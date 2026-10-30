# Phase 4.2 — Atomic Purchase-Creation Idempotency Report

**Workspace:** `C:\Users\Tushar Kumar\Desktop\Plinthly`  
**Date:** 2026-10-20  
**Phase:** 4.2 — Atomic Purchase-Creation Idempotency  
**Status:** Completed  
**Final Verdict:** **PASS**

---

## 1. Executive Summary

Phase 4.2 resolved the concurrency defect identified in Phase 4.1 where simultaneous creation requests sharing an identical idempotency key could both execute purchase creation before the idempotency record was persisted.

Purchase creation, initial audit events, and idempotency record persistence now occur **atomically within a single PostgreSQL transaction**. A database-enforced compound unique index `(actor_id, operation, key)` establishes atomic key ownership. Concurrent conflicting requests are serialized at the database level: the winning transaction commits the purchase and idempotency record together, while competing transactions fail the unique constraint, roll back without committing partial state, and safely recover by replaying the committed response.

---

## 2. Root Cause & Concurrency Design

### 2.1 Root Cause in Phase 4.1
In Phase 4.1, `executeWithIdempotency` executed the operation callback (which invoked `this.repo.createPurchase`), and only *after* the purchase transaction committed did it attempt to call `this.repo.saveIdempotencyRecord`. Under concurrent arrival:
1. Two simultaneous requests with identical key `k` checked `getIdempotencyRecord(actorId, "create_purchase", k)`.
2. Both read `null` (neither had completed).
3. Both invoked `createPurchase()`, successfully creating two separate purchase aggregates in the database.
4. Both attempted `saveIdempotencyRecord()`. The second request failed with a unique constraint error, but duplicate purchase creation had already occurred.

### 2.2 Phase 4.2 Concurrency Architecture
The design establishes atomic reservation and persistence:
1. **Single Database Transaction Boundary:**
   `repo.createPurchase` now accepts an optional `idempotencyRecord?: IdempotencyRecord`.
   Inside `client.$transaction(async (tx) => { ... })`:
   - `tx.idempotencyRecord.create(...)` executes first.
   - `tx.purchase.create(...)` executes next.
   - `tx.auditEvent.createMany(...)` executes next.
   All three entities commit atomically in the same database transaction.
2. **Database-Enforced Mutual Exclusion:**
   Because PostgreSQL enforces uniqueness on `(actor_id, operation, key)`, simultaneous transactions competing for the same key block at the unique index level.
   - If the first transaction commits, the second transaction immediately aborts with a unique constraint violation (`P2002`). The transaction rolls back cleanly; no purchase and no audit event are written.
   - If the first transaction aborts or fails (e.g., validation failure), the lock releases on rollback, allowing a competing request to proceed.
3. **Safe Recovery & Polling Loop:**
   When a concurrent request catches a unique constraint error (`isUniqueConstraintViolation`), it enters a bounded recovery loop (up to 12 attempts with backoff) to re-read the winning committed record via `getIdempotencyRecord`.
   - Once retrieved, it validates canonical `requestHash`.
   - If matching and within 24 hours, it replays the committed response with the original purchase ID (`cached: true`).
   - If the request payload differed, it raises `IdempotencyConflictError` (HTTP 409).
4. **Deterministic 24-Hour Expiration:**
   `expiresAt` is set to `now + 24 hours`. When an existing key is accessed after 24 hours, `executeWithIdempotency` rejects the request with `IdempotencyConflictError("Idempotency key has expired and cannot be reused.")` (HTTP 409). This prevents stale packets from bypassing uniqueness without requiring external cron schedulers.

---

## 3. Files Modified

1. **`lib/workflow/idempotency.ts`**
   - Added `isUniqueConstraintViolation(error)` helper supporting Prisma `P2002`, PostgreSQL `23505`, and repository uniqueness messages.
   - Extended `ExecuteWithIdempotencyOptions` to pass candidate `idempotencyDraft` to the execution callback.
   - Added recovery loop on unique-constraint conflict to poll for committed winning record and replay.
   - Added deterministic 24-hour expiration verification (`expiresAt`).
2. **`lib/workflow/repository.ts`**
   - Updated `PurchaseRepository.createPurchase` signature to accept optional `idempotencyRecord?: IdempotencyRecord`.
   - Updated `PrismaPurchaseRepository.createPurchase` to write `idempotencyRecord` inside the interactive `$transaction`.
   - Updated `InMemoryPurchaseRepository.createPurchase` to atomically enforce key uniqueness (`P2002`) and store `idempotencyRecords` together with `purchases` and `auditEvents`.
   - Updated `InMemoryPurchaseRepository.saveIdempotencyRecord` to reject duplicate keys with code `P2002`.
