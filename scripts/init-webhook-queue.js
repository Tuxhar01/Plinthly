const { Client } = require("pg");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

async function main() {
  const envConfig = dotenv.parse(fs.readFileSync(path.resolve(".env.stage2")));
  const client = new Client({ connectionString: envConfig.DATABASE_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS public."WebhookEventQueue" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transmission_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      order_id VARCHAR(64),
      capture_id VARCHAR(64),
      refund_id VARCHAR(64),
      amount_cents BIGINT NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'USD',
      payee_email VARCHAR(255),
      raw_payload_json JSONB NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 5,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      locked_until TIMESTAMPTZ,
      locked_by VARCHAR(64),
      claim_token UUID DEFAULT gen_random_uuid(),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE public."WebhookEventQueue"
      ADD COLUMN IF NOT EXISTS claim_token UUID DEFAULT gen_random_uuid();

    DROP INDEX IF EXISTS public.idx_webhook_queue_claim;

    CREATE INDEX IF NOT EXISTS "idx_webhook_queue_claim"
      ON public."WebhookEventQueue" (status, next_attempt_at, locked_until, created_at)
      WHERE status IN ('QUEUED', 'FAILED_RETRYABLE', 'PROCESSING');

    CREATE INDEX IF NOT EXISTS "idx_webhook_queue_tx"
      ON public."WebhookEventQueue" (transmission_id);

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
  `);

  console.log("WebhookEventQueue created and granted successfully.");
  await client.end();
}

main().catch((err) => {
  console.error("Init error:", err);
  process.exit(1);
});
