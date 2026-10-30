# Plinthly — Phase 17 Acceptance Report: Judge-Ready Demo and Product Narrative

**Date:** October 29, 2026  
**Status:** ACCEPTED & VERIFIED  
**Milestone:** Phase 17 — Judge-Ready Demo, Payment-Intent Audit Trail, and Product Narrative  
**Author:** Antigravity AI  

---

## 1. Executive Summary

Phase 17 successfully transitions Plinthly from an audited architectural foundation into a demonstrably usable, judge-ready product. All objectives specified in the Phase 17 mandate have been achieved and verified against live execution evidence:

1. **Payment-Intent Audit Trail Gap Closed:** Persists requested intent (`AUTHORIZE`) with payment attempts and their corresponding audit events without modifying the database DDL or retroactively inventing data for historical records. Verified by 6 dedicated automated tests.
2. **Repeatable 10-Step Demo Journey:** Implemented and verified an isolated, deterministic 3-item workstation procurement scenario covering natural language parsing with Gemini, ambiguity identification, multi-merchant policy threshold evaluation, transparent evidence inspection, feasible strategy comparison, cryptographic approval locking, material destination change invalidation, and checkout boundary fraud rejection.
3. **Product & UI Polish:** Streamlined desktop and mobile layouts, embedded prominent non-capture payment safety notices, surfaced policy threshold progress indicators, and added a one-click **"Load Judge Demo Fixture (3 Items)"** control directly into the dashboard.
4. **Complete Judge Package:** Delivered `PHASE17_DEMO_RUNBOOK.md`, `PHASE17_PRODUCT_NARRATIVE.md`, and this `PHASE17_ACCEPTANCE_REPORT.md`.
5. **System Invariants Preserved:** Gate 1 hash is strictly unmodified, both protected purchases remain untouched in `BUYER_APPROVED` status, and total completed fund captures across the database remain strictly **zero**.

---

## 2. Invariant & Safety Baseline Verification

Before and after implementing Phase 17 changes, the system was verified against all protected boundaries:

| Invariant Check | Required Value | Observed Value | Status |
| :--- | :--- | :--- | :--- |
| **Gate 1 Script SHA-256** | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` | **PASS (UNTOUCHED)** |
| **Protected Purchase 1** | `pur_1792633876502_s7jvwi22` (v6, status: `BUYER_APPROVED`) | v6, status: `BUYER_APPROVED`, 1 attempt (`OPEN`) | **PASS (READ-ONLY)** |
| **Protected Purchase 2** | `pur_1792654701712_f2iks5to` (v5, status: `BUYER_APPROVED`) | v5, status: `BUYER_APPROVED`, 1 attempt (`OPEN`) | **PASS (READ-ONLY)** |
| **Total Completed Captures**| Strictly 0 across PostgreSQL | 0 completed captures | **PASS (ZERO CAPTURES)** |
| **Sandbox Order Creation** | Zero new remote PayPal orders created during Phase 17 | 0 new PayPal orders created | **PASS (ZERO ORDERS)** |

---

## 3. Objective 1: Payment-Intent Audit Trail Implementation

### Root Cause & Audit Trail Architecture
In Phase 16.3, Plinthly established that remote order `2BR08855VR6881230` was created with `intent: CAPTURE` due to an unpinned default prior to Phase 16.2. To ensure all future payment attempts immutably record their requested intent locally without requiring a destructive schema migration, Plinthly enhanced the state transition and audit system:

1. **State & Types:** Added `requestedIntent?: "AUTHORIZE" | string | null` to `PaymentAttemptFacts`, `PaymentAttemptRecord`, `AuditPayloadOrderCreated`, and `CreatePayPalOrderResponse`.
2. **State Transition:** In `lib/state/transitions.ts`, the `create_order` transition records `requestedIntent: "AUTHORIZE"` directly on `newAttempt` and embeds it in the `order_created` audit event payload.
3. **Repository Hydration:** In `lib/workflow/repository.ts`, `PrismaPurchaseRepository.getPurchaseById` extracts `requestedIntent` directly from the matching `order_created` audit event payload.
4. **Historical Isolation:** For the legacy order `2BR08855VR6881230`, `requestedIntent` reports `null` (unrecorded in historical audit event), preventing retrospective fabrication.
5. **No Schema Migration:** Storing the intent in the `AuditEvent.payload` JSON column allowed full audit immutability without modifying Prisma DDL or altering production tables.

### Automated Test Verification
New test suite: `tests/workflow/phase17-payment-intent-audit.test.ts` (6 tests, all passing):
- `1. records requestedIntent: 'AUTHORIZE' in payment attempt facts on order creation transition` (PASS)
- `2. records requestedIntent: 'AUTHORIZE' in order_created audit event payload` (PASS)
- `3. persists requestedIntent: 'AUTHORIZE' through repository and hydrates it on getPurchaseById` (PASS)
- `4. leaves requestedIntent undefined/null for legacy orders without inventing historical intent` (PASS)
- `5. handles remote lookup failure cleanly without altering recorded requestedIntent` (PASS)
- `6. createPayPalOrder service method includes requestedIntent: 'AUTHORIZE' in response and attempt record` (PASS)

---

## 4. Objective 2: Repeatable 10-Step Deterministic Demo Verification

An automated end-to-end verification script (`scratch/test_demo_flow.ts`) exercised the complete lifecycle through the active Next.js runtime (`http://localhost:3000`):

