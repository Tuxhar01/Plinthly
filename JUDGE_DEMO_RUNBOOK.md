# Plinthly — Official Hackathon Demonstration Runbook & Video Script
## Strict Sub-3-Minute Video Walkthrough (Target: 2 Minutes 40 Seconds)

**Event:** PayPal AI Hackathon  
**Target Duration:** **2 minutes 40 seconds (160 seconds)** — *Strictly under the 3:00 minute rule*  
**Platform:** Next.js 16.4.2 / PostgreSQL 16.15 / PayPal Sandbox  
**Video Requirement:** Public YouTube URL showing live screen capture of functioning application  
**Brand Promise:** *Every purchase. Proven.*  

---

## 1. Pre-Recording Setup & Environment Checklist

Before hitting record, ensure your local environment is configured:

```bash
# 1. Start application on localhost:3000
npm run dev

# 2. In browser, open http://localhost:3000
# 3. Verify health endpoint: http://localhost:3000/api/health -> {"status":"UP"}
# 4. Verify Prometheus metrics: http://localhost:3000/api/metrics
```

### Video Recording Rules Checklist (Official Compliance)
- [x] **Duration Check**: Total video length must be **under 3 minutes** (Target: 2m 40s).
- [x] **No Copyrighted Audio**: Do not use commercial background music. Use voiceover only or royalty-free audio.
- [x] **No Third-Party Trademarks**: Avoid showing unauthorized corporate logos outside merchant candidate references.
- [x] **Real Working Prototype**: Record actual web browser interaction; no static slide decks or Figma mockups.
- [x] **Honest Gateway Disclosure**: Highlight the clear environment badge (`Local Demo Mode (Simulated Payment — No External PayPal Call)` when running without credentials, or `PayPal Sandbox Mode` when connected).
- [x] **Evidence-Backed Landed Cost**: Use precise terminology: authoritative carrier quotes and validated statutory tax, with unquoted shipping failing closed. Never claim "guaranteed tax" without evidence.

---

## 2. Minute-by-Minute Timestamped Video Script

```
0:00 ──────────────── 0:25 ──────────────── 0:50 ──────────────── 1:20 ──────────────── 1:50 ──────────────── 2:20 ─── 2:40
│ Problem Statement  │ AI Intent Parsing  │ Offer Discovery    │ Relational Allocation│ PayPal Multi-Cart    │ Receipts & Refund
│ & Brand Promise    │ (Google Gemini)    │ & Landed Cost      │ & Approval Lock      │ Sequential Checkout  │ (DEF-P4-01)
```

### Segment 1: The Problem & Brand Promise (0:00 – 0:25 | 25s)
- **On Screen**: Browser open at `http://localhost:3000`. Highlight top banner: *"Plinthly Purchase Assurance — Every purchase. Proven."* with the *Stage 3 Certified* and *Model A* badges.
- **Voiceover**:
  > *"When autonomous AI agents procure equipment for enterprises, modern finance teams face a fatal trust gap: hidden shipping fees, hallucinated terms, and unapproved checkouts. Plinthly is an evidence-gated agentic commerce platform built for the PayPal AI Hackathon. Our defining promise is: Every purchase. Proven. We guarantee that every purchase is mathematically constrained, evidence-backed, and approved with zero landed-cost variance before a single cent is captured."*

### Segment 2: AI-Assisted Intent Interpretation with Google Gemini (0:25 – 0:50 | 25s)
- **On Screen**: In **Purchase Request Card** (Stage 1), enter the prompt:
  `I need a developer workstation: 32GB RAM laptop under $1,500, a 4K monitor under $400, and a USB-C dock under $150 delivered to 98101.`
  Click **"Decompose Request with AI"** (or click **"Create Purchase Request"**).
- **Voiceover**:
  > *"We start with unstructured natural language. Google Gemini decomposes the prompt into typed procurement specifications—extracting RAM, resolution, and budgets while flagging missing quantities. But notice our core architectural boundary: Gemini parses intent, but never makes purchasing decisions, never evaluates candidate eligibility, and never authorizes funds. Deterministic code retains full control."*

