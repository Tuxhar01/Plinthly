/**
 * Plinthly Stage 3 Phase 3 — PostgreSQL Durable Webhook Event Queue
 *
 * Implements a durable, cloud-neutral transactional message queue backed by
 * PostgreSQL utilizing monotonic row locking with FOR UPDATE SKIP LOCKED.
 *
 * Guarantees:
 * 1. Transactional Durability: Zero loss of verified webhook events.
 * 2. Concurrency Safety: Monotonic row-level locking ensures concurrent worker
 *    instances never double-process or contend on the same webhook item.
 * 3. Expired Lease Recovery (DEF-WHK-01): Expired PROCESSING events are automatically
 *    and safely reclaimed when locked_until < clock_timestamp(), preventing abandoned
 *    work caused by worker process crashes (OOM, SIGKILL).
 * 4. Stale-Worker Fencing: Each claim receives a unique claim_token fencing identity.
 *    Updates (markCompleted, markFailedWithRetry, moveToDeadLetterQueue, renewLease)
 *    are conditionally bound to the claim token, preventing stale workers from overwriting
 *    newer workers' results.
 * 5. Exponential Backoff Retry: Failed items transition to FAILED_RETRYABLE
 *    with exponential backoff delay schedules.
 * 6. Dead Letter Queue (DLQ): Items exceeding max attempts (default 5) are
 *    routed to DEAD_LETTER for manual inspection and audit logging.
 * 7. Zero External Infrastructure: No Redis, Kafka, or vendor queue required.
 */

import { Client, PoolClient } from "pg";
import crypto from "crypto";

export type WebhookQueueStatus =
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED_RETRYABLE"
  | "DEAD_LETTER";

export class StaleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleClaimError";
    Object.setPrototypeOf(this, StaleClaimError.prototype);
  }
}

export interface WebhookQueueItem {
  id: string;
  transmissionId: string;
  eventType: string;
  orderId: string | null;
  captureId: string | null;
  refundId: string | null;
  amountCents: number;
  currency: string;
  payeeEmail: string | null;
  payload: any;
  status: WebhookQueueStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date | null;
  lockedBy?: string | null;
  claimToken?: string | null;
  lastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueWebhookInput {
  transmissionId: string;
  eventType: string;
  orderId?: string | null;
  captureId?: string | null;
  refundId?: string | null;
  amountCents?: number;
  currency?: string;
  payeeEmail?: string | null;
  rawPayload: any;
  maxAttempts?: number;
}

export interface IWebhookEventQueue {
  enqueue(input: EnqueueWebhookInput): Promise<WebhookQueueItem>;
  dequeueBatch(
    batchSize?: number,
    workerId?: string,
    lockDurationSeconds?: number
  ): Promise<WebhookQueueItem[]>;
  markCompleted(id: string, claimToken?: string): Promise<void>;
  markFailedWithRetry(
    id: string,
    backoffMs: number,
    errorMessage: string,
    claimToken?: string
  ): Promise<void>;
  moveToDeadLetterQueue(
    id: string,
    errorMessage: string,
    claimToken?: string
  ): Promise<void>;
  renewLease(
    id: string,
    durationSeconds: number,
    claimToken: string
  ): Promise<void>;
  getQueueItem(id: string): Promise<WebhookQueueItem | null>;
  getDeadLetterItems(limit?: number): Promise<WebhookQueueItem[]>;
  clearQueue?(): Promise<void>;
}

export class PostgresWebhookEventQueue implements IWebhookEventQueue {
  private client: Client | PoolClient;
  private tableInitialized: boolean = false;

  constructor(client: Client | PoolClient) {
    this.client = client;
  }

