import { createHash } from "node:crypto";
import { EvidenceStatus } from "./types";

const SNAPSHOT_KEYS = [
  "availability",
  "currency",
  "externalId",
  "merchantName",
  "merchantUrl",
  "quantity",
  "shippingCents",
  "source",
  "totalCents",
  "unitPriceCents",
] as const;

export interface SnapshotCandidateInput {
  availability: string;
  currency: string;
  externalId: string;
  merchantName: string;
  merchantUrl: string;
  quantity: number;
  shippingCents: number;
  source: string;
  totalCents: number;
  unitPriceCents: number;
  [key: string]: unknown;
}

export function computeSnapshotHash(candidate: SnapshotCandidateInput): string {
  const canonicalObj: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) {
    if (candidate[key] === undefined) {
      throw new Error(`Candidate missing required snapshot field: ${key}`);
    }
    canonicalObj[key] = candidate[key];
  }

  const json = JSON.stringify(canonicalObj);
  return createHash("sha256").update(json, "utf8").digest("hex").toLowerCase();
}

export interface EvidenceFingerprintItem {
  requirementKey: string;
  value: string;
  sourceUrl: string;
  sourceType: string;
  capturedAt: string;
  status: EvidenceStatus;
}

const ISO_8601_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function computeEvidenceFingerprint(items: readonly EvidenceFingerprintItem[]): string {
  if (!items || items.length === 0) {
    return createHash("sha256").update("[]", "utf8").digest("hex").toLowerCase();
  }

  const serialisedItems: string[] = [];

  for (const item of items) {
    if (typeof item.capturedAt !== "string" || !ISO_8601_UTC_REGEX.test(item.capturedAt)) {
      throw new Error(`Invalid capturedAt: must match ISO 8601 UTC pattern (YYYY-MM-DDTHH:MM:SSZ), got "${item.capturedAt}"`);
    }

    const timestamp = Date.parse(item.capturedAt);
    if (Number.isNaN(timestamp)) {
      throw new Error(`Invalid capturedAt: unparseable date timestamp "${item.capturedAt}"`);
    }

    // Canonicalise with sorted keys: capturedAt, requirementKey, sourceType, sourceUrl, status, value
    const canonicalItem = {
      capturedAt: item.capturedAt,
      requirementKey: item.requirementKey,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      status: item.status,
      value: item.value,
    };

    serialisedItems.push(JSON.stringify(canonicalItem));
  }

  // Sort by plain code-unit comparison (no localeCompare)
  serialisedItems.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const finalJson = JSON.stringify(serialisedItems);
  return createHash("sha256").update(finalJson, "utf8").digest("hex").toLowerCase();
}

/**
 * Standard 64-character lowercase hexadecimal SHA-256 pattern.
 */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Validates whether a value is an actual 64-character lowercase hexadecimal SHA-256 fingerprint.
 * Rejects empty, whitespace-only, malformed, non-hex, or padded values.
 */
export function isValidEvidenceFingerprint(fp: unknown): fp is string {
  return typeof fp === "string" && SHA256_HEX_REGEX.test(fp);
}

/**
 * Normalizes a policy evidence fingerprint read from persistent storage.
 * Handles fixed-width padding (such as PostgreSQL CHAR(64)) defensively:
 * - null, undefined, or empty/whitespace-only values return null (indicating absence of a valid fingerprint).
 * - Non-empty strings are trimmed of fixed-width padding.
 * Note: Callers must validate the returned value via isValidEvidenceFingerprint rather than
 * blindly trusting trimmed input.
 */
export function normalizePolicyEvidenceFingerprint(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

