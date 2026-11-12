# Plinthly Stage 3 Architecture Contract

**Version:** 3.0.0  
**Status:** DRAFT — PENDING FORMAL AUTHORIZATION  
**Architectural Baseline:** Approved Stage 2 Architecture Contract v2.0.11 & Frozen Phases 0–5  
**Date:** 2026-11-07  
**Scope:** Production Security, Live Provider Integration, Product UI Modernization, and Operational Readiness  

---

## 1. Executive Framing & Architectural Principles

### 1.1 Purpose & Mandate
This Architecture Contract governs **Stage 3** of the Plinthly platform. Stage 2 established an authoritative, relationally governed procurement and payment state engine in PostgreSQL (`plinthly_stage2_dev`), featuring 8 canonical `SECURITY DEFINER` routines, strict monotonic locking, Model A Landed Cost zero-variance enforcement, certificate-pinned webhook ingress, and comprehensive Section 10 acceptance tests.

Stage 3 transitions Plinthly from an audited, isolated developmental baseline into a **production-hardened, operational enterprise procurement platform**. Stage 3 does not redesign or modify the settled relational schemas or canonical SQL routines of Stage 2. Instead, it encapsulates them within genuine production infrastructure:
1. **Workload Identity & Production Security:** Replacing development-only session simulation (`SET SESSION AUTHORIZATION`) with genuine PostgreSQL mutual TLS (mTLS) workload identity and role-segregated connection pools.
2. **Provider Integration:** Implementing production-grade adapters for live payment capture (PayPal v2 Orders REST API) and certified statutory tax calculation engines (TaxJar / Avalara AvaTax), backed by resilient webhook queuing and automated reconciliation.
3. **Product & User Interface Integration:** Connecting the existing Next.js / React procurement dashboard to the Stage 2 multi-cart APIs, integrating AgGrid evidence comparison, and providing real-time multi-merchant buyer approval and capture tracking.
4. **Operational Readiness:** Establishing containerized deployment architectures, OpenTelemetry structured logging and distributed tracing, real-time alert definitions, and audited incident recovery playbooks.

### 1.2 Non-Negotiable Architectural Invariants

| ID | Name | Formal Statement | Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **INV-301** | **Stage 1 & 2 Preservation** | Stage 1 baseline data (`plinthly_dev`) and Stage 2 relational schemas/routines (`plinthly_stage2_dev`) must remain permanently intact and backward compatible. Historical migrations are frozen. | Continuous SHA-256 hash assertions on baseline dump and Gate 1 verification script; isolated migration directories. |
| **INV-302** | **Zero-Variance Landed Cost** | At buyer checkout and payment capture, the sum of merchant subtotals, shipping, and quoted statutory tax must exactly equal the total charged to the buyer in minor units ($|\Delta| = 0$). No payment gateway capture may proceed if currency or amount differs by $\ge 1$ cent. | Canonical routine `prepare_order_authorization` (R2-02) and pre-capture assertion in `CartCaptureService`. |
| **INV-303** | **Production Workload Identity** | Application tiers and workers must authenticate to PostgreSQL using individual x509 client certificates mapped to specific database roles. No application worker may connect as `postgres` or execute `SET SESSION AUTHORIZATION` in production. | PostgreSQL `clientcert=verify-full`, `pg_ident.conf` role maps, and `ProductionConnectionFactory`. |
| **INV-304** | **Cryptographic Key Boundary** | Private keys used to sign statutory tax attestations or verify internal tokens must reside within a hardware security module (HSM) or Cloud KMS. Private key bytes must never be logged, persisted to disk, or transmitted over plain HTTP. | `KmsSignerAdapter` / PKCS#11 provider abstraction; public keys registered in `AuditSigningKey` via R2-08. |
| **INV-305** | **Ambiguous Capture Fail-Closed** | A network timeout, gateway 5xx error, or ambiguous HTTP response during payment capture must never be recorded as a payment failure or assumed uncaptured. The cart must enter `CAPTURE_PENDING` / `AMBIGUOUS_TIMEOUT` until authoritatively reconciled. | Three-state capture gateway output (`COMPLETED`, `FAILED`, `AMBIGUOUS_TIMEOUT`) and `AmbiguousCaptureReconciliationWorker`. |
| **INV-306** | **Wire-Log Immutability** | All inbound webhook payloads and provider responses must be persisted as uncompressed raw `BYTEA` before business logic execution. Wire logs must never be updated or deleted. | PostgreSQL rule/trigger `trg_webhook_transmission_immutability` and `record_paypal_webhook_event` (R2-03). |

