# Plinthly — Pitch Narrative & Commercial Assurance Manifesto

> **Every purchase. Proven.**  
> Commercial Assurance and Deterministic Policy Verification for Autonomous AI Procurement.

---

## 1. Executive Summary: The Trust Deficit in Agentic Commerce

Autonomous AI agents are beginning to browse the web, compare products, and recommend purchasing actions for enterprises and consumers. However, every corporate procurement officer, CFO, and IT director faces a critical trust barrier before they will ever give an autonomous agent purchasing authority:

1. **The "Base-Price" Illusion**: AI shopping tools evaluate candidates based purely on base sticker price, ignoring shipping policies, regional freight surcharges, and statutory sales taxes that add 5% to 35% to order totals.
2. **The Hallucination of Free Shipping**: Naive LLMs frequently treat missing shipping data as `$0.00`, or hallucinate that split multi-retailer orders will all qualify for free delivery.
3. **The Uncontrolled Checkout Boundary**: Prototypes either ask for unrestricted corporate credit cards or blindly fire checkout calls, risking irreversible over-billing and accidental settlement.

**Plinthly solves this problem.** Plinthly is an **evidence-gated agentic commerce platform** that guarantees every corporate purchase is backed by cryptographic evidence, deterministic policy verification, and zero-variance landed cost before a single cent can be captured.

---

## 2. Core Architectural Separation: Probabilistic Intent vs. Deterministic Policy

Plinthly does not ask a generative AI model to calculate prices, evaluate eligibility, or approve funds. Plinthly enforces a strict architectural boundary:

```
┌────────────────────────────────────────────────────────┐
│ PROBABILISTIC INTERFACE (Google Gemini)                │
│ • Decomposes natural language into structured items    │
│ • Flags missing quantities, specifications, & dates    │
│ • NEVER approves funds or makes financial decisions    │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ DETERMINISTIC ASSURANCE ENGINE (PostgreSQL & TypeScript)│
│ • Exact integer minor-unit cents arithmetic (No floats)│
│ • Multi-merchant shipping threshold evaluation         │
│ • Pareto-optimal split-order cart optimization         │
│ • Cryptographic SHA-256 snapshot binding               │
│ • Model A Landed Cost: Items - Disc + Ship + Tax = Total│
│ • Fail-Closed Database Triggers & Sequential Capture   │
└────────────────────────────────────────────────────────┘
```

### What the AI Does
- Translates messy human requests into typed procurement specifications (e.g., *"I need 5 laptops with 32GB RAM under $1,500 and 5 4K monitors delivered to San Francisco"*).
- Highlights ambiguities and requests human clarification when constraints are missing.

### What the AI Is Never Allowed to Do
- The AI never evaluates whether a candidate meets budget.
- The AI never calculates shipping costs.
- The AI never authorizes checkout or captures funds.

---

## 3. Key Product Capabilities & Differentiators

### 1. Model A Landed Cost with Zero Variance ($\Delta_{\text{landed}} \equiv 0$)
Plinthly enforces an invariant at the database level:
$$\text{Merchandise Subtotal} - \text{Discount} + \text{Shipping Total} + \text{Statutory Tax} \equiv \text{Total Authorized Cents}$$
If there is even a $0.01 discrepancy between what was authorized and what is captured, the checkout gate aborts fail-closed and triggers an emergency P0 alert.

### 2. Relational Multi-Cart Allocation
Enterprise procurement rarely comes from a single merchant. Plinthly dynamically solves the multi-retailer allocation problem:
- It aggregates line items across merchants (Best Buy, Target, Walmart, B&H) to hit free-shipping thresholds ($35/$49 minimums).
- It generates three Pareto-optimal procurement strategies: **Cheapest Landed Cost**, **Fastest Fulfillment**, and **Balanced**.
- It persists the chosen allocation atomically into relational PostgreSQL tables (`ProcurementPlan`, `ApprovalAggregate`, `ApprovedMerchantCart`, `CartAllocation`).

### 3. Non-Bypassable Human-in-the-Loop Approval Gate
Once a plan is allocated, Plinthly computes a canonical SHA-256 snapshot digest across the entire order structure. The buyer reviews the exact breakdown and signs off. If an item is modified, removed, or the shipping destination changes, the snapshot hash mismatches and the approval is instantly invalidated.

### 4. Sequential Multi-Cart Checkout with PayPal Integration
Capturing multiple independent merchant carts simultaneously introduces race conditions and partial failure nightmares. Plinthly executes **monotonic sequential capture**:
- Carts are captured one by one.
- If Merchant B fails or times out, Merchant A remains safely captured, and Merchant B transitions into an isolated retry state.
- Ambiguous timeouts are preserved without premature failure records, precluding double billing.

### 5. Durable Refund Provenance (DEF-P4-01)
Most agentic commerce prototypes overlook post-purchase lifecycle and refunds. Plinthly enforces that every refund intent is committed in PostgreSQL (`CartRefundRecord`) *before* dispatching to the payment gateway. The PayPal idempotency token (`PayPal-Request-Id`) is derived directly from the persisted refund record ID, guaranteeing deterministic retries across worker crashes and restarts.

---

## 4. Market Impact & Financial Defensibility

| Target Audience | Core Pain Point Solved | Plinthly Value Delivered |
| :--- | :--- | :--- |
| **Corporate Procurement** | Unapproved rogue purchases and split-shipping fee creep | Automated multi-retailer optimization that maximizes merchant volume thresholds. |
| **CFOs & Finance Teams** | Unexpected variances between invoice and purchase order | Cryptographically enforced zero-variance landed cost. |
| **Compliance & Internal Audit** | Opaque AI recommendations without audit trails | Immutable SHA-256 event chains and statutory tax attestations. |
| **Autonomous Agent Developers** | Inability to safely connect AI to payment rails | Drop-in, fail-closed purchase assurance infrastructure. |

---

## 5. Why Plinthly Wins

Plinthly is not a chatbot that browses the web. It is a **production-hardened financial system** built on formal relational mathematics, PostgreSQL canonical routines (`R2-01` through `R2-08`), and defensible computer science.

- **1,568 passing tests** prove that concurrency, deadlocks, and edge cases are solved.
- **Production containerization (`Dockerfile`) and telemetry** prove it is ready for deployment.
- **Honest capability disclosures** prove the engineering team builds with unwavering integrity.

**Plinthly: Every purchase. Proven.**

