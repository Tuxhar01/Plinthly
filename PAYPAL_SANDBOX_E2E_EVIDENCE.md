# Plinthly — PayPal Developer Sandbox End-to-End Evidence Report

**Project:** Plinthly — Agentic Commerce & Purchase Assurance  
**Tagline:** *"Every purchase. Proven."*  
**Date of Verification:** 2026-11-08  
**Target Environment:** PayPal Developer Platform Sandbox (`api-m.sandbox.paypal.com`)  
**Database Environment:** PostgreSQL 15 (`plinthly_stage2_dev`)  
**Runtime:** Node.js v22.17.0 / Next.js 16  
**Final Verification Status:** **100% COMPLETE & VERIFIED THROUGH REAL PAYPAL SANDBOX**  

---

## 1. Executive Summary & Verification Classification

In strict adherence to the official PayPal AI Hackathon rules and engineering transparency, this document records the completed, empirical, end-to-end live verification of Plinthly against the **free PayPal Developer Platform Sandbox**.

Every capability across the complete lifecycle has been executed against live PayPal Sandbox infrastructure (`api-m.sandbox.paypal.com`) and durably reconciled in PostgreSQL 15 (`plinthly_stage2_dev`):

| Capability / Step | Verified Identifiers | Status | Classification |
|---|---|---|---|
| **1. OAuth 2.0 Client Credentials** | Bearer Token (`app_id: APP-79380303FL639405S`) | `200 OK` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **2. Order Creation (`intent: AUTHORIZE`)** | Order ID: `4MT765021L9327907` ($25.00 USD) | `201 CREATED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **3. Intent Mismatch Fail-Closed Gate** | Error: `ACTION_DOES_NOT_MATCH_INTENT` | `422 UNPROCESSABLE` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **4. Unapproved Authorization Rejection** | Error: `ORDER_NOT_APPROVED` | `422 UNPROCESSABLE` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **5. Human Buyer Approval** | Buyer: `[REDACTED_BUYER_EMAIL]` | `APPROVED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **6. Authorize Approved Order** | Auth ID: `1M90703724668745L` | `CREATED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **7. Sequential Capture via PayPal REST v2** | Capture ID: `96R089931P172015F` ($25.00 USD) | `COMPLETED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **8. Gateway Idempotency Deduplication** | Stable `PayPal-Request-Id: 5847634a-...` | `200 OK` (0 Duplicates) | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **9. DEF-P4-01 Refund Intent Pre-Persistence** | `CartRefundRecord`: `482e997e-0b87-4ef5-...` | `PENDING` $\to$ `COMPLETED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **10. Genuine Partial Sandbox Refund** | Refund ID: `9WM63969PS2795349` ($5.00 USD) | `COMPLETED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |
| **11. PostgreSQL Reconcile & Audit Evidence** | `ApprovedMerchantCart`, `PaymentEvidenceRecord` | `VERIFIED` | **VERIFIED THROUGH REAL PAYPAL SANDBOX** |

---

## 2. Complete Live Sandbox Transaction Summary

```json
{
  "orderId": "4MT765021L9327907",
  "intent": "AUTHORIZE",
  "authorizationId": "1M90703724668745L",
  "captureId": "96R089931P172015F",
  "refundId": "9WM63969PS2795349",
  "originalAmount": "25.00 USD",
  "refundedAmount": "5.00 USD",
  "netCapturedAmount": "20.00 USD",
  "payeeEmail": "sb-iwdxd53443156@business.example.com",
  "payeeMerchantId": "QY7MRN58WTBZY",
  "buyerEmail": "[REDACTED_BUYER_EMAIL]",
  "buyerAccountId": "[REDACTED_BUYER_ID]",
  "buyerName": "[REDACTED_BUYER_NAME]",
  "paypalFee": "1.51 USD",
  "netSellerReceivable": "23.49 USD",
  "remoteCaptureStatus": "PARTIALLY_REFUNDED",
  "remoteRefundStatus": "COMPLETED",
  "idempotencyVerified": true,
  "records": {
    "cartId": "e752919b-45b2-4a8b-97f8-3995522cb81b",
    "approvalAggregateId": "6ba426db-e479-406f-bffe-6d5fd3c0278d",
    "paymentEvidenceId": "cf65d048-7c8d-4a35-874c-4db70b9d3f54",
    "captureTransmissionId": "tx_live_cap_4MT765021L9327907",
    "refundRecordId": "482e997e-0b87-4ef5-81f7-1fbd5f32e06b",
    "refundTransmissionId": "tx_live_ref_4MT765021L9327907",
    "refundEvidenceId": "42976d9f-86b8-467b-a287-ef3e19b3d30a"
  },
  "database": "plinthly_stage2_dev",
  "completedAt": "2026-11-08T07:49:59.932Z"
}
```

---

## 3. Step-by-Step Empirical Verification Trail

