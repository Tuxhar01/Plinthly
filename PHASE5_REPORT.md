# Phase 5 — PayPal Sandbox Integration Report

**Date:** 2026-10-20  
**Project:** Purchase Assurance  
**Workspace:** `C:\Users\Tushar Kumar\Desktop\Plinthly`  
**Verdict:** **PASS**

---

## 1. Executive Summary

Phase 5 introduces server-side PayPal Sandbox order creation and buyer approval verification to Purchase Assurance, strictly preserving the existing state machine (`transition()`), cryptographic approval integrity, PostgreSQL persistence contracts, and atomic idempotency guarantees.

All interactions are strictly restricted to PayPal Sandbox (`https://api-m.sandbox.paypal.com`). In adherence to Phase 5 directives:
- Capture endpoints and live-money transactions are **strictly prohibited** and were **not implemented**.
- Workflow progression stops definitively at `BUYER_APPROVED`.
- No database migrations were executed, no database writes were performed against an external DB, no Git remote was configured, and no changes were pushed, published, or deployed.
- Baseline Gate 1 script `C:\paypal-gate1\gate1.mjs` was untouched; its SHA-256 hash was preserved identically before and after execution.

---

## 2. Gate 1 Baseline Integrity Verification

The Gate 1 file `C:\paypal-gate1\gate1.mjs` was verified using SHA-256:
- **Preflight Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Post-Verification Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Integrity Status:** **MATCH (Unchanged)**

No inspections, reads, edits, moves, renames, executions, or deletions were performed on `C:\paypal-gate1\gate1.mjs`.

---

## 3. Files Created and Modified

### New Modules & Routes
1. `lib/paypal/types.ts`:
   - Domain and DTO contracts for PayPal Sandbox client, OAuth token responses, order creation requests/responses, and typed error hierarchy (`PayPalConfigError`, `PayPalNetworkError`, `PayPalTimeoutError`, `PayPalApiError`, `PayPalUnknownOutcomeError`).
2. `lib/paypal/client.ts`:
   - Server-only PayPal Sandbox client (`PayPalSandboxClient`).
   - Sandbox-only URL validation (`validateSandboxBaseUrl`) strictly rejecting production domains (`api.paypal.com`, `api-m.paypal.com`).
   - Safe OAuth token acquisition with client credentials, in-memory TTL caching with a 60-second skew buffer, explicit request timeouts (default 10s via `AbortSignal.timeout`), and sanitized error logging.
3. `app/api/purchases/[id]/paypal/create-order/route.ts`:
   - Dedicated POST route handler for server-side PayPal order creation.
   - Enforces actor authentication (`requireActor`), purchase ownership (`assertPurchaseAccess`), body validation (`createPayPalOrderSchema`), and returns 201 Created with order ID and buyer approval URL.
4. `app/api/purchases/[id]/paypal/confirm-approval/route.ts`:
   - Dedicated POST route handler for buyer approval confirmation.
   - Enforces actor authentication, purchase ownership, body validation (`confirmBuyerApprovalSchema`), queries PayPal Sandbox independently, advances state machine, and returns 200 OK with `BUYER_APPROVED` purchase aggregate.

### Modified Files
1. `lib/workflow/repository.ts`:
   - Added `PaymentAttemptRecord`, `RecordOrderCreationParams`, and `RecordBuyerApprovalParams`.
   - Updated `PurchaseAggregate` to include `paymentAttempts: readonly PaymentAttemptRecord[]`.
   - Enhanced both `InMemoryPurchaseRepository` and `PrismaPurchaseRepository` with atomic `recordOrderCreation` and `recordBuyerApproval` methods with optimistic concurrency checks (`expectedStatus`, `expectedVersion`).
2. `lib/workflow/service.ts`:
   - Implemented `createPayPalOrder(purchaseId, actor, options)`: derives order amounts strictly from approved candidate snapshot, verifies active approval, checks against snapshot drift, idempotently reuses existing orders, handles timeouts without duplicate orders, and records audit trails.
   - Implemented `confirmBuyerApproval(purchaseId, actor, req)`: fetches order status directly from PayPal Sandbox, asserts `APPROVED` status, validates currency and amount equality, calls `transition()` with `observe_paypal_order`, and updates the attempt record.
