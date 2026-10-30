import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface QuantityConfirmationClaims {
  readonly jti: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly draftHash: string;
  readonly lineItemId: string;
  readonly confirmedQuantity: number;
  readonly originalInferredQuantity?: number | null;
  readonly quantitySource: string;
  readonly actorId: string;
  readonly iat: number;
  readonly exp: number;
  readonly confirmedAt?: string;
}

// Backward-compatible interface for existing single-item callers
export interface QuantityConfirmationReceipt {
  readonly actorId: string;
  readonly lineItemId: string;
  readonly confirmedQuantity: number;
  readonly draftHash: string;
  readonly confirmedAt: string;
  readonly jti?: string;
  readonly draftId?: string;
  readonly draftVersion?: number;
}

export const confirmQuantitySchema = z
  .object({
    draftId: z.string().trim().min(1, "draftId cannot be empty").optional(),
    draftHash: z.string().trim().min(8, "draftHash must be at least 8 characters").optional(),
    draft: z
      .object({
        draftId: z.string().optional(),
        version: z.number().int().optional(),
        budgetCents: z.number().int().optional(),
        currency: z.string().optional(),
        destination: z.unknown().optional(),
        lineItems: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              quantity: z.number().int().optional(),
              budgetCents: z.number().int().nullable().optional(),
              requirements: z.unknown().optional(),
            })
          )
          .optional(),
        requirements: z.unknown().optional(),
      })
      .optional(),
    lineItemId: z.string().trim().min(1, "lineItemId cannot be empty"),
    confirmedQuantity: z.number().int().min(1, "confirmedQuantity must be at least 1"),
  })
  .refine((data) => Boolean(data.draftHash || data.draft || data.draftId), {
    message: "Either draftId, draftHash, or draft must be provided",
  });

export type ConfirmQuantityInput = z.infer<typeof confirmQuantitySchema>;

export const batchConfirmQuantitySchema = z.object({
  draftId: z.string().trim().min(1, "draftId cannot be empty"),
  confirmations: z
    .array(
      z.object({
        lineItemId: z.string().trim().min(1, "lineItemId cannot be empty"),
        confirmedQuantity: z.number().int().min(1, "confirmedQuantity must be at least 1"),
      })
    )
    .min(1, "At least one confirmation must be provided"),
});

export type BatchConfirmQuantityInput = z.infer<typeof batchConfirmQuantitySchema>;

const DEFAULT_ACTIVE_KID = "plinthly_sec_2026_v1";

export function getSigningSecret(kid?: string): string {
  // Support keyring rotation if configured
  if (process.env.CONFIRMATION_SIGNING_KEYRING) {
    try {
      const keyring = JSON.parse(process.env.CONFIRMATION_SIGNING_KEYRING);
      if (kid && keyring[kid] && typeof keyring[kid] === "string" && keyring[kid].length >= 32) {
        return keyring[kid];
      }
    } catch {
      // Fall through to primary secret
    }
  }

  const primary = process.env.CONFIRMATION_SIGNING_SECRET?.trim();
  if (primary && primary.length >= 32) {
    return primary;
  }

  throw new Error(
    "Security configuration error: CONFIRMATION_SIGNING_SECRET is missing or shorter than 32 characters. Fails closed."
  );
}

export function computeTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateTokenJti(): string {
  return `qtk_${Date.now()}_${randomBytes(8).toString("hex")}`;
}

/**
 * Computes a deterministic canonical SHA-256 content hash of the procurement draft.
 * Binds confirmation to all purchase-relevant fields: destination, budget, line items, and requirements.
 */