### Segment 3: Evidence-Backed Discovery & Zero-Variance Landed Cost (0:50 – 1:20 | 30s)
- **On Screen**: View transitions to **Multi-Item Procurement Studio**. Click **"Load Demo Fixture"**, then click **"Evaluate Multi-Item Plan"**. Show comparison between **Consolidated** ($2,010.00) and **Lowest Landed Cost** ($2,000.00) strategies. Point to the `✓ All 3 Items Covered` badges and the exact landed-cost breakdown.
- **Voiceover**:
  > *"Plinthly discovers candidates across verified merchants. Unlike naive shopping agents that assume missing shipping is free, Plinthly strictly enforces Model A Landed Cost: Base Price plus Carrier Shipping plus Statutory Tax. Unquoted shipping fails closed. We distinguish authoritative quotes from estimates. The Lowest Landed Cost strategy splits items across Best Buy and B&H Photo, unlocking free shipping thresholds while keeping all requested items strictly accounted for."*

### Segment 4: Atomic Cart Allocation & Purchase Assurance Approval Gate (1:20 – 1:50 | 30s)
- **On Screen**: Select strategy and click **"Approve & Open Multi-Cart Checkout Gate"**. The **Stage 2 Approval Modal** appears. Point to the green **"Zero Variance Verified"** badge ($\Delta = \$0.00$) and the SHA-256 Snapshot Digest. Click **"Lock Carts & Proceed to Checkout"**.
- **Voiceover**:
  > *"When the buyer selects an evidence-backed strategy, Plinthly executes an atomic PostgreSQL transaction, partitioning line items into discrete merchant carts. The Approval Modal displays the canonical SHA-256 snapshot hash and verifies zero landed-cost variance down to the exact minor unit cent. The buyer approves, locking the carts against price tampering or product substitution."*

### Segment 5: Multi-Cart Checkout (Local Demo vs PayPal Sandbox) (1:50 – 2:20 | 30s)
- **On Screen**: Automatically navigates to **3. Multi-Cart Checkout**. Point out the honest badge: `Local Demo Mode (Simulated Payment — No External PayPal Call)`. Click **"Execute Sequential Multi-Cart Capture"**. The progress bar moves from 0% to 100%, and carts transition from `BUYER_APPROVED` $\to$ `CAPTURING` $\to$ `CAPTURED`. Show simulated capture IDs clearly marked.
- **Voiceover**:
  > *"In checkout, Plinthly supports two unmistakable modes: Local Demo Mode with simulated testbed payments for zero live risk, and genuine PayPal Sandbox Mode using the REST v2 API. Here in Local Demo Mode, we simulate sequential capture with multi-merchant failure isolation. When PayPal Sandbox credentials are configured, Plinthly executes genuine authorized captures against api-m.sandbox.paypal.com with stable idempotency keys."*

### Segment 6: Settlement Receipts & DEF-P4-01 Refund Provenance (2:20 – 2:40 | 20s)
- **On Screen**: Click **"Proceed to Settlement Receipts"**. View **Stage 2 Purchase Receipt**. Click **"Initiate Partial Refund"** on Cart #1, enter `$20.00`, click **"Confirm Refund"**. Show the updated balance and audit log.
- **Voiceover**:
  > *"Here is the settlement receipt. Every cent captured matches authorized terms. Under DEF-P4-01, our refund engine pre-persists refund intent in PostgreSQL before gateway dispatch, binding the PayPal-Request-Id to prevent double-refunding. Plinthly: Every purchase. Proven."*

---

## 3. Fast-Track Alternative for Emergency Re-Recording

If you need a 60-second backup take:
1. Load **"Sample 1: pur_1792633876502_s7jvwi22"** from the top dashboard switcher.
2. Walk through Tab 1 (Planning) $\to$ Tab 3 (Checkout) $\to$ Tab 4 (Receipts) $\to$ Tab 5 (Audit Trail) in 60 seconds.

---

## 4. Post-Recording YouTube Upload Instructions

1. **Title**: `Plinthly — Agentic Commerce & Purchase Assurance (PayPal AI Hackathon)`
2. **Description**: Include tagline (*Every purchase. Proven.*), GitHub repository URL, and brief architecture overview.
3. **Visibility**: Select **Public** or **Unlisted** (Devpost judges must be able to view without login).
4. **Copy Link**: Paste the final YouTube URL into `HACKATHON_SUBMISSION_CHECKLIST.md` and the Devpost submission form.

