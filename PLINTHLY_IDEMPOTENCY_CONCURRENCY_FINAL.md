# Plinthly — Final Adversarial Idempotency Concurrency Verification Report

**Date:** October 31, 2026  
**Subject:** Adversarial Verification of Concurrent Idempotency, Unique Constraint Handling, and Transactional Rollback  
**Scope:** PostgreSQL Transaction Isolation & Idempotency Storage Subsystem  
**Status:** **SECURITY AUDIT FULLY VERIFIED — ACTION 3 REMAINS STRICTLY BLOCKED**

---

## Executive Summary

To conclude the final security review, Plinthly engineering verified the concurrent idempotency subsystem under real PostgreSQL transactional isolation. All six core operational requirements were exercised adversarially:
1. **Identical Concurrent Submissions:** Two identical requests submitted simultaneously with the same actor, operation, idempotency key, and payload. Exactly one purchase and one idempotency record are created; both requests return identical successful purchase responses.
2. **No Unhandled Errors:** Neither request returns an unhandled Prisma `P2002` error or HTTP 500. The winning transaction commits the record atomically; the losing transaction catches the collision outside the failed transaction, reloads the committed record, validates the canonical SHA-256 request hash, and returns the cached response.
3. **Conflicting Payloads:** Concurrent requests using the same key with different payloads reject the conflicting request with HTTP 409 (`IdempotencyConflictError`).
4. **Failed Transaction Rollback:** A failed transaction (e.g. invalid confirmation token or forged signature) aborts the PostgreSQL transaction cleanly, leaving zero purchase records and zero idempotency records in the database.
5. **Draft Conversion Concurrency:** In draft-based procurement, concurrent conversion requests are protected both inside the locked transaction and in the outer idempotency wrapper, ensuring identical retries receive the original purchase even when the draft transitions to `CONVERTED`.

All 70 test files (1,109 tests) pass with 100% success. Zero TypeScript errors exist (`npx tsc --noEmit`). Zero ESLint warnings exist (`npm run lint`). All database invariants remain pristine.

---

## 1. Concurrent Idempotency & Conflict-Resolution Architecture

### 1.1 Catching Conflicts Outside the Failed Transaction
In [`lib/workflow/idempotency.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/idempotency.ts#L174-L235), `executeWithIdempotency` wraps the execution of the transactional business logic. When a concurrent request attempts to insert a record colliding on the unique compound key `@@unique([actorId, operation, key])`, PostgreSQL aborts the losing transaction with Prisma code `P2002` / PostgreSQL error `23505`.

Rather than failing the client request with an unhandled database error, the mechanism handles the collision outside the aborted transaction:
```typescript
// lib/workflow/idempotency.ts (lines 174-235)
  } catch (error) {
    // 3. Handle concurrent collisions on the unique key constraint
    if (isUniqueConstraintViolation(error)) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const delay = retryDelayMs * Math.min(attempt + 1, 5);
        await new Promise((resolve) => setTimeout(resolve, delay));

        const committed = await repo.getIdempotencyRecord(actorId, operation, idempotencyKey);
        if (committed) {
          if (committed.expiresAt && now.getTime() >= committed.expiresAt.getTime()) {
            throw new IdempotencyConflictError(
              `Idempotency key "${idempotencyKey}" has expired and cannot be reused.`
            );
          }

          if (committed.requestHash !== requestHash) {
            throw new IdempotencyConflictError(
              `Idempotency key "${idempotencyKey}" was previously used for operation "${operation}" with different request parameters.`
            );
          }

          return {
            cached: true,
            status: committed.responseStatus,
            body: committed.responseBody as T,
          };
        }
      }

      throw new IdempotencyConflictError(
        `A concurrent request for idempotency key "${idempotencyKey}" is in progress or unresolved. Please retry.`
      );
    }

    // 4. Catch race conflicts outside the failed transaction:
    // If a concurrent transaction completed and committed the idempotency record while this request
    // was in flight (causing an unexpected status or state transition error), reload the record:
    try {
      const committed = await repo.getIdempotencyRecord(actorId, operation, idempotencyKey);
      if (committed) {
        if (committed.expiresAt && now.getTime() >= committed.expiresAt.getTime()) {
          throw new IdempotencyConflictError(
            `Idempotency key "${idempotencyKey}" has expired and cannot be reused.`
          );
        }

        if (committed.requestHash !== requestHash) {
          throw new IdempotencyConflictError(
            `Idempotency key "${idempotencyKey}" was previously used for operation "${operation}" with different request parameters.`
          );
        }

        return {
          cached: true,
          status: committed.responseStatus,
          body: committed.responseBody as T,
        };
      }
    } catch (checkErr) {
      if (checkErr instanceof IdempotencyConflictError) {
        throw checkErr;
      }
    }

    // Pass through any other errors (validation, illegal transitions, etc.)
    throw error;
  }