  /**
   * Initializes queue table and indexes if not already created.
   * Safe to call multiple times (idempotent).
   */
  async initQueue(): Promise<void> {
    if (this.tableInitialized) return;

    try {
      await this.client.query(`
        CREATE TABLE IF NOT EXISTS public."WebhookEventQueue" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          transmission_id VARCHAR(64) NOT NULL,
          event_type VARCHAR(64) NOT NULL,
          order_id VARCHAR(64),
          capture_id VARCHAR(64),
          refund_id VARCHAR(64),
          amount_cents BIGINT NOT NULL DEFAULT 0,
          currency VARCHAR(3) NOT NULL DEFAULT 'USD',
          payee_email VARCHAR(255),
          raw_payload_json JSONB NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
          attempts INT NOT NULL DEFAULT 0,
          max_attempts INT NOT NULL DEFAULT 5,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          locked_until TIMESTAMPTZ,
          locked_by VARCHAR(64),
          claim_token UUID DEFAULT gen_random_uuid(),
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );

        ALTER TABLE public."WebhookEventQueue"
          ADD COLUMN IF NOT EXISTS claim_token UUID DEFAULT gen_random_uuid();

        DROP INDEX IF EXISTS public.idx_webhook_queue_claim;

        CREATE INDEX IF NOT EXISTS "idx_webhook_queue_claim"
          ON public."WebhookEventQueue" (status, next_attempt_at, locked_until, created_at)
          WHERE status IN ('QUEUED', 'FAILED_RETRYABLE', 'PROCESSING');

        CREATE INDEX IF NOT EXISTS "idx_webhook_queue_tx"
          ON public."WebhookEventQueue" (transmission_id);

        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webhook_ingress_role') THEN
            GRANT SELECT, INSERT, UPDATE ON public."WebhookEventQueue" TO webhook_ingress_role;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_orchestrator_role') THEN
            GRANT ALL ON public."WebhookEventQueue" TO app_orchestrator_role;
          END IF;
        END
        $$;
      `);
    } catch (err: any) {
      if (err.code !== "42501" && err.code !== "42P07") {
        throw err;
      }
    }

    this.tableInitialized = true;
  }

  /**
   * Enqueues an authenticated webhook event into the durable queue.
   */
  async enqueue(input: EnqueueWebhookInput): Promise<WebhookQueueItem> {
    const maxAttempts = input.maxAttempts ?? 5;
    const payloadJson =
      typeof input.rawPayload === "string"
        ? input.rawPayload
        : JSON.stringify(input.rawPayload);

    const res = await this.client.query(
      `INSERT INTO public."WebhookEventQueue" (
         transmission_id, event_type, order_id, capture_id, refund_id,
         amount_cents, currency, payee_email, raw_payload_json,
         status, attempts, max_attempts, next_attempt_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9::jsonb,
         'QUEUED', 0, $10, clock_timestamp(), clock_timestamp(), clock_timestamp()
       )
       RETURNING id, transmission_id, event_type, order_id, capture_id, refund_id,
                 amount_cents, currency, payee_email, raw_payload_json,
                 status, attempts, max_attempts, next_attempt_at,
                 locked_until, locked_by, claim_token, last_error, created_at, updated_at;`,
      [
        input.transmissionId,
        input.eventType,
        input.orderId || null,
        input.captureId || null,
        input.refundId || null,
        input.amountCents || 0,
        input.currency || "USD",
        input.payeeEmail || null,
        payloadJson,
        maxAttempts,
      ]
    );

    return this.mapRowToItem(res.rows[0]);
  }

