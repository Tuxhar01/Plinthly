# Plinthly

> **Every purchase. Proven.**  
> Commercial Assurance and Deterministic Policy Verification for Autonomous AI Procurement.

Built for the **PayPal AI Hackathon** (Submission Deadline: November 12, 2026, 12:00 PM Pacific Time).

---

## 1. Overview & The Commercial Assurance Problem

When autonomous AI agents or automated procurement workflows select products on behalf of enterprise buyers, they encounter a fatal trust gap:
- **The "Base-Price" Illusion:** AI shopping tools evaluate candidates based purely on base sticker price, ignoring shipping policies, regional freight surcharges, and statutory sales taxes that add 5% to 35% to order totals.
- **The Hallucination of Free Shipping:** Naive LLMs frequently treat missing shipping data as `$0.00`, or hallucinate that split multi-retailer orders will all qualify for free delivery.
- **The Uncontrolled Checkout Boundary:** Prototypes either ask for unrestricted corporate credit cards or blindly fire checkout calls, risking irreversible over-billing and accidental settlement.

**Plinthly** is an **evidence-gated AI procurement agent**. Its defining capability is that **every purchasing decision must be supported by verifiable evidence, deterministic policy verification, and buyer approval bound to an exact offer snapshot with zero landed-cost variance.**

---

## 2. System Architecture: Probabilistic Intent vs. Deterministic Policy

Plinthly enforces an architectural separation between natural-language understanding and procurement execution:

```
┌────────────────────────────────────────────────────────┐
│ PROBABILISTIC INTERFACE (Google Gemini)                │
│ • Decomposes natural language into structured items    │
│ • Extracts budget, quantity, and technical specs       │
│ • Flags unresolved ambiguities and confidence limits   │
│ • NEVER makes purchasing decisions or approves funds   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ DETERMINISTIC ASSURANCE ENGINE (PostgreSQL & Next.js)  │
│ • Non-floating-point monetary evaluation (BigInt cents)│
│ • Multi-merchant shipping threshold evaluation         │
│ • Pareto-optimal split-order cart optimization         │
│ • Cryptographic SHA-256 snapshot binding               │
│ • Model A Landed Cost: Items - Disc + Ship + Tax = Total│
│ • Fail-Closed Database Triggers & Sequential Capture   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ PAYPAL SANDBOX BOUNDARY & RECONCILIATION               │
│ • Sequential multi-cart capture across merchant carts  │
│ • PayPal-Request-Id idempotency & fast-ack webhook queue│
│ • DEF-P4-01 pre-persisted refund intent derivation     │
└────────────────────────────────────────────────────────┘
```

---

## 3. Key Capabilities & Differentiators

1. **Evidence-Backed Model A Landed Cost ($\Delta_{\text{landed}} \equiv 0$):**
   $$\text{Merchandise Subtotal} - \text{Discount} + \text{Shipping Total} + \text{Statutory Tax} \equiv \text{Total Authorized Cents}$$
   Reconciles authoritative evidence and validated quotes down to the exact minor unit cent before approval. Unknown shipping or statutory tax remains explicitly unknown and fails closed (`UNQUOTED_SHIPPING_BLOCKED`); estimated amounts are never silently converted into verified evidence.
2. **Relational Multi-Cart Allocation:**
   Partitions multi-item baskets across multiple merchants (Best Buy, B&H Photo, Target, Walmart) to satisfy line-item completeness, evaluate free shipping thresholds, and minimize total landed cost.
3. **Non-Bypassable Human-in-the-Loop Approval:**
   Computes canonical SHA-256 snapshot digests. If any item, price, or delivery destination changes after approval, the snapshot hash mismatches and checkout is blocked.
4. **Sequential Multi-Cart Checkout with PayPal Sandbox:**
   Captures approved carts monotonically one by one with multi-merchant failure isolation. Ambiguous network timeouts are safely preserved without duplicate billing.
5. **Durable Refund Provenance (DEF-P4-01):**
   Commits `CartRefundRecord` in PostgreSQL *before* gateway dispatch, deriving the PayPal `PayPal-Request-Id` directly from the persisted record ID.

---

## 4. Quick Start & Judge Evaluation Paths

Plinthly supports two unmistakable, fully separated evaluation paths:

### Mode A: Local Demo Mode (Simulated Testbed — Zero Private Credentials)
Designed for immediate, frictionless hackathon judging without requiring private API keys or merchant sandbox accounts:
- **No Private Credentials:** Runs completely offline or with local Docker PostgreSQL.
- **Simulated Testbed:** Uses synthetic procurement catalog fixtures and local simulated payment execution (`MockPaymentGatewayClient`).
- **Zero Ambiguity:** Never claims that PayPal processed a payment in this mode.
- **Explicit Badging:** Checkout is clearly labeled `Local Demo Mode (Simulated Payment — No External PayPal Call)`, and simulated capture IDs are prefixed `Simulated Capture: CAP-... (Local Demo)`.
- **Honest Attestation:** Receipts display `Ledger: Cryptographic Purchase Attestation (Model A Landed Cost)` and denote simulated settlement.

