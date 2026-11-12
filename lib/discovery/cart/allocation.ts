/**
 * Plinthly Phase 15 — Candidate Allocation and Specification Compatibility Engine.
 *
 * Enforces:
 * 1. Title, specification, and variant compatibility between line items and candidate facts.
 * 2. Rejection of candidate allocations when critical specifications contradict (e.g. RAM, storage, brand).
 * 3. Prevention of duplicate candidate allocations: a single candidate instance cannot satisfy multiple
 *    distinct line items unless inventory and line item definitions explicitly permit it.
 * 4. Preservation of seller, merchant identity, fulfillment method, and observation timestamps.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NormalizedProductCandidate } from "../types";
import { computeSnapshotHash, resolveValidSnapshotHash } from "../../state/snapshot";
import {
  LineItemCandidateAllocation,
  ProcurementLineItem,
  SellerAuthenticityEvidence,
  EvidenceTier,
  ProductSuitabilityTier,
  ProductSuitabilityAssessment,
} from "./types";
import {
  AmountOutOfBoundsError,
  MalformedNestedStructureError,
  ProviderTaxSumMismatchError,
} from "../../contracts/stage2-errors";

export interface CandidateCompatibilityCheck {
  readonly compatible: boolean;
  readonly matchedSpecs: readonly string[];
  readonly contradictorySpecs: readonly string[];
  readonly missingSpecs: readonly string[];
  readonly score: number;
  readonly reason: string;
  readonly suitability?: ProductSuitabilityAssessment;
}

/**
 * Detects high-level product classification / category to prevent absurd cross-category
 * allocations (e.g. allocating a docking station to a laptop line item or monitor to a dock).
 */
export function getProductClassification(
  title: string
): "laptop" | "monitor" | "dock" | "keyboard" | "mouse" | "audio" | "general" {
  if (!title || typeof title !== "string") return "general";
  const t = title.toLowerCase();
  // Docking station check first (to prevent "laptop docking station" being classified as laptop)
  if (/\b(dock|docking\s+station|port\s+replicator|usb-c\s+hub|thunderbolt\s+hub)\b/.test(t)) {
    return "dock";
  }
  if (/\b(laptop|notebook|macbook|xps|thinkpad|chromebook)\b/.test(t)) {
    return "laptop";
  }
  if (/\b(monitor|display|ultrasharp|screen)\b/.test(t)) {
    return "monitor";
  }
  if (/\b(keyboard)\b/.test(t)) {
    return "keyboard";
  }
  if (/\b(mouse)\b/.test(t)) {
    return "mouse";
  }
  if (/\b(headset|headphones|earbuds)\b/.test(t)) {
    return "audio";
  }
  return "general";
}

/**
 * Checks if a procurement request is specifically for professional software engineering or development.
 */
