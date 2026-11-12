-- Plinthly Stage 2 Phase 1: Relational Schema & Database Infrastructure
-- Baseline Architecture Contract v2.0.11 Section 3.1, 6.3, 7.1.5

-- 1. Cryptographic Extensions Schema
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;

-- 2. Group A: Core Domain Procurement & Multi-Retailer Entities (7)

-- 1. ProcurementPlan
CREATE TABLE IF NOT EXISTS "ProcurementPlan" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "strategy" VARCHAR(32) NOT NULL,
    "lifecycleStatus" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_procurement_plan_user" ON "ProcurementPlan"("userId");
CREATE INDEX IF NOT EXISTS "idx_procurement_plan_status" ON "ProcurementPlan"("lifecycleStatus");

-- 2. ProcurementLineItem
CREATE TABLE IF NOT EXISTS "ProcurementLineItem" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "planId" UUID NOT NULL REFERENCES "ProcurementPlan"("id") ON DELETE CASCADE,
    "itemDescription" TEXT NOT NULL,
    "targetQuantity" INT NOT NULL CHECK ("targetQuantity" > 0),
    "maxUnitCents" BIGINT NOT NULL CHECK ("maxUnitCents" > 0),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_procurement_line_item_plan" ON "ProcurementLineItem"("planId");

-- 3. ApprovalAggregate
CREATE TABLE IF NOT EXISTS "ApprovalAggregate" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "planId" UUID NOT NULL REFERENCES "ProcurementPlan"("id") ON DELETE RESTRICT,
    "aggregateStatus" VARCHAR(32) NOT NULL,
    "snapshotDigest" BYTEA NOT NULL,
    "snapshotPayload" JSONB NOT NULL,
    "approvedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_approval_aggregate_plan" ON "ApprovalAggregate"("planId");

-- 4. ApprovedMerchantCart
CREATE TABLE IF NOT EXISTS "ApprovedMerchantCart" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "approvalAggregateId" UUID NOT NULL REFERENCES "ApprovalAggregate"("id") ON DELETE RESTRICT,
    "merchantId" VARCHAR(64) NOT NULL,
    "merchantPayeeEmail" VARCHAR(255) NOT NULL,
    "checkoutStatus" VARCHAR(32) NOT NULL CHECK ("checkoutStatus" IN (
        'READY', 'CHECKOUT_INITIATED', 'BUYER_APPROVED', 'CAPTURING',
        'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'
    )),
    "paypalOrderId" VARCHAR(64) NULL,
    "merchandiseSubtotalCents" BIGINT NOT NULL CHECK ("merchandiseSubtotalCents" >= 0),
    "discountCents" BIGINT NOT NULL DEFAULT 0 CHECK ("discountCents" >= 0),
    "shippingTotalCents" BIGINT NOT NULL DEFAULT 0 CHECK ("shippingTotalCents" >= 0),
    "taxAmountCents" BIGINT NOT NULL DEFAULT 0 CHECK ("taxAmountCents" >= 0),
    "totalCartCents" BIGINT NOT NULL CHECK ("totalCartCents" >= 0),
    "cumulativeRefundedCents" BIGINT NOT NULL DEFAULT 0 CHECK ("cumulativeRefundedCents" >= 0),
    "lockedAt" TIMESTAMPTZ NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_approved_merchant_cart_aggregate" ON "ApprovedMerchantCart"("approvalAggregateId");
CREATE INDEX IF NOT EXISTS "idx_approved_merchant_cart_status" ON "ApprovedMerchantCart"("checkoutStatus");
CREATE INDEX IF NOT EXISTS "idx_approved_merchant_cart_order" ON "ApprovedMerchantCart"("paypalOrderId");

-- 5. CartAllocation
CREATE TABLE IF NOT EXISTS "CartAllocation" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "cartId" UUID NOT NULL REFERENCES "ApprovedMerchantCart"("id") ON DELETE RESTRICT,
    "lineItemId" UUID NOT NULL REFERENCES "ProcurementLineItem"("id") ON DELETE RESTRICT,
    "allocatedQuantity" INT NOT NULL CHECK ("allocatedQuantity" > 0),
    "allocatedUnitCents" BIGINT NOT NULL CHECK ("allocatedUnitCents" > 0),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "uq_cart_allocation_item" UNIQUE ("cartId", "lineItemId")
);