```bash
# 1. Install dependencies
npm install

# 2. Start Next.js development server on port 3000
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser and click **"Load Demo Fixture"**, then click **"Evaluate Multi-Item Plan"** to inspect deterministic planning and simulated settlement.

### Mode B: PayPal Sandbox Mode (Live Developer Platform REST v2)
Connects directly to the live PayPal Developer Platform Sandbox (`api-m.sandbox.paypal.com`):
- **Requires Valid Sandbox Credentials:** Requires `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env.local` with `PAYPAL_MODE=sandbox`.
- **Real REST API:** Uses live PayPal REST v2 endpoints for OAuth2 tokens, order creation (`intent: "AUTHORIZE"`), and sequential captures.
- **Real Buyer Approval:** Launches the genuine PayPal Sandbox buyer checkout portal (`https://www.sandbox.paypal.com/checkoutnow?token={orderId}`) where a test buyer logs in and approves funds.
- **Server-Side Verified Payment:** Reports payment completion only after PayPal returns genuine status `COMPLETED` and server-side PostgreSQL records verify payment evidence.

1. **Configure Environment in `.env.local`:**
   ```env
   PAYPAL_CLIENT_ID=your_sandbox_client_id
   PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
   PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_MODE=sandbox
   ```
2. **Execute Live PayPal Sandbox Integration Suite:**
   PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
   PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_MODE=sandbox
   ```
2. **Execute Live PayPal Sandbox Integration Suite:**
   ```bash
   npx vitest run tests/integration/paypal-sandbox-live.test.ts
   ```
   *Verifies live OAuth2 token exchange (`POST /v1/oauth2/token`), order creation with `intent: "AUTHORIZE"` (`POST /v2/checkout/orders`), authoritative order retrieval (`GET /v2/checkout/orders/{id}`), and fail-closed intent rejection directly against PayPal servers.*
3. **Interactive Buyer Approval Walkthrough:**
   * An order created in PayPal Sandbox returns a genuine HATEOAS approval link (`https://www.sandbox.paypal.com/checkoutnow?token={orderId}`).
   * The judge visits this link in any browser, logs in with a personal PayPal Sandbox test buyer account (`sb-buyer@personal.example.com`), and clicks **"Continue"**.
   * Once approved, the multi-retailer capture route (`POST /api/cart/capture`) executes sequential capture via `PayPalSandboxGatewayAdapter`.
4. **Empirical Evidence Report:**
   * Consult **[`PAYPAL_SANDBOX_E2E_EVIDENCE.md`](PAYPAL_SANDBOX_E2E_EVIDENCE.md)** for live HTTP traces, response payloads, and sanitized order IDs.

For the full 2-minute-40-second interactive walkthrough script, consult **[`JUDGE_DEMO_RUNBOOK.md`](JUDGE_DEMO_RUNBOOK.md)**.

---

## 5. Verification & Test Suite

The test suite validates concurrency, cryptographic verification, canonical routines, and financial invariants:

```bash
# 1. Run full local regression test suite (114 test files, 1,568 tests)
npm test

# 2. Strict TypeScript typecheck (0 errors)
npx tsc --noEmit

# 3. Prisma schema validation (0 errors)
npx prisma validate

# 4. Next.js production build (19/19 routes compiled & prerendered)
npm run build

# 5. Baseline database integrity verification
node scripts/verify-baseline.js
```
*Result:* **114/114 test files passed, 1,568 tests passed, 0 failures.**

---

## 6. Official Submission Documents

| Document | Description |
| :--- | :--- |
| **[`PAYPAL_SANDBOX_E2E_EVIDENCE.md`](PAYPAL_SANDBOX_E2E_EVIDENCE.md)** | Empirical proof of live PayPal Sandbox API interactions, fail-closed intent gates, and sanitized traces. |
| **[`JUDGE_DEMO_RUNBOOK.md`](JUDGE_DEMO_RUNBOOK.md)** | Sub-3-minute timestamped video script (2m 40s) and step-by-step judge runbook. |
| **[`HACKATHON_OFFICIAL_COMPLIANCE_MATRIX.md`](HACKATHON_OFFICIAL_COMPLIANCE_MATRIX.md)** | Evidence matrix verifying every official PayPal AI Hackathon requirement. |
| **[`HACKATHON_SUBMISSION_CHECKLIST.md`](HACKATHON_SUBMISSION_CHECKLIST.md)** | Submission checklist and action items for final Devpost form. |
| **[`PITCH_NARRATIVE.md`](PITCH_NARRATIVE.md)** | Problem statement, commercial assurance manifesto, and competitive differentiation. |
| **[`TECHNICAL_ARCHITECTURE_OVERVIEW.md`](TECHNICAL_ARCHITECTURE_OVERVIEW.md)** | Engineering blueprint, ER diagrams, canonical routines `R2-01` to `R2-08`. |
| **[`FEATURE_AND_CAPABILITY_DISCLOSURE.md`](FEATURE_AND_CAPABILITY_DISCLOSURE.md)** | Transparent operational boundaries: live cloud APIs vs local DB vs sandbox adapters. |
| **[`HACKATHON_FINALIZATION_REPORT.md`](HACKATHON_FINALIZATION_REPORT.md)** | Final authorization and readiness assessment report. |

---

## 7. License

This project is licensed under the terms of the [MIT License](LICENSE).  
Copyright (c) 2026 Tushar Kumar. All rights reserved.
