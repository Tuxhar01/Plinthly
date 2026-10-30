# Phase 13B.1 — Merchant Policy Registry Correctness Audit and Remediation Report

**Date:** 2026-10-29  
**Status:** Completed & Verified  
**Audit Target:** Authoritative Seeded Merchant Policy Registry & Evaluation Engine  

---

## 1. Executive Summary

Prior to initiating Phase 13C's automated policy crawler, **Phase 13B.1** conducted an exhaustive correctness audit of the seeded merchant policies for four primary US retailers (**Best Buy**, **Walmart**, **Target**, and **B&H Photo Video**) against official published policy sources.

The audit revealed multiple critical real-world limitations that were previously unmodeled or oversimplified:
1. **Best Buy:** Indiscriminate $35 threshold application failed to model third-party Marketplace exclusions, major appliance scheduled delivery surcharges, and in-home delivery fees.
2. **Walmart:** Blanket $35 claims failed to model seller fulfillment (marketplace sellers set separate terms), assumed Walmart+ benefits for ordinary shoppers without proof, and missed category exclusions (freight, fresh grocery delivery from store, hazardous materials).
3. **Target:** Threshold evaluation failed to enforce that $35 must be calculated **after discounts/coupons** and **before sales tax**, and did not block Target Plus marketplace sellers or assume membership benefits (Circle Card / 360).
4. **B&H Photo Video:** Universal $49 order minimum was factually inaccurate. B&H offers **Free Expedited (1-2 Day) Shipping** over $49 to the contiguous US, but also **Free Standard Ground Shipping** on thousands of items with **no order minimum** ($0 threshold) based on item-specific qualification.

All four merchant registries and the core policy evaluation engine were refactored to **version 2.0.0** with strict typed blockers, fail-closed semantics, pre-tax/post-discount arithmetic, and complete provenance tracking.

---

## 2. Seeded Policy Remediation Matrix

