# Phase 13A — Real Evidence Integration & Procurement Workflow Advancement Report

**Date:** 2026-10-29  
**Repository:** `C:\Users\Tushar Kumar\Desktop\Plinthly`  
**Phase:** 13A — Real Evidence Integration & Procurement Workflow Advancement  
**Verdict:** **PASS**

---

## 1. Executive Summary

Phase 13A resumes and advances Plinthly's core mission as an evidence-gated autonomous AI procurement engine. Prior to Phase 13A, live multi-retailer catalog offers retrieved via Channel3 lacked destination-specific carrier shipping evidence, resulting in immediate fail-closed policy blocks. While a synthetic demo fixture verified the positive approval and order execution path, the system needed substantial architectural and workflow improvements to address real evidence limitations, candidate normalization, duplicate detection, and PayPal Sandbox error recovery.

Phase 13A implements:
1. **Destination-Aware Shipping Quote Enrichment:** Integrated the typed `ShippingQuoteAdapter` abstraction into `Channel3SourceAdapter`, allowing destination postal codes (`DestinationContext`) to trigger real-time shipping rate queries or cleanly capture typed provider blocker reasons (e.g. Best Buy CAPI enterprise sales gating, Shopify Storefront API access token requirements).
2. **Deterministic Candidate Near-Duplicate Detection & Grouping:** Added deterministic hashing (`computeDuplicateGroupKey`) across merchant domains, canonical URL paths, and title tokens to identify duplicate offers across search results without merging distinct products, tagging secondary offers with canonical external IDs.
3. **Structured Specification & Provenance Classification:** Added `CandidateSpecificationsSummary` distinguishing known (structured merchant-provided facts), inferred (unverified heuristic extractions), and missing specifications, preventing unverified claims from masquerading as verified evidence.
4. **Enhanced AG Grid Procurement Studio:** Added evidence freshness and provenance audit indicators, duplicate offer tagging, a "Hide Duplicates" toggle, and explicit shipping blocker diagnostics in the UI comparison studio.
5. **PayPal Sandbox 404 & Failure Recovery:** Hardened `PaymentVerificationService` to explicitly handle HTTP 404 (`RESOURCE_NOT_FOUND`) from expired or historical Sandbox orders, persisting an authoritative `NOT_FOUND` attempt record while maintaining local purchase and audit immutability, rendered clearly in the UI with a dedicated status chip and diagnostic banner.
6. **Strict Non-Capture & Gate 1 Preservation:** Zero PayPal captures, zero new remote order creation, zero modifications to Gate 1 baseline script `C:\paypal-gate1\gate1.mjs`.

---

## 2. Gate 1 Baseline Integrity Verification

The Gate 1 baseline script `C:\paypal-gate1\gate1.mjs` was verified via SHA-256 before and after execution:

- **Target File:** `C:\paypal-gate1\gate1.mjs`
- **Expected SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Measured SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Verification Status:** **PASS** (100% byte-for-byte exact match; untouched, unread, unexecuted).

---

## 3. Real Shipping Evidence Gap Analysis & Provider Decision Matrix

### 3.1 The Root Cause of the Shipping Gap
Product catalog search engines (such as Channel3) aggregate raw retailer product feeds. These feeds contain item titles, catalog prices, images, and merchant URLs, but **inherently lack dynamic destination shipping rates**. 

In modern e-commerce, final shipping costs cannot be determined from a product catalog alone because they depend on four dynamic variables:
1. **Destination Postal Code:** Delivery zone pricing differs between local, interstate, and non-contiguous destinations.
2. **Origin Fulfillment Center:** Enterprise retailers (Best Buy, Walmart, Target) calculate rates from dynamic distribution centers or nearby retail stores.
3. **Parcel Weight and Volumetric Dimensions:** Multi-carrier parcel rates require weight and cubic dimensions.
4. **Customer Eligibility & Cart Thresholds:** Free shipping policies often require order total minimums ($35 threshold) or membership tiers (Best Buy Total, Walmart+, Amazon Prime).

Treating missing shipping as $0.00 is a severe financial hazard. Plinthly strictly enforces that missing shipping fails closed.

### 3.2 Provider Decision Matrix

