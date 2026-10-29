# Plinthly — Product Narrative & Architectural Blueprint

**Phase:** Phase 17 Judge Package  
**Tagline:** Verifiable Multi-Item Autonomous Procurement with Defensible Landed Costs  
**Core Thesis:** Autonomous procurement cannot be trusted without defensible shipping evidence, mathematical cart aggregation, and cryptographic human-in-the-loop authorization.

---

## 1. The Problem: The Hidden Leakage of Modern Procurement

When modern businesses, IT departments, and SMB teams purchase equipment, they face three pervasive failure modes:

### 1. The "Base-Price" Illusion
Search engines, price-comparison tools, and naive AI shopping agents evaluate products based almost exclusively on **base merchandise price**. But in real-world business purchasing:
- Shipping costs can represent 5% to 30% of order totals.
- Published free-shipping policies (e.g. Best Buy free standard ground over $35, B&H free shipping over $49) only trigger when items are intelligently aggregated into the same merchant cart.
- Split orders across multiple sellers incur separate delivery fees that quickly destroy nominal discounts.

### 2. The Unverified Evidence Trap
Existing autonomous agents frequently "hallucinate" shipping terms, treat missing shipping fields as `$0.00`, or blindly trust scrape results from unverified third-party marketplace sellers. When unexpected freight or split charges arrive on the corporate card, finance teams lose trust in the automation.

### 3. The Uncontrolled Checkout Boundary
Most autonomous purchasing prototypes treat checkout as an afterthought — either passing raw credit card numbers or handing off unrestricted capture tokens to external agents. An autonomous agent should **never** have unilateral authority to capture funds. Without cryptographic locking of buyer approval terms and strict multi-merchant cart boundaries, automated checkout is a major security vulnerability.

---

## 2. Plinthly’s Solution

Plinthly is a **verifiable, multi-item autonomous procurement engine** designed from the ground up for defensibility, transparent landed-cost accounting, and strict payment boundary isolation.

```
       Buyer Request (Natural Language)
                     │
                     ▼
       ┌──────────────────────────────┐
       │   Gemini Intent Parsing      │ ──► Flags Missing Specs & Ambiguities
       └──────────────────────────────┘
                     │
                     ▼
       ┌──────────────────────────────┐
       │ Multi-Candidate Discovery    │ ──► Channel3 + Direct Retailer Feeds
       └──────────────────────────────┘
                     │
                     ▼
       ┌──────────────────────────────┐
       │ Merchant Policy Engine       │ ──► Zone Filtering (Contiguous US vs AK/HI)
       │ & Shipping Evidence          │ ──► Threshold Evaluation ($35/$49 minimums)
       └──────────────────────────────┘
                     │
                     ▼
       ┌──────────────────────────────┐
       │ Split-Shipment & Cart Plan   │ ──► Consolidated vs. Lowest Landed Cost
       └──────────────────────────────┘
                     │
                     ▼
       ┌──────────────────────────────┐
       │ Buyer Approval Snapshot      │ ──► Cryptographic SHA-256 Hash Locked
       └──────────────────────────────┘
                     │
            [Material Change?] ────────► YES: Invalidate Approval & Block Checkout
                     │ NO
                     ▼
       ┌──────────────────────────────┐
       │ PayPal Sandbox Boundary      │ ──► Intent: AUTHORIZE Only (0 Captures)
       │ (Domain Isolated)            │ ──► Cart-Domain Whitelist Enforcement
       └──────────────────────────────┘
```

---

## 3. The End-to-End Buyer Journey

### Stage 1: Intelligent Intent Parsing & Ambiguity Resolution
A buyer describes their need in natural language:
> *"I need a workstation laptop with 32GB RAM under $1,500, a 4K monitor under $400, and a USB-C dock under $150 delivered to 98101."*

Plinthly uses **Google Gemini** structured output extraction to decompose this sentence into concrete, typed line items with individual budgets and attribute requirements (`ram: 32GB`, `resolution: 4K`). Crucially, Gemini actively highlights **unresolved ambiguities** (e.g. unstated quantities or destination ambiguities) so the buyer remains in full control.

### Stage 2: Multi-Item Discovery Across Top Retailers
Plinthly connects to enterprise product discovery APIs (such as Channel3) and authorized merchant feeds. It retrieves candidates for each line item, normalizing product titles, merchant identities, seller relationships (direct retailer vs. third-party marketplace), and availability.

### Stage 3: Defensible Landed-Cost Calculation & Evidence Inspection
Unlike naive scrapers, Plinthly ingests published merchant shipping policy documents and validates them with cryptographic fingerprints. It verifies:
- **Geographic Eligibility:** Enforces contiguous 48-state policies, identifying exclusions for Alaska (`AK`), Hawaii (`HI`), and APO/FPO addresses.
- **Threshold Progress:** Aggregates item subtotals within each merchant cart to calculate qualifying merchandise and determine whether free-shipping thresholds are satisfied.
- **Evidence Labeling:** Transparently flags every line as:
  - `RETAILER QUOTED`: Real-time API carrier quote.
  - `POLICY-DERIVED`: Validated merchant policy threshold applied (carrier quote unbound).
  - `UNQUOTED`: Shipping fee absent from upstream data.