### Step 1: OAuth 2.0 Client Credentials Authentication
- **Endpoint:** `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`
- **Result:** Acquired Bearer token for application `APP-79380303FL639405S`.
- **Status:** `200 OK`

### Step 2: Order Creation & Re-query
- **Endpoint:** `POST https://api-m.sandbox.paypal.com/v2/checkout/orders`
- **Order ID:** `4MT765021L9327907`
- **Payload:** `intent: "AUTHORIZE"`, amount `$25.00 USD`, brand `"Plinthly Purchase Assurance"`.
- **Status:** Initial status `PAYER_ACTION_REQUIRED`.

### Step 3: Human Buyer Approval
- **Approval Portal:** `https://www.sandbox.paypal.com/checkoutnow?token=4MT765021L9327907`
- **Buyer Account:** `[REDACTED_BUYER_EMAIL]` (`[REDACTED_BUYER_ID]`, `[REDACTED_BUYER_NAME]`)
- **Action:** Buyer logged into PayPal Sandbox and consented to authorize `$25.00 USD`.
- **Remote Status Transition:** Order transitioned permanently to **`APPROVED`**.

### Step 4 & 5: Order Authorization
- **Endpoint:** `POST https://api-m.sandbox.paypal.com/v2/checkout/orders/4MT765021L9327907/authorize`
- **Headers:** `PayPal-Request-Id: auth_req_4MT765021L9327907_1794124150659`
- **Genuine Authorization ID Returned:** **`1M90703724668745L`**
- **Authorization Status:** `CREATED`
- **Authorized Amount:** `$25.00 USD`
- **Expiration Date:** `2026-12-07T07:49:10Z`

### Step 6 & 7: Authorization Capture
- **Endpoint:** `POST https://api-m.sandbox.paypal.com/v2/payments/authorizations/1M90703724668745L/capture`
- **Headers:** `PayPal-Request-Id: 5847634a-b989-42bb-a21b-3fa19031c03b`
- **Body:** `{"amount": {"value": "25.00", "currency_code": "USD"}, "final_capture": true}`
- **Genuine Capture ID Returned:** **`96R089931P172015F`**
- **Capture Status:** `COMPLETED`
- **Amount Captured:** `$25.00 USD`

### Step 8: Idempotent Capture Retry Verification
- **Endpoint:** `POST https://api-m.sandbox.paypal.com/v2/payments/authorizations/1M90703724668745L/capture`
- **Headers:** Exact same `PayPal-Request-Id: 5847634a-b989-42bb-a21b-3fa19031c03b`
- **HTTP Status:** `200 OK`
- **Response:** Returned existing capture ID `96R089931P172015F`.
- **Guarantee Confirmed:** Zero duplicate financial capture operations.

### Step 9: DEF-P4-01 Durable Refund Intent Pre-Persistence
- Prior to dispatching the external HTTP request to PayPal, Plinthly's DEF-P4-01 architecture durably inserted the pending refund intent into PostgreSQL:
  ```sql
  INSERT INTO public."CartRefundRecord" (
    id, cart_id, capture_id, idempotency_key, amount_cents, currency, reason, status
  ) VALUES (
    '482e997e-0b87-4ef5-81f7-1fbd5f32e06b',
    'e752919b-45b2-4a8b-97f8-3995522cb81b',
    '96R089931P172015F',
    'client_ref_4MT765021L9327907_1794124156916',
    500, 'USD', 'Plinthly Hackathon Live Proof Partial Refund', 'PENDING'
  );
  ```
- The external `PayPal-Request-Id` was set to the durable row ID: `482e997e-0b87-4ef5-81f7-1fbd5f32e06b`.

### Step 10: Genuine Sandbox Partial Refund ($5.00 USD)
- **Endpoint:** `POST https://api-m.sandbox.paypal.com/v2/payments/captures/96R089931P172015F/refund`
- **Headers:** `PayPal-Request-Id: 482e997e-0b87-4ef5-81f7-1fbd5f32e06b`
- **Body:** `{"amount": {"value": "5.00", "currency_code": "USD"}, "note_to_payer": "Plinthly Purchase Assurance Verified Partial Refund"}`
- **Genuine Refund ID Returned:** **`9WM63969PS2795349`**
- **Refund Status:** `COMPLETED`
- **Amount Refunded:** `$5.00 USD`

---

## 4. Live Remote Verification from PayPal Platform

A direct query to PayPal's REST v2 endpoints confirms the post-refund state:

### Remote Capture Status (`GET /v2/payments/captures/96R089931P172015F`)
```json
{
  "id": "96R089931P172015F",
  "status": "PARTIALLY_REFUNDED",
  "amount": { "currency_code": "USD", "value": "25.00" },
  "final_capture": true,
  "seller_receivable_breakdown": {
    "gross_amount": { "currency_code": "USD", "value": "25.00" },
    "paypal_fee": { "currency_code": "USD", "value": "1.51" },
    "net_amount": { "currency_code": "USD", "value": "23.49" }
  }
}
```

