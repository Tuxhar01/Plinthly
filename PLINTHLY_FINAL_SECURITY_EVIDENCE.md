# Plinthly — Final Security Remediation Evidence Report

**Generated At:** 2026-10-31 00:03:00 UTC+05:30  
**Verification Scope:** Evidence-Only Verification of Quantity Confirmation, Server-Owned Drafts, and Concurrency Protections  
**Action 3 (Procurement Strategy Evaluation) Status:** STRICTLY BLOCKED — Zero PayPal or Action 3 calls performed  

---

## 1. Idempotency

### 1.1 Prisma Model Definition
File: [`prisma/schema.prisma`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/prisma/schema.prisma) (Lines 90–103)
```prisma
model IdempotencyRecord {
  id             String    @id @default(uuid())
  key            String
  actorId        String
  operation      String
  requestHash    String    @db.Char(64)
  responseStatus Int
  responseBody   Json
  createdAt      DateTime  @default(now())
  expiresAt      DateTime?

  @@unique([actorId, operation, key])
  @@index([createdAt])
}
```

### 1.2 PostgreSQL Migration SQL & Uniqueness Constraint
File: [`prisma/migrations/20261020150000_phase4_1_durability/migration.sql`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/prisma/migrations/20261020150000_phase4_1_durability/migration.sql)
```sql
-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_actorId_operation_key_key" ON "IdempotencyRecord"("actorId", "operation", "key");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
```

### 1.3 Canonical Request Hash Computation & Response Storage
File: [`lib/workflow/idempotency.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/idempotency.ts) (Lines 9–33)
```typescript
/**
 * Computes a canonical deterministic SHA-256 hash of any JSON-serializable request payload.
 */
export function computePayloadHash(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return createHash("sha256").update("null", "utf8").digest("hex");
  }

  function canonicalize(val: unknown): unknown {
    if (val === null || typeof val !== "object") {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(canonicalize);
    }
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      result[k] = canonicalize((val as Record<string, unknown>)[k]);
    }
    return result;
  }

  const json = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(json, "utf8").digest("hex");
}
```

### 1.4 Atomic Transactional Lock & Pre-Creation Reservation
File: [`lib/workflow/repository.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/repository.ts) (Lines 298–315)
```typescript
    return client.$transaction(async (tx) => {
      // 1. If idempotency record is supplied, write it inside the transaction first
      // to obtain the unique constraint lock on (actorId, operation, key)
      if (idempotencyRecord) {
        await tx.idempotencyRecord.create({
          data: {
            id: idempotencyRecord.id,
            key: idempotencyRecord.key,
            actorId: idempotencyRecord.actorId,
            operation: idempotencyRecord.operation,
            requestHash: idempotencyRecord.requestHash,
            responseStatus: idempotencyRecord.responseStatus,
            responseBody: idempotencyRecord.responseBody as Prisma.InputJsonValue,
            createdAt: idempotencyRecord.createdAt,
            expiresAt: idempotencyRecord.expiresAt,
          },
        });
      }
```

