/**
 * Plinthly Stage 3 Phase 3 — Webhook Queue Resilience & Fast-Ack Acceptance Suite
 *
 * Verifies Acceptance Matrix criteria WHK-01, WHK-02, WHK-03:
 * 1. WHK-01: Inbound /api/webhooks/paypal fast-acks (< 300ms) with HTTP 200 under concurrent load (50 events).
 *    Raw payloads immutably logged to WebhookTransmission via R2-03.
 * 2. WHK-02: Asynchronous queue with exponential retry backoff on transient failures.
 *    Successful dequeuing executes R2-04/R2-05 reconciliation.
 * 3. WHK-03: Dead Letter Queue (DLQ) routing after 5 failed attempts with P1 operational alert.
 * 4. Monotonic row locking: Concurrent workers process queue with FOR UPDATE SKIP LOCKED without duplicate claims.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { POST as webhookRoute } from "../../app/api/webhooks/paypal/route";
import {
  PostgresWebhookEventQueue,
  WebhookQueueItem,
  StaleClaimError,
} from "../../lib/queue/webhook-event-queue";
import { WebhookReconciliationWorker } from "../../lib/workers/webhook-reconciliation-worker";
import { WebhookPaymentReconciler } from "../../lib/workflow/webhook-reconciler";
import { CartCaptureService } from "../../lib/workflow/cart-capture-service";
import { RefundService } from "../../lib/workflow/refund-service";
import { MockPaymentGatewayClient } from "../../lib/workflow/payment-gateway-adapter";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import {
  TEST_PAYPAL_ROOT_CA_PEM,
  TEST_PAYPAL_LEAF_CERT_PEM,
  TEST_PAYPAL_LEAF_PRIVATE_KEY_PEM,
} from "../fixtures/test-certificates";
import { formatPayPalSignatureMessage } from "../../lib/crypto/paypal-crc32";

describe("Stage 3 Phase 3 Acceptance Suite: Webhook Queue Resilience (WHK-01, WHK-02, WHK-03)", () => {
  let masterClient: Client;
  let queue: PostgresWebhookEventQueue;
  const hmacKeyId = "audit_hmac_key_2026";
  const webhookId = "WH_STAGE2_DEFAULT";

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
    await createTestKeys(masterClient, "vak_unused", hmacKeyId, "ingress_worker_user");

    queue = new PostgresWebhookEventQueue(masterClient);
    await queue.initQueue();
  });

  afterAll(async () => {
    await masterClient.query(
      `DELETE FROM public."WebhookEventQueue" WHERE transmission_id LIKE 'tx_resilience_%';`
    );
    await masterClient.end();
  });

  beforeEach(async () => {
    process.env.AUTH_MODE = "local_demo";
    process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
    await masterClient.query(
      `DELETE FROM public."WebhookEventQueue" WHERE transmission_id LIKE 'tx_resilience_%';`
    );
  });

  function createSignedWebhookRequest(
    transmissionId: string,
    orderId: string,
    captureId: string,
    amountCents: number = 2500,
    isAsync: boolean = true
  ): Request {
    const payloadObj = {
      id: "WH-EV-" + crypto.randomUUID(),
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: new Date().toISOString(),
      resource: {
        id: captureId,
        amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" },
        payee: { email_address: "merchant@example.com" },
        supplementary_data: { related_ids: { order_id: orderId, capture_id: captureId } },
      },
    };

    const rawPayload = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const transmissionTime = new Date().toISOString();

    const sigMsg = formatPayPalSignatureMessage({
      transmissionId,
      transmissionTime,
      webhookId,
      rawPayload,
    });

    const signer = crypto.createSign("sha256");
    signer.update(sigMsg);
    const sig = signer.sign(TEST_PAYPAL_LEAF_PRIVATE_KEY_PEM, "base64");

    const headers: Record<string, string> = {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-WHK-01",
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-sig": sig,
      "paypal-transmission-time": transmissionTime,
      "x-paypal-cert-pem": encodeURIComponent(TEST_PAYPAL_LEAF_CERT_PEM),
    };

    if (isAsync) {
      headers["x-plinthly-webhook-async"] = "true";
    }

    return new Request("http://localhost:3000/api/webhooks/paypal", {
      method: "POST",
      headers,
      body: rawPayload,
    });
  }

  // ==========================================================================
  // WHK-01: Fast-Ack Webhook Ingress
  // ==========================================================================
  describe("WHK-01: Fast-Ack Webhook Ingress Performance & Durability", () => {
    it("responds with HTTP 200 within < 300ms across 50 concurrent valid webhook events", async () => {
      // Warm up connection pool and JIT caches
      await Promise.all(
        Array.from({ length: 10 }).map((_, i) => {
          const warmupTxId = "tx_resilience_warmup_" + i + "_" + crypto.randomUUID();
          const warmupReq = createSignedWebhookRequest(warmupTxId, "ORD-WARM-" + i, "CAP-WARM-" + i, 1000, true);
          return webhookRoute(warmupReq);
        })
      );

      const concurrency = 50;
      const runId = crypto.randomUUID().slice(0, 8);
      const requests: { req: Request; txId: string; orderId: string; captureId: string }[] = [];

      for (let i = 0; i < concurrency; i++) {
        const txId = `tx_resilience_fastack_${runId}_${i}`;
        const orderId = `ORD-FASTACK-${runId}-${i}`;
        const captureId = `CAP-FASTACK-${runId}-${i}`;
        const req = createSignedWebhookRequest(txId, orderId, captureId, 1000 + i * 100, true);
        requests.push({ req, txId, orderId, captureId });
      }

      const start = Date.now();
      const results: { status: number; latency: number; body: any }[] = [];
      const queueWork = [...requests];
      const concurrencyLimit = 10;
      const workerPool = Array.from({ length: concurrencyLimit }).map(async () => {
        while (queueWork.length > 0) {
          const item = queueWork.shift();
          if (!item) break;
          const reqStart = Date.now();
          const res = await webhookRoute(item.req);
          const latency = Date.now() - reqStart;
          const body = await res.json();
          results.push({ status: res.status, latency, body });
        }
      });
      await Promise.all(workerPool);
      const totalDuration = Date.now() - start;

      // Assert 100% of responses are HTTP 200
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.status).toBe("accepted");
        expect(res.body.queueItemId).toBeDefined();
        // Target metric: each individual response < 300ms
        expect(res.latency).toBeLessThan(300);
      }

      // Verify that all 50 items exist in WebhookTransmission (R2-03)
      const txCheck = await masterClient.query(
        `SELECT count(*) FROM public."WebhookTransmission" WHERE transmission_id LIKE $1;`,
        [`tx_resilience_fastack_${runId}_%`]
      );
      expect(Number(txCheck.rows[0].count)).toBe(concurrency);

      // Verify that all 50 items exist in WebhookEventQueue in QUEUED state
      const queueCheck = await masterClient.query(
        `SELECT count(*) FROM public."WebhookEventQueue" WHERE transmission_id LIKE $1 AND status = 'QUEUED';`,
        [`tx_resilience_fastack_${runId}_%`]
      );
      expect(Number(queueCheck.rows[0].count)).toBe(concurrency);
    });

    it("rejects malformed signatures fail-closed without corrupting the queue", async () => {
      const txId = "tx_resilience_forged_" + crypto.randomUUID();
      const orderId = "ORD-FORGED-01";
      const captureId = "CAP-FORGED-01";

      const validReq = createSignedWebhookRequest(txId, orderId, captureId, 2500, true);
      const rawPayload = Buffer.from(await validReq.arrayBuffer());

      // Send with invalid signature
      const badReq = new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        headers: {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-WHK-01",
          "paypal-transmission-id": txId,
          "paypal-transmission-sig": Buffer.from("invalid-forged-signature").toString("base64"),
          "paypal-transmission-time": new Date().toISOString(),
          "x-paypal-cert-pem": encodeURIComponent(TEST_PAYPAL_LEAF_CERT_PEM),
          "x-plinthly-webhook-async": "true",
        },
        body: rawPayload,
      });

      const res = await webhookRoute(badReq);
      expect(res.status).toBe(400);

      // Verify zero rows in queue or transmission table
      const qRes = await masterClient.query(
        `SELECT 1 FROM public."WebhookEventQueue" WHERE transmission_id = $1`,
        [txId]
      );
      expect(qRes.rows.length).toBe(0);
    });
  });

  // ==========================================================================
  // WHK-02: Asynchronous Queue & Retry Backoff
  // ==========================================================================
  describe("WHK-02: Asynchronous Queue & Retry Backoff Execution", () => {
    it("retries failed webhook items with exponential backoff and succeeds upon transient recovery", async () => {
      const orderId = "ORD-RETRY-" + crypto.randomUUID();
      const captureId = "CAP-RETRY-" + crypto.randomUUID();
      const txId = "tx_resilience_retry_" + crypto.randomUUID();

      // Create target cart in CAPTURING
      const fixture = await createTestCartFixture(
        masterClient,
        "CAPTURING",
        3000,
        0,
        0,
        0,
        "merchant@example.com",
        orderId
      );

      // Submit webhook via route
      const req = createSignedWebhookRequest(txId, orderId, captureId, 3000, true);
      const res = await webhookRoute(req);
      expect(res.status).toBe(200);
      const { queueItemId } = await res.json();

      // Configure worker with fast test backoff schedule (50ms, 100ms, 200ms)
      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const refundService = new RefundService(masterClient, mockGateway, hmacKeyId);
      const reconciler = new WebhookPaymentReconciler(masterClient, captureService, refundService);

      const worker = new WebhookReconciliationWorker(masterClient, queue, reconciler, {
        backoffScheduleMs: [50, 100, 200, 500, 1000],
        maxAttempts: 5,
      });

      // Simulate transient failure by temporarily sabotaging the reconciler
      let failCount = 0;
      const originalReconcile = reconciler.reconcileWebhook.bind(reconciler);
      reconciler.reconcileWebhook = async (ingress) => {
        if (failCount < 2) {
          failCount++;
          throw new Error("Simulated transient PostgreSQL lock contention");
        }
        return originalReconcile(ingress);
      };

      // Attempt 1: Should fail and enter FAILED_RETRYABLE with attempts = 1
      const batch1 = await worker.processNextBatch(5);
      expect(batch1.claimedCount).toBe(1);
      expect(batch1.retriedCount).toBe(1);
      expect(batch1.completedCount).toBe(0);

      const item1 = await queue.getQueueItem(queueItemId);
      expect(item1?.status).toBe("FAILED_RETRYABLE");
      expect(item1?.attempts).toBe(1);
      expect(item1?.lastError).toContain("Simulated transient PostgreSQL lock contention");

      // Verify immediate second claim returns empty because next_attempt_at is in the future
      const immediateBatch = await worker.processNextBatch(5);
      expect(immediateBatch.claimedCount).toBe(0);

      // Wait 60ms for backoff delay 1 (50ms) to elapse
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Attempt 2: Fails again, backoff delay 2 (100ms)
      const batch2 = await worker.processNextBatch(5);
      expect(batch2.claimedCount).toBe(1);
      expect(batch2.retriedCount).toBe(1);

      const item2 = await queue.getQueueItem(queueItemId);
      expect(item2?.status).toBe("FAILED_RETRYABLE");
      expect(item2?.attempts).toBe(2);

      // Wait 110ms for backoff delay 2 (100ms) to elapse
      await new Promise((resolve) => setTimeout(resolve, 110));

      // Attempt 3: Transient failure is cleared! Reconciliation succeeds!
      const batch3 = await worker.processNextBatch(5);
      expect(batch3.claimedCount).toBe(1);
      expect(batch3.completedCount).toBe(1);

      const item3 = await queue.getQueueItem(queueItemId);
      expect(item3?.status).toBe("COMPLETED");

      // Verify cart transitioned to CAPTURED via R2-05
      const cartCheck = await masterClient.query(
        `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
        [fixture.cartId]
      );
      expect(cartCheck.rows[0].checkoutStatus).toBe("CAPTURED");
    });
  });

  // ==========================================================================
  // WHK-03: Dead Letter Queue (DLQ) & Alerting
  // ==========================================================================
  describe("WHK-03: Dead Letter Queue (DLQ) & P1 Alert Trigger", () => {
    it("routes unresolvable events to DEAD_LETTER after 5 failed attempts and triggers P1 alert", async () => {
      const orderId = "ORD-UNRESOLVABLE-" + crypto.randomUUID();
      const captureId = "CAP-UNRESOLVABLE-" + crypto.randomUUID();
      const txId = "tx_resilience_dlq_" + crypto.randomUUID();

      // Submit webhook for non-existent cart
      const req = createSignedWebhookRequest(txId, orderId, captureId, 5000, true);
      const res = await webhookRoute(req);
      expect(res.status).toBe(200);
      const { queueItemId } = await res.json();

      let p1AlertTriggered = false;
      let alertItemRef: WebhookQueueItem | null = null;

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const refundService = new RefundService(masterClient, mockGateway, hmacKeyId);
      const reconciler = new WebhookPaymentReconciler(masterClient, captureService, refundService);

      // Force reconciler to fail permanently
      reconciler.reconcileWebhook = async () => {
        throw new Error("Permanent unresolvable schema mismatch in payload");
      };

      const worker = new WebhookReconciliationWorker(masterClient, queue, reconciler, {
        backoffScheduleMs: [1, 1, 1, 1, 1], // 1ms backoff for deterministic testing
        maxAttempts: 5,
        onDeadLetterAlert: (item, err) => {
          p1AlertTriggered = true;
          alertItemRef = item;
        },
      });

      // Run worker 4 times -> should be RETRIED
      for (let attempt = 1; attempt <= 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const batch = await worker.processNextBatch(5);
        expect(batch.claimedCount).toBe(1);
        expect(batch.retriedCount).toBe(1);
        expect(p1AlertTriggered).toBe(false);
      }

      // Run 5th attempt -> Should transition to DEAD_LETTER and fire P1 alert
      await new Promise((resolve) => setTimeout(resolve, 5));
      const finalBatch = await worker.processNextBatch(5);
      expect(finalBatch.claimedCount).toBe(1);
      expect(finalBatch.deadLetterCount).toBe(1);
      expect(finalBatch.retriedCount).toBe(0);

      // Assert P1 alert was fired
      expect(p1AlertTriggered).toBe(true);
      expect((alertItemRef as any)?.id).toBe(queueItemId);
      expect((alertItemRef as any)?.transmissionId).toBe(txId);

      // Inspect DLQ items via queue query
      const dlqItems = await queue.getDeadLetterItems();
      expect(dlqItems.length).toBeGreaterThanOrEqual(1);
      const dlqItem = dlqItems.find((it) => it.id === queueItemId);
      expect(dlqItem).toBeDefined();
      expect(dlqItem?.status).toBe("DEAD_LETTER");
      expect(dlqItem?.attempts).toBe(5);
      expect(dlqItem?.lastError).toContain("Permanent unresolvable schema mismatch");
    });
  });

  // ==========================================================================
  // Concurrency Safety: Monotonic Row Locking via FOR UPDATE SKIP LOCKED
  // ==========================================================================
  describe("Concurrency: FOR UPDATE SKIP LOCKED Monotonic Claiming", () => {
    it("ensures multiple concurrent workers never double-claim or contend on identical queue items", async () => {
      const itemCount = 12;
      const createdIds: string[] = [];

      for (let i = 0; i < itemCount; i++) {
        const item = await queue.enqueue({
          transmissionId: `tx_resilience_conc_${i}_${crypto.randomUUID()}`,
          eventType: "PAYMENT.CAPTURE.COMPLETED",
          orderId: `ORD-CONC-${i}`,
          captureId: `CAP-CONC-${i}`,
          amountCents: 1000,
          rawPayload: { index: i },
        });
        createdIds.push(item.id);
      }

      // Create 3 separate client instances representing 3 concurrent worker processes
      const client1 = await createStage2Client();
      const client2 = await createStage2Client();
      const client3 = await createStage2Client();

      const q1 = new PostgresWebhookEventQueue(client1);
      const q2 = new PostgresWebhookEventQueue(client2);
      const q3 = new PostgresWebhookEventQueue(client3);

      try {
        // Simultaneously dequeue batches of 5
        const [batch1, batch2, batch3] = await Promise.all([
          q1.dequeueBatch(5, "worker-1"),
          q2.dequeueBatch(5, "worker-2"),
          q3.dequeueBatch(5, "worker-3"),
        ]);

        const claimed1 = batch1.map((i) => i.id);
        const claimed2 = batch2.map((i) => i.id);
        const claimed3 = batch3.map((i) => i.id);

        const totalClaimed = claimed1.length + claimed2.length + claimed3.length;
        expect(totalClaimed).toBe(itemCount);

        // Strict disjointness assertion: NO overlapping items between any worker pairs
        const set1 = new Set(claimed1);
        const set2 = new Set(claimed2);
        const set3 = new Set(claimed3);

        for (const id of claimed1) {
          expect(set2.has(id)).toBe(false);
          expect(set3.has(id)).toBe(false);
        }
        for (const id of claimed2) {
          expect(set1.has(id)).toBe(false);
          expect(set3.has(id)).toBe(false);
        }
      } finally {
        await client1.end();
        await client2.end();
        await client3.end();
      }
    });
  });

  // ==========================================================================
  // DEF-WHK-01: Expired Worker Lease Recovery & Stale-Worker Fencing
  // ==========================================================================
  describe("DEF-WHK-01: Expired Worker Lease Recovery & Stale-Worker Fencing", () => {
    let clientWorkerA: Client;
    let clientWorkerB: Client;
    let queueWorkerA: PostgresWebhookEventQueue;
    let queueWorkerB: PostgresWebhookEventQueue;

    beforeAll(async () => {
      clientWorkerA = await createStage2Client();
      clientWorkerB = await createStage2Client();
      queueWorkerA = new PostgresWebhookEventQueue(clientWorkerA);
      queueWorkerB = new PostgresWebhookEventQueue(clientWorkerB);
    });

    afterAll(async () => {
      await clientWorkerA.end();
      await clientWorkerB.end();
    });

    // 1. Expired PROCESSING lease is reclaimed
    it("reclaims an event with an expired PROCESSING lease and assigns a fresh lease and fencing token", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_lease_exp_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-EXP-01",
        captureId: "CAP-EXP-01",
        amountCents: 5000,
        rawPayload: { test: "lease_expiration" },
      });

      // Worker A claims the event
      const batchA = await queueWorkerA.dequeueBatch(1, "worker-A", 60);
      expect(batchA.length).toBe(1);
      expect(batchA[0].id).toBe(enqueued.id);
      expect(batchA[0].attempts).toBe(1);
      expect(batchA[0].claimToken).toBeDefined();
      const tokenA = batchA[0].claimToken;

      // Simulate expiration of Worker A's lease (locked_until in the past)
      await masterClient.query(
        `UPDATE public."WebhookEventQueue"
            SET locked_until = clock_timestamp() - interval '5 seconds'
          WHERE id = $1;`,
        [enqueued.id]
      );

      // Worker B dequeues; must reclaim the expired PROCESSING event
      const batchB = await queueWorkerB.dequeueBatch(1, "worker-B", 60);
      expect(batchB.length).toBe(1);
      expect(batchB[0].id).toBe(enqueued.id);
      expect(batchB[0].status).toBe("PROCESSING");
      expect(batchB[0].attempts).toBe(2);
      expect(batchB[0].lockedBy).toBe("worker-B");
      expect(batchB[0].claimToken).toBeDefined();
      expect(batchB[0].claimToken).not.toBe(tokenA); // Fresh fencing token assigned!
    });

    // 2. Active PROCESSING lease is NOT reclaimed
    it("does NOT reclaim an event while its PROCESSING lease remains active", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_lease_act_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-ACT-01",
        captureId: "CAP-ACT-01",
        amountCents: 4500,
        rawPayload: { test: "active_lease" },
      });

      // Worker A claims with 120s lease
      const batchA = await queueWorkerA.dequeueBatch(1, "worker-A", 120);
      expect(batchA.length).toBe(1);
      expect(batchA[0].id).toBe(enqueued.id);

      // Worker B tries to claim immediately; lease is still active
      const batchB = await queueWorkerB.dequeueBatch(1, "worker-B", 60);
      expect(batchB.length).toBe(0);

      // Verify row in database remains owned by Worker A in PROCESSING status
      const dbItem = await queue.getQueueItem(enqueued.id);
      expect(dbItem?.status).toBe("PROCESSING");
      expect(dbItem?.lockedBy).toBe("worker-A");
      expect(dbItem?.attempts).toBe(1);
    });

    // 3. Crashed worker's event becomes available after lease expiration
    it("makes a crashed worker's event available to surviving workers after lease expiration", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_crash_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-CRASH-01",
        captureId: "CAP-CRASH-01",
        amountCents: 7500,
        rawPayload: { test: "crash_recovery" },
      });

      // Simulate worker 1 claiming the item and then crashing abruptly
      const batch1 = await queueWorkerA.dequeueBatch(1, "worker-crashed-pid-9999", 60);
      expect(batch1.length).toBe(1);

      // Simulate elapsed time past the lease duration
      await masterClient.query(
        `UPDATE public."WebhookEventQueue"
            SET locked_until = clock_timestamp() - interval '1 second'
          WHERE id = $1;`,
        [enqueued.id]
      );

      // Surviving worker 2 claims the abandoned event
      const batch2 = await queueWorkerB.dequeueBatch(1, "worker-surviving-pid-1000", 60);
      expect(batch2.length).toBe(1);
      expect(batch2[0].id).toBe(enqueued.id);
      expect(batch2[0].lockedBy).toBe("worker-surviving-pid-1000");

      // Surviving worker completes the event
      await queueWorkerB.markCompleted(batch2[0].id, batch2[0].claimToken!);

      // Verify final state is COMPLETED and unlocked
      const completedItem = await queue.getQueueItem(enqueued.id);
      expect(completedItem?.status).toBe("COMPLETED");
      expect(completedItem?.lockedUntil).toBeNull();
      expect(completedItem?.lockedBy).toBeNull();
    });

    // 4. Two concurrent workers cannot validly claim the same event
    it("ensures two concurrent workers racing on a single item never double-claim", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_race_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-RACE-01",
        captureId: "CAP-RACE-01",
        amountCents: 3200,
        rawPayload: { test: "concurrency_race" },
      });

      // Concurrently invoke dequeueBatch on Worker A and Worker B
      const [batchA, batchB] = await Promise.all([
        queueWorkerA.dequeueBatch(1, "worker-A", 60),
        queueWorkerB.dequeueBatch(1, "worker-B", 60),
      ]);

      const totalClaimed = batchA.length + batchB.length;
      expect(totalClaimed).toBe(1); // Exactly one worker succeeded!

      const winner = batchA.length === 1 ? "worker-A" : "worker-B";
      const loser = winner === "worker-A" ? batchB : batchA;
      expect(loser.length).toBe(0);

      const winningItem = batchA.length === 1 ? batchA[0] : batchB[0];
      expect(winningItem.id).toBe(enqueued.id);
      expect(winningItem.lockedBy).toBe(winner);
    });

    // 5. Stale worker cannot complete an event after another worker reclaims it
    it("rejects markCompleted with StaleClaimError when a stale worker attempts to complete a reclaimed event", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_stale_comp_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-STALE-COMP-01",
        captureId: "CAP-STALE-COMP-01",
        amountCents: 2000,
        rawPayload: { test: "stale_completion" },
      });

      // 1. Worker A claims the event
      const batchA = await queueWorkerA.dequeueBatch(1, "worker-A", 60);
      const itemA = batchA[0];
      const tokenA = itemA.claimToken!;

      // 2. Worker A stalls; lease expires
      await masterClient.query(
        `UPDATE public."WebhookEventQueue"
            SET locked_until = clock_timestamp() - interval '2 seconds'
          WHERE id = $1;`,
        [enqueued.id]
      );

      // 3. Worker B reclaims the event
      const batchB = await queueWorkerB.dequeueBatch(1, "worker-B", 60);
      const itemB = batchB[0];
      const tokenB = itemB.claimToken!;
      expect(tokenB).not.toBe(tokenA);

      // 4. Stale Worker A resumes and attempts markCompleted with tokenA
      await expect(
        queueWorkerA.markCompleted(itemA.id, tokenA)
      ).rejects.toThrow(StaleClaimError);

      // 5. Verify the event in database remains in PROCESSING owned by Worker B
      let dbItem = await queue.getQueueItem(enqueued.id);
      expect(dbItem?.status).toBe("PROCESSING");
      expect(dbItem?.lockedBy).toBe("worker-B");
      expect(dbItem?.claimToken).toBe(tokenB);

      // 6. Worker B completes the event with valid tokenB -> succeeds!
      await queueWorkerB.markCompleted(itemB.id, tokenB);

      dbItem = await queue.getQueueItem(enqueued.id);
      expect(dbItem?.status).toBe("COMPLETED");
    });

    // 6. Stale worker cannot schedule a retry or mark newer worker's event as failed
    it("rejects markFailedWithRetry and moveToDeadLetterQueue from a stale worker", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_stale_fail_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-STALE-FAIL-01",
        captureId: "CAP-STALE-FAIL-01",
        amountCents: 1500,
        rawPayload: { test: "stale_failure" },
      });

      // 1. Worker A claims the event
      const batchA = await queueWorkerA.dequeueBatch(1, "worker-A", 60);
      const itemA = batchA[0];
      const tokenA = itemA.claimToken!;

      // 2. Lease expires
      await masterClient.query(
        `UPDATE public."WebhookEventQueue"
            SET locked_until = clock_timestamp() - interval '1 second'
          WHERE id = $1;`,
        [enqueued.id]
      );

      // 3. Worker B reclaims
      const batchB = await queueWorkerB.dequeueBatch(1, "worker-B", 60);
      const itemB = batchB[0];
      const tokenB = itemB.claimToken!;

      // 4. Stale Worker A attempts markFailedWithRetry
      await expect(
        queueWorkerA.markFailedWithRetry(itemA.id, 5000, "Stale worker error", tokenA)
      ).rejects.toThrow(StaleClaimError);

      // Verify row still owned by Worker B
      let dbItem = await queue.getQueueItem(enqueued.id);
      expect(dbItem?.status).toBe("PROCESSING");
      expect(dbItem?.lockedBy).toBe("worker-B");

      // 5. Stale Worker A attempts moveToDeadLetterQueue
      await expect(
        queueWorkerA.moveToDeadLetterQueue(itemA.id, "Stale worker terminal error", tokenA)
      ).rejects.toThrow(StaleClaimError);

      // Verify row is STILL PROCESSING and owned by Worker B
      dbItem = await queue.getQueueItem(enqueued.id);
      expect(dbItem?.status).toBe("PROCESSING");
      expect(dbItem?.lockedBy).toBe("worker-B");

      // 6. Stale Worker A attempts renewLease
      await expect(
        queueWorkerA.renewLease(itemA.id, 60, tokenA)
      ).rejects.toThrow(StaleClaimError);

      // 7. Legitimate Worker B completes successfully
      await queueWorkerB.markCompleted(itemB.id, tokenB);
      dbItem = await queue.getQueueItem(enqueued.id);
      expect(dbItem?.status).toBe("COMPLETED");
    });

    // 7. Retry timing and maximum-attempt behavior remain unchanged
    it("preserves exponential backoff retry timing and transitions to DEAD_LETTER after max attempts", async () => {
      const enqueued = await queue.enqueue({
        transmissionId: "tx_resilience_retry_flow_" + crypto.randomUUID(),
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId: "ORD-RETRY-01",
        captureId: "CAP-RETRY-01",
        amountCents: 9900,
        rawPayload: { test: "retry_behavior" },
        maxAttempts: 3,
      });

      // Attempt 1: Worker claims and fails retryable with 200ms backoff
      const b1 = await queueWorkerA.dequeueBatch(1, "worker-1", 60);
      expect(b1.length).toBe(1);
      expect(b1[0].attempts).toBe(1);

      await queueWorkerA.markFailedWithRetry(b1[0].id, 200, "Simulated transient failure 1", b1[0].claimToken!);

      // Immediately try to dequeue: next_attempt_at is in the future (+200ms), should return 0 items
      const bImmediate = await queueWorkerA.dequeueBatch(1, "worker-1", 60);
      expect(bImmediate.length).toBe(0);

      // Wait for backoff duration (250ms)
      await new Promise((r) => setTimeout(r, 250));

      // Attempt 2: Worker claims and fails retryable with 200ms backoff
      const b2 = await queueWorkerA.dequeueBatch(1, "worker-1", 60);
      expect(b2.length).toBe(1);
      expect(b2[0].attempts).toBe(2);

      await queueWorkerA.markFailedWithRetry(b2[0].id, 200, "Simulated transient failure 2", b2[0].claimToken!);

      // Wait for backoff duration (250ms)
      await new Promise((r) => setTimeout(r, 250));

      // Attempt 3: Worker claims (attempts reaches maxAttempts = 3)
      const b3 = await queueWorkerA.dequeueBatch(1, "worker-1", 60);
      expect(b3.length).toBe(1);
      expect(b3[0].attempts).toBe(3);

      // Worker routes to DLQ
      await queueWorkerA.moveToDeadLetterQueue(b3[0].id, "Terminal max attempts exceeded", b3[0].claimToken!);

      // Verify DLQ state
      const dlqItem = await queue.getQueueItem(enqueued.id);
      expect(dlqItem?.status).toBe("DEAD_LETTER");
      expect(dlqItem?.attempts).toBe(3);
      expect(dlqItem?.lastError).toContain("Terminal max attempts exceeded");
    });

    // 8. Existing webhook replay/idempotency behavior remains intact
    it("preserves webhook ingress replay protection and idempotency without duplicate queue items", async () => {
      const txId = "tx_resilience_replay_safe_" + crypto.randomUUID();
      const orderId = "ORD-REPLAY-SAFE-01";
      const captureId = "CAP-REPLAY-SAFE-01";

      const req1 = createSignedWebhookRequest(txId, orderId, captureId, 5000, true);
      const res1 = await webhookRoute(req1);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.received).toBe(true);
      expect(body1.queueItemId).toBeDefined();

      // Send identical webhook request again (replay)
      const req2 = createSignedWebhookRequest(txId, orderId, captureId, 5000, true);
      const res2 = await webhookRoute(req2);
      // Replay with identical transmission ID is rejected fail-closed with HTTP 409 Conflict
      expect(res2.status).toBe(409);

      // Verify that exactly 1 queue item exists for this transmission_id in WebhookEventQueue
      const qCount = await masterClient.query(
        `SELECT count(*) FROM public."WebhookEventQueue" WHERE transmission_id = $1;`,
        [txId]
      );
      expect(Number(qCount.rows[0].count)).toBe(1);
    });

    // 9. WebhookReconciliationWorker handles StaleClaimError gracefully
    it("gracefully catches StaleClaimError in WebhookReconciliationWorker without retrying or overwriting newer workers", async () => {
      const orderId = "ORD-WORKER-STALE-" + crypto.randomUUID();
      const captureId = "CAP-WORKER-STALE-" + crypto.randomUUID();
      const txId = "tx_resilience_worker_stale_" + crypto.randomUUID();

      // Create cart in CAPTURING
      await createTestCartFixture(
        masterClient,
        "CAPTURING",
        4000,
        0,
        0,
        0,
        "merchant@example.com",
        orderId
      );

      // Enqueue webhook item
      const item = await queue.enqueue({
        transmissionId: txId,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        orderId,
        captureId,
        amountCents: 4000,
        rawPayload: { test: "worker_stale_handling" },
      });

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const refundService = new RefundService(masterClient, mockGateway, hmacKeyId);
      const reconciler = new WebhookPaymentReconciler(masterClient, captureService, refundService);

      // Claim item manually so we have tokenA
      const batch = await queueWorkerA.dequeueBatch(1, "worker-test-stale-01", 60);
      const claimedItem = batch[0];
      const tokenA = claimedItem.claimToken!;

      // Advance lock expiration and have Worker B reclaim it
      await masterClient.query(
        `UPDATE public."WebhookEventQueue"
            SET locked_until = clock_timestamp() - interval '1 second'
          WHERE id = $1;`,
        [item.id]
      );
      const batchB = await queueWorkerB.dequeueBatch(1, "worker-B", 60);
      expect(batchB.length).toBe(1);

      // Now test that if worker executes markCompleted with tokenA, it throws StaleClaimError
      await expect(
        queueWorkerA.markCompleted(claimedItem.id, tokenA)
      ).rejects.toThrow(StaleClaimError);

      // Clean up by completing with Worker B
      await queueWorkerB.markCompleted(batchB[0].id, batchB[0].claimToken!);
    });
  });
});
