# PLINTHLY — PHASE 15 REPORT
## Multi-Item Procurement, Cart Aggregation and Split-Shipment Planning

**Date**: 2026-10-29  
**Status**: COMPLETE & VERIFIED  
**Gate 1 SHA-256**: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` (`MATCH: true`)  
**Test Suite**: 60 test files passed · 972 tests passed · 0 failed  
**TypeScript**: Exit code `0` (0 errors)  
**ESLint**: Exit code `0` (0 errors, 0 warnings)  

---

### Executive Summary

Phase 15 moves Plinthly from single-candidate evaluation into multi-item commercial procurement. Buyers can now specify complex, multi-line item requests with independent quantities, specifications, budgets, and verification requirements.

The system deterministically matches candidates against line items, enforces strict duplicate allocation prevention, aggregates compatible items into retailer carts, evaluates published merchant shipping policies against cumulative merchandise subtotals, plans physical split shipments, and generates defensible purchasing strategies with truthful landed-cost rankings.

All existing single-item workflows, database tables, and PayPal Sandbox boundaries remain intact and backward-compatible.

---

### 1. Invariants & Safety Baseline Verification

Before and after Phase 15 implementation:

| Security Invariant | Requirement | Observed Status | Defensibility Check |
| :--- | :--- | :--- | :--- |
| **Gate 1 SHA-256** | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` | **MATCH: true** |
| **Protected Purchase 1** | `pur_1792633876502_s7jvwi22` | Status `BUYER_APPROVED`, Version `6`, Payment attempts `1`, Captured `$0.00` | Untouched, Read-Only |
| **Protected Purchase 2** | `pur_1792654701712_f2iks5to` | Status `BUYER_APPROVED`, Version `5`, Payment attempts `1`, Captured `$0.00` | Untouched, Read-Only |
| **Database Captures** | Exactly `0` captures across database | Exactly `0` captures found across all payment attempts | Zero funds captured |
| **Live PayPal Orders** | Zero live or rogue orders created | Zero unintended orders created | Mocked test harness verified |
| **Git & Deployment** | No commits, pushes, deployments, or package publications | Clean local working copy | Strict containment |

---

### 2. Architecture & Multi-Item Data Model

The multi-item procurement architecture is housed under [`lib/discovery/cart/`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/):

```
lib/discovery/cart/
├── index.ts               # Barrel exports
├── types.ts               # Core multi-item interfaces & data models
├── line-item.ts           # Line-item validation & backward-compatibility adapters
├── allocation.ts          # Candidate compatibility & duplicate allocation prevention
├── split-shipment.ts      # Independent split-shipment dispatch planner
├── cart-aggregator.ts     # Retailer cart grouping & policy threshold engine
├── strategy-engine.ts     # Multi-strategy generator & defensible landed-cost ranking
└── approval-snapshot.ts   # Multi-item cryptographic approval snapshot & invalidation
```

#### Multi-Item Procurement Line Items ([`lib/discovery/cart/line-item.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/line-item.ts))
Each discrete requirement is modeled as a [`ProcurementLineItem`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/types.ts):
- Stable line-item identifier (`id`: string).
- Product title / description (`title`: string).
- Quantity (`quantity`: positive integer >= 1).
- Budget constraint (`budgetCents?: number`).
- Currency (`currency: "USD"`).
- Specifications (`requirements: readonly (string | BuyerRequirementItem)[]`).
- Verification level (`verificationLevel?: "strict" | "standard" | "flexible"`).

**Integrity Validations Enforced**:
1. Duplicate line-item IDs rejected immediately (`duplicate_line_item_id`).
2. Non-positive, non-integer, or NaN quantities rejected (`invalid_quantity`).
3. Non-USD currencies rejected (`unsupported_currency`); currency mixing within a request is disallowed.
4. Bidirectional backward compatibility: Legacy requests containing top-level `requirements` arrays automatically map to a single-element `ProcurementLineItem[]` via [`convertLegacyRequirementsToLineItems`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/line-item.ts).

---

### 3. Candidate Allocation and Duplicate Prevention ([`lib/discovery/cart/allocation.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/allocation.ts))

The candidate allocation engine matches candidates to line items based on evidence facts rather than crude title similarity:
- **Specification Contradiction Rejection**: If a line item requires e.g. `RAM: 32GB`, and a candidate has evidence `RAM: 16GB` (status: `contradicts` or value mismatch), allocation is strictly rejected.
- **Strict Verification Level**: In strict mode, missing specifications reject allocation.
- **Duplicate Allocation Prevention**: A single candidate instance cannot satisfy multiple distinct line items in the same plan unless inventory evidence and explicit purchase terms allow it.

