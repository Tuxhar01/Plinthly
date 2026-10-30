# Plinthly Phase 13C — Merchant Policy Evidence Ingestion and Change Monitoring Report

**Date:** 2026-10-29  
**Execution Context:** Production Hardening & Autonomous Procurement Integrity  
**Status:** Complete & Verified  

---

## 1. Executive Summary

Phase 13C establishes an authoritative, deterministic merchant policy evidence ingestion and change monitoring subsystem for Plinthly. It solves the critical operational problem of tracking changes in official retailer shipping terms without compromising the deterministic guarantees required by autonomous procurement workflows.

Key achievements in Phase 13C:
1. **Preserved Policy Registry with Historical Versioning**: Retained complete version history (`getPolicyVersion`, `getPolicyHistory`, `publishPolicy`). Separated source retrieval, source-content hashing, policy extraction, policy validation, and publication.
2. **Safe Change Detection**: Implemented `PolicySourceFetcher` enforcing an HTTPS-only retailer allowlist, 10-second timeouts via `AbortController`, strict 2 MB response bounds, conditional HTTP requests (`If-None-Match`, `If-Modified-Since`, HTTP 304 detection), and safe redirect handling restricted to approved retailer hosts.
3. **Mandatory Human Review Gating**: Implemented `PolicyProposalEngine` to enforce that material terms changes (threshold changes, seller eligibility modifications, cart contribution alterations, membership requirements, zone changes) and ambiguous terms extractions are staged as `proposed` and **never** auto-published to live procurement decisions. Non-material changes (e.g., promotional banner/layout changes with identical canonical terms) update audit review timestamps without invalidating live decisions.
4. **Deterministic Multi-Item Cart Eligibility Engine**: Implemented `CartShippingEngine` enforcing clear boundaries between per-product evaluation and multi-item cart qualification. Disaggregates direct retailer and WFS items from independent 3rd-party marketplace offers. Enforces pre-tax merchandise calculations with cart-level discount deductions and strict exclusion of estimated sales tax.
5. **Procurement Workflow Invalidation Protection**: Integrated with the state machine to invalidate stale approval snapshots with typed reasons (`"policy_superseded"`, `"evidence_fingerprint_changed"`, `"policy_version_changed"`). Proves that policy ingestion never mutates purchase records, never creates PayPal orders, and never captures funds.

---

## 2. Ingestion & Architecture Design

### A. Separation of Responsibilities

```
                                      [Official Retailer HTTPS URL]
                                                    │
                                                    ▼
                                    ┌──────────────────────────────┐
                                    │    PolicySourceFetcher       │
                                    │  - Strict HTTPS allowlist    │
                                    │  - Max 2MB buffer bounding   │
                                    │  - Timeout (AbortController) │
                                    │  - 304 Not Modified handler  │
                                    │  - SHA-256 rawContentHash    │
                                    └──────────────┬───────────────┘
                                                   │ PolicySourceRecord
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │       PolicyExtractor        │
                                    │  - Retailer-specific parser  │
                                    │  - Ambiguity detector       │
                                    │  - Typed warnings & terms    │
                                    └──────────────┬───────────────┘
                                                   │ PolicyExtractionResult
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │    PolicyProposalEngine      │
                                    │  - Canonical equality check  │
                                    │  - Material change staging   │
                                    │  - Human approval workflow   │
                                    └──────────────┬───────────────┘
                                                   │
                 ┌─────────────────────────────────┴─────────────────────────────────┐
                 │                                                                   │
       [Material Change / Ambiguity]                                   [Identical Terms / 304]
                 │                                                                   │
                 ▼                                                                   ▼
       Status: "proposed"                                                 Status: "active"
       (Awaits Human Reviewer)                                            (Audit Timestamp Updated)
                 │
       [Human Reviewer Approves]
                 │
                 ▼
       Status: "validated"
                 │
                 ▼
       [MerchantPolicyRegistry.publishPolicy]
         ├── Sets New Version as Active
         ├── Marks Prior Version as "superseded" in History
         └── Triggers Stale Approval Invalidation ("policy_superseded")
```

### B. Core Source Files Created / Modified

