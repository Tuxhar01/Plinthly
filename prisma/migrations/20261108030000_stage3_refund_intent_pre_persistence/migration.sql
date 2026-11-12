-- Migration: 20261108030000_stage3_refund_intent_pre_persistence
-- Author: Plinthly Security & Domain Architecture
-- Purpose: Remediation of DEF-P4-01: Durably pre-persist refund intents before gateway dispatch.
-- Guarantees:
-- 1. Stable UUIDv4 identity persisted in CartRefundRecord prior to external HTTP dispatch.
-- 2. PayPal-Request-Id derived strictly from persisted CartRefundRecord.id.
-- 3. In-flight reservation against refundable balance prevents concurrent over-refunds.
-- 4. Idempotency uniqueness uq_cart_refund_idempotency(cart_id, idempotency_key).
-- 5. Safe recovery across timeouts, retries, and process restarts.

CREATE TABLE IF NOT EXISTS public."CartRefundRecord" (
    id uuid NOT NULL DEFAULT extensions.gen_random_uuid(),
    cart_id uuid NOT NULL,
    capture_id varchar(64) NOT NULL,
    idempotency_key varchar(128) NOT NULL,
    amount_cents bigint NOT NULL,
    currency varchar(3) NOT NULL DEFAULT 'USD',
    reason text,
    status varchar(32) NOT NULL DEFAULT 'PENDING',
    gateway_refund_id varchar(64),
    error_code varchar(64),
    error_message text,
    refund_evidence_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "CartRefundRecord_pkey" PRIMARY KEY (id),
    CONSTRAINT "fk_cart_refund_cart" FOREIGN KEY (cart_id) REFERENCES public."ApprovedMerchantCart"(id) ON DELETE RESTRICT,
    CONSTRAINT "fk_cart_refund_evidence" FOREIGN KEY (refund_evidence_id) REFERENCES public."RefundEvidenceRecord"(id) ON DELETE SET NULL,
    CONSTRAINT "uq_cart_refund_idempotency" UNIQUE (cart_id, idempotency_key),
    CONSTRAINT "chk_cart_refund_amount_positive" CHECK (amount_cents > 0),
    CONSTRAINT "chk_cart_refund_currency_usd" CHECK (currency = 'USD'),
    CONSTRAINT "chk_cart_refund_status" CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'AMBIGUOUS_TIMEOUT'))
);

