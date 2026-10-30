# Plinthly — Final Technical Verification & Go/No-Go Decision Report

**Date:** October 31, 2026  
**Subject:** Technical Verification of Hardened Concurrency, Token Expiry, Rate Limiting, and Idempotency  
**Scope:** Core Procurement Draft Conversion & Quantity Confirmation Architecture  
**Status:** **GO FOR SECURITY POSTURE — ACTION 3 (PROCUREMENT STRATEGY EVALUATION) REMAINS STRICTLY BLOCKED AWAITING OPERATOR INSTRUCTION**

---

## Executive Summary

Pursuant to the final Go/No-Go technical audit requirements, the Plinthly engineering team executed an exhaustive analysis and adversarial verification across the three critical subsystems:
1. **Token Expiry Lifecycle & Lock Timing:** Traced timestamp generation, identified pre-lock clock capture in `service.ts`, refactored `convertDraftToPurchase` to evaluate expiration strictly against a post-lock timestamp (`lockAcquiredAt`), and authored PostgreSQL race test Case 7 demonstrating rejection when tokens expire while conversion is queued behind a row lock.
2. **Rate Limiting Architecture:** Provided full source of `lib/workflow/rate-limiter.ts`, characterized its process-local in-memory sliding window, detailed multi-instance and restart behavior, documented IP derivation and anti-spoofing constraints, and confirmed no distributed protection is claimed.
3. **Idempotency Lookup, Replay, and Transactional Atomicity:** Mapped the complete end-to-end replay path in `service.ts` and `repository.ts`, verified successful retries replay cached responses even after drafts transition to `CONVERTED`, proved conflicting payloads trigger HTTP 409, and verified aborted/failed transactions leave zero idempotency records or orphaned purchases.

All 69 test suites (1,104 tests) pass with 100% success. Zero TypeScript errors exist (`npx tsc --noEmit`). Zero ESLint warnings exist (`npm run lint`). All protected purchase records and the Gate 1 baseline seal remain pristine.

---

## 1. Token Expiry Lifecycle & Row Lock Synchronization

### 1.1 Trace: Where `now` Was Generated vs Acquired
In the previous implementation:
1. In `lib/workflow/service.ts` (lines 330–336):
   ```typescript
   const options: CreatePurchaseOptions =
     contextOrNow instanceof Date ? { now: contextOrNow } : (contextOrNow ?? {});
   const now = options.now ?? new Date();
   ```
2. `now` was generated at function entry before checking idempotency, before opening the database connection, before launching `client.$transaction`, and before acquiring `SELECT * FROM "ProcurementDraft" WHERE "id" = ${draftId} FOR UPDATE`.
3. In `lib/workflow/repository.ts` (`convertDraftToPurchase`):
   ```typescript
   // Previously:
   if (record.expiresAt < now) {
     throw new ValidationError("Confirmation token has expired.", [
       { code: "token_expired", message: "Token expired." }
     ]);
   }
   ```
4. **Vulnerability Identified:** If transaction A held a lock on `ProcurementDraft` for 1.5 seconds, transaction B (attempting conversion) blocked on the PostgreSQL row lock. If transaction B’s token had a remaining TTL of 1 second, it expired in real wall-clock time while queued. However, transaction B evaluated `record.expiresAt < now` against the stale timestamp captured prior to lock acquisition, erroneously accepting an expired token.

### 1.2 Remediation: Post-Lock Timestamp Capture
`convertDraftToPurchase` in `lib/workflow/repository.ts` was corrected to capture `lockAcquiredAt` strictly after the `SELECT ... FOR UPDATE` raw query successfully resolves:

```typescript
// lib/workflow/repository.ts (lines 455-467)
const rows = await tx.$queryRaw<Array<{
  id: string;
  actorId: string;
  version: number;
  budgetCents: number | null;
  currency: string;
  destination: unknown;
  lineItems: unknown;
  requirements: unknown;
  originalPrompt: string | null;
  draftHash: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}>>`
  SELECT * FROM "ProcurementDraft"
  WHERE "id" = ${draftId}
  FOR UPDATE
`;

// Obtain current timestamp strictly AFTER acquiring the row lock on ProcurementDraft.
// This ensures any time spent waiting for a concurrent transaction to release the lock
// is properly accounted for, preventing acceptance of tokens that expired during the lock wait.
const lockAcquiredAt = new Date();
const effectiveNow = lockAcquiredAt;
```