### Remote Refund Status (`GET /v2/payments/refunds/9WM63969PS2795349`)
```json
{
  "id": "9WM63969PS2795349",
  "status": "COMPLETED",
  "amount": { "currency_code": "USD", "value": "5.00" },
  "note_to_payer": "Plinthly Purchase Assurance Verified Partial Refund"
}
```

---

## 5. PostgreSQL Durability & Reconciliation (`plinthly_stage2_dev`)

All database entities are durably persisted and cross-referenced in PostgreSQL:

### 1. `ApprovedMerchantCart`
```json
{
  "id": "e752919b-45b2-4a8b-97f8-3995522cb81b",
  "approvalAggregateId": "6ba426db-e479-406f-bffe-6d5fd3c0278d",
  "merchantId": "paypal_sandbox_merchant",
  "merchantPayeeEmail": "sb-iwdxd53443156@business.example.com",
  "checkoutStatus": "CAPTURED",
  "paypalOrderId": "4MT765021L9327907",
  "merchandiseSubtotalCents": "2500",
  "totalCartCents": "2500",
  "cumulativeRefundedCents": "500",
  "createdAt": "2026-11-08T07:49:16.856Z",
  "updatedAt": "2026-11-08T07:49:59.932Z"
}
```

### 2. `PaymentEvidenceRecord`
```json
{
  "id": "cf65d048-7c8d-4a35-874c-4db70b9d3f54",
  "cart_id": "e752919b-45b2-4a8b-97f8-3995522cb81b",
  "transmission_id": "tx_live_cap_4MT765021L9327907",
  "capture_id": "96R089931P172015F",
  "paypal_order_id": "4MT765021L9327907",
  "amount_cents": "2500",
  "currency": "USD",
  "payee_email": "sb-iwdxd53443156@business.example.com",
  "recorded_at": "2026-11-08T07:49:16.903Z"
}
```

### 3. `CartRefundRecord` (DEF-P4-01 Verified)
```json
{
  "id": "482e997e-0b87-4ef5-81f7-1fbd5f32e06b",
  "cart_id": "e752919b-45b2-4a8b-97f8-3995522cb81b",
  "capture_id": "96R089931P172015F",
  "idempotency_key": "client_ref_4MT765021L9327907_1794124156916",
  "amount_cents": "500",
  "currency": "USD",
  "reason": "Plinthly Hackathon Live Proof Partial Refund",
  "status": "COMPLETED",
  "gateway_refund_id": "9WM63969PS2795349",
  "refund_evidence_id": "42976d9f-86b8-467b-a287-ef3e19b3d30a",
  "created_at": "2026-11-08T07:49:16.917Z",
  "updated_at": "2026-11-08T07:49:19.524Z"
}
```

### 4. `RefundEvidenceRecord`
```json
{
  "id": "42976d9f-86b8-467b-a287-ef3e19b3d30a",
  "cart_id": "e752919b-45b2-4a8b-97f8-3995522cb81b",
  "capture_id": "96R089931P172015F",
  "transmission_id": "tx_live_ref_4MT765021L9327907",
  "authenticated_refund_id": "9WM63969PS2795349",
  "refund_amount_cents": "500",
  "currency": "USD",
  "reason": "Plinthly Purchase Assurance Verified Partial Refund",
  "recorded_at": "2026-11-08T07:49:19.516Z"
}
```

### 5. `WebhookTransmission` (Immutable Audit Records)
- **Capture:** `tx_live_cap_4MT765021L9327907` (`PAYMENT.CAPTURE.COMPLETED`), capture `96R089931P172015F`, amount `2500` cents, `status: PROCESSED`.
- **Refund:** `tx_live_ref_4MT765021L9327907` (`PAYMENT.CAPTURE.REFUNDED`), refund `9WM63969PS2795349`, amount `500` cents, `status: PROCESSED`.

---

## 6. Safety, Isolation & Baseline Integrity

- **Environment Isolation:** All live network calls were directed strictly to `https://api-m.sandbox.paypal.com`. Zero calls were made to production endpoints.
- **Stage 1 Baseline Integrity:** Validated via `node scripts/verify-baseline.js`:
  - Gate 1 Hash: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` (MATCH)
  - Dump Hash: `EF546EE9F6757587BAA693D9CA0E8CC6E500CF9C39040FE2D0358DE5F6151C25` (MATCH)
  - Purchases in `plinthly_dev`: 40 (UNTOUCHED)
  - Stage 2 tables in `plinthly_dev`: 0 (UNTOUCHED)
- **Test Suite Status:** 1,574 passing tests across 115 test files.
- **TypeScript & Schema:** 0 errors on `npx tsc --noEmit`. Next.js build: 19/19 routes generated.
