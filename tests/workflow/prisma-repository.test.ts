import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  PrismaPurchaseRepository,
  DatabaseUnavailableError,
  PurchaseRecord,
  InMemoryPurchaseRepository,
  getPurchaseRepository,
  setPurchaseRepository,
  resetPurchaseRepository,
  disconnectPurchaseRepository,
} from "../../lib/workflow/repository";
import { AuditEventDraft, AuditPayloadMap } from "../../lib/state/types";

describe("PrismaPurchaseRepository - Database Fail-Closed and Transaction Semantics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Fail-Closed Database Availability Checks", () => {
    it("fails closed and throws DatabaseUnavailableError when DATABASE_URL is not set", async () => {
      const repo = new PrismaPurchaseRepository();

      const purchase: PurchaseRecord = {
        id: "pur_fail_nodb",
        status: "DRAFT",
        requirements: ["item"],
        budgetCents: 5000,
        currency: "USD",
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "usr_1",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(repo.createPurchase(purchase, [])).rejects.toThrow(DatabaseUnavailableError);
    });

    it("does not silently fall back to in-memory persistence when PostgreSQL is unavailable", async () => {
      const repo = new PrismaPurchaseRepository();

      await expect(repo.getPurchaseById("any_id")).rejects.toThrow(DatabaseUnavailableError);
      await expect(repo.getAuditHistory("any_id")).rejects.toThrow(DatabaseUnavailableError);
    });
  });

  describe("Interactive Transaction and Concurrency Mock Verification", () => {
    it("executes atomic purchase creation and audit event writes inside an interactive transaction", async () => {
      const mockPurchaseCreate = vi.fn().mockResolvedValue({
        id: "pur_tx_1",
        status: "REQUIREMENTS_CONFIRMED",
        requirements: ["spec1"],
        budgetCents: 5000,
        currency: "USD",
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "buyer_tx",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const mockAuditEventCreateMany = vi.fn().mockResolvedValue({ count: 1 });

      const mockTx = {
        purchase: { create: mockPurchaseCreate },
        auditEvent: { createMany: mockAuditEventCreateMany },
      };

      const mockPrismaClient = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
      } as unknown as PrismaClient;

      const repo = new PrismaPurchaseRepository(mockPrismaClient);

      const purchase: PurchaseRecord = {
        id: "pur_tx_1",
        status: "REQUIREMENTS_CONFIRMED",
        requirements: ["spec1"],
        budgetCents: 5000,
        currency: "USD",
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "buyer_tx",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const auditEvents: AuditEventDraft[] = [
        {
          type: "proposed",
          purchaseId: "pur_tx_1",
          actor: { kind: "user", userId: "buyer_tx" },
          occurredAt: new Date(),
          payload: { budgetCents: 5000, currency: "USD" },
        },
      ];

      const created = await repo.createPurchase(purchase, auditEvents);

      expect(mockPrismaClient.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPurchaseCreate).toHaveBeenCalledTimes(1);
      expect(mockAuditEventCreateMany).toHaveBeenCalledTimes(1);
      expect(created.id).toBe("pur_tx_1");
    });

    it("persists purchase, initial audit event, and idempotency record atomically in one transaction", async () => {
      const mockPurchaseCreate = vi.fn().mockResolvedValue({
        id: "pur_tx_atomic_idem",
        status: "REQUIREMENTS_CONFIRMED",
        requirements: ["item_atomic"],
        budgetCents: 5000,
        currency: "USD",
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "buyer_atomic",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const mockAuditEventCreateMany = vi.fn().mockResolvedValue({ count: 1 });
      const mockIdempotencyCreate = vi.fn().mockResolvedValue({ id: "idem_record_1" });

      const mockTx = {
        purchase: { create: mockPurchaseCreate },
        auditEvent: { createMany: mockAuditEventCreateMany },
        idempotencyRecord: { create: mockIdempotencyCreate },
      };

      const mockPrismaClient = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
      } as unknown as PrismaClient;

      const repo = new PrismaPurchaseRepository(mockPrismaClient);

      const purchase: PurchaseRecord = {
        id: "pur_tx_atomic_idem",
        status: "REQUIREMENTS_CONFIRMED",
        requirements: ["item_atomic"],
        budgetCents: 5000,
        currency: "USD",
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "buyer_atomic",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const auditEvents: AuditEventDraft[] = [
        {
          type: "proposed",
          purchaseId: "pur_tx_atomic_idem",
          actor: { kind: "user", userId: "buyer_atomic" },
          occurredAt: new Date(),
          payload: { budgetCents: 5000, currency: "USD" },
        },
      ];

      const idempotencyRecord = {
        id: "idem_record_1",
        key: "key_tx_test",
        actorId: "buyer_atomic",
        operation: "create_purchase",
        requestHash: "0".repeat(64),
        responseStatus: 201,
        responseBody: { id: "pur_tx_atomic_idem" },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      };

      const created = await repo.createPurchase(purchase, auditEvents, idempotencyRecord);

      expect(mockPrismaClient.$transaction).toHaveBeenCalledTimes(1);
      expect(mockIdempotencyCreate).toHaveBeenCalledTimes(1);
      expect(mockPurchaseCreate).toHaveBeenCalledTimes(1);
      expect(mockAuditEventCreateMany).toHaveBeenCalledTimes(1);
      expect(created.id).toBe("pur_tx_atomic_idem");
    });

    it("pre-validates audit events and aborts transaction before touching database if audit contains forbidden keys", async () => {
      const mockPrismaClient = {
        $transaction: vi.fn(),
      } as unknown as PrismaClient;

      const repo = new PrismaPurchaseRepository(mockPrismaClient);

      const purchase: PurchaseRecord = {
        id: "pur_poison_tx",
        status: "DRAFT",
        requirements: [],
        budgetCents: 1000,
        currency: "USD",
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "buyer_tx",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const poisonedAudit: AuditEventDraft<"proposed"> = {
        type: "proposed",
        purchaseId: "pur_poison_tx",
        actor: { kind: "user", userId: "buyer_tx" },
        occurredAt: new Date(),
        payload: {
          budgetCents: 1000,
          currency: "USD",
          ...({ secret_token: "leaked_secret" } as Record<string, unknown>),
        } as unknown as AuditPayloadMap["proposed"],
      };

      await expect(repo.createPurchase(purchase, [poisonedAudit])).rejects.toThrow();

      expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
    });

    it("enforces database-level conditional update matching status and version, throwing on conflict", async () => {
      const mockPurchaseUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

      const mockTx = {
        purchase: { updateMany: mockPurchaseUpdateMany },
        policyResult: { createMany: vi.fn() },
        auditEvent: { createMany: vi.fn() },
      };

      const mockPrismaClient = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
      } as unknown as PrismaClient;

      const repo = new PrismaPurchaseRepository(mockPrismaClient);

      await expect(
        repo.recordEvaluation({
          purchaseId: "pur_conflict_1",
          expectedStatus: "REQUIREMENTS_CONFIRMED",
          expectedVersion: 1,
          nextStatus: "POLICY_PASSED",
          selectedCandidateId: "cand_1",
          policyVersion: "1.0.0",
          policyEvidenceFingerprint: "fp",
          policyResults: [],
          auditEvents: [],
        })
      ).rejects.toThrow("Concurrency conflict");

      expect(mockPurchaseUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "pur_conflict_1",
          status: "REQUIREMENTS_CONFIRMED",
          version: 1,
        },
        data: expect.objectContaining({
          status: "POLICY_PASSED",
          version: { increment: 1 },
        }),
      });
    });
  });

  describe("Lifecycle, Teardown, and Singleton Hardening", () => {
    it("calls $disconnect() on the underlying Prisma client when disconnect() is called", async () => {
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      const mockPrismaClient = {
        $disconnect: mockDisconnect,
      } as unknown as PrismaClient;

      const repo = new PrismaPurchaseRepository(mockPrismaClient);
      await repo.disconnect();

      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Subsequent disconnect calls are idempotent
      await repo.disconnect();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it("allows InMemoryPurchaseRepository to disconnect cleanly", async () => {
      const memRepo = new InMemoryPurchaseRepository();
      await expect(memRepo.disconnect()).resolves.toBeUndefined();
    });

    it("manages global repository singleton and allows reset and clean teardown", async () => {
      const originalRepo = getPurchaseRepository();
      expect(originalRepo).toBeDefined();

      const testDouble = new InMemoryPurchaseRepository();
      setPurchaseRepository(testDouble);
      expect(getPurchaseRepository()).toBe(testDouble);

      // Teardown via disconnectPurchaseRepository
      await expect(disconnectPurchaseRepository()).resolves.toBeUndefined();

      // Reset back to default PrismaPurchaseRepository
      resetPurchaseRepository();
      const resetRepo = getPurchaseRepository();
      expect(resetRepo).toBeInstanceOf(PrismaPurchaseRepository);
    });
  });
});