---

## 2. Production Security & Workload Identity Architecture

### 2.1 Mutual TLS (mTLS) Database Workload Identity
In Stage 2, workers connected via a shared PostgreSQL connection and applied `SET SESSION AUTHORIZATION <role>` to test least-privilege scoping. In Stage 3 production, this simulation is eliminated.

```
+---------------------------------------------------------------------------------------+
|                               Next.js Application Host                                |
|                                                                                       |
|  +-----------------------+  +-----------------------+  +---------------------------+  |
|  | Webhook Ingress Tier  |  |   Tax Verifier Tier   |  | Orchestrator/Capture Tier |  |
|  | (CN=ingress-worker)   |  |   (CN=tax-verifier)   |  |   (CN=app-orchestrator)   |  |
|  +-----------+-----------+  +-----------+-----------+  +-------------+-------------+  |
+--------------|--------------------------|----------------------------|----------------+
               | mTLS (Cert A)            | mTLS (Cert B)              | mTLS (Cert C)
               | sslmode=verify-full      | sslmode=verify-full        | sslmode=verify-full
+--------------v--------------------------v----------------------------v----------------+
|                         PostgreSQL 16 Enterprise Cluster                              |
|                                                                                       |
|  pg_hba.conf:                                                                         |
|    hostssl plinthly_prod all 10.0.0.0/16 cert clientcert=verify-full map=mtls_map    |
|                                                                                       |
|  pg_ident.conf:                                                                       |
|    mtls_map  ingress-worker     webhook_ingress_role                                  |
|    mtls_map  tax-verifier       tax_verifier_role                                     |
|    mtls_map  app-orchestrator   app_orchestrator_role                                 |
|    mtls_map  admin-sec          admin_security_role                                   |
|                                                                                       |
|  Database Privileges:                                                                 |
|    - webhook_ingress_role: EXECUTE on R2-03, R2-04 ONLY. Table DML: NONE.             |
|    - tax_verifier_role:    EXECUTE on R2-01 ONLY. Table DML: NONE.                    |
|    - app_orchestrator_role: EXECUTE on R2-02, R2-05, R2-06, R2-07. Table DML: NONE.   |
|    - admin_security_role:  EXECUTE on R2-08 ONLY. Table DML: NONE.                    |
+---------------------------------------------------------------------------------------+
```

### 2.2 Connection Pool Isolation
To prevent cross-talk or privilege elevation across requests:
1. **Dedicated Service Pools:** The application server maintains four distinct `pg.Pool` instances, each configured with its own TLS client certificate, private key, and connection limits:
   - `IngressPool`: Sized for high concurrency and low latency (e.g. min 5, max 50).
   - `OrchestratorPool`: Sized for transactional operations (e.g. min 5, max 30).
   - `TaxPool`: Sized for statutory quoting (e.g. min 2, max 20).
   - `AdminPool`: Sized for key lifecycle management (e.g. min 1, max 5).
2. **Elimination of Superuser:** Application configuration contains no `postgres` superuser credentials. The `postgres` administrative role is quarantined and restricted to migration pipelines executed during maintenance windows.

### 2.3 Secrets & Cryptographic Key Lifecycle Management
1. **Secret Provider Abstraction (`SecretsManagerClient`):**
   - Application secrets (database client certificates, PayPal OAuth client secrets, webhook verification secrets, OIDC secrets) are dynamically retrieved at startup and refreshed prior to expiry.
   - Cloud adapters: `AwsSecretsManagerAdapter`, `GcpSecretManagerAdapter`, `HashiCorpVaultAdapter`.
   - Local adapter: `LocalFileSecretsAdapter` (restricted to non-production environments).