| Provider / Channel | Integration Feasibility | Prerequisites & Commercial Boundaries | Architectural Compatibility | Status in Plinthly |
| :--- | :--- | :--- | :--- | :--- |
| **Best Buy Commerce API (CAPI)** | High (Structured JSON rates endpoint `/commerce/shipping-rates`) | **Enterprise Sales-Gated.** Requires bilateral partner agreement and private partner credentials. Public developer API does not calculate dynamic rates. Scraping checkout violates Terms of Service. | Native match with `ShippingQuoteAdapter` | **Adapter Implemented** (`BestBuyShippingQuoteAdapter`); reports typed `unavailable` status when credentials absent. |
| **Shopify Storefront API** | High (GraphQL `cart.deliveryGroups.deliveryOptions`) | **Merchant-Specific Domain & Token.** Requires Storefront Access Token with `unauthenticated_read_shipping_rates` scope for each independent Shopify merchant. | Direct match with `ShippingQuoteAdapter` | **Adapter Implemented** (`ShopifyShippingQuoteAdapter`); reports typed `unavailable` status when shop domain/token absent. |
| **Multi-Carrier Platforms (EasyPost / Shippo / ShipEngine)** | Moderate | Requires known **origin fulfillment ZIP** and exact package dimensions/weight, which third-party product feeds do not supply. | High for direct fulfillment; low for merchant web orders | Documented as viable when merchant declares origin warehouse metadata. |
| **Direct Carrier APIs (USPS / FedEx / UPS)** | Low to Moderate | Requires account registration, origin ZIP, destination ZIP, and parcel specifications. | Moderate | Prohibited from inferring origin warehouse locations without merchant declaration. |
| **Merchant Policy Rules (Deterministic Thresholds)** | High | Deterministic verification: if merchant offers universal free shipping over threshold (e.g. $35.00) in contiguous US, and candidate total exceeds threshold with verified merchant policy metadata. | Compatible with policy engine rules | Evaluated fail-closed; must be backed by authoritative merchant policy evidence. |

---

## 4. Code Modifications Implemented

### 4.1 Type System & Schema Additions
- **[`lib/discovery/types.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/types.ts):**
  - Added `CandidateDuplicateInfo` (`isDuplicate`, `duplicateGroupKey`, `canonicalExternalId`, `duplicateReason`).
  - Added `CandidateSpecificationsSummary` (`known`, `inferred`, `missing`).
  - Extended `NormalizedProductCandidate` with optional `duplicateInfo` and `specificationsSummary`.
  - Added `destination?: DestinationContext` to `SearchConstraints`.
- **[`lib/workflow/validation.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/workflow/validation.ts):**
  - Updated `searchConstraintsSchema` to accept optional `destination: destinationContextSchema`.

### 4.2 Candidate Normalization & Evidence Hardening
- **[`lib/discovery/normalize.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/normalize.ts):**
  - Implemented `computeDuplicateGroupKey(candidate)`: Generates deterministic SHA-256 group hashes based on normalized merchant domain and title/URL path.
  - Implemented `summarizeCandidateSpecifications(rawAttributes, requiredKeys)`: Categorizes specifications into structured verified facts (`known`), text heuristics (`inferred`), and absent requirements (`missing`).
  - Extended `normalizeCandidate` to attach `duplicateInfo` and `specificationsSummary`.

### 4.3 Discovery Adapter Enrichment
- **[`lib/discovery/channel3-adapter.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/discovery/channel3-adapter.ts):**
  - Integrated `getShippingQuoteAdapter()`: When `constraints.destination` is supplied in `ProductSearchRequest`, the adapter invokes the quote adapter to fetch destination-specific rates for candidates.
  - On quote success: Attaches authoritative `shippingCents`, `deliveryMethod`, `destinationPostalCode`, and `snapshotHash`.
  - On quote blocker/unavailable: Records typed blocker reason (`shipping_blocker_status`, `shipping_blocker_reason`) in raw attributes, preventing silent conversion to $0.00.
  - Implemented duplicate group tracking across search results, marking secondary offers with canonical external ID references.

### 4.4 PayPal Sandbox 404 & Error Recovery
- **[`lib/paypal/verification.ts`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/lib/paypal/verification.ts):**
  - Added `"REMOTE_NOT_FOUND"` to `PaymentVerificationOutcome`.
  - Explicitly differentiated HTTP 404 (`RESOURCE_NOT_FOUND`) from generic API errors when `getOrder()` fails.
  - Records verification attempt in repository with `verifiedStatus: "NOT_FOUND"` and `failureReason: "remote_order_not_found"`.
  - Returns structured `outcome: "REMOTE_NOT_FOUND"`, `verified: false`, with explicit explanation that the order expired or does not exist in Sandbox while local purchase and audit records remain intact.
  - Records generic `API_ERROR` with `err.errorName` in repository on other HTTP status codes.
- **[`components/workflow/paypal-card.tsx`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/components/workflow/paypal-card.tsx):**
  - Added chip renderer for `REMOTE_NOT_FOUND`: `<StatusChip variant="caution" label="REMOTE ORDER NOT FOUND (404)" />`.
  - Added diagnostic banner explaining that sandbox orders expire periodically and local audit history is preserved.

