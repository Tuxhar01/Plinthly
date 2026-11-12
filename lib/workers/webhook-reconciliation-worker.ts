/**
 * Plinthly Stage 3 Phase 3 — Webhook Reconciliation Asynchronous Background Worker
 *
 * Implements:
 * 1. Resilient background worker dequeuing events from WebhookEventQueue.
 * 2. Execution of payment capture & refund reconciliation via WebhookPaymentReconciler (R2-04/R2-05/R2-06).
 * 3. Exponential backoff retry schedules (1s, 5s, 30s, 2m, 10m) upon transient failures.
 * 4. Automatic Dead Letter Queue (DLQ) routing after 5 failed attempts.
 * 5. P1 Operational Alert emission upon DLQ routing (WHK-03).
 * 6. Stale worker protection (DEF-WHK-01): Handles fencing tokens (claim_token) preventing stale
 *    workers whose leases expired from overwriting newer worker outcomes.
 */

import { Client, PoolClient } from "pg";
import {
  IWebhookEventQueue,
  WebhookQueueItem,
  StaleClaimError,
} from "../queue/webhook-event-queue";
import {
  WebhookPaymentReconciler,
  ReconciliationResult,
} from "../workflow/webhook-reconciler";
import { WebhookIngressResult } from "./webhook-ingress-worker";

export interface WebhookWorkerOptions {
  backoffScheduleMs?: number[];
  maxAttempts?: number;
  workerId?: string;
  onDeadLetterAlert?: (item: WebhookQueueItem, error: Error) => void;
}

export interface ProcessedItemResult {
  itemId: string;
  transmissionId: string;
  status: "COMPLETED" | "RETRIED" | "DEAD_LETTER" | "STALE_CLAIM";
  reconciliation?: ReconciliationResult;
  error?: string;
  attempts: number;
}

export interface ProcessBatchResult {
  claimedCount: number;
  completedCount: number;
  retriedCount: number;
  deadLetterCount: number;
  results: ProcessedItemResult[];
}

export class WebhookReconciliationWorker {
  private client: Client | PoolClient;
  private queue: IWebhookEventQueue;
  private reconciler: WebhookPaymentReconciler;
  private backoffScheduleMs: number[];
  private maxAttempts: number;
  private workerId: string;
  private onDeadLetterAlert?: (item: WebhookQueueItem, error: Error) => void;

  constructor(
    client: Client | PoolClient,
    queue: IWebhookEventQueue,
    reconciler: WebhookPaymentReconciler,
    options: WebhookWorkerOptions = {}
  ) {
    this.client = client;
    this.queue = queue;
    this.reconciler = reconciler;
    this.backoffScheduleMs = options.backoffScheduleMs || [
      1000, 5000, 30000, 120000, 600000,
    ];
    this.maxAttempts = options.maxAttempts || 5;
    this.workerId = options.workerId || `worker_${process.pid}_${Date.now()}`;
    this.onDeadLetterAlert = options.onDeadLetterAlert;
  }

  /**
   * Dequeues and processes the next batch of eligible webhook events.
   */
  async processNextBatch(batchSize: number = 10): Promise<ProcessBatchResult> {
    const items = await this.queue.dequeueBatch(batchSize, this.workerId);

    const results: ProcessedItemResult[] = [];
    let completedCount = 0;
    let retriedCount = 0;
    let deadLetterCount = 0;

    for (const item of items) {
      try {
        const reconResult = await this.processSingleItem(item);
        await this.queue.markCompleted(item.id, item.claimToken || undefined);

        completedCount++;
        results.push({
          itemId: item.id,
          transmissionId: item.transmissionId,
          status: "COMPLETED",
          reconciliation: reconResult,
          attempts: item.attempts,
        });
      } catch (err: any) {
        if (err instanceof StaleClaimError) {
          results.push({
            itemId: item.id,
            transmissionId: item.transmissionId,
            status: "STALE_CLAIM",
            error: err.message,
            attempts: item.attempts,
          });
          continue;
        }

        const error = err instanceof Error ? err : new Error(String(err));

        try {
          if (item.attempts >= item.maxAttempts) {
            // Route to Dead Letter Queue (DLQ)
            await this.queue.moveToDeadLetterQueue(
              item.id,
              error.message,
              item.claimToken || undefined
            );
            this.triggerDeadLetterAlert(item, error);

            deadLetterCount++;
            results.push({
              itemId: item.id,
              transmissionId: item.transmissionId,
              status: "DEAD_LETTER",
              error: error.message,
              attempts: item.attempts,
            });
          } else {
            // Calculate exponential backoff delay
            const backoffIndex = Math.min(
              item.attempts - 1,
              this.backoffScheduleMs.length - 1
            );
            const backoffDelay = this.backoffScheduleMs[backoffIndex] || 1000;

            await this.queue.markFailedWithRetry(
              item.id,
              backoffDelay,
              error.message,
              item.claimToken || undefined
            );

            retriedCount++;
            results.push({
              itemId: item.id,
              transmissionId: item.transmissionId,
              status: "RETRIED",
              error: error.message,
              attempts: item.attempts,
            });
          }
        } catch (updateErr: any) {
          if (updateErr instanceof StaleClaimError) {
            results.push({
              itemId: item.id,
              transmissionId: item.transmissionId,
              status: "STALE_CLAIM",
              error: updateErr.message,
              attempts: item.attempts,
            });
          } else {
            throw updateErr;
          }
        }
      }
    }

    return {
      claimedCount: items.length,
      completedCount,
      retriedCount,
      deadLetterCount,
      results,
    };
  }

  /**
   * Executes reconciliation for a single queue item.
   */
  async processSingleItem(item: WebhookQueueItem): Promise<ReconciliationResult> {
    const ingressResult: WebhookIngressResult = {
      transmissionId: item.transmissionId,
      status: "PROCESSED",
      eventType: item.eventType,
      orderId: item.orderId,
      captureId: item.captureId,
      refundId: item.refundId,
      amountCents: item.amountCents,
      currency: item.currency,
      payeeEmail: item.payeeEmail,
      rawPayloadHash: item.payload?.rawPayloadHash || "",
      crc32: item.payload?.crc32 || 0,
      loggedAt: new Date(item.createdAt),
      finalized: true,
    };

    const reconResult = await this.reconciler.reconcileWebhook(ingressResult);

    if (!reconResult.reconciled && reconResult.message?.includes("No ApprovedMerchantCart found")) {
      // If cart not found yet (race condition where webhook arrives before cart checkout row commits),
      // treat as retryable failure so backoff can retry!
      throw new Error(`ERR_RECONCILIATION_PENDING_CART: ${reconResult.message}`);
    }

    return reconResult;
  }

  private triggerDeadLetterAlert(item: WebhookQueueItem, error: Error): void {
    const alertPayload = {
      timestamp: new Date().toISOString(),
      alert: "WebhookDeadLetterAlert",
      severity: "P1",
      transmissionId: item.transmissionId,
      eventType: item.eventType,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      queueItemId: item.id,
      errorMessage: error.message,
    };

    console.error(`[P1_ALERT] WebhookDeadLetterAlert:`, JSON.stringify(alertPayload));

    if (this.onDeadLetterAlert) {
      try {
        this.onDeadLetterAlert(item, error);
      } catch (cbErr) {
        console.error(`[ALERT_CALLBACK_ERROR]`, cbErr);
      }
    }
  }
}
