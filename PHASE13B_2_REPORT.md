# Phase 13B.2 — Policy Evidence Accuracy Review Report

**Date:** 2026-10-29  
**Status:** Completed & Verified  
**Audit Target:** Exact Source Evidence Alignment, Effective Date Provenance, Walmart Seller vs. Threshold Contribution, Target Destination Distinction, Best Buy/B&H Strict Terms  

---

## 1. Executive Summary

**Phase 13B.2** conducted a comprehensive, ground-truth audit of every seeded merchant policy field against current official retailer documentation.

Key findings and remediations implemented in code:
1. **Absence of Invented Effective Dates:** Removed fabricated `effectiveFrom: "2024-01-01"` defaults across all seeded policies. Official help pages represent standing online policies without declared effective dates (`sourceStatedEffectiveDate: null`). Explicitly distinguished three dates:
   - `sourceStatedEffectiveDate`: null when unstated by source (never invented).
   - `retrievedAt`: authentic timestamp when the page was retrieved by our system.
   - `lastReviewedAt`: authentic timestamp when policy terms were verified by engineering audit.
2. **Walmart Seller Shipping Eligibility vs. Cart-Threshold Contribution:**
   - *Seller Eligibility:* Free shipping under Walmart's policy requires the candidate item to be fulfilled by Walmart or Walmart Fulfillment Services (`requiresDirectRetailerOrWfsFulfillment: true`). Independent 3P seller-fulfilled items do NOT receive Walmart-funded free shipping.
   - *Cart Contribution:* Eligible items from Marketplace sellers explicitly count toward the $35 minimum threshold (`marketplaceItemsContributeToThreshold: true`). Model accepts multi-item `cartTotalCents` to satisfy the $35 threshold for Walmart-fulfilled items.
3. **Target Promotion vs. Circle Card vs. Circle 360 & Geographic Eligibility:**
   - *Standard $35 Promotion:* Applies to 48 continental states (`contiguous_us`) **and** APO/FPO addresses (`military_apo_fpo`); strictly excludes Alaska, Hawaii, and U.S. protectorates.
   - *Target Circle Card:* Covers all 50 states (including Alaska and Hawaii) and APO/FPO addresses with $0 minimum on eligible items. Autonomous agents never assume this benefit without verified proof (`requiresMembership: "target_circle_card"`).
   - *Target Circle 360:* Gated to verified subscription (`requiresMembership: "target_circle_360"`).
4. **Best Buy Official URL & Scope Strictness:**
   - Corrected source URL from the old credit card help topic to the official shipping help hub: `https://www.bestbuy.com/site/help-topics/shipping-delivery-and-store-pickup/pcmcat1504113264003.c`.
   - Modeled exclusions strictly supported by terms: Marketplace items, scheduled delivery, major appliances, TVs $\ge$ 51", and non-contiguous destinations.
5. **B&H Photo Video Terms Strictness:**
   - Preserved exact distinction between Free Expedited 1-2 Day Shipping ($49 minimum, contiguous US, excluding truck/drop-ship/special order) and Free Standard Ground Shipping ($0 minimum, item-specific qualification required).
6. **Blocker Diagnostic Specificity:**
   - Refactored evaluation order to prioritize standard merchant qualification blockers over optional membership blockers, ensuring clear explanations for standard shoppers.

---

## 2. Seeded Policy Evidence Coverage Matrix

| Retailer | Policy ID | URL | Stated Effective Date | Retrieved / Reviewed At | Destination Eligibility | Seller & Cart Conditions |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Best Buy** | `pol_bestbuy_contiguous_us_ground_v2` | [Shipping Help](https://www.bestbuy.com/site/help-topics/shipping-delivery-and-store-pickup/pcmcat1504113264003.c) | `null` (standing) | 2026-10-28 / 2026-10-29 | Contiguous US | Direct Best Buy items only; excludes 3P marketplace and scheduled delivery |
| **Walmart** | `pol_walmart_contiguous_us_ground_v2` | [Shipping Rates](https://www.walmart.com/help/article/shipping-rates-and-delivery/4113264426aa41aa9d00da81691a5e1e) | `null` (standing) | 2026-10-28 / 2026-10-29 | Contiguous US | Item must be Walmart/WFS fulfilled; eligible marketplace items count toward $35 cart minimum |
| **Target Standard** | `pol_target_contiguous_us_ground_v2` | [Target Help](https://help.target.com/help/subcategoryarticle?childcat=Free+shipping) | `null` (standing) | 2026-10-28 / 2026-10-29 | 48 Continental States + APO/FPO | $35 qualifying merchandise post-discount pre-tax; Target Plus excluded; AK/HI excluded |
| **Target Circle Card** | `pol_target_circle_card_v2` | [Target Help](https://help.target.com/help/subcategoryarticle?childcat=Free+shipping) | `null` (standing) | 2026-10-28 / 2026-10-29 | All 50 States (incl. AK/HI) + APO/FPO | $0 threshold on eligible items; requires verified Target Circle Card |
| **Target Circle 360** | `pol_target_circle_360_v2` | [Target Help](https://help.target.com/help/subcategoryarticle?childcat=Free+shipping) | `null` (standing) | 2026-10-28 / 2026-10-29 | All 50 States + APO/FPO | Expedited/same-day delivery; requires verified Target Circle 360 |
| **B&H Expedited** | `pol_bhphoto_contiguous_us_expedited_v2` | [B&H Help](https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp) | `null` (standing) | 2026-10-28 / 2026-10-29 | Contiguous US | $49 order minimum; expedited (1-2 day); excludes freight/truck/drop-ship/special order |
| **B&H Standard** | `pol_bhphoto_contiguous_us_free_standard_v2` | [B&H Help](https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp) | `null` (standing) | 2026-10-28 / 2026-10-29 | Contiguous US | $0 minimum; requires item-specific qualification; standard ground (1-7 days) |

---

## 3. Verification Test Results

All verification commands executed cleanly:

| Suite / Verification | Command | Exit Code | Result |
| :--- | :--- | :--- | :--- |
| **Phase 13B & 13B.2 Test Suite** | `npx vitest run tests/discovery/phase13b-merchant-policy.test.ts` | `0` | **59 passed** (59 tests) |
| **Full Project Test Suite** | `npx vitest run` | `0` | **822 passed**, 0 failed (**54 test files**) |
| **TypeScript Typecheck** | `npx tsc --noEmit` | `0` | **0 errors** |
| **ESLint Check** | `npm run lint` | `0` | **0 errors, 0 warnings** |

---

## 4. Invariants & Safety Verification

1. **Gate 1 Baseline Script (`C:\paypal-gate1\gate1.mjs`)**:
   - SHA-256 Hash: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` (identical before and after).
2. **Protected Purchases in PostgreSQL**:
   - `pur_1792633876502_s7jvwi22`: Status `BUYER_APPROVED` | Version `6` | Payment Attempt `2JW38959VY1221001` (`OPEN`, `APPROVED`) | Captures: `0`.
   - `pur_1792654701712_f2iks5to`: Status `BUYER_APPROVED` | Version `5` | Payment Attempt `6TN25543HL618580V` (`OPEN`, `APPROVED`) | Captures: `0`.
3. **Safety Guarantee**:
   - Zero PayPal orders created.
   - Zero PayPal captures attempted or executed.
   - Zero Git commits, pushes, deployments, or published packages.

