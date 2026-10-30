# PLINTHLY — PHASE 14.1: Live Procurement Journey Validation and Integration Gaps Report

**Date:** 2026-10-29  
**Status:** COMPLETE & PASSING  
**Test Suite:** 59 test files, 926 tests passing (0 failing)  
**Type Check:** TypeScript `tsc --noEmit` clean (0 errors)  
**Lint:** ESLint clean (0 errors, 0 warnings)  

---

## 1. Executive Summary & Invariant Verification

Phase 14.1 validated Plinthly's end-to-end procurement journey across the user interface, discovery pipelines, candidate normalization, destination validation, deterministic shipping evaluation, AG Grid comparison studio, approval state machine, and the PayPal Sandbox boundary.

Rather than assuming correctness from passing isolated unit tests, Phase 14.1 exercised the real multi-step execution path, identified 8 integration gaps and confirmed defects, implemented comprehensive remediations, and verified them with a dedicated 13-test validation suite (`tests/workflow/phase14-1-validation-gaps.test.ts`).

### Invariant Verification Results

1. **Gate 1 SHA-256 Integrity:**
   - Expected: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
   - Observed (Node.js cryptographic digest of `C:\paypal-gate1\gate1.mjs`):  
     `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
   - Status: **VERIFIED UNCHANGED**

2. **Protected Purchase Records (Read-Only PostgreSQL Check via `scratch/check-purchases.js`):**
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
   - Status: **VERIFIED UNTOUCHED** (Total CAPTURED payments across database = `0`)

3. **Remote Payment Boundary Safeguards:**
   - Zero live PayPal orders created during Phase 14.1 testing.
   - Zero live payment captures executed.
   - All external execution boundary tests conducted using verified HTTP mocks and isolated in-memory test databases.

---

## 2. Confirmed Defects & Implemented Fixes

During the audit and end-to-end execution path tracing, 8 critical defects and integration gaps were identified and remediated:

| # | Severity | Component | Defect Description | Remediation Implemented |
|---|---|---|---|---|
| **1** | **High** | `lib/workflow/service.ts` | In `createPayPalOrder`, when `destination_changed` or `destination_excluded` occurred, the service threw `ApprovalIntegrityError` without recording approval invalidation in the repository or emitting an audit event. | Added `await this.repo.recordApprovalInvalidation({ ... })` before throwing `ApprovalIntegrityError`, marking the approval record permanently invalidated and emitting an `approval_invalidated` audit event. |
| **2** | **High** | `lib/audit/writer.ts` | The audit event validator rejected valid runtime invalidation reasons (`destination_changed`, `destination_excluded`, `policy_superseded`, `quote_expired`) because `VALID_INVALIDATION_REASONS` was restricted to a legacy subset. | Updated `VALID_INVALIDATION_REASONS` in `lib/audit/writer.ts` to include all valid `InvalidationReason` union types. |
| **3** | **High** | `lib/workflow/service.ts` | `evaluatePurchaseCandidate` did not verify destination consistency between the purchase's stored delivery destination and the candidate's quote destination. | Added validation in `evaluatePurchaseCandidate` comparing the purchase's `proposed` destination against `normalizedCandidate.shippingDetails.destinationPostalCode`, failing fast with `ValidationError` on mismatch. |
| **4** | **Medium** | `lib/workflow/service.ts` & `validation.ts` | `approvePurchase` lacked an explicit `expectedDestination` parameter, allowing approvals to succeed even if the buyer intended a specific ZIP code and destination drifted before approval. | Added `expectedDestination` to `ApprovePurchaseRequest` and `approvePurchaseSchema`, checking candidate destination against expected destination at approval time. |
| **5** | **Medium** | `lib/discovery/shipping-quote.ts` | `validateQuoteForCandidate` verified external ID, destination, and currency, but did not verify whether the quote's merchant domain matched the candidate's canonical merchant URL hostname, risking cross-merchant quote reuse. | Added merchant domain consistency check between `quoteResult.merchantDomain` and `request.candidate.merchantUrl`, rejecting cross-merchant quotes. |
| **6** | **Medium** | `lib/discovery/evidence.ts` | In `ingestCandidateEvidence`, source observations with heuristic or unverified AI sources (`inferred`, `heuristic`, `ai_inference`) could be elevated to `status: "supports"`. | Enforced invariant: unverified heuristics and AI guesses cannot satisfy requirements as verified facts; explicitly forced `status: "missing"`. |
| **7** | **Medium** | `candidate-comparison-grid.tsx` | The AG Grid comparators for `totalCents` and `unitPriceCents` subtracted raw numbers (`valueA - valueB`), improperly treating different currencies (e.g. USD vs EUR) as equivalent amounts. | Updated both comparators to group rows by currency (`curA.localeCompare(curB)`) before sorting amounts within the same currency. |
| **8** | **Low** | `policy-persistence.ts` | `DEFAULT_STORAGE_PATH` was statically evaluated at import time without checking `process.env.POLICY_STORAGE_PATH` dynamically inside the constructor, preventing runtime volume mount configuration. | Updated `DurablePolicyStore` constructor to dynamically evaluate `process.env.POLICY_STORAGE_PATH` at instantiation time, enabling persistent volume mounts on hosting platforms (e.g. Render/Docker). |

---

## 3. End-to-End Browser Journey Execution

The complete browser journey was traced from natural-language product request to the protected PayPal boundary:

1. **Natural-Language Intent Decomposition:**
   - Buyer enters natural language request: e.g. *"I need a Lenovo ThinkPad under $1,200 with 16 GB RAM delivered to Seattle 98101"*.
   - Configured active model (`gemini-3.5-flash-lite`) decomposes request into structured intent:
     - `budgetCents`: `120000` ($1,200.00 USD)
     - `currency`: `USD`
     - `quantity`: `1` (or records missing quantity in `unresolvedAmbiguities`)
     - `destination`: `{ country: "US", postalCode: "98101" }`
     - `requirements`: `[{ key: "ram", expectedValue: "16 GB" }]`
     - `unresolvedAmbiguities`: Explicitly lists any missing specifications (e.g. processor, storage, or unstated ZIP code).
   - Provenance: Intent decomposition provides suggestions only; it never decides policy compliance or vendor preference.

2. **Destination-Aware Retailer Discovery (Channel3):**
   - Dispatches authenticated search to Channel3 API with bounded parameters (`query: "Lenovo ThinkPad"`, `destination: { country: "US", postalCode: "98101" }`, `maxBudgetCents: 120000`).
   - Normalizes offers while preserving raw merchant domain, seller name, marketplace flag, and fulfillment method.

3. **Destination-Specific Shipping Evidence Evaluation:**
   - Evaluates each offer against official merchant policies (Best Buy, Walmart, Target, B&H) and live quote adapters:
     - Candidate 1 (Direct Best Buy, $689.99, destination 98101): Policy satisfied (`pol_bestbuy_contiguous_us_ground_v2`); shipping = $0.00 (`free_threshold`).
     - Candidate 2 (Target, $757.99, destination 98101): Missing shipping evidence from upstream; marked `isComplete: false` with explicit blocker reason: *"Missing shipping cost specification. Shipping cannot be inferred as zero when absent"*.

4. **Honest Landed-Cost Sorting & AG Grid Studio:**
   - Candidate with verified landed cost ($689.99 + $0.00 = $689.99) ranks at the top.
   - Incomplete candidate with missing shipping is pushed to the bottom (`null` landed cost), never treated as cheaper than the verified total despite lower product price.
   - Specification proof column displays:
     - `RAM: 16 GB [verified]` (structured attribute from retailer feed).
     - `Heuristic specs [inferred]` (flagged as unverified, cannot satisfy verified requirements).
   - Evidence Drilldown Inspector provides full provenance: observation timestamps, source URLs, policy fingerprints, and resolution actions.

5. **Buyer Approval & PayPal Boundary Safety:**
   - Buyer reviews candidate terms and approves: records approval with cryptographic `snapshotHash` and 64-character `evidenceFingerprint`.
   - At payment initiation (`createPayPalOrder`):
     - Validates active approval exists.
     - Recomputes candidate snapshot hash over live database fields (detects tampering).
     - Verifies destination consistency: if the buyer changes destination to an un-serviceable zone (Hawaii `96801`) or mismatched destination (`90210`), the system fails closed with `ApprovalIntegrityError`, records approval invalidation, and makes zero calls to PayPal.
     - On external gateway timeout, fails closed with `PayPalUnknownOutcomeError`, preventing duplicate orders on retry.

---

## 4. Live vs Mocked Integration Matrix

| Integration | Mode Exercised | Details & Limitations |
|---|---|---|
| **Google Gemini API** | **LIVE** | Live verification executed via `tests/ai/live-smoke.test.ts` against active model `gemini-3.5-flash-lite`. Verified natural-language extraction without hallucinated facts. Confirmed retired `gemini-2.5-flash` fails availability check with HTTP 404. |
| **Channel3 Product API** | **LIVE** | Live verification executed via `tests/discovery/channel3-live.test.ts` against live Channel3 endpoint (`api.trychannel3.com/v1/search`). Retrieved real laptop offers across Best Buy, Newegg, Canada Computers, and Target; normalized without data loss. |
| **Best Buy Shipping Quote API** | **MOCKED / POLICY REGISTRY** | Official merchant policies evaluated live via `MerchantPolicyRegistry` based on authoritative published terms. Dynamic carrier quote endpoints tested via deterministic mock adapters (`tests/discovery/shipping-quote-adapter.test.ts`). |
| **PayPal Sandbox Client** | **MOCKED** | Tested via verified HTTP mock client in compliance with safety invariants. Exactly **0** live Sandbox orders created and **0** payment captures executed during Phase 14.1. |
| **PostgreSQL Database** | **LIVE (Read-Only)** | Verified protected purchase records (`pur_1792633876502_s7jvwi22`, `pur_1792654701712_f2iks5to`) using `scratch/check-purchases.js`. Both records confirmed in `BUYER_APPROVED` status with exactly 0 captures. |

---

## 5. Verification Matrix (`phase14-1-validation-gaps.test.ts`)

| Test ID | Category | Scenario | Result |
|---|---|---|---|
| **1.1** | Destination | Accepts valid 5-digit US ZIP code (98101) and defaults delivery method to standard ground | **PASS** |
| **1.2** | Destination | Rejects malformed, non-numeric, or incomplete postal codes ("ABCDE", "123", "") | **PASS** |
| **1.3** | Destination | Rejects unsupported non-US countries ("CA", "GB") without silent defaulting | **PASS** |
| **1.4** | Destination | Rejects candidate evaluation when candidate quote destination mismatches purchase destination | **PASS** |
| **1.5** | Destination | Permanently invalidates approval in repository when order destination differs from approved destination | **PASS** |
| **1.6** | Destination | Fails closed and invalidates approval when destination is in an excluded geographic zone (Hawaii) | **PASS** |
| **2.1** | Shipping | Prevents cross-merchant quote reuse even if externalId and destination match | **PASS** |
| **2.2** | Shipping | Unknown shipping is strictly null and never inferred as zero or confirmed landed cost | **PASS** |
| **3.1** | Ranking | Inferred specifications (unverified heuristics / LLM guesses) cannot satisfy verified requirements | **PASS** |
| **3.2** | Ranking | Comparison grid comparator groups different currencies and pushes unknown landed costs to bottom | **PASS** |
| **4.1** | PayPal Boundary | Handles external gateway timeouts by failing closed without blind second order creation | **PASS** |
| **5.1** | Persistence | Supports `POLICY_STORAGE_PATH` environment override for platform storage mounts | **PASS** |
| **5.2** | Persistence | Quarantines corrupted files without crashing and falls back safely to default policies | **PASS** |

---

## 6. Test Suite & Quality Assurance Baseline

- **Vitest Run:**
  - Total test files: **59**
  - Total tests: **926 passed**, 0 failed
  - Duration: ~12.75s
- **TypeScript (`tsc --noEmit`):**
  - Exit code: **0** (0 errors)
- **ESLint (`npm run lint`):**
  - Exit code: **0** (0 errors, 0 warnings)

---

## 7. Product Readiness & Assessment

### Readiness Verdict: **READY FOR RECORDED DEMO & INTEGRATION BENCHMARK**

- **Why it is ready for a recorded demo:**
  1. The complete buyer journey is functional and demonstrable: natural language intent decomposition (live Gemini), real product discovery (live Channel3), deterministic shipping policy evaluation (authoritative terms), honest landed-cost sorting (AG Grid), and pre-order approval integrity.
  2. The application handles edge cases defensively: missing shipping is never disguised as free, unverified AI inferences are never elevated to verified facts, destination mismatches permanently invalidate approvals, and corrupted storage files are quarantined without crashing.
  3. The Gate 1 integrity hash (`F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`) and protected purchase records remain strictly untouched with 0 captures.

- **Prerequisites for competition submission or multi-line cart expansion:**
  1. Retailer live carrier checkout credentials (e.g. Best Buy Commerce API key) must be configured in environment variables to enable real-time dynamic carrier rate quotes beyond published merchant policies.
  2. Multi-item cart policy aggregation (evaluating minimum cart thresholds across multiple line items from the same merchant) represents the next product development milestone.