CREATE INDEX IF NOT EXISTS "idx_cart_allocation_cart" ON "CartAllocation"("cartId");
CREATE INDEX IF NOT EXISTS "idx_cart_allocation_item" ON "CartAllocation"("lineItemId");

-- 6. PlannedShipmentRecord
CREATE TABLE IF NOT EXISTS "PlannedShipmentRecord" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "cartId" UUID NOT NULL REFERENCES "ApprovedMerchantCart"("id") ON DELETE RESTRICT,
    "shippingCarrier" VARCHAR(64) NOT NULL,
    "shippingTrackingNumber" VARCHAR(128) NULL,
    "shippingStatus" VARCHAR(32) NOT NULL DEFAULT 'PLANNED',
    "dispatchedAt" TIMESTAMPTZ NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_planned_shipment_cart" ON "PlannedShipmentRecord"("cartId");

-- 3. Group C: Security & Cryptographic Infrastructure Entities (3)

-- 12. AuditSigningKey
CREATE TABLE IF NOT EXISTS "AuditSigningKey" (
    "key_id" VARCHAR(64) PRIMARY KEY,
    "key_type" VARCHAR(32) NOT NULL CHECK ("key_type" IN ('AUDIT_HMAC_SYMMETRIC', 'VERIFIER_ATTESTATION_PUBLIC_KEY')),
    "worker_principal" VARCHAR(64) NULL,
    "algorithm" VARCHAR(32) NOT NULL CHECK ("algorithm" IN ('HMAC-SHA256', 'ECDSA-P256-SHA256', 'RSASSA-PSS-SHA256')),
    "public_key_der" BYTEA NULL,
    "key_bytes" BYTEA NULL,
    "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'REVOKED')),
    "valid_from" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    "valid_until" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ NULL,
    "revocation_reason" VARCHAR(255) NULL,
    "revoked_by" VARCHAR(64) NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_audit_signing_key_status" ON "AuditSigningKey"("status");
CREATE INDEX IF NOT EXISTS "idx_audit_signing_key_worker" ON "AuditSigningKey"("worker_principal");

-- 13. TaxAuthorityCertificate
CREATE TABLE IF NOT EXISTS "TaxAuthorityCertificate" (
    "authority_id" VARCHAR(64) NOT NULL,
    "certificate_number" VARCHAR(64) NOT NULL,
    "certificate_pem" TEXT NOT NULL,
    "subject_dn" VARCHAR(255) NOT NULL,
    "issuer_dn" VARCHAR(255) NOT NULL,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_until" TIMESTAMPTZ NOT NULL,
    "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'REVOKED')),
    "revoked_at" TIMESTAMPTZ NULL,
    "revocation_reason" VARCHAR(255) NULL,
    "revoked_by" VARCHAR(64) NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("authority_id", "certificate_number")
);

CREATE INDEX IF NOT EXISTS "idx_tax_authority_cert_status" ON "TaxAuthorityCertificate"("status");

-- 11. NonceRegistry
CREATE TABLE IF NOT EXISTS "NonceRegistry" (
    "nonce" VARCHAR(64) NOT NULL,
    "scope" VARCHAR(32) NOT NULL,
    "target_id" UUID NOT NULL,
    "request_digest" BYTEA NOT NULL,
    "consumed_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("nonce", "scope")
);

CREATE INDEX IF NOT EXISTS "idx_nonce_registry_target" ON "NonceRegistry"("target_id");

-- 4. Group B: Financial & Gateway Ingress Supporting Entities (3)

-- 10. WebhookTransmission
CREATE TABLE IF NOT EXISTS "WebhookTransmission" (
    "transmission_id" VARCHAR(64) PRIMARY KEY,
    "authenticated_order_id" VARCHAR(64) NULL,
    "authenticated_capture_id" VARCHAR(64) NULL,
    "authenticated_refund_id" VARCHAR(64) NULL,
    "authenticated_amount_cents" BIGINT NOT NULL CHECK ("authenticated_amount_cents" >= 0),
    "authenticated_currency" VARCHAR(3) NOT NULL CHECK ("authenticated_currency" = 'USD'),
    "authenticated_payee_email" VARCHAR(255) NULL,
    "authenticated_event_type" VARCHAR(64) NOT NULL,
    "raw_payload" BYTEA NOT NULL,
    "payload_hash" BYTEA NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'RECORDED',
    "response_code" INTEGER NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "idx_webhook_tx_order" ON "WebhookTransmission"("authenticated_order_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_tx_capture" ON "WebhookTransmission"("authenticated_capture_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_tx_status" ON "WebhookTransmission"("status");

-- 7. PaymentEvidenceRecord
CREATE TABLE IF NOT EXISTS "PaymentEvidenceRecord" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "cart_id" UUID NOT NULL REFERENCES "ApprovedMerchantCart"("id") ON DELETE RESTRICT,
    "transmission_id" VARCHAR(64) NOT NULL REFERENCES "WebhookTransmission"("transmission_id") ON DELETE RESTRICT,
    "capture_id" VARCHAR(64) NOT NULL,
    "paypal_order_id" VARCHAR(64) NOT NULL,
    "amount_cents" BIGINT NOT NULL CHECK ("amount_cents" > 0),
    "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'USD'),
    "payee_email" VARCHAR(255) NOT NULL,
    "internal_audit_signature" BYTEA NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "uq_payment_evidence_cart" UNIQUE ("cart_id"),
    CONSTRAINT "uq_payment_evidence_transmission" UNIQUE ("transmission_id")
);

CREATE INDEX IF NOT EXISTS "idx_payment_evidence_capture" ON "PaymentEvidenceRecord"("capture_id");
CREATE INDEX IF NOT EXISTS "idx_payment_evidence_order" ON "PaymentEvidenceRecord"("paypal_order_id");

-- 8. TaxEvidenceRecord (33 Columns)
CREATE TABLE IF NOT EXISTS "TaxEvidenceRecord" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "cart_id" UUID NOT NULL REFERENCES "ApprovedMerchantCart"("id") ON DELETE RESTRICT,
    "tax_quote_id" VARCHAR(64) NOT NULL,
    "provider_name" VARCHAR(64) NOT NULL,
    "provider_api_version" VARCHAR(32) NOT NULL,
    "signature_algorithm" VARCHAR(32) NOT NULL CHECK ("signature_algorithm" IN ('RSA-SHA256', 'ECDSA-P256')),
    "provider_timestamp" TIMESTAMPTZ NOT NULL,
    "valid_until" TIMESTAMPTZ NOT NULL,
    "provider_merchandise_subtotal_cents" BIGINT NOT NULL CHECK ("provider_merchandise_subtotal_cents" >= 0),
    "provider_discount_cents" BIGINT NOT NULL CHECK ("provider_discount_cents" >= 0),
    "provider_shipping_cents" BIGINT NOT NULL CHECK ("provider_shipping_cents" >= 0),
    "provider_adjustment_cents" BIGINT NOT NULL DEFAULT 0 CHECK ("provider_adjustment_cents" = 0),
    "provider_total_cents" BIGINT NOT NULL CHECK ("provider_total_cents" >= 0),
    "total_tax_cents" BIGINT NOT NULL CHECK ("total_tax_cents" >= 0),
    "merchandise_tax_cents" BIGINT NOT NULL CHECK ("merchandise_tax_cents" >= 0),
    "shipping_tax_cents" BIGINT NOT NULL CHECK ("shipping_tax_cents" >= 0),
    "taxable_shipping_base_cents" BIGINT NOT NULL CHECK ("taxable_shipping_base_cents" >= 0),
    "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'USD'),
    "jurisdiction_code" VARCHAR(64) NOT NULL,
    "line_items_breakdown" JSONB NOT NULL,
    "jurisdiction_breakdown" JSONB NOT NULL,
    "raw_payload" BYTEA NOT NULL,
    "statutory_payload_hash" BYTEA NOT NULL,
    "statutory_signature" BYTEA NOT NULL,
    "authority_id" VARCHAR(64) NOT NULL,
    "certificate_number" VARCHAR(64) NOT NULL,
    "verifier_identity" VARCHAR(64) NOT NULL,
    "attestation_key_id" VARCHAR(64) NOT NULL REFERENCES "AuditSigningKey"("key_id") ON DELETE RESTRICT,
    "attestation_timestamp" TIMESTAMPTZ NOT NULL,
    "verifier_attestation_signature" BYTEA NOT NULL,
    "verification_status" VARCHAR(16) NOT NULL CHECK ("verification_status" = 'VERIFIED'),
    "internal_audit_signature" BYTEA NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "uq_tax_evidence_cart" UNIQUE ("cart_id"),
    CONSTRAINT "fk_tax_evidence_authority_cert" FOREIGN KEY ("authority_id", "certificate_number")
        REFERENCES "TaxAuthorityCertificate"("authority_id", "certificate_number") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "idx_tax_evidence_quote" ON "TaxEvidenceRecord"("tax_quote_id");
CREATE INDEX IF NOT EXISTS "idx_tax_evidence_attestation_key" ON "TaxEvidenceRecord"("attestation_key_id");
CREATE INDEX IF NOT EXISTS "idx_tax_evidence_authority_cert" ON "TaxEvidenceRecord"("authority_id", "certificate_number");

-- 9. RefundEvidenceRecord
CREATE TABLE IF NOT EXISTS "RefundEvidenceRecord" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "cart_id" UUID NOT NULL REFERENCES "ApprovedMerchantCart"("id") ON DELETE RESTRICT,
    "capture_id" VARCHAR(64) NOT NULL,
    "transmission_id" VARCHAR(64) NOT NULL REFERENCES "WebhookTransmission"("transmission_id") ON DELETE RESTRICT,
    "authenticated_refund_id" VARCHAR(64) NOT NULL,
    "refund_amount_cents" BIGINT NOT NULL CHECK ("refund_amount_cents" > 0),
    "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'USD'),
    "reason" VARCHAR(255) NULL,
    "internal_audit_signature" BYTEA NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "uq_refund_evidence_transmission" UNIQUE ("transmission_id"),
    CONSTRAINT "uq_refund_evidence_authenticated_refund_id" UNIQUE ("authenticated_refund_id")
);

CREATE INDEX IF NOT EXISTS "idx_refund_evidence_cart" ON "RefundEvidenceRecord"("cart_id");
CREATE INDEX IF NOT EXISTS "idx_refund_evidence_capture" ON "RefundEvidenceRecord"("capture_id");

-- 5. Immutability Trigger for WebhookTransmission
CREATE OR REPLACE FUNCTION fn_webhook_transmission_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ERR_IMMUTABLE_RECORD: Deletion of WebhookTransmission records is strictly prohibited'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Only status and response_code can transition from RECORDED to PROCESSED/FAILED, and wire fields must remain immutable
        IF OLD.status = 'RECORDED' AND NEW.status IN ('PROCESSED', 'FAILED')
           AND OLD.transmission_id = NEW.transmission_id
           AND OLD.authenticated_event_type = NEW.authenticated_event_type
           AND OLD.authenticated_order_id IS NOT DISTINCT FROM NEW.authenticated_order_id
           AND OLD.authenticated_capture_id IS NOT DISTINCT FROM NEW.authenticated_capture_id
           AND OLD.authenticated_refund_id IS NOT DISTINCT FROM NEW.authenticated_refund_id
           AND OLD.authenticated_amount_cents = NEW.authenticated_amount_cents
           AND OLD.authenticated_currency = NEW.authenticated_currency
           AND OLD.authenticated_payee_email IS NOT DISTINCT FROM NEW.authenticated_payee_email
           AND OLD.raw_payload = NEW.raw_payload
           AND OLD.payload_hash = NEW.payload_hash
           AND OLD.created_at = NEW.created_at THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'ERR_IMMUTABLE_RECORD: Direct updates to WebhookTransmission records are strictly prohibited'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_webhook_transmission_immutability ON "WebhookTransmission";
CREATE TRIGGER trg_webhook_transmission_immutability
BEFORE UPDATE OR DELETE ON "WebhookTransmission"
FOR EACH ROW EXECUTE FUNCTION fn_webhook_transmission_immutability();

-- 6. Role Revocations & Least Privilege Grants (Section 6.3)
REVOKE ALL ON "WebhookTransmission", "TaxEvidenceRecord", "PaymentEvidenceRecord",
              "RefundEvidenceRecord", "NonceRegistry", "AuditSigningKey",
              "TaxAuthorityCertificate", "ApprovedMerchantCart", "CartAllocation",
              "PlannedShipmentRecord", "ApprovalAggregate", "ProcurementPlan",
              "ProcurementLineItem" FROM tax_verifier_role, webhook_ingress_role, app_orchestrator_role;

GRANT USAGE ON SCHEMA public TO tax_verifier_role, webhook_ingress_role, app_orchestrator_role, admin_security_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_orchestrator_role;