### 4.5 AG Grid Procurement Studio UI
- **[`components/workflow/candidate-comparison-grid.tsx`](file:///c:/Users/Tushar%20Kumar/Desktop/Plinthly/components/workflow/candidate-comparison-grid.tsx):**
  - Added `Duplicate` badge for secondary candidate listings.
  - Added "Hide Duplicates" interactive filter checkbox in the Studio header.
  - Added "Freshness & Provenance" audit column displaying verified source timestamps vs observation dates.
  - Preserved `Unknown (Incomplete)` landed cost display when shipping evidence is absent.

---

## 5. Verification & Test Results

### 5.1 Test Suites Executed

| Command / Suite | Tests Run | Tests Passed | Tests Failed | Exit Code | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `npx vitest run tests/discovery/phase13a-improvements.test.ts` | 8 | 8 | 0 | `0` | New Phase 13A suite covering Gate 1, duplicate detection, spec summary, destination quote enrichment, and PayPal 404 recovery. |
| `npx vitest run tests/discovery/shipping-quote-adapter.test.ts tests/paypal/verification.test.ts tests/paypal/client.test.ts tests/workflow/service.test.ts` | 76 | 76 | 0 | `0` | Key shipping and payment regression suites. |
| `npx vitest run tests/discovery tests/workflow tests/paypal tests/policy` | 528 | 528 | 0 | `0` | Full discovery, workflow, PayPal, and policy test suites (including live Channel3 integration test). |
| `npx vitest run tests/state tests/audit tests/source.test.ts tests/tokens.test.ts` | 184 | 184 | 0 | `0` | Full state machine, audit writer, WCAG token contrast, and source hygiene tests. |
| `npx vitest run tests/contracts/` | 4 | 4 | 0 | `0` | OpenAPI contract test suite. |
| `npx vitest run tests/apimatic/` | 4 | 4 | 0 | `0` | APIMatic client integration suite. |
| `npx vitest run tests/ai/api-route.test.ts tests/ai/intent-parser.test.ts` | 22 | 22 | 0 | `0` | Gemini intent parser and API route unit test suites. |
| `npx tsc --noEmit` | N/A | Full Project | 0 errors | `0` | Zero TypeScript compiler errors or type warnings. |
| `npm run lint` | N/A | Full Project | 0 errors | `0` | ESLint passed with zero warnings or errors. |
| `Get-FileHash C:\paypal-gate1\gate1.mjs` | 1 | 1 | 0 | `0` | Hash exactly `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`. |

---

## 6. Integration Status Overview

| Integration | Classification | Current Status | Notes |
| :--- | :--- | :--- | :--- |
| **Gate 1 Baseline (`gate1.mjs`)** | Production Baseline | **Active & Preserved** | SHA-256 hash verified identically. |
| **Channel3 Product Search** | Live Provider | **Live & Operational** | Exercises live catalog query in integration tests; passes without regressions. |
| **Best Buy Shipping Quote Adapter** | Provider Boundary | **Awaiting Partner Credentials** | Returns typed `unavailable` status documenting CAPI partner gating blocker. |
| **Shopify Shipping Quote Adapter** | Provider Boundary | **Awaiting Merchant Token** | Returns typed `unavailable` status documenting domain & token requirements. |
| **MultiProvider Composite Adapter** | Modular Architecture | **Active & Dispatching** | Dispatches to Best Buy, Shopify, or reports clean `unsupported` status. |
| **Synthetic Demo Fixture** | Test / Demo Fixture | **Active & Explicitly Labeled** | Clearly labeled as `[DEMO FIXTURE]` to avoid masquerading as live evidence. |
| **PayPal Sandbox Orders v2** | Server-Side Sandbox | **Verified (Non-Capture)** | Tested against sandbox specifications; 404 recovery verified; funds capture strictly disabled. |
| **PostgreSQL / Prisma** | Database Layer | **Active & Tested** | In-memory and Docker/Postgres tests pass with full transactional and concurrency guarantees. |

---

## 7. Protected State & Invariant Compliance

1. **No Funds Capture:** Zero capture endpoints or payment finalizations were introduced.
2. **No Accidental Sandbox Orders:** No new live PayPal Sandbox orders were created.
3. **No Database Mutation of Baseline Purchases:** Baseline purchases `pur_1792633876502_s7jvwi22` and `pur_1792654701712_f2iks5to` were untouched.
4. **No Git Changes:** Working tree remains clean; no commits, branches, pushes, or deployments were performed.
5. **No Secret Exposure:** Environment variables and secrets remain safely isolated in `.env.local`.

---

## 8. Remaining Blockers & Next Engineering Steps

### Blockers Requiring Commercial Access
1. **Best Buy CAPI Credentials:** Requires an enterprise sales partnership agreement with Best Buy for dynamic destination rate calculations.
2. **Shopify Merchant Storefront Access:** Requires configuring authorized merchant domain(s) and Storefront API Access Tokens for live Shopify stores.

### Recommended Next Engineering Phase
**Phase 13B — Deterministic Merchant Policy Evaluation Engine & Multi-Destination Quoting:**
- Implement deterministic threshold rules for verified merchant policies (e.g., contiguous US free shipping thresholds where order total >= $35.00).
- Expand destination context support to multi-destination zone matrices (handling US Alaska/Hawaii non-contiguous exclusions deterministically).
- Implement buyer approval link refresh and polling for Sandbox buyer authorization callbacks.