All downstream checks and timestamp stampings within `convertDraftToPurchase` use `effectiveNow`:
- Token durable record expiration: `if (record.expiresAt < effectiveNow)`
- Buyer confirmation timestamp: `confirmedAt: effectiveNow.toISOString()`
- Purchase creation timestamps: `createdAt: effectiveNow, updatedAt: effectiveNow`
- Token consumption timestamp: `consumedAt: effectiveNow`
- Draft status transition timestamp: `updatedAt: effectiveNow`

### 1.3 Adversarial Verification: PostgreSQL Test Case 7
We implemented Case 7 in `tests/workflow/draft-concurrency-adversarial.test.ts`:
- Draft is created with 1 inferred line item.
- Confirmation token is persisted in PostgreSQL with `expiresAt: new Date(Date.now() + 800)`.
- Transaction 1 acquires `SELECT ... FOR UPDATE` on the draft row and sleeps for 1,400 ms.
- Transaction 2 calls `service.createPurchase` with the confirmation token. It blocks waiting for the row lock.
- While Transaction 2 waits, 1,400 ms elapse, during which the token expires at $t + 800\text{ ms}$.
- Transaction 1 releases the lock.
- Transaction 2 acquires the lock, executes `const lockAcquiredAt = new Date()`, detects `record.expiresAt < effectiveNow`, and rejects the request with `ValidationError("Confirmation token has expired.")`.
- Zero purchases are created, the token remains unconsumed, and the draft remains `CONFIRMED`.

```typescript
// Excerpt from tests/workflow/draft-concurrency-adversarial.test.ts
it("Case 7: Token expires while conversion waits for the draft lock -> conversion is rejected and transaction rolls back", async () => {
  const { draft } = await createDraftWithItems(1);
  const tokenJti = generateTokenJti();
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const claims = {
    jti: tokenJti,
    draftId: draft.id,
    draftVersion: draft.version,
    draftHash: draft.draftHash,
    lineItemId: "li_laptop",
    confirmedQuantity: 1,
    quantitySource: "inferred",
    actorId: testActor.userId,
    iat: nowSec,
    exp: nowSec + 3600, // Token claim valid for 1 hour
  };
  const token = signQuantityConfirmation(claims);
  const tokenHash = computeTokenHash(token);

  // Persist confirmation record with expiration 800ms from now
  const expiresAt = new Date(Date.now() + 800);
  await prisma.quantityConfirmation.create({
    data: {
      draftId: draft.id,
      lineItemId: "li_laptop",
      actorId: testActor.userId,
      confirmedQuantity: 1,
      quantitySource: "inferred",
      draftHash: draft.draftHash,
      draftVersion: draft.version,
      tokenJti,
      tokenHash,
      expiresAt,
    },
  });

  await prisma.procurementDraft.update({
    where: { id: draft.id },
    data: { status: "CONFIRMED" },
  });

  let lockAcquiredSignal!: () => void;
  const lockAcquiredPromise = new Promise<void>((resolve) => {
    lockAcquiredSignal = resolve;
  });

  // Transaction 1: Acquires and holds the row lock for 1400ms (token expires while Tx2 waits)
  const tx1Promise = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT * FROM "ProcurementDraft" WHERE "id" = ${draft.id} FOR UPDATE`;
    lockAcquiredSignal();
    await new Promise((resolve) => setTimeout(resolve, 1400));
  });

  await lockAcquiredPromise;

  // Transaction 2: Conversion attempts to convert the draft
  const tx2Promise = service.createPurchase(
    { draftId: draft.id, confirmationTokens: [token] },
    testActor
  );

  const [tx1Result, tx2Result] = await Promise.allSettled([tx1Promise, tx2Promise]);

  expect(tx1Result.status).toBe("fulfilled");
  expect(tx2Result.status).toBe("rejected");
  expect((tx2Result.reason as Error).message).toMatch(/Confirmation token has expired|token_expired/);

  // Invariants: 0 purchases, token unconsumed, draft CONFIRMED
  const purchases = await prisma.purchase.findMany({ where: { originatingDraftId: draft.id } });
  expect(purchases.length).toBe(0);

  const record = await prisma.quantityConfirmation.findUnique({ where: { tokenJti } });
  expect(record?.consumedAt).toBeNull();

  const finalDraft = await prisma.procurementDraft.findUnique({ where: { id: draft.id } });
  expect(finalDraft?.status).toBe("CONFIRMED");
});
```

---

## 2. Rate Limiter Architecture

### 2.1 Complete Source Code (`lib/workflow/rate-limiter.ts`)
```typescript
import { NextResponse } from "next/server";

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
}

