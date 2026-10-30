# PLINTHLY — PHASE 15.1: Multi-Item Runtime Integration and End-to-End Verification Report

## Executive Summary

Phase 15.1 builds directly on the domain algorithms established in Phase 15 (candidate allocation, retailer cart aggregation, split-shipment planning, and cryptographic approval snapshots) to integrate multi-item procurement into Plinthly's live application runtime.

All identified integration gaps have been resolved and verified with automated test coverage:
1. **Durable Snapshot Persistence & Restart Survival:** Multi-item approval snapshots are now durably written to the database under `Purchase.requirements.approvedStrategy` alongside transactional `Approval` records, surviving complete server/service restarts without state loss.
2. **Channel3 Automated Per-Line-Item Discovery:** When candidates are not pre-supplied, `createMultiItemPlan` executes query discovery across the `SourceAdapter` boundary for each individual line item, populating candidates with verifiable evidence while maintaining strict non-fabrication guarantees.
3. **Fail-Closed Unfulfillment Safety:** If discovery yields no matching offers for any line item, the strategy engine marks feasibility as `"blocked"`, produces explicit risk disclosures, and prevents buyer approval under fail-closed invariants.
4. **Pre-Order Snapshot Revalidation in `createPayPalOrder`:** Before dispatching an order to the PayPal Sandbox boundary, `createPayPalOrder` revalidates the multi-item approval snapshot against current candidate facts and destination postal codes. Any discrepancy automatically records approval invalidation and halts checkout.
5. **Single-Merchant Transaction Boundary Enforcement:** PayPal transactions are strictly partitioned by merchant domain. Multi-cart split strategies require an explicit `targetCartMerchantDomain`, preventing multi-merchant order consolidation at the payment gateway while ensuring each merchant cart charges its exact defensible landed cost.
6. **UI Integration:** `PurchaseRequestCard` supports a "Multi-Item Cart Aggregation" mode with dynamic line item authoring, and `MultiItemProcurementStudio` supports interactive line item management, budget summaries, and candidate re-evaluation.

---

## 1. Baseline and Invariants Verification

### 1.1 Gate 1 Invariant
- **Gate 1 File:** `C:\paypal-gate1\gate1.mjs`
- **Expected SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Observed SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Match:** `true`

### 1.2 Protected Purchases and Captures
Read-only database query verified:
- `pur_1792633876502_s7jvwi22`: Status `BUYER_APPROVED`, Version `6`, 1 payment attempt (`OPEN`), 0 captured funds.
- `pur_1792654701712_f2iks5to`: Status `BUYER_APPROVED`, Version `5`, 1 payment attempt (`OPEN`), 0 captured funds.
- **Total `COMPLETED` payment attempts across database:** Exactly `0`.
- **Zero Live PayPal Captures:** Verified throughout all test cycles and mock executions.

---

## 2. Architecture and Runtime Hardening

### 2.1 Durable Snapshot Persistence
- **Repository Layer (`lib/workflow/repository.ts`):**
  - Updated `RecordApprovalParams` to accept `requirements?: unknown` and `selectedCandidateId?: string`.
  - In `PrismaPurchaseRepository.recordApproval`, updated the conditional transaction update (`tx.purchase.updateMany`) to update `purchase.requirements` and `purchase.selectedCandidateId` alongside `status: "APPROVED"` and `version: { increment: 1 }`.
  - In `InMemoryPurchaseRepository.recordApproval`, updated in-memory purchase state to retain `requirements` and `selectedCandidateId`.
- **Service Layer (`lib/workflow/service.ts`):**
  - In `approveMultiItemPlan`, all allocated candidates in `targetStrategy.allocations` are durably upserted into the `Candidate` table via `saveCandidateWithEvidence`.
  - Created a transactional `ApprovalRecord` with `snapshotHash: computedSnapshotHash`, `totalCents: targetStrategy.totalLandedCostCents`, and `approverUserId: actor.userId`.
  - Persisted the approval via `this.repo.recordApproval` with `requirements: { lineItems, approvedStrategy: activeApproval }`.
  - In `createMultiItemPlan`, if `aggregate.purchase.requirements` contains `approvedStrategy`, the active snapshot is restored across server restarts, reflecting any invalidation recorded in `aggregate.approvals`.

### 2.2 Automated Per-Line-Item Discovery
- `PurchaseWorkflowService` constructor accepts an injected `discoveryAdapter: SourceAdapter = new Channel3SourceAdapter()`.
- When `createMultiItemPlan` receives no candidate pool, it iterates through each line item in `lineItems` and executes `discoveryAdapter.search(...)`.
- Discovered products are normalized and saved into the repository.
- If discovery returns zero offers or encounters upstream errors, no synthetic candidates are fabricated, preserving the zero-fabrication invariant.