| Merchant | Policy ID | Delivery Method | Threshold | Key Remediated Conditions | Official Source URL |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Best Buy** | `pol_bestbuy_contiguous_us_ground_v2` | `standard_ground` | $35.00 (`3500` cents) | `requiresDirectRetailerSeller: true` (excludes Marketplace), `excludedSpecialFulfillmentMethods`: scheduled/in-home/freight delivery, major appliances | [Best Buy Help](https://www.bestbuy.com/site/help-topics/free-shipping/pcmcat204400050012.c) |
| **Walmart** | `pol_walmart_contiguous_us_ground_v2` | `standard_ground` | $35.00 (`3500` cents) | `requiresDirectRetailerSeller: true` (excludes 3P sellers), `requiresMembership: null` (no assumed Walmart+), `excludedCategories`: freight, heavy/oversized, hazmat, fresh grocery | [Walmart Help](https://www.walmart.com/help/article/shipping-rates-and-delivery/4113264426aa41aa9d00da81691a5e1e) |
| **Target** | `pol_target_contiguous_us_ground_v2` | `standard_ground` | $35.00 (`3500` cents) | `requiresPreTaxMerchandiseThreshold: true` (calculated after discounts, before tax), `requiresDirectRetailerSeller: true` (excludes Target Plus), no assumed Circle Card/360 | [Target Help](https://help.target.com/help/subcategoryarticle?childcat=Free+shipping) |
| **B&H Photo Video** (Expedited) | `pol_bhphoto_contiguous_us_expedited_v2` | `expedited` | $49.00 (`4900` cents) | Free 1-2 Day Expedited Shipping over $49 to contiguous US, excludes freight/oversized/drop-ship | [B&H Help Center](https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp) |
| **B&H Photo Video** (Standard Ground) | `pol_bhphoto_contiguous_us_free_standard_v2` | `standard_ground` | $0.00 (`0` cents) | `itemSpecificQualificationRequired: true` (item must be verified free shipping eligible), no universal $49 minimum | [B&H Help Center](https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp) |

---

## 3. Policy Evaluation Engine Enhancements

1. **Typed Blocker Diagnostics:**
   - `"marketplace_seller_excluded"`: Candidate is identified as a third-party marketplace offer or seller name differs from retailer name.
   - `"special_delivery_required"`: Candidate requires scheduled in-home delivery, freight, or special delivery methods.
   - `"membership_required"`: Policy requires paid membership (e.g., Walmart+, Target Circle 360) and buyer is not verified.
   - `"unconfirmed_qualification"`: Item-specific qualification required (e.g., B&H free standard ground) but item is unverified.
   - `"threshold_not_met"`: Merchandise total net of discounts and before tax fails the required order minimum.
   - `"conflicting_policies"`: Multiple policies satisfy with conflicting rates; fails closed.

2. **Pre-Tax & Post-Discount Arithmetic:**
   - Gross merchandise = `unitPriceCents * quantity`
   - Net qualifying merchandise = `Math.max(0, grossMerchandiseCents - discountCents)`
   - Sales tax (`estimatedTaxCents`) is strictly **excluded** from qualifying merchandise calculations.
   - Detailed diagnostics indicate if gross was above threshold but discounts reduced it, or if tax was excluded.

3. **Cryptographic Fingerprint & Provenance:**
   - Canonical representation in `computePolicyFingerprint` covers all 21 policy terms sorted alphabetically with array determinism.
   - Preserves exact source URL, publisher corporate identity, retrieval timestamp (ISO 8601 UTC), and effective/expiry dates.

4. **Upstream Adapter Integration:**
   - `lib/discovery/channel3-adapter.ts` inspects upstream offer attributes for seller provenance (`sellerName`, `isMarketplace`, `isDirectRetailerSeller`), fulfillment method (`requiresSpecialDelivery`), and item qualification (`isFreeShippingEligibleItem`).
   - Propagates `deliveryMethod` and `thresholdCents` through `RawDiscoveredCandidate` to `ShippingEvidenceDetails`.

---

## 4. Test & Verification Results

### 1. Test Suite Execution (`npx vitest run`)
- **Total Test Files:** 54 passed (54 total)
- **Total Tests:** 810 passed (810 total)
- **Exit Code:** `0`
- **Phase 13B & 13B.1 Suite:** `tests/discovery/phase13b-merchant-policy.test.ts` (47 passed out of 47 tests)
  - *Best Buy Exclusions:* 5 passed
  - *Walmart Marketplace & Membership:* 4 passed
  - *Target Discount & Tax Exclusion:* 4 passed
  - *B&H Photo Video Separation:* 4 passed
  - *Policy Provenance & Cryptographic Fingerprints:* 2 passed
  - *End-to-End Tracing & Policy Invalidation:* 1 passed

### 2. TypeScript Compilation (`npx tsc --noEmit`)
- **Exit Code:** `0` (Zero type errors)

### 3. ESLint Verification (`npm run lint`)
- **Exit Code:** `0` (Zero lint errors, zero warnings)

### 4. Read-Only Invariants Preservation
- **Gate 1 SHA-256 Hash:**
  - Expected: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
  - Verified: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` (Exact match)
- **Protected Purchase `pur_1792633876502_s7jvwi22`:**
  - Status: `BUYER_APPROVED`
  - Version: `6`
  - Payment Attempt: `2JW38959VY1221001` (`OPEN`, `APPROVED`)
  - Capture count: `0`
- **Protected Purchase `pur_1792654701712_f2iks5to`:**
  - Status: `BUYER_APPROVED`
  - Version: `5`
  - Payment Attempt: `6TN25543HL618580V` (`OPEN`, `APPROVED`)
  - Capture count: `0`
- **External State Safety:**
  - Zero PayPal orders created
  - Zero PayPal captures executed
  - Zero Git commits, pushes, or deployments

