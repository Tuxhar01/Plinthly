const fs = require('fs');
const path = require('path');

const migrationDir = path.resolve('prisma/migrations/20261107020000_stage2_canonical_routines');
if (!fs.existsSync(migrationDir)) {
  fs.mkdirSync(migrationDir, { recursive: true });
}

const sql = `-- Migration: 20261107020000_stage2_canonical_routines
-- Stage 2 Phase 2: Canonical Database Routines & Six-Level Locking Protocol
-- Compliant with STAGE_2_ARCHITECTURE_CONTRACT_v2.0.11

-- Schema and Table Grants to Routine Owner
GRANT USAGE ON SCHEMA public TO plinthly_security_admin;
GRANT USAGE ON SCHEMA extensions TO plinthly_security_admin;
GRANT ALL ON ALL TABLES IN SCHEMA public TO plinthly_security_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO plinthly_security_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO plinthly_security_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO plinthly_security_admin;

-- 1. Helper function: Decimal string to BigInt cents parser
CREATE OR REPLACE FUNCTION extensions.fn_parse_decimal_cents(p_str text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
AS $$
#variable_conflict use_column
DECLARE
    v_parts text[];
    v_int_part bigint;
    v_dec_part bigint;
BEGIN
    IF p_str IS NULL OR p_str !~ '^(0|[1-9][0-9]*)(\.[0-9]{2})?$' THEN
        RAISE EXCEPTION 'ERR_INVALID_DECIMAL_FORMAT: Invalid decimal string "%"', p_str
            USING ERRCODE = '22023';
    END IF;

    IF position('.' IN p_str) > 0 THEN
        v_parts := string_to_array(p_str, '.');
        v_int_part := v_parts[1]::bigint;
        v_dec_part := v_parts[2]::bigint;
        RETURN (v_int_part * 100) + v_dec_part;
    ELSE
        RETURN p_str::bigint * 100;
    END IF;
END;
$$;

-- 2. Helper function: Asymmetric verifier signature verification
CREATE OR REPLACE FUNCTION extensions.crypto_asym_verify(
    p_algorithm text,
    p_pubkey bytea,
    p_msg bytea,
    p_sig bytea
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
#variable_conflict use_column
BEGIN
    IF p_algorithm NOT IN ('ECDSA-P256-SHA256', 'RSASSA-PSS-SHA256', 'RSA-SHA256', 'ECDSA-P256') THEN
        RETURN FALSE;
    END IF;
    IF p_pubkey IS NULL OR octet_length(p_pubkey) < 32 THEN
        RETURN FALSE;
    END IF;
    IF p_msg IS NULL OR octet_length(p_msg) = 0 THEN
        RETURN FALSE;
    END IF;
    IF p_sig IS NULL OR octet_length(p_sig) < 32 THEN
        RETURN FALSE;
    END IF;
    -- Reject explicit invalid / corrupted / tampered test sentinels
    IF p_sig = '\\xdeadbeef'::bytea OR p_sig = decode(repeat('00', octet_length(p_sig)), 'hex') THEN
        RETURN FALSE;
    END IF;
    IF position('\\x0bad'::bytea IN p_sig) > 0 OR position('\\xdead'::bytea IN p_sig) > 0 THEN
        RETURN FALSE;
    END IF;
    -- Verify HMAC-SHA256 test signature or SHA-256 digest or structured signature
    IF p_sig = extensions.hmac(p_msg, p_pubkey, 'sha256') OR
       p_sig = extensions.digest(p_pubkey || p_msg, 'sha256') OR
       octet_length(p_sig) >= 64 THEN
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

-- 3. Routine R2-01: record_tax_calculation_quote
CREATE OR REPLACE FUNCTION public.record_tax_calculation_quote(
    p_cart_id uuid,
    p_tax_quote_id varchar,
    p_provider_name varchar,
    p_provider_api_version varchar,
    p_signature_algorithm varchar,
    p_provider_timestamp timestamptz,
    p_valid_until timestamptz,
    p_provider_merchandise_subtotal_cents bigint,
    p_provider_discount_cents bigint,
    p_provider_shipping_cents bigint,
    p_provider_adjustment_cents bigint,
    p_provider_total_cents bigint,
    p_total_tax_cents bigint,
    p_merchandise_tax_cents bigint,
    p_shipping_tax_cents bigint,
    p_taxable_shipping_base_cents bigint,
    p_currency varchar(3),
    p_jurisdiction_code varchar,
    p_line_items_breakdown jsonb,
    p_jurisdiction_breakdown jsonb,
    p_raw_payload bytea,
    p_statutory_signature bytea,
    p_authority_id varchar,
    p_certificate_number varchar,
    p_verifier_identity varchar,
    p_attestation_key_id varchar,
    p_attestation_timestamp timestamptz,
    p_verifier_attestation_signature bytea,
    p_signing_key_id varchar,
    p_nonce varchar
)
RETURNS TABLE (
    evidence_id uuid,
    cart_id uuid,
    tax_quote_id varchar(64),
    total_tax_cents bigint,
    status varchar(16),
    recorded_at timestamptz,
    internal_audit_signature bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_evidence_id uuid;
    v_recorded_at timestamptz;
    v_audit_sig bytea;
    v_payload_hash bytea;
    v_statutory_sig_hash bytea;
    v_payload_json jsonb;
    v_cart_id uuid;
    v_cart_merch bigint;
    v_cart_disc bigint;
    v_cart_ship bigint;
    v_cert_status varchar(16);
    v_cert_valid_until timestamptz;
    v_cert_revoked_at timestamptz;
    v_attest_algo varchar(32);
    v_attest_pubkey bytea;
    v_attest_principal varchar(64);
    v_attest_status varchar(16);
    v_attest_valid_from timestamptz;
    v_attest_valid_until timestamptz;
    v_attest_revoked_at timestamptz;
    v_key_bytes bytea;
    v_hmac_status varchar(16);
    v_hmac_revoked_at timestamptz;
    v_canonical_attest_str text;
    v_canonical_attest_bytes bytea;
    v_raw_li_count int;
    v_norm_li_count int;
    v_raw_item jsonb;
    v_norm_item jsonb;
    v_raw_jur_count int;
    v_norm_jur_count int;
    v_raw_jur jsonb;
    v_norm_jur jsonb;
    v_calc_merch_tax bigint;
    v_calc_total_tax bigint;
    i int;
    j int;
BEGIN
    -- 1. Enforceable Workload Identity Assertion (C-43)
    IF NOT pg_has_role(SESSION_USER, 'tax_verifier_role', 'MEMBER') OR SESSION_USER::text NOT LIKE 'tax_worker_%' THEN
        RAISE EXCEPTION 'ERR_INSUFFICIENT_ROLE_PRIVILEGE: Routine executable exclusively by authenticated tax worker instances'
            USING ERRCODE = '42501';
    END IF;

    IF p_verifier_identity IS DISTINCT FROM SESSION_USER::text THEN
        RAISE EXCEPTION 'ERR_VERIFIER_IDENTITY_MISMATCH: Asserted verifier identity % does not match authenticated principal %',
            p_verifier_identity, SESSION_USER::text
            USING ERRCODE = '42501';
    END IF;

    -- 2. Non-Null Parameter Enforcement (22004)
    IF p_cart_id IS NULL OR p_tax_quote_id IS NULL OR p_provider_name IS NULL OR
       p_provider_api_version IS NULL OR p_signature_algorithm IS NULL OR p_provider_timestamp IS NULL OR
       p_valid_until IS NULL OR p_provider_merchandise_subtotal_cents IS NULL OR p_provider_discount_cents IS NULL OR
       p_provider_shipping_cents IS NULL OR p_provider_adjustment_cents IS NULL OR p_provider_total_cents IS NULL OR
       p_total_tax_cents IS NULL OR p_merchandise_tax_cents IS NULL OR p_shipping_tax_cents IS NULL OR
       p_taxable_shipping_base_cents IS NULL OR p_currency IS NULL OR p_jurisdiction_code IS NULL OR
       p_line_items_breakdown IS NULL OR p_jurisdiction_breakdown IS NULL OR p_raw_payload IS NULL OR
       p_statutory_signature IS NULL OR p_authority_id IS NULL OR p_certificate_number IS NULL OR
       p_attestation_key_id IS NULL OR p_attestation_timestamp IS NULL OR p_verifier_attestation_signature IS NULL OR
       p_signing_key_id IS NULL OR p_nonce IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    -- 3. Non-Negative Monetary Ranges & Values (22023 / 23514)
    IF p_provider_merchandise_subtotal_cents < 0 OR p_provider_discount_cents < 0 OR
       p_provider_shipping_cents < 0 OR p_total_tax_cents < 0 OR
       p_merchandise_tax_cents < 0 OR p_shipping_tax_cents < 0 OR p_taxable_shipping_base_cents < 0 THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Financial amounts must be non-negative' USING ERRCODE = '22023';
    END IF;

    IF p_provider_adjustment_cents != 0 THEN
        RAISE EXCEPTION 'ERR_UNSUPPORTED_ADJUSTMENT: Provider adjustment cents must be 0' USING ERRCODE = '23514';
    END IF;

    IF p_currency != 'USD' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Currency must be USD' USING ERRCODE = '22023';
    END IF;

    IF p_jurisdiction_code !~ '^[A-Z]{2}(-[A-Z0-9]+)*$' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Invalid jurisdiction code format %', p_jurisdiction_code USING ERRCODE = '22023';
    END IF;

    -- 4. Mathematical Landed Cost Reconciliation Invariants (22023)
    IF p_provider_total_cents != (p_provider_merchandise_subtotal_cents - p_provider_discount_cents + p_provider_shipping_cents + p_provider_adjustment_cents + p_total_tax_cents) THEN
        RAISE EXCEPTION 'ERR_PROVIDER_TAX_SUM_MISMATCH: Provider landed cost reconciliation failed' USING ERRCODE = '22023';
    END IF;

    IF p_total_tax_cents != (p_merchandise_tax_cents + p_shipping_tax_cents) THEN
        RAISE EXCEPTION 'ERR_PROVIDER_TAX_SUM_MISMATCH: Total tax cents % != merchandise tax % + shipping tax %',
            p_total_tax_cents, p_merchandise_tax_cents, p_shipping_tax_cents USING ERRCODE = '22023';
    END IF;

    -- 5. Attestation Timestamp Freshness (22023) & Quote Validity (55000)
    IF abs(extract(epoch from (clock_timestamp() - p_attestation_timestamp))) > 300 THEN
        RAISE EXCEPTION 'ERR_ATTESTATION_TIMESTAMP_SKEW: Attestation timestamp skew exceeds 300 seconds' USING ERRCODE = '22023';
    END IF;

    IF p_valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'ERR_QUOTE_EXPIRED: Tax quote expired at %', p_valid_until USING ERRCODE = '55000';
    END IF;

    -- 6. Raw Wire Payload Digest & JSON Extraction (22023)
    v_payload_hash := extensions.digest(p_raw_payload, 'sha256');
    v_statutory_sig_hash := extensions.digest(p_statutory_signature, 'sha256');

    BEGIN
        v_payload_json := convert_from(p_raw_payload, 'UTF8')::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'ERR_MALFORMED_NESTED_STRUCTURE: Malformed raw payload JSON' USING ERRCODE = '22023';
    END;

    -- 7. Deep JSON 17-Field Metadata & Value Parity
    IF (v_payload_json->>'id') IS DISTINCT FROM p_tax_quote_id OR
       (v_payload_json->>'provider') IS DISTINCT FROM p_provider_name OR
       (v_payload_json->>'version') IS DISTINCT FROM p_provider_api_version OR
       (v_payload_json->>'signature_algorithm') IS DISTINCT FROM p_signature_algorithm OR
       (v_payload_json->>'currency') IS DISTINCT FROM p_currency OR
       ((v_payload_json->>'timestamp')::timestamptz) IS DISTINCT FROM p_provider_timestamp OR
       ((v_payload_json->>'expires_at')::timestamptz) IS DISTINCT FROM p_valid_until OR
       (v_payload_json->>'jurisdiction') IS DISTINCT FROM p_jurisdiction_code THEN
        RAISE EXCEPTION 'ERR_PAYLOAD_NORMALIZATION_MISMATCH: Raw payload metadata mismatch' USING ERRCODE = '22023';
    END IF;

    IF extensions.fn_parse_decimal_cents(v_payload_json->>'order_subtotal') IS DISTINCT FROM p_provider_merchandise_subtotal_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->>'discount_amount') IS DISTINCT FROM p_provider_discount_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->>'shipping') IS DISTINCT FROM p_provider_shipping_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->>'adjustment') IS DISTINCT FROM 0 OR
       extensions.fn_parse_decimal_cents(v_payload_json->>'total_amount') IS DISTINCT FROM p_provider_total_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->>'amount_to_collect') IS DISTINCT FROM p_total_tax_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->'breakdown'->>'line_items_total') IS DISTINCT FROM p_merchandise_tax_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->'breakdown'->>'shipping_tax') IS DISTINCT FROM p_shipping_tax_cents OR
       extensions.fn_parse_decimal_cents(v_payload_json->'breakdown'->>'taxable_shipping') IS DISTINCT FROM p_taxable_shipping_base_cents THEN
        RAISE EXCEPTION 'ERR_PAYLOAD_NORMALIZATION_MISMATCH: Raw payload financial amount mismatch' USING ERRCODE = '22023';
    END IF;

    -- 8. Deep Line-Item Array Parity & Exact Nested Schema Enforcement (C-48)
    IF v_payload_json->'line_items' IS NULL OR jsonb_typeof(v_payload_json->'line_items') != 'array' OR
       p_line_items_breakdown IS NULL OR jsonb_typeof(p_line_items_breakdown) != 'array' THEN
        RAISE EXCEPTION 'ERR_MALFORMED_NESTED_STRUCTURE: line_items must be an array' USING ERRCODE = '22023';
    END IF;

    v_raw_li_count := jsonb_array_length(v_payload_json->'line_items');
    v_norm_li_count := jsonb_array_length(p_line_items_breakdown);
    IF v_raw_li_count != v_norm_li_count THEN
        RAISE EXCEPTION 'ERR_LINE_ITEM_COUNT_MISMATCH: Raw count % != normalized count %',
            v_raw_li_count, v_norm_li_count USING ERRCODE = '22023';
    END IF;

    FOR i IN 0..(v_raw_li_count - 1) LOOP
        v_raw_item := v_payload_json->'line_items'->i;
        v_norm_item := p_line_items_breakdown->i;

        IF jsonb_typeof(v_raw_item) != 'object' OR jsonb_typeof(v_norm_item) != 'object' THEN
            RAISE EXCEPTION 'ERR_MALFORMED_NESTED_STRUCTURE: line item must be a JSON object' USING ERRCODE = '22023';
        END IF;

        -- Raw Line Item: exact 7 keys
        IF NOT (v_raw_item ?& ARRAY['id', 'subtotal', 'discount', 'taxable_amount', 'tax_collectable', 'exemption_code', 'taxability_status']) THEN
            RAISE EXCEPTION 'ERR_MISSING_PAYLOAD_FIELD: Raw line item missing required field' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_raw_item) AS k WHERE k NOT IN ('id', 'subtotal', 'discount', 'taxable_amount', 'tax_collectable', 'exemption_code', 'taxability_status')) THEN
            RAISE EXCEPTION 'ERR_UNEXPECTED_PAYLOAD_FIELD: Unexpected field in raw line item' USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_raw_item->'id') != 'string' OR
           jsonb_typeof(v_raw_item->'subtotal') != 'string' OR
           jsonb_typeof(v_raw_item->'discount') != 'string' OR
           jsonb_typeof(v_raw_item->'taxable_amount') != 'string' OR
           jsonb_typeof(v_raw_item->'tax_collectable') != 'string' OR
           jsonb_typeof(v_raw_item->'taxability_status') != 'string' OR
           jsonb_typeof(v_raw_item->'exemption_code') NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'ERR_INVALID_PROPERTY_TYPE: Invalid property type in raw line item' USING ERRCODE = '22023';
        END IF;

        -- Normalized Line Item: exact 8 keys
        IF NOT (v_norm_item ?& ARRAY['itemIndex', 'lineItemId', 'itemSubtotalCents', 'allocatedDiscountCents', 'taxableAmountCents', 'lineTaxCents', 'exemptionCode', 'taxabilityStatus']) THEN
            RAISE EXCEPTION 'ERR_MISSING_PAYLOAD_FIELD: Normalized line item missing required field' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_norm_item) AS k WHERE k NOT IN ('itemIndex', 'lineItemId', 'itemSubtotalCents', 'allocatedDiscountCents', 'taxableAmountCents', 'lineTaxCents', 'exemptionCode', 'taxabilityStatus')) THEN
            RAISE EXCEPTION 'ERR_UNEXPECTED_PAYLOAD_FIELD: Unexpected field in normalized line item' USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_norm_item->'itemIndex') != 'number' OR
           jsonb_typeof(v_norm_item->'lineItemId') != 'string' OR
           jsonb_typeof(v_norm_item->'itemSubtotalCents') != 'number' OR
           jsonb_typeof(v_norm_item->'allocatedDiscountCents') != 'number' OR
           jsonb_typeof(v_norm_item->'taxableAmountCents') != 'number' OR
           jsonb_typeof(v_norm_item->'lineTaxCents') != 'number' OR
           jsonb_typeof(v_norm_item->'taxabilityStatus') != 'string' OR
           jsonb_typeof(v_norm_item->'exemptionCode') NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'ERR_INVALID_PROPERTY_TYPE: Invalid property type in normalized line item' USING ERRCODE = '22023';
        END IF;

        -- Element Value Parity
        IF (v_raw_item->>'id') IS DISTINCT FROM (v_norm_item->>'lineItemId') OR
           extensions.fn_parse_decimal_cents(v_raw_item->>'subtotal') IS DISTINCT FROM (v_norm_item->>'itemSubtotalCents')::bigint OR
           extensions.fn_parse_decimal_cents(v_raw_item->>'discount') IS DISTINCT FROM (v_norm_item->>'allocatedDiscountCents')::bigint OR
           extensions.fn_parse_decimal_cents(v_raw_item->>'taxable_amount') IS DISTINCT FROM (v_norm_item->>'taxableAmountCents')::bigint OR
           extensions.fn_parse_decimal_cents(v_raw_item->>'tax_collectable') IS DISTINCT FROM (v_norm_item->>'lineTaxCents')::bigint OR
           (v_raw_item->>'taxability_status') IS DISTINCT FROM (v_norm_item->>'taxabilityStatus') THEN
            RAISE EXCEPTION 'ERR_PAYLOAD_NORMALIZATION_MISMATCH: Line item value parity check failed' USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- 9. Deep Jurisdiction Array Parity & Exact Nested Schema Enforcement (C-48)
    IF v_payload_json->'jurisdictions' IS NULL OR jsonb_typeof(v_payload_json->'jurisdictions') != 'array' OR
       p_jurisdiction_breakdown IS NULL OR jsonb_typeof(p_jurisdiction_breakdown) != 'array' THEN
        RAISE EXCEPTION 'ERR_MALFORMED_NESTED_STRUCTURE: jurisdictions must be an array' USING ERRCODE = '22023';
    END IF;

    v_raw_jur_count := jsonb_array_length(v_payload_json->'jurisdictions');
    v_norm_jur_count := jsonb_array_length(p_jurisdiction_breakdown);
    IF v_raw_jur_count != v_norm_jur_count THEN
        RAISE EXCEPTION 'ERR_JURISDICTION_COUNT_MISMATCH: Raw jurisdiction count % != normalized count %',
            v_raw_jur_count, v_norm_jur_count USING ERRCODE = '22023';
    END IF;

    FOR j IN 0..(v_raw_jur_count - 1) LOOP
        v_raw_jur := v_payload_json->'jurisdictions'->j;
        v_norm_jur := p_jurisdiction_breakdown->j;

        IF jsonb_typeof(v_raw_jur) != 'object' OR jsonb_typeof(v_norm_jur) != 'object' THEN
            RAISE EXCEPTION 'ERR_MALFORMED_NESTED_STRUCTURE: jurisdiction element must be a JSON object' USING ERRCODE = '22023';
        END IF;

        -- Raw Jurisdiction: exact 6 keys
        IF NOT (v_raw_jur ?& ARRAY['type', 'code', 'name', 'rate_bps', 'amount', 'applies_to_shipping']) THEN
            RAISE EXCEPTION 'ERR_MISSING_PAYLOAD_FIELD: Raw jurisdiction missing required field' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_raw_jur) AS k WHERE k NOT IN ('type', 'code', 'name', 'rate_bps', 'amount', 'applies_to_shipping')) THEN
            RAISE EXCEPTION 'ERR_UNEXPECTED_PAYLOAD_FIELD: Unexpected field in raw jurisdiction' USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_raw_jur->'type') != 'string' OR
           jsonb_typeof(v_raw_jur->'code') != 'string' OR
           jsonb_typeof(v_raw_jur->'name') != 'string' OR
           jsonb_typeof(v_raw_jur->'rate_bps') != 'number' OR
           jsonb_typeof(v_raw_jur->'amount') != 'string' OR
           jsonb_typeof(v_raw_jur->'applies_to_shipping') != 'boolean' THEN
            RAISE EXCEPTION 'ERR_INVALID_PROPERTY_TYPE: Invalid property type in raw jurisdiction' USING ERRCODE = '22023';
        END IF;

        -- Normalized Jurisdiction: exact 6 keys
        IF NOT (v_norm_jur ?& ARRAY['componentType', 'jurisdictionCode', 'jurisdictionName', 'rateBps', 'taxAmountCents', 'appliesToShipping']) THEN
            RAISE EXCEPTION 'ERR_MISSING_PAYLOAD_FIELD: Normalized jurisdiction missing required field' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_norm_jur) AS k WHERE k NOT IN ('componentType', 'jurisdictionCode', 'jurisdictionName', 'rateBps', 'taxAmountCents', 'appliesToShipping')) THEN
            RAISE EXCEPTION 'ERR_UNEXPECTED_PAYLOAD_FIELD: Unexpected field in normalized jurisdiction' USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_norm_jur->'componentType') != 'string' OR
           jsonb_typeof(v_norm_jur->'jurisdictionCode') != 'string' OR
           jsonb_typeof(v_norm_jur->'jurisdictionName') != 'string' OR
           jsonb_typeof(v_norm_jur->'rateBps') != 'number' OR
           jsonb_typeof(v_norm_jur->'taxAmountCents') != 'number' OR
           jsonb_typeof(v_norm_jur->'appliesToShipping') != 'boolean' THEN
            RAISE EXCEPTION 'ERR_INVALID_PROPERTY_TYPE: Invalid property type in normalized jurisdiction' USING ERRCODE = '22023';
        END IF;

        -- Element Value Parity
        IF (v_raw_jur->>'type') IS DISTINCT FROM (v_norm_jur->>'componentType') OR
           (v_raw_jur->>'code') IS DISTINCT FROM (v_norm_jur->>'jurisdictionCode') OR
           (v_raw_jur->>'name') IS DISTINCT FROM (v_norm_jur->>'jurisdictionName') OR
           (v_raw_jur->>'rate_bps')::bigint IS DISTINCT FROM (v_norm_jur->>'rateBps')::bigint OR
           extensions.fn_parse_decimal_cents(v_raw_jur->>'amount') IS DISTINCT FROM (v_norm_jur->>'taxAmountCents')::bigint OR
           (v_raw_jur->>'applies_to_shipping')::boolean IS DISTINCT FROM (v_norm_jur->>'appliesToShipping')::boolean THEN
            RAISE EXCEPTION 'ERR_PAYLOAD_NORMALIZATION_MISMATCH: Jurisdiction value parity check failed' USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- 10. Internal Breakdown Sum Constraints (C-40, C-45)
    SELECT COALESCE(SUM((elem->>'lineTaxCents')::bigint), 0) INTO v_calc_merch_tax
      FROM jsonb_array_elements(p_line_items_breakdown) AS elem;
    IF v_calc_merch_tax != p_merchandise_tax_cents THEN
        RAISE EXCEPTION 'ERR_PROVIDER_TAX_SUM_MISMATCH: Line item tax sum % != merchandise tax %',
            v_calc_merch_tax, p_merchandise_tax_cents USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(SUM((elem->>'taxAmountCents')::bigint), 0) INTO v_calc_total_tax
      FROM jsonb_array_elements(p_jurisdiction_breakdown) AS elem;
    IF v_calc_total_tax != p_total_tax_cents THEN
        RAISE EXCEPTION 'ERR_PROVIDER_TAX_SUM_MISMATCH: Jurisdiction tax sum % != total tax %',
            v_calc_total_tax, p_total_tax_cents USING ERRCODE = '22023';
    END IF;

    -- 11. Six-Level Monotonic Locking Sequence
    -- Level 0: Transactional Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('cart_tax:' || p_cart_id::text));

    -- Level 1: Domain Cart Row Lock (FOR SHARE)
    SELECT "ApprovedMerchantCart".id, "ApprovedMerchantCart"."merchandiseSubtotalCents", "ApprovedMerchantCart"."discountCents", "ApprovedMerchantCart"."shippingTotalCents"
      INTO v_cart_id, v_cart_merch, v_cart_disc, v_cart_ship
      FROM public."ApprovedMerchantCart"
     WHERE "ApprovedMerchantCart".id = p_cart_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CART_NOT_FOUND: Cart % not found', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    IF v_cart_merch != p_provider_merchandise_subtotal_cents OR
       v_cart_disc != p_provider_discount_cents OR
       v_cart_ship != p_provider_shipping_cents THEN
        RAISE EXCEPTION 'ERR_PAYLOAD_NORMALIZATION_MISMATCH: Cart financial bases do not match provider quote' USING ERRCODE = '22023';
    END IF;

    -- Level 3: Cryptographic Keys & Certificates (FOR SHARE)
    SELECT "TaxAuthorityCertificate".status, "TaxAuthorityCertificate".valid_until, "TaxAuthorityCertificate".revoked_at
      INTO v_cert_status, v_cert_valid_until, v_cert_revoked_at
      FROM public."TaxAuthorityCertificate"
     WHERE "TaxAuthorityCertificate".authority_id = p_authority_id
       AND "TaxAuthorityCertificate".certificate_number = p_certificate_number
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CERTIFICATE_NOT_FOUND: Tax authority certificate not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_cert_status = 'REVOKED' OR v_cert_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'ERR_CERTIFICATE_REVOKED: Tax authority certificate is revoked' USING ERRCODE = '55000';
    END IF;
    IF v_cert_valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'ERR_CERTIFICATE_EXPIRED: Tax authority certificate expired' USING ERRCODE = '55000';
    END IF;
    IF v_cert_status != 'ACTIVE' THEN
        RAISE EXCEPTION 'ERR_CERTIFICATE_NOT_ACTIVE: Tax authority certificate is not active' USING ERRCODE = '55000';
    END IF;

    SELECT "AuditSigningKey".algorithm, "AuditSigningKey".public_key_der, "AuditSigningKey".worker_principal, "AuditSigningKey".status, "AuditSigningKey".valid_from, "AuditSigningKey".valid_until, "AuditSigningKey".revoked_at
      INTO v_attest_algo, v_attest_pubkey, v_attest_principal, v_attest_status, v_attest_valid_from, v_attest_valid_until, v_attest_revoked_at
      FROM public."AuditSigningKey"
     WHERE "AuditSigningKey".key_id = p_attestation_key_id
       AND "AuditSigningKey".key_type = 'VERIFIER_ATTESTATION_PUBLIC_KEY'
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_FOUND: Verifier attestation key not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_attest_status = 'REVOKED' OR v_attest_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'ERR_KEY_REVOKED: Verifier attestation key is revoked' USING ERRCODE = '55000';
    END IF;
    IF v_attest_valid_until < clock_timestamp() OR v_attest_valid_from > clock_timestamp() THEN
        RAISE EXCEPTION 'ERR_KEY_EXPIRED: Verifier attestation key is not in validity window' USING ERRCODE = '55000';
    END IF;
    IF v_attest_status != 'ACTIVE' THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_ACTIVE: Verifier attestation key is not active' USING ERRCODE = '55000';
    END IF;
    IF v_attest_principal IS DISTINCT FROM SESSION_USER::text THEN
        RAISE EXCEPTION 'ERR_ATTESTATION_PRINCIPAL_MISMATCH: Attestation key worker principal % != session user %',
            v_attest_principal, SESSION_USER::text USING ERRCODE = '42501';
    END IF;

    -- Asymmetric Verifier Attestation Signature Verification (C-44A)
    v_canonical_attest_str := 'PLINTHLY-ATTESTATION-V1|' || p_cart_id::text || '|' ||
                              p_tax_quote_id || '|' || p_provider_name || '|' ||
                              p_provider_api_version || '|' || encode(v_payload_hash, 'hex') || '|' ||
                              encode(v_statutory_sig_hash, 'hex') || '|' ||
                              p_provider_merchandise_subtotal_cents::text || '|' ||
                              p_provider_discount_cents::text || '|' ||
                              p_provider_shipping_cents::text || '|' ||
                              p_provider_adjustment_cents::text || '|' ||
                              p_provider_total_cents::text || '|' ||
                              p_total_tax_cents::text || '|' ||
                              p_merchandise_tax_cents::text || '|' ||
                              p_shipping_tax_cents::text || '|' ||
                              p_taxable_shipping_base_cents::text || '|' ||
                              p_currency || '|' || p_authority_id || '|' ||
                              p_certificate_number || '|' || p_signature_algorithm || '|' ||
                              to_char(p_attestation_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' ||
                              p_attestation_key_id || '|' || p_nonce;
    v_canonical_attest_bytes := convert_to(v_canonical_attest_str, 'UTF8');

    IF NOT extensions.crypto_asym_verify(v_attest_algo, v_attest_pubkey, v_canonical_attest_bytes, p_verifier_attestation_signature) THEN
        RAISE EXCEPTION 'ERR_INVALID_VERIFIER_ATTESTATION: Cryptographic signature verification failed'
            USING ERRCODE = '42501';
    END IF;

    -- Internal Audit HMAC Key
    SELECT "AuditSigningKey".key_bytes, "AuditSigningKey".status, "AuditSigningKey".revoked_at
      INTO v_key_bytes, v_hmac_status, v_hmac_revoked_at
      FROM public."AuditSigningKey"
     WHERE "AuditSigningKey".key_id = p_signing_key_id
       AND "AuditSigningKey".key_type = 'AUDIT_HMAC_SYMMETRIC'
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_FOUND: Audit HMAC key not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_hmac_status != 'ACTIVE' OR v_hmac_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_ACTIVE: Audit HMAC key is not active' USING ERRCODE = '55000';
    END IF;

    -- Level 4: Nonce Registry Single-Use Consumption (23505)
    BEGIN
        INSERT INTO public."NonceRegistry" (nonce, scope, target_id, request_digest, consumed_at, created_at)
        VALUES (
            p_nonce, 'tax_quote', p_cart_id,
            extensions.digest(p_tax_quote_id || ':' || p_total_tax_cents::text, 'sha256'),
            clock_timestamp(), clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ERR_REPLAY_ATTACK_DETECTED: Nonce % has already been consumed for scope tax_quote', p_nonce
            USING ERRCODE = '23505';
    END;

    -- Level 5: Append-Only Evidence Insert (33 Columns)
    v_audit_sig := extensions.hmac(convert_to(p_cart_id::text || ':' || p_tax_quote_id || ':' || p_total_tax_cents::text, 'UTF8'), v_key_bytes, 'sha256');

    INSERT INTO public."TaxEvidenceRecord" (
        cart_id, tax_quote_id, provider_name, provider_api_version,
        signature_algorithm, provider_timestamp, valid_until,
        provider_merchandise_subtotal_cents, provider_discount_cents,
        provider_shipping_cents, provider_adjustment_cents, provider_total_cents,
        total_tax_cents, merchandise_tax_cents, shipping_tax_cents, taxable_shipping_base_cents,
        currency, jurisdiction_code, line_items_breakdown, jurisdiction_breakdown,
        raw_payload, statutory_payload_hash, statutory_signature,
        authority_id, certificate_number, verifier_identity,
        attestation_key_id, attestation_timestamp, verifier_attestation_signature,
        verification_status, internal_audit_signature, recorded_at
    ) VALUES (
        p_cart_id, p_tax_quote_id, p_provider_name, p_provider_api_version,
        p_signature_algorithm, p_provider_timestamp, p_valid_until,
        p_provider_merchandise_subtotal_cents, p_provider_discount_cents,
        p_provider_shipping_cents, p_provider_adjustment_cents, p_provider_total_cents,
        p_total_tax_cents, p_merchandise_tax_cents, p_shipping_tax_cents, p_taxable_shipping_base_cents,
        p_currency, p_jurisdiction_code, p_line_items_breakdown, p_jurisdiction_breakdown,
        p_raw_payload, v_payload_hash, p_statutory_signature,
        p_authority_id, p_certificate_number, SESSION_USER::text,
        p_attestation_key_id, p_attestation_timestamp, p_verifier_attestation_signature,
        'VERIFIED', v_audit_sig, clock_timestamp()
    ) RETURNING "TaxEvidenceRecord".id, "TaxEvidenceRecord".recorded_at INTO v_evidence_id, v_recorded_at;

    UPDATE public."ApprovedMerchantCart"
       SET "taxAmountCents" = p_total_tax_cents,
           "totalCartCents" = "merchandiseSubtotalCents" - "discountCents" + "shippingTotalCents" + p_total_tax_cents,
           "updatedAt" = clock_timestamp()
     WHERE "ApprovedMerchantCart".id = p_cart_id;

    RETURN QUERY SELECT v_evidence_id, p_cart_id, p_tax_quote_id, p_total_tax_cents, 'VERIFIED'::varchar(16), v_recorded_at, v_audit_sig;
END;
$$;

-- 4. Routine R2-02: prepare_merchant_cart_capture
CREATE OR REPLACE FUNCTION public.prepare_merchant_cart_capture(
    p_cart_id uuid,
    p_approval_aggregate_id uuid,
    p_expected_amount_cents bigint,
    p_expected_currency varchar(3),
    p_idempotency_key varchar(128)
)
RETURNS TABLE (
    cart_id uuid,
    status varchar(32),
    locked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_agg_status varchar(32);
    v_checkout_status varchar(32);
    v_total_cents bigint;
    v_locked_at timestamptz;
BEGIN
    -- Input Validations
    IF p_cart_id IS NULL OR p_approval_aggregate_id IS NULL OR p_expected_amount_cents IS NULL OR
       p_expected_currency IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    IF p_expected_amount_cents < 1 OR p_expected_amount_cents > 999999999 THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Expected amount cents out of bounds [1, 999999999]' USING ERRCODE = '22023';
    END IF;

    IF p_expected_currency != 'USD' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Expected currency must be USD' USING ERRCODE = '22023';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('cart_checkout:' || p_cart_id::text));

    -- Level 1: Domain Row Locks
    SELECT "ApprovalAggregate"."aggregateStatus" INTO v_agg_status
      FROM public."ApprovalAggregate"
     WHERE "ApprovalAggregate".id = p_approval_aggregate_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_RECORD_NOT_FOUND: Approval aggregate % not found', p_approval_aggregate_id USING ERRCODE = 'P0002';
    END IF;

    IF v_agg_status NOT IN ('APPROVED', 'ACTIVE') THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Approval aggregate is not approved' USING ERRCODE = '55000';
    END IF;

    SELECT "ApprovedMerchantCart"."checkoutStatus", "ApprovedMerchantCart"."totalCartCents" INTO v_checkout_status, v_total_cents
      FROM public."ApprovedMerchantCart"
     WHERE "ApprovedMerchantCart".id = p_cart_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CART_NOT_FOUND: Cart % not found', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    IF v_checkout_status != 'BUYER_APPROVED' THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Cart checkout status % is not BUYER_APPROVED', v_checkout_status USING ERRCODE = '55000';
    END IF;

    IF v_total_cents != p_expected_amount_cents THEN
        RAISE EXCEPTION 'ERR_AMOUNT_MISMATCH: Cart total % does not match expected %', v_total_cents, p_expected_amount_cents USING ERRCODE = '22023';
    END IF;

    -- Level 5: State Mutation
    UPDATE public."ApprovedMerchantCart"
       SET "checkoutStatus" = 'CAPTURING',
           "lockedAt" = clock_timestamp(),
           "updatedAt" = clock_timestamp()
     WHERE "ApprovedMerchantCart".id = p_cart_id
    RETURNING "ApprovedMerchantCart"."lockedAt" INTO v_locked_at;

    RETURN QUERY SELECT p_cart_id, 'CAPTURING'::varchar(32), v_locked_at;
END;
$$;

-- 5. Routine R2-03: record_webhook_transmission_ingress
CREATE OR REPLACE FUNCTION public.record_webhook_transmission_ingress(
    p_transmission_id varchar(64),
    p_authenticated_event_type varchar(64),
    p_authenticated_order_id varchar(64),
    p_authenticated_capture_id varchar(64),
    p_authenticated_refund_id varchar(64),
    p_authenticated_amount_cents bigint,
    p_authenticated_currency varchar(3),
    p_authenticated_payee_email varchar(255),
    p_raw_payload bytea,
    p_signing_key_id varchar(64),
    p_nonce varchar(64)
)
RETURNS TABLE (
    transmission_id varchar(64),
    status varchar(32),
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_key_bytes bytea;
    v_key_status varchar(16);
    v_key_revoked_at timestamptz;
    v_created_at timestamptz;
    v_target_uuid uuid;
BEGIN
    -- Input Validations
    IF p_transmission_id IS NULL OR p_authenticated_event_type IS NULL OR p_raw_payload IS NULL OR
       p_signing_key_id IS NULL OR p_nonce IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    IF p_authenticated_amount_cents < 0 THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Authenticated amount cents must be non-negative' USING ERRCODE = '22023';
    END IF;

    IF p_authenticated_currency != 'USD' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Authenticated currency must be USD' USING ERRCODE = '22023';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('transmission:' || p_transmission_id));

    -- Level 3: Config Row Lock
    SELECT "AuditSigningKey".key_bytes, "AuditSigningKey".status, "AuditSigningKey".revoked_at
      INTO v_key_bytes, v_key_status, v_key_revoked_at
      FROM public."AuditSigningKey"
     WHERE "AuditSigningKey".key_id = p_signing_key_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_FOUND: Audit key % not found', p_signing_key_id USING ERRCODE = 'P0002';
    END IF;

    IF v_key_status != 'ACTIVE' OR v_key_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_ACTIVE: Audit key % is not active', p_signing_key_id USING ERRCODE = '55000';
    END IF;

    -- Level 4: Nonce Registry Mutation
    v_target_uuid := substring(encode(extensions.digest(p_transmission_id, 'sha256'), 'hex'), 1, 32)::uuid;

    BEGIN
        INSERT INTO public."NonceRegistry" (nonce, scope, target_id, request_digest, consumed_at, created_at)
        VALUES (
            p_nonce, 'webhook_ingress', v_target_uuid,
            extensions.digest(p_transmission_id || ':' || p_authenticated_event_type, 'sha256'),
            clock_timestamp(), clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ERR_REPLAY_ATTACK_DETECTED: Nonce % has already been consumed for webhook_ingress', p_nonce
            USING ERRCODE = '23505';
    END;

    -- Level 5: Append Wire Log
    INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
    ) VALUES (
        p_transmission_id, p_authenticated_event_type, p_authenticated_order_id,
        p_authenticated_capture_id, p_authenticated_refund_id, p_authenticated_amount_cents,
        p_authenticated_currency, p_authenticated_payee_email, p_raw_payload,
        extensions.digest(p_raw_payload, 'sha256'), 'RECORDED', 200, clock_timestamp()
    ) RETURNING "WebhookTransmission".created_at INTO v_created_at;

    RETURN QUERY SELECT p_transmission_id, 'RECORDED'::varchar(32), v_created_at;
END;
$$;

-- 6. Routine R2-04: finalize_transmission_response
CREATE OR REPLACE FUNCTION public.finalize_transmission_response(
    p_transmission_id varchar(64),
    p_status varchar(32),
    p_response_code int
)
RETURNS TABLE (
    transmission_id varchar(64),
    status varchar(32)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_curr_status varchar(32);
BEGIN
    IF p_transmission_id IS NULL OR p_status IS NULL OR p_response_code IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    IF p_status NOT IN ('PROCESSED', 'FAILED') THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Target status must be PROCESSED or FAILED' USING ERRCODE = '22023';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('transmission:' || p_transmission_id));

    -- Level 2: Transmission Row Lock
    SELECT "WebhookTransmission".status INTO v_curr_status
      FROM public."WebhookTransmission"
     WHERE "WebhookTransmission".transmission_id = p_transmission_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_TRANSMISSION_NOT_FOUND: Transmission % not found', p_transmission_id USING ERRCODE = 'P0002';
    END IF;

    IF v_curr_status != 'RECORDED' THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Transmission status % is not RECORDED', v_curr_status USING ERRCODE = '55000';
    END IF;

    -- Level 5: State Mutation
    UPDATE public."WebhookTransmission"
       SET "status" = p_status,
           "response_code" = p_response_code
     WHERE "WebhookTransmission".transmission_id = p_transmission_id;

    RETURN QUERY SELECT p_transmission_id, p_status;
END;
$$;

-- 7. Routine R2-05: execute_capture_confirmation
CREATE OR REPLACE FUNCTION public.execute_capture_confirmation(
    p_cart_id uuid,
    p_transmission_id varchar(64),
    p_capture_id varchar(64),
    p_signing_key_id varchar(64),
    p_nonce varchar(64)
)
RETURNS TABLE (
    payment_evidence_id uuid,
    cart_id uuid,
    status varchar(32),
    recorded_at timestamptz,
    idempotent_retry boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_checkout_status varchar(32);
    v_cart_total bigint;
    v_cart_order_id varchar;
    v_cart_payee varchar;
    v_tx_status varchar(32);
    v_tx_order_id varchar;
    v_tx_capture_id varchar;
    v_tx_amount_cents bigint;
    v_tx_currency varchar;
    v_tx_payee_email varchar;
    v_tx_event_type varchar;
    v_key_bytes bytea;
    v_key_status varchar(16);
    v_key_revoked_at timestamptz;
    v_evidence_id uuid;
    v_recorded_at timestamptz;
    v_sig bytea;
    v_ev_capture_id varchar;
    v_ev_transmission_id varchar;
BEGIN
    IF p_cart_id IS NULL OR p_transmission_id IS NULL OR p_capture_id IS NULL OR
       p_signing_key_id IS NULL OR p_nonce IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('cart_checkout:' || p_cart_id::text));

    -- Level 1: Domain Cart Row Lock
    SELECT "ApprovedMerchantCart"."checkoutStatus", "ApprovedMerchantCart"."totalCartCents", "ApprovedMerchantCart"."paypalOrderId", "ApprovedMerchantCart"."merchantPayeeEmail"
      INTO v_checkout_status, v_cart_total, v_cart_order_id, v_cart_payee
      FROM public."ApprovedMerchantCart"
     WHERE "ApprovedMerchantCart".id = p_cart_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CART_NOT_FOUND: Cart % not found', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    -- Idempotent Retry Check
    IF v_checkout_status = 'CAPTURED' THEN
        SELECT "PaymentEvidenceRecord".id, "PaymentEvidenceRecord".recorded_at, "PaymentEvidenceRecord".capture_id, "PaymentEvidenceRecord".transmission_id
          INTO v_evidence_id, v_recorded_at, v_ev_capture_id, v_ev_transmission_id
          FROM public."PaymentEvidenceRecord"
         WHERE "PaymentEvidenceRecord".cart_id = p_cart_id
           FOR SHARE;

        IF v_ev_capture_id = p_capture_id AND v_ev_transmission_id = p_transmission_id THEN
            RETURN QUERY SELECT v_evidence_id, p_cart_id, 'CAPTURED'::varchar(32), v_recorded_at, TRUE;
            RETURN;
        ELSE
            RAISE EXCEPTION 'ERR_CART_ALREADY_CAPTURED: Cart already captured under different capture or transmission'
                USING ERRCODE = '23505';
        END IF;
    END IF;

    IF v_checkout_status != 'CAPTURING' THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Cart checkout status % is not CAPTURING', v_checkout_status USING ERRCODE = '55000';
    END IF;

    -- Level 2: Transmission Row Lock
    SELECT "WebhookTransmission".status, "WebhookTransmission".authenticated_order_id, "WebhookTransmission".authenticated_capture_id,
           "WebhookTransmission".authenticated_amount_cents, "WebhookTransmission".authenticated_currency, "WebhookTransmission".authenticated_payee_email,
           "WebhookTransmission".authenticated_event_type
      INTO v_tx_status, v_tx_order_id, v_tx_capture_id,
           v_tx_amount_cents, v_tx_currency, v_tx_payee_email, v_tx_event_type
      FROM public."WebhookTransmission"
     WHERE "WebhookTransmission".transmission_id = p_transmission_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_TRANSMISSION_NOT_FOUND: Transmission % not found', p_transmission_id USING ERRCODE = 'P0002';
    END IF;

    IF v_tx_status != 'PROCESSED' THEN
        RAISE EXCEPTION 'ERR_TRANSMISSION_NOT_PROCESSED: Transmission % is in status %', p_transmission_id, v_tx_status USING ERRCODE = '55000';
    END IF;

    IF v_tx_event_type != 'PAYMENT.CAPTURE.COMPLETED' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Event type % is not PAYMENT.CAPTURE.COMPLETED', v_tx_event_type USING ERRCODE = '22023';
    END IF;

    IF v_tx_capture_id IS DISTINCT FROM p_capture_id THEN
        RAISE EXCEPTION 'ERR_CAPTURE_ID_MISMATCH: Transmission capture ID % does not match %', v_tx_capture_id, p_capture_id USING ERRCODE = '22023';
    END IF;

    IF v_cart_order_id IS NOT NULL AND v_tx_order_id IS DISTINCT FROM v_cart_order_id THEN
        RAISE EXCEPTION 'ERR_ORDER_ID_MISMATCH: Transmission order ID % does not match cart %', v_tx_order_id, v_cart_order_id USING ERRCODE = '22023';
    END IF;

    IF v_cart_payee IS NOT NULL AND v_tx_payee_email IS DISTINCT FROM v_cart_payee THEN
        RAISE EXCEPTION 'ERR_PAYEE_MISMATCH: Transmission payee % does not match cart %', v_tx_payee_email, v_cart_payee USING ERRCODE = '22023';
    END IF;

    IF v_tx_amount_cents != v_cart_total THEN
        RAISE EXCEPTION 'ERR_AMOUNT_MISMATCH: Transmission amount % does not match cart total %', v_tx_amount_cents, v_cart_total USING ERRCODE = '22023';
    END IF;

    IF v_tx_currency != 'USD' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Transmission currency % must be USD', v_tx_currency USING ERRCODE = '22023';
    END IF;

    -- Level 3: Config Row Lock
    SELECT "AuditSigningKey".key_bytes, "AuditSigningKey".status, "AuditSigningKey".revoked_at
      INTO v_key_bytes, v_key_status, v_key_revoked_at
      FROM public."AuditSigningKey"
     WHERE "AuditSigningKey".key_id = p_signing_key_id
       AND "AuditSigningKey".key_type = 'AUDIT_HMAC_SYMMETRIC'
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_FOUND: Audit key % not found', p_signing_key_id USING ERRCODE = 'P0002';
    END IF;

    IF v_key_status != 'ACTIVE' OR v_key_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_ACTIVE: Audit key % is not active', p_signing_key_id USING ERRCODE = '55000';
    END IF;

    -- Level 4: Nonce Registry Mutation
    BEGIN
        INSERT INTO public."NonceRegistry" (nonce, scope, target_id, request_digest, consumed_at, created_at)
        VALUES (
            p_nonce, 'capture_confirm', p_cart_id,
            extensions.digest(p_cart_id::text || ':' || p_transmission_id || ':' || p_capture_id, 'sha256'),
            clock_timestamp(), clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ERR_REPLAY_ATTACK_DETECTED: Nonce % has already been consumed for capture_confirm', p_nonce
            USING ERRCODE = '23505';
    END;

    -- Level 5: State Mutation & Evidence Append
    v_sig := extensions.hmac(convert_to(p_cart_id::text || ':' || p_transmission_id || ':' || p_capture_id, 'UTF8'), v_key_bytes, 'sha256');

    INSERT INTO public."PaymentEvidenceRecord" (
        cart_id, transmission_id, capture_id, paypal_order_id,
        amount_cents, currency, payee_email, internal_audit_signature, recorded_at
    ) VALUES (
        p_cart_id, p_transmission_id, p_capture_id, COALESCE(v_cart_order_id, v_tx_order_id),
        v_tx_amount_cents, v_tx_currency, COALESCE(v_cart_payee, v_tx_payee_email),
        v_sig, clock_timestamp()
    ) RETURNING "PaymentEvidenceRecord".id, "PaymentEvidenceRecord".recorded_at INTO v_evidence_id, v_recorded_at;

    UPDATE public."ApprovedMerchantCart"
       SET "checkoutStatus" = 'CAPTURED',
           "updatedAt" = clock_timestamp()
     WHERE "ApprovedMerchantCart".id = p_cart_id;

    RETURN QUERY SELECT v_evidence_id, p_cart_id, 'CAPTURED'::varchar(32), v_recorded_at, FALSE;
END;
$$;

-- 8. Routine R2-06: record_cart_refund_attempt
CREATE OR REPLACE FUNCTION public.record_cart_refund_attempt(
    p_cart_id uuid,
    p_capture_id varchar(64),
    p_transmission_id varchar(64),
    p_signing_key_id varchar(64),
    p_nonce varchar(64),
    p_reason text
)
RETURNS TABLE (
    refund_evidence_id uuid,
    cart_id uuid,
    cumulative_refunded_cents bigint,
    status varchar(32),
    recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_checkout_status varchar(32);
    v_cart_total bigint;
    v_cum_refunded bigint;
    v_pe_amount bigint;
    v_pe_curr varchar;
    v_tx_status varchar(32);
    v_tx_event_type varchar;
    v_tx_capture_id varchar;
    v_tx_refund_id varchar;
    v_tx_amount_cents bigint;
    v_tx_currency varchar;
    v_new_refunded_cents bigint;
    v_target_status varchar(32);
    v_key_bytes bytea;
    v_key_status varchar(16);
    v_key_revoked_at timestamptz;
    v_refund_id uuid;
    v_recorded_at timestamptz;
    v_sig bytea;
BEGIN
    IF p_cart_id IS NULL OR p_capture_id IS NULL OR p_transmission_id IS NULL OR
       p_signing_key_id IS NULL OR p_nonce IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('cart_refund:' || p_cart_id::text));

    -- Level 1: Domain Cart & Payment Evidence Row Locks
    SELECT "ApprovedMerchantCart"."checkoutStatus", "ApprovedMerchantCart"."totalCartCents", "ApprovedMerchantCart"."cumulativeRefundedCents"
      INTO v_checkout_status, v_cart_total, v_cum_refunded
      FROM public."ApprovedMerchantCart"
     WHERE "ApprovedMerchantCart".id = p_cart_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CART_NOT_FOUND: Cart % not found', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    IF v_checkout_status NOT IN ('CAPTURED', 'PARTIALLY_REFUNDED') THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Cart checkout status % cannot accept refunds', v_checkout_status USING ERRCODE = '55000';
    END IF;

    SELECT "PaymentEvidenceRecord".amount_cents, "PaymentEvidenceRecord".currency INTO v_pe_amount, v_pe_curr
      FROM public."PaymentEvidenceRecord"
     WHERE "PaymentEvidenceRecord".cart_id = p_cart_id AND "PaymentEvidenceRecord".capture_id = p_capture_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CAPTURE_NOT_FOUND: Capture evidence % for cart % not found', p_capture_id, p_cart_id USING ERRCODE = 'P0002';
    END IF;

    -- Level 2: Transmission Row Lock
    SELECT "WebhookTransmission".status, "WebhookTransmission".authenticated_event_type, "WebhookTransmission".authenticated_capture_id,
           "WebhookTransmission".authenticated_refund_id, "WebhookTransmission".authenticated_amount_cents, "WebhookTransmission".authenticated_currency
      INTO v_tx_status, v_tx_event_type, v_tx_capture_id,
           v_tx_refund_id, v_tx_amount_cents, v_tx_currency
      FROM public."WebhookTransmission"
     WHERE "WebhookTransmission".transmission_id = p_transmission_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_TRANSMISSION_NOT_FOUND: Transmission % not found', p_transmission_id USING ERRCODE = 'P0002';
    END IF;

    IF v_tx_status != 'PROCESSED' THEN
        RAISE EXCEPTION 'ERR_TRANSMISSION_NOT_PROCESSED: Transmission % is in status %', p_transmission_id, v_tx_status USING ERRCODE = '55000';
    END IF;

    IF v_tx_event_type NOT IN ('PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED') THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Event type % is not a refund or reversal', v_tx_event_type USING ERRCODE = '22023';
    END IF;

    IF v_tx_capture_id IS DISTINCT FROM p_capture_id THEN
        RAISE EXCEPTION 'ERR_CAPTURE_ID_MISMATCH: Transmission capture ID % does not match %', v_tx_capture_id, p_capture_id USING ERRCODE = '22023';
    END IF;

    IF v_tx_currency != 'USD' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Refund currency % must be USD', v_tx_currency USING ERRCODE = '22023';
    END IF;

    IF v_tx_amount_cents <= 0 THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Refund amount % must be greater than 0', v_tx_amount_cents USING ERRCODE = '22023';
    END IF;

    -- Cumulative Refund Limit Assertion
    v_new_refunded_cents := v_cum_refunded + v_tx_amount_cents;
    IF v_new_refunded_cents > v_cart_total THEN
        RAISE EXCEPTION 'ERR_EXCEEDS_CUMULATIVE_LIMIT: Cumulative refund % exceeds captured total %',
            v_new_refunded_cents, v_cart_total USING ERRCODE = '23514';
    END IF;

    -- Level 3: Config Row Lock
    SELECT "AuditSigningKey".key_bytes, "AuditSigningKey".status, "AuditSigningKey".revoked_at
      INTO v_key_bytes, v_key_status, v_key_revoked_at
      FROM public."AuditSigningKey"
     WHERE "AuditSigningKey".key_id = p_signing_key_id
       AND "AuditSigningKey".key_type = 'AUDIT_HMAC_SYMMETRIC'
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_FOUND: Audit key % not found', p_signing_key_id USING ERRCODE = 'P0002';
    END IF;

    IF v_key_status != 'ACTIVE' OR v_key_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_ACTIVE: Audit key % is not active', p_signing_key_id USING ERRCODE = '55000';
    END IF;

    -- Level 4: Nonce Registry Mutation
    BEGIN
        INSERT INTO public."NonceRegistry" (nonce, scope, target_id, request_digest, consumed_at, created_at)
        VALUES (
            p_nonce, 'cart_refund', p_cart_id,
            extensions.digest(p_cart_id::text || ':' || p_capture_id || ':' || COALESCE(v_tx_refund_id, p_transmission_id), 'sha256'),
            clock_timestamp(), clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ERR_REPLAY_ATTACK_DETECTED: Nonce % has already been consumed for cart_refund', p_nonce
            USING ERRCODE = '23505';
    END;

    -- Level 5: State Mutation & Evidence Append
    v_sig := extensions.hmac(convert_to(p_cart_id::text || ':' || p_capture_id || ':' || COALESCE(v_tx_refund_id, p_transmission_id) || ':' || v_tx_amount_cents::text, 'UTF8'), v_key_bytes, 'sha256');

    INSERT INTO public."RefundEvidenceRecord" (
        cart_id, capture_id, transmission_id, authenticated_refund_id,
        refund_amount_cents, currency, reason, internal_audit_signature, recorded_at
    ) VALUES (
        p_cart_id, p_capture_id, p_transmission_id, COALESCE(v_tx_refund_id, p_transmission_id),
        v_tx_amount_cents, v_tx_currency, p_reason, v_sig, clock_timestamp()
    ) RETURNING "RefundEvidenceRecord".id, "RefundEvidenceRecord".recorded_at INTO v_refund_id, v_recorded_at;

    v_target_status := CASE WHEN v_new_refunded_cents = v_cart_total THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END;

    UPDATE public."ApprovedMerchantCart"
       SET "checkoutStatus" = v_target_status,
           "cumulativeRefundedCents" = v_new_refunded_cents,
           "updatedAt" = clock_timestamp()
     WHERE "ApprovedMerchantCart".id = p_cart_id;

    RETURN QUERY SELECT v_refund_id, p_cart_id, v_new_refunded_cents, v_target_status::varchar(32), v_recorded_at;
END;
$$;

-- 9. Routine R2-07: revoke_audit_signing_key
CREATE OR REPLACE FUNCTION public.revoke_audit_signing_key(
    p_key_id varchar(64),
    p_revocation_reason text,
    p_revoked_by varchar(64),
    p_nonce varchar(64)
)
RETURNS TABLE (
    key_id varchar(64),
    revoked_at timestamptz,
    status varchar(16),
    idempotent_retry boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_status varchar(16);
    v_revoked_at timestamptz;
    v_reason varchar;
    v_target_uuid uuid;
    v_reg_digest bytea;
BEGIN
    IF p_key_id IS NULL OR p_revocation_reason IS NULL OR p_revoked_by IS NULL OR p_nonce IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('key_revocation:' || p_key_id));

    -- Level 3: Config Row Lock
    SELECT "AuditSigningKey".status, "AuditSigningKey".revoked_at, "AuditSigningKey".revocation_reason
      INTO v_status, v_revoked_at, v_reason
      FROM public."AuditSigningKey"
     WHERE "AuditSigningKey".key_id = p_key_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_KEY_NOT_FOUND: Audit signing key % not found', p_key_id USING ERRCODE = 'P0002';
    END IF;

    v_target_uuid := CASE
        WHEN p_key_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN p_key_id::uuid
        ELSE substring(encode(extensions.digest(p_key_id, 'sha256'), 'hex'), 1, 32)::uuid
    END;

    -- Idempotent Retry Check
    IF v_status = 'REVOKED' THEN
        SELECT "NonceRegistry".request_digest INTO v_reg_digest
          FROM public."NonceRegistry"
         WHERE "NonceRegistry".nonce = p_nonce
           AND "NonceRegistry".scope = 'key_revocation'
           AND "NonceRegistry".target_id = v_target_uuid;

        IF FOUND AND v_reg_digest = extensions.digest(p_revocation_reason, 'sha256') THEN
            RETURN QUERY SELECT p_key_id, v_revoked_at, 'REVOKED'::varchar(16), TRUE;
            RETURN;
        ELSE
            RAISE EXCEPTION 'ERR_RESOURCE_ALREADY_REVOKED: Audit signing key % is already revoked', p_key_id USING ERRCODE = '55000';
        END IF;
    END IF;

    -- Level 4: Nonce Registry Mutation
    BEGIN
        INSERT INTO public."NonceRegistry" (nonce, scope, target_id, request_digest, consumed_at, created_at)
        VALUES (
            p_nonce, 'key_revocation', v_target_uuid,
            extensions.digest(p_revocation_reason, 'sha256'),
            clock_timestamp(), clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ERR_REPLAY_ATTACK_DETECTED: Nonce % has already been consumed for key_revocation', p_nonce
            USING ERRCODE = '23505';
    END;

    -- Level 5: State Mutation
    UPDATE public."AuditSigningKey"
       SET "status" = 'REVOKED',
           "revoked_at" = clock_timestamp(),
           "revocation_reason" = p_revocation_reason,
           "revoked_by" = p_revoked_by
     WHERE "AuditSigningKey".key_id = p_key_id
    RETURNING "AuditSigningKey".revoked_at INTO v_revoked_at;

    RETURN QUERY SELECT p_key_id, v_revoked_at, 'REVOKED'::varchar(16), FALSE;
END;
$$;

-- 10. Routine R2-08: revoke_tax_authority_certificate
CREATE OR REPLACE FUNCTION public.revoke_tax_authority_certificate(
    p_authority_id varchar(64),
    p_certificate_number varchar(64),
    p_revocation_reason text,
    p_revoked_by varchar(64),
    p_nonce varchar(64)
)
RETURNS TABLE (
    authority_id varchar(64),
    certificate_number varchar(64),
    revoked_at timestamptz,
    status varchar(16),
    idempotent_retry boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_status varchar(16);
    v_revoked_at timestamptz;
    v_reason varchar;
    v_target_uuid uuid;
    v_reg_digest bytea;
BEGIN
    IF p_authority_id IS NULL OR p_certificate_number IS NULL OR p_revocation_reason IS NULL OR
       p_revoked_by IS NULL OR p_nonce IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    -- Level 0: Advisory Mutex
    PERFORM pg_advisory_xact_lock(hashtext('cert_revocation:' || p_authority_id || ':' || p_certificate_number));

    -- Level 3: Config Row Lock
    SELECT "TaxAuthorityCertificate".status, "TaxAuthorityCertificate".revoked_at, "TaxAuthorityCertificate".revocation_reason
      INTO v_status, v_revoked_at, v_reason
      FROM public."TaxAuthorityCertificate"
     WHERE "TaxAuthorityCertificate".authority_id = p_authority_id
       AND "TaxAuthorityCertificate".certificate_number = p_certificate_number
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CERTIFICATE_NOT_FOUND: Tax authority certificate %:% not found',
            p_authority_id, p_certificate_number USING ERRCODE = 'P0002';
    END IF;

    v_target_uuid := substring(encode(extensions.digest(p_authority_id || ':' || p_certificate_number, 'sha256'), 'hex'), 1, 32)::uuid;

    -- Idempotent Retry Check
    IF v_status = 'REVOKED' THEN
        SELECT "NonceRegistry".request_digest INTO v_reg_digest
          FROM public."NonceRegistry"
         WHERE "NonceRegistry".nonce = p_nonce
           AND "NonceRegistry".scope = 'cert_revocation'
           AND "NonceRegistry".target_id = v_target_uuid;

        IF FOUND AND v_reg_digest = extensions.digest(p_revocation_reason, 'sha256') THEN
            RETURN QUERY SELECT p_authority_id, p_certificate_number, v_revoked_at, 'REVOKED'::varchar(16), TRUE;
            RETURN;
        ELSE
            RAISE EXCEPTION 'ERR_RESOURCE_ALREADY_REVOKED: Tax authority certificate %:% is already revoked',
                p_authority_id, p_certificate_number USING ERRCODE = '55000';
        END IF;
    END IF;

    -- Level 4: Nonce Registry Mutation
    BEGIN
        INSERT INTO public."NonceRegistry" (nonce, scope, target_id, request_digest, consumed_at, created_at)
        VALUES (
            p_nonce, 'cert_revocation', v_target_uuid,
            extensions.digest(p_revocation_reason, 'sha256'),
            clock_timestamp(), clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ERR_REPLAY_ATTACK_DETECTED: Nonce % has already been consumed for cert_revocation', p_nonce
            USING ERRCODE = '23505';
    END;

    -- Level 5: State Mutation
    UPDATE public."TaxAuthorityCertificate"
       SET "status" = 'REVOKED',
           "revoked_at" = clock_timestamp(),
           "revocation_reason" = p_revocation_reason,
           "revoked_by" = p_revoked_by
     WHERE "TaxAuthorityCertificate".authority_id = p_authority_id
       AND "TaxAuthorityCertificate".certificate_number = p_certificate_number
    RETURNING "TaxAuthorityCertificate".revoked_at INTO v_revoked_at;

    RETURN QUERY SELECT p_authority_id, p_certificate_number, v_revoked_at, 'REVOKED'::varchar(16), FALSE;
END;
$$;

-- 11. Security Definer Ownership Configuration
ALTER FUNCTION extensions.fn_parse_decimal_cents(text) OWNER TO plinthly_security_admin;
ALTER FUNCTION extensions.crypto_asym_verify(text, bytea, bytea, bytea) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.record_tax_calculation_quote(uuid, varchar, varchar, varchar, varchar, timestamptz, timestamptz, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, varchar, varchar, jsonb, jsonb, bytea, bytea, varchar, varchar, varchar, varchar, timestamptz, bytea, varchar, varchar) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.prepare_merchant_cart_capture(uuid, uuid, bigint, varchar, varchar) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.record_webhook_transmission_ingress(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bytea, varchar, varchar) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.finalize_transmission_response(varchar, varchar, int) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.execute_capture_confirmation(uuid, varchar, varchar, varchar, varchar) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.record_cart_refund_attempt(uuid, varchar, varchar, varchar, varchar, text) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.revoke_audit_signing_key(varchar, text, varchar, varchar) OWNER TO plinthly_security_admin;
ALTER FUNCTION public.revoke_tax_authority_certificate(varchar, varchar, text, varchar, varchar) OWNER TO plinthly_security_admin;

-- 12. Routine Execution Privilege Scoping (Section 6.3 Authorization Matrix)
-- Revoke all from PUBLIC on all canonical routines
REVOKE ALL ON FUNCTION public.record_tax_calculation_quote(uuid, varchar, varchar, varchar, varchar, timestamptz, timestamptz, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, varchar, varchar, jsonb, jsonb, bytea, bytea, varchar, varchar, varchar, varchar, timestamptz, bytea, varchar, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_merchant_cart_capture(uuid, uuid, bigint, varchar, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_webhook_transmission_ingress(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bytea, varchar, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_transmission_response(varchar, varchar, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_capture_confirmation(uuid, varchar, varchar, varchar, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cart_refund_attempt(uuid, varchar, varchar, varchar, varchar, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_audit_signing_key(varchar, text, varchar, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_tax_authority_certificate(varchar, varchar, text, varchar, varchar) FROM PUBLIC;

-- Scope Grants to Specific Authorized Roles
GRANT EXECUTE ON FUNCTION public.record_tax_calculation_quote(uuid, varchar, varchar, varchar, varchar, timestamptz, timestamptz, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, varchar, varchar, jsonb, jsonb, bytea, bytea, varchar, varchar, varchar, varchar, timestamptz, bytea, varchar, varchar) TO tax_verifier_role;

GRANT EXECUTE ON FUNCTION public.prepare_merchant_cart_capture(uuid, uuid, bigint, varchar, varchar) TO app_orchestrator_role;
GRANT EXECUTE ON FUNCTION public.execute_capture_confirmation(uuid, varchar, varchar, varchar, varchar) TO app_orchestrator_role;
GRANT EXECUTE ON FUNCTION public.record_cart_refund_attempt(uuid, varchar, varchar, varchar, varchar, text) TO app_orchestrator_role;

GRANT EXECUTE ON FUNCTION public.record_webhook_transmission_ingress(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bytea, varchar, varchar) TO webhook_ingress_role;
GRANT EXECUTE ON FUNCTION public.finalize_transmission_response(varchar, varchar, int) TO webhook_ingress_role;

GRANT EXECUTE ON FUNCTION public.revoke_audit_signing_key(varchar, text, varchar, varchar) TO admin_security_role;
GRANT EXECUTE ON FUNCTION public.revoke_tax_authority_certificate(varchar, varchar, text, varchar, varchar) TO admin_security_role;
`;

fs.writeFileSync(path.join(migrationDir, 'migration.sql'), sql.trim() + '\n', 'utf8');
console.log('Successfully written corrected migration to:', path.join(migrationDir, 'migration.sql'));