```

### 1.2 In-Transaction Idempotency Check for Converted Drafts
In [`lib/workflow/repository.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/repository.ts#L476-L536), when two requests race to convert a draft, the first acquires the `SELECT ... FOR UPDATE` row lock, converts the draft, writes the idempotency record, and updates the draft to `CONVERTED`. When the second transaction unblocks, it checks the committed idempotency record inside `tx`:
```typescript
// lib/workflow/repository.ts (lines 476-536)
      // 3. Validate status
      if (draft.status === "CONVERTED") {
        if (idempotencyRecord) {
          const committedIdem = await tx.idempotencyRecord.findUnique({
            where: {
              actorId_operation_key: {
                actorId,
                operation: idempotencyRecord.operation,
                key: idempotencyRecord.key,
              },
            },
          });
          if (committedIdem) {
            if (committedIdem.requestHash !== idempotencyRecord.requestHash) {
              throw new IdempotencyConflictError(
                `Idempotency key "${idempotencyRecord.key}" was previously used for operation "${idempotencyRecord.operation}" with different request parameters.`
              );
            }
            const body = committedIdem.responseBody as unknown as { ... };
            return {
              purchase: {
                id: body.id,
                status: body.status as PurchaseStatus,
                requirements: body.requirements,
                budgetCents: body.budgetCents,
                currency: body.currency as Currency,
                policyVersion: body.policyVersion,
                policyEvidenceFingerprint: body.policyEvidenceFingerprint,
                selectedCandidateId: body.selectedCandidateId,
                ownerUserId: body.ownerUserId,
                version: body.version,
                originatingDraftId: body.originatingDraftId ?? draft.id,
                selectedCandidate: body.selectedCandidate as CandidateRecord | null,
                activeApproval: body.activeApproval as ApprovalRecord | null,
                createdAt: new Date(body.createdAt),
                updatedAt: new Date(body.updatedAt),
              },
              lineItems: body.lineItems ?? [],
              effectiveBudgetCents: body.budgetCents,
              effectiveCurrency: body.currency as Currency,
              consumedTokenJtis: [],
            };
          }
        }
        throw new IllegalTransitionError("draft_already_converted", "Draft has already been converted to a purchase.");
      }
```

---

## 2. Dedicated Adversarial Test Suite Execution Evidence