---

### 4. Retailer Cart Aggregation & Policy Thresholds ([`lib/discovery/cart/cart-aggregator.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/cart-aggregator.ts))

Items are grouped by normalized merchant domain (`walmart.com`, `target.com`, `bestbuy.com`, `bhphotovideo.com`):
1. **Separation of Concepts**:
   - `contributesToCartThreshold`: Items whose pre-tax subtotal counts toward the order minimum.
   - `isIndividuallyEligibleForFreeShipping`: Items that actually receive $0 shipping once the threshold is met.
   - `isMarketplace`: Third-party marketplace items dispatched by external sellers.
   - `requiresSpecialDelivery`: Freight, scheduled delivery, or oversized items.
2. **Authoritative Policy Rules**:
   - **Walmart**: Standard ground threshold is $35.00. First-party items and eligible Marketplace items contribute to the $35 threshold (`marketplaceItemsContributeToThreshold: true`). However, third-party marketplace items themselves do NOT receive Walmart-funded free shipping (they ship from independent sellers with separate quotes).
   - **Target**: Standard ground threshold is $35.00. Target Plus marketplace items are excluded from the threshold (`requiresDirectRetailerSeller: true`).
   - **Best Buy**: Threshold is $35.00. Excludes marketplace sellers, freight, and scheduled delivery.
   - **B&H**: Free standard ground shipping on orders ($0 threshold for standard, $49 for expedited).

---

### 5. Independent Split-Shipment Planning ([`lib/discovery/cart/split-shipment.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/split-shipment.ts))

Shipments represent physical logistics dispatch and are decoupled from carts and line items:
- **Fulfillment Method Partition**: Freight and scheduled deliveries cannot be consolidated into standard parcel ground packages.
- **Marketplace Seller Partition**: Each third-party marketplace seller dispatches from their own warehouse as a separate shipment.
- **Delivery Dates**: `deliveryDate` remains `null` unless backed by explicit, verified carrier evidence. The system never fabricates delivery timelines.

---

### 6. Strategy Comparison & Defensible Landed Cost ([`lib/discovery/cart/strategy-engine.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/strategy-engine.ts))

The strategy engine evaluates multiple procurement approaches:
1. **Lowest Landed Cost Strategy**: Evaluates optimal item pricing and shipping across retailers.
2. **Consolidated Single-Retailer Strategy**: Maximizes fulfillment from a single merchant to leverage cart thresholds and minimize orders.
3. **Verified Direct Retailer Strategy**: Prioritizes first-party items with complete verified shipping evidence.

#### Defensible Ranking Invariants:
> [!IMPORTANT]
> **Defensible Cost Invariant**: A procurement plan with unquoted or missing shipping charges results in `totalLandedCostCents: null` and `feasibility: "uncertain"`.
> **Ranking Invariant**: An incomplete/uncertain total is **NEVER** ranked as cheaper than a verified complete total, regardless of raw merchandise price.
> **Currency Invariant**: Disparate currencies are never combined into a single sum without an explicit, disclosed conversion method.

---

### 7. Buyer Approval Snapshot & Invalidation Engine ([`lib/discovery/cart/approval-snapshot.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/approval-snapshot.ts))

When a buyer approves a multi-item strategy, the approval is bound to a cryptographic SHA-256 fingerprint ([`computeMultiItemSnapshotHash`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/approval-snapshot.ts)) across:
- All line items, quantities, and requirements.
- Selected candidate IDs and variant facts.
- Retailer carts and threshold evaluations.
- Physical split shipments and shipping charges.
- Destination postal code and country.

Any subsequent material change to quantities, candidates, cart composition, shipping fees, or destination immediately invalidates the approval ([`deriveMultiItemInvalidationReasons`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/cart/approval-snapshot.ts)).

---

### 8. PayPal Sandbox Boundary & Safety ([`lib/workflow/service.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts))