2. **Statutory Signing Key Management:**
   - Private keys for signing C-44A tax attestations (`PLINTHLY-ATTESTATION-V1`) are managed in Cloud KMS or HSM.
   - Operations use asymmetric signing APIs (`signDigest` / `sign`) without exposing key material.
   - Public keys are registered in `AuditSigningKey` via canonical routine `R2-08` / migration.
   - Automated Key Rotation: Key rotation executes on a 90-day lifecycle with a 14-day overlap. Compromised keys are immediately revoked via `POST /api/admin/keys/revoke`.

---

## 3. Provider Integration Architecture

### 3.1 Separate Sandbox & Production Adapters
Provider integrations are decoupled via strict TypeScript interfaces. Runtime environment variables determine whether sandbox or production implementations are bound.

```
                 +-------------------------------+
                 |  PaymentGatewayClient (IF)    |
                 +---------------+---------------+
                                 |
         +-----------------------+-----------------------+
         |                                               |
+--------v----------------------+             +----------v--------------------+
| PayPalSandboxGatewayAdapter   |             | PayPalProductionGatewayAdapter |
| - api.sandbox.paypal.com      |             | - api.paypal.com              |
| - Mock / sandbox credentials  |             | - Live OAuth2 token manager   |
| - Test card error simulations |             | - Dedicated mTLS egress       |
+-------------------------------+             +-------------------------------+
```

### 3.2 PayPal API Integration Specification
1. **Order Capture Integration (`POST /v2/checkout/orders/{id}/capture`):**
   - **Idempotency Key:** `PayPal-Request-Id` header set to `MerchantCartCapture.id` (UUIDv4).
   - **Authorization Verification:** Pre-capture verification checks that `MerchantCart.orderStatus === 'BUYER_APPROVED'` and `PaymentState === 'PENDING_CAPTURE'`.
   - **Amount & Currency Assertion:** The minor unit total sent to PayPal must match the exact calculated `totalCents` in `prepare_order_authorization` (R2-02).
   - **Ambiguous Timeout Handling:** Network errors, socket disconnects, or 504 Gateway Timeouts trigger an immediate transition to `AMBIGUOUS_TIMEOUT`. The capture is never assumed failed.
2. **Refund Integration (`POST /v2/payments/captures/{id}/refund`):**
   - **Idempotency Key:** `PayPal-Request-Id` header set to `CartRefundRecord.id` (UUIDv4).
   - **Amount Bounds:** Refund amount cannot exceed `MerchantCartCapture.amountCents - previouslyRefundedCents`.
   - **Result Mapping:** Successful gateway refund invokes `record_cart_refund` (R2-06).

### 3.3 Certified Tax Provider Integration Specification
1. **Tax Provider Adapter Interface (`TaxProviderAdapter`):**
   - Methods: `calculateTaxQuote(request: TaxCalculationRequest): Promise<TaxCalculationResult>`.
   - Production Implementations: `TaxJarAdapter` and `AvalaraAvaTaxAdapter`.
2. **Statutory Attestation Generation:**
   - Provider API response is normalized into statutory components (merchandise tax, shipping tax, taxable base).
   - Normalized components are hashed and assembled into the canonical C-44A pipe-delimited buffer:
     `PLINTHLY-ATTESTATION-V1|{cartId}|{quoteId}|{provider}|{version}|{payloadHash}|{statSigHash}|...`
   - Buffer is signed via KMS/HSM using RSA-SHA256 or ECDSA-P256-SHA256.
   - Result is submitted to PostgreSQL via `record_tax_calculation_quote` (R2-01).