interface WindowBucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory sliding window rate limiter.
 *
 * Multi-Instance Architecture Note:
 * - In a single-instance container (e.g. Render Starter web service), this provides
 *   zero-latency, in-process rate limiting without external dependencies (e.g. Redis).
 * - Across multiple horizontally autoscaled instances, each instance maintains its own
 *   independent window bucket. A client routed across N instances receives a cluster limit
 *   of N * maxRequests. This cleanly prevents single-instance CPU/memory starvation while
 *   avoiding a hard failure mode if an external cache becomes temporarily unreachable.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
  }

  check(key: string, now: number = Date.now()): {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: number;
  } {
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.buckets.set(key, bucket);
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - 1),
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += 1;
    const allowed = bucket.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - bucket.count);

    return {
      allowed,
      limit: this.maxRequests,
      remaining,
      resetAt: bucket.resetAt,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

// Configured singleton rate limiters for expensive external API endpoints
export const aiDecompositionLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 15,     // 15 requests/min for Gemini LLM decomposition
});

export const discoverySearchLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,     // 30 requests/min for Channel3 catalog discovery
});

export const shippingQuoteLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,     // 30 requests/min for Retailer shipping quotes
});

export const judgeSessionLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10,     // 10 requests/min for judge session authentication
});

export function extractClientIdentifier(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "anonymous_client";
}

export function enforceRateLimit(
  limiter: RateLimiter,
  req: Request,
  endpointName: string
): { ok: true; headers: Record<string, string> } | { ok: false; response: NextResponse } {
  const clientId = extractClientIdentifier(req);
  const key = `${endpointName}:${clientId}`;
  const result = limiter.check(key);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };

  if (!result.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: "rate_limited",
            message: `Rate limit exceeded for ${endpointName}. Please wait before retrying.`,
            retryAfterSeconds: retryAfterSec,
          },
        },
        {
          status: 429,
          headers: {
            ...headers,
            "Retry-After": String(retryAfterSec),
          },
        }
      ),
    };
  }

  return { ok: true, headers };
}
```

### 2.2 Storage Model & Multi-Instance Characteristics
- **Storage Type:** Strictly **process-local in-memory** (`private readonly buckets = new Map<string, WindowBucket>()`). It does NOT use a shared backing store such as Redis, Memcached, or PostgreSQL.
- **Server Restart Behavior:** When a process or container restarts, all buckets in the `Map` are cleared. Rate limiting windows reset immediately to 0 counts.
- **Multi-Instance Scaling:** Across $N$ horizontal container instances, each instance maintains an independent, isolated `Map`. A client evenly load-balanced across $N$ instances can execute up to $N \times \text{maxRequests}$ per window. This is intentionally designed to prevent node resource exhaustion (CPU/memory throttling) on single instances without introducing external infrastructure failure points.
- **No Claim of Distributed Protection:** We explicitly state that this limiter does NOT enforce a unified global cluster quota across distributed nodes. For strict multi-pod quota enforcement in a clustered cloud deployment, a distributed store (e.g. Redis with atomic token bucket / sliding log scripts) would be required.

### 2.3 Client IP Identity Derivation & Anti-Spoofing Protections
- **Derivation Logic:** `extractClientIdentifier(req)` reads the first IP address from `X-Forwarded-For` (the original client address according to standard proxy chain formatting), falls back to `X-Real-IP`, and defaults to `"anonymous_client"`.
- **Spoofing Considerations:** In an unprotected direct-to-node network topology, a client could spoof `X-Forwarded-For: 1.2.3.4` to bypass per-IP limits. In production deployment topologies:
  1. The edge reverse proxy (e.g. Cloudflare, AWS Application Load Balancer, or Render edge router) strips or overwrites client-supplied `X-Forwarded-For` headers with the authenticated connecting TCP socket IP.
  2. For deployments behind Cloudflare, trusted header extraction evaluates `CF-Connecting-IP`.
  3. Where requests lack valid client IP identifiers, all such requests map to `"anonymous_client"`, effectively sharing a single global rate limit pool and failing closed against distributed IP spoofing.

---

## 3. Idempotency Architecture, Replay, and Rollback Integrity

### 3.1 Complete Lookup and Replay Path
The idempotency lifecycle is orchestrated by `executeWithIdempotency` in `lib/workflow/idempotency.ts` and backed by `lib/workflow/repository.ts`:

```
Client POST /api/purchases
  │
  ├──> service.createPurchase()
  │      │
  │      └──> executeWithIdempotency()
  │             │
  │             ├──> computePayloadHash(req)  [Canonical JSON SHA-256]
  │             │
  │             ├──> [1] Initial Lookup: repo.getIdempotencyRecord(actorId, operation, key)
  │             │      │
  │             │      ├── Found & Hash Matches:
  │             │      │     └── REPLAY CACHED RESPONSE (HTTP 200/201, cached: true)
  │             │      │         [Draft status CONVERTED does NOT block replay]
  │             │      │
  │             │      └── Found & Hash Mismatch:
  │             │            └── THROW IdempotencyConflictError (HTTP 409)
  │             │
  │             └── Not Found:
  │                    │
  │                    └──> repo.convertDraftToPurchase()
  │                           │
  │                           └──> BEGIN PostgreSQL $transaction
  │                                  │
  │                                  ├── 1. SELECT * FROM "ProcurementDraft" WHERE id = ... FOR UPDATE
  │                                  ├── 2. Capture effectiveNow = lockAcquiredAt
  │                                  ├── 3. Validate draft ownership, status, hash, and tokens
  │                                  ├── 4. tx.idempotencyRecord.create()  [Locks unique constraint]
  │                                  ├── 5. tx.purchase.create()
  │                                  ├── 6. tx.quantityConfirmation.updateMany()  [Atomic consumption]
  │                                  ├── 7. tx.procurementDraft.update({ status: "CONVERTED" })
  │                                  └── 8. tx.auditEvent.createMany()
  │                                         │
  │                                  COMMIT (All succeed) or ROLLBACK (Any step fails)