  /**
   * Atomically claims and dequeues a batch of eligible events using FOR UPDATE SKIP LOCKED.
   * Concurrent workers calling this will receive non-overlapping batches without lock contention.
   *
   * DEF-WHK-01 Fix:
   * - Reclaims abandoned PROCESSING events whose locked_until timestamp has expired (< clock_timestamp()).
   * - Assigns a fresh, unique claim_token fencing token on each claim.
   */
  async dequeueBatch(
    batchSize: number = 10,
    workerId: string = `worker_${crypto.randomUUID()}`,
    lockDurationSeconds: number = 60
  ): Promise<WebhookQueueItem[]> {
    const res = await this.client.query(
      `WITH claimable AS (
         SELECT id
           FROM public."WebhookEventQueue"
          WHERE (
                  (status IN ('QUEUED', 'FAILED_RETRYABLE')
                   AND next_attempt_at <= clock_timestamp()
                   AND (locked_until IS NULL OR locked_until < clock_timestamp()))
               OR (status = 'PROCESSING'
                   AND locked_until IS NOT NULL
                   AND locked_until < clock_timestamp())
                )
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE public."WebhookEventQueue" q
          SET status = 'PROCESSING',
              locked_until = clock_timestamp() + ($2 || ' seconds')::interval,
              locked_by = $3,
              claim_token = gen_random_uuid(),
              attempts = q.attempts + 1,
              updated_at = clock_timestamp()
         FROM claimable
        WHERE q.id = claimable.id
       RETURNING q.id, q.transmission_id, q.event_type, q.order_id, q.capture_id, q.refund_id,
                 q.amount_cents, q.currency, q.payee_email, q.raw_payload_json,
                 q.status, q.attempts, q.max_attempts, q.next_attempt_at,
                 q.locked_until, q.locked_by, q.claim_token, q.last_error, q.created_at, q.updated_at;`,
      [batchSize, lockDurationSeconds, workerId]
    );

    return res.rows.map((row) => this.mapRowToItem(row));
  }

  /**
   * Marks a processed queue item as COMPLETED and releases locks.
   * Fenced by claimToken when provided to ensure stale workers whose leases expired
   * cannot overwrite newer workers' results.
   */
  async markCompleted(id: string, claimToken?: string): Promise<void> {
    const res = await this.client.query(
      claimToken
        ? `UPDATE public."WebhookEventQueue"
              SET status = 'COMPLETED',
                  locked_until = NULL,
                  locked_by = NULL,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND claim_token = $2;`
        : `UPDATE public."WebhookEventQueue"
              SET status = 'COMPLETED',
                  locked_until = NULL,
                  locked_by = NULL,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND (status = 'QUEUED' OR claim_token IS NULL);`,
      claimToken ? [id, claimToken] : [id]
    );

    if (res.rowCount === 0) {
      if (claimToken) {
        throw new StaleClaimError(
          `STALE_CLAIM: Cannot mark completed. Lease for queue item "${id}" with claim token "${claimToken}" has expired or was reclaimed.`
        );
      } else {
        throw new Error(`QUEUE_UPDATE_FAILED: Item "${id}" could not be marked completed.`);
      }
    }
  }

  /**
   * Schedules a failed item for retry with exponential backoff delay.
   * Fenced by claimToken when provided to ensure stale workers cannot overwrite newer claims.
   */
  async markFailedWithRetry(
    id: string,
    backoffMs: number,
    errorMessage: string,
    claimToken?: string
  ): Promise<void> {
    const res = await this.client.query(
      claimToken
        ? `UPDATE public."WebhookEventQueue"
              SET status = 'FAILED_RETRYABLE',
                  next_attempt_at = clock_timestamp() + ($2 || ' milliseconds')::interval,
                  locked_until = NULL,
                  locked_by = NULL,
                  last_error = $3,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND claim_token = $4;`
        : `UPDATE public."WebhookEventQueue"
              SET status = 'FAILED_RETRYABLE',
                  next_attempt_at = clock_timestamp() + ($2 || ' milliseconds')::interval,
                  locked_until = NULL,
                  locked_by = NULL,
                  last_error = $3,
                  updated_at = clock_timestamp()
            WHERE id = $1;`,
      claimToken
        ? [id, Math.max(1, Math.round(backoffMs)), errorMessage, claimToken]
        : [id, Math.max(1, Math.round(backoffMs)), errorMessage]
    );

    if (res.rowCount === 0 && claimToken) {
      throw new StaleClaimError(
        `STALE_CLAIM: Cannot mark failed retryable. Lease for queue item "${id}" with claim token "${claimToken}" has expired or was reclaimed.`
      );
    }
  }

