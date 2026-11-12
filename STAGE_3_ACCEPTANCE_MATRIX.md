# Plinthly Stage 3 Acceptance Matrix

**Version:** 3.0.0  
**Status:** DRAFT — PENDING FORMAL AUTHORIZATION  
**Architectural Baseline:** Approved Stage 3 Architecture Contract v3.0.0  
**Date:** 2026-11-07  
**Scope:** Stage 3 Verification Criteria, Acceptance Tests, Target Metrics, and Pass/Fail Gates  

---

## 1. Acceptance Matrix Overview & Evaluation Framework

This document establishes the binding **Acceptance Matrix** for Plinthly Stage 3. Every capability, security boundary, and operational readiness requirement specified in the **Stage 3 Architecture Contract v3.0.0** is mapped to concrete verification methods, target metrics, and pass/fail gates.

### Status Definitions
- **REQUIRED:** Mandatory condition for phase completion. Failure blocks subsequent phases.
- **PASSED:** Independently verified by automated test suites or live evidence inspection.
- **PENDING:** Planned for execution during the corresponding implementation phase.

---

## 2. Comprehensive Stage 3 Acceptance Matrix

| Section / ID | Requirement & Objective | Verification Method | Target Metric / Expected Result | Pass/Fail Gate |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **PostgreSQL mTLS Workload Identity** | Attempt connection to `plinthly_prod` without client certificate or with untrusted certificate. | PostgreSQL rejects connection with `SSL error: certificate verify failed` or `connection requires a valid client certificate`. | Phase 1 Gate |
| **SEC-02** | **Certificate-to-Role Mapping** | Connect with `tax-verifier` x509 client certificate and query `SELECT current_user, session_user;`. | `current_user` resolves to `tax_verifier_role`. Direct table DML is blocked. Routine `R2-01` executes successfully. | Phase 1 Gate |
| **SEC-03** | **Zero Identity Simulation in Prod** | Run AST static analysis and regex search across all production application code. | Zero (0) occurrences of `SET SESSION AUTHORIZATION` in production code paths. | Phase 1 Gate |
| **SEC-04** | **Dedicated Connection Pool Isolation** | Inspect `Stage3DatabasePoolManager` instance configurations. | Distinct `pg.Pool` instances for Ingress, Orchestrator, Tax, and Admin with independent certs and limits. | Phase 1 Gate |
| **SEC-05** | **KMS Private Key Protection** | Inspect statutory attestation signing service and Cloud KMS configuration. | Private key bytes are never exported, stored in memory, or logged. Signing occurs via KMS asymmetric signing API. | Phase 1 Gate |
| **SEC-06** | **Production OIDC Authentication** | Send API requests to `/api/cart/*` with missing, expired, and forged JWT bearer tokens. | Requests with invalid tokens fail closed with HTTP 401 `unauthorized`. Valid tokens populate verified actor identity. | Phase 1 Gate |
| **PRV-01** | **PayPal Sandbox / Prod Adapter Decoupling** | Inspect `PaymentGatewayClient` factory and runtime binding. | Runtime environment variable binds either `PayPalSandboxGatewayAdapter` or `PayPalProductionGatewayAdapter` with zero code change. | Phase 2 Gate |
| **PRV-02** | **Landed-Cost Zero-Variance Assertion** | Execute capture where PayPal authorized amount differs from quoted landed cost by 1 cent ($0.01). | Capture is aborted fail-closed with `ERR_LANDED_COST_VARIANCE` before invoking PayPal capture API. | Phase 2 Gate |
| **PRV-03** | **Capture Idempotency Header** | Inspect PayPal REST v2 capture request wire logs. | `PayPal-Request-Id` is strictly set to `MerchantCartCapture.id` (UUIDv4). Repeated requests return cached gateway response. | Phase 2 Gate |
| **PRV-04** | **Ambiguous Capture Timeout Handling** | Simulate gateway network drop / 504 Gateway Timeout during PayPal capture call. | Adapter returns `AMBIGUOUS_TIMEOUT`. Cart enters `CAPTURE_PENDING` / `AMBIGUOUS_TIMEOUT`. Zero failure records logged. | Phase 2 Gate |
| **PRV-05** | **Certified Tax Provider Attestation** | Query tax provider adapter (TaxJar/Avalara) and verify C-44A attestation signature. | Attestation matches `PLINTHLY-ATTESTATION-V1` format, verified by PostgreSQL `crypto_asym_verify`, accepted by `R2-01`. | Phase 2 Gate |
| **PRV-06** | **Multi-State Tax Quote Precision** | Calculate tax for line items across 5 distinct US tax jurisdictions (e.g. CA, NY, TX, PA, FL). | Tax calculated to exact minor unit cents with zero rounding drift across line item breakdowns. | Phase 2 Gate |
| **WHK-01** | **Fast-Ack Webhook Ingress** | Load-test `/api/webhooks/paypal` with 50 concurrent valid webhook events. | 100% of requests return HTTP 200 within $< 300\text{ms}$. Raw payloads logged to `WebhookTransmissionRecord` via `R2-03`. | Phase 3 Gate |
| **WHK-02** | **Asynchronous Queue & Retry Backoff** | Enqueue webhook event; simulate transient database lock contention. | Event is retried with exponential backoff (1s, 5s, 30s). Successful execution invokes `R2-04`. | Phase 3 Gate |
| **WHK-03** | **Dead Letter Queue (DLQ) & Alerting** | Submit webhook event that consistently fails processing 5 times. | Event moved to DLQ. P1 operational alert fired. Event retained in DLQ for manual inspection. | Phase 3 Gate |
| **WHK-04** | **Ambiguous Capture Background Recovery** | Create cart in `AMBIGUOUS_TIMEOUT`; run `AmbiguousCaptureReconciliationWorker`. | Worker queries PayPal GET API, discovers completed capture, and executes `confirm_cart_capture` (R2-05). | Phase 3 Gate |
| **UI-01** | **Stage 2 Client API Parity** | Verify all Stage 2 endpoints have typed methods in `lib/workflow/stage2-client-api.ts`. | 100% TypeScript type coverage with Zod validation for `quoteTax`, `checkoutCart`, `captureCart`. | Phase 4 Gate |
| **UI-02** | **Multi-Retailer Cart Allocation** | Input multi-item procurement request; inspect `MultiItemProcurementStudio`. | Items are grouped into distinct retailer carts with visual shipping threshold indicators and package splits. | Phase 4 Gate |
| **UI-03** | **AgGrid Landed Cost Comparison** | Inspect `CandidateComparisonGrid` with candidate offerings from multiple merchants. | Grid displays unit price, shipping, quoted statutory tax, and total landed cost. Sorting and filtering verified. | Phase 4 Gate |
| **UI-04** | **Interactive Evidence Provenance Drawer** | Click offer in comparison grid to open evidence drawer. | Drawer renders raw candidate JSON, timestamp provenance, screenshot verification, and policy pass/fail tags. | Phase 4 Gate |
| **UI-05** | **Stage 2 Buyer Approval Modal** | Click "Proceed to Checkout" in UI with multiple merchant carts. | Modal displays landed-cost breakdown, verifies zero-variance guarantee, and locks carts via `POST /api/cart/checkout`. | Phase 4 Gate |
| **UI-06** | **PayPal Smart Buttons Capture Orchestration** | Complete PayPal sandbox approval flow in `PayPalMultiCartCheckout`. | Carts captured sequentially; progress bars update in real time; completed state transitions to receipt view. | Phase 4 Gate |
| **OPS-01** | **Container Build & Hardening** | Build production Docker image via `Dockerfile`. | Image builds cleanly, contains no dev dependencies, runs as non-root user (`USER node`), zero high/critical CVEs. | Phase 5 Gate |
| **OPS-02** | **Structured JSON Telemetry** | Inspect application stdout under load. | All logs emit single-line JSON adhering to schema with `timestamp`, `level`, `traceId`, `actorId`, `cartId`, `durationMs`. | Phase 5 Gate |
| **OPS-03** | **OpenTelemetry Metric Emission** | Scrape Prometheus metrics endpoint `/metrics`. | Metrics `plinthly_cart_capture_total`, `plinthly_landed_cost_variance_cents`, and pool utilization present and valid. | Phase 5 Gate |
| **OPS-04** | **P0 Landed Cost Variance Alert** | Inject test event with non-zero landed cost variance into telemetry pipeline. | P0 alert fires immediately to PagerDuty / On-Call with full trace context. | Phase 5 Gate |
| **OPS-05** | **Capture Triage CLI Tool** | Execute `scripts/ops/reconcile-gateway-order.ts` against sandbox order. | Tool queries PayPal API, displays authoritative state, and executes R2-05/R2-07 reconciliation safely. | Phase 5 Gate |
| **OPS-06** | **End-to-End Staging Sandbox Run** | Execute `tests/e2e/stage3-sandbox-e2e.test.ts` against real PayPal sandbox accounts. | Complete flow: discovery $\rightarrow$ quote tax $\rightarrow$ checkout $\rightarrow$ PayPal capture $\rightarrow$ webhook reconciliation passes 100%. | Phase 5 Gate |
| **REG-01** | **Stage 1 Baseline Data Preservation** | Execute database assertion query against `plinthly_dev`. | Exactly 40 purchases, 6 payment attempts, 0 Stage 2 tables. Quarantined purchase `pur_1793274041667_01rg028x` is `ORDER_CREATED`. | Gate 3 Final |
| **REG-02** | **Gate 1 Script & Backup Hash Integrity** | Compute SHA-256 of `gate1.mjs` and `.backups/plinthly_dev_stage1_baseline.dump`. | Backup hash matches `EF546EE9...`; Gate 1 script hash matches `F0449D22...` exactly. | Gate 3 Final |
| **REG-03** | **Stage 2 Regression Suite 100% Pass** | Execute `npm test` across repository. | All 101 test files (1,467+ tests) pass with zero failures. TypeScript check exits 0. | Gate 3 Final |
| **REG-04** | **Zero Live Financial Transactions** | Audit gateway egress traffic during all testing and audit phases. | Zero calls to `api.paypal.com`. All tests strictly target sandbox or mock adapters. | Gate 3 Final |

