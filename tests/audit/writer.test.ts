import { describe, expect, it, vi } from "vitest";
import {
  createPrismaAuditStore,
  InMemoryAuditStore,
  PrismaAuditDelegate,
} from "../../lib/audit/writer";
import { AuditEventDraft } from "../../lib/state/types";

const mockNow = new Date("2026-10-20T12:00:00Z");
const userActor = { kind: "user" as const, userId: "user-123" };

describe("Audit Writer", () => {
  const validDrafts: Record<string, AuditEventDraft> = {
    proposed: {
      type: "proposed",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: { budgetCents: 5000, currency: "USD" },
    },
    requirements_confirmed: {
      type: "requirements_confirmed",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {},
    },
    evaluated: {
      type: "evaluated",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: { candidateId: "cand-1", reason: "candidate_selected" },
    },
    policy_blocked: {
      type: "policy_blocked",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: { blockingRuleKeys: ["rule-1"], unknownRuleKeys: [] },
    },
    policy_passed: {
      type: "policy_passed",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: { policyVersion: "v1.0" },
    },
    approved: {
      type: "approved",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {
        approvalId: "app-1",
        candidateId: "cand-1",
        snapshotHash: "a".repeat(64),
        totalCents: 2000,
        currency: "USD",
        policyVersion: "v1.0",
        evidenceFingerprint: "e".repeat(64),
        approverUserId: "user-123",
      },
    },
    approval_invalidated: {
      type: "approval_invalidated",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: { approvalId: "app-1", reasons: ["candidate_changed"] },
    },
    order_created: {
      type: "order_created",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {
        paymentAttemptId: "pay-1",
        approvalId: "app-1",
        paypalOrderId: "order-1",
        totalCents: 2000,
      },
    },
    buyer_approved: {
      type: "buyer_approved",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {
        paymentAttemptId: "pay-1",
        paypalOrderId: "order-1",
        verifiedStatus: "APPROVED",
        observedAt: mockNow.toISOString(),
      },
    },
    capture_attempted: {
      type: "capture_attempted",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: { paymentAttemptId: "pay-1" },
    },
    completed: {
      type: "completed",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {
        paymentAttemptId: "pay-1",
        paypalOrderId: "order-1",
        verifiedStatus: "COMPLETED",
        observedAt: mockNow.toISOString(),
      },
    },
    failed: {
      type: "failed",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {
        paymentAttemptId: "pay-1",
        source: "capture_rejected",
        reason: "Declined by bank",
        verifiedStatus: null,
      },
    },
    cancelled: {
      type: "cancelled",
      purchaseId: "pur-1",
      actor: userActor,
      occurredAt: mockNow,
      payload: {
        fromStatus: "APPROVED",
        paymentAttemptId: null,
        reason: "User changed mind",
      },
    },
  };

  it("accepts each of the 13 event types with a valid payload", async () => {
    const store = new InMemoryAuditStore();
    for (const draft of Object.values(validDrafts)) {
      await expect(store.append([draft])).resolves.not.toThrow();
    }
    expect(store.getRecords()).toHaveLength(13);
  });

  it("rejects missing required reason field", async () => {
    const store = new InMemoryAuditStore();
    const invalidEvaluated: AuditEventDraft = {
      ...validDrafts.evaluated,
      payload: { candidateId: "cand-1", reason: "" as unknown as "candidate_selected" },
    };
    await expect(store.append([invalidEvaluated])).rejects.toThrow(/invalid reason/);
  });

  it("rejects payload key named secret, token, password, or authorization at top level and nested", async () => {
    const store = new InMemoryAuditStore();

    const topSecret: AuditEventDraft = {
      ...validDrafts.proposed,
      payload: { budgetCents: 100, currency: "USD", secretKey: "123" } as unknown as { budgetCents: number; currency: "USD" },
    };
    await expect(store.append([topSecret])).rejects.toThrow(/Forbidden key "secretKey"/);

    const nestedToken: AuditEventDraft = {
      ...validDrafts.proposed,
      payload: {
        budgetCents: 100,
        currency: "USD",
        nested: { authToken: "xyz" },
      } as unknown as { budgetCents: number; currency: "USD" },
    };
    await expect(store.append([nestedToken])).rejects.toThrow(/Forbidden key "authToken"/);

    const passwordKey: AuditEventDraft = {
      ...validDrafts.proposed,
      payload: { budgetCents: 100, currency: "USD", password: "pwd" } as unknown as { budgetCents: number; currency: "USD" },
    };
    await expect(store.append([passwordKey])).rejects.toThrow(/Forbidden key "password"/);

    const authKey: AuditEventDraft = {
      ...validDrafts.proposed,
      payload: { budgetCents: 100, currency: "USD", authorizationHeader: "val" } as unknown as { budgetCents: number; currency: "USD" },
    };
    await expect(store.append([authKey])).rejects.toThrow(/Forbidden key "authorizationHeader"/);
  });

  it("rejects invalid actor (user without userId, system without component)", async () => {
    const store = new InMemoryAuditStore();

    const userNoId: AuditEventDraft = {
      ...validDrafts.proposed,
      actor: { kind: "user", userId: "" },
    };
    await expect(store.append([userNoId])).rejects.toThrow(/userId must be non-empty/);

    const systemNoComp: AuditEventDraft = {
      ...validDrafts.proposed,
      actor: { kind: "system", component: "" },
    };
    await expect(store.append([systemNoComp])).rejects.toThrow(/component must be non-empty/);
  });

  it("rejects invalid occurredAt", async () => {
    const store = new InMemoryAuditStore();
    const invalidDate: AuditEventDraft = {
      ...validDrafts.proposed,
      occurredAt: new Date("invalid-date-string"),
    };
    await expect(store.append([invalidDate])).rejects.toThrow(/valid Date instance/);
  });

  it("rejects failed event with null paymentAttemptId", async () => {
    const store = new InMemoryAuditStore();
    const invalidFailed: AuditEventDraft = {
      ...validDrafts.failed,
      payload: {
        paymentAttemptId: null as unknown as string,
        source: "capture_rejected",
        reason: "failed",
        verifiedStatus: null,
      },
    };
    await expect(store.append([invalidFailed])).rejects.toThrow(/failed payload requires non-empty paymentAttemptId/);
  });

  it("rejects cancelled event with fromStatus outside PurchaseStatus set", async () => {
    const store = new InMemoryAuditStore();
    const invalidCancelled: AuditEventDraft = {
      ...validDrafts.cancelled,
      payload: {
        fromStatus: "INVALID_STATUS" as unknown as "DRAFT",
        paymentAttemptId: null,
        reason: "test",
      },
    };
    await expect(store.append([invalidCancelled])).rejects.toThrow(/cancelled payload has invalid fromStatus/);
  });

  it("batch with one invalid record writes nothing", async () => {
    const store = new InMemoryAuditStore();
    const invalidRec: AuditEventDraft = {
      ...validDrafts.proposed,
      payload: { budgetCents: -50, currency: "USD" },
    };

    await expect(store.append([validDrafts.proposed, invalidRec])).rejects.toThrow();
    expect(store.getRecords()).toHaveLength(0);
  });

  it("createPrismaAuditStore calls delegate.auditEvent.createMany once with all validated records", async () => {
    const createManyMock = vi.fn().mockResolvedValue({ count: 2 });
    const delegate: PrismaAuditDelegate = {
      auditEvent: {
        createMany: createManyMock,
      },
    };

    const prismaStore = createPrismaAuditStore(delegate);
    await prismaStore.append([validDrafts.proposed, validDrafts.requirements_confirmed]);

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock).toHaveBeenCalledWith({
      data: [
        {
          purchaseId: "pur-1",
          type: "proposed",
          actor: userActor,
          payload: validDrafts.proposed.payload,
          createdAt: mockNow,
        },
        {
          purchaseId: "pur-1",
          type: "requirements_confirmed",
          actor: userActor,
          payload: validDrafts.requirements_confirmed.payload,
          createdAt: mockNow,
        },
      ],
    });
  });
});