```
=== PHASE 17 DEMO VERIFICATION SCRIPT ===

--- Step 1 & 2: Natural Language Decompose via Gemini ---
Decompose Status: 200
Extracted Keywords: workstation laptop, 4K monitor, USB-C dock
Extracted Destination: { country: 'US', postalCode: '98101' }
Unresolved Ambiguities: [
  'Quantity is not explicitly specified for workstation laptop, 4K monitor, and USB-C dock.',
  'Multiple distinct products requested in a single prompt; please separate into distinct purchase requests for accurate budgeting and processing.'
]

--- Step 3: Create Multi-Item Purchase (3 Line Items) ---
Create Purchase Status: 201
Created Purchase ID: pur_1793279274941_j1esx6ko
Purchase Status: REQUIREMENTS_CONFIRMED

--- Step 4-7: Evaluate Multi-Item Procurement Plan ---
Plan Evaluation Status: 200
Strategies Evaluated: 3
- Strategy [strat_lowest_landed_cost]: "Lowest Landed Cost (Policy-Derived)" | Feasibility: feasible | Merchandise: $2000.00 | Shipping: $0.00 (policy_derived) | Landed: $2000.00
- Strategy [strat_consolidated_single_retailer]: "Consolidated (bestbuy.com)" | Feasibility: feasible | Merchandise: $2010.00 | Shipping: $0.00 (policy_derived) | Landed: $2010.00
- Strategy [strat_uncertain_evidence]: "Incomplete Shipping Candidate" | Feasibility: uncertain | Merchandise: $1970.00 | Shipping: UNQUOTED (unverified) | Landed: INCOMPLETE

--- Step 8: Buyer Approves Strategy ---
Approving strategy: "Lowest Landed Cost (Policy-Derived)" (strat_lowest_landed_cost)
Approve Strategy Status: 200
Approved Purchase Status: APPROVED
Approval Snapshot Hash: fd642118a13ec2ad4019e7b90479766fb3070db392806013bad8dbb8b1b949d6

--- Reload & Persisted Snapshot Inspection ---
Reload Status: 200
Persisted Status: APPROVED
Persisted Strategy ID: strat_lowest_landed_cost
Persisted Snapshot Hash matches: true

--- Step 9: Material Destination Change Staleness Invalidation ---
Re-evaluated for Alaska (99501) Status: 200
Snapshot Invalidation Triggered: Out-of-zone delivery invalidates contiguous US ground shipping assumptions.

--- Step 10: Checkout Boundary Rejection Check ---
Tampered Checkout Status: 400
Tampered Checkout Rejected: true
Rejection Error: {
  code: 'invalid_input',
  message: 'Target cart merchant domain "nonexistent_fraudulent_vendor.com" does not match any approved cart (bhphotovideo.com, bestbuy.com).'
}

=== ALL 10 DEMO STEPS VERIFIED SUCCESSFULLY ===
```

---

## 5. Objective 3: Product Experience & UI Polish

