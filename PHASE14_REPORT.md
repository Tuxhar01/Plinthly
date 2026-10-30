# PLINTHLY — PHASE 14: Live Retailer Evidence and Destination-Aware Procurement Report

**Date:** 2026-10-29  
**Status:** COMPLETE & PASSING  
**Test Suite:** 58 test files, 913 tests passing (0 failing)  
**Type Check:** TypeScript `tsc --noEmit` clean (0 errors)  
**Lint:** ESLint clean (0 errors, 0 warnings)  

---

## 1. Executive Summary & Invariant Verification

Phase 14 transitions Plinthly from adversarial policy auditing to a trustworthy, end-to-end procurement product. It grounds buyer purchase requests in real retailer discovery, deterministic shipping quote / policy evaluation, honest landed-cost sorting, specification provenance tracking, and strict pre-order execution safety.

### Invariant Verification Results

1. **Gate 1 SHA-256 Integrity:**
   - Expected: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
   - Observed (Node.js cryptographic digest of `C:\paypal-gate1\gate1.mjs`):  
     `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
   - Status: **VERIFIED UNCHANGED**

2. **Protected Purchase Records (Read-Only PostgreSQL Verification via `scratch/check-purchases.js`):**
   - Record 1: `pur_1792633876502_s7jvwi22`
     - Status: `BUYER_APPROVED`
     - Version: `6`
     - Payment Attempt: `pay_att_1792642078698_cio3e660` (Gateway Order: `2JW38959VY1221001`, Status: `OPEN`, Verified: `APPROVED`)
     - Captures: `0`
   - Record 2: `pur_1792654701712_f2iks5to`
     - Status: `BUYER_APPROVED`
     - Version: `5`
     - Payment Attempt: `pay_att_1792654816903_rdndyocu` (Gateway Order: `6TN25543HL618580V`, Status: `OPEN`, Verified: `APPROVED`)
     - Captures: `0`
   - Status: **VERIFIED UNTOUCHED** (Total CAPTURED payments across entire database = `0`)

3. **Remote Payment Safeguards:**
   - Zero live PayPal orders created during Phase 14 implementation or testing.
   - Zero live payment captures attempted or executed.
   - All journey tests executed against isolated test environments with verified mocks.

---

## 2. Core Implemented Capabilities

### A. Natural Language Intent Decomposition & Destination Extraction
- **Files:** `lib/ai/types.ts`, `lib/ai/intent-parser.ts`, `components/workflow/purchase-request-card.tsx`
- **Capability:**
  - Extended Gemini intent parser schema and instructions to extract buyer delivery destination (`destination: { country: "US", postalCode: string }`) alongside budget, constraints, and quantity.
  - LLM strictly extracts factual requirements and ambiguities; it never decides policy compliance, approval, or vendor preference.
  - Added manual and AI-draft destination input to `PurchaseRequestCard`, preserving user control and auto-populating validated 5-digit US ZIP codes into purchase creation requests.

### B. Destination-Aware Channel3 Discovery & Auto-Enrichment
- **Files:** `app/api/purchases/[id]/discover/route.ts`, `lib/discovery/channel3-adapter.ts`, `lib/discovery/types.ts`, `lib/discovery/normalize.ts`
- **Capability:**
  - `POST /api/purchases/[id]/discover` automatically enriches discovery requests with the purchase's stored delivery destination, quantity, budget, and requirements if omitted in the caller request body.
  - Candidate normalization preserves retailer identity, seller name, direct-retailer flag, marketplace status, fulfillment method, and raw observation provenance.
  - Offers with missing shipping costs are clearly tagged as incomplete rather than defaulted to zero.

### C. Honest Landed-Cost Sorting & Comparison Studio
- **Files:** `components/workflow/candidate-comparison-grid.tsx`, `components/workflow/candidate-evaluation-card.tsx`
- **Capability:**
  - **Honest Landed-Cost Comparator:** AG Grid column comparator sorts `null` landed costs strictly after all verified numeric totals, ensuring candidates with unverified shipping can never be sorted as cheaper than verified totals.
  - **Shipping Evidence Classification:** Candidates display clear status badges:
    - `quoted`: dynamic rate from verified quote adapter with provider timestamp.
    - `free_threshold`: deterministic evaluation against official retailer policy threshold.
    - `synthetic`: simulated rate clearly tagged as unverified test data.
    - `missing`: shipping unspecified; landed cost displayed as `Unknown (shipping missing)`.
  - **Specification Proof Column:** Differentiates verified structured facts (e.g. `RAM: 16GB [verified]`), inferred heuristics (`[inferred]`), and missing requirements (`[missing]`).
  - **Blocker Reason & Action Guidance:** Identifies candidates failing policies with clear remediation actions (e.g., *"Select a direct retailer offer or add $5.01 to cart to reach the $35.00 threshold"*).
  - **Interactive Evidence Drilldown Inspector:** Clicking any row reveals a comprehensive inspection drawer showing candidate provenance, observation timestamps, shipping evidence breakdown, and policy verdict details.

### D. PayPal Sandbox Safety & Pre-Order Guardrails
- **Files:** `lib/workflow/service.ts`, `tests/workflow/phase14-procurement-journey.test.ts`
- **Capability:**
  - Prior to initiating order creation with PayPal, `createPayPalOrder` independently revalidates:
    1. Active, non-invalidated buyer approval record.
    2. Candidate snapshot integrity and un-tampered database fields.
    3. Destination postal code consistency between request options, candidate quote, and merchant zone eligibility.
    4. Shipping quote expiration timestamps.
    5. Landed cost compliance within the approved purchase budget.
  - If any precondition fails, the system fails closed with `ApprovalIntegrityError` without calling external payment APIs.

### E. Durable Policy Storage & Safe Fallback Hardening
- **Files:** `lib/discovery/policy-persistence.ts`
- **Capability:**
  - Hardened `DurablePolicyStore.loadState()` against file corruption or malformed JSON.
  - Corrupted files are immediately quarantined (`<path>.corrupt.<timestamp>`) and logged.
  - Safely falls back to `DEFAULT_MERCHANT_POLICIES` without crashing or serving stale unverified policies.

---

## 3. End-to-End Verification Matrix (`phase14-procurement-journey.test.ts`)

The complete procurement journey was verified across 10 deterministic tests:

| Test ID | Scenario | Verification Result |
| :--- | :--- | :--- |
| **1** | Normalization preserves retailer, seller, and fulfillment while flagging missing shipping | **PASS** — `isComplete=false`, `shippingCents=null`, `totalCents=null`, seller identity preserved |
| **2** | Rejects product variant or seller mismatches between quote and candidate | **PASS** — Adapter confirms quote applicability only for matching merchant & variant |
| **3** | Distinguishes observation timestamp from provider source-verification timestamp | **PASS** — Candidate without quote sets `isAuthoritative=false`; policy candidate sets authoritative timestamp |
| **4** | Distinguishes dynamic quotes from policy-derived evidence and never conflates them | **PASS** — Carrier adapter sets `type: "quoted"`; policy engine sets `type: "policy_derived"` with explanation |
| **5** | Honest landed-cost ranking: unknown shipping is never ranked cheaper than verified totals | **PASS** — `$140 + $10 = $150` ranks #1, `$200 + $0 = $200` ranks #2, `$80 + unknown = null` ranks last |
| **6** | Fails closed when order destination postal code mismatches candidate quote destination | **PASS** — Throws `ApprovalIntegrityError("destination_changed")`; 0 calls to PayPal |
| **7** | Invalidates approval and blocks payment if candidate unit price or variant changes | **PASS** — Database tampering triggers `ApprovalIntegrityError("snapshot_hash_changed")`; 0 calls to PayPal |
| **8** | Generates explicit blocker reasons and resolution actions for incomplete candidates | **PASS** — Incomplete candidate outputs actionable blocker guidance |
| **9** | PayPal Sandbox client receives zero calls when candidate lacks authoritative shipping | **PASS** — Unapproved candidate rejected; 0 calls to PayPal client |
| **10** | Persistence failures quarantine corrupted files and fall back safely to default policies | **PASS** — Corrupt file moved to `.corrupt.<ts>`; default policies retained |

---

## 4. Test Suite & Quality Assurance Baseline

- **Vitest Run:**
  - Total test files: **58**
  - Total tests: **913 passed**, 0 failed
  - Execution duration: ~11.66s
- **TypeScript (`tsc --noEmit`):**
  - Exit code: **0** (0 errors)
- **ESLint (`npm run lint`):**
  - Exit code: **0** (0 errors, 0 warnings)

---

## 5. Summary of Modified & Created Files

| File | Change Nature | Key Enhancements |
| :--- | :--- | :--- |
| `lib/ai/types.ts` | Schema Extension | Added `decomposedDestinationSchema` and optional `destination` field to decomposed intent. |
| `lib/ai/intent-parser.ts` | Extraction Logic | Added destination extraction to Gemini schema and instructions; records missing destination in ambiguities. |
| `components/workflow/purchase-request-card.tsx` | UI Enhancement | Added destination input field, AI draft auto-population, client validation, and payload submission. |
| `lib/discovery/types.ts` | Type Definition | Added seller, marketplace, fulfillment, and blocker reason / resolution fields to `NormalizedProductCandidate`. |
| `lib/discovery/normalize.ts` | Candidate Normalization | Populated seller provenance, marketplace status, fulfillment metadata, and actionable blocker reasons. |
| `lib/discovery/channel3-adapter.ts` | Adapter Enrichment | Extracted candidate seller and marketplace provenance regardless of destination presence. |
| `app/api/purchases/[id]/discover/route.ts` | API Route | Enriched discovery requests with stored purchase destination, budget, quantity, and requirements. |
| `components/workflow/candidate-comparison-grid.tsx` | AG Grid Studio | Added honest landed-cost comparator, shipping badges, specification proof column, and drilldown panel. |
| `components/workflow/candidate-evaluation-card.tsx` | UI Provenance | Passed complete candidate shipping evidence and observations to evaluation API. |
| `lib/discovery/policy-persistence.ts` | Storage Hardening | Implemented corrupted file quarantine and safe default policy fallback. |
| `tests/workflow/phase14-procurement-journey.test.ts` | Integration Suite | 10 comprehensive tests verifying the complete procurement journey and execution safety. |
| `PHASE14_REPORT.md` | Verification Report | Authoritative documentation of Phase 14 architecture, invariants, and test results. |

---

## 6. Product Status & Next Milestone

Plinthly now possesses a complete, defensive, and user-facing procurement journey:
- Buyers articulate requests with delivery destinations.
- The system discovers real retailer candidates and performs deterministic shipping policy / quote evaluation.
- The comparison studio enforces honest landed costs (pushing missing shipping to the bottom with clear resolution guidance).
- Approvals capture verified snapshot hashes and evidence fingerprints.
- PayPal Sandbox order execution strictly validates all terms before initiating transactions.

**Recommended Next Milestone: Phase 15 — Multi-Item Cart Policy Aggregation & Checkout Simulation**.
Move beyond single-candidate purchasing to support multi-line carts, multi-retailer order grouping, minimum cart threshold satisfaction across multiple items, and automated end-to-end sandbox checkout verification.

