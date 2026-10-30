# Plinthly — Concurrency Hardening & In-Transaction Validation Report

**Date:** 2026-10-31 00:23:00 UTC+05:30  
**Scope:** Remediation of Time-of-Check to Time-of-Use (TOCTOU) draft validation, conditional token consumption, judge-session token exposure, and rate limiting  
**Action 3 Status:** STRICTLY BLOCKED — Zero payment workflows, orders, or captures executed  

---

## 1. Executive Summary

All four security and concurrency remediation directives have been implemented and verified:

1. **In-Transaction Validation:** All draft reads, actor ownership checks, version/hash validation, line item verification, and token matching have been moved entirely inside a single PostgreSQL interactive transaction (`convertDraftToPurchase`). The transaction begins by acquiring a row-level lock (`SELECT * FROM "ProcurementDraft" WHERE "id" = $draftId FOR UPDATE`). No pre-transaction read is trusted.
2. **Conditional & Atomic Token Consumption:** Token consumption updates `QuantityConfirmation` using strict conditions: `tokenJti IN (...) AND consumedAt IS NULL AND draftId = $draftId AND actorId = $actorId`. If `updateResult.count !== tokenJtis.length`, the transaction throws a `ValidationError` and rolls back all database modifications, including purchase creation.
3. **Judge Session Credential Inaccessibility & Rate Limiting:** The `judgeSessionToken` has been removed from the JSON response body of `POST /api/auth/judge-session`. Credentials are set exclusively via an HTTP-only secure cookie (`plinthly_judge_session`). Sliding-window rate limiting (10 requests/min) was added to the endpoint using `enforceRateLimit`.
4. **Adversarial Concurrency Verification:** Created a dedicated 6-scenario PostgreSQL concurrency suite ([`tests/workflow/draft-concurrency-adversarial.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/draft-concurrency-adversarial.test.ts)). All 6 test cases passed.
5. **Project-Wide Quality Gates:**
   - `npm run lint`: 0 errors, 0 warnings
   - `npx tsc --noEmit`: 0 errors
   - `npx vitest run`: 69/69 test files passed (1,103/1,103 tests, 100%)
   - Completed fund captures: 0
   - Protected sample purchases: intact (`pur_1792633876502_s7jvwi22` v6, `pur_1792654701712_f2iks5to` v5)
   - Gate 1 SHA-256 seal: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`

---

## 2. In-Transaction Draft Locking & Validation

### 2.1 Complete Conversion Transaction (`convertDraftToPurchase`)
File: [`lib/workflow/repository.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/repository.ts) (Lines 420–675)

```typescript
  async convertDraftToPurchase(params: ConvertDraftParams): Promise<ConvertDraftResult> {
    const {
      draftId,
      actor,
      actorId,
      now,
      candidateTokens,
      purchaseId,
      purchaseStatus,
      ownerUserId,
      auditEvents,
      idempotencyRecord,
    } = params;

    void actor;
    const client = this.getClient();

    // Pre-validate all audit records before touching the database
    for (const draft of auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      // 1. Acquire row lock on ProcurementDraft as first draft operation
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

      const draft = rows[0];
      if (!draft) {
        throw new NotFoundError(`Procurement draft "${draftId}" not found.`);
      }

      // 2. Validate actor ownership
      if (draft.actorId !== actorId) {
        throw new ForbiddenError(`Actor "${actorId}" is not authorized to convert draft owned by "${draft.actorId}".`);
      }

      // 3. Validate status
      if (draft.status === "CONVERTED") {
        throw new IllegalTransitionError("draft_already_converted", "Draft has already been converted to a purchase.");
      }
      if (draft.status !== "ACTIVE" && draft.status !== "CONFIRMED") {
        throw new IllegalTransitionError("draft_not_active", `Draft cannot be converted in status "${draft.status}".`);
      }

      // 4. Validate canonical hash and version against locked draft
      const canonicalHash = computeCanonicalDraftHash({
        draftId: draft.id,
        version: draft.version,
        budgetCents: draft.budgetCents,
        currency: draft.currency,
        destination: draft.destination,
        lineItems: (draft.lineItems as unknown as readonly { id: string; title: string; quantity?: number; budgetCents?: number | null; requirements?: unknown }[]) || [],
        requirements: draft.requirements,
      });
      if (draft.draftHash !== canonicalHash) {
        throw new ApprovalIntegrityError("draft_integrity_mismatch", "Draft content integrity check failed. Hash mismatch.");
      }

      const draftLineItems = (draft.lineItems as unknown as ProcurementLineItem[]) || [];

      // 5. Decode and verify all candidate confirmation tokens
      const seenTokens = new Set<string>();
      for (const t of candidateTokens) {
        if (seenTokens.has(t)) {
          throw new ValidationError("Duplicate confirmation tokens detected in request.", [
            { code: "duplicate_confirmation_tokens", message: "Duplicate confirmation token provided." }
          ]);
        }
        seenTokens.add(t);
      }

      const unconfirmedItems = draftLineItems.filter(
        (li) =>
          li.quantityConfirmed === false ||
          li.quantitySource === "inferred" ||
          li.quantitySource === "unresolved" ||
          li.quantitySource === "manual_override"
      );

      if (unconfirmedItems.length > 0 && candidateTokens.length === 0) {
        throw new ValidationError("Missing required quantity confirmation tokens.", [
          { code: "unconfirmed_inferred_quantity", message: "Inferred or unverified quantity requires explicit buyer confirmation token." }
        ]);
      }

      const decodedTokens = candidateTokens.map((t) => {
        const claims = verifyQuantityConfirmation(t);
        if (!claims) {
          throw new ValidationError("Invalid or forged confirmation token.", [
            { code: "invalid_confirmation_token", message: "Token signature verification failed." }
          ]);
        }
        return { token: t, claims };
      });

      // Check for duplicate line item confirmations
      const confirmedLineItemIds = new Set<string>();
      for (const { claims } of decodedTokens) {
        if (confirmedLineItemIds.has(claims.lineItemId)) {
          throw new ValidationError(`Duplicate confirmation token for line item "${claims.lineItemId}".`, [
            { code: "duplicate_line_item_confirmation", message: `Line item "${claims.lineItemId}" confirmed multiple times.` }
          ]);
        }
        confirmedLineItemIds.add(claims.lineItemId);
      }

      // Check for unexpected extra tokens
      for (const { claims } of decodedTokens) {
        const matching = draftLineItems.find((li) => li.id === claims.lineItemId);
        if (!matching) {
          throw new ValidationError(`Unexpected extra confirmation token for line item "${claims.lineItemId}".`, [
            { code: "unexpected_confirmation_token", message: `Line item "${claims.lineItemId}" does not exist in draft.` }
          ]);
        }
      }

      // Check all unconfirmed items are covered
      for (const u of unconfirmedItems) {
        if (!confirmedLineItemIds.has(u.id)) {
          throw new ValidationError(`Line item "${u.id}" (${u.title}) requires buyer confirmation token.`, [
            { code: "unconfirmed_inferred_quantity", message: `Line item "${u.id}" has an unconfirmed quantity.` }
          ]);
        }
      }

      // Sort tokens deterministically by JTI
      decodedTokens.sort((a, b) => a.claims.jti.localeCompare(b.claims.jti));
      const tokenJtis = decodedTokens.map((t) => t.claims.jti);

      if (tokenJtis.length > 0) {
        const dbRecords = await tx.quantityConfirmation.findMany({
          where: { tokenJti: { in: tokenJtis } },
          orderBy: { tokenJti: "asc" },
        });

        if (dbRecords.length !== decodedTokens.length) {
          throw new ValidationError("One or more confirmation records not found in database.", [
            { code: "invalid_confirmation_token", message: "Durable confirmation record missing." }
          ]);
        }

        const dbMap = new Map(dbRecords.map((r) => [r.tokenJti, r]));

        for (const { token, claims } of decodedTokens) {
          const record = dbMap.get(claims.jti)!;

          if (computeTokenHash(token) !== record.tokenHash) {
            throw new ValidationError("Token hash does not match stored record hash.", [
              { code: "invalid_confirmation_token", message: "Token tampering detected." }
            ]);
          }
          if (claims.lineItemId !== record.lineItemId) {
            throw new ValidationError("Token line item does not match record.", [
              { code: "invalid_confirmation_token", message: "Line item mismatch." }
            ]);
          }
          if (claims.confirmedQuantity !== record.confirmedQuantity) {
            throw new ValidationError("Token confirmed quantity does not match record.", [
              { code: "confirmation_quantity_mismatch", message: "Quantity mismatch." }
            ]);
          }
          if (claims.draftId !== record.draftId || claims.draftVersion !== record.draftVersion || claims.draftHash !== record.draftHash) {
            throw new ValidationError("Token draft binding does not match record.", [
              { code: "confirmation_draft_mismatch", message: "Draft version/hash mismatch." }
            ]);
          }
          if (claims.draftHash !== draft.draftHash) {
            throw new ValidationError("Confirmation draft mismatch: Draft content has changed since confirmation.", [
              { code: "confirmation_draft_mismatch", message: "Draft content has changed since confirmation." }
            ]);
          }
          if (claims.actorId !== record.actorId || claims.actorId !== actorId) {
            throw new ValidationError("Confirmation actor mismatch.", [
              { code: "confirmation_actor_mismatch", message: "Actor mismatch." }
            ]);
          }
          if (record.consumedAt !== null) {
            throw new ValidationError("Confirmation token has already been consumed.", [
              { code: "token_already_consumed", message: "Token already consumed." }
            ]);
          }
          if (record.expiresAt < now) {
            throw new ValidationError("Confirmation token has expired.", [
              { code: "token_expired", message: "Token expired." }
            ]);
          }
          const item = draftLineItems.find((li) => li.id === record.lineItemId);
          if (!item || item.quantity !== record.confirmedQuantity) {
            throw new ValidationError("Confirmed quantity does not match line item quantity.", [
              { code: "confirmation_quantity_mismatch", message: "Quantity mismatch with draft line item." }
            ]);
          }
        }
      }

      const finalLineItems = draftLineItems.map((li) => ({
        ...li,
        quantityConfirmed: true,
        confirmedAt: now.toISOString(),
        confirmedBy: actorId,
      }));

      const finalRequirements = {
        lineItems: finalLineItems,
        ...(draft.destination ? { destination: draft.destination } : {}),
      };

      const effectiveBudgetCents = draft.budgetCents ?? 0;
      const effectiveCurrency = (draft.currency ?? "USD") as Currency;

      // 6. Write idempotency record if present (locking on unique constraint)
      const responseBody = {
        id: purchaseId,
        status: purchaseStatus,
        budgetCents: effectiveBudgetCents,
        currency: effectiveCurrency,
        requirements: finalLineItems,
        lineItems: finalLineItems,
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId,
        version: 1,
        originatingDraftId: draft.id,
        selectedCandidate: null,
        activeApproval: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      if (idempotencyRecord) {
        await tx.idempotencyRecord.create({
          data: {
            id: idempotencyRecord.id,
            key: idempotencyRecord.key,
            actorId: idempotencyRecord.actorId,
            operation: idempotencyRecord.operation,
            requestHash: idempotencyRecord.requestHash,
            responseStatus: 201,
            responseBody: responseBody as Prisma.InputJsonValue,
            createdAt: idempotencyRecord.createdAt,
            expiresAt: idempotencyRecord.expiresAt,
          },
        });
      }

      // 7. Create Purchase record
      const created = await tx.purchase.create({
        data: {
          id: purchaseId,
          status: purchaseStatus,
          requirements: finalRequirements as Prisma.InputJsonValue,
          budgetCents: effectiveBudgetCents,
          currency: effectiveCurrency,
          policyVersion: null,
          policyEvidenceFingerprint: null,
          selectedCandidateId: null,
          ownerUserId,
          version: 1,
          originatingDraftId: draft.id,
          createdAt: now,
          updatedAt: now,
        },
      });

      // 8. Atomically and conditionally consume confirmation records (Requirement 2)
      if (tokenJtis.length > 0) {
        const updateResult = await tx.quantityConfirmation.updateMany({
          where: {
            tokenJti: { in: tokenJtis },
            consumedAt: null,
            draftId: draft.id,
            actorId: actorId,
          },
          data: {
            consumedAt: now,
            consumedPurchaseId: created.id,
          },
        });

        if (updateResult.count !== tokenJtis.length) {
          throw new ValidationError("Token consumption failed: One or more tokens were already consumed or invalid.", [
            { code: "token_already_consumed", message: "Concurrent token consumption detected. Rolling back." }
          ]);
        }
      }

      // 9. Change draft status to CONVERTED
      await tx.procurementDraft.update({
        where: { id: draft.id },
        data: {
          status: "CONVERTED",
          updatedAt: now,
        },
      });

      // 10. Write audit events
      const updatedAuditEvents = auditEvents.map((ae) => {
        if (ae.type === "proposed") {
          return {
            ...ae,
            payload: {
              budgetCents: effectiveBudgetCents,
              currency: effectiveCurrency,
              ...(draft.destination ? { destination: draft.destination } : {}),
              lineItems: finalLineItems,
            },
          };
        }
        return ae;
      });

      if (updatedAuditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: updatedAuditEvents.map((draftEvent) => ({
            purchaseId: draftEvent.purchaseId,
            type: draftEvent.type,
            actor: draftEvent.actor as unknown as Prisma.InputJsonValue,
            payload: draftEvent.payload as Prisma.InputJsonValue,
            createdAt: draftEvent.occurredAt,
          })),
        });
      }

      const purchaseRecord: PurchaseRecord = {
        id: created.id,
        status: created.status as PurchaseStatus,
        requirements: created.requirements,
        budgetCents: created.budgetCents,
        currency: created.currency as Currency,
        policyVersion: created.policyVersion,
        policyEvidenceFingerprint: normalizePolicyEvidenceFingerprint(created.policyEvidenceFingerprint),
        selectedCandidateId: created.selectedCandidateId,
        ownerUserId: created.ownerUserId,
        version: created.version,
        originatingDraftId: created.originatingDraftId,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };

      return {
        purchase: purchaseRecord,
        lineItems: finalLineItems,
        effectiveBudgetCents,
        effectiveCurrency,
        consumedTokenJtis: tokenJtis,
      };
    });
  }
```

### 2.2 Calling Site in `service.ts`
File: [`lib/workflow/service.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts) (Lines 404–465)

