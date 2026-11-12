-- Migration: 20261107040000_stage2_cart_failure_routine
-- Plinthly Stage 2 Phase 4: Atomic Cart Capture Failure Routine
-- Mediates FAILED state transition for app_orchestrator_role under Level 0 advisory mutex

CREATE OR REPLACE FUNCTION public.record_cart_capture_failure(
    p_cart_id uuid,
    p_error_code varchar(64),
    p_error_message text
)
RETURNS TABLE (
    cart_id uuid,
    status varchar(32),
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_checkout_status varchar(32);
    v_updated_at timestamptz;
BEGIN
    -- Level 0 Advisory Mutex (cart_checkout)
    PERFORM pg_advisory_xact_lock(hashtext('cart_checkout:' || p_cart_id::text));

    -- Level 1: Domain Row Lock
    SELECT "ApprovedMerchantCart"."checkoutStatus" INTO v_checkout_status
    FROM public."ApprovedMerchantCart"
    WHERE "ApprovedMerchantCart".id = p_cart_id
    FOR UPDATE OF "ApprovedMerchantCart";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ERR_CART_NOT_FOUND: Cart % not found', p_cart_id USING ERRCODE = 'P0002';
    END IF;

    -- Validate transition: only BUYER_APPROVED or CAPTURING can transition to FAILED
    IF v_checkout_status NOT IN ('BUYER_APPROVED', 'CAPTURING') THEN
        RAISE EXCEPTION 'ERR_INVALID_TRANSITION: Cart checkout status % cannot transition to FAILED', v_checkout_status USING ERRCODE = '55000';
    END IF;

    -- Level 5: State Mutation
    UPDATE public."ApprovedMerchantCart"
    SET "checkoutStatus" = 'FAILED', "updatedAt" = clock_timestamp()
    WHERE "ApprovedMerchantCart".id = p_cart_id
    RETURNING "ApprovedMerchantCart"."updatedAt" INTO v_updated_at;

    RETURN QUERY SELECT p_cart_id, 'FAILED'::varchar(32), v_updated_at;
END;
$$;

-- Security Definer Ownership & Privilege Configuration
ALTER FUNCTION public.record_cart_capture_failure(uuid, varchar, text) OWNER TO plinthly_security_admin;
REVOKE ALL ON FUNCTION public.record_cart_capture_failure(uuid, varchar, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_cart_capture_failure(uuid, varchar, text) TO app_orchestrator_role;

