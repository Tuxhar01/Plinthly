# PLINTHLY — PHASE 16.1: Acceptance Evidence Audit and Sandbox Order Reconciliation Report

## Executive Summary

Phase 16.1 conducted a rigorous, evidence-backed audit of all Phase 16 acceptance claims against actual persisted state, live external APIs, and execution artifacts. We independently reconciled newly created PayPal Sandbox order `2BR08855VR6881230`, audited the underlying evidence behind the workstation strategy's "$0 shipping" claim, corrected UI labels and strategy calculations to prevent policy threshold inferences from being conflated with retailer-issued carrier quotes, and added regression tests.

No new PayPal orders were created during this audit. Gate 1 script integrity remains strictly intact, both protected purchase records remain unmutated in `BUYER_APPROVED` status, and total completed payment captures across the database remain strictly **`0`** ($0.00 captured funds).

---

## 1. Categorized Reconciliation: Claims vs Actual Execution Evidence

In accordance with strict evidence standards, all Phase 16 claims are categorized by their factual source:

| Capability / Claim | Evidence Category | Supporting Artifact / Verification Evidence | Verification Status |
| :--- | :--- | :--- | :--- |
| **Local Next.js Dev Server** | Directly Observed Live Result | Turbopack dev server running on `http://localhost:3000` (`task-4177`), HTTP 200 on all routes | **VERIFIED** |
| **PostgreSQL Database** | Persisted Database State | `plinthly_dev` connected on port 5432; Prisma queries executed cleanly against live schema | **VERIFIED** |
| **Gemini AI Prompt Decomposition** | Directly Observed Live Result | Live `gemini-3.5-flash-lite` provider decomposing workstation prompt in 5.75s (`tests/ai/live-smoke.test.ts`) | **VERIFIED** |
| **Channel3 Catalog Discovery** | Directly Observed Live Result | Live `buy.trychannel3.com` API returning 25 real laptop candidates with merchant URLs and stock | **VERIFIED** |
| **PayPal Sandbox Order Creation** | Directly Observed Live Result & Persisted DB State | Order `2BR08855VR6881230` created via OAuth2 client credentials, recorded in `PaymentAttempt` `pay_att_1793274042584_km4vrx3t` | **VERIFIED** |
| **Zero Fund Capture Invariant** | Persisted Database State & Live Query | Database count of `COMPLETED` payment attempts = 0; PayPal remote order payments = null | **VERIFIED** |
| **$0.00 Workstation Shipping Evidence** | Documented Policy Eligibility Determination | Best Buy Standard Policy (`policy_bestbuy_standard`) verified threshold $\ge \$35.00$ ($2,010.00 merchandise). **NOT** an upstream carrier quote | **RECONCILED & LABELED** |
| **Material Change Invalidation** | Automated Test & Persisted DB State | Destination postal code change from `94103` to `99501` revoked approval with HTTP 422 `destination_changed` | **VERIFIED** |
| **Headless Edge Browser Journey** | Directly Observed Live Artifacts | 7 CDP screenshots captured in conversation artifact directory across 1280px and 375px viewports | **VERIFIED** |

---

## 2. Independent Reconciliation of PayPal Sandbox Order `2BR08855VR6881230`

Using the authorized PayPal Sandbox client credentials and read-only `GET /v2/checkout/orders/2BR08855VR6881230`, the remote order was independently inspected and reconciled with local database state:

### Remote Order Inspection Facts

```json
{
  "id": "2BR08855VR6881230",
  "status": "PAYER_ACTION_REQUIRED",
  "intent": "CAPTURE",
  "create_time": "2026-10-29T11:40:43Z",
  "purchase_units": [
    {
      "reference_id": "pur_1793274041667_01rg028x",
      "amount": {
        "currency_code": "USD",
        "value": "2010.00"
      },
      "payee": {
        "email_address": "sb-iwdxd53443156@business.example.com",
        "merchant_id": "QY7MRN58WTBZY"
      },
      "description": "Plinthly Purchase: pur_1793274041667_01rg028x",
      "custom_id": "pur_1793274041667_01rg028x"
    }
  ],
  "payer": undefined,
  "payments": undefined
}
```

### Reconciliation Findings

1. **Remote Status**: The order exists in PayPal Sandbox with status **`PAYER_ACTION_REQUIRED`**. In the PayPal Orders v2 API lifecycle, this is the standard initial status for orders created with intent `CAPTURE`, awaiting the buyer to authenticate at the checkout URL.
2. **Transaction Reference Binding**: `reference_id` and `custom_id` strictly match purchase `pur_1793274041667_01rg028x`.
3. **Transaction Amount**: The remote order amount is exactly **`$2,010.00 USD`**, which strictly matches the targeted Best Buy cart subtotal ($2,010.00 items + $0.00 policy-derived shipping).
4. **Authorization / Capture Status**:
   - `payer` is `undefined`: No human buyer has logged into PayPal to authorize payment.
   - `payments` object in `purchase_units[0]` is `undefined`: Zero authorizations and zero captures exist on the remote record.
   - **No capture endpoint was ever invoked**.
