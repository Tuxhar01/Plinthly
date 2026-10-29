import { createHash } from "node:crypto";
import { CandidateSource, Currency } from "../state/types";
import { computeSnapshotHash } from "../state/snapshot";
import { deriveTotalCents, MAX_CENTS } from "../state/money";
import {
  CandidateDuplicateInfo,
  CandidateSpecificationsSummary,
  NormalizedProductCandidate,
  RawDiscoveredCandidate,
} from "./types";
import { validateShippingEvidence } from "./shipping";

/**
 * Validates a URL and ensures its protocol is either http: or https:.
 * Returns normalized URL string or null if invalid.
 */
export function validateUrl(rawUrl: unknown): { valid: boolean; normalized?: string; error?: string } {
  if (typeof rawUrl !== "string") {
    return { valid: false, error: "URL must be a string." };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "URL cannot be empty." };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: `Protocol "${parsed.protocol}" is not supported. Only http: and https: are allowed.` };
    }
    if (!parsed.hostname || parsed.hostname.trim().length === 0) {
      return { valid: false, error: "URL hostname cannot be empty." };
    }
    return { valid: true, normalized: parsed.toString() };
  } catch {
    return { valid: false, error: `Unparseable URL: "${trimmed}"` };
  }
}

/**
 * Parses monetary value into integer cents without floating-point arithmetic.
 * Accepts:
 * - Integer cents (number where Number.isInteger(cents) === true)
 * - Exact decimal string e.g. "29.99", "$29.99", "1200", "0.50"
 * Rejects:
 * - JavaScript floating-point numbers (e.g. 29.99 as number, due to precision loss)
 * - Ambiguous, negative, or scientific notation strings (e.g. "29.999", "-5", "1e3", "NaN")
 */
export function parseCentsExact(
  rawValue: unknown,
  fieldName: string
): { valid: boolean; cents?: number; error?: string } {
  if (rawValue === undefined || rawValue === null) {
    return { valid: false, error: `${fieldName} is missing.` };
  }

  // If passed as integer number, check directly
  if (typeof rawValue === "number") {
    if (!Number.isInteger(rawValue)) {
      return {
        valid: false,
        error: `${fieldName} passed as floating-point number (${rawValue}). Floating-point arithmetic is forbidden; pass integer cents or decimal string.`,
      };
    }
    if (rawValue < 0) {
      return { valid: false, error: `${fieldName} cannot be negative (${rawValue}).` };
    }
    if (rawValue > MAX_CENTS) {
      return { valid: false, error: `${fieldName} exceeds maximum allowable cents (${MAX_CENTS}).` };
    }
    return { valid: true, cents: rawValue };
  }

  // If passed as string, parse with strict regex
  if (typeof rawValue === "string") {
    let clean = rawValue.trim();
    if (clean.startsWith("$")) {
      clean = clean.slice(1).trim();
    }
    if (clean.length === 0) {
      return { valid: false, error: `${fieldName} string is empty.` };
    }

    // Must be positive digits with optional 1 or 2 decimal places
    const DECIMAL_REGEX = /^(\d+)(?:\.(\d{1,2}))?$/;
    const match = DECIMAL_REGEX.exec(clean);
    if (!match) {
      return {
        valid: false,
        error: `${fieldName} "${rawValue}" is not a valid non-negative decimal amount (expected e.g. "29.99" or integer).`,
      };
    }

    const intPartStr = match[1];
    let fracPartStr = match[2] ?? "00";
    if (fracPartStr.length === 1) {
      fracPartStr += "0";
    }

    const intPartBig = BigInt(intPartStr);
    const fracPartBig = BigInt(fracPartStr);
    const totalCentsBig = intPartBig * BigInt(100) + fracPartBig;

    if (totalCentsBig > BigInt(MAX_CENTS)) {
      return { valid: false, error: `${fieldName} exceeds maximum allowable cents (${MAX_CENTS}).` };
    }

    return { valid: true, cents: Number(totalCentsBig) };
  }

  return { valid: false, error: `${fieldName} must be an integer number of cents or a decimal string.` };
}