### 3.4 Webhook Ingress, Queueing & Reconciliation Strategy
1. **Fast-Ack Ingress Buffer:**
   - Inbound webhook endpoint `POST /api/webhooks/paypal` performs synchronous X.509 certificate validation and PayPal root anchor verification (DEF-WH-01, DEF-WH-02, DEF-SEC-PK-01).
   - Raw payload and headers are synchronously recorded in `WebhookTransmissionRecord` via `record_paypal_webhook_event` (R2-03).
   - HTTP 200 `{"status": "accepted"}` is returned to PayPal within $< 300\text{ms}$.
2. **Asynchronous Processing Queue:**
   - Event is enqueued to a transactional BullMQ / PostgreSQL queue (`webhook_event_queue`).
   - Dedicated `WebhookReconciliationWorker` dequeues events and executes `reconcile_payment_capture` (R2-04).
   - Failures are retried with exponential backoff (1s, 5s, 30s, 2m, 10m). Events exceeding 5 attempts are routed to a Dead Letter Queue (DLQ) with P1 alerts.
3. **Automated Ambiguous Capture Reconciliation:**
   - Background worker `AmbiguousCaptureReconciliationWorker` polls every 2 minutes for captures in `INITIATED` or `AMBIGUOUS_TIMEOUT` state older than 5 minutes.
   - Worker queries PayPal REST API `GET /v2/payments/captures/{capture_id}` or `GET /v2/checkout/orders/{order_id}`.
   - Authoritative state is reconciled via `confirm_cart_capture` (R2-05) or `record_cart_capture_failure` (R2-07).

---

## 4. Product & UI Modernization Architecture

### 4.1 Client API Layer Modernization (`lib/workflow/stage2-client-api.ts`)
The client API layer is updated to expose strongly typed, Promise-based client functions for all Stage 2 operations:
- `quoteTax(cartId: string, address: DeliveryAddress): Promise<QuoteTaxResponse>`
- `checkoutCart(approvalAggregateId: string, cartIds?: string[]): Promise<CheckoutResponse>`
- `captureCart(cartId: string): Promise<CaptureResponse>`
- `getApprovalAggregate(aggregateId: string): Promise<ApprovalAggregateDetails>`
- `getCartStatus(cartId: string): Promise<CartStatusDetails>`

### 4.2 UI Component Architecture

```
+---------------------------------------------------------------------------------------+
|                                  PurchaseDashboard                                    |
|                                                                                       |
|  +-------------------------+  +-------------------------+  +-----------------------+  |
|  |     Request Builder     |  | MultiItemStudio (v3)    |  | Evidence Comparison   |  |
|  |     (NLP / Decompose)   |  | - Merchant-Grouped Carts|  | (AgGrid Matrix)       |  |
|  +-------------------------+  +------------+------------+  +-----------------------+  |
|                                            |                                          |
|                               +------------v------------+                             |
|                               |  Stage2ApprovalModal    |                             |
|                               |  - Landed Cost Breakdown|                             |
|                               |  - Statutory Tax Quotes |                             |
|                               |  - Zero-Variance Check  |                             |
|                               +------------+------------+                             |
|                                            |                                          |
|                               +------------v------------+                             |
|                               |  PayPalMultiCartCheckout|                             |
|                               |  - PayPal Smart Buttons |                             |
|                               |  - Sequential Captures  |                             |
|                               |  - Real-time Progress   |                             |
|                               +-------------------------+                             |
+---------------------------------------------------------------------------------------+
```

1. **Multi-Retailer Procurement Studio (`MultiItemProcurementStudio`):**
   - Consumes multi-line item procurement plans.
   - Organizes candidate allocations into per-retailer carts using the Stage 2 strategy engine.
   - Displays real-time shipping threshold qualifications and parcel split alerts.
2. **Evidence Comparison Matrix (`CandidateComparisonGrid`):**
   - AgGrid Community grid showing normalized candidate attributes: retailer, price, shipping, statutory tax quote, and policy compliance tags.
   - Interactive evidence drawer: Inspects raw candidate JSON, timestamp provenance, and screenshot verification records.
3. **Buyer Approval & Checkout Modal (`Stage2ApprovalModal`):**
   - Presents the formal Model A Landed Cost calculation for buyer confirmation.
   - Validates that merchandise subtotal + shipping + statutory tax matches order total with zero variance.
   - Invokes `POST /api/cart/checkout` to lock carts into `BUYER_APPROVED` state.