CREATE INDEX IF NOT EXISTS idx_cart_refund_cart ON public."CartRefundRecord"(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_refund_capture ON public."CartRefundRecord"(capture_id);
CREATE INDEX IF NOT EXISTS idx_cart_refund_status ON public."CartRefundRecord"(status);

ALTER TABLE public."CartRefundRecord" OWNER TO plinthly_security_admin;
REVOKE ALL ON TABLE public."CartRefundRecord" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public."CartRefundRecord" TO app_orchestrator_role;

-- Routine 1: prepare_cart_refund
CREATE OR REPLACE FUNCTION public.prepare_cart_refund(
    p_cart_id uuid,
    p_amount_cents bigint,
    p_idempotency_key varchar(128),
    p_reason text,
    p_currency varchar(3) DEFAULT 'USD'
)
RETURNS TABLE (
    refund_record_id uuid,
    cart_id uuid,
    capture_id varchar(64),
    idempotency_key varchar(128),
    amount_cents bigint,
    currency varchar(3),
    status varchar(32),
    is_existing boolean,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_checkout_status varchar(32);
    v_total_cents bigint;
    v_cum_refunded bigint;
    v_capture_id varchar(64);
    v_pe_curr varchar(3);
    v_in_flight bigint;
    v_avail_balance bigint;
    v_rec_id uuid;
    v_rec_status varchar(32);
    v_rec_created_at timestamptz;
    v_existing_amount bigint;
    v_existing_curr varchar(3);
BEGIN
    -- Input validations
    IF p_cart_id IS NULL OR p_amount_cents IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    IF p_amount_cents <= 0 THEN
        RAISE EXCEPTION 'ERR_INVALID_REFUND_AMOUNT: Refund amount must be greater than zero' USING ERRCODE = '22023';
    END IF;

    IF trim(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'ERR_INVALID_PARAMETER_VALUE: Idempotency key cannot be empty' USING ERRCODE = '22023';
    END IF;

    -- Level 0: Advisory Mutex (Same hash as R2-06 to ensure strict mutual exclusion)
    PERFORM pg_advisory_xact_lock(hashtext('cart_refund:' || p_cart_id::text));

    -- Level 1: Domain Row Lock on Cart
    SELECT "ApprovedMerchantCart"."checkoutStatus",
           "ApprovedMerchantCart"."totalCartCents",
           "ApprovedMerchantCart"."cumulativeRefundedCents"
      INTO v_checkout_status, v_total_cents, v_cum_refunded
      FROM public."ApprovedMerchantCart"
     WHERE "ApprovedMerchantCart".id = p_cart_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CART_NOT_FOUND: Cart % does not exist', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    IF v_checkout_status NOT IN ('CAPTURED', 'PARTIALLY_REFUNDED') THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Cannot refund cart in status %. Must be CAPTURED or PARTIALLY_REFUNDED',
            v_checkout_status USING ERRCODE = '55000';
    END IF;

    -- Level 1: Payment Evidence Lock
    SELECT "PaymentEvidenceRecord".capture_id, "PaymentEvidenceRecord".currency
      INTO v_capture_id, v_pe_curr
      FROM public."PaymentEvidenceRecord"
     WHERE "PaymentEvidenceRecord".cart_id = p_cart_id
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_NO_PAYMENT_EVIDENCE: Cart % has no payment evidence record', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    IF v_pe_curr IS DISTINCT FROM p_currency THEN
        RAISE EXCEPTION 'ERR_CURRENCY_MISMATCH: Refund currency % does not match captured currency %',
            p_currency, v_pe_curr USING ERRCODE = '22023';
    END IF;

    -- Check for existing intent for this (cart_id, idempotency_key)
    SELECT "CartRefundRecord".id,
           "CartRefundRecord".amount_cents,
           "CartRefundRecord".currency,
           "CartRefundRecord".status,
           "CartRefundRecord".created_at
      INTO v_rec_id, v_existing_amount, v_existing_curr, v_rec_status, v_rec_created_at
      FROM public."CartRefundRecord"
     WHERE "CartRefundRecord".cart_id = p_cart_id
       AND "CartRefundRecord".idempotency_key = p_idempotency_key
       FOR UPDATE;

    IF FOUND THEN
        -- Verify parameters match original request
        IF v_existing_amount != p_amount_cents OR v_existing_curr != p_currency THEN
            RAISE EXCEPTION 'ERR_IDEMPOTENCY_MISMATCH: Idempotency key % already used with different parameters (amount: %, curr: %)',
                p_idempotency_key, v_existing_amount, v_existing_curr USING ERRCODE = '22023';
        END IF;

        -- Return existing intent identity
        RETURN QUERY SELECT v_rec_id, p_cart_id, v_capture_id, p_idempotency_key,
                            v_existing_amount, v_existing_curr, v_rec_status, TRUE, v_rec_created_at;
        RETURN;
    END IF;

    -- Calculate in-flight refunds and completed gateway refunds not yet incorporated in cumulativeRefundedCents
    SELECT COALESCE(SUM("CartRefundRecord".amount_cents), 0)
      INTO v_in_flight
      FROM public."CartRefundRecord"
     WHERE "CartRefundRecord".cart_id = p_cart_id
       AND (
           "CartRefundRecord".status IN ('PENDING', 'AMBIGUOUS_TIMEOUT')
           OR ("CartRefundRecord".status = 'COMPLETED' AND "CartRefundRecord".refund_evidence_id IS NULL)
       );

    v_avail_balance := v_total_cents - v_cum_refunded - v_in_flight;

    IF p_amount_cents > v_avail_balance THEN
        RAISE EXCEPTION 'ERR_REFUND_EXCEEDS_BALANCE: Requested refund amount (% cents) exceeds remaining refundable balance (% cents, in-flight: % cents)',
            p_amount_cents, v_avail_balance, v_in_flight USING ERRCODE = '22023';
    END IF;

    -- Durably persist the new refund intent BEFORE gateway dispatch
    INSERT INTO public."CartRefundRecord" (
        id, cart_id, capture_id, idempotency_key, amount_cents, currency, reason, status, created_at, updated_at
    ) VALUES (
        extensions.gen_random_uuid(), p_cart_id, v_capture_id, p_idempotency_key, p_amount_cents, p_currency, p_reason, 'PENDING', clock_timestamp(), clock_timestamp()
    ) RETURNING "CartRefundRecord".id, "CartRefundRecord".created_at
         INTO v_rec_id, v_rec_created_at;

    RETURN QUERY SELECT v_rec_id, p_cart_id, v_capture_id, p_idempotency_key,
                        p_amount_cents, p_currency, 'PENDING'::varchar(32), FALSE, v_rec_created_at;
END;
$$;

-- Routine 2: update_cart_refund_status
CREATE OR REPLACE FUNCTION public.update_cart_refund_status(
    p_refund_record_id uuid,
    p_status varchar(32),
    p_gateway_refund_id varchar(64) DEFAULT NULL,
    p_error_code varchar(64) DEFAULT NULL,
    p_error_message text DEFAULT NULL
)
RETURNS TABLE (
    refund_record_id uuid,
    status varchar(32),
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_updated_at timestamptz;
BEGIN
    IF p_refund_record_id IS NULL OR p_status IS NULL THEN
        RAISE EXCEPTION 'ERR_NULL_PARAMETER: Mandatory parameter is NULL' USING ERRCODE = '22004';
    END IF;

    IF p_status NOT IN ('PENDING', 'COMPLETED', 'FAILED', 'AMBIGUOUS_TIMEOUT') THEN
        RAISE EXCEPTION 'ERR_INVALID_STATUS: Invalid refund status %', p_status USING ERRCODE = '22023';
    END IF;

    UPDATE public."CartRefundRecord"
       SET status = p_status,
           gateway_refund_id = COALESCE(p_gateway_refund_id, "CartRefundRecord".gateway_refund_id),
           error_code = COALESCE(p_error_code, "CartRefundRecord".error_code),
           error_message = COALESCE(p_error_message, "CartRefundRecord".error_message),
           updated_at = clock_timestamp()
     WHERE "CartRefundRecord".id = p_refund_record_id
    RETURNING "CartRefundRecord".updated_at INTO v_updated_at;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_REFUND_NOT_FOUND: CartRefundRecord % not found', p_refund_record_id USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY SELECT p_refund_record_id, p_status, v_updated_at;
END;
$$;

ALTER FUNCTION public.prepare_cart_refund(uuid, bigint, varchar, text, varchar) OWNER TO plinthly_security_admin;
REVOKE ALL ON FUNCTION public.prepare_cart_refund(uuid, bigint, varchar, text, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_cart_refund(uuid, bigint, varchar, text, varchar) TO app_orchestrator_role;

ALTER FUNCTION public.update_cart_refund_status(uuid, varchar, varchar, varchar, text) OWNER TO plinthly_security_admin;
REVOKE ALL ON FUNCTION public.update_cart_refund_status(uuid, varchar, varchar, varchar, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cart_refund_status(uuid, varchar, varchar, varchar, text) TO app_orchestrator_role;

