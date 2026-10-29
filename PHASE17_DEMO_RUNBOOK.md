# Plinthly Phase 17 — Judge-Ready Demo Runbook

**Product Version:** Plinthly v0.1.0 (Phase 17 Milestone)  
**Target Environment:** Local Node.js v22.17.0 / PostgreSQL / Next.js 16.4.2  
**Target Audience:** Hackathon Judges, Procurement Officers, Technical Evaluators  
**Execution Time:** ~5–7 minutes for complete interactive walkthrough  

---

## 1. Executive Summary & Demo Goals

Plinthly is a **verifiable, multi-item autonomous procurement engine** that eliminates the hidden shipping fees, split-order surprises, and unauthorized checkout risks plaguing enterprise and SMB purchasing.

This runbook provides an exact, step-by-step procedure to evaluate Plinthly’s judge-ready demonstration using a canonical 3-item workstation procurement scenario.

### Core Capabilities Demonstrated
1. **Natural Language Decomposition & Ambiguity Flagging:** Gemini parses unstructured buyer requests into structured specifications while flagging missing quantities or shipping destinations.
2. **Deterministic Multi-Item Discovery:** Evaluates candidates across multiple top retailers (Best Buy, B&H Photo, etc.).
3. **Transparent Landed-Cost Evidence:** Clearly distinguishes between **quoted carrier shipping**, **policy-derived shipping** (e.g. Best Buy free standard ground over $35), and **unverified shipping** (flagging missing offers as incomplete landed cost).
4. **Cart Aggregation & Split-Shipment Planning:** Evaluates feasible purchasing strategies (Consolidated Single Retailer vs. Lowest Landed Cost Multi-Retailer).
5. **Durable Cryptographic Approval Locking:** The buyer locks an approved strategy snapshot with actor identity, timestamp, and immutable SHA-256 hash.
6. **Material Staleness Invalidation:** Invalids approval immediately when delivery destination or items change (e.g. changing ZIP from 98101 to Alaska 99501).
7. **Strict Checkout Boundary Enforcement:** Tampered terms or unapproved merchant carts are rejected with HTTP 400 *before* reaching the PayPal API.
8. **Non-Capture Payment Safety:** Demonstrates `AUTHORIZE` intent isolation with **zero fund captures**.

---

## 2. Environment Setup & Prerequisites

### Prerequisites
- Node.js `22.17.0` and npm `10.9.2`
- PostgreSQL 15+ database running (configured in `.env.local` as `DATABASE_URL`)
- Active local server running on `http://localhost:3000`