3. `lib/workflow/auth.ts`:
   - Added `"create_order"` and `"confirm_approval"` operations to `assertPurchaseAccess`, enforcing that only the verified purchase owner (or authorized actor) can create or confirm PayPal orders.
4. `lib/workflow/types.ts`:
   - Added `CreatePayPalOrderRequest`, `CreatePayPalOrderResponse`, and `ConfirmBuyerApprovalRequest`.
   - Updated `PurchaseResponse` with `livePaymentAttempt` metadata.
5. `lib/workflow/validation.ts`:
   - Added Zod schemas `createPayPalOrderSchema` and `confirmBuyerApprovalSchema`.
6. `.env.example`:
   - Added placeholder configuration keys:
     - `PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com`
     - `PAYPAL_CLIENT_ID=`
     - `PAYPAL_CLIENT_SECRET=`

### Test Suites
1. `tests/paypal/client.test.ts` (12 unit tests):
   - Validates Sandbox config parsing, rejection of production endpoints, OAuth token retrieval, token caching, order creation payload formatting, order retrieval, and error taxonomy.
2. `tests/paypal/service.test.ts` (11 integration tests):
   - Tests server-derived amount integrity, refusal of unapproved purchases, refusal when approval snapshot drifts, actor authorization, idempotent replay, unknown-outcome timeout retention, independent PayPal status verification, amount mismatch rejection, and legal audit trails.
3. `tests/paypal/api.test.ts` (4 route tests):
   - Tests HTTP route handlers for 401 unauthenticated, 403 unauthorized ownership, 201 order creation, and 200 buyer approval confirmation.

---

## 4. PayPal Sandbox Configuration & Security Architecture

### Server-Only Enforcement
- Credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) are read strictly within server processes and are never exposed to client bundles, HTTP responses, or audit records.
- In-memory OAuth tokens are managed entirely within `PayPalSandboxClient` and are excluded from all audit event payloads and repository records.

### Fail-Closed Sandbox Enforcement
The client validates configuration on instantiation:
```ts
function validateSandboxBaseUrl(rawUrl?: string): string {
  if (!rawUrl) return "https://api-m.sandbox.paypal.com";
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new PayPalConfigError("PayPal API base URL must use HTTPS.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "api.paypal.com" || hostname === "api-m.paypal.com") {
    throw new PayPalConfigError(
      `Production PayPal endpoint "${hostname}" is strictly prohibited in Sandbox integration.`
    );
  }
  if (!hostname.includes("sandbox")) {
    throw new PayPalConfigError(
      `Invalid PayPal Sandbox endpoint "${hostname}". Endpoint must be a valid PayPal Sandbox domain.`
    );
  }
  return url.origin;
}
```

---

## 5. State Machine Transitions & Invariant Adherence

No new state values were added to the domain model. Phase 5 uses the legal transitions already formalized in Phase 1:

1. **Transition T10 (`create_order`):**
   - **Pre-condition:** `status === "APPROVED"`, valid non-invalidated approval, non-drifted candidate snapshot hash, amount and currency exact match.
   - **Target Status:** `ORDER_CREATED`.
   - **Action:** Remote PayPal order created; order ID and attempt persisted.
   - **Audit Event:** `type: "order_created"`, recording actor, internal purchase ID, PayPal order ID, and resulting state.

2. **Transition T11 (`observe_paypal_order`):**
   - **Pre-condition:** `status === "ORDER_CREATED"`, PayPal Sandbox order independently retrieved and observed with `status === "APPROVED"`, amount and currency matching server-approved terms.
   - **Target Status:** `BUYER_APPROVED`.
   - **Audit Event:** `type: "buyer_approved"`, recording actor, internal purchase ID, PayPal order ID, and verified status.

Under no circumstances does Phase 5 transition to `COMPLETED`, capture funds, or claim that payment is finalized.

---

## 6. Order Creation Idempotency & Unknown-Outcome Recovery Design

### Remote Idempotency
- When calling PayPal's order creation endpoint, `PayPalSandboxClient` passes `PayPal-Request-Id: <idempotencyKey>`.
- The key is derived either from the client's request header / payload or falls back deterministically to `pay_${purchaseId}_${approvalId}`.