### 2.3 Pre-Order Snapshot Revalidation & Transaction Boundary
- In `createPayPalOrder`:
  - Detects multi-item purchases via `aggregate.purchase.requirements.approvedStrategy`.
  - **Transaction Boundary:**
    - If the approved strategy spans multiple carts (split shipment across merchants), an explicit `targetCartMerchantDomain` is required. Omitting it throws `ValidationError`.
    - If `targetCartMerchantDomain` does not match any cart in the approved strategy, checkout is rejected.
    - If the strategy consolidates all items into a single cart, omitting `targetCartMerchantDomain` safely resolves to the single cart without ambiguity.
  - **Snapshot Integrity:**
    - Checks `eff.snapshotHash === multiItemSnapshot.multiItemSnapshotHash`.
    - Checks destination consistency: if `options.destination.postalCode !== multiItemSnapshot.destination.postalCode`, records invalidation and rejects checkout.
    - Checks candidate facts: verifies every allocated item's candidate snapshot hash matches `snapItem.candidateSnapshotHash`.
    - Computes order amount strictly as `targetedCart.merchandiseSubtotalCents + targetedCart.shippingCents`.

### 2.4 User Interface Integration
- **`components/workflow/purchase-request-card.tsx`:**
  - Added a "Procurement Mode" switcher: `Single-Item Procurement` vs `Multi-Item Cart Aggregation`.
  - In multi-item mode, buyers dynamically add, configure, and remove line items with live aggregate budget computation.
  - Submits structured line items to `/api/purchases`.
- **`components/workflow/multi-item-procurement-studio.tsx`:**
  - In Tab 4 ("Buyer Line Items"), buyers can add new items, modify titles, quantities, and budgets, and remove rows.
  - "Evaluate Multi-Item Plan" submits the edited line items to the plan generation endpoint.

---

## 3. Test Execution and Verification

### 3.1 Test Suite Breakdown
A dedicated integration suite was implemented in `tests/workflow/phase15-1-runtime-integration.test.ts` covering:
1. `1.1`: Durable persistence across service restarts and snapshot restoration.
2. `2.1`: Automated per-line-item discovery query delegation via `SourceAdapter`.
3. `3.1`: Fail-closed line item unfulfillment with blocked feasibility and approval prevention.
4. `4.1`: Pre-order candidate snapshot hash modification detection and invalidation recording.
5. `4.2`: Pre-order destination postal code mismatch detection and invalidation recording.
6. `5.1`: Multi-cart order creation blocked when `targetCartMerchantDomain` is omitted.
7. `5.2`: Rejection of unapproved `targetCartMerchantDomain`.
8. `5.3`: Successful order creation for targeted merchant cart with exact cart landed cost.
9. `5.4`: Single-cart multi-item purchase checkout without ambiguity.
10. `6.1`: Verification of zero live PayPal captures across all multi-item workflows.

### 3.2 Full Suite Verification Results
- **Vitest:**
  - `61` test files passed (100%).
  - `982` tests passed (100%).
  - Zero test failures, zero skips.
- **TypeScript (`npx tsc --noEmit`):**
  - Exit code `0` (clean, 0 type errors).
- **ESLint (`npm run lint`):**
  - Exit code `0` (clean, 0 warnings, 0 errors).

---

## 4. Modified Files Summary

| File Path | Description of Changes |
| :--- | :--- |
| `lib/workflow/repository.ts` | Added `requirements?: unknown` and `selectedCandidateId?: string` to `RecordApprovalParams`; updated Prisma and InMemory conditional updates. |
| `lib/workflow/service.ts` | Injected `SourceAdapter` in constructor; added per-line-item discovery in `createMultiItemPlan`; implemented durable approval persistence in `approveMultiItemPlan`; hardened pre-order revalidation and transaction boundary in `createPayPalOrder`. |
| `lib/workflow/types.ts` | Added optional `candidates?: readonly NormalizedProductCandidate[]` to `ApproveMultiItemPlanRequest`. |
| `lib/workflow/validation.ts` | Added optional `candidates` array to `approveMultiItemPlanSchema`. |
| `components/workflow/purchase-request-card.tsx` | Added Procurement Mode selector with dynamic multi-line item creation and aggregate budget calculation. |
| `components/workflow/multi-item-procurement-studio.tsx` | Enabled interactive line item addition, deletion, and inline editing in Tab 4. |
| `tests/workflow/phase15-1-runtime-integration.test.ts` | Comprehensive Phase 15.1 integration test suite (10 tests). |