### Starting the Server
```bash
# In the repository root:
npm run dev
```
Confirm the application is available at [http://localhost:3000](http://localhost:3000).

### Pre-Run Invariant Check
Plinthly includes strict invariants protecting production-critical audit logs and sandbox boundaries. Verify system health before running the demo:
```bash
# Run Vitest test suite (1,040+ passing tests):
npx vitest run

# Run TypeScript compilation check:
npx tsc --noEmit

# Run ESLint hygiene check:
npm run lint
```
*Expected result:* All checks exit with code 0.

---

## 3. The Canonical 3-Item Procurement Scenario

To demonstrate all edge cases cleanly without brittle external networks, the demo uses a canonical 3-item workstation request:

| Line Item | Description | Target Budget | Required Specifications | Candidate Behaviors |
| :--- | :--- | :--- | :--- | :--- |
| **Item 1** | Dell XPS 15 Workstation Laptop | $1,500.00 | `ram: 32GB` | Multiple verified candidates (Best Buy $1,460 vs B&H $1,480). |
| **Item 2** | Dell UltraSharp 27 4K Monitor | $400.00 | `resolution: 4K` | Clear policy shipping threshold evaluation ($400 meets $35 free shipping). |
| **Item 3** | USB-C Dual 4K Docking Station | $150.00 | `ports: Dual HDMI/DP` | Split option ($140 @ B&H saves $10) vs Unverified offer ($110 with missing shipping). |

---

## 4. Step-by-Step Interactive Demo Walkthrough

### Step 1: Natural Language Request & Gemini AI Decomposition
1. Navigate to [http://localhost:3000](http://localhost:3000) in your web browser.
2. In the **Natural Language Request Studio** (Stage 1), enter the buyer's procurement prompt:
   ```text
   I need a workstation laptop with 32GB RAM under $1,500, a 4K monitor under $400, and a USB-C dock under $150 delivered to 98101.
   ```
3. Click **"Decompose Request with AI"**.
4. **Observe the Judged Capabilities:**
   - **Structured Extraction:** Gemini extracts `budget: $2,050.00`, `destination: { country: "US", postalCode: "98101" }`, and 3 distinct product keywords.
   - **Ambiguity Flagging:** Gemini identifies and displays unresolved ambiguities (e.g. quantity was inferred as 1 rather than explicitly stated, prompting buyer confirmation).

---

### Step 2: Create Structured Multi-Item Purchase
1. Click **"Create Purchase with Extracted Items"** (or click **"New Purchase"** in the top navigation).
2. The system provisions a durable database record (status: `REQUIREMENTS_CONFIRMED`) and navigates to the Purchase Dashboard.
3. Observe the three pre-populated line items with line-level budgets and specification rules.

---

### Step 3: Multi-Merchant Strategy Evaluation
1. Scroll to the **Multi-Item Procurement Studio** card.
2. Verify the destination postal code is set to `98101` (Seattle, WA — Contiguous US).
3. Click **"Load Judge Demo Fixture (3 Items)"** (or click **"Evaluate Multi-Item Plan"** for live retailer discovery).
4. **Observe the Real-Time Strategy Matrix:**
   - The studio populates and compares **3 distinct strategies**:
     - **Strategy A — "Lowest Landed Cost (Policy-Derived)":** Allocates the Dock to B&H Photo ($140.00) and the Laptop ($1,460.00) + Monitor ($400.00) to Best Buy.
       - *Merchandise:* $2,000.00
       - *Shipping:* $0.00 (Both retailers qualify for free ground shipping thresholds)
       - *Total Landed Cost:* **$2,000.00 USD** (Defensible: Yes)
     - **Strategy B — "Consolidated (bestbuy.com)":** Allocates all 3 items to Best Buy.
       - *Merchandise:* $2,010.00
       - *Shipping:* $0.00 (Best Buy $35 threshold satisfied)
       - *Total Landed Cost:* **$2,010.00 USD** (Defensible: Yes, minimizes shipments to 1)
     - **Strategy C — "Incomplete Evidence Candidate":** If an unverified marketplace offer ($110 with unquoted shipping) is considered:
       - Marked with **"UNQUOTED / INCOMPLETE"**.
       - StatusChip flags **"UNCERTAIN"**.
       - The **Approve button is safely disabled** to prevent committing buyer funds to uncalculated delivery fees.

---

### Step 4: Transparent Evidence Inspection
1. Click the **"Retailer Carts"** tab:
   - Inspect the **Free Shipping Policy Progress Bar**. For Best Buy, note `$2010.00 >= $35.00 Threshold (QUALIFIED)`.
   - Inspect the merchant domain separation (`bestbuy.com` vs `bhphotovideo.com`).
2. Click the **"Split Shipments"** tab:
   - Observe the shipping evidence badges:
     - `POLICY-DERIVED`: Published merchant threshold rule applied. Carrier quote is not bound.
     - `RETAILER QUOTED`: Real-time API quote bound to merchant cart.
     - `UNQUOTED`: Upstream missing shipping fee.

---

### Step 5: Buyer Approval & Cryptographic Snapshot Locking
1. Return to the **"Strategy Comparison"** tab.
2. Select **"Lowest Landed Cost (Policy-Derived)"** (saves $10.00 across 2 carts).
3. Click **"Approve Plan"**.
4. **Observe the Results:**
   - The purchase transitions to `APPROVED`.
   - A green **"Approved Strategy Locked"** banner appears:
     - Records approver user ID (`usr_demo_buyer`).
     - Records the exact locked landed cost: `$2000.00 USD`.
     - Displays the durable 64-character SHA-256 `Snapshot Hash`.

---

### Step 6: Material Staleness Invalidation Check
1. In the **Ship to ZIP** input field, change `98101` to `99501` (Anchorage, Alaska).
2. **Observe the Immediate Invalidation Warning:**
   - A blue advisory banner alerts the buyer that material terms have changed.
3. Click **"Re-Evaluate Strategies"**:
   - Alaska is outside the Contiguous US geographic zone for retailer ground shipping policies.
   - The system re-evaluates merchant policies, detects that ground threshold free shipping is void for Alaska, and invalidates the previous snapshot.

---

### Step 7: Checkout Boundary Fraud & Tamper Rejection
1. Scroll to the **PayPal Sandbox Order & Independent Verification** card.
2. Notice the prominent **Non-Capture Architecture Banner**:
   > *"Order creation sets up an authorized payment agreement in PayPal Sandbox; it is not payment authorization or capture. Funds are never moved during order creation."*
3. If an attacker or compromised client attempts to submit checkout with an altered cart (e.g. `fraudulent-vendor.com`):
   - The checkout route intercepts the mismatch against the approved snapshot.
   - Rejects the request with `HTTP 400 (invalid_input)`:
     `Target cart merchant domain does not match any approved cart.`
   - **Zero orders are created in PayPal.**

---

### Step 8: Independent Verification & Zero-Capture Guarantee
1. When viewing existing payment attempts, click **"Verify State via Remote Query"**.
2. Plinthly queries PayPal directly via authenticated REST API:
   - Displays requested intent: `AUTHORIZE`.
   - Displays remote status without mutating local databases.
3. Confirm that **database-wide completed captures remain strictly ZERO**.

---

## 5. Automated Headless Verification Script

To run the complete 10-step flow programmatically and view formatted execution logs:

```bash
# Run the automated Phase 17 verification script:
npx tsx scratch/test_demo_flow.ts
```

*Expected console output:*
```text
=== PHASE 17 DEMO VERIFICATION SCRIPT ===
--- Step 1 & 2: Natural Language Decompose via Gemini ---
Decompose Status: 200
Extracted Keywords: workstation laptop, 4K monitor, USB-C dock
Extracted Destination: { country: 'US', postalCode: '98101' }
Unresolved Ambiguities: [...]
--- Step 3: Create Multi-Item Purchase (3 Line Items) ---
Create Purchase Status: 201
Purchase Status: REQUIREMENTS_CONFIRMED
--- Step 4-7: Evaluate Multi-Item Procurement Plan ---
Strategies Evaluated: 3
- Strategy [strat_lowest_landed_cost]: "Lowest Landed Cost (Policy-Derived)" | Feasibility: feasible | Landed: $2000.00
- Strategy [strat_consolidated_single_retailer]: "Consolidated (bestbuy.com)" | Feasibility: feasible | Landed: $2010.00
--- Step 8: Buyer Approves Strategy ---
Approve Strategy Status: 200
Approved Purchase Status: APPROVED
--- Reload & Persisted Snapshot Inspection ---
Persisted Snapshot Hash matches: true
--- Step 9: Material Destination Change Staleness Invalidation ---
Re-evaluated for Alaska (99501) Status: 200
--- Step 10: Checkout Boundary Rejection Check ---
Tampered Checkout Status: 400
Tampered Checkout Rejected: true
=== ALL 10 DEMO STEPS VERIFIED SUCCESSFULLY ===
```

---

## 6. Reset & Replay Procedure

To perform a clean replay between demo sessions:
1. Simply click **"New Purchase"** in the top navigation bar to create a fresh purchase ID.
2. Historical purchases and protected test records remain untouched in PostgreSQL.
3. Gate 1 script (`C:\paypal-gate1\gate1.mjs`) remains untouched with SHA-256:  
   `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`

