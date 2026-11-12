# Plinthly Incident Response Runbooks & Operational Playbooks (OPS-04 / Phase 5)

**Version:** 1.0.0  
**Target Environment:** Plinthly Production / Staging  
**On-Call Tier:** Primary SRE & Financial Systems Engineer  
**Security Boundary:** `plinthly_security_admin` / `orchestrator_worker_user`  

---

## 1. P0-01: Landed-Cost Variance Violation (`LANDED_COST_VARIANCE_VIOLATION`)

### 1.1 Trigger & Classification
- **Alert Rule:** `plinthly_landed_cost_variance_cents != 0`
- **Severity:** **P0 — CRITICAL** (Direct Risk of Financial Miscalculation / Under-Authorization)
- **Automatic Action:** Checkout gate blocks fail-closed. Database routine rejects invalid transitions.

### 1.2 Immediate Triage Steps
1. **Identify Trace & Aggregate:**
   Inspect the P0 alert payload for `traceId`, `approvalAggregateId`, and `cartId`.
2. **Execute Invariant Verification Query:**
   ```sql
   SELECT id, "merchantName", "checkoutStatus",
          "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
          "taxAmountCents", "totalCartCents",
          ("merchandiseSubtotalCents" - "discountCents" + "shippingTotalCents" + "taxAmountCents" - "totalCartCents") AS variance_cents
     FROM public."ApprovedMerchantCart"
    WHERE "approvalAggregateId" = '<approvalAggregateId>';
   ```
3. **Analyze Discrepancy:**
   - Model A Invariant: $\text{Merchandise} - \text{Discount} + \text{Shipping} + \text{Statutory Tax} \equiv \text{Total Cart Cents}$.
   - If floating-point arithmetic was accidentally injected, verify that all calculations use minor-unit integer `BigInt` arithmetic.
4. **Quarantine:**
   If variance is confirmed, mark the `ApprovalAggregate` as `QUARANTINED` to prevent gateway capture:
   ```sql
   UPDATE public."ApprovalAggregate"
      SET "aggregateStatus" = 'QUARANTINED', "updatedAt" = clock_timestamp()
    WHERE id = '<approvalAggregateId>';
   ```

---

## 2. P1-02: Ambiguous Gateway Capture Timeout (`AMBIGUOUS_TIMEOUT`)

### 2.1 Trigger & Classification
- **Metric:** Spike in `plinthly_cart_capture_total{status="AMBIGUOUS_TIMEOUT"}`
- **Severity:** **P1 — HIGH** (Unknown Gateway Payment Outcome)
- **Automatic Behavior:** Cart remains safely in `CAPTURING` / `AMBIGUOUS_TIMEOUT`. Zero premature failure records are created, preventing double-billing.

### 2.2 Operational Triage with CLI Tool
1. Run the manual triage CLI tool to inspect current database and payment evidence state:
   ```bash
   npx ts-node scripts/ops/reconcile-gateway-order.ts --cartId <CART_UUID> --action inspect
   ```
2. Check PayPal Sandbox / Live REST API for the order ID:
   ```bash
   curl -v -X GET https://api-m.sandbox.paypal.com/v2/checkout/orders/<PAYPAL_ORDER_ID> \
     -H "Authorization: Bearer <ACCESS_TOKEN>"
   ```
3. **If PayPal status is `COMPLETED`:**
   Execute safe confirmation via canonical routine `R2-05`:
   ```bash
   npx ts-node scripts/ops/reconcile-gateway-order.ts --cartId <CART_UUID> --action confirm --captureId <PAYPAL_CAPTURE_ID>
   ```
4. **If PayPal status is `FAILED` or expired:**
   Execute safe failure recording via canonical routine `R2-07`:
   ```bash
   npx ts-node scripts/ops/reconcile-gateway-order.ts --cartId <CART_UUID> --action fail --errorCode "GATEWAY_TIMEOUT_EXPIRED"
   ```

---

## 3. P1-03: Webhook Queue Worker Lag & Lease Expiration (`DEF-WHK-01`)

### 3.1 Trigger & Classification
- **Alert:** Webhook processing backlog $> 100$ items or expired lease count $> 0$.
- **Severity:** **P1 — HIGH**

### 3.2 Recovery Procedure
1. Inspect queue health in `plinthly_stage2_dev`:
   ```sql
   SELECT status, COUNT(*), MIN(created_at) AS oldest_pending,
          COUNT(*) FILTER (WHERE status = 'PROCESSING' AND lease_expires_at < clock_timestamp()) AS expired_leases
     FROM public."WebhookEventQueue"
    GROUP BY status;
   ```
2. Manually trigger expired worker lease recovery:
   ```sql
   SELECT * FROM public.recover_expired_webhook_leases('5 minutes'::interval);
   ```
3. Restart worker daemon:
   ```bash
   npm run worker:webhooks
   ```

---

## 4. P2-04: Refund Gateway Failure & Balance Exceeded (`DEF-P4-01`)

### 4.1 Invariants & Protection
- Every refund intent is committed in `CartRefundRecord` prior to gateway dispatch.
- `PayPal-Request-Id` is strictly derived from persisted `CartRefundRecord.id`.
- In-flight reservations block concurrent over-refunds.

### 4.2 Triage Procedure
1. Inspect `CartRefundRecord` for the affected cart:
   ```sql
   SELECT id, cart_id, idempotency_key, amount_cents, status, gateway_refund_id, created_at
     FROM public."CartRefundRecord"
    WHERE cart_id = '<CART_UUID>'
    ORDER BY created_at DESC;
   ```
2. If status is `AMBIGUOUS_TIMEOUT`:
   Re-running the refund with the identical `Idempotency-Key` header will safely reuse the existing `CartRefundRecord.id` without incrementing consumed balance.