1. **Multi-Item Procurement Studio Controls:**
   - Added **"Load Judge Demo Fixture (3 Items)"** button directly into the dashboard card header. Allows evaluators and judges to populate and evaluate the canonical 3-item workstation request with one click.
   - Built interactive tabs for **Strategy Comparison**, **Retailer Carts**, **Split Shipments**, and **Buyer Line Items**.
   - Built a dynamic **Free Shipping Policy Progress Bar** showing threshold attainment (`$2010.00 >= $35.00 Threshold (QUALIFIED)`).
2. **Transparent Evidence Distinction:**
   - Every shipping line displays a distinct badge:
     - `RETAILER QUOTED` (green / pass)
     - `POLICY-DERIVED` (blue / info)
     - `UNQUOTED / INCOMPLETE` (yellow / caution)
   - Candidates or strategies with unquoted shipping fees are permanently blocked from buyer approval, preventing unexpected checkout charges.
3. **Prominent Non-Capture Safety Notice:**
   - In `components/workflow/paypal-card.tsx`, embedded an informational banner:
     > *"Order creation sets up an authorized payment agreement in PayPal Sandbox; it is not payment authorization or capture. Funds are never moved during order creation. Buyer authorization occurs separately in PayPal Sandbox, and fund capture is strictly deferred until verified fulfillment."*
4. **Mobile & Desktop Responsiveness:**
   - Verified adaptive layout on mobile viewports (`375px`) and desktop viewports (`1280px`). Tables include horizontal scroll wrappers (`overflow-x-auto`) to prevent layout clipping.

---

## 6. Comprehensive Verification Summary

```text
================================================================================
PLINTHLY PHASE 17 VERIFICATION SUMMARY
================================================================================
1. Vitest Test Suite:           66 test files passed | 1,044 tests passed (0 failures)
2. TypeScript (tsc --noEmit):    Exit Code 0 (clean, 0 type errors)
3. ESLint (npm run lint):        Exit Code 0 (clean, 0 warnings, 0 errors)
4. Gate 1 Script Hash:          F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451 (MATCH)
5. Protected Purchases:         pur_1792633876502_s7jvwi22 (v6), pur_1792654701712_f2iks5to (v5) (INTACT)
6. Total Captured Funds:        0 USD (Zero completed captures across entire database)
7. Sandbox Order Creations:     0 new remote orders created during this phase
8. Judge Artifacts Produced:     PHASE17_DEMO_RUNBOOK.md, PHASE17_PRODUCT_NARRATIVE.md, PHASE17_ACCEPTANCE_REPORT.md
================================================================================
STATUS: PHASE 17 OBJECTIVES FULLY SATISFIED AND ACCEPTED
================================================================================
```

---

## 7. Final Judge Rehearsal Results & Visual Evidence

On October 29, 2026, a comprehensive end-to-end rehearsal was executed using headless Chromium against the active Next.js runtime (`http://localhost:3000`). All user-facing views, states, and safety boundaries were exercised at desktop (`1280x900`) and mobile (`375x812`) viewports against the deterministic 3-item workstation request (`pur_1793282867200_lzmy27od`).

### 7.1. Strategy Reconciliation & Shipping Evidence Audit

The displayed purchasing strategies were audited back to candidate facts, cart composition, and merchant shipping policies:

#### Strategy 1: Lowest Landed Cost ($2,000.00 USD)
- **Cart 1: Best Buy (`bestbuy.com`)**
  - Item 1: Dell XPS 15 (32GB RAM) — $1,460.00 USD
  - Item 2: Dell UltraSharp 27 4K Monitor — $400.00 USD
  - Merchandise Subtotal: $1,860.00 USD
  - Shipping Policy: Best Buy Ground ($35.00 threshold)
  - Policy Evaluation: $1,860.00 $\ge$ $35.00 $\rightarrow$ **$0.00 USD (Policy-Derived)**
  - Cart Total: $1,860.00 USD (Pre-Tax)
