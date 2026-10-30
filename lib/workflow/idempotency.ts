import { createHash } from "node:crypto";
import { IdempotencyConflictError } from "./errors";
import { IdempotencyRecord } from "./types";
import { PurchaseRepository } from "./repository";

export { IdempotencyConflictError };

/**
 * Computes a canonical deterministic SHA-256 hash of any JSON-serializable request payload.
 */
export function computePayloadHash(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return createHash("sha256").update("null", "utf8").digest("hex");
  }

  function canonicalize(val: unknown): unknown {
    if (val === null || typeof val !== "object") {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(canonicalize);
    }
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      result[k] = canonicalize((val as Record<string, unknown>)[k]);
    }
    return result;
  }

  const json = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Validates idempotency key format: non-empty string, max 128 characters.
 */
export function validateIdempotencyKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return trimmed;
}

export interface IdempotencyExecutionResult<T> {
  readonly cached: boolean;
  readonly status: number;
  readonly body: T;
}

export interface ExecuteWithIdempotencyOptions<T> {
  readonly actorId: string;
  readonly operation: string;
  readonly idempotencyKey?: string | null;
  readonly payload: unknown;
  readonly now?: Date;
  readonly ttlMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly execute: (idempotencyDraft?: IdempotencyRecord) => Promise<{
    status: number;
    body: T;
    persistedAtomically?: boolean;
  }>;
}

/**
 * Detects whether an error represents a database unique-constraint collision.
 * Handles Prisma P2002, PostgreSQL 23505, and repository error conventions.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  if (err.code === "P2002" || err.code === "23505") {
    return true;
  }
  if (typeof err.message === "string") {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("unique constraint") ||
      msg.includes("already exists") ||
      msg.includes("p2002")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Executes an operation with durable database-backed idempotency protection.
 */
export async function executeWithIdempotency<T>(
  repo: PurchaseRepository,
  options: ExecuteWithIdempotencyOptions<T>
): Promise<IdempotencyExecutionResult<T>> {
  const {
    actorId,
    operation,
    idempotencyKey,
    payload,
    now = new Date(),
    ttlMs = 24 * 60 * 60 * 1000,
    maxRetries = 12,
    retryDelayMs = 20,
    execute,
  } = options;

  if (!idempotencyKey) {
    const executed = await execute();
    return {
      cached: false,
      status: executed.status,
      body: executed.body,
    };
  }

  const requestHash = computePayloadHash(payload);

  // 1. Initial lookup: Replay committed result if already recorded
  const existing = await repo.getIdempotencyRecord(actorId, operation, idempotencyKey);
  if (existing) {
    if (existing.expiresAt && now.getTime() >= existing.expiresAt.getTime()) {
      throw new IdempotencyConflictError(
        `Idempotency key "${idempotencyKey}" has expired and cannot be reused.`
      );
    }

    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency key "${idempotencyKey}" was previously used for operation "${operation}" with different request parameters.`
      );
    }

    return {
      cached: true,
      status: existing.responseStatus,
      body: existing.responseBody as T,
    };
  }

  // 2. Draft candidate idempotency record (24-hour retention window)
  const idempotencyDraft: IdempotencyRecord = {
    id: `idem_${now.getTime()}_${Math.random().toString(36).substring(2, 9)}`,
    key: idempotencyKey,
    actorId,
    operation,
    requestHash,
    responseStatus: 0,
    responseBody: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };

  try {
    const executed = await execute(idempotencyDraft);

    // If execute() did not persist the idempotency record atomically within its own transaction,
    // persist it now (used for generic or unit test executions).
    if (!executed.persistedAtomically) {
      const record: IdempotencyRecord = {
        ...idempotencyDraft,
        responseStatus: executed.status,
        responseBody: executed.body,
      };
      await repo.saveIdempotencyRecord(record);
    }

    return {
      cached: false,
      status: executed.status,
      body: executed.body,
    };
  } catch (error) {
    // 3. Handle concurrent collisions on the unique key constraint
    if (isUniqueConstraintViolation(error)) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const delay = retryDelayMs * Math.min(attempt + 1, 5);
        await new Promise((resolve) => setTimeout(resolve, delay));

        const committed = await repo.getIdempotencyRecord(actorId, operation, idempotencyKey);
        if (committed) {
          if (committed.expiresAt && now.getTime() >= committed.expiresAt.getTime()) {
            throw new IdempotencyConflictError(
              `Idempotency key "${idempotencyKey}" has expired and cannot be reused.`
            );
          }

          if (committed.requestHash !== requestHash) {
            throw new IdempotencyConflictError(
              `Idempotency key "${idempotencyKey}" was previously used for operation "${operation}" with different request parameters.`
            );
          }

          return {
            cached: true,
            status: committed.responseStatus,
            body: committed.responseBody as T,
          };
        }
      }

      throw new IdempotencyConflictError(
        `A concurrent request for idempotency key "${idempotencyKey}" is in progress or unresolved. Please retry.`
      );
    }

    // 4. Catch race conflicts outside the failed transaction:
    // If a concurrent transaction completed and committed the idempotency record while this request
    // was in flight (causing an unexpected status or state transition error), reload the record:
    try {
      const committed = await repo.getIdempotencyRecord(actorId, operation, idempotencyKey);
      if (committed) {
        if (committed.expiresAt && now.getTime() >= committed.expiresAt.getTime()) {
          throw new IdempotencyConflictError(
            `Idempotency key "${idempotencyKey}" has expired and cannot be reused.`
          );
        }

        if (committed.requestHash !== requestHash) {
          throw new IdempotencyConflictError(
            `Idempotency key "${idempotencyKey}" was previously used for operation "${operation}" with different request parameters.`
          );
        }

        return {
          cached: true,
          status: committed.responseStatus,
          body: committed.responseBody as T,
        };
      }
    } catch (checkErr) {
      if (checkErr instanceof IdempotencyConflictError) {
        throw checkErr;
      }
    }

    // Pass through any other errors (validation, illegal transitions, etc.)
    throw error;
  }
}