/**
 * Normalizes string values safely: trims whitespace and collapses internal multiple spaces.
 */
export function normalizeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Normalizes merchant names by stripping corporate suffixes, domain extensions, and punctuation
 * to identify merchant aliases (e.g. "Best Buy", "Best Buy Co.", "Best Buy, Inc." -> "bestbuy").
 */
export function normalizeMerchantAlias(rawName: unknown): string {
  if (typeof rawName !== "string") return "";
  let norm = rawName.toLowerCase().trim();
  // Strip common corporate suffixes
  norm = norm.replace(/\b(co|inc|llc|corp|corporation|incorporated|company|ltd|limited|services|group|holdings)\b\.?/gi, "");
  // Strip .com, www.
  norm = norm.replace(/\.com\b/gi, "").replace(/^www\./gi, "");
  // Strip non-alphanumeric characters
  norm = norm.replace(/[^a-z0-9]/g, "");
  return norm;
}

const URL_TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "ref",
  "ref_",
  "tag",
  "trk",
  "affiliate",
  "affiliate_id",
  "source",
  "campaign",
  "cmpid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
]);

/**
 * Computes a deterministic duplicate group key from candidate facts.
 * Robustly handles:
 * - Distinguishing different products with similar titles (preserves distinguishing tokens).
 * - Distinguishing different variants (preserves variant query parameters while stripping tracking params).
 * - Normalizing merchant aliases.
 * - Missing or empty identifiers.
 */
export function computeDuplicateGroupKey(candidate: {
  merchantName?: string;
  merchantUrl?: string;
  title?: string;
  externalId?: string;
}): string {
  const normMerchant = normalizeMerchantAlias(candidate.merchantName);
  let canonicalUrl = "";

  if (candidate.merchantUrl && typeof candidate.merchantUrl === "string") {
    try {
      const u = new URL(candidate.merchantUrl.trim());
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const cleanPath = u.pathname.toLowerCase().replace(/\/+$/, "") || "/";

      // Filter query parameters: strip tracking parameters, retain variant and identifying parameters
      const preservedParams: [string, string][] = [];
      for (const [key, value] of u.searchParams.entries()) {
        const kLower = key.toLowerCase();
        if (!URL_TRACKING_PARAMS.has(kLower)) {
          preservedParams.push([kLower, value.toLowerCase()]);
        }
      }
      preservedParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      const searchStr = preservedParams.map(([k, v]) => `${k}=${v}`).join("&");
      canonicalUrl = searchStr ? `${host}${cleanPath}?${searchStr}` : `${host}${cleanPath}`;
    } catch {
      canonicalUrl = candidate.merchantUrl.toLowerCase().trim();
    }
  }

  // Significant title tokens: preserve up to 20 words so model numbers, accessories, and variants are not truncated
  const titleTokens = normalizeText(candidate.title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 20)
    .join("-");

  const externalId = typeof candidate.externalId === "string" ? candidate.externalId.trim().toLowerCase() : "";

  // The seed incorporates merchant identity, canonical URL (preserving variant query params), and title tokens
  let seed = "";
  if (canonicalUrl && titleTokens) {
    seed = `${canonicalUrl}::${titleTokens}`;
  } else if (canonicalUrl) {
    seed = canonicalUrl;
  } else if (normMerchant && titleTokens) {
    seed = `${normMerchant}::${titleTokens}`;
  } else if (titleTokens) {
    seed = titleTokens;
  } else if (externalId) {
    seed = `${normMerchant}::${externalId}`;
  } else {
    seed = `unidentified_candidate_${Date.now()}`;
  }

  return createHash("sha256").update(seed, "utf8").digest("hex").substring(0, 16);
}

/**
 * Categorizes candidate attributes into known (verified from structured source),
 * inferred (extracted or unverified text), and missing.
 * Crucially: Inferred attributes NEVER satisfy a required specification as a verified fact.
 */