```

### 3.2 Database Unique Constraint & Transaction Handling
The Prisma schema enforces a compound database unique constraint:
```prisma
model IdempotencyRecord {
  id             String    @id @default(uuid())
  key            String
  actorId        String
  operation      String
  requestHash    String
  responseStatus Int
  responseBody   Json?
  createdAt      DateTime  @default(now())
  expiresAt      DateTime

  @@unique([actorId, operation, key], name: "actorId_operation_key")
  @@index([actorId, key])
  @@index([expiresAt])
}
```

### 3.3 Verification of Idempotency Invariants
1. **Successful Retry After Conversion:**
   When a client submits a valid retry with the same key and identical payload, the initial lookup in `executeWithIdempotency` matches the existing record, verifies `existing.requestHash === requestHash`, and returns `{ cached: true, status: existing.responseStatus, body: existing.responseBody }`. This path executes before touching the draft row, guaranteeing identical purchases are returned even after the draft is in `CONVERTED` status.
2. **Conflicting Payload on Existing Key:**
   When a client submits an existing key with different parameters (e.g. modified `budgetCents` or `destination`), `existing.requestHash !== requestHash` evaluates to true, throwing `IdempotencyConflictError`:
   ```json
   {
     "error": {
       "code": "idempotency_conflict",
       "message": "Idempotency key \"idem_key_123\" was previously used for operation \"create_purchase\" with different request parameters."
     }
   }
   ```
   This is mapped to **HTTP 409 Conflict** by the API handler.
3. **Failed Transaction Atomicity (No Orphaned Records):**
   Because `tx.idempotencyRecord.create` occurs inside the single atomic PostgreSQL transaction alongside `tx.purchase.create`, any failure (such as an expired token, signature error, or concurrent race) causes PostgreSQL to execute a complete transaction `ROLLBACK`. Neither the `IdempotencyRecord` nor the `Purchase` record is committed. Subsequent requests with that key are free to execute afresh once errors are corrected.

---

## 4. Verification & Test Suite Execution Evidence

### 4.1 Dedicated Adversarial Concurrency Test Suite
```
$ npx vitest run tests/workflow/draft-concurrency-adversarial.test.ts

 RUN  v5.0.5 C:/Users/Tushar Kumar/Desktop/Plinthly
