# PLINTHLY — PHASE 16.3: Legacy Sandbox Order Isolation and Final Payment-Flow Acceptance Report

## Executive Summary

Phase 16.3 delivers rigorous isolation of legacy PayPal Sandbox orders created under previous `CAPTURE` intent assumptions, enforces end-to-end payment intent invariants across client, server, and external boundaries, and validates the complete payment lifecycle state machine under adversarial and edge-case conditions.

### Primary Acceptance Outcomes
1. **Legacy Order Isolation**: PayPal Sandbox order `2BR08855VR6881230` (created during Phase 16 with legacy intent `CAPTURE`) was independently verified read-only. It has been strictly quarantined: [`PaymentVerificationService`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/paypal/verification.ts) and [`PurchaseWorkflowService`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts) now explicitly verify remote order intent, permanently preventing legacy `CAPTURE` orders from advancing to `BUYER_APPROVED` or being authorized.
2. **Authoritative Request Path**: Schema validation ([`createPayPalOrderSchema`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/validation.ts)), workflow service ([`createPayPalOrder`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts)), and client SDK ([`PayPalSandboxClient`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/paypal/client.ts)) consistently mandate `intent: "AUTHORIZE"`. Any payload or client parameter attempting `intent: "CAPTURE"` is rejected fail-closed before network dispatch.
3. **Comprehensive Lifecycle Distinctions Suite**: Created [`tests/workflow/phase16-3-lifecycle-acceptance.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase16-3-lifecycle-acceptance.test.ts) covering all 7 core payment lifecycle state distinctions (14 test cases, 100% passing).
4. **Zero Fund Captures & Invariant Preservation**: Database-wide completed captures remain strictly `0`. Protected purchases `pur_1792633876502_s7jvwi22` (v6) and `pur_1792654701712_f2iks5to` (v5) remain unmodified in `BUYER_APPROVED`. Gate 1 SHA-256 remains exact: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`.
5. **Full Regression Cleanliness**: 65 test files, 1,038 tests passing; TypeScript compiler check (`npx tsc --noEmit`) 0 errors; ESLint (`npm run lint`) 0 errors, 0 warnings.

---

## 1. Observed State and Isolation of Order `2BR08855VR6881230`

### A. Live Remote Inspection (Read-Only)
Direct read-only inspection against PayPal Sandbox endpoint `GET /v2/checkout/orders/2BR08855VR6881230` observed:
```json
{
  "id": "2BR08855VR6881230",
  "intent": "CAPTURE",
  "status": "PAYER_ACTION_REQUIRED",
  "purchase_units": [
    {
      "reference_id": "pur_1793274041667_01rg028x",
      "amount": { "currency_code": "USD", "value": "2010.00" },
      "payee": { "merchant_id": "QY7MRN58WTBZY", "email_address": "sb-iwdxd53443156@business.example.com" }
    }
  ],
  "create_time": "2026-10-29T11:40:43Z"
}
```

### B. Local Persistence & Lineage Audit
1. **Associated Purchase**: `pur_1793274041667_01rg028x` (status: `ORDER_CREATED`, version: 3).
2. **Associated Payment Attempt**: `pay_att_1793274042584_km4vrx3t` (status: `OPEN`, `idempotencyKey`: `paypal-order-pur_1793274041667_01rg028x-1793274042584`).
3. **Intent Preservation Gap Identified**:
   - The Prisma [`PaymentAttempt`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/prisma/schema.prisma#L174-L190) schema does not include an `intent` column.
   - The `order_created` [`AuditEvent`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/prisma/schema.prisma#L192-L202) payload recorded `{ approvalId, totalCents, paypalOrderId, paymentAttemptId }`, omitting the PayPal intent parameter.
   - Consequently, local persistence cannot infer the order's intent from stored records alone without querying PayPal.
4. **Isolation Guard Established**:
   - In [`PaymentVerificationService.verifyPayment`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/paypal/verification.ts#L385-L420), when the authoritative remote order is retrieved, the service inspects `remoteOrder.intent`:
     ```typescript
     if (remoteOrder.intent && remoteOrder.intent !== "AUTHORIZE") {
       await this.repo.recordPaymentVerification({
         purchaseId,
         paymentAttemptId: liveAttempt.id,
         verifiedStatus: "INTENT_INCOMPATIBLE",
         verifiedAt: now,
         failureReason: "legacy_capture_intent_incompatible",
       });

       return {
         purchaseId,
         paypalOrderId: liveAttempt.paypalOrderId,
         internalStatus: aggregate.purchase.status,
         outcome: "MISMATCH_REJECTED",
         verified: false,
         remoteStatus: remoteOrder.status ?? null,
         referenceIdMatched: true,
         amountMatched: true,
         currencyMatched: true,
         observedAmountCents,
         observedCurrency,
         verifiedAt: nowIso,
         message: `PayPal order "${liveAttempt.paypalOrderId}" was created with intent "${remoteOrder.intent}", which is incompatible with Plinthly's authorization-only lifecycle. This legacy order is isolated and cannot be authorized or advanced.`,
         approvalUrl: null, // Critical: suppress approval URL so buyer cannot approve incompatible order
         details: {
           observedIntent: remoteOrder.intent,
           requiredIntent: "AUTHORIZE",
           legacyOrderIncompatible: true,
         },
       };
     }
     ```
   - In [`PurchaseWorkflowService.confirmBuyerApproval`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts#L2090-L2110), remote order intent is similarly inspected before state transitions:
     ```typescript
     if (remoteOrder.intent && remoteOrder.intent !== "AUTHORIZE") {
       try {
         await this.repo.recordPaymentVerification({
           purchaseId,
           paymentAttemptId: liveAttempt.id,
           verifiedStatus: "INTENT_INCOMPATIBLE",
           verifiedAt: new Date(),
           failureReason: "legacy_capture_intent_incompatible",
         });
       } catch {}
       throw new WorkflowError(
         "incompatible_payment_intent",
         `PayPal order "${liveAttempt.paypalOrderId}" has intent "${remoteOrder.intent}", which is incompatible with Plinthly's authorization-only workflow. Legacy CAPTURE orders cannot be approved or authorized.`
       );
     }
     ```
5. **Live Verification of Isolation**:
   - Running live verification against order `2BR08855VR6881230` confirms:
     - Outcome: `MISMATCH_REJECTED`
     - Verified: `false`
     - Approval URL: `null` (suppressed)
     - `verifiedStatus` recorded: `INTENT_INCOMPATIBLE`
     - `failureReason` recorded: `legacy_capture_intent_incompatible`
     - Purchase status: unchanged in `ORDER_CREATED` (version 3)
     - No PayPal mutation, authorization, or capture occurred.

---

## 2. Request Path Invariant Verification

| Layer | Component | Invariant Enforcement | Verification Method |
|---|---|---|---|
| **API Schema** | [`createPayPalOrderSchema`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/validation.ts#L122) | Rejects `intent: "CAPTURE"` with Zod validation error; permits only `"AUTHORIZE"` or omitted. | Automated schema test in [`phase16-3-lifecycle-acceptance.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase16-3-lifecycle-acceptance.test.ts#L418-L432) |
| **API Route** | `POST /api/purchases/[id]/paypal/create-order` | Parses input body through `createPayPalOrderSchema`; rejects invalid payloads with HTTP 400. | Integration test in [`tests/paypal/api.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/paypal/api.test.ts) |
| **Workflow Service** | [`PurchaseWorkflowService.createPayPalOrder`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts#L1812) | Always supplies `intent: "AUTHORIZE"` to PayPal client, ignoring any non-authoritative client preference. | Mock inspection test in [`phase16-3-lifecycle-acceptance.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase16-3-lifecycle-acceptance.test.ts#L434-L447) |
| **PayPal Client** | [`PayPalSandboxClient.createOrder`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/paypal/client.ts#L306-L315) | Throws `PayPalApiError` immediately if `input.intent === "CAPTURE"`; guarantees `payload.intent = "AUTHORIZE" as const` in outgoing POST payload. | Request-body capture test in [`tests/workflow/phase16-2-paypal-intent.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase16-2-paypal-intent.test.ts#L76-L89) |
| **UI Components** | Multi-cart checkout UI (`components/checkout/`) | Labels buttons "Authorize with PayPal"; redirects via safe approve link without fund capture. | Manual CDP Edge browser journey and unit assertions |

---

## 3. Payment Lifecycle State Distinctions Test Results

[`tests/workflow/phase16-3-lifecycle-acceptance.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase16-3-lifecycle-acceptance.test.ts) exercises 14 dedicated test cases across 8 lifecycle scenarios:

```
 ✓ tests/workflow/phase16-3-lifecycle-acceptance.test.ts (14 tests)
   ✓ 1. Order Created — Buyer Action Required (PAYER_ACTION_REQUIRED / CREATED)
     ✓ reports PENDING_BUYER_ACTION and preserves ORDER_CREATED state without advancing
   ✓ 2. Buyer Approved Order (APPROVED)
     ✓ advances purchase from ORDER_CREATED to BUYER_APPROVED upon verified buyer approval
     ✓ idempotently verifies when purchase is already in BUYER_APPROVED
   ✓ 3. Non-Capture Invariant & External Completion
     ✓ reports REMOTELY_COMPLETED without falsely advancing internal workflow to COMPLETED
   ✓ 4. Remote Unverified & Fault Isolation (Transient Errors / 404)
     ✓ returns UNVERIFIED_TRANSIENT on PayPalNetworkError without mutating purchase state
     ✓ returns UNVERIFIED_TRANSIENT on PayPalTimeoutError without mutating purchase state
     ✓ returns REMOTE_NOT_FOUND on HTTP 404 and preserves historical audit records
   ✓ 5. Legacy Order Wrong Intent (CAPTURE) Isolation
     ✓ verifyPayment rejects legacy CAPTURE order and suppresses approval URL
     ✓ confirmBuyerApproval throws incompatible_payment_intent on legacy CAPTURE order
   ✓ 6. Order Creation Timeout & Ambiguity Handling
     ✓ surfaces PayPalTimeoutError without recording an unverified order ID
   ✓ 7. Idempotent Retry Reconciles Without Second Order
     ✓ returns existing payment attempt on subsequent calls without creating a duplicate order
   ✓ 8. Request Path & Schema Enforcement (AUTHORIZE Only)
     ✓ createPayPalOrderSchema rejects any payload with intent: 'CAPTURE'
     ✓ createPayPalOrderSchema accepts payload with intent: 'AUTHORIZE' or undefined
     ✓ workflowService.createPayPalOrder always sends intent: 'AUTHORIZE' to PayPalSandboxClient
```

---

## 4. Final Regression & Invariant Verification

### A. Test Suite Results
- **Vitest**: `65 passed (65 files)`, `1038 passed (1038 tests)`.
- **TypeScript**: `npx tsc --noEmit` exited `0` (clean, 0 type errors).
- **ESLint**: `npm run lint` exited `0` (clean, 0 warnings, 0 errors).

### B. Security & Cryptographic Invariants
- **Gate 1 Script**: `C:\paypal-gate1\gate1.mjs`
  - SHA-256 Digest: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
  - Status: **UNMODIFIED** (`gate1Hash === expectedGate1: true`).
- **Protected Purchase Records**:
  - `pur_1792633876502_s7jvwi22`: Status `BUYER_APPROVED`, version `6`, 1 attempt (`OPEN`).
  - `pur_1792654701712_f2iks5to`: Status `BUYER_APPROVED`, version `5`, 1 attempt (`OPEN`).
  - Status: **UNMODIFIED** (read-only verified).
- **Database Capture Count**:
  - `SELECT count(*) FROM "PaymentAttempt" WHERE status = 'COMPLETED'` = `0`.
  - Total captured funds across database: **$0.00** (Zero capture invariant strictly maintained).

---

## 5. Next Product-Development Milestones

With single-item and multi-item candidate discovery, quote-derived shipping calculation, durable multi-item carts, PayPal `AUTHORIZE` lifecycle enforcement, and legacy `CAPTURE` order isolation complete, the following product milestones remain:

1. **Carrier Shipping API Live Ingestion**: Integrate live Shippo/EasyPost/FedEx quote retrieval endpoints to augment static retailer threshold policies with real-time zone-based shipping calculations.
2. **Post-Authorization Order Fulfillment Automation**: Build post-authorization state transitions (transitioning from `BUYER_APPROVED` to merchant order placement and shipment tracking).
3. **Escrow & Capture Delivery Gate**: Implement the delivery-confirmation webhook handler that authoritatively captures authorized PayPal funds only upon verified parcel delivery receipt.