export function summarizeCandidateSpecifications(
  rawAttributes?: unknown,
  requiredKeys?: readonly string[]
): CandidateSpecificationsSummary {
  const known: Record<string, string> = {};
  const inferred: Record<string, string> = {};
  const missing: string[] = [];

  const rawMap =
    rawAttributes && typeof rawAttributes === "object"
      ? (rawAttributes as Record<string, unknown>)
      : {};

  for (const [k, v] of Object.entries(rawMap)) {
    if (v === undefined || v === null) continue;
    const keyLower = k.toLowerCase().trim();
    if (keyLower === "provider" || keyLower === "attribution") continue;

    const strVal = typeof v === "string" ? v.trim() : String(v);
    if (
      keyLower.startsWith("inferred_") ||
      keyLower.startsWith("unverified_") ||
      keyLower.includes("heuristic")
    ) {
      inferred[k] = strVal;
    } else {
      known[k] = strVal;
    }
  }

  if (requiredKeys && requiredKeys.length > 0) {
    for (const reqKey of requiredKeys) {
      const cleanKey = reqKey.toLowerCase().trim();
      // Only structured verified facts in known can satisfy a required specification
      const hasKnown = Object.keys(known).some((k) => k.toLowerCase().trim() === cleanKey);
      // Inferred attributes (unverified text heuristics) NEVER satisfy a required specification as a verified fact
      if (!hasKnown) {
        missing.push(reqKey);
      }
    }
  }

  return { known, inferred, missing };
}

/**
 * Normalizes and validates a raw candidate from an external or fixture source.
 * Follows core principle: discovered data is untrusted input.
 * Missing fields, malformed values, or invalid arithmetic will result in an incomplete
 * or rejected candidate, never silently defaulting or guessing.
 */