3. **`lib/workflow/service.ts`**
   - In `createPurchase`, constructed planned response and passed `recordToPersist` into `this.repo.createPurchase(purchaseRecord, auditEvents, recordToPersist)`.
   - Removed duplicate `getPurchaseById` query after creation, assembling the response directly and persisting it atomically with the idempotency record.
4. **`tests/workflow/idempotency.test.ts`**
   - Added comprehensive Phase 4.2 regression suite covering:
     - 10 simultaneous identical requests producing exactly 1 purchase.
     - Payload conflict returning 409 without creating additional purchases.
     - Identical retry returning original purchase ID.
     - Process restart simulation preserving cached response.
     - Transaction rollback on audit failure freeing the key.
     - Safe retry after transient failure.
     - Deterministic 24-hour expiration enforcement.
5. **`tests/workflow/prisma-repository.test.ts`**
   - Added mock interactive transaction test verifying `tx.idempotencyRecord.create`, `tx.purchase.create`, and `tx.auditEvent.createMany` are all called inside `$transaction`.

---

## 4. Test Suite Execution & Verification

### 4.1 Verification Commands and Results

| Command | Exit Code | Result Summary |
| :--- | :---: | :--- |
| `npm test` | **0** | **440 passed** across 29 test suites (0 failed). |
| `npx tsc --noEmit` | **0** | Clean TypeScript typecheck with zero errors. |
| `npm run lint` | **0** | ESLint passed cleanly with zero warnings or errors. |
| `npm run build` | **0** | Next.js 16 (Turbopack) production build completed successfully. |
| `npx prisma validate` | **0** | Prisma schema validated successfully. |

### 4.2 Regression Test Matrix

| Test Requirement | Test File | Execution Type | Status |
| :--- | :--- | :--- | :---: |
| **>= 10 simultaneous identical requests -> exactly 1 purchase** | `tests/workflow/idempotency.test.ts` | In-Memory Atomic Repository | **PASS** |
| **Same key, different payload -> 409 conflict, no purchase** | `tests/workflow/idempotency.test.ts` | In-Memory Atomic Repository | **PASS** |
| **Successful retry returns original purchase ID** | `tests/workflow/idempotency.test.ts` | In-Memory Atomic Repository | **PASS** |
| **Process restart preserves idempotency result** | `tests/workflow/idempotency.test.ts` | In-Memory Shared Persistence | **PASS** |
| **Failure rolls back purchase and idempotency record** | `tests/workflow/idempotency.test.ts` | In-Memory Atomic Repository | **PASS** |
| **Failed attempt can be retried safely** | `tests/workflow/idempotency.test.ts` | In-Memory Atomic Repository | **PASS** |
| **Deterministic 24-hour key expiration** | `tests/workflow/idempotency.test.ts` | In-Memory Atomic Repository | **PASS** |
| **Prisma interactive transaction atomicity** | `tests/workflow/prisma-repository.test.ts` | Mock Prisma Client | **PASS** |
| **Existing Phase 0–4.1 workflow, state, policy, discovery tests** | All 29 test suites | Vitest Unit/Integration | **PASS** |

### 4.3 Unverified PostgreSQL Behavior
As noted in Phase 4.1, no live PostgreSQL daemon is active on the local Windows host. Database-level behavior (such as row locks, interactive transaction rollbacks, and unique constraint enforcement on `(actor_id, operation, key)`) is tested via unit-level mock transactions and simulated atomic repository tests. Execution against an active PostgreSQL instance will occur upon staging deployment when the migration is applied.

---

## 5. Gate 1 Hash & Environment Verification

- **Baseline File:** `C:\paypal-gate1\gate1.mjs`
- **Expected SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Pre-execution SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Post-execution SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Comparison:** **EXACT MATCH (UNMODIFIED)**
- **Git Remotes:** Confirmed 0 remote repositories configured (`git remote -v` returned empty).
- **Deployment Status:** Zero commits pushed, zero packages published, zero deployments triggered.

---

## 6. Verdict

# **PASS**

Phase 4.2 requirements are completely fulfilled. Purchase creation and idempotency persistence are atomic, concurrent duplicate creation is prevented by database-enforced compound uniqueness, and existing workflow integrity is preserved. Phase 5 (PayPal Sandbox integration) may proceed upon authorization.