| File | Type | Description |
|---|---|---|
| `lib/discovery/policy-ingestion/types.ts` | Source | Typed data contracts: `PolicySourceRecord`, `PolicyChangeType`, `PolicyPublicationStatus`, `ExtractedPolicyTerms`, `PolicyExtractionResult`, `PolicyChangeProposal`, `CartShippingContext`, `CartShippingEvaluationResult`. |
| `lib/discovery/policy-ingestion/fetcher.ts` | Source | Allowlisted HTTPS fetcher with bounded sizes (2MB), timeouts, conditional headers (304), redirect validation, and raw content SHA-256 hashing. |
| `lib/discovery/policy-ingestion/extractor.ts` | Source | Specialized extractors for Best Buy, Walmart, Target, and B&H with deterministic ambiguity detection. |
| `lib/discovery/policy-ingestion/proposal-engine.ts` | Source | Compares canonical terms against active policies; classifies changes; stages material changes as `proposed`; provides `approveProposal` and `rejectProposal`. |
| `lib/discovery/policy-ingestion/cart-engine.ts` | Source | Multi-item cart shipping engine evaluating qualifying merchandise pre-tax, cart discounts, marketplace disaggregation, and destination zones. |
| `lib/discovery/policy-ingestion/index.ts` | Source | Unified public exports for policy ingestion subsystem. |
| `lib/discovery/merchant-policy-registry.ts` | Source (Updated) | Added version history retention (`getPolicyVersion`, `getPolicyHistory`, `publishPolicy`, `isPolicyActive`, `isFingerprintActive`). |
| `lib/state/types.ts` & `lib/state/approval.ts` | Source (Updated) | Added `"policy_superseded"` invalidation reason and integrated with `deriveInvalidationReasons`. |
| `tests/discovery/phase13c-policy-ingestion.test.ts` | Test | 26 comprehensive automated regression tests covering all 5 pillars of Phase 13C. |

---

## 3. Retailer Ingestion & Policy Evidence Coverage

| Retailer | Authoritative Policy URL | Canonical Business Terms Extracted | Ambiguity / Failure Handling |
|---|---|---|---|
| **Best Buy** | `https://www.bestbuy.com/site/help-topics/shipping-delivery-and-store-pickup/pcmcat1504113264003.c` | Standard ground $35.00 threshold; contiguous US only; excludes 3rd-party marketplace sellers, scheduled in-home delivery, major appliances, freight. | Conflicting thresholds on page (e.g. $35 vs $50) flagged as `status: "ambiguous"`. Non-HTTPS or non-allowlisted URLs rejected. |
| **Walmart** | `https://www.walmart.com/help/article/shipping-rates-and-delivery/4113264426aa41aa9d00da81691a5e1e` | Standard ground $35.00 threshold; contiguous US only; candidate must be fulfilled by Walmart or WFS; eligible marketplace items contribute to threshold; autonomous agents do not assume Walmart+. | Independent seller items without WFS excluded from Walmart free shipping. Conflicting thresholds flagged ambiguous. |
| **Target** | `https://help.target.com/help/subcategoryarticle?childcat=Free+shipping` | Standard ground $35.00 threshold of qualifying merchandise after discounts and pre-tax; covers 48 continental states + APO/FPO; excludes AK, HI, protectorates, and Target Plus items. Circle Card policy: $0 min, all 50 states + APO/FPO. | Distinct variants for Standard ($35) vs Circle Card ($0). Alaska/Hawaii excluded from standard promotion. |
| **B&H Photo Video** | `https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp` | Expedited shipping (1-2 Day) on orders $\ge$ $49.00 in contiguous US. Standard ground shipping: item-specific qualification required (no universal $49 order minimum). Excludes freight, drop ship, oversized. | Expedited policy separated from standard ground. Lack of verified item badge triggers `unconfirmed_qualification`. |

---

## 4. Multi-Item Cart Eligibility Engine Boundaries

The `CartShippingEngine` strictly enforces the boundary between single-candidate discovery and multi-item cart fulfillment:
1. **No Implicit Cart Assumption**: A single product candidate priced at $25 cannot assume it is part of a larger order; it fails with `threshold_not_met` unless multi-item cart evidence is explicitly supplied via `CartShippingContext`.
2. **Pre-Tax Merchandise Total**:
   - Qualifying merchandise = $\sum (\text{unitPriceCents} \times \text{quantity})$.
   - Pre-tax discounts (`cartLevelDiscountsCents`) are subtracted from the subtotal before threshold comparison.
   - Example verified by test: Cart items totaling $40.00 with a $10.00 pre-tax coupon yield net qualifying merchandise of $30.00, failing the $35.00 threshold.
3. **Strict Tax Exclusion**:
   - Estimated tax (`estimatedTaxCents`) is strictly excluded from qualifying calculations.
   - Example verified by test: Cart items totaling $32.00 with $4.00 tax ($36.00 total) fail the $35.00 threshold because tax never counts toward free shipping qualification.
4. **Fulfillment Disaggregation**:
   - For Walmart: Direct Walmart and WFS items qualify for free shipping once the $35.00 cart threshold is reached. Independent 3rd-party marketplace items contribute to reaching the $35.00 minimum, but the marketplace items themselves receive `marketplace_seller_excluded` and require seller-specific shipping quotes.