```typescript
        if (req.draftId) {
          // Collect candidate confirmation tokens from request
          const rawTokens: string[] = [];
          if (Array.isArray(req.confirmationTokens)) {
            rawTokens.push(...req.confirmationTokens);
          }
          if (Array.isArray(req.lineItems)) {
            for (const li of req.lineItems) {
              if (li.confirmationToken) rawTokens.push(li.confirmationToken);
            }
          }
          if (req.confirmationToken) {
            rawTokens.push(req.confirmationToken);
          }

          let idempotencyToPass = undefined;
          if (idempotencyDraft) {
            idempotencyToPass = {
              ...idempotencyDraft,
              responseStatus: 201,
              responseBody: null,
            };
          }

          const convertResult = await this.repo.convertDraftToPurchase({
            draftId: req.draftId,
            actor,
            actorId,
            now,
            candidateTokens: rawTokens,
            purchaseId,
            purchaseStatus: finalStatus,
            ownerUserId,
            auditEvents,
            idempotencyRecord: idempotencyToPass,
          });

          const plannedResponse: PurchaseResponse = {
            id: convertResult.purchase.id,
            status: convertResult.purchase.status,
            budgetCents: convertResult.effectiveBudgetCents,
            currency: convertResult.effectiveCurrency,
            requirements: Array.isArray(req.requirements)
              ? req.requirements
              : ((convertResult.lineItems as unknown as readonly unknown[]) ?? []),
            lineItems: convertResult.lineItems,
            policyVersion: convertResult.purchase.policyVersion,
            policyEvidenceFingerprint: convertResult.purchase.policyEvidenceFingerprint,
            selectedCandidateId: convertResult.purchase.selectedCandidateId,
            ownerUserId: convertResult.purchase.ownerUserId,
            version: convertResult.purchase.version,
            originatingDraftId: convertResult.purchase.originatingDraftId ?? null,
            selectedCandidate: null,
            activeApproval: null,
            createdAt: convertResult.purchase.createdAt.toISOString(),
            updatedAt: convertResult.purchase.updatedAt.toISOString(),
          };

          return {
            status: 201,
            body: plannedResponse,
            persistedAtomically: !!idempotencyToPass,
          };
        }
```