  /**
   * Moves a failed item that has exceeded max attempts into DEAD_LETTER.
   * Fenced by claimToken when provided to ensure stale workers cannot force newer claims to DLQ.
   */
  async moveToDeadLetterQueue(
    id: string,
    errorMessage: string,
    claimToken?: string
  ): Promise<void> {
    const res = await this.client.query(
      claimToken
        ? `UPDATE public."WebhookEventQueue"
              SET status = 'DEAD_LETTER',
                  locked_until = NULL,
                  locked_by = NULL,
                  last_error = $2,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND claim_token = $3;`
        : `UPDATE public."WebhookEventQueue"
              SET status = 'DEAD_LETTER',
                  locked_until = NULL,
                  locked_by = NULL,
                  last_error = $2,
                  updated_at = clock_timestamp()
            WHERE id = $1;`,
      claimToken ? [id, errorMessage, claimToken] : [id, errorMessage]
    );

    if (res.rowCount === 0 && claimToken) {
      throw new StaleClaimError(
        `STALE_CLAIM: Cannot move to DLQ. Lease for queue item "${id}" with claim token "${claimToken}" has expired or was reclaimed.`
      );
    }
  }

  /**
   * Renews an active lease for long-running processing jobs.
   * Fenced by claimToken; fails if the lease has expired and been reclaimed.
   */
  async renewLease(
    id: string,
    durationSeconds: number,
    claimToken: string
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE public."WebhookEventQueue"
          SET locked_until = clock_timestamp() + ($2 || ' seconds')::interval,
              updated_at = clock_timestamp()
        WHERE id = $1 AND claim_token = $3 AND status = 'PROCESSING';`,
      [id, Math.max(1, Math.round(durationSeconds)), claimToken]
    );

    if (res.rowCount === 0) {
      throw new StaleClaimError(
        `STALE_CLAIM: Cannot renew lease. Lease for queue item "${id}" with claim token "${claimToken}" has expired or was reclaimed.`
      );
    }
  }

  /**
   * Retrieves a single queue item by ID.
   */
  async getQueueItem(id: string): Promise<WebhookQueueItem | null> {
    const res = await this.client.query(
      `SELECT id, transmission_id, event_type, order_id, capture_id, refund_id,
              amount_cents, currency, payee_email, raw_payload_json,
              status, attempts, max_attempts, next_attempt_at,
              locked_until, locked_by, claim_token, last_error, created_at, updated_at
         FROM public."WebhookEventQueue"
        WHERE id = $1;`,
      [id]
    );

    if (res.rows.length === 0) return null;
    return this.mapRowToItem(res.rows[0]);
  }

  /**
   * Queries items currently stored in the Dead Letter Queue.
   */
  async getDeadLetterItems(limit: number = 50): Promise<WebhookQueueItem[]> {
    const res = await this.client.query(
      `SELECT id, transmission_id, event_type, order_id, capture_id, refund_id,
              amount_cents, currency, payee_email, raw_payload_json,
              status, attempts, max_attempts, next_attempt_at,
              locked_until, locked_by, claim_token, last_error, created_at, updated_at
         FROM public."WebhookEventQueue"
        WHERE status = 'DEAD_LETTER'
        ORDER BY updated_at DESC
        LIMIT $1;`,
      [limit]
    );

    return res.rows.map((row) => this.mapRowToItem(row));
  }

  /**
   * Helper to truncate queue for testing environments.
   */
  async clearQueue(): Promise<void> {
    await this.client.query(`DELETE FROM public."WebhookEventQueue";`);
  }

  private mapRowToItem(row: any): WebhookQueueItem {
    return {
      id: row.id,
      transmissionId: row.transmission_id,
      eventType: row.event_type,
      orderId: row.order_id,
      captureId: row.capture_id,
      refundId: row.refund_id,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      payeeEmail: row.payee_email,
      payload: row.raw_payload_json,
      status: row.status as WebhookQueueStatus,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: new Date(row.next_attempt_at),
      lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
      lockedBy: row.locked_by || null,
      claimToken: row.claim_token || null,
      lastError: row.last_error || null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