- **Transaction Boundary Enforcement**: Plinthly strictly forbids automatically creating multiple PayPal Sandbox orders when a plan contains multiple retailers.
- In [`PurchaseWorkflowService.createPayPalOrder`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/service.ts#L1030-L1050), if `targetCartMerchantDomain` is supplied, it is validated against the selected candidate retailer. If an unapproved or mismatched retailer domain is provided, it is rejected with a validation error.
- Zero live orders or automated loops are executed.

---

### 9. Multi-Item Procurement Studio UI ([`components/workflow/multi-item-procurement-studio.tsx`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/components/workflow/multi-item-procurement-studio.tsx))

Integrated into the primary purchase dashboard ([`components/workflow/purchase-dashboard.tsx`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/components/workflow/purchase-dashboard.tsx)):
- **Strategy Comparison View**: Compares Lowest Cost, Consolidated, and Direct Retailer plans with feasibility badges, defensible landed costs, and risk disclosures.
- **Retailer Cart Inspector**: Visualizes cumulative merchandise subtotals, free-shipping threshold progress bars (e.g. Walmart $35), remaining amounts, and marketplace vs direct fulfillment badges.
- **Split-Shipment Dispatch View**: Breaks down shipments by fulfillment method and marketplace seller, displaying verified shipping charges and unquoted warnings.
- **Buyer Line Items Table**: Displays item titles, quantities, budgets, specifications, and verification levels.

---

### 10. Automated Test Results

The test suite was executed via `npx vitest run`:

```
Test Files  60 passed (60)
     Tests  972 passed (972)
  Duration  11.52s
```

All 22 dedicated multi-item tests in [`tests/workflow/phase15-multi-item-procurement.test.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/tests/workflow/phase15-multi-item-procurement.test.ts) passed:
1. `1.1` validates multiple line items with distinct IDs, quantities, specifications, and budgets.
2. `1.2` rejects duplicate line-item IDs with `duplicate_line_item_id`.
3. `1.3` rejects invalid quantities (0, negative, floating-point, NaN).
4. `1.4` rejects non-USD currencies and enforces homogeneous USD currency.
5. `1.5` backward compatibility: normalizes legacy requirements to 1 line item.
6. `2.1` allocates candidate when specifications match verified evidence.
7. `2.2` rejects candidate allocation when critical specifications contradict.
8. `2.3` prevents duplicate allocation of the same candidate across distinct line items.
9. `3.1` groups allocated candidates by normalized merchant domain.
10. `3.2` combines multiple line items from same retailer to satisfy $35 threshold.
11. `3.3` differentiates threshold contribution from free-shipping eligibility for Walmart Marketplace items.
12. `3.4` Target cart excludes Target Plus marketplace items from $35 threshold.
13. `4.1` splits cart into multiple shipments when fulfillment methods differ.
14. `4.2` retains null delivery dates when carrier timestamps are unverified.
15. `5.1` generates Lowest Cost and Single-Retailer Consolidated strategies.
16. `5.2` INVARIANT: incomplete total with unquoted shipping is marked uncertain and NEVER ranked cheaper than a complete verified total.
17. `6.1` creates cryptographic `MultiItemApprovalSnapshot`.
18. `6.2` invalidates approval when line-item quantity is changed.
19. `6.3` invalidates approval when delivery destination changes.
20. `7.1` prevents PayPal order creation when purchase is not in `APPROVED` status.
21. `7.2` enforces transaction boundary check when `targetCartMerchantDomain` is provided.
22. `7.3` allows PayPal order creation when `targetCartMerchantDomain` matches the retailer.

---

### 11. Live vs Mocked Integration Matrix

| Subsystem | Mode | Verification Status | Notes |
| :--- | :--- | :--- | :--- |
| **Merchant Shipping Policies** | Authoritative Seeded / Ingested | Verified Published Policies | Target, Walmart, Best Buy, B&H policies verified from official source terms |
| **Channel3 Discovery** | Live API + Normalized Adapter | Live search diagnostic passing | Real Channel3 candidate normalization and query execution |
| **Gemini AI Decomposition** | Live API (gemini-3.5-flash-lite) | Active Live Provider Verified | Prompt decomposition tests passing |
| **Split-Shipment Dispatch** | Deterministic Engine | Verified Logic | Freight, special delivery, and marketplace partitions |
| **PayPal Sandbox Client** | Mocked Boundary | Strict Safety Control | Zero live PayPal orders created during automated runs |
| **Database Persistence** | PostgreSQL / SQLite Prisma | Verified Transactions | Read-only inspection of protected records |

---

### 12. Unresolved Access & Known Limitations

1. **Carrier Estimated Delivery Dates**: Commercial API credentials for live carrier tracking (FedEx, UPS, USPS APIs) are not integrated; `deliveryDate` remains strictly `null` in accordance with the truthfulness invariant.
2. **Multi-Merchant Simultaneous Checkout**: PayPal Sandbox does not natively support single-step multi-seller split checkout in standard REST APIs. Plinthly strictly enforces discrete buyer approval per transaction boundary (`targetCartMerchantDomain`).

