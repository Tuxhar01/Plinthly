-- Plinthly Stage 2 Phase 1 Acceptance Correction CORR-02: Trigger Function Hardening
-- Hardens fn_webhook_transmission_immutability by fixing search_path to pg_catalog

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
$$ LANGUAGE plpgsql
SET search_path = pg_catalog;