---

## 3. Phase Gate Checkpoint Criteria

### Checkpoint 1 (End of Phase 1: Production Security)
- [ ] Tests `SEC-01` through `SEC-06` pass with 100% coverage.
- [ ] AST static analysis confirms zero `SET SESSION AUTHORIZATION` in production paths.
- [ ] All database pools verify mTLS connection and role scoping.
- [ ] Deliverable: `STAGE_3_PHASE_1_SECURITY_REPORT.md`.

### Checkpoint 2 (End of Phase 2: Live Provider Adapters)
- [ ] Tests `PRV-01` through `PRV-06` pass with 100% coverage.
- [ ] PayPal v2 Orders capture and refund operations verified in sandbox environment.
- [ ] Zero-variance landed cost invariant strictly enforced before gateway capture.
- [ ] Statutory tax attestation successfully verifies in PostgreSQL via R2-01.
- [ ] Deliverable: `STAGE_3_PHASE_2_PROVIDER_REPORT.md`.

### Checkpoint 3 (End of Phase 3: Webhook Queueing & Reconciliation)
- [ ] Tests `WHK-01` through `WHK-04` pass with 100% coverage.
- [ ] Webhook ingress fast-ack verified under load ($< 300\text{ms}$).
- [ ] Asynchronous retry backoff, DLQ routing, and ambiguous capture recovery verified.
- [ ] Deliverable: `STAGE_3_PHASE_3_RECONCILIATION_REPORT.md`.

### Checkpoint 4 (End of Phase 4: Product Integration & UI Modernization)
- [ ] Tests `UI-01` through `UI-06` pass with 100% coverage.
- [ ] Multi-retailer procurement studio groups candidate offerings by merchant.
- [ ] AgGrid candidate comparison grid and evidence provenance drawer verified.
- [ ] Buyer approval modal and PayPal Smart Buttons multi-cart checkout operational.
- [ ] Deliverable: `STAGE_3_PHASE_4_PRODUCT_REPORT.md`.

### Checkpoint 5 (End of Phase 5: Gate 3 Production Readiness Review)
- [ ] Tests `OPS-01` through `OPS-06` pass with 100% coverage.
- [ ] Regression assertions `REG-01` through `REG-04` confirmed intact.
- [ ] Full test suite (`npm test`) passes with 100% success rate.
- [ ] Independent final audit completed with verdict **ACCEPTED**.
- [ ] Deliverable: `STAGE_3_FINAL_ACCEPTANCE_AUDIT.md`.