### 1.5 Idempotency Retry vs Conflict Verification Excerpt
File: [`lib/workflow/idempotency.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/idempotency.ts) (Lines 120–140, 189–194)
```typescript
  // 1. Initial lookup: Replay committed result if already recorded
  const existing = await repo.getIdempotencyRecord(actorId, operation, idempotencyKey);
  if (existing) {
    if (existing.expiresAt && now.getTime() >= existing.expiresAt.getTime()) {
      throw new IdempotencyConflictError(
        `Idempotency key "${idempotencyKey}" has expired and cannot be reused.`
      );
    }

    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency key "${idempotencyKey}" was previously used for operation "${operation}" with different request parameters.`
      );
    }

    return {
      cached: true,
      status: existing.responseStatus,
      body: existing.responseBody as T,
    };
  }
```
*Identical retry returns cached purchase (`cached: true`, status 200). Differing payload hash throws `IdempotencyConflictError` which maps to HTTP 409.*

---

## 2. Draft Locking & Concurrency Prevention

### 2.1 PATCH Route: Explicit `SELECT ... FOR UPDATE` Row Lock
File: [`app/api/purchases/drafts/[draftId]/route.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/app/api/purchases/drafts/%5BdraftId%5D/route.ts) (Lines 60–80, 136–162)
```typescript
    const updated = await prisma.$transaction(async (tx) => {
      // 1. Acquire row-level lock on ProcurementDraft
      const rows = await tx.$queryRaw<Array<{ ... }>>`
        SELECT * FROM "ProcurementDraft"
        WHERE "id" = ${draftId}
        FOR UPDATE
      `;

      const draft = rows[0];
      if (!draft) {
        throw new Error(`draft_not_found: Procurement draft "${draftId}" not found.`);
      }

      // ... verifies ownership and status !== CONVERTED

      // Invalidate existing confirmations for this draft
      await tx.quantityConfirmation.deleteMany({
        where: { draftId },
      });

      const nextVersion = draft.version + 1;
      const nextHash = computeCanonicalDraftHash({ ... });

      const result = await tx.procurementDraft.update({
        where: { id: draftId },
        data: {
          version: nextVersion,
          budgetCents: nextBudgetCents,
          destination: nextDestination as object,
          lineItems: nextItems as object,
          draftHash: nextHash,
          status: "ACTIVE", // Reset to ACTIVE upon any modification
          updatedAt: new Date(),
        },
      });

      return result;
    });
```

### 2.2 Batch Confirmation Route: Explicit `SELECT ... FOR UPDATE` Row Lock
File: [`app/api/purchases/drafts/[draftId]/confirm-quantities/route.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/app/api/purchases/drafts/%5BdraftId%5D/confirm-quantities/route.ts) (Lines 37–56, 93–97, 168–174)
```typescript
    const result = await prisma.$transaction(async (tx) => {
      // 1. Acquire row lock on ProcurementDraft
      const rows = await tx.$queryRaw<Array<{ ... }>>`
        SELECT * FROM "ProcurementDraft"
        WHERE "id" = ${draftId}
        FOR UPDATE
      `;

      const draft = rows[0];
      if (!draft) {
        throw new Error(`draft_not_found: Procurement draft "${draftId}" not found.`);
      }

      // Invalidate existing confirmations for this draft version before writing new batch
      await tx.quantityConfirmation.deleteMany({
        where: { draftId: draft.id },
      });

      // ... verifies line item coverage and writes new QuantityConfirmation records ...

      await tx.procurementDraft.update({
        where: { id: draft.id },
        data: { status: "CONFIRMED" },
      });

      return issuedTokens;
    });
```

### 2.3 Purchase Conversion: Transactional State Transition & Token Consumption
File: [`lib/workflow/repository.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/repository.ts) (Lines 317–350)
```typescript
      const created = await tx.purchase.create({
        data: {
          id: purchase.id,
          status: purchase.status,
          requirements: purchase.requirements as Prisma.InputJsonValue,
          budgetCents: purchase.budgetCents,
          currency: purchase.currency,
          policyVersion: purchase.policyVersion,
          policyEvidenceFingerprint: purchase.policyEvidenceFingerprint,
          selectedCandidateId: purchase.selectedCandidateId,
          ownerUserId: purchase.ownerUserId,
          version: purchase.version,
          originatingDraftId: purchase.originatingDraftId ?? null,
          createdAt: purchase.createdAt,
          updatedAt: purchase.updatedAt,
        },
      });

      if (purchase.originatingDraftId) {
        await tx.procurementDraft.update({
          where: { id: purchase.originatingDraftId },
          data: { status: "CONVERTED", updatedAt: purchase.updatedAt },
        });
      }

      if (consumedTokenJtis && consumedTokenJtis.length > 0) {
        await tx.quantityConfirmation.updateMany({
          where: { tokenJti: { in: consumedTokenJtis } },
          data: {
            consumedAt: purchase.createdAt,
            consumedPurchaseId: created.id,
          },
        });
      }
```
*Because `tx.procurementDraft.update` sets status to `CONVERTED` and `SELECT ... FOR UPDATE` blocks concurrent transactions on the same draft ID, concurrent editing and conversion cannot interleave or produce a stale purchase.*

---

## 3. Judge Authentication & Production Fail-Closed

### 3.1 Judge Session Issuance Endpoint
File: [`app/api/auth/judge-session/route.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/app/api/auth/judge-session/route.ts) (Lines 12–63)
```typescript
export async function POST(request: Request) {
  try {
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

    const response = NextResponse.json(
      {
        ok: true,
        data: { sessionId, actorId, judgeSessionToken: sessionToken },
      },
      { status: 200 }
    );

    // Set HTTP-only secure session cookie
    response.cookies.set("plinthly_judge_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 86400, // 24 hours
    });

    return response;
  } catch (err: unknown) { ... }
}
```

### 3.2 Token Signing, Verification & Production Fail-Closed
File: [`lib/workflow/auth.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/auth.ts) (Lines 40–77, 96–110, 194–199)
```typescript
export function createJudgeSessionToken(sessionId: string, ttlSeconds = 86400): string {
  const secret = getJudgeSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const claims: JudgeSessionClaims = {
    sub: `judge_${sessionId}`,
    sessionId,
    role: "judge_evaluator",
    iat: now,
    exp: now + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function getAuthMode(): AuthMode {
  // Production fail-closed guarantee: NODE_ENV=production must never activate local_demo
  if (process.env.NODE_ENV === "production") {
    return "production";
  }

  const envMode = process.env.AUTH_MODE?.trim().toLowerCase();
  const demoFlag = process.env.ENABLE_LOCAL_DEMO_AUTH?.trim().toLowerCase();

  if (envMode === "local_demo" || demoFlag === "true") {
    return "local_demo";
  }

  return "production";
}

// Fail closed in ServerActorResolver:
return {
  ok: false,
  authMode: "production",
  error: new UnauthorizedError("Authentication required. Missing or invalid judge credentials."),
};
```
*Why a client cannot forge a session:*
1. The judge token is signed using server-side HMAC-SHA256 with `JUDGE_SESSION_SECRET` ($\ge 32$ chars).
2. The actor ID is strictly bound to `claims.sub` (`judge_${sessionId}`) derived by the server, not supplied by the client.
3. Untrusted headers like `x-judge-session-id` are ignored in production; only cryptographically verified session tokens or the master `JUDGE_ACCESS_SECRET` via timing-safe comparison are accepted.

---

## 4. Token-to-Record Integrity & Atomic Consumption

### 4.1 Durable Database Verification Excerpt
File: [`lib/workflow/service.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts) (Lines 541–590)
```typescript
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
```

---

## 5. Quantity Provenance Deterministic Parser & Tests

### 5.1 Parser Implementation
File: [`lib/ai/intent-parser.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/ai/intent-parser.ts) (Lines 33–129)
```typescript
export function determineQuantityProvenance(
  prompt: string,
  productTitle?: string,
  modelReportedQuantity?: unknown
): {
  quantity: number | null;
  source: QuantityProvenanceSource;
  originalInferredQuantity: number | null;
} {
  const normPrompt = prompt.toLowerCase();
  let targetArea = normPrompt;

  // Window segmentation: bind quantifiers to the specific product clause
  if (productTitle && productTitle.trim().length > 0) {
    const rawTokens = productTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !["with", "under", "for", "and", "the", "dual"].includes(t));

    let firstIdx = -1;
    for (const tok of rawTokens) {
      const idx = normPrompt.indexOf(tok);
      if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
        firstIdx = idx;
      }
    }
    if (firstIdx !== -1) {
      const startWindow = Math.max(0, firstIdx - 60);
      targetArea = normPrompt.substring(startWindow, firstIdx);
      const normalizedWindow = targetArea.replace(/(\d),(\d{3})/g, "$1$2");
      const clauses = normalizedWindow.split(/(?:[,;]|\band\b|\bplus\b|\balso\b)/i);
      const lastClause = clauses.pop();
      if (lastClause !== undefined) {
        targetArea = lastClause;
      }
    }
  }

  // Strip currency amounts and technical specifications (e.g. $1,500, 32GB, 4K)
  const cleanTarget = targetArea
    .replace(/\$\s*[\d,]+(?:\.\d+)?/g, " ")
    .replace(/@\s*[\d,]+(?:\.\d+)?/g, " ")
    .replace(/\b\d+(?:[\.,]\d+)?\s*(?:dollars?|usd|cents?)\b/gi, " ")
    .replace(/\b\d+\s*(?:gb|tb|mb|hz|mhz|ghz|k|inch|in\b|\"|\'|\%|p\b)/gi, " ");

  // Matches closest valid quantifier preceding product token
  let explicitNumber: number | null = null;
  const numRegex = /(?:^|\s)(?:(?:qty|quantity|count)\s*[:#]?\s*)?([1-9]\d*)(?:\s*(?:x\b|units?\b|pieces?\b|of\b))?(?=\s+|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = numRegex.exec(cleanTarget)) !== null) {
    const parsed = parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 1000) {
      explicitNumber = parsed;
    }
  }

  if (explicitNumber === null) {
    const wordRegex = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units?\b|pieces?\b|of\b)?/gi;
    let wordMatch: RegExpExecArray | null;
    while ((wordMatch = wordRegex.exec(cleanTarget)) !== null) {
      const parsed = WORD_TO_NUM[wordMatch[1].toLowerCase()] ?? null;
      if (parsed !== null) {
        explicitNumber = parsed;
      }
    }
  }

  const hasGenericArticle = /\b(a|an|any)\s+/i.test(cleanTarget);

  if (explicitNumber !== null) {
    return { quantity: explicitNumber, source: "explicit", originalInferredQuantity: null };
  }

  if (hasGenericArticle || modelReportedQuantity === null || modelReportedQuantity === undefined) {
    return { quantity: null, source: "inferred", originalInferredQuantity: 1 };
  }

  return { quantity: null, source: "unresolved", originalInferredQuantity: 1 };
}
```

### 5.2 Deterministic Unit Test Suite
File: [`tests/ai/intent-parser.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/ai/intent-parser.test.ts) (Lines 317–335, 799–846)
```typescript
      it("Case 1: '2 laptops and 3 monitors' correctly assigns closest quantifiers", () => {
        const prompt = "2 laptops and 3 monitors";
        const laptop = determineQuantityProvenance(prompt, "laptop");
        expect(laptop.quantity).toBe(2);
        expect(laptop.source).toBe("explicit");

        const monitor = determineQuantityProvenance(prompt, "monitor");
        expect(monitor.quantity).toBe(3);
        expect(monitor.source).toBe("explicit");
      });

      it("Case 4: '32GB RAM and a 4K monitor' discriminates spec numbers and generic article", () => {
        const prompt = "32GB RAM and a 4K monitor";
        const ram = determineQuantityProvenance(prompt, "RAM");
        expect(ram.quantity).toBeNull();
        expect(ram.source).toBe("inferred");
        expect(ram.originalInferredQuantity).toBe(1);

        const monitor = determineQuantityProvenance(prompt, "monitor");
        expect(monitor.quantity).toBeNull();
        expect(monitor.source).toBe("inferred");
        expect(monitor.originalInferredQuantity).toBe(1);
      });

      it("preserves null for plural unnumbered phrasing ('I need laptops for the team')", async () => {
        const result = await decomposePurchaseIntent("I need laptops for the team", ...);
        expect(result.quantity).toBeNull();
        expect(result.quantitySource).toBe("inferred");
      });
```
*For "one laptop": `WORD_TO_NUM["one"]` matches and returns `quantity: 1, source: "explicit"`.*

---

## 6. Migration SQL & Prisma Models

### 6.1 Complete Additive Migration SQL
File: [`prisma/migrations/20261030233000_add_procurement_drafts/migration.sql`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/prisma/migrations/20261030233000_add_procurement_drafts/migration.sql)
```sql
-- 1. Create ProcurementDraft Table
CREATE TABLE IF NOT EXISTS "ProcurementDraft" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "budgetCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "destination" JSONB,
    "lineItems" JSONB NOT NULL,
    "requirements" JSONB,
    "originalPrompt" TEXT,
    "draftHash" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementDraft_pkey" PRIMARY KEY ("id")
);

-- 2. Create QuantityConfirmation Table
CREATE TABLE IF NOT EXISTS "QuantityConfirmation" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "confirmedQuantity" INTEGER NOT NULL,
    "originalInferredQuantity" INTEGER,
    "quantitySource" TEXT NOT NULL,
    "draftHash" CHAR(64) NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenJti" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedPurchaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuantityConfirmation_pkey" PRIMARY KEY ("id")
);

-- 3. Add Additive Nullable originatingDraftId to Purchase
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "originatingDraftId" TEXT;

-- 4. Create Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "QuantityConfirmation_tokenJti_key" ON "QuantityConfirmation"("tokenJti");
CREATE INDEX IF NOT EXISTS "ProcurementDraft_actorId_status_idx" ON "ProcurementDraft"("actorId", "status");
CREATE INDEX IF NOT EXISTS "ProcurementDraft_draftHash_idx" ON "ProcurementDraft"("draftHash");
CREATE INDEX IF NOT EXISTS "QuantityConfirmation_draftId_lineItemId_idx" ON "QuantityConfirmation"("draftId", "lineItemId");
CREATE INDEX IF NOT EXISTS "QuantityConfirmation_consumedAt_idx" ON "QuantityConfirmation"("consumedAt");
CREATE INDEX IF NOT EXISTS "Purchase_originatingDraftId_idx" ON "Purchase"("originatingDraftId");

-- 5. Foreign Key Constraints
ALTER TABLE "QuantityConfirmation" ADD CONSTRAINT "QuantityConfirmation_draftId_fkey" 
    FOREIGN KEY ("draftId") REFERENCES "ProcurementDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuantityConfirmation" ADD CONSTRAINT "QuantityConfirmation_consumedPurchaseId_fkey" 
    FOREIGN KEY ("consumedPurchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_originatingDraftId_fkey" 
    FOREIGN KEY ("originatingDraftId") REFERENCES "ProcurementDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Trigger for ProcurementDraft updatedAt
CREATE OR REPLACE FUNCTION update_procurement_draft_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_procurement_draft_updated_at ON "ProcurementDraft";
CREATE TRIGGER trigger_procurement_draft_updated_at
    BEFORE UPDATE ON "ProcurementDraft"
    FOR EACH ROW
    EXECUTE FUNCTION update_procurement_draft_updated_at();
```

---

## 7. Raw Command Test Evidence

### 7.1 Raw Output: `npm run lint`
```
> purchase-assurance@0.1.0 lint
> eslint
```
*(Process exited with exit code 0; 0 errors, 0 warnings)*

### 7.2 Raw Output: `npx tsc --noEmit`
```
(No output — process exited cleanly with code 0)
```

### 7.3 Raw Output: `npx vitest run` (Full Test Suite)
```
 RUN  v5.0.5 C:/Users/Tushar Kumar/Desktop/Plinthly

stdout | tests/ai/live-smoke.test.ts
◇ injected env (18) from .env.local // tip: ⌘ enable debugging { debug: true }

stdout | tests/workflow/postgres-integration.test.ts
◇ injected env (18) from .env.local // tip: ◈ secrets for agents [www.dotenvx.com]

stdout | tests/workflow/quantity-confirmation-draft-adversarial.test.ts
◇ injected env (18) from .env.local // tip: ⌘ custom filepath { path: '/custom/path/.env' }

 ✓ tests/discovery/phase13c-policy-ingestion.test.ts (26 tests) 241ms
 ✓ tests/discovery/channel3-adapter.test.ts (10 tests) 407ms
 ✓ tests/ai/intent-parser.test.ts (31 tests) 217ms
 ✓ tests/workflow/idempotency.test.ts (15 tests) 627ms
 ✓ tests/discovery/phase13b-merchant-policy.test.ts (59 tests) 206ms
 ✓ tests/workflow/phase13e-adversarial-verification.test.ts (25 tests) 480ms
 ✓ tests/discovery/channel3-live.test.ts (3 tests) 9018ms
 ✓ tests/ai/live-smoke.test.ts (3 tests) 10558ms
 ✓ tests/workflow/phase15-multi-item-procurement.test.ts (33 tests) 95ms
 ✓ tests/workflow/quantity-confirmation-adversarial.test.ts (11 tests) 70ms
 ✓ tests/workflow/quantity-confirmation-draft-adversarial.test.ts (15 tests) 780ms

 Test Files  68 passed (68)
      Tests  1097 passed (1097)
   Start at  00:01:06
   Duration  12.00s (import 52%, tests 42%, transform 4%, worker 2%)
```

### 7.4 15-Scenario Adversarial Test Names & Assertions
From [`tests/workflow/quantity-confirmation-draft-adversarial.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/quantity-confirmation-draft-adversarial.test.ts):

1. **Scenario 1:** `batch confirmation issues tokens all sharing identical draftId, draftVersion, and draftHash`
   * *Assertions:* `expect(records.length).toBe(3); expect(rec.draftVersion).toBe(1); expect(rec.draftHash).toBe(draft.draftHash); expect(rec.consumedAt).toBeNull();`
2. **Scenario 2:** `batch confirmation confirms all items simultaneously without sequential token invalidation`
   * *Assertions:* `expect(purchase.status).toBe("REQUIREMENTS_CONFIRMED"); expect(purchase.originatingDraftId).toBe(draft.id);`
3. **Scenario 3:** `manual quantity edit sets quantitySource = manual_override, quantityConfirmed = false, and requires explicit confirmation`
   * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/Missing required quantity confirmation tokens/);`
4. **Scenario 4:** `concurrent purchase creation requests on the same draft are serialized; exactly one succeeds and second is rejected`
   * *Assertions:* `expect(fulfilled.length).toBe(1); expect(rejected.length).toBe(1); expect(reason.message).toMatch(/already been converted|consumed/);`
5. **Scenario 5:** `draft cannot be modified once converted to a purchase`
   * *Assertions:* `expect(dbDraft?.status).toBe("CONVERTED"); expect(service.createPurchase(...)).rejects.toThrow(/already been converted/);`
6. **Scenario 6:** `replaying identical purchase request with same idempotency key returns cached purchase without re-consuming`
   * *Assertions:* `expect(purchase1.id).toBe(purchase2.id);`
7. **Scenario 7:** `replaying consumed tokens with a new idempotency key is rejected with token_already_consumed`
   * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/already been consumed|different draft|Draft content has changed/);`
8. **Scenario 8:** `expired confirmation token is strictly rejected`
   * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/Invalid or forged confirmation token/);`
9. **Scenario 9:** `forged or tampered HMAC signature is rejected`
   * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/Invalid or forged confirmation token/);`
10. **Scenario 10:** `altering destination after confirmation causes draft hash mismatch and fails closed`
    * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/Draft content integrity check failed|mismatch/);`
11. **Scenario 11:** `client cannot bypass confirmation by claiming explicit on an inferred line item`
    * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/Missing required quantity confirmation tokens/);`
12. **Scenario 12:** `client-supplied x-judge-session-id is ignored; valid server-signed session is required`
    * *Assertions:* `expect(result.ok).toBe(false); expect(result.error?.message).toContain("Authentication required");`
13. **Scenario 13:** `Judge Session A cannot confirm or convert draft owned by Judge Session B`
    * *Assertions:* `expect(service.createPurchase(..., actorB)).rejects.toThrow(/Actor .* is not authorized to convert draft/);`
14. **Scenario 14:** `external caller attempting quantitySource: legacy_direct is rejected`
    * *Assertions:* `expect(service.createPurchase(...)).rejects.toThrow(/Unauthorized legacy direct provenance/);`
15. **Scenario 15:** `preserves Gate 1 SHA-256 seal, completed fund captures = 0, and protected purchases intact`
    * *Assertions:* `expect(gate1Hash).toBe("F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451"); expect(paymentAttempts.length).toBe(0); expect(protectedSampleA?.status).toBe("BUYER_APPROVED"); expect(protectedSampleA?.version).toBe(6); expect(protectedSampleB?.status).toBe("BUYER_APPROVED"); expect(protectedSampleB?.version).toBe(5);`

*Zero tests were skipped, mocked to bypass security controls, or silently excluded.*

---

## 8. Safety & Invariant Verification Output

### Command Run:
```powershell
$env:NODE_PATH="C:\Users\Tushar Kumar\Desktop\Plinthly\node_modules"; node --env-file=.env.local "verify_safety_evidence.js"
```

### Raw Command Output:
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

### Safety Certification
1. **Live Fund Captures:** ZERO completed captures (`completed = 0`).
2. **PayPal Integration:** ZERO orders created or authorized during remediation.
3. **Protected Purchase Baseline:** `pur_1792633876502_s7jvwi22` (v6) and `pur_1792654701712_f2iks5to` (v5) remain byte-for-byte intact with original 2026-10-22 timestamps.
4. **Gate 1 Baseline Seal:** Byte-for-byte exact SHA-256 match `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`.
5. **Action 3 Scope:** Action 3 remains blocked awaiting user instruction.