export function normalizeCandidate(
  raw: RawDiscoveredCandidate,
  options: {
    purchaseId: string;
    source: CandidateSource;
    now: Date;
    candidateId?: string;
    duplicateInfo?: CandidateDuplicateInfo;
    requiredAttributes?: readonly string[];
  }
): NormalizedProductCandidate {
  const errors: string[] = [];
  const rawSourceData: Record<string, unknown> = { ...raw };

  const id = options.candidateId ?? (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `cand_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
  const purchaseId = options.purchaseId;
  const source = options.source;

  // 1. External ID
  const externalId = typeof raw.externalId === "string" ? raw.externalId.trim() : "";
  if (externalId.length === 0) {
    errors.push("Missing or empty externalId.");
  }

  // 2. Title
  const title = normalizeText(raw.title);
  if (title.length === 0) {
    errors.push("Missing or empty title.");
  }

  // 3. Merchant Name
  const merchantName = normalizeText(raw.merchantName);
  if (merchantName.length === 0) {
    errors.push("Missing or empty merchantName.");
  }

  // 4. Merchant URL
  const urlCheck = validateUrl(raw.merchantUrl ?? raw.sourceUrl);
  let merchantUrl = "";
  if (!urlCheck.valid || !urlCheck.normalized) {
    errors.push(`Invalid merchantUrl: ${urlCheck.error}`);
  } else {
    merchantUrl = urlCheck.normalized;
  }

  // 5. Currency
  const currency: Currency = "USD";
  if (raw.currency === undefined || raw.currency === null || raw.currency === "") {
    errors.push("Missing currency specification.");
  } else if (raw.currency !== "USD") {
    errors.push(`Unsupported currency "${String(raw.currency)}". Only "USD" is supported.`);
  }

  // 6. Unit Price Cents
  const rawUnitPrice = raw.unitPriceCents ?? raw.unitPrice;
  const unitPriceCheck = parseCentsExact(rawUnitPrice, "unitPrice");
  let unitPriceCents = 0;
  if (!unitPriceCheck.valid || unitPriceCheck.cents === undefined) {
    errors.push(`Invalid unitPrice: ${unitPriceCheck.error}`);
  } else if (unitPriceCheck.cents <= 0) {
    errors.push(`unitPriceCents must be greater than zero, got ${unitPriceCheck.cents}.`);
  } else {
    unitPriceCents = unitPriceCheck.cents;
  }

  // 7. Quantity
  let quantity = 1;
  if (raw.quantity !== undefined && raw.quantity !== null) {
    if (typeof raw.quantity !== "number" || !Number.isInteger(raw.quantity) || raw.quantity < 1) {
      errors.push(`quantity must be an integer >= 1, got ${String(raw.quantity)}.`);
    } else {
      quantity = raw.quantity;
    }
  }

  // 8. Shipping Cents and Structured Shipping Evidence
  const shippingRes = validateShippingEvidence({
    rawShipping: raw.shipping,
    rawShippingCents: raw.shippingCents,
    shippingType: raw.shippingType,
    deliveryMethod: raw.deliveryMethod,
    destinationPostalCode: raw.destinationPostalCode,
    destinationCountry: raw.destinationCountry,
    observationTimestamp: options.now,
    sourceVerificationTimestamp: raw.sourceVerificationTimestamp,
    source,
    requiresDestination: typeof raw.requiresDestination === "boolean" ? raw.requiresDestination : undefined,
    policyId: typeof raw.policyId === "string" ? raw.policyId : undefined,
    policyDocumentFingerprint:
      typeof raw.policyDocumentFingerprint === "string" ? raw.policyDocumentFingerprint : undefined,
    policySourceUrl: typeof raw.policySourceUrl === "string" ? raw.policySourceUrl : undefined,
    geographicZone: raw.geographicZone as import("./geographic-zones").GeographicZone,
    serviceabilityStatus: raw.serviceabilityStatus as import("./geographic-zones").DestinationServiceability,
    thresholdCents: typeof raw.thresholdCents === "number" ? raw.thresholdCents : undefined,
  });

  const shippingCents = shippingRes.shippingCents;
  const shippingDetails = shippingRes.details;
  if (!shippingRes.valid || !shippingRes.isComplete) {
    errors.push(...shippingRes.errors);
  }

  // 9. Total Cents (derived, not guessed)
  let totalCents = 0;
  if (unitPriceCents > 0 && quantity >= 1 && shippingCents >= 0 && errors.length === 0) {
    try {
      totalCents = deriveTotalCents(unitPriceCents, quantity, shippingCents);
    } catch (err: unknown) {
      errors.push(`Failed to derive total cents: ${(err as Error).message}`);
    }
  }

  // 10. Availability
  // Explicit rule: do not infer stock availability when absent
  let availability = "";
  if (typeof raw.availability === "string" && raw.availability.trim().length > 0) {
    availability = raw.availability.trim().toLowerCase();
  } else {
    errors.push("Missing stock availability status. Availability cannot be inferred when absent.");
  }

  // 11. CapturedAt timestamp
  let capturedAt: Date = options.now;
  if (raw.capturedAt instanceof Date && !isNaN(raw.capturedAt.getTime())) {
    capturedAt = raw.capturedAt;
  } else if (typeof raw.capturedAt === "string" && raw.capturedAt.trim().length > 0) {
    const parsed = Date.parse(raw.capturedAt);
    if (!isNaN(parsed)) {
      capturedAt = new Date(parsed);
    } else {
      errors.push(`Unparseable capturedAt timestamp: "${raw.capturedAt}".`);
    }
  }

  const isComplete = errors.length === 0;

  // 12. Snapshot Hash
  let snapshotHash = "";
  if (isComplete) {
    try {
      snapshotHash = computeSnapshotHash({
        availability,
        currency,
        externalId,
        merchantName,
        merchantUrl,
        quantity,
        shippingCents,
        source,
        totalCents,
        unitPriceCents,
      });
    } catch (err: unknown) {
      errors.push(`Snapshot hash generation failed: ${(err as Error).message}`);
    }
  }

  // 13. Duplicate Info & Specifications Summary
  const duplicateGroupKey =
    options.duplicateInfo?.duplicateGroupKey ??
    computeDuplicateGroupKey({
      merchantName,
      merchantUrl,
      title,
      externalId,
    });

  const duplicateInfo: CandidateDuplicateInfo = options.duplicateInfo ?? {
    isDuplicate: false,
    duplicateGroupKey,
    duplicateReason: "Primary offer in group",
  };

  const specificationsSummary = summarizeCandidateSpecifications(
    raw.rawAttributes,
    options.requiredAttributes
  );

  // 14. Retailer/Seller Provenance & Blocker Attribution (Phase 14)
  const rawAttrs =
    raw.rawAttributes && typeof raw.rawAttributes === "object"
      ? (raw.rawAttributes as Record<string, unknown>)
      : {};

  const sellerName =
    typeof raw.sellerName === "string" && raw.sellerName.trim().length > 0
      ? raw.sellerName.trim()
      : typeof raw.seller === "string" && raw.seller.trim().length > 0
      ? raw.seller.trim()
      : typeof rawAttrs.seller === "string" && rawAttrs.seller.trim().length > 0
      ? rawAttrs.seller.trim()
      : typeof rawAttrs.seller_name === "string" && rawAttrs.seller_name.trim().length > 0
      ? rawAttrs.seller_name.trim()
      : undefined;

  const isMarketplace =
    typeof raw.isMarketplace === "boolean"
      ? raw.isMarketplace
      : typeof raw.marketplace === "boolean"
      ? raw.marketplace
      : typeof rawAttrs.is_marketplace === "boolean"
      ? rawAttrs.is_marketplace
      : typeof rawAttrs.marketplace === "boolean"
      ? rawAttrs.marketplace
      : undefined;

  const isDirectRetailer =
    typeof raw.isDirectRetailer === "boolean"
      ? raw.isDirectRetailer
      : typeof raw.is_direct_retailer === "boolean"
      ? raw.is_direct_retailer
      : typeof rawAttrs.is_direct_retailer === "boolean"
      ? rawAttrs.is_direct_retailer
      : undefined;

  const fulfillmentMethod =
    typeof raw.fulfillmentMethod === "string" && raw.fulfillmentMethod.trim().length > 0
      ? raw.fulfillmentMethod.trim()
      : typeof rawAttrs.fulfilled_by === "string" && rawAttrs.fulfilled_by.trim().length > 0
      ? rawAttrs.fulfilled_by.trim()
      : typeof rawAttrs.fulfillment === "string" && rawAttrs.fulfillment.trim().length > 0
      ? rawAttrs.fulfillment.trim()
      : undefined;

  let blockerReason: string | undefined = undefined;
  let blockerAction: string | undefined = undefined;

  if (errors.length > 0) {
    if (shippingDetails.type === "missing") {
      blockerReason = "Missing shipping cost specification. Shipping cannot be inferred as zero when absent.";
      blockerAction = "Provide a valid destination postal code to request an authoritative quote or evaluate merchant free-shipping policy.";
    } else if (shippingDetails.type === "estimated") {
      blockerReason = "Estimated shipping cost cannot be treated as an authoritative quote for buyer approval.";
      blockerAction = "Obtain an authoritative carrier quote or verified merchant shipping policy.";
    } else if (errors.some((e) => e.includes("availability"))) {
      blockerReason = "Stock availability is unverified from source.";
      blockerAction = "Verify merchant in-stock status before approval.";
    } else {
      blockerReason = errors.join("; ");
      blockerAction = "Resolve missing or unverified candidate attributes.";
    }
  } else if (rawAttrs.shipping_blocker_reason) {
    blockerReason = String(rawAttrs.shipping_blocker_reason);
    if (rawAttrs.shipping_blocker_status === "marketplace_excluded") {
      blockerAction = "Select an item sold and fulfilled directly by the retailer rather than a marketplace third-party seller.";
    } else if (rawAttrs.shipping_blocker_status === "destination_excluded") {
      blockerAction = "Specify a delivery destination within the merchant's contiguous US service zone.";
    } else {
      blockerAction = "Verify merchant policy conditions or provide destination details.";
    }
  }

  return {
    id,
    purchaseId,
    source,
    externalId,
    title,
    merchantName,
    merchantUrl,
    unitPriceCents,
    quantity,
    shippingCents,
    totalCents,
    currency,
    availability,
    capturedAt,
    snapshotHash,
    rawSourceData,
    shippingDetails,
    duplicateInfo,
    specificationsSummary,
    isComplete: errors.length === 0,
    validationErrors: errors,
    sellerName,
    isMarketplace,
    isDirectRetailer,
    fulfillmentMethod,
    blockerReason,
    blockerAction,
  };
}
