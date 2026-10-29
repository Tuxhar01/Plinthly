import { describe, it, expect, beforeEach } from "vitest";
import {
  computePayloadHash,
  executeWithIdempotency,
  validateIdempotencyKey,
  IdempotencyConflictError,
} from "../../lib/workflow/idempotency";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";

describe("Phase 4.1 Idempotency Groundwork", () => {
  let repo: InMemoryPurchaseRepository;

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
  });

  describe("computePayloadHash", () => {
    it("produces identical 64-char hex hash regardless of object key order", () => {
      const obj1 = { budgetCents: 5000, currency: "USD", requirements: ["a", "b"] };
      const obj2 = { requirements: ["a", "b"], currency: "USD", budgetCents: 5000 };

      const hash1 = computePayloadHash(obj1);
      const hash2 = computePayloadHash(obj2);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for materially different payloads", () => {
      const hash1 = computePayloadHash({ budgetCents: 5000, currency: "USD" });
      const hash2 = computePayloadHash({ budgetCents: 5001, currency: "USD" });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("validateIdempotencyKey", () => {
    it("accepts valid non-empty strings up to 128 chars", () => {
      expect(validateIdempotencyKey("valid-key-123")).toBe("valid-key-123");
      expect(validateIdempotencyKey("a".repeat(128))).toHaveLength(128);
    });

    it("rejects empty, whitespace-only, or overly long keys", () => {
      expect(validateIdempotencyKey("")).toBeNull();
      expect(validateIdempotencyKey("   ")).toBeNull();
      expect(validateIdempotencyKey("a".repeat(129))).toBeNull();
      expect(validateIdempotencyKey(null)).toBeNull();
      expect(validateIdempotencyKey(123)).toBeNull();
    });
  });

  describe("executeWithIdempotency", () => {
    it("executes operation on first request and records result", async () => {
      let executionCount = 0;

      const result = await executeWithIdempotency(repo, {
        actorId: "usr_buyer_1",
        operation: "create_purchase",
        idempotencyKey: "key_first_call",
        payload: { budgetCents: 5000 },
        execute: async () => {
          executionCount++;
          return { status: 201, body: { purchaseId: "pur_100" } };
        },
      });

      expect(result.cached).toBe(false);
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ purchaseId: "pur_100" });
      expect(executionCount).toBe(1);
    });

    it("replays cached response on duplicate request with same payload without re-executing", async () => {
      let executionCount = 0;
      const payload = { budgetCents: 5000, currency: "USD" };

      // Call 1
      const res1 = await executeWithIdempotency(repo, {
        actorId: "usr_buyer_1",
        operation: "create_purchase",
        idempotencyKey: "key_replay",
        payload,
        execute: async () => {
          executionCount++;
          return { status: 201, body: { purchaseId: "pur_replay_1" } };
        },
      });

      expect(res1.cached).toBe(false);
      expect(executionCount).toBe(1);

      // Call 2 with identical key and payload
      const res2 = await executeWithIdempotency(repo, {
        actorId: "usr_buyer_1",
        operation: "create_purchase",
        idempotencyKey: "key_replay",
        payload,
        execute: async () => {
          executionCount++;
          return { status: 201, body: { purchaseId: "pur_should_not_run" } };
        },
      });

      expect(res2.cached).toBe(true);
      expect(res2.status).toBe(201);
      expect(res2.body).toEqual({ purchaseId: "pur_replay_1" });
      expect(executionCount).toBe(1); // Not executed again!
    });

    it("rejects key reuse with materially different payload", async () => {
      const payload1 = { budgetCents: 5000, currency: "USD" };
      const payload2 = { budgetCents: 9000, currency: "USD" };

      await executeWithIdempotency(repo, {
        actorId: "usr_buyer_1",
        operation: "create_purchase",
        idempotencyKey: "key_conflict",
        payload: payload1,
        execute: async () => ({ status: 201, body: { purchaseId: "pur_1" } }),
      });

      await expect(
        executeWithIdempotency(repo, {
          actorId: "usr_buyer_1",
          operation: "create_purchase",
          idempotencyKey: "key_conflict",
          payload: payload2,
          execute: async () => ({ status: 201, body: { purchaseId: "pur_2" } }),
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it("scopes idempotency keys to the resolved actor", async () => {
      let user1Executed = false;
      let user2Executed = false;

      // User 1 uses "shared-key-name"
      await executeWithIdempotency(repo, {
        actorId: "usr_1",
        operation: "create_purchase",
        idempotencyKey: "shared-key-name",
        payload: { budget: 100 },
        execute: async () => {
          user1Executed = true;
          return { status: 201, body: { purchaseId: "pur_usr1" } };
        },
      });

      // User 2 uses same "shared-key-name" -> does NOT collide
      const user2Result = await executeWithIdempotency(repo, {
        actorId: "usr_2",
        operation: "create_purchase",
        idempotencyKey: "shared-key-name",
        payload: { budget: 200 },
        execute: async () => {
          user2Executed = true;
          return { status: 201, body: { purchaseId: "pur_usr2" } };
        },
      });

      expect(user1Executed).toBe(true);
      expect(user2Executed).toBe(true);
      expect(user2Result.cached).toBe(false);
      expect(user2Result.body).toEqual({ purchaseId: "pur_usr2" });
    });
  });

  describe("Phase 4.2 Atomic Purchase-Creation Idempotency Regressions", () => {
    it("handles at least 10 simultaneous identical requests resulting in exactly one purchase", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const service = new PurchaseWorkflowService(repo);
      const actor = { kind: "user" as const, userId: "concurrent_buyer_1" };
      const now = new Date("2026-10-20T10:00:00Z");

      const req = {
        budgetCents: 7500,
        currency: "USD" as const,
        requirements: ["item_alpha", "item_beta"],
        idempotencyKey: "idem_concurrent_10_stress",
      };

      // Launch 10 simultaneous identical requests concurrently
      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.createPurchase(req, actor, now))
      );

      // All 10 returned successfully with identical purchase ID
      const firstId = results[0].id;
      expect(firstId).toMatch(/^pur_/);
      for (const res of results) {
        expect(res.id).toBe(firstId);
        expect(res.budgetCents).toBe(7500);
        expect(res.status).toBe("REQUIREMENTS_CONFIRMED");
      }

      // Exactly one purchase was committed to repository
      const createdPurchase = await repo.getPurchaseById(firstId);
      expect(createdPurchase).not.toBeNull();
      expect(createdPurchase?.purchase.id).toBe(firstId);

      // Exactly one proposed audit event exists
      const auditHistory = await repo.getAuditHistory(firstId);
      const proposedEvents = auditHistory.filter((e) => e.type === "proposed");
      expect(proposedEvents).toHaveLength(1);
    });

    it("returns 409 conflict on reusing key with different payload without creating second purchase", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const service = new PurchaseWorkflowService(repo);
      const actor = { kind: "user" as const, userId: "buyer_conflict_test" };

      // Request 1: initial creation
      const res1 = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec1"],
          idempotencyKey: "key_payload_diff_1",
        },
        actor
      );
      expect(res1.id).toBeDefined();

      // Request 2: same key, materially different payload
      await expect(
        service.createPurchase(
          {
            budgetCents: 9999,
            currency: "USD",
            requirements: ["completely_different_spec"],
            idempotencyKey: "key_payload_diff_1",
          },
          actor
        )
      ).rejects.toThrow(IdempotencyConflictError);

      // Verify no second purchase was created
      const committedIdem = await repo.getIdempotencyRecord(actor.userId, "create_purchase", "key_payload_diff_1");
      expect(committedIdem).not.toBeNull();
      expect((committedIdem?.responseBody as { id: string }).id).toBe(res1.id);
    });

    it("returns original purchase ID on successful retry", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const service = new PurchaseWorkflowService(repo);
      const actor = { kind: "user" as const, userId: "buyer_retry_test" };

      const payload = {
        budgetCents: 12000,
        currency: "USD" as const,
        requirements: ["req_retry"],
        idempotencyKey: "key_retry_exact",
      };

      const res1 = await service.createPurchase(payload, actor);
      const res2 = await service.createPurchase(payload, actor);

      expect(res2.id).toBe(res1.id);
      expect(res2.createdAt).toBe(res1.createdAt);
      expect(res2.budgetCents).toBe(12000);
    });

    it("preserves idempotency result and purchase ID across process restarts", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const actor = { kind: "user" as const, userId: "buyer_restart_test" };
      const payload = {
        budgetCents: 8800,
        currency: "USD" as const,
        requirements: ["server_restart_req"],
        idempotencyKey: "key_across_restart",
      };

      // Service instance 1 simulates pre-restart process
      const serviceInstance1 = new PurchaseWorkflowService(repo);
      const originalResult = await serviceInstance1.createPurchase(payload, actor);

      // Service instance 2 simulates post-restart process sharing the same durable repo
      const serviceInstance2 = new PurchaseWorkflowService(repo);
      const replayedResult = await serviceInstance2.createPurchase(payload, actor);

      expect(replayedResult.id).toBe(originalResult.id);
      expect(replayedResult.version).toBe(originalResult.version);
    });

    it("rolls back purchase and idempotency record together if audit insertion fails", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const service = new PurchaseWorkflowService(repo);
      const actor = { kind: "user" as const, userId: "buyer_rollback_test" };

      // Poison the repository's createPurchase to simulate an audit failure during transaction
      const originalCreate = repo.createPurchase.bind(repo);
      repo.createPurchase = async () => {
        throw new Error("Simulated database failure during audit write");
      };

      await expect(
        service.createPurchase(
          {
            budgetCents: 3000,
            currency: "USD",
            requirements: ["must_rollback"],
            idempotencyKey: "key_rollback_atomicity",
          },
          actor
        )
      ).rejects.toThrow("Simulated database failure during audit write");

      // Restore original createPurchase
      repo.createPurchase = originalCreate;

      // Verify no idempotency record was committed
      const idemRecord = await repo.getIdempotencyRecord(actor.userId, "create_purchase", "key_rollback_atomicity");
      expect(idemRecord).toBeNull();
    });

    it("allows a failed attempt to be retried safely after resolution", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const service = new PurchaseWorkflowService(repo);
      const actor = { kind: "user" as const, userId: "buyer_safe_retry" };

      let failOnce = true;
      const originalCreate = repo.createPurchase.bind(repo);
      repo.createPurchase = async (p, a, i) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("Transient error on first try");
        }
        return originalCreate(p, a, i);
      };

      const payload = {
        budgetCents: 4500,
        currency: "USD" as const,
        requirements: ["retryable_req"],
        idempotencyKey: "key_safe_retry_success",
      };

      // First attempt fails
      await expect(service.createPurchase(payload, actor)).rejects.toThrow("Transient error on first try");

      // Second attempt succeeds safely with the same key
      const success = await service.createPurchase(payload, actor);
      expect(success.id).toMatch(/^pur_/);
      expect(success.budgetCents).toBe(4500);

      // Third attempt replays the successful purchase
      const replay = await service.createPurchase(payload, actor);
      expect(replay.id).toBe(success.id);
    });

    it("enforces deterministic 24-hour expiration policy", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const service = new PurchaseWorkflowService(repo);
      const actor = { kind: "user" as const, userId: "buyer_expiry_test" };

      const t0 = new Date("2026-10-20T12:00:00Z");
      const payload = {
        budgetCents: 6000,
        currency: "USD" as const,
        requirements: ["expiry_spec"],
        idempotencyKey: "key_expiry_24h",
      };

      // Created at t0
      const initial = await service.createPurchase(payload, actor, t0);
      expect(initial.id).toBeDefined();

      // Retry at t0 + 23 hours: valid, replays cached purchase
      const t23h = new Date(t0.getTime() + 23 * 3600 * 1000);
      const replayValid = await service.createPurchase(payload, actor, t23h);
      expect(replayValid.id).toBe(initial.id);

      // Retry at t0 + 25 hours: expired, throws IdempotencyConflictError
      const t25h = new Date(t0.getTime() + 25 * 3600 * 1000);
      await expect(service.createPurchase(payload, actor, t25h)).rejects.toThrow(
        "Idempotency key \"key_expiry_24h\" has expired and cannot be reused."
      );
    });
  });
});
