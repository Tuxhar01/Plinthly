/**
 * Plinthly Stage 2 & 3 Dedicated Database Client & Pool Connection Helper
 *
 * Guarantees:
 * 1. Strictly targets plinthly_stage2_dev only.
 * 2. Preflight verification: fails closed if current_database !== 'plinthly_stage2_dev'.
 * 3. Enforces zero accidental writes or reads to plinthly_dev.
 * 4. Production Security (Stage 3 Phase 1):
 *    - In production mode: SET SESSION AUTHORIZATION is strictly eliminated from all connection paths.
 *    - Delegates production connections to Stage3DatabasePoolManager with role-segregated mTLS pools.
 *    - In development/test mode: provides backward-compatible session authorization for isolated test execution.
 */

import { Client, Pool, PoolClient } from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { getAuthMode } from "../workflow/auth";
import {
  Stage3DatabasePoolManager,
  Stage3DatabaseRole,
  ProductionIdentityViolationError,
} from "./stage3-pool-manager";

let cachedStage2DbUrl: string | null = null;
const devPoolMap: Map<string, Pool> = new Map();

function getDevPool(principal: string = "default"): Pool {
  let pool = devPoolMap.get(principal);
  if (!pool) {
    pool = new Pool({
      connectionString: getStage2DatabaseUrl(),
      max: 50,
      idleTimeoutMillis: 30000,
    });
    devPoolMap.set(principal, pool);
  }
  return pool;
}

export function isProductionDatabaseMode(): boolean {
  return process.env.NODE_ENV === "production" || getAuthMode() === "production";
}

export function getStage2DatabaseUrl(): string {
  if (cachedStage2DbUrl) {
    return cachedStage2DbUrl;
  }

  // Check process.env first
  let dbUrl = process.env.STAGE2_DATABASE_URL;

  // If not set, parse .env.stage2 explicitly
  if (!dbUrl) {
    try {
      const stage2EnvPath = path.resolve(".env.stage2");
      if (fs.existsSync(stage2EnvPath)) {
        const parsed = dotenv.parse(fs.readFileSync(stage2EnvPath));
        dbUrl = parsed.STAGE2_DATABASE_URL || parsed.DATABASE_URL;
      }
    } catch {
      // ignore
    }
  }

  // Safety Assertion: Must target plinthly_stage2_dev
  if (!dbUrl || !dbUrl.includes("plinthly_stage2_dev")) {
    throw new Error(
      `FATAL_SAFETY_GUARD: Stage 2 database connection URL must explicitly target "plinthly_stage2_dev". Target was: "${dbUrl || "UNDEFINED"}"`
    );
  }

  cachedStage2DbUrl = dbUrl;
  return dbUrl;
}

export type Stage2WorkerPrincipal =
  | "tax_worker_01"
  | "ingress_worker_user"
  | "orchestrator_worker_user"
  | "security_admin_user";

export function mapPrincipalToRole(principal: Stage2WorkerPrincipal): Stage3DatabaseRole {
  switch (principal) {
    case "ingress_worker_user":
      return "webhook_ingress_role";
    case "tax_worker_01":
      return "tax_verifier_role";
    case "orchestrator_worker_user":
      return "app_orchestrator_role";
    case "security_admin_user":
      return "admin_security_role";
    default:
      throw new Error(`Unknown worker principal "${principal}".`);
  }
}

export async function createStage2ApiClient(
  principal?: Stage2WorkerPrincipal
): Promise<Client | PoolClient> {
  // Production Security Path (Stage 3 Phase 1)
  if (isProductionDatabaseMode()) {
    // In production, SET SESSION AUTHORIZATION is strictly forbidden
    if (process.env.SIMULATE_SESSION_AUTH === "true") {
      throw new ProductionIdentityViolationError(
        "SET SESSION AUTHORIZATION is strictly forbidden in production mode. " +
        "Workload identity must be established via PostgreSQL mTLS client certificates."
      );
    }

    const poolManager = Stage3DatabasePoolManager.getInstance({
      baseConnectionString: getStage2DatabaseUrl(),
      isProduction: true,
    });

    if (principal) {
      const role = mapPrincipalToRole(principal);
      return await poolManager.getVerifiedClient(role);
    }

    // Default to app_orchestrator_role pool if no principal is explicitly specified
    return await poolManager.getVerifiedClient("app_orchestrator_role");
  }

  // Development & Test Sandbox Path (Isolated for Unit/Integration Testing with connection pooling)
  const pool = getDevPool(principal || "default");
  const client = await pool.connect();

  // Safety Preflight Assertion
  const check = await client.query("SELECT current_database() as db, current_user as usr;");
  if (check.rows[0].db !== "plinthly_stage2_dev") {
    client.release();
    throw new Error(
      `FATAL_SAFETY_VIOLATION: Connected to "${check.rows[0].db}" instead of "plinthly_stage2_dev"! Aborting connection.`
    );
  }

  // Apply worker session authorization only in development/test environments
  if (principal) {
    try {
      await client.query(`SET SESSION AUTHORIZATION ${principal};`);
    } catch (err: any) {
      client.release();
      throw new Error(`ERR_WORKER_AUTH_FAILED: Failed to set session authorization to "${principal}": ${err.message}`);
    }
  }

  // Attach safe end() alias that resets authorization and returns to pool
  (client as any).end = async () => {
    try {
      await client.query("RESET SESSION AUTHORIZATION;");
    } catch {}
    client.release();
  };

  return client;
}