---

## 5. Judge Evaluation Modes (Local Quickstart vs Live PayPal Sandbox)

Judges can verify Plinthly through two distinct, transparent paths:

### Mode A: Local Demo Mode (Synthetic Testbed — Zero Configuration)
- **Use Case:** Immediate, 100% free evaluation of the complete multi-item planning, candidate comparison, relational allocation, snapshot approval, simulated multi-cart checkout, and cryptographic receipt ledger.
- **Credentials:** None required.
- **Gateway Binding:** `MockPaymentGatewayClient`.
- **UI Labeling:** The checkout screen is labeled `Local Demo Mode (Simulated Payment — No External PayPal Call)`, and simulated capture IDs are clearly identified as `Simulated Capture: CAP-... (Local Demo)`.
- **Zero Payment Claims:** In this mode, Plinthly never claims to have contacted PayPal or processed live funds.
- **Step-by-Step Instructions:**
  1. Start the application:
     ```bash
     npm install
     npm run dev
     ```
  2. Open `http://localhost:3000` in your browser.
  3. In the Multi-Item Procurement Studio, click **"Load Demo Fixture"** to load the synthetic 3-item workstation package.
  4. Click **"Evaluate Multi-Item Plan"** to evaluate the four strategies (Consolidated $2,010.00, Lowest Landed Cost $2,000.00, Balanced Optimal, Verified Direct Retailer).
  5. Select a strategy and click **"Approve & Open Multi-Cart Checkout Gate"**.
  6. Inspect the zero-variance breakdown and SHA-256 snapshot in the Approval Modal, then click **"Lock Carts & Proceed to Checkout"**.
  7. On the checkout screen, click **"Execute Sequential Multi-Cart Capture"** to execute simulated sequential capture.
  8. Click **"View Receipts"** to inspect the settlement receipt and audit log.

### Mode B: Genuine PayPal Developer Sandbox
- **Use Case:** Independent verification against real PayPal Developer Platform endpoints (`api-m.sandbox.paypal.com`).
- **Required Environment Variables in `.env.local`:**
  ```env
  PAYPAL_CLIENT_ID=your_sandbox_client_id
  PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
  PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
  PAYPAL_MODE=sandbox
  ```
- **Real REST API Verifications:**
  ```bash
  npx vitest run tests/integration/paypal-sandbox-live.test.ts
  ```
- **Live Verifications Performed:**
  1. Genuine OAuth2 token grant (`POST /v1/oauth2/token`).
  2. Order creation with explicit `intent: "AUTHORIZE"` (`POST /v2/checkout/orders`).
  3. Authoritative order query (`GET /v2/checkout/orders/{orderId}`).
  4. Fail-closed intent validation (rejects immediate capture on `AUTHORIZE` order with HTTP 422).
  5. Fail-closed payer approval validation (rejects authorization before buyer approval with HTTP 422).
- **Interactive Buyer Approval & Reproduction:**
  1. Run order creation route or test to generate a PayPal Sandbox order.
  2. Open the returned HATEOAS approval URL (`https://www.sandbox.paypal.com/checkoutnow?token={orderId}`) in a browser.
  3. Log in with a PayPal Sandbox personal buyer account (`sb-buyer@personal.example.com`) and click **"Continue"**.
  4. Run sequential capture: Plinthly invokes `PayPalSandboxGatewayAdapter`, capturing the approved authorization via PayPal REST v2.
  5. Server-side payment evidence is permanently recorded in PostgreSQL (`PaymentEvidenceRecord`), and the cart status transitions to `CAPTURED`.
- **Existing Sandbox Verification Trail:**
  - Order ID: `4MT765021L9327907`
  - Authorization ID: `1M90703724668745L`
  - Capture ID: `96R089931P172015F` ($25.00 USD)
  - Partial Refund ID: `9WM63969PS2795349` ($5.00 USD)
  - Full Evidence Log: Consult [`PAYPAL_SANDBOX_E2E_EVIDENCE.md`](PAYPAL_SANDBOX_E2E_EVIDENCE.md).