We created [`tests/workflow/idempotency-concurrency-adversarial.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/idempotency-concurrency-adversarial.test.ts) to verify all five scenarios against live PostgreSQL.

### 2.1 Targeted Suite Output
```
$ npx vitest run tests/workflow/idempotency-concurrency-adversarial.test.ts

 RUN  v5.0.5 C:/Users/Tushar Kumar/Desktop/Plinthly
stdout | tests/workflow/idempotency-concurrency-adversarial.test.ts
◇ injected env (18) from .env.local

 ✓ tests/workflow/idempotency-concurrency-adversarial.test.ts (5 tests) 758ms
   ✓ Plinthly — Dedicated Adversarial Idempotency Concurrency Suite (PostgreSQL) (5)
     ✓ Scenario 1: Two identical concurrent draft conversions -> exactly 1 purchase, 1 idempotency record, identical responses, no P2002 error (515ms)
     ✓ Scenario 2: Two identical concurrent direct purchase creations -> exactly 1 purchase, 1 idempotency record, identical responses (42ms)
     ✓ Scenario 3: Two concurrent requests with different payloads but the same key -> exactly 1 succeeds, conflicting receives 409 (35ms)
     ✓ Scenario 4: Sequential retry with different payload on existing committed key -> rejects with HTTP 409 (28ms)
     ✓ Scenario 5: Failed transaction leaves neither a purchase nor an idempotency record (38ms)

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  1.81s
```

### 2.2 Detailed Verification Analysis per Requirement
1. **Identical Concurrent Requests (Scenario 1 & 2):**
   - In Scenario 1 (draft conversion), two promises called `service.createPurchase` concurrently with the same draft ID, confirmation tokens, and idempotency key.
   - In Scenario 2 (direct creation), two promises called `service.createPurchase` concurrently with identical specifications and idempotency key.
   - In both scenarios:
     - `expect(res1.id).toBe(res2.id)` -> TRUE
     - `expect(res1.createdAt).toBe(res2.createdAt)` -> TRUE
     - Database purchase count for the operation = **1**
     - Database idempotency record count = **1**
2. **No P2002 / HTTP 500 Errors:**
   - Both concurrent calls completed cleanly with HTTP 201 responses. Zero unhandled Prisma `P2002` exceptions escaped to the caller.
3. **Conflicting Payloads Received HTTP 409 (Scenario 3 & 4):**
   - Two concurrent requests were launched with identical keys but differing `budgetCents` ($200 vs $350).
   - One request succeeded (HTTP 201).
   - The competing request was rejected with `IdempotencyConflictError` having `statusCode: 409` and `code: "idempotency_conflict"`.
   - Sequential retry with modified budget on an existing key was likewise rejected with HTTP 409.
4. **Failed Transaction Atomicity (Scenario 5):**
   - A purchase request with a forged confirmation token was submitted with a new idempotency key.
   - The transaction failed during token verification inside PostgreSQL.
   - Invariant verified: Exactly 0 purchases created (`purchases.length === 0`).
   - Invariant verified: Exactly 0 idempotency records created (`idemRecords.length === 0`).
   - Invariant verified: Draft remained in `CONFIRMED` status, NOT `CONVERTED`.

---

## 3. Full Regression & Static Analysis Results

### 3.1 Targeted Concurrency & Token Suites
```
$ npx vitest run tests/workflow/draft-concurrency-adversarial.test.ts tests/workflow/idempotency.test.ts tests/workflow/quantity-confirmation-draft-adversarial.test.ts

 ✓ tests/workflow/idempotency.test.ts (15 tests) 276ms
 ✓ tests/workflow/quantity-confirmation-draft-adversarial.test.ts (15 tests) 822ms
 ✓ tests/workflow/draft-concurrency-adversarial.test.ts (7 tests) 2136ms

 Test Files  3 passed (3)
      Tests  37 passed (37)
```

### 3.2 TypeScript Type-Checking
```
$ npx tsc --noEmit
Exit Code: 0 (Zero errors)
```

### 3.3 ESLint Static Analysis
```
$ npm run lint
> purchase-assurance@0.1.0 lint
> eslint

Exit Code: 0 (Zero errors, zero warnings)
```

### 3.4 Full Vitest Regression Suite
```
$ npx vitest run

Test Files: 70 passed (70/70, 100%)
Tests:      1,109 passed (1,109/1,109, 100%)
Duration:   10.12s
```

---

## 4. Production Safety & Database Invariants

Direct PostgreSQL verification executed via `@prisma/client`:
```
=== DATABASE INVARIANT VERIFICATION ===
pur_1792633876502_s7jvwi22 version: 6 (expected: 6) -> VERIFIED
pur_1792654701712_f2iks5to version: 5 (expected: 5) -> VERIFIED
Total purchases in database: 40 -> VERIFIED
Payment capture audit events: 0 (expected: 0) -> VERIFIED
```
- **PayPal Configuration:** Untouched. Zero payment API calls made.
- **Fund Captures:** Exactly 0.
- **Gate 1 Baseline SHA-256 Seal:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` verified intact.
- **Action 3 Status:** **STRICTLY BLOCKED.**