4. **PayPal Smart Buttons Integration (`PayPalMultiCartCheckout`):**
   - Wraps `@paypal/react-paypal-js` components.
   - Manages approval token exchange and orchestrates sequential/parallel cart captures via `POST /api/cart/capture`.
   - Displays visual progress indicators for multi-merchant fulfillment.

---

## 5. Operational Readiness, Monitoring & Incident Playbooks

### 5.1 Observability & Telemetry Framework
1. **Structured JSON Logging:**
   Every log message emitted by API routes, background workers, and database clients adheres to a standardized JSON schema:
   ```json
   {
     "timestamp": "2026-11-07T18:30:00.000Z",
     "level": "INFO",
     "service": "cart-capture-service",
     "traceId": "trace_abc123",
     "spanId": "span_xyz789",
     "actorId": "usr_buyer_1",
     "cartId": "cart_888",
     "orderId": "pay_att_999",
     "sqlState": "00000",
     "message": "Cart capture confirmed successfully via R2-05",
     "durationMs": 42
   }
   ```
2. **OpenTelemetry Metrics:**
   - `plinthly_cart_capture_total{status="COMPLETED|FAILED|AMBIGUOUS"}`
   - `plinthly_landed_cost_variance_cents` (gauge, MUST be 0)
   - `plinthly_webhook_processing_latency_ms` (histogram)
   - `plinthly_database_pool_utilization{role="orchestrator|tax|ingress"}`

### 5.2 Critical Alert Matrix

| Alert Name | Severity | Condition | Routing | Action Playbook |
| :--- | :--- | :--- | :--- | :--- |
| **LandedCostVarianceDetected** | **P0 (Critical)** | `plinthly_landed_cost_variance_cents != 0` | PagerDuty / Security On-Call | Emergency Freeze: Halt checkout route immediately. Inspect quote vs order authorization. |
| **AmbiguousCaptureTimeout** | **P1 (High)** | Any cart in `AMBIGUOUS_TIMEOUT` $> 15\text{min}$ | PagerDuty / Payment Ops | Ambiguous Capture Reconciliation Playbook. |
| **WebhookSignatureSpike** | **P1 (High)** | Webhook signature rejection $> 5\%$ in 5 min | Security Ops | Inspect certificate chain, CRL/OCSP status, and PayPal root trust anchors. |
| **SigningKeyExpiring** | **P2 (Medium)** | Active attestation key expires in $< 14\text{days}$ | Engineering Ops | Rotate statutory attestation key via AWS KMS and R2-08. |
| **DatabasePoolExhaustion** | **P2 (Medium)** | Pool utilization $> 90\%$ for 3 consecutive minutes | SRE | Increase connection limit or investigate long-running transactions. |

### 5.3 Incident Playbooks
1. **Playbook 1: Ambiguous Capture Triage:**
   - Step 1: Query database for all carts in `CAPTURE_PENDING` or `AMBIGUOUS_TIMEOUT`.
   - Step 2: Extract `paymentAttemptId` and `paypalOrderId`.
   - Step 3: Run administrative CLI tool `scripts/reconcile-gateway-order.ts <orderId>` to query PayPal v2 API.
   - Step 4: If gateway reports `COMPLETED`, execute manual reconciliation via R2-05. If gateway reports `FAILED` or expired, invoke R2-07.
2. **Playbook 2: Emergency Signing Key Revocation:**
   - Step 1: Execute `POST /api/admin/keys/revoke` with `admin_security_role` credentials and key ID.
   - Step 2: Verify `AuditSigningKey.revokedAt` is populated.
   - Step 3: Generate and register new active keypair in KMS/HSM.
   - Step 4: Deploy updated key ID to tax ingress configuration.

---

## 6. Contract Acceptance Sign-Off

This contract defines the authoritative specification for Plinthly Stage 3. No implementation work may commence until formal authorization is granted.