5. **Comparison with Persisted State**:
   - In `PaymentAttempt` `pay_att_1793274042584_km4vrx3t`: `status: "OPEN"`, `paypalOrderId: "2BR08855VR6881230"`.
   - In `Purchase`: `status: "ORDER_CREATED"`, `version: 3`.
   - In `AuditEvent`: `order_created` recorded with payload `totalCents: 201000`.
   - **Conclusion**: Local persisted state and remote PayPal Sandbox state are in 100% agreement. The order was created for the exact targeted cart amount and remains open with zero fund captures.

---

## 3. Audit of the $0.00 Shipping Claim & Evidence Categorization

### Evidence Category Analysis

We inspected the three-item workstation strategy (Dell XPS 15 laptop at $1,450.00, Dell 4K monitor at $420.00, Dell dock at $140.00; total merchandise $2,010.00 USD; destination 94103). We determined how the `$0.00` shipping cost was derived:

1. **Actual Retailer-Issued Carrier Quote Bound to Exact Cart & Destination**:
   - **NOT PRESENT**. The upstream discovery provider (Channel3) does not provide live real-time carrier shipping quotes (e.g., UPS/FedEx ground rates), and no carrier quote token with `quoteId` or `expiresAt` exists for this candidate set.
2. **Documented Policy Eligibility Determination with All Required Conditions Verified**:
   - **PRESENT**. Best Buy published shipping policy (`policy_bestbuy_standard`) in [`MerchantPolicyRegistry`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/merchant-policy-registry.ts) defines free standard ground shipping for orders $\ge \$35.00$. All conditions were verified:
     - Seller condition: Direct retailer seller (not 3rd-party marketplace).
     - Geographic condition: US ZIP 94103 (standard contiguous US delivery zone, non-excluded).
     - Special delivery: Standard parcel (not freight or major appliance scheduled delivery).
     - Cart threshold: $2,010.00 qualifying merchandise exceeds $35.00 minimum.
3. **Threshold-Based Policy Inference Alone**:
   - A naive inference would assume any cart meeting $35.00 gets free shipping without verifying marketplace sellers or excluded zones. Plinthly avoided this by checking all policy conditions, but Phase 16 previously labeled the shipping as "Verified Shipping" without distinguishing policy derivation from an actual carrier quote.

### Implemented Code Enhancements & Corrections

To eliminate any ambiguity and prevent policy threshold eligibility from being conflated with a retailer-issued shipping quote:

1. **Explicit Shipping Evidence Typing on Planned Shipments**:
   - Added `ShipmentShippingEvidenceType` (`"quoted" | "policy_derived" | "missing" | "estimated"`) to [`PlannedShipment`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/types.ts#L120).
   - Added `isQuoteBound: boolean` to [`PlannedShipment`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/types.ts#L135). For policy-derived free shipping, `isQuoteBound` is strictly `false`.
   - Updated [`planCartShipments`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/split-shipment.ts#L98-L105) to set `shippingEvidenceType: "policy_derived"` and `explanation: "Policy-derived free shipping applied (cart qualified for standard ground shipping threshold). Carrier shipping quote is not bound."`

2. **Accurate Strategy Naming & Rationale Disclosures**:
   - In [`buildStrategyFromAllocations`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/strategy-engine.ts#L160-L190), if the lowest cost strategy relies on policy-derived shipping rather than an upstream carrier quote, it is explicitly labeled:
     **`Lowest Landed Cost (Policy-Derived)`**
   - Rationale explicitly discloses:
     *"Policy-derived landed cost of $2,010.00 USD based on published merchant threshold policy ($0 shipping threshold met). A real-time carrier shipping quote is not bound."*
   - Added `shippingEvidenceType` and `isQuoteBacked` fields to `ProcurementStrategy`.

3. **Studio UI Corrections**:
   - In [`MultiItemProcurementStudio`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/components/workflow/multi-item-procurement-studio.tsx):
     - Strategy cards display `(Policy-Derived)` next to shipping cost when threshold-qualified.
     - Split Shipments tab renders an amber/blue `POLICY-DERIVED` chip (rather than claiming "VERIFIED SHIPPING").
     - Shipping column explicitly reads `$0.00 (Policy Threshold)` to distinguish from retailer quotes.

4. **Regression Tests Added**:
   - Implemented 6 new regression tests in [`tests/workflow/phase16-1-shipping-reconciliation.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase16-1-shipping-reconciliation.test.ts):
     - Confirms policy-threshold eligibility sets `shippingEvidenceType: "policy_derived"` and `isQuoteBound: false`.
     - Confirms explicit quotes set `shippingEvidenceType: "quoted"` and `isQuoteBound: true`.
     - Confirms unquoted items without policy coverage set `shippingEvidenceType: "missing"` and `isQuoteBound: false`.
     - Confirms policy-derived free shipping does not leak to 3rd-party marketplace sellers in split shipments.
     - Confirms strategy naming and rationale reflect `(Policy-Derived)`.
     - Confirms approval snapshot binding and destination change revocation.

---

## 4. Recheck of Approval Integrity & Non-Custodial Boundaries

Using read-only verification:

1. **Snapshot-to-Strategy Binding**:
   - Persisted `multiItemSnapshotHash` (`751724222c1ba89db440034f1c458ed6cc31cf62b0477f073e01da1063684b2f`) cryptographically commits to all 3 line items, candidate IDs, unit prices ($1,450.00, $420.00, $140.00), policy version `2.0.0`, and destination `US / 94103`.
2. **Order Amount Matches Target Cart**:
   - The PayPal order amount of `$2,010.00 USD` strictly matches the targeted Best Buy cart subtotal. No cross-merchant aggregate amounts were commingled.
3. **Material Change Invalidation**:
   - Changing destination to `99501` immediately revokes active approval (`hasActiveApproval: false`).
   - Checkout attempts on the revoked approval are rejected with HTTP 422, preventing stale or tampered execution.

---

## 5. Final Invariant and Test Suite Verification

### Test Suite Execution Results

```bash
# Vitest Test Suite (63 test files, 1,014 tests)
npx vitest run
Exit Code: 0
Duration: 18.51s
Results: 63 test files passed (100%), 1,014 tests passed (100%)

# TypeScript Compiler Check
npx tsc --noEmit
Exit Code: 0 (Zero errors)

# ESLint Static Analysis
npm run lint
Exit Code: 0 (Zero errors, zero warnings)
```

### Security & Financial Invariants Audit

1. **PayPal Gate 1 Script Hash**:
   - Path: `C:\paypal-gate1\gate1.mjs`
   - Expected: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
   - Actual:   `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
   - **Verification**: Exact match. The file remains strictly unmodified.

2. **Protected Purchase Records (`plinthly_dev`)**:
   - `pur_1792633876502_s7jvwi22`: Status `BUYER_APPROVED`, Version `6`, 1 attempt (`OPEN`).
   - `pur_1792654701712_f2iks5to`: Status `BUYER_APPROVED`, Version `5`, 1 attempt (`OPEN`).
   - **Verification**: Both protected records remain strictly unmodified.

3. **Newly Created Sandbox Order (`pur_1793274041667_01rg028x` / `2BR08855VR6881230`)**:
   - Purchase Status: `ORDER_CREATED` (Version `3`).
   - Payment Attempt: `pay_att_1793274042584_km4vrx3t` (`OPEN`).
   - Remote PayPal Order: `PAYER_ACTION_REQUIRED`, 0 payments, 0 captures.
   - **Verification**: Separately accounted; no authorization or capture occurred.

4. **Global Capture Invariant**:
   - Total `COMPLETED` payment attempts across database: **`0`**.
   - Total captured funds across all environments: **`$0.00`**.
   - **Verification**: Zero unauthorized fund transfers.

---

## 6. Remaining Blockers for a Judge-Ready Demonstration

While the application workflow, persistence, and non-custodial boundaries are fully functional, the following real-world boundaries remain:

1. **Carrier Shipping API Integration**:
   - Discovery currently relies on Channel3 (catalog/stock) and the internal `MerchantPolicyRegistry` (threshold rules). Upstream integration with carrier rating APIs (UPS/FedEx) or retailer checkout quote APIs is required to provide real-time `quoted` evidence for merchants that do not publish threshold policies.
2. **PayPal Sandbox Buyer Login Simulation**:
   - Moving from `ORDER_CREATED` / `PAYER_ACTION_REQUIRED` to `BUYER_APPROVED` requires a human tester to authenticate with PayPal Sandbox personal credentials (`buyer@example.com`) in a web browser, or automated headless browser session with Sandbox credentials.
3. **Retailer Fulfillment Automation**:
   - In accordance with Plinthly's non-custodial architecture, actual placement of orders on third-party retailer sites (Best Buy, Walmart) is executed directly with merchants, avoiding custodial fund pooling.

---

## 7. Conclusion

Phase 16.1 has successfully reconciled all acceptance claims with verifiable evidence. PayPal Sandbox order `2BR08855VR6881230` is confirmed open with zero fund captures. The $0 shipping claim is now accurately typed and labeled as **policy-derived threshold qualification** rather than a retailer quote, supported by 6 regression tests, with 100% of test suites passing cleanly and all baseline invariants intact.