export function isSoftwareDevelopmentRequest(lineItem: ProcurementLineItem): boolean {
  const titleLower = (lineItem.title || "").toLowerCase();
  const devKeywords = [
    "software development",
    "software developer",
    "programming",
    "developer setup",
    "developer laptop",
    "coding",
    "software engineer",
    "engineer laptop",
    "code compilation",
    "software testing",
    "development",
  ];
  if (devKeywords.some((kw) => titleLower.includes(kw))) {
    return true;
  }
  if (Array.isArray(lineItem.requirements)) {
    for (const rawReq of lineItem.requirements) {
      const req = typeof rawReq === "string" ? { key: rawReq } : rawReq;
      const combined = `${req.key || ""} ${req.expectedValue || ""} ${req.description || ""}`.toLowerCase();
      if (devKeywords.some((kw) => combined.includes(kw))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if the buyer explicitly requested older, vintage, or budget hardware.
 */
export function isVintageOrBudgetExplicitlyRequested(lineItem: ProcurementLineItem): boolean {
  const titleLower = (lineItem.title || "").toLowerCase();
  const vintageKeywords = [
    "vintage",
    "retro",
    "older",
    "refurbished",
    "used",
    "thinkpad p50",
    "p50",
    "budget laptop",
    "cheap laptop",
    "legacy",
  ];
  if (vintageKeywords.some((kw) => titleLower.includes(kw))) {
    return true;
  }
  if (Array.isArray(lineItem.requirements)) {
    for (const rawReq of lineItem.requirements) {
      const req = typeof rawReq === "string" ? { key: rawReq } : rawReq;
      const combined = `${req.key || ""} ${req.expectedValue || ""} ${req.description || ""}`.toLowerCase();
      if (vintageKeywords.some((kw) => combined.includes(kw))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Deterministically evaluates candidate product suitability for professional software development (DEF-AUD-01).
 * Distinguishes: "compatible", "compatible_with_limitations", "insufficient_evidence", "unsuitable".
 */
export function evaluateProductSuitability(
  lineItem: ProcurementLineItem,
  candidate: NormalizedProductCandidate
): ProductSuitabilityAssessment {
  const isDev = isSoftwareDevelopmentRequest(lineItem);
  const isVintage = isVintageOrBudgetExplicitlyRequested(lineItem);

  // Extract text tokens to inspect
  const titleLower = (candidate.title || "").toLowerCase();
  const rawAttrs = (candidate.rawAttributes || {}) as Record<string, unknown>;
  const attrsText = Object.entries(rawAttrs)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ")
    .toLowerCase();
  const combinedText = `${titleLower} ${attrsText}`;

  const disclosures: string[] = [];

  // 1. Detect Refurbished / Used condition
  const candAny = candidate as unknown as Record<string, unknown>;
  const isRefurbishedOrUsed =
    candAny.condition === "refurbished" ||
    candAny.condition === "used" ||
    rawAttrs.condition === "refurbished" ||
    rawAttrs.condition === "used" ||
    /\b(refurbished|renewed|pre-owned|used|off-lease|b-stock)\b/i.test(combinedText);
  if (isRefurbishedOrUsed) {
    disclosures.push("Product condition: refurbished or pre-owned.");
  }

  // 2. Detect CPU & Generation
  let isObsoleteHardware = false;
  let isWindows11Capable: boolean | undefined = undefined;
  let cpuGeneration: string | undefined = undefined;

  // Obsolete architectures: Intel 7th gen or older (6th gen Skylake, 5th gen Broadwell, 4th gen Haswell, etc.)
  // Specifically: ThinkPad P50 (2015/2016 6th gen Skylake Core/Xeon), P70, T450, T460, T470, etc.
  const obsoleteIntelMatch =
    /\b(p50|p70|t450|t460|t470|x250|x260|x270|skylake|broadwell|haswell|6700hq|6820hq|6820hk|6920hq|e3-1505m|e3-1535m|6th\s*gen|7th\s*gen)\b/i.test(
      combinedText
    ) ||
    /\bi[357]-6\d{3}[a-z]*\b/i.test(combinedText) ||
    /\bi[357]-7\d{3}[a-z]*\b/i.test(combinedText);

  // Modern architectures: Intel 8th-Gen or newer (Windows 11 baseline: 8th gen+, Ryzen 2000+, Core Ultra, Core 5/7/9, Apple Silicon)
  const modernCpuMatch =
    /\b(core\s*ultra|core\s*[3579]\s*2\d{2}[a-z]*|1[012345]th\s*gen|ryzen\s*[3579]\s*[23456789]\d{3}|m[1234]\b|apple\s*silicon|snapdragon\s*x)\b/i.test(
      combinedText
    ) ||
    /\bi[3579]-1[012345]\d{3}[a-z]*\b/i.test(combinedText) ||
    /\bi[3579]-8\d{3}[a-z]*\b/i.test(combinedText) ||
    /\bi[3579]-9\d{3}[a-z]*\b/i.test(combinedText);

  if (obsoleteIntelMatch) {
    isObsoleteHardware = true;
    isWindows11Capable = false;
    cpuGeneration = "Intel 6th/7th-Gen or older (~2015-2017)";
    disclosures.push("Obsolete processor generation (~2015-2017 Intel Skylake/Kaby Lake).");
    disclosures.push("Officially incompatible with Windows 11 (requires Intel 8th-Gen or newer).");
  } else if (modernCpuMatch) {
    isObsoleteHardware = false;
    isWindows11Capable = true;
    cpuGeneration = "Modern 8th-Gen+ / Core Ultra / Ryzen 2000+ / Apple Silicon";
  } else {
    // Missing CPU generation evidence
    disclosures.push("Processor generation and architecture evidence is unverified from provider.");
  }

  // 3. Detect RAM
  let ramGb: number | undefined = undefined;
  const ramMatch = combinedText.match(/\b(4|8|16|24|32|64|128)\s*gb\b/i);
  if (ramMatch) {
    ramGb = parseInt(ramMatch[1], 10);
  } else if (typeof rawAttrs.ram === "string") {
    const rawMatch = (rawAttrs.ram as string).match(/\b(4|8|16|24|32|64|128)\b/);
    if (rawMatch) ramGb = parseInt(rawMatch[1], 10);
  }

  if (ramGb !== undefined) {
    if (ramGb <= 4) {
      disclosures.push(`Severe memory constraint: ${ramGb}GB RAM is inadequate for modern software development.`);
    } else if (ramGb <= 8) {
      disclosures.push(`Memory constraint: ${ramGb}GB RAM may constrain multi-container (Docker) or heavy IDE workloads; 16GB+ recommended.`);
    }
  } else {
    disclosures.push("RAM capacity evidence is unverified from provider.");
  }

  // 4. Detect Storage
  let storage: string | undefined = undefined;
  const storageMatch = combinedText.match(/\b(128|256|512)\s*gb\s*(?:ssd|nvme|pcie)?\b|\b(1|2)\s*tb\s*(?:ssd|nvme|pcie)?\b/i);
  if (storageMatch) {
    storage = storageMatch[0];
  }

  const detectedSpecs = {
    cpuGeneration,
    ramGb,
    storage,
    isRefurbishedOrUsed,
    isWindows11Capable,
    isObsoleteHardware,
  };

  // If this is NOT a professional software development request:
  if (!isDev) {
    return {
      tier: isObsoleteHardware || isRefurbishedOrUsed ? "compatible_with_limitations" : "compatible",
      isProfessionalDevelopmentRequest: false,
      isVintageOrBudgetExplicitlyRequested: isVintage,
      disclosures,
      detectedSpecs,
      reason: "General non-development request: standard category matching applies.",
    };
  }

  // If user explicitly asked for older/budget/vintage hardware:
  if (isVintage) {
    disclosures.push("Explicitly requested older, vintage, or budget hardware accommodated with disclosed limitations.");
    return {
      tier: isObsoleteHardware || isRefurbishedOrUsed || (ramGb !== undefined && ramGb <= 8)
        ? "compatible_with_limitations"
        : "compatible",
      isProfessionalDevelopmentRequest: true,
      isVintageOrBudgetExplicitlyRequested: true,
      disclosures,
      detectedSpecs,
      reason: "Explicit buyer request for budget, vintage, or older hardware accommodated with disclosed limitations.",
    };
  }

  // If candidate is obsolete hardware (e.g. ThinkPad P50) or severely inadequate RAM (<=4GB):
  if (isObsoleteHardware || (ramGb !== undefined && ramGb <= 4)) {
    return {
      tier: "unsuitable",
      isProfessionalDevelopmentRequest: true,
      isVintageOrBudgetExplicitlyRequested: false,
      disclosures,
      detectedSpecs,
      reason: isObsoleteHardware
        ? "Product is an obsolete ~10-year-old workstation (Intel 6th-Gen / Skylake) unsupported by Windows 11 and unsuitable for modern professional software development."
        : "Product memory (<=4GB RAM) is inadequate for modern professional software development.",
    };
  }

  // If critical evidence (either CPU generation or RAM capacity) is unverified from provider:
  if (cpuGeneration === undefined || ramGb === undefined) {
    return {
      tier: "insufficient_evidence",
      isProfessionalDevelopmentRequest: true,
      isVintageOrBudgetExplicitlyRequested: false,
      disclosures,
      detectedSpecs,
      reason: "Hardware evidence is incomplete: CPU generation or RAM capacity cannot be verified from provider catalog.",
    };
  }

  // If candidate has disclosed limitations (8GB RAM or refurbished condition):
  if ((ramGb !== undefined && ramGb <= 8) || isRefurbishedOrUsed) {
    return {
      tier: "compatible_with_limitations",
      isProfessionalDevelopmentRequest: true,
      isVintageOrBudgetExplicitlyRequested: false,
      disclosures,
      detectedSpecs,
      reason: "Hardware meets minimum operational threshold but carries disclosed performance or condition limitations.",
    };
  }

  // Otherwise: Verified modern hardware suitable for professional development!
  return {
    tier: "compatible",
    isProfessionalDevelopmentRequest: true,
    isVintageOrBudgetExplicitlyRequested: false,
    disclosures,
    detectedSpecs,
    reason: "Verified modern hardware suitable for professional software development.",
  };
}

/**
 * Evaluates whether a candidate product is compatible with a line item's required specifications.
 * Enforces that critical contradictions (e.g. wrong variant, incompatible specs) fail allocation.
 */
export function checkCandidateCompatibility(
  lineItem: ProcurementLineItem,
  candidate: NormalizedProductCandidate
): CandidateCompatibilityCheck {
  const matchedSpecs: string[] = [];
  const contradictorySpecs: string[] = [];
  const missingSpecs: string[] = [];

  // Product category / classification check: hard gate against cross-category allocation
  const requestedCategory = getProductClassification(lineItem.title);
  const candidateCategory = getProductClassification(candidate.title);
  if (requestedCategory !== "general" && candidateCategory !== "general" && requestedCategory !== candidateCategory) {
    contradictorySpecs.push(
      `Product category contradiction: line item requires "${requestedCategory}", but candidate is classified as "${candidateCategory}" ("${candidate.title}")`
    );
  }

  // Hardware suitability assessment (DEF-AUD-01)
  const suitability = evaluateProductSuitability(lineItem, candidate);
  if (suitability.tier === "unsuitable") {
    contradictorySpecs.push(`Hardware suitability failure: ${suitability.reason}`);
    return {
      compatible: false,
      matchedSpecs: [],
      contradictorySpecs,
      missingSpecs: [],
      score: 0,
      reason: `Unsuitable for stated purpose: ${suitability.reason}`,
      suitability,
    };
  }

  // Check currency
  if (candidate.currency !== lineItem.currency) {
    return {
      compatible: false,
      matchedSpecs: [],
      contradictorySpecs: [`Currency mismatch: candidate=${candidate.currency}, required=${lineItem.currency}`],
      missingSpecs: [],
      score: 0,
      reason: `Currency mismatch: candidate is ${candidate.currency}, but line item requires ${lineItem.currency}.`,
    };
  }

  // Check budget constraint if defined
  if (lineItem.budgetCents !== undefined && lineItem.budgetCents > 0) {
    const totalItemCents = candidate.unitPriceCents * lineItem.quantity;
    if (totalItemCents > lineItem.budgetCents) {
      if (lineItem.verificationLevel === "strict") {
        return {
          compatible: false,
          matchedSpecs: [],
          contradictorySpecs: [`Budget exceeded: ${totalItemCents} cents > ${lineItem.budgetCents} cents`],
          missingSpecs: [],
          score: 0,
          reason: `Total line-item cost ($${(totalItemCents / 100).toFixed(2)}) exceeds line-item budget ($${(lineItem.budgetCents / 100).toFixed(2)}).`,
        };
      }
    }
  }

  // Evaluate specifications from observationList / rawAttributes
  const observations = (candidate.observationList ?? []) as readonly { requirementKey: string; value: string; status: string }[];
  const rawAttrs = (candidate.rawAttributes ?? {}) as Record<string, unknown>;

  const lineItemRequirements = Array.isArray(lineItem.requirements) ? lineItem.requirements : [];
  for (const rawReq of lineItemRequirements) {
    const req = typeof rawReq === "string" ? { key: rawReq } : rawReq;
    const reqKey = req.key.toLowerCase().trim();
    const expectedVal = req.expectedValue?.toLowerCase().trim();

    // Check observations
    const matchingObs = observations.find(
      (obs: { requirementKey: string }) => obs.requirementKey.toLowerCase().trim() === reqKey
    );

    if (matchingObs) {
      if (matchingObs.status === "contradicts") {
        contradictorySpecs.push(`${req.key}: expected "${req.expectedValue ?? 'present'}", observed contradicts ("${matchingObs.value}")`);
        continue;
      }

      if (expectedVal) {
        const obsVal = matchingObs.value.toLowerCase().trim();
        if (obsVal.includes(expectedVal) || expectedVal.includes(obsVal)) {
          matchedSpecs.push(req.key);
        } else {
          contradictorySpecs.push(`${req.key}: expected "${req.expectedValue}", observed "${matchingObs.value}"`);
        }
      } else {
        matchedSpecs.push(req.key);
      }
      continue;
    }

    // Check raw attributes if observation not found
    let foundInRaw = false;
    for (const [attrKey, attrVal] of Object.entries(rawAttrs)) {
      if (attrKey.toLowerCase().includes(reqKey) || reqKey.includes(attrKey.toLowerCase())) {
        const strVal = String(attrVal).toLowerCase().trim();
        if (expectedVal) {
          if (strVal.includes(expectedVal) || expectedVal.includes(strVal)) {
            matchedSpecs.push(req.key);
            foundInRaw = true;
          } else {
            contradictorySpecs.push(`${req.key}: expected "${req.expectedValue}", found attribute "${attrVal}"`);
            foundInRaw = true;
          }
        } else {
          matchedSpecs.push(req.key);
          foundInRaw = true;
        }
        break;
      }
    }

    // Check candidate title if observation and raw attributes did not verify
    if (!foundInRaw && candidate.title) {
      const titleLower = candidate.title.toLowerCase();
      if (expectedVal) {
        if (titleLower.includes(expectedVal)) {
          matchedSpecs.push(req.key);
          foundInRaw = true;
        } else if (reqKey === "ram" && /\b(4gb|8gb|16gb|32gb|64gb)\b/.test(titleLower)) {
          const foundRam = titleLower.match(/\b(4gb|8gb|16gb|32gb|64gb)\b/)?.[0];
          if (foundRam && !foundRam.includes(expectedVal) && !expectedVal.includes(foundRam)) {
            contradictorySpecs.push(`${req.key}: expected "${req.expectedValue}", candidate title specifies "${foundRam}"`);
            foundInRaw = true;
          }
        }
      } else if (titleLower.includes(reqKey)) {
        matchedSpecs.push(req.key);
        foundInRaw = true;
      }
    }

    if (!foundInRaw) {
      missingSpecs.push(req.key);
    }
  }

  // Rejection logic:
  // If ANY specification directly contradicts, the candidate cannot be allocated to this line item.
  if (contradictorySpecs.length > 0) {
    return {
      compatible: false,
      matchedSpecs,
      contradictorySpecs,
      missingSpecs,
      score: 0,
      reason: `Specification contradictions detected: ${contradictorySpecs.join("; ")}. Candidate cannot satisfy line item.`,
    };
  }

  // In strict verification mode, missing specifications also reject
  if (lineItem.verificationLevel === "strict" && missingSpecs.length > 0) {
    return {
      compatible: false,
      matchedSpecs,
      contradictorySpecs,
      missingSpecs,
      score: 0.2,
      reason: `Strict verification failed: missing verified evidence for specifications: ${missingSpecs.join(", ")}.`,
    };
  }

  // When a line item requires a specific category and has mandatory requirements,
  // a candidate with general classification and 0 matched specs cannot qualify.
  if (lineItemRequirements.length > 0 && matchedSpecs.length === 0 && requestedCategory !== "general" && candidateCategory === "general") {
    return {
      compatible: false,
      matchedSpecs,
      contradictorySpecs: [`Unverified candidate: candidate does not match requested category "${requestedCategory}" and matches 0 required specifications.`],
      missingSpecs,
      score: 0,
      reason: `Candidate does not match required product category "${requestedCategory}" and has zero matched specifications.`,
    };
  }

  const totalReqs = lineItemRequirements.length;
  let matchRatio = totalReqs > 0 ? matchedSpecs.length / totalReqs : 1.0;

  // Modulate match score based on suitability assessment:
  if (suitability.tier === "insufficient_evidence") {
    matchRatio = Math.min(matchRatio, 0.45);
  } else if (suitability.tier === "compatible_with_limitations") {
    matchRatio = Math.min(matchRatio, 0.75);
  }

  return {
    compatible: true,
    matchedSpecs,
    contradictorySpecs,
    missingSpecs,
    score: matchRatio,
    reason: `Compatible: ${matchedSpecs.length}/${totalReqs} requirements matched with verified evidence. ${suitability.reason}`,
    suitability,
  };
}

/**
 * Strictly parses a boolean value from unknown input.
 * Explicitly guards against JavaScript's Boolean("false") === true trap.
 */
export function parseStrictBoolean(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1" || trimmed === "yes") return true;
    if (trimmed === "false" || trimmed === "0" || trimmed === "no") return false;
    return false;
  }
  if (typeof val === "number") {
    return val === 1;
  }
  return false;
}

/**
 * Resolves the server authenticity verification secret from environment.
 * Missing or empty secret returns undefined, failing closed with zero fallback defaults.
 */
export function getServerAuthenticitySecret(): string | undefined {
  const envVal = process.env.AUTHENTICITY_VERIFICATION_SECRET?.trim();
  return envVal && envVal.length >= 32 ? envVal : undefined;
}

/**
 * A discrete, cryptographically attested claim verified by the server-side verification pipeline.
 */
export interface AuthenticityClaimAttestation {
  readonly claimType: "authorization" | "authenticity" | "warranty";
  readonly sellerOrCandidateId: string;
  readonly evidenceReference: string;
  readonly authorityId: string;
  readonly attestedAt: string;
  readonly expiresAt?: string;
  readonly attestationSignature: string;
}

/**
 * Computes deterministic cryptographic attestation signature for an authentic claim.
 * Requires an explicit, non-empty secret key.
 * Missing secret throws Error, failing closed.
 */
export function computeClaimAttestationSignature(
  claim: {
    readonly claimType: "authorization" | "authenticity" | "warranty";
    readonly sellerOrCandidateId: string;
    readonly evidenceReference: string;
    readonly authorityId: string;
    readonly attestedAt: string;
    readonly expiresAt?: string;
  },
  secret: string
): string {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error(
      "Missing required signing secret: cannot compute claim attestation signature without a valid non-empty secret key (fail-closed)."
    );
  }
  const expiresAtStr = claim.expiresAt ? claim.expiresAt.trim() : "no_expiry";
  const message = `${claim.claimType}:::${claim.sellerOrCandidateId.toLowerCase().trim()}:::${claim.evidenceReference.trim()}:::${claim.authorityId.trim()}:::${claim.attestedAt.trim()}:::${expiresAtStr}`;
  return createHmac("sha256", secret.trim()).update(message).digest("hex");
}

const INTERNAL_AUTHENTICITY_REGISTRY_TOKEN = Symbol("ServerAuthenticityRegistry.INTERNAL_TOKEN");

/**
 * Server-controlled cryptographic/authoritative authenticity registry.
 * Prevents client-supplied callbacks, arbitrary objects, or untrusted callers
 * from elevating unverified candidate claims to "verified_fact".
 *
 * Requirements:
 * 1. Direct instantiation by application code is strictly prohibited. Constructor requires
 *    unexported internal token.
 * 2. In production, trusted registries may only be created via server-controlled pipelines
 *    reading configured environment secrets.
 * 3. Enrolled attestations must pass cryptographic signature verification against server secret.
 * 4. JavaScript private fields (#authorizations, #authenticProducts, #warranties) ensure zero
 *    prototype-call mutation or outside inspection of internal Set references.
 * 5. Immutable: sealed with Object.freeze upon construction.
 */
export class ServerAuthenticityRegistry {
  readonly #authorizations: ReadonlySet<string>;
  readonly #authenticProducts: ReadonlySet<string>;
  readonly #warranties: ReadonlySet<string>;
  readonly #isTestRegistry: boolean;

  constructor(
    internalToken: unknown,
    params: {
      readonly verifiedAuthorizations: ReadonlySet<string>;
      readonly verifiedAuthenticProducts: ReadonlySet<string>;
      readonly verifiedWarranties: ReadonlySet<string>;
    },
    options?: { readonly isTestRegistry?: boolean }
  ) {
    if (internalToken !== INTERNAL_AUTHENTICITY_REGISTRY_TOKEN) {
      throw new Error(
        "Unauthorized construction of ServerAuthenticityRegistry: Direct instantiation is strictly prohibited. Registries must be constructed through server-controlled authority pipelines."
      );
    }

    this.#authorizations = Object.freeze(params.verifiedAuthorizations);
    this.#authenticProducts = Object.freeze(params.verifiedAuthenticProducts);
    this.#warranties = Object.freeze(params.verifiedWarranties);
    this.#isTestRegistry = options?.isTestRegistry === true;
    Object.freeze(this);
  }

  public get isTestRegistry(): boolean {
    return this.#isTestRegistry;
  }

  public isAuthorizationValidated(ref: string, sellerName: string): boolean {
    const key = `${sellerName.toLowerCase().trim()}:${ref.trim()}`;
    return this.#authorizations.has(key);
  }

  public isAuthenticityValidated(ref: string, candidateId: string): boolean {
    const key = `${candidateId.trim()}:${ref.trim()}`;
    return this.#authenticProducts.has(key);
  }

  public isWarrantyValidated(ref: string, sellerOrMfr: string): boolean {
    const key = `${sellerOrMfr.toLowerCase().trim()}:${ref.trim()}`;
    return this.#warranties.has(key);
  }

  /**
   * Empty server registry for unverified flows.
   * Requires zero signing secrets and contains zero verified claims.
   */
  public static createEmpty(): ServerAuthenticityRegistry {
    return new ServerAuthenticityRegistry(INTERNAL_AUTHENTICITY_REGISTRY_TOKEN, {
      verifiedAuthorizations: new Set(),
      verifiedAuthenticProducts: new Set(),
      verifiedWarranties: new Set(),
    });
  }

  /**
   * Trusted server-side factory to create a registry from verified attestations.
   * Strictly resolves secret key from server environment (fail-closed).
   * Does NOT accept caller-supplied secrets.
   */
  public static createServerVerified(
    attestations: readonly AuthenticityClaimAttestation[],
    verificationTime?: Date
  ): ServerAuthenticityRegistry {
    const serverSecret = getServerAuthenticitySecret();
    if (!serverSecret || serverSecret.length === 0) {
      throw new Error(
        "Cannot create ServerAuthenticityRegistry: Server authenticity secret is missing or not configured (fail-closed)."
      );
    }

    const authorizations = new Set<string>();
    const authenticProducts = new Set<string>();
    const warranties = new Set<string>();
    const now = verificationTime ?? new Date();

    for (const attestation of attestations) {
      if (!attestation.attestationSignature || typeof attestation.attestationSignature !== "string") {
        continue;
      }

      // Validate expiry if present
      if (attestation.expiresAt) {
        const expDate = new Date(attestation.expiresAt);
        if (isNaN(expDate.getTime()) || expDate.getTime() <= now.getTime()) {
          // Expired attestation cannot be enrolled
          continue;
        }
      }

      const expectedSig = computeClaimAttestationSignature(attestation, serverSecret);
      const sigBuf = Buffer.from(attestation.attestationSignature.trim(), "hex");
      const expBuf = Buffer.from(expectedSig, "hex");

      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
        const key = `${attestation.sellerOrCandidateId.toLowerCase().trim()}:${attestation.evidenceReference.trim()}`;
        if (attestation.claimType === "authorization") {
          authorizations.add(key);
        } else if (attestation.claimType === "authenticity") {
          authenticProducts.add(key);
        } else if (attestation.claimType === "warranty") {
          warranties.add(key);
        }
      }
    }

    return new ServerAuthenticityRegistry(INTERNAL_AUTHENTICITY_REGISTRY_TOKEN, {
      verifiedAuthorizations: authorizations,
      verifiedAuthenticProducts: authenticProducts,
      verifiedWarranties: warranties,
    });
  }
}

/**
 * Synthetic test helper to construct a test authenticity registry for unit testing
 * cryptographic signatures, tamper detection, and payload binding.
 * Explicitly isolated from production flows.
 */
export function createSyntheticAuthenticityRegistryForTesting(
  attestations: readonly AuthenticityClaimAttestation[],
  testSecret: string,
  verificationTime?: Date
): ServerAuthenticityRegistry {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Forbidden in production: createSyntheticAuthenticityRegistryForTesting cannot be called in production runtime."
    );
  }

  if (!testSecret || typeof testSecret !== "string" || testSecret.trim().length === 0) {
    throw new Error(
      "Missing required test secret: Cannot construct synthetic test authenticity registry without a non-empty test secret."
    );
  }

  const authorizations = new Set<string>();
  const authenticProducts = new Set<string>();
  const warranties = new Set<string>();
  const now = verificationTime ?? new Date();

  for (const attestation of attestations) {
    if (!attestation.attestationSignature || typeof attestation.attestationSignature !== "string") {
      continue;
    }

    if (attestation.expiresAt) {
      const expDate = new Date(attestation.expiresAt);
      if (isNaN(expDate.getTime()) || expDate.getTime() <= now.getTime()) {
        continue;
      }
    }

    const expectedSig = computeClaimAttestationSignature(attestation, testSecret);
    const sigBuf = Buffer.from(attestation.attestationSignature.trim(), "hex");
    const expBuf = Buffer.from(expectedSig, "hex");

    if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
      const key = `${attestation.sellerOrCandidateId.toLowerCase().trim()}:${attestation.evidenceReference.trim()}`;
      if (attestation.claimType === "authorization") {
        authorizations.add(key);
      } else if (attestation.claimType === "authenticity") {
        authenticProducts.add(key);
      } else if (attestation.claimType === "warranty") {
        warranties.add(key);
      }
    }
  }

  return new (ServerAuthenticityRegistry as unknown as new (
    token: unknown,
    p: unknown,
    opts?: { readonly isTestRegistry?: boolean }
  ) => ServerAuthenticityRegistry)(
    INTERNAL_AUTHENTICITY_REGISTRY_TOKEN,
    {
      verifiedAuthorizations: authorizations,
      verifiedAuthenticProducts: authenticProducts,
      verifiedWarranties: warranties,
    },
    { isTestRegistry: true }
  );
}

export type TrustedAuthenticityValidator = ServerAuthenticityRegistry;

/**
 * Converts a compatible candidate into a strongly typed LineItemCandidateAllocation.
 */
export function createCandidateAllocation(
  lineItem: ProcurementLineItem,
  candidate: NormalizedProductCandidate,
  trustedValidator?: unknown
): LineItemCandidateAllocation {
  const compat = checkCandidateCompatibility(lineItem, candidate);
  const sellerName = candidate.sellerName ?? candidate.merchantName;
  const isDirectRetailerSeller = candidate.isDirectRetailerSeller ?? (sellerName.toLowerCase().includes(candidate.merchantName.toLowerCase()));
  const isMarketplace = candidate.isMarketplace ?? !isDirectRetailerSeller;

  const snapshotInput = {
    availability: candidate.availability,
    currency: candidate.currency,
    externalId: candidate.externalId,
    merchantName: candidate.merchantName,
    merchantUrl: candidate.merchantUrl,
    quantity: lineItem.quantity,
    shippingCents: candidate.shippingCents,
    source: candidate.source,
    totalCents: (candidate.unitPriceCents * lineItem.quantity) + candidate.shippingCents,
    unitPriceCents: candidate.unitPriceCents,
  };

  const snapshotHash = resolveValidSnapshotHash(candidate.snapshotHash, snapshotInput);

  // Orthogonal authenticity evidence tracking - NEVER inferred from isDirectRetailerSeller!
  const rawAttrs = (candidate.rawAttributes ?? {}) as Record<string, unknown>;
  const candRecord = candidate as unknown as Record<string, unknown>;

  // 1. Manufacturer authorization: strictly parse boolean, require non-empty reference
  const rawAuthVal = candRecord.isManufacturerAuthorized ?? rawAttrs.isManufacturerAuthorized;
  const isManufacturerAuthorized = parseStrictBoolean(rawAuthVal);
  const rawAuthRef = (candRecord.authorizationEvidence as string | undefined) ?? (rawAttrs.authorizationEvidence as string | undefined) ?? null;
  const authorizationEvidence = typeof rawAuthRef === "string" && rawAuthRef.trim().length > 0 ? rawAuthRef.trim() : null;

  // 2. Product authenticity: strictly parse boolean, require non-empty reference
  const rawAuthenticVal = candRecord.isProductAuthenticVerified ?? rawAttrs.isProductAuthenticVerified;
  const isProductAuthenticVerified = parseStrictBoolean(rawAuthenticVal);
  const rawAuthenticRef = (candRecord.authenticityEvidence as string | undefined) ?? (rawAttrs.authenticityEvidence as string | undefined) ?? null;
  const authenticityEvidence = typeof rawAuthenticRef === "string" && rawAuthenticRef.trim().length > 0 ? rawAuthenticRef.trim() : null;

  // 3. Warranty coverage: strictly validated, require non-empty reference
  const rawWarrantyCov = (candRecord.warrantyCoverage as string | undefined) ?? (rawAttrs.warrantyCoverage as string | undefined) ?? "unverified";
  const validCoverages = ["full_manufacturer", "limited_merchant", "unverified", "none"] as const;
  type ValidCoverage = (typeof validCoverages)[number];
  const isCoverage = (val: string): val is ValidCoverage =>
    validCoverages.some((c) => c === val);
  const warrantyCoverage: ValidCoverage = isCoverage(rawWarrantyCov) ? rawWarrantyCov : "unverified";
  const rawWarrantyRef = (candRecord.warrantyEvidence as string | undefined) ?? (rawAttrs.warrantyEvidence as string | undefined) ?? null;
  const warrantyEvidence = typeof rawWarrantyRef === "string" && rawWarrantyRef.trim().length > 0 ? rawWarrantyRef.trim() : null;

  // 4. Evidence tier:
  // A non-empty evidence reference is not independently validated evidence.
  // Until a trusted evidence-validation mechanism exists, arbitrary references on candidate
  // attributes MUST NOT be classified as "verified_fact". Unsupported claims remain "merchant_claim" or "unknown".
  // Untrusted client input or arbitrary callback objects cannot supply or replace the server validator.
  const hasClaims =
    isDirectRetailerSeller ||
    isManufacturerAuthorized ||
    isProductAuthenticVerified ||
    warrantyCoverage !== "unverified" ||
    isMarketplace;

  let evidenceTier: EvidenceTier = "unknown";

  const isServerValidator = trustedValidator instanceof ServerAuthenticityRegistry;

  if (isServerValidator && authorizationEvidence && authenticityEvidence && warrantyEvidence) {
    const isAuthValid = trustedValidator.isAuthorizationValidated(authorizationEvidence, sellerName);
    const isAuthenticValid = trustedValidator.isAuthenticityValidated(authenticityEvidence, candidate.id || candidate.externalId);
    const isWarrantyValid = trustedValidator.isWarrantyValidated(warrantyEvidence, sellerName);
    if (
      isAuthValid &&
      isAuthenticValid &&
      isWarrantyValid &&
      isManufacturerAuthorized &&
      isProductAuthenticVerified &&
      warrantyCoverage === "full_manufacturer"
    ) {
      if (process.env.NODE_ENV === "production" && trustedValidator.isTestRegistry) {
        evidenceTier = "merchant_claim";
      } else {
        evidenceTier = "verified_fact";
      }
    } else if (hasClaims) {
      evidenceTier = "merchant_claim";
    }
  } else if (hasClaims) {
    evidenceTier = "merchant_claim";
  } else {
    evidenceTier = "unknown";
  }

  const authenticity: SellerAuthenticityEvidence = {
    sellerName,
    isDirectRetailerSeller,
    isMarketplace,
    isManufacturerAuthorized,
    authorizationEvidence,
    isProductAuthenticVerified,
    authenticityEvidence,
    warrantyCoverage,
    warrantyEvidence,
    evidenceTier,
  };

  return {
    lineItemId: lineItem.id,
    candidateId: candidate.id || candidate.externalId,
    externalId: candidate.externalId,
    title: candidate.title,
    merchantName: candidate.merchantName,
    merchantUrl: candidate.merchantUrl,
    unitPriceCents: candidate.unitPriceCents,
    quantity: lineItem.quantity,
    currency: candidate.currency,
    availability: candidate.availability,
    sellerName,
    isMarketplace,
    isDirectRetailerSeller,
    isWfsFulfilled: candidate.isWfsFulfilled === true,
    fulfillmentMethod: candidate.fulfillmentMethod ?? "standard_ground",
    requiresSpecialDelivery: candidate.requiresSpecialDelivery === true,
    rawAttributes: candidate.rawAttributes,
    snapshotHash,
    capturedAt: candidate.capturedAt instanceof Date
      ? candidate.capturedAt.toISOString()
      : (typeof candidate.capturedAt === "string" ? candidate.capturedAt : new Date().toISOString()),
    authenticity,
    matchedSpecs: compat.matchedSpecs,
    contradictorySpecs: compat.contradictorySpecs,
    missingSpecs: compat.missingSpecs,
    observationList: candidate.observationList,
    suitability: compat.suitability,
  };
}

export interface CandidateAllocationOptions {
  readonly allowSharedCandidatesAcrossIdenticalItems?: boolean;
  readonly authenticityRegistry?: ServerAuthenticityRegistry;
}

/**
 * Allocates candidates to line items deterministically while strictly preventing
 * accidental duplicate assignment of the same candidate to multiple distinct line items.
 */
export function allocateCandidatesToLineItems(
  lineItems: readonly ProcurementLineItem[],
  candidatePool: readonly NormalizedProductCandidate[],
  options: CandidateAllocationOptions = {}
): {
  readonly allocations: readonly LineItemCandidateAllocation[];
  readonly unallocatedLineItemIds: readonly string[];
  readonly duplicateRejections: readonly { lineItemId: string; candidateId: string; reason: string }[];
} {
  const allocations: LineItemCandidateAllocation[] = [];
  const unallocatedLineItemIds: string[] = [];
  const duplicateRejections: { lineItemId: string; candidateId: string; reason: string }[] = [];
  const assignedCandidateIds = new Set<string>();

  for (const lineItem of lineItems) {
    // If the line item explicitly requested a specific candidate ID:
    let chosenCandidate: NormalizedProductCandidate | undefined;

    if (lineItem.selectedCandidateId) {
      const explicit = candidatePool.find((c) => c.externalId === lineItem.selectedCandidateId);
      if (explicit) {
        const compat = checkCandidateCompatibility(lineItem, explicit);
        if (compat.compatible) {
          chosenCandidate = explicit;
        }
      }
    }

    // Otherwise, search candidate pool for best compatible candidate
    if (!chosenCandidate) {
      interface EligibleCandidate {
        readonly candidate: NormalizedProductCandidate;
        readonly compat: CandidateCompatibilityCheck;
      }
      const eligibleCandidates: EligibleCandidate[] = [];

      for (const cand of candidatePool) {
        // Enforce duplicate allocation guard:
        if (assignedCandidateIds.has(cand.externalId) && !options.allowSharedCandidatesAcrossIdenticalItems) {
          continue;
        }

        const compat = checkCandidateCompatibility(lineItem, cand);
        // Hard constraint: candidate MUST be compatible (no contradictions, within budget, strict specs verified)
        if (!compat.compatible) {
          continue;
        }

        eligibleCandidates.push({ candidate: cand, compat });
      }

      // Rank eligible candidates:
      // 1. Highest specification match score (product compatibility hard constraint)
      // 2. Hardware suitability tier: "compatible" (3) > "compatible_with_limitations" (2) > "insufficient_evidence" (1) > "unsuitable" (0)
      //    (Prevents an obsolete or unverified product from overriding a genuinely suitable modern product purely by price)
      // 3. In-stock availability preference
      // 4. Lowest unit price (price optimization strictly among equally suitable candidates)
      eligibleCandidates.sort((a, b) => {
        if (b.compat.score !== a.compat.score) {
          return b.compat.score - a.compat.score;
        }
        const tierRank = (t?: ProductSuitabilityTier) => {
          switch (t) {
            case "compatible": return 3;
            case "compatible_with_limitations": return 2;
            case "insufficient_evidence": return 1;
            case "unsuitable": return 0;
            default: return 2;
          }
        };
        const aRank = tierRank(a.compat.suitability?.tier);
        const bRank = tierRank(b.compat.suitability?.tier);
        if (bRank !== aRank) {
          return bRank - aRank;
        }
        const aStock = a.candidate.availability === "in_stock" ? 1 : 0;
        const bStock = b.candidate.availability === "in_stock" ? 1 : 0;
        if (bStock !== aStock) {
          return bStock - aStock;
        }
        return a.candidate.unitPriceCents - b.candidate.unitPriceCents;
      });

      if (eligibleCandidates.length > 0) {
        chosenCandidate = eligibleCandidates[0].candidate;
      }
    }

    if (chosenCandidate) {
      // Final duplicate check guard
      if (assignedCandidateIds.has(chosenCandidate.externalId) && !options.allowSharedCandidatesAcrossIdenticalItems) {
        duplicateRejections.push({
          lineItemId: lineItem.id,
          candidateId: chosenCandidate.externalId,
          reason: `Candidate "${chosenCandidate.externalId}" is already allocated to another line item and cannot be duplicated.`,
        });
        unallocatedLineItemIds.push(lineItem.id);
        continue;
      }

      assignedCandidateIds.add(chosenCandidate.externalId);
      allocations.push(createCandidateAllocation(lineItem, chosenCandidate, options.authenticityRegistry));
    } else {
      unallocatedLineItemIds.push(lineItem.id);
    }
  }

  return {
    allocations,
    unallocatedLineItemIds,
    duplicateRejections,
  };
}

/**
 * Line item input descriptor for proportional promotional discount allocation.
 */
export interface DiscountableLineItem {
  readonly lineItemId?: string;
  readonly itemIndex: number;
  readonly unitPriceCents: number | bigint;
  readonly quantity: number | bigint;
  readonly itemSubtotalCents?: bigint;
}

/**
 * Result for an individual line item's promotional discount allocation.
 */
export interface AllocatedLineItemDiscount {
  readonly itemIndex: number;
  readonly lineItemId?: string;
  readonly itemSubtotalCents: bigint;
  readonly allocatedDiscountCents: bigint;
  readonly taxableAmountCents: bigint;
}

/**
 * Comprehensive result of proportional discount allocation across a cart.
 */
export interface PromotionalDiscountAllocationResult {
  readonly merchandiseSubtotalCents: bigint;
  readonly requestedDiscountCents: bigint;
  readonly effectiveDiscountCents: bigint;
  readonly remainderCents: bigint;
  readonly items: readonly AllocatedLineItemDiscount[];
}

/**
 * Deterministic Proportional Discount Allocation Algorithm.
 * Implements Section 7.2 of Contract v2.0.11 (C-28).
 *
 * Enforces:
 * 1. Pre-discount merchandise subtotal calculation across items: sum(unitPrice * quantity).
 * 2. Excess discount capping: if D > merchandiseSubtotal, D_effective = merchandiseSubtotal.
 * 3. Zero-subtotal cart rejection: carts with subtotal = 0 throw ERR_AMOUNT_OUT_OF_BOUNDS (22003).
 * 4. Negative discount rejection: D < 0 throws ERR_AMOUNT_OUT_OF_BOUNDS (22003).
 * 5. Proportional integer floor allocation: floor(D_effective * itemSubtotal / merchandiseSubtotal).
 * 6. Deterministic 1-cent remainder distribution sorted by (itemSubtotal DESC, itemIndex ASC).
 * 7. Exact integer-cent conservation invariant: sum(allocatedDiscountCents) === D_effective.
 * 8. Zero floating-point arithmetic.
 */
const ZERO_BIGINT = BigInt(0);
const ONE_BIGINT = BigInt(1);

export function allocatePromotionalDiscounts(
  lineItems: readonly DiscountableLineItem[],
  totalDiscountCents: bigint | number
): PromotionalDiscountAllocationResult {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new AmountOutOfBoundsError("Cannot allocate promotional discounts to an empty line-item list.");
  }

  const requestedDiscountCents = typeof totalDiscountCents === "bigint" ? totalDiscountCents : BigInt(totalDiscountCents);
  if (requestedDiscountCents < ZERO_BIGINT) {
    throw new AmountOutOfBoundsError("Promotional discount cannot be negative.");
  }

  const seenIndices = new Set<number>();
  const parsedItems: {
    readonly originalIndex: number;
    readonly itemIndex: number;
    readonly lineItemId?: string;
    readonly unitPriceCents: bigint;
    readonly quantity: bigint;
    readonly itemSubtotalCents: bigint;
  }[] = [];

  let merchandiseSubtotalCents = ZERO_BIGINT;

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    if (typeof item.itemIndex !== "number" || !Number.isInteger(item.itemIndex) || item.itemIndex < 0) {
      throw new MalformedNestedStructureError(`Line item at index ${i} has invalid itemIndex: ${item.itemIndex}`);
    }
    if (seenIndices.has(item.itemIndex)) {
      throw new MalformedNestedStructureError(`Duplicate itemIndex ${item.itemIndex} detected in line-item list.`);
    }
    seenIndices.add(item.itemIndex);

    const unitPrice = typeof item.unitPriceCents === "bigint" ? item.unitPriceCents : BigInt(item.unitPriceCents);
    const qty = typeof item.quantity === "bigint" ? item.quantity : BigInt(item.quantity);

    if (unitPrice <= ZERO_BIGINT) {
      throw new AmountOutOfBoundsError(`Line item at index ${item.itemIndex} must have positive unitPriceCents, got ${unitPrice}`);
    }
    if (qty <= ZERO_BIGINT) {
      throw new AmountOutOfBoundsError(`Line item at index ${item.itemIndex} must have positive quantity, got ${qty}`);
    }

    const subtotal = item.itemSubtotalCents !== undefined
      ? (typeof item.itemSubtotalCents === "bigint" ? item.itemSubtotalCents : BigInt(item.itemSubtotalCents))
      : unitPrice * qty;

    if (subtotal !== unitPrice * qty) {
      throw new AmountOutOfBoundsError(
        `Line item at index ${item.itemIndex} subtotal mismatch: supplied ${subtotal}, expected ${unitPrice * qty}`
      );
    }

    merchandiseSubtotalCents += subtotal;
    parsedItems.push({
      originalIndex: i,
      itemIndex: item.itemIndex,
      lineItemId: item.lineItemId,
      unitPriceCents: unitPrice,
      quantity: qty,
      itemSubtotalCents: subtotal,
    });
  }

  // Zero-Subtotal Cart Rejection
  if (merchandiseSubtotalCents === ZERO_BIGINT) {
    throw new AmountOutOfBoundsError("Carts with zero merchandise subtotal cannot be allocated promotional discounts.");
  }

  // Excess Discount Capping: Net merchandise cannot be negative
  const effectiveDiscountCents = requestedDiscountCents > merchandiseSubtotalCents
    ? merchandiseSubtotalCents
    : requestedDiscountCents;

  // Proportional floor distribution: floor(D_effective * itemSubtotal / merchandiseSubtotal)
  const floorDiscounts = new Array<bigint>(parsedItems.length);
  let totalFloorAllocated = ZERO_BIGINT;

  for (let i = 0; i < parsedItems.length; i++) {
    const floorVal = (effectiveDiscountCents * parsedItems[i].itemSubtotalCents) / merchandiseSubtotalCents;
    floorDiscounts[i] = floorVal;
    totalFloorAllocated += floorVal;
  }

  const remainderCents = effectiveDiscountCents - totalFloorAllocated;

  // Deterministic tie-breaking sort: (itemSubtotal DESC, itemIndex ASC)
  const sortedItems = parsedItems
    .map((item, originalIndex) => ({
      originalIndex,
      itemIndex: item.itemIndex,
      itemSubtotalCents: item.itemSubtotalCents,
    }))
    .sort((a, b) => {
      if (b.itemSubtotalCents !== a.itemSubtotalCents) {
        return b.itemSubtotalCents > a.itemSubtotalCents ? 1 : -1;
      }
      return a.itemIndex - b.itemIndex;
    });

  // Distribute 1-cent remainders sequentially
  const allocatedDiscounts = [...floorDiscounts];
  let remainingCentsToDistribute = remainderCents;
  let sortPtr = 0;

  while (remainingCentsToDistribute > ZERO_BIGINT) {
    const target = sortedItems[sortPtr % sortedItems.length];
    allocatedDiscounts[target.originalIndex] += ONE_BIGINT;
    remainingCentsToDistribute -= ONE_BIGINT;
    sortPtr++;
  }

  // Verify exact integer conservation invariant: sum(allocated) === D_effective
  const totalAllocated = allocatedDiscounts.reduce((acc, curr) => acc + curr, ZERO_BIGINT);
  if (totalAllocated !== effectiveDiscountCents) {
    throw new ProviderTaxSumMismatchError(
      `Discount conservation invariant violated: sum(${totalAllocated}) !== effective(${effectiveDiscountCents})`
    );
  }

  const items: AllocatedLineItemDiscount[] = parsedItems.map((item, i) => {
    const itemDiscount = allocatedDiscounts[i];
    const taxableAmount = item.itemSubtotalCents - itemDiscount;
    return {
      itemIndex: item.itemIndex,
      lineItemId: item.lineItemId,
      itemSubtotalCents: item.itemSubtotalCents,
      allocatedDiscountCents: itemDiscount,
      taxableAmountCents: taxableAmount,
    };
  });

  return {
    merchandiseSubtotalCents,
    requestedDiscountCents,
    effectiveDiscountCents,
    remainderCents,
    items,
  };
}