export function computeDraftHash(draft: {
  readonly draftId?: string;
  readonly version?: number;
  readonly budgetCents?: number | null;
  readonly currency?: string;
  readonly destination?: unknown;
  readonly lineItems?: readonly {
    readonly id: string;
    readonly title: string;
    readonly quantity?: number;
    readonly budgetCents?: number | null;
    readonly currency?: string;
    readonly verificationLevel?: string | null;
    readonly selectedCandidateId?: string | null;
    readonly requirements?: unknown;
  }[];
  readonly requirements?: unknown;
}): string {
  function sortKeys(val: unknown): unknown {
    if (val === null || typeof val !== "object") {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(sortKeys);
    }
    const record = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = sortKeys(record[key]);
      }
    }
    return sorted;
  }

  let canonicalDestination: unknown = null;
  if (draft.destination && typeof draft.destination === "object") {
    const dest = draft.destination as Record<string, unknown>;
    canonicalDestination = {
      country: typeof dest.country === "string" ? dest.country.trim().toUpperCase() : "US",
      postalCode: typeof dest.postalCode === "string" ? dest.postalCode.trim() : "",
      deliveryMethodPreference: dest.deliveryMethodPreference ?? null,
    };
  }

  let canonicalLineItems: unknown = null;
  if (draft.lineItems && Array.isArray(draft.lineItems)) {
    canonicalLineItems = draft.lineItems
      .map((li) => {
        let reqs: unknown = null;
        if (li.requirements && Array.isArray(li.requirements) && li.requirements.length > 0) {
          reqs = [...li.requirements]
            .map((r: Record<string, unknown>) => ({
              key: String(r.key || "").trim().toLowerCase(),
              expectedValue: String(r.expectedValue ?? "").trim(),
              description: r.description ? String(r.description).trim() : null,
            }))
            .sort((a, b) => a.key.localeCompare(b.key));
        } else if (li.requirements && !Array.isArray(li.requirements)) {
          reqs = sortKeys(li.requirements);
        }

        return {
          id: li.id,
          title: li.title.trim().toLowerCase(),
          quantity: typeof li.quantity === "number" ? li.quantity : 1,
          budgetCents: li.budgetCents ?? null,
          currency: (li.currency ?? draft.currency ?? "USD").toUpperCase(),
          verificationLevel: li.verificationLevel ?? null,
          selectedCandidateId: li.selectedCandidateId ?? null,
          requirements: reqs,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const canonical = {
    draftId: draft.draftId ?? null,
    version: draft.version ?? 1,
    budgetCents: draft.budgetCents ?? null,
    currency: (draft.currency ?? "USD").toUpperCase(),
    destination: canonicalDestination,
    lineItems: canonicalLineItems,
    requirements:
      Array.isArray(draft.requirements) && draft.requirements.length === 0
        ? null
        : draft.requirements
        ? sortKeys(draft.requirements)
        : null,
  };

  return createHash("sha256").update(JSON.stringify(sortKeys(canonical)), "utf8").digest("hex");
}

export const computeCanonicalDraftHash = computeDraftHash;

/**
 * Cryptographically signs a server-controlled quantity confirmation receipt with Key ID.
 */
export function signQuantityConfirmation(
  claimsOrReceipt: QuantityConfirmationClaims | QuantityConfirmationReceipt,
  customKid?: string
): string {
  const kid = customKid || process.env.CONFIRMATION_SIGNING_ACTIVE_KID?.trim() || DEFAULT_ACTIVE_KID;
  const secret = getSigningSecret(kid);

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid,
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();

  const isFullClaims = "jti" in claimsOrReceipt && Boolean(claimsOrReceipt.jti);

  const payload: QuantityConfirmationClaims = isFullClaims
    ? (claimsOrReceipt as QuantityConfirmationClaims)
    : {
        jti: claimsOrReceipt.jti || generateTokenJti(),
        draftId: claimsOrReceipt.draftId || "legacy_draft",
        draftVersion: claimsOrReceipt.draftVersion ?? 1,
        draftHash: claimsOrReceipt.draftHash,
        lineItemId: claimsOrReceipt.lineItemId,
        confirmedQuantity: claimsOrReceipt.confirmedQuantity,
        quantitySource: "inferred",
        actorId: claimsOrReceipt.actorId,
        iat: nowSec,
        exp: nowSec + 3600, // 1 hour TTL
        confirmedAt: claimsOrReceipt.confirmedAt || nowIso,
      };

  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verifies and decodes a signed server-controlled quantity confirmation token.
 * Returns null if signature is invalid, expired, or tampered.
 */
export function verifyQuantityConfirmation(token: string): QuantityConfirmationClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length === 2) {
      // Backward compatibility for 2-part tokens during transition
      const [payloadB64, signature] = parts;
      if (!payloadB64 || !signature) return null;
      const secret = getSigningSecret(DEFAULT_ACTIVE_KID);
      const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
      const sigBuf = Buffer.from(signature, "base64url");
      const expBuf = Buffer.from(expectedSig, "base64url");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return null;
      }
      const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      return {
        jti: parsed.jti || "legacy_jti",
        draftId: parsed.draftId || "legacy_draft",
        draftVersion: parsed.draftVersion || 1,
        draftHash: parsed.draftHash,
        lineItemId: parsed.lineItemId,
        confirmedQuantity: parsed.confirmedQuantity,
        quantitySource: parsed.quantitySource || "inferred",
        actorId: parsed.actorId,
        iat: parsed.iat || Math.floor(Date.now() / 1000),
        exp: parsed.exp || Math.floor(Date.now() / 1000) + 3600,
        confirmedAt: parsed.confirmedAt || new Date().toISOString(),
      };
    }

    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signature] = parts;
    if (!headerB64 || !payloadB64 || !signature) return null;

    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    if (header.alg !== "HS256") return null;

    const kid = typeof header.kid === "string" ? header.kid : DEFAULT_ACTIVE_KID;
    const secret = getSigningSecret(kid);

    const dataToVerify = `${headerB64}.${payloadB64}`;
    const expectedSig = createHmac("sha256", secret).update(dataToVerify).digest("base64url");

    const sigBuf = Buffer.from(signature, "base64url");
    const expBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as QuantityConfirmationClaims;

    if (
      typeof claims.jti !== "string" ||
      typeof claims.actorId !== "string" ||
      typeof claims.lineItemId !== "string" ||
      typeof claims.confirmedQuantity !== "number" ||
      typeof claims.draftHash !== "string" ||
      typeof claims.exp !== "number"
    ) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= claims.exp) {
      return null; // Expired
    }

    return claims;
  } catch {
    return null;
  }
}

/**
 * In-memory server registry tracking server-confirmed quantity records for fast caching.
 */
export class QuantityConfirmationRegistry {
  private records = new Map<string, QuantityConfirmationClaims>();

  record(claims: QuantityConfirmationClaims, token: string): void {
    this.records.set(token, { ...claims });
  }

  get(token: string): QuantityConfirmationClaims | undefined {
    return this.records.get(token);
  }

  has(token: string): boolean {
    return this.records.has(token);
  }

  clear(): void {
    this.records.clear();
  }
}

const globalRegistry = new QuantityConfirmationRegistry();

export function getQuantityConfirmationRegistry(): QuantityConfirmationRegistry {
  return globalRegistry;
}
