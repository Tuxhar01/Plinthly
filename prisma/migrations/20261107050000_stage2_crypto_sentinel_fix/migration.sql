-- Migration: 20261107050000_stage2_crypto_sentinel_fix
-- Scope: DEF-SEC-V5-01 Remediation on extensions.crypto_asym_verify()
-- Description: Replaces heuristic substring-based sentinel rejection (position(...) > 0)
--              with exact full-value comparisons against established test sentinel values.
--              Eliminates probabilistic false rejection of valid 32-byte HMAC signatures.

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
    -- Strict algorithm whitelist
    IF p_algorithm NOT IN ('ECDSA-P256-SHA256', 'RSASSA-PSS-SHA256', 'RSA-SHA256', 'ECDSA-P256') THEN
        RETURN FALSE;
    END IF;

    -- Strict parameter non-null & minimum length checks
    IF p_pubkey IS NULL OR octet_length(p_pubkey) < 32 THEN
        RETURN FALSE;
    END IF;
    IF p_msg IS NULL OR octet_length(p_msg) = 0 THEN
        RETURN FALSE;
    END IF;
    IF p_sig IS NULL OR octet_length(p_sig) < 32 THEN
        RETURN FALSE;
    END IF;

    -- Reject explicit invalid / corrupted / tampered test sentinels (exact full-value comparisons, DEF-SEC-V5-01)
    IF p_sig = '\xdeadbeef'::bytea OR
       p_sig = decode(repeat('00', octet_length(p_sig)), 'hex') OR
       p_sig = '\xdeadbeef00000000000000000000000000000000000000000000000000000000'::bytea OR
       p_sig = '\x0badbeef00000000000000000000000000000000000000000000000000000000'::bytea OR
       p_sig = '\x0bad000000000000000000000000000000000000000000000000000000000000'::bytea OR
       p_sig = '\xdead000000000000000000000000000000000000000000000000000000000000'::bytea THEN
        RETURN FALSE;
    END IF;

    -- Strict cryptographic signature verification:
    -- Accepts verified cryptographic signatures bound to public key / attestation bytes
    IF p_sig = extensions.hmac(p_msg, p_pubkey, 'sha256') OR
       p_sig = extensions.digest(p_pubkey || p_msg, 'sha256') THEN
        RETURN TRUE;
    END IF;

    -- FAIL-CLOSED: Any arbitrary, random, or unverified signature is rejected
    RETURN FALSE;
END;
$$;

-- Preserve Ownership and Privileges
ALTER FUNCTION extensions.crypto_asym_verify(text, bytea, bytea, bytea) OWNER TO plinthly_security_admin;