---

## 3. Judge Session Token Removal & Rate Limiting

### 3.1 Hardened Endpoint Implementation
File: [`app/api/auth/judge-session/route.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/app/api/auth/judge-session/route.ts)

```typescript
import { NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createJudgeSessionToken } from "../../../../lib/workflow/auth";
import {
  enforceRateLimit,
  judgeSessionLimiter,
} from "../../../../lib/workflow/rate-limiter";

function verifySecretTimingSafe(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

export async function POST(request: Request) {
  try {
    const rateCheck = enforceRateLimit(judgeSessionLimiter, request, "judge_session");
    if (!rateCheck.ok) {
      return rateCheck.response;
    }

    const configuredSecret = process.env.JUDGE_ACCESS_SECRET?.trim();
    if (!configuredSecret) {
      return NextResponse.json(
        { ok: false, error: { code: "not_configured", message: "JUDGE_ACCESS_SECRET is not configured on the server." } },
        { status: 500 }
      );
    }

    const authHeader = request.headers.get("authorization")?.trim();
    let suppliedSecret: string | undefined;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      suppliedSecret = authHeader.slice(7).trim();
    } else {
      suppliedSecret = request.headers.get("x-judge-access-token")?.trim();
    }

    if (!suppliedSecret || !verifySecretTimingSafe(suppliedSecret, configuredSecret)) {
      return NextResponse.json(
        { ok: false, error: { code: "unauthorized", message: "Invalid judge access credentials." } },
        { status: 401 }
      );
    }

    // Generate random server-controlled session ID
    const sessionId = "sess_" + randomBytes(16).toString("hex");
    const sessionToken = createJudgeSessionToken(sessionId);
    const actorId = `judge_${sessionId}`;

    // Return session metadata only; keep the raw cryptographic token inside the HTTP-only cookie
    const response = NextResponse.json(
      {
        ok: true,
        data: {
          sessionId,
          actorId,
        },
      },
      { status: 200 }
    );

    // Set HTTP-only secure session cookie inaccessible to browser JavaScript
    response.cookies.set("plinthly_judge_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 86400, // 24 hours
    });

    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal authentication error";
    return NextResponse.json({ ok: false, error: { code: "internal_error", message } }, { status: 500 });
  }
}
```

---

## 4. Adversarial Concurrency Test Results

All 6 test cases in [`tests/workflow/draft-concurrency-adversarial.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/draft-concurrency-adversarial.test.ts) executed against real PostgreSQL and passed:

```
 RUN  v5.0.5 C:/Users/Tushar Kumar/Desktop/Plinthly

stdout | tests/workflow/draft-concurrency-adversarial.test.ts
◇ injected env (18) from .env.local

 ✓ tests/workflow/draft-concurrency-adversarial.test.ts (6 tests) 712ms
   ✓ Plinthly — Dedicated Adversarial Draft Concurrency & Token Consumption Suite (6)
     ✓ Case 1: PATCH wins the race against conversion -> conversion fails without creating a purchase 413ms
     ✓ Case 2: Conversion wins the race against PATCH -> PATCH fails with draft_conflict 53ms
     ✓ Case 3: Two conversions with different idempotency keys against the same draft -> exactly one purchase created 105ms
     ✓ Case 4: Two conversions attempting to consume the same confirmation tokens -> exactly one succeeds 48ms
     ✓ Case 5: A token consumed concurrently before transaction executes is rejected with token_already_consumed 23ms
     ✓ Case 6: Partial token consumption failure rolls back the entire purchase and draft status 20ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  2.01s
```

---

## 5. Raw Command Outputs

### 5.1 `npm run lint`
```
> purchase-assurance@0.1.0 lint
> eslint
```
*(Process exited with code 0; 0 errors, 0 warnings)*

### 5.2 `npx tsc --noEmit`
```
(No output — process exited with code 0)
```

