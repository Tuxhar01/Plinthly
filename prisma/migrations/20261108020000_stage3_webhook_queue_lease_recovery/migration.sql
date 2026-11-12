-- Migration: 20261108020000_stage3_webhook_queue_lease_recovery
-- Scope: Stage 3 Phase 3 DEF-WHK-01 Remediation on public."WebhookEventQueue"
-- Target Database: plinthly_stage2_dev
-- Description:
-- 1. Adds claim_token column to provide fencing tokens / claim identities
--    preventing stale-worker race conditions on completion, retry, and DLQ updates.
-- 2. Updates partial claim index idx_webhook_queue_claim to index status, next_attempt_at,
--    locked_until, created_at covering QUEUED, FAILED_RETRYABLE, and PROCESSING states.
-- 3. Grants necessary permissions to webhook_ingress_role and app_orchestrator_role.

-- Step 1: Add claim_token column if not exists
ALTER TABLE public."WebhookEventQueue"
  ADD COLUMN IF NOT EXISTS claim_token UUID DEFAULT gen_random_uuid();

-- Step 2: Drop obsolete partial index
DROP INDEX IF EXISTS public.idx_webhook_queue_claim;

-- Step 3: Create updated partial claim index matching claim query predicate
CREATE INDEX IF NOT EXISTS idx_webhook_queue_claim
  ON public."WebhookEventQueue" (status, next_attempt_at, locked_until, created_at)
  WHERE status IN ('QUEUED', 'FAILED_RETRYABLE', 'PROCESSING');

-- Step 4: Ensure permissions for queue roles
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webhook_ingress_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public."WebhookEventQueue" TO webhook_ingress_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_orchestrator_role') THEN
    GRANT ALL ON public."WebhookEventQueue" TO app_orchestrator_role;
  END IF;
END
$$;