### In-Flight Replay
- If a purchase is already in `ORDER_CREATED`, `createPayPalOrder()` inspects the existing open payment attempt and returns the existing order details and approval URL without initiating a second remote PayPal order.

### Unknown-Outcome Timeout Recovery
- Remote network calls are subject to an explicit 10,000ms timeout (`AbortSignal.timeout(10000)`).
- If PayPal's API times out during order creation, the client cannot know whether PayPal received and created the order or failed before processing.
- The service catches `PayPalTimeoutError`, marks or leaves the internal purchase state in `APPROVED`, records a recoverable `PayPalUnknownOutcomeError`, and prevents blind retries from duplicating orders. The caller or reconciliation worker can replay using the same idempotency key to recover the definitive outcome.

---

## 7. Buyer Approval Verification Logic

To prevent client-side spoofing or tampered approval responses:
1. The server never accepts a client-provided PayPal status as authoritative.
2. The service accepts only the internal `purchaseId` and the matching `paypalOrderId`.
3. The server calls PayPal's Sandbox API `GET /v2/checkout/orders/{id}` using its own server credentials.
4. The server inspects the returned payload:
   - Validates that `status === "APPROVED"`.
   - Validates that `purchase_units[0].reference_id === purchaseId`.
   - Validates that `purchase_units[0].amount.value` and `currency_code` exactly equal the approved terms.
5. Only when all checks succeed is `transition()` invoked with `observe_paypal_order`, advancing the state machine to `BUYER_APPROVED`.

---

## 8. Database Migration Prerequisites & Status

- **Prerequisites:** Two migrations exist in `prisma/migrations`:
  1. `20261020124600_phase1_domain`: Core domain models including `Purchase`, `PaymentAttempt`, `AuditEvent`, `Approval`, `Candidate`, `EvidenceItem`.
  2. `20261020150000_phase4_1_idempotency_audit`: Idempotency records table and compound unique index constraints.
- **Applied Status:** **UNAPPLIED**
  - No active PostgreSQL instance was connected during this phase.
  - Per preflight instructions, `prisma migrate deploy` was not run.
  - In-memory repository implementations mirror the Prisma schema exactly and allow full test and build verification without live database writes.

---

## 9. Test Execution & Verification Suite

All 32 test files comprising 467 tests ran and passed.

### Test Breakdown
- **Mocked Unit/Service Tests:** All tests in `tests/paypal/` use mocked HTTP fetch / mock PayPal clients. No live PayPal Sandbox network requests were made, guaranteeing deterministic, hermetic test runs.
- **Regression Tests:** All 450+ tests from Phases 0–4.2 passed without regressions.

### Command Execution Results
| Command | Result | Exit Code | Notes |
| :--- | :---: | :---: | :--- |
| `npm test` | **PASS** | 0 | 32 test files, 467 tests passed |
| `npx tsc --noEmit` | **PASS** | 0 | Zero TypeScript type errors |
| `npm run lint` | **PASS** | 0 | Zero ESLint warnings or errors |
| `npx prisma validate` | **PASS** | 0 | Prisma schema valid |
| `npx prisma generate` | **PASS** | 0 | Prisma client generated successfully |
| `npm run build` | **PASS** | 0 | Next.js production build succeeded with Turbopack |

---

## 10. Security Limitations & Unresolved Scope

1. **Unapplied Migrations:** PostgreSQL migrations remain unapplied until a production/staging database is provisioned and migrated.
2. **Phase 6 Prerequisite:** Webhook ingestion (`CHECKOUT.ORDER.APPROVED`) and payment authorization/capture are deferred to Phase 6. Funds are intentionally not captured.
3. **No Live Sandbox Credentials:** Tests rely on mocked HTTP transports; live Sandbox end-to-end smoke tests require populating real Sandbox credentials into `.env.local`.

---

## 11. Git Status & Deployment Confirmation

- **Git Status:** Clean branch `master`, no commits made, untracked files match development workspace.
- **Remote:** No Git remote exists or was created (`git remote -v` is empty).
- **Deployment:** Nothing was published, pushed, deployed, captured, or transacted with real money.

---

## 12. Final Verdict

**PASS** — Phase 5 requirements for PayPal Sandbox order creation and buyer approval verification are fully satisfied, preserving state machine transitions, approval integrity, optimistic concurrency, and atomic idempotency. Phase 6 has not been started.