> **The Plinthly Defensibility Rule:** If any item in a candidate strategy has unquoted shipping, Plinthly marks `totalLandedCostCents: null` and `isLandedCostDefensible: false`. It **never** treats missing shipping as free and **never** ranks an unverified estimate as cheaper than a verified complete quote.

### Stage 4: Strategy Comparison & Cart Optimization
Plinthly evaluates multiple feasible allocation strategies and presents them side-by-side in AG Grid and card interfaces:
- **Consolidated Strategy:** Minimizes shipments and retailer touchpoints by grouping items into a single trusted merchant (e.g. Best Buy), maximizing threshold qualification.
- **Lowest Landed Cost Strategy:** Dynamically splits items across merchants (e.g. Laptop & Monitor at Best Buy, Dock at B&H Photo) when the merchandise savings exceed the cost of split shipping.
- **Buyer Inspection:** The buyer can drill down into Retailer Carts and Split Shipments to inspect seller names, fulfillment methods, and threshold progress bars.

### Stage 5: Cryptographic Approval Locking
When the buyer selects their preferred strategy and clicks **Approve**, Plinthly generates an immutable snapshot:
- Computes a deterministic 64-character SHA-256 hash across line items, candidate IDs, merchant domains, prices, and shipping fees.
- Records the approver's user ID and timestamp in durable PostgreSQL audit logs.
- Fences the purchase version so subsequent changes to the catalog do not silently mutate approved terms.

### Stage 6: Staleness Invalidation & Protection
If material terms change after approval — such as altering line items, quantities, or changing the delivery ZIP from `98101` to `99501` (Alaska) — Plinthly immediately marks the snapshot as invalidated. The system prevents checkout until the buyer re-evaluates and approves the updated landed cost.

### Stage 7: Protected PayPal Checkout Boundary
Plinthly integrates with PayPal Sandbox through a hardened, non-capture architectural pattern:
1. **Multi-Merchant Cart Isolation:** Corporate purchasing cannot pool funds across unrelated merchants. Plinthly requires individual checkout order creation per merchant domain.
2. **Intent AUTHORIZE Enforcement:** Order creation is strictly configured with `intent: AUTHORIZE`. Order creation never captures funds.
3. **Domain Whitelisting:** Checkout requests verify that the target cart matches the approved snapshot. Attempts to direct checkout to unapproved merchants are rejected with `HTTP 400` before reaching PayPal.
4. **Independent Verification:** Payment attempts can be independently verified by querying PayPal’s REST API directly, guaranteeing complete alignment between local records and remote sandbox state with **strictly zero fund captures**.

---

## 4. Architectural Highlights & Engineering Integrity

| Component | Technical Implementation | Defense In Depth |
| :--- | :--- | :--- |
| **State Machine** | Discrete state transitions (`REQUIREMENTS_CONFIRMED` $\to$ `BUYER_APPROVED` $\to$ `ORDER_CREATED`) | Version fencing prevents race conditions and concurrent double-actions. |
| **Audit Log** | Immutable append-only audit event log stored in PostgreSQL | Every transition records actor identity, timestamp, and SHA-256 snapshot hashes. |
| **Shipping Engine** | Geographic zone resolver + merchant policy threshold evaluator | Defends against silent out-of-zone shipping surcharges (e.g. AK/HI). |
| **Payment Boundary** | Hardened PayPal REST API client + Gate 1 validation wrapper | Enforces `intent: AUTHORIZE`; completely eliminates autonomous fund capture. |
| **API Resilience** | Idempotency middleware with SHA-256 request hashing | Eliminates duplicate purchase creations and duplicate payment attempts. |

---

## 5. Scope Boundaries & Honest Engineering Disclosures

Plinthly strictly adheres to truth-in-advertising and engineering transparency:
- **Order Creation vs. Payment Authorization:** Creating a PayPal order provisions an authorized order in the sandbox; it does not capture funds or charge the buyer's card.
- **Policy-Derived Shipping:** Merchant shipping thresholds are evaluated against published merchant policy documents. While legally and commercially binding under published retailer terms, carrier quotes are not live API quotes until checkout dispatch.
- **Multi-Merchant Checkout:** Plinthly isolates each retailer cart into a separate transaction boundary; it does not claim multi-merchant single-swipe checkout completion.
- **Zero Captures:** Across all test runs, production deployments, and sandbox verifications, Plinthly maintains a verified database capture count of **strictly zero**.