### 5.3 `npx vitest run` (Full Test Suite)
```
 Test Files  69 passed (69)
      Tests  1103 passed (1103)
   Start at  00:22:27
   Duration  12.68s (import 51%, tests 43%, transform 4%, worker 2%)
```

### 5.4 Safety Invariant Output (`verify_safety_evidence.js`)
```
PROTECTED_PURCHASES: [
  {
    "id": "pur_1792633876502_s7jvwi22",
    "status": "BUYER_APPROVED",
    "version": 6,
    "updatedAt": "2026-10-22T06:29:54.105Z"
  },
  {
    "id": "pur_1792654701712_f2iks5to",
    "status": "BUYER_APPROVED",
    "version": 5,
    "updatedAt": "2026-10-22T07:47:23.421Z"
  }
]
PAYMENT_ATTEMPTS: total = 6 , completed = 0
GATE_1_SHA256: F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451
```

---

## 6. Safety Certification

1. **Zero Fund Captures:** `completed = 0` across all payment attempts.
2. **Zero Order Operations:** No PayPal orders, authorizations, or captures created.
3. **Protected Baseline Intact:** `pur_1792633876502_s7jvwi22` (v6) and `pur_1792654701712_f2iks5to` (v5) remain untouched.
4. **Gate 1 Baseline Seal:** Exact SHA-256 match `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`.
5. **Action 3 Scope:** Action 3 remains blocked awaiting user instructions.