5. **Geographic Exclusions & Serviceability**:
   - Evaluates `checkGeographicEligibility` with `allowedZones` and `excludedZones`.
   - Contiguous US destinations (e.g. 10001, 94103, 60601, 77001) qualify.
   - Military APO/FPO destinations (e.g. 09012) qualify under Target's standard policy.
   - Non-contiguous destinations (e.g. Anchorage, AK 99501) are excluded under Target's standard policy, but qualify under Target Circle Card.

---

## 5. Verification Commands, Exit Codes, and Test Totals

### A. Phase 13C Dedicated Test Suite
- **Command:** `npx vitest run tests/discovery/phase13c-policy-ingestion.test.ts`
- **Exit Code:** `0`
- **Results:** 1 test file passed, 26 tests passed (0 failed, 0 skipped)
- **Coverage Areas:**
  - `PolicySourceFetcher`: 8 tests (HTTPS enforcement, URL allowlist, SHA-256 raw hashing, conditional 304, 404 removal, size bounding, redirect validation, timeout abort).
  - `PolicyExtractor`: 7 tests (Best Buy, Walmart, Target Standard, Target Circle Card, B&H Expedited vs Standard, conflicting threshold ambiguity detection, parse error on empty body).
  - `PolicyProposalEngine`: 5 tests (unchanged 304, non-material HTML change with identical terms, material change gated behind human review as `proposed`, human approval publishing new version and superseding old version, human rejection leaving active registry untouched).
  - `CartShippingEngine`: 5 tests (multi-item threshold qualification, marketplace disaggregation, pre-tax discount reduction, tax exclusion, Target APO/FPO inclusion vs AK/HI exclusion).
  - `Procurement Invalidation Integrity`: 1 test (invalidation of stale approval snapshot via `policy_version_changed`, `evidence_fingerprint_changed`, and `policy_superseded`).

### B. Full Project Test Suite
- **Command:** `npx vitest run`
- **Exit Code:** `0`
- **Results:** 55 test files passed, 851 tests passed (0 failed, 0 skipped)
- **Duration:** 14.2s

### C. TypeScript Type Check
- **Command:** `npx tsc --noEmit`
- **Exit Code:** `0`
- **Errors:** 0

### D. ESLint Check
- **Command:** `npm run lint`
- **Exit Code:** `0`
- **Errors:** 0, **Warnings:** 0

---

## 6. Read-Only Invariant & Protected Record Attestations

All invariants were independently verified read-only before and after implementation:

### A. Gate 1 Script Hash Integrity
- **Algorithm:** SHA-256
- **Target File:** `C:\paypal-gate1\gate1.mjs`
- **Observed Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Status:** Unmodified (Exact Match)

### B. Protected Purchase Record 1: `pur_1792633876502_s7jvwi22`
- **Status:** `BUYER_APPROVED`
- **Version:** `6`
- **Selected Candidate:** `5e6f1929-6d17-4f00-811c-233074d2366d`
- **Policy Evidence Fingerprint:** `a7bea28e28767ac8ad8bbf0a00a1293731a1146afd9797105ffa2cc8a348e8f9`
- **Active Approval:** `appr_1792639866777_t41vqfaf` (Snapshot: `1a78a481d0a4e40989aa4eb3b7ae36170dbffecdf0c6e5d6881dd775c98fc0ef`)
- **Payment Attempts:** 1 (`pay_att_1792642078698_cio3e660`, PayPal Order ID: `2JW38959VY1221001`, Status: `OPEN`, Verified: `APPROVED`)
- **Captures:** `0` (Zero captures attempted or recorded)

### C. Protected Purchase Record 2: `pur_1792654701712_f2iks5to`
- **Status:** `BUYER_APPROVED`
- **Version:** `5`
- **Selected Candidate:** `60a76ce6-9147-4ff2-a9b1-a56f8d34e0df`
- **Policy Evidence Fingerprint:** `71e67e3e2c6d474823dcdac6d30a8a7b814ce40cbb76062b2c10a24fb65c5b1f`
- **Active Approval:** `appr_1792654761253_t0ul1938` (Snapshot: `1a78a481d0a4e40989aa4eb3b7ae36170dbffecdf0c6e5d6881dd775c98fc0ef`)
- **Payment Attempts:** 1 (`pay_att_1792654816903_rdndyocu`, PayPal Order ID: `6TN25543HL618580V`, Status: `OPEN`, Verified: `APPROVED`)
- **Captures:** `0` (Zero captures attempted or recorded)

### D. System Actions Constraint Compliance
- **PayPal Orders Created:** 0
- **Live Payments Captured:** 0
- **Git Commits Created:** 0
- **Git Pushes:** 0
- **Deployments / Releases:** 0

