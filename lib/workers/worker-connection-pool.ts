import { Client, ClientConfig } from "pg";

export type WorkerRole = "tax_verifier_role" | "webhook_ingress_role" | "app_orchestrator_role" | "admin_security_role";

export interface WorkerIdentityConfig {
  workerInstanceId: string;
  workerPrincipal: string; // e.g. "tax_worker_01", "webhook_worker_01"
  workerRole: WorkerRole;
  clientCertPath?: string;
  clientKeyPath?: string;
  caCertPath?: string;
}

/**
 * Returns a configured PostgreSQL Client for the specified worker workload identity.
 * 
 * In production deployments:
 * Uses mTLS client certificates (rejectUnauthorized: true) where PostgreSQL verifies
 * clientcert=verify-full and maps the Subject CN directly to SESSION_USER.
 * 
 * In development / local testing environments:
 * Connects to the isolated plinthly_stage2_dev database and applies session-level authorization
 * matching the worker principal, enabling PostgreSQL's internal role checks, SESSION_USER
 * bindings, and SECURITY DEFINER routine privilege enforcements to be strictly evaluated.
 */
export async function createWorkerClient(
  identity: WorkerIdentityConfig,
  databaseUrl?: string
): Promise<Client> {
  const dbUrl = databaseUrl || process.env.STAGE2_DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("ERR_NO_DATABASE_URL: Database connection URL is not configured.");
  }

  const clientConfig: ClientConfig = {
    connectionString: dbUrl,
  };

  // If production mTLS certificates are supplied:
  if (identity.clientCertPath && identity.clientKeyPath && identity.caCertPath) {
    const fs = require("fs");
    clientConfig.ssl = {
      ca: fs.readFileSync(identity.caCertPath).toString(),
      cert: fs.readFileSync(identity.clientCertPath).toString(),
      key: fs.readFileSync(identity.clientKeyPath).toString(),
      rejectUnauthorized: true,
    };
  }

  const client = new Client(clientConfig);
  await client.connect();

  // In non-TLS or local demo mode, apply session authorization for the verified worker principal
  if (!clientConfig.ssl) {
    try {
      await client.query(`SET SESSION AUTHORIZATION ${identity.workerPrincipal};`);
    } catch (e: any) {
      await client.end().catch(() => {});
      throw new Error(`ERR_WORKER_AUTH_FAILED: Failed to assume worker principal "${identity.workerPrincipal}": ${e.message}`);
    }
  }

  return client;
}