- **Cart 2: B&H Photo (`bhphotovideo.com`)**
  - Item 3: CalDigit TS4 USB-C Dock — $140.00 USD
  - Merchandise Subtotal: $140.00 USD
  - Shipping Policy: B&H Standard Shipping ($49.00 threshold)
  - Policy Evaluation: $140.00 $\ge$ $49.00 $\rightarrow$ **$0.00 USD (Policy-Derived)**
  - Cart Total: $140.00 USD (Pre-Tax)
- **Combined Total Landed Cost:** **$2,000.00 USD (Pre-Tax)**
- **Evidence Audit & Defensibility:**
  - B&H offers the USB-C dock at $140.00 ($10.00 cheaper than Best Buy's $150.00).
  - Both carts qualify for free ground shipping under published merchant policies ($1,860 $\ge$ $35; $140 $\ge$ $49).
  - The $10.00 difference is verified: Best Buy ($1,460 + $400 + $150 = $2,010) vs Split ($1,460 + $400 + $140 = $2,000).
  - Shipping charges are explicitly tagged as `POLICY-DERIVED`, acknowledging that carrier rates are not real-time retailer quotes.
  - Taxes and delivery surcharges are disclosed as excluded pre-tax estimates calculated at final merchant checkout.

#### Strategy 2: Consolidated Single Retailer ($2,010.00 USD)
- **Cart 1: Best Buy (`bestbuy.com`)**
  - Item 1: Dell XPS 15 (32GB RAM) — $1,460.00 USD
  - Item 2: Dell UltraSharp 27 4K Monitor — $400.00 USD
  - Item 3: CalDigit TS4 USB-C Dock — $150.00 USD
  - Merchandise Subtotal: $2,010.00 USD
  - Shipping Policy: Best Buy Ground ($35.00 threshold)
  - Policy Evaluation: $2,010.00 $\ge$ $35.00 $\rightarrow$ **$0.00 USD (Policy-Derived)**
  - Cart Total: $2,010.00 USD (1 shipment, Pre-Tax)
- **Combined Total Landed Cost:** **$2,010.00 USD (Pre-Tax)**
- **Evidence Audit & Defensibility:**
  - Eliminates multi-package coordination risk by consolidating all items into a single merchant cart and single delivery package for a modest $10.00 price difference.

---

### 7.2. Visual Evidence Catalog (16 Portable Repository Captures)

All captures are stored under portable, repository-relative paths in `docs/evidence/screenshots/`:

| Screenshot Identifier | Relative Repository Path | Viewport | Verified State |
| :--- | :--- | :--- | :--- |
| `01_home_desktop.png` | `docs/evidence/screenshots/01_home_desktop.png` | 1280x900 | Landing page showing authenticated actor (`usr_buyer_1`), active purchases, and **"Load Judge Demo Fixture"** control. |
| `01_home_mobile.png` | `docs/evidence/screenshots/01_home_mobile.png` | 375x812 | Mobile responsive card stack and streamlined header. |
| `02_line_items_desktop.png` | `docs/evidence/screenshots/02_line_items_desktop.png` | 1280x950 | Buyer Line Items tab displaying specifications, budgets ($1,500 / $400 / $160), and verification levels. |
| `02_line_items_mobile.png` | `docs/evidence/screenshots/02_line_items_mobile.png` | 375x812 | Mobile horizontal scrolling line items table. |
| `03_strategies_comparison_desktop.png` | `docs/evidence/screenshots/03_strategies_comparison_desktop.png` | 1280x1000 | Strategy comparison grid displaying 3 strategies with `FEASIBLE` vs `UNCERTAIN` chips, Pre-Tax Landed totals, and policy disclosures. |
| `03_strategies_comparison_mobile.png` | `docs/evidence/screenshots/03_strategies_comparison_mobile.png` | 375x812 | Mobile stacked strategy cards with pre-tax summaries. |
| `04_retailer_carts_desktop.png` | `docs/evidence/screenshots/04_retailer_carts_desktop.png` | 1280x1000 | Retailer Carts tab showing dynamic free shipping threshold progress bars ($1,860/35 Best Buy, $140/49 B&H). |
| `04_retailer_carts_mobile.png` | `docs/evidence/screenshots/04_retailer_carts_mobile.png` | 375x812 | Mobile cards for individual merchant cart breakdowns. |
| `05_split_shipments_desktop.png` | `docs/evidence/screenshots/05_split_shipments_desktop.png` | 1280x1000 | Split Shipments tab showing carrier routing, contiguous US zone eligibility, and delivery estimates. |
| `05_split_shipments_mobile.png` | `docs/evidence/screenshots/05_split_shipments_mobile.png` | 375x812 | Mobile shipment cards with `POLICY-DERIVED` chips. |
| `06_approved_locked_desktop.png` | `docs/evidence/screenshots/06_approved_locked_desktop.png` | 1280x1000 | Approved purchase state (`pur_1793282867200_lzmy27od`), status `APPROVED`, locked cryptographic snapshot hash `fd642118a13ec2ad4019e7b90479766fb3070db392806013bad8dbb8b1b949d6`. |
| `06_approved_locked_mobile.png` | `docs/evidence/screenshots/06_approved_locked_mobile.png` | 375x812 | Mobile approved status header and locked summary. |
| `07_invalidation_warning_desktop.png` | `docs/evidence/screenshots/07_invalidation_warning_desktop.png` | 1280x1000 | Red stale-approval warning banner triggered by material destination change to Alaska (`99501`). |
| `07_invalidation_warning_mobile.png` | `docs/evidence/screenshots/07_invalidation_warning_mobile.png` | 375x812 | Mobile rendering of destination invalidation alert banner. |
| `08_paypal_boundary_desktop.png` | `docs/evidence/screenshots/08_paypal_boundary_desktop.png` | 1280x1000 | PayPal Checkout Boundary: Displays non-capture notice, requested intent `AUTHORIZE`, and merchant domain isolation controls. |
| `08_paypal_boundary_mobile.png` | `docs/evidence/screenshots/08_paypal_boundary_mobile.png` | 375x812 | Mobile view of PayPal payment boundary and compliance disclaimer. |

---

### 7.3. Rigorous Evidence Separation

To maintain strict auditability, behavior is categorized into four distinct evidence classes:

1. **Directly Exercised in Headless Browser:**
   - Navigated landing page at `/` as `usr_buyer_1`.
   - Created rehearsal purchase `pur_1793282867200_lzmy27od` with 3 line items.
   - Evaluated 3 procurement strategies against the deterministic candidate pool.
   - Verified tabbed navigation: Buyer Line Items, Strategy Comparison, Retailer Carts, Split Shipments.
   - Inspected merchant policy shipping threshold progress indicators ($1,860/35 Best Buy, $140/49 B&H).
   - Approved strategy `strat_lowest_landed_cost` ($2,000.00 USD pre-tax).
   - Confirmed purchase status transition to `APPROVED` and locked snapshot hash rendering.
   - Verified access control denial message (`[forbidden]`) when unauthorized users attempt to read other buyers' purchases.
   - Simulated destination change to Alaska (`99501`), triggering immediate invalidation of contiguous US shipping rules and rendering the red warning banner.
   - Verified prominent non-capture PayPal payment notice.

2. **Verified via Automated Unit & Integration Tests:**
   - PayPal Orders API v2 wire contract and `intent: AUTHORIZE` persistence (`tests/workflow/phase17-payment-intent-audit.test.ts`).
   - PostgreSQL interactive transactions and optimistic concurrency control (`tests/workflow/postgres-integration.test.ts`).
   - Cart partitioning, split shipment dispatch, and defensible landed-cost ranking (`tests/discovery/cart/`).
   - Candidate normalization and schema validation (`tests/discovery/normalize.test.ts`, `tests/discovery/channel3-adapter.test.ts`).
   - Complete Vitest suite across 66 files (1,044 passing tests).

3. **Verified via Live Provider Smoke Tests:**
   - Live Gemini intent parser response structure and legacy model 404 detection (`tests/ai/live-smoke.test.ts`).
   - Live Channel3 search queries and adapter normalization (`tests/discovery/channel3-live.test.ts`).

4. **Explicitly Unverified / Out-of-Scope Behaviors:**
   - **Live Fund Capture:** Never executed; captures remain strictly zero across the entire database.
   - **Real PayPal Order Creation During Rehearsal:** Mocked/intercepted at the boundary; no live PayPal API orders were created.
   - **Third-Party Real-Time Carrier Quoting:** Threshold evaluations rely on merchant policy tables, not live FedEx/UPS carrier APIs.

---

## 8. Limitations & Scope Boundaries

1. **Synthetic Demo Fixtures:** Demo candidate products are labeled `[DEMO FIXTURE]` and seeded deterministically in demo scenarios to guarantee predictable policy threshold evaluation during walkthroughs without relying on third-party merchant scraping availability.
2. **Multi-Cart PayPal Boundary:** PayPal Orders API v2 does not support single-order multi-merchant captures. For split strategies (e.g. Best Buy + B&H), Plinthly evaluates and authorizes carts per merchant domain rather than combining distinct merchants into an illegal multi-seller basket. Mixed-merchant orders are rejected at the checkout boundary with `HTTP 400 (invalid_input)`.
3. **Protected Historical Orders:** Protected purchases `pur_1792633876502_s7jvwi22` and `pur_1792654701712_f2iks5to` remain permanently locked in `BUYER_APPROVED` status with zero fund captures. Legacy order `2BR08855VR6881230` remains isolated with unrecorded requested intent.
4. **Deferred Capture Requirement:** Plinthly strictly enforces authorization-only order creation. Fund capture is deferred until verified physical fulfillment. At no point in rehearsal or test runs were any funds captured.

---

## 9. Final Verification Commands & Status Matrix

### 9.1. Sequential Execution Results Against Final Working Tree

| Command | Exit Code | Pass / Fail Summary | Details |
| :--- | :---: | :--- | :--- |
| `npx vitest run` | **0** | **66/66 files passed**, **1,044/1,044 tests passed** | Duration: 21.92s. Zero failures. Includes live Gemini and Channel3 smoke tests. |
| `npx tsc --noEmit` | **0** | **0 errors** | Clean TypeScript compilation across entire project. |
| `npm run lint` | **0** | **0 errors, 0 warnings** | ESLint passed cleanly with no rule violations. |
| Invariant Verification Script | **0** | **Gate 1: MATCH**, **P1/P2: INTACT**, **Captures: 0** | Verified via direct read-only query against PostgreSQL. |

### 9.2. Comprehensive Readiness & Check Matrix

| Check / Requirement | Status | Notes |
| :--- | :---: | :--- |
| Gate 1 Script SHA-256 (`F0449D22...`) | **PASS** | Byte-for-byte identical; hash confirmed via crypto SHA-256. |
| Protected Purchase 1 (`pur_1792633876502_s7jvwi22`) | **PASS** | Status `BUYER_APPROVED`, version 6, 1 payment attempt. |
| Protected Purchase 2 (`pur_1792654701712_f2iks5to`) | **PASS** | Status `BUYER_APPROVED`, version 5, 1 payment attempt. |
| Total Completed Captures Across Database | **PASS** | Strictly 0 completed or captured payment records. |
| New Remote PayPal Orders Created | **PASS** | 0 new PayPal orders created during this pass. |
| Secret Leakage Prevention | **PASS** | No API keys, credentials, or secrets present in code, logs, or screenshots. |
| Candidate Provenance & Evidence Visibility | **PASS** | Badges clearly distinguish `RETAILER QUOTED`, `POLICY-DERIVED`, and `UNQUOTED`. |
| Consolidated ($2,010) vs Split ($2,000) Reconciliation | **PASS** | Mathematical and threshold derivation confirmed line-by-line. |
| Pre-Tax & Excluded Cost Disclosures | **PASS** | Landed costs clearly labeled pre-tax with checkout tax disclosure footnote. |
| Cryptographic Snapshot Binding & Invalidation | **PASS** | Verified hash binding on approval; Alaska destination invalidates snapshot. |
| Multi-Merchant Isolation at Checkout Boundary | **PASS** | Fraudulent / mixed-merchant checkout rejected prior to PayPal API call. |
| Desktop (1280px) & Mobile (375px) Usability | **PASS** | Verified via 16 full-resolution screenshots stored in `docs/evidence/screenshots/`. |
| Full Test Suite (`vitest`, `tsc`, `lint`) | **PASS** | All commands exited with code 0. |

**OVERALL SYSTEM READINESS: PASS — ALL MANDATORY CHECKS FULLY SATISFIED**