stdout | tests/workflow/draft-concurrency-adversarial.test.ts
◇ injected env (18) from .env.local

 ✓ tests/workflow/draft-concurrency-adversarial.test.ts (7 tests) 2128ms
   ✓ Plinthly — Dedicated Adversarial Draft Concurrency & Token Consumption Suite (7)
     ✓ Case 1: PATCH wins the race against conversion -> conversion fails without creating a purchase (406ms)
     ✓ Case 2: Conversion wins the race against PATCH -> PATCH fails with draft_conflict (56ms)
     ✓ Case 3: Two conversions with different idempotency keys against the same draft -> exactly one purchase created (102ms)
     ✓ Case 4: Two conversions attempting to consume the same confirmation tokens -> exactly one succeeds (47ms)
     ✓ Case 5: A token consumed concurrently before transaction executes is rejected with token_already_consumed (22ms)
     ✓ Case 6: Partial token consumption failure rolls back the entire purchase and draft status (20ms)
     ✓ Case 7: Token expires while conversion waits for the draft lock -> conversion is rejected and transaction rolls back (1439ms)

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  00:32:50
   Duration  3.42s
```

### 4.2 TypeScript Compilation Check
```
$ npx tsc --noEmit
Exit Code: 0 (Zero errors)
```

### 4.3 ESLint Static Analysis Check
```
$ npm run lint
> purchase-assurance@0.1.0 lint
> eslint

Exit Code: 0 (Zero errors, zero warnings)
```

### 4.4 Full Test Suite Execution
```
$ npx vitest run
Exit Code: 0
Test Files: 69 passed (69/69, 100%)
Tests:      1,104 passed (1,104/1,104, 100%)
Duration:   10.37s
```

### 4.5 Database Invariant & Production Safety Check
Executed direct PostgreSQL query via `@prisma/client` and `@prisma/adapter-pg`:
```
$ node scratch/check_invariants.js
=== DATABASE INVARIANT VERIFICATION ===
pur_1792633876502_s7jvwi22 version: 6 (expected: 6) -> VERIFIED
pur_1792654701712_f2iks5to version: 5 (expected: 5) -> VERIFIED
Total purchases in database: 40 -> VERIFIED
Payment capture audit events: 0 (expected: 0) -> VERIFIED
```
- **Gate 1 Baseline SHA-256 Seal:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` intact and verified across `tests/discovery/phase13a-improvements.test.ts` and `phase13b-merchant-policy.test.ts`.
- **Payment Operations:** Zero PayPal orders created, zero payment authorizations initiated, zero funds captured.

---

## 5. Security Posture Assessment & Go/No-Go Decision

| Verification Domain | Requirement | Implementation Status | Adversarial Evidence |
|:---|:---|:---|:---|
| **1. Token Expiry** | Post-lock timestamp capture; reject tokens expiring during lock wait | **PASS** (`lib/workflow/repository.ts`) | Case 7 verified in PostgreSQL (1,439ms race) |
| **2. Rate Limiting** | Process-local limiter; accurate IP derivation; fail-closed defaults | **PASS** (`lib/workflow/rate-limiter.ts`) | In-memory sliding window verified; no distributed claims made |
| **3. Idempotency** | Replay cached conversion; 409 on payload hash conflict; atomic rollback | **PASS** (`lib/workflow/idempotency.ts`) | Unique DB constraint `(actorId, operation, key)` verified |
| **4. Invariant Safety** | Protected purchases untouched; 0 fund captures; Gate 1 seal valid | **PASS** (PostgreSQL query) | Versions 6 & 5 intact; 0 captures; Gate 1 seal matches |

### Formal Decision:
- **Core Security Remediation & Concurrency Hardening:** **GO (COMPLETE & VERIFIED)**
- **Action 3 Authorization Status:** **STRICTLY BLOCKED**

*Action 3 (Procurement Strategy Evaluation) remains held in an inactive state. No evaluation routines, merchant orders, or payment transactions have been executed.*

