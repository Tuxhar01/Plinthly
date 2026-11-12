# Plinthly — Feature & Capability Disclosure
## Honest Operational Boundaries & Execution Environment Guide

**Version:** 1.0.0  
**Target Audience:** Hackathon Judges, Security Evaluators, Commercial Partners  
**Core Brand Promise:** *Every purchase. Proven.*  

---

## 1. Executive Disclosure Policy

To ensure complete transparency and engineering integrity, Plinthly strictly delineates its execution boundaries. This document specifies which subsystems operate against live external cloud APIs, which operate against local database infrastructure, and which operate within controlled sandbox or mock adapters.

**Under no circumstances does Plinthly execute live money movement or charge real credit cards.**

---

## 2. Operational Subsystem Matrix

| Subsystem | Execution Boundary | Operational Details & Guarantees | Fallback / Offline Behavior |
| :--- | :---: | :--- | :--- |
| **Natural Language Intent Parsing** | **Live External API** | Uses Google Gemini (`@google/genai`) to parse unstructured buyer prompts into typed line items, budgets, and specifications. | If `GEMINI_API_KEY` is absent or rate-limited, falls back to deterministic local rule parser or pre-populated draft templates. |
| **Multi-Retailer Product Discovery** | **Live API / Local Fixtures** | Queries Channel 3 multi-retailer commerce search endpoint for real-time catalog listings across Best Buy, Target, Walmart, and Amazon. | If external API key is absent or upstream quotas are exceeded, seamlessly serves recorded candidate fixtures marked `[DEMO FIXTURE]`. |
| **Deterministic Policy & Landed Cost** | **Authoritative Local Code** | Minor-unit integer cents arithmetic (`BigInt`). Evaluates geographic eligibility, contiguous US shipping thresholds, and tax evidence without floating-point math. | 100% deterministic local execution. Zero reliance on external network calls. |
| **Relational Cart Allocation** | **Authoritative Local Database** | Executes inside PostgreSQL `plinthly_stage2_dev`. Inserts `ProcurementPlan`, `ProcurementLineItem`, `ApprovalAggregate`, `ApprovedMerchantCart`, and `CartAllocation` within serializable transactions. | Fails closed on any line item over- or under-allocation or unit price cap violation. |
| **Purchase Assurance Approval Gate** | **Authoritative Local Database** | Generates SHA-256 snapshot hashes of the exact approved multi-item terms. Enforces zero-variance landed-cost assertion ($\Delta_{\text{landed}} \equiv 0$). | Any material term change immediately invalidates approval snapshot and blocks checkout. |
| **PayPal Multi-Cart Checkout** | **Sandbox / Mock Gateway Adapter** | Coordinates sequential capture across merchant carts. Dispatches to `MockPaymentGatewayClient` simulating PayPal REST v2 Vault and Order Capture endpoints. | Carts transition to `CAPTURING` awaiting authenticated webhook confirmation or triage reconciliation (`R2-05`). |
| **Settlement Receipts & Evidence** | **Authoritative Local Database** | Renders tamper-evident receipts reading immutable `PaymentEvidenceRecord` and `ApprovalAggregate` from PostgreSQL. | Shows captured amount, transaction IDs, and zero-variance landed cost. |
| **Refund Provenance (DEF-P4-01)** | **Authoritative Local Database** | Enforces DEF-P4-01: commits `CartRefundRecord` with `INITIATED` status and derives `PayPal-Request-Id` directly from persisted refund record ID. | Validates remaining refundable balance; prevents concurrent over-refunding. |
| **Telemetry & Observability** | **Authoritative Local Runtime** | Structured JSON logging (`OPS-02`), Prometheus metrics registry at `/api/metrics` (`OPS-03`), P0 landed-cost alerting (`OPS-04`), triage CLI tool (`OPS-05`). | 100% local emission without external telemetry vendors required. |

---

## 3. Detailed Boundary Clarifications for Evaluators

### 1. Payment Processing Disclosure
- In the local judge/demo testbed, the cart capture (`POST /api/cart/capture`) and refund (`POST /api/cart/refund`) routes instantiate the `MockPaymentGatewayClient`.
- This ensures **zero financial risk** for evaluators and allows deterministic simulation of success, failure, and ambiguous timeout scenarios without requiring live sandbox merchant funds or PayPal login credentials.
- The state machine, monotonic status triggers, sequential execution loop, and idempotent recovery routines are 100% genuine production PostgreSQL routines (`R2-01` through `R2-08`).

### 2. Merchant Offer Discovery Disclosure
- When testing live product discovery via `POST /api/discovery/search`, Plinthly communicates with the Channel 3 commerce API if `CHANNEL3_API_KEY` is present.
- If the external API key is omitted, or if the upstream SaaS provider experiences rate limiting, Plinthly automatically serves high-fidelity, verified candidate fixtures. Every fixture is clearly prefixed with `[DEMO FIXTURE]` in the UI to prevent any confusion.

### 3. Tax Evidence Disclosure
- In production, tax calculations require cryptographically attested tax quotes from authorized statutory tax authorities.
- In the demonstration and test environments, Plinthly uses a cryptographically signed synthetic tax oracle (`SYNTHETIC_TEST_TAX_AUTHORITY`) to demonstrate HMAC-SHA256 signature verification, certificate expiration checking, and tamper detection without incurring paid third-party tax API fees.

### 4. Database Isolation Disclosure
- Plinthly maintains two completely isolated PostgreSQL databases:
  1. `plinthly_dev`: The pristine Stage 1 baseline database containing 40 purchases, 6 payment attempts, and 0 Stage 2 tables. Strictly read-only and verified by SHA-256 hashes (`Gate 1` and `Dump`).
  2. `plinthly_stage2_dev`: The active development and staging database where all Stage 2 and Stage 3 relational tables, canonical routines (`R2-01` to `R2-08`), triggers, and audit logs reside.

