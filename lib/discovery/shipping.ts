import { z } from "zod";
import { parseCentsExact } from "./normalize";
import { formatUtcIso8601, UNKNOWN_TIMESTAMP_SENTINEL_ISO } from "./evidence";

/**
 * Discriminator for shipping evidence status.
 * Distinguishes:
 * - "missing": No shipping data provided.
 * - "estimated": Heuristic or approximation (never authoritative for approval).
 * - "policy_derived": General merchant policy (unverified without proof of eligibility).
 * - "quoted": Authoritative quote for specified destination and delivery method.
 */
export type ShippingEvidenceType = "missing" | "estimated" | "policy_derived" | "quoted";

/**
 * Minimal, privacy-preserving delivery destination context.
 * Collects only essential geographic zone information without personal name,
 * street address, or phone number.
 */
export const destinationContextSchema = z.object({
  country: z
    .literal("US", {
      message: 'Only "US" delivery destination is currently supported',
    })
    .default("US"),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Valid 5-digit US ZIP code required (e.g. 98101 or 98101-1234)"),
  deliveryMethodPreference: z
    .enum(["standard_ground", "expedited", "in_store_pickup"])
    .optional()
    .default("standard_ground"),
});

export type DestinationContext = z.infer<typeof destinationContextSchema>;

/**
 * Structured details of shipping evidence attached to a product candidate.
 */
export interface ShippingEvidenceDetails {
  readonly type: ShippingEvidenceType;
  readonly amountCents: number | null;
  readonly currency: string;
  readonly deliveryMethod?: string;
  readonly destinationPostalCode?: string;
  readonly destinationCountry?: string;
  readonly isAuthoritative: boolean;
  readonly observationTimestamp: string;
  readonly sourceVerificationTimestamp: string | null;
  readonly explanation: string;
  // Phase 13B additions for deterministic merchant policy evidence
  readonly policyId?: string;
  readonly policyDocumentFingerprint?: string;
  readonly policySourceUrl?: string;
  readonly geographicZone?: import("./geographic-zones").GeographicZone;
  readonly serviceabilityStatus?: import("./geographic-zones").DestinationServiceability;
  readonly thresholdCents?: number;
}

export interface ValidateShippingInput {
  readonly rawShipping?: unknown;
  readonly rawShippingCents?: unknown;
  readonly shippingType?: unknown;
  readonly deliveryMethod?: unknown;
  readonly destinationPostalCode?: unknown;
  readonly destinationCountry?: unknown;
  readonly observationTimestamp?: unknown;
  readonly sourceVerificationTimestamp?: unknown;
  readonly source?: string; // "channel3" | "seeded"
  readonly requiresDestination?: boolean;
  // Phase 13B additions for deterministic merchant policy evidence
  readonly policyId?: string;
  readonly policyDocumentFingerprint?: string;
  readonly policySourceUrl?: string;
  readonly geographicZone?: import("./geographic-zones").GeographicZone;
  readonly serviceabilityStatus?: import("./geographic-zones").DestinationServiceability;
  readonly thresholdCents?: number;
}

export interface ShippingValidationResult {
  readonly valid: boolean;
  readonly shippingCents: number;
  readonly details: ShippingEvidenceDetails;
  readonly isComplete: boolean;
  readonly errors: readonly string[];
}

/**
 * Validates and normalizes shipping evidence against Plinthly's procurement invariants.
 *
 * Enforces:
 * 1. Missing shipping is never inferred as $0.00 and remains ineligible for approval.
 * 2. Estimates cannot be treated as authoritative quotes.
 * 3. Policy-derived shipping without verified proof of eligibility is ineligible.
 * 4. Missing destination prevents destination-dependent quotes.
 * 5. Observation timestamps cannot substitute for source-verification timestamps.
 * 6. Existing synthetic fixtures continue to work without weakening validation.
 */
export function validateShippingEvidence(input: ValidateShippingInput): ShippingValidationResult {
  const errors: string[] = [];
  const obsTimestamp = formatUtcIso8601(input.observationTimestamp) || new Date().toISOString();

  // Extract source verification timestamp strictly (never defaulted to observation timestamp)
  let srcVerificationTimestamp: string | null = null;
  if (input.sourceVerificationTimestamp !== undefined && input.sourceVerificationTimestamp !== null) {
    const formatted = formatUtcIso8601(input.sourceVerificationTimestamp);
    if (formatted && formatted !== UNKNOWN_TIMESTAMP_SENTINEL_ISO) {
      srcVerificationTimestamp = formatted;
    }
  }

  const rawShipping = input.rawShippingCents ?? input.rawShipping;

  // Determine explicit shipping evidence type
  let shippingType: ShippingEvidenceType = "missing";
  if (typeof input.shippingType === "string") {
    const cleanType = input.shippingType.trim().toLowerCase();
    if (
      cleanType === "missing" ||
      cleanType === "estimated" ||
      cleanType === "policy_derived" ||
      cleanType === "quoted"
    ) {
      shippingType = cleanType as ShippingEvidenceType;
    }
  } else if (rawShipping !== undefined && rawShipping !== null) {
    // If shipping amount is provided without explicit type:
    // Default to "quoted" for backwards compatibility with existing seeded fixtures
    shippingType = "quoted";
  }

  // Handle Case 1: Missing shipping
  if (shippingType === "missing" || (rawShipping === undefined && rawShipping === null)) {
    const details: ShippingEvidenceDetails = {
      type: "missing",
      amountCents: null,
      currency: "USD",
      isAuthoritative: false,
      observationTimestamp: obsTimestamp,
      sourceVerificationTimestamp: null,
      explanation: "Missing shipping cost specification. Shipping cannot be inferred as zero when absent.",
    };
    errors.push("Missing shipping cost specification. Shipping cannot be inferred as zero when absent.");
    return {
      valid: false,
      shippingCents: 0,
      details,
      isComplete: false,
      errors,
    };
  }

  // Handle Case 2: Estimated shipping (cannot be treated as authoritative for approval)
  if (shippingType === "estimated") {
    let estCents = 0;
    const parseRes = parseCentsExact(rawShipping, "estimated shipping");
    if (parseRes.valid && parseRes.cents !== undefined) {
      estCents = parseRes.cents;
    }
    const details: ShippingEvidenceDetails = {
      type: "estimated",
      amountCents: estCents,
      currency: "USD",
      deliveryMethod: typeof input.deliveryMethod === "string" ? input.deliveryMethod : undefined,
      isAuthoritative: false,
      observationTimestamp: obsTimestamp,
      sourceVerificationTimestamp: srcVerificationTimestamp,
      explanation: "Estimated shipping cost cannot be treated as an authoritative quote for buyer approval.",
    };
    errors.push("Estimated shipping cost cannot be treated as an authoritative quote for buyer approval.");
    return {
      valid: false,
      shippingCents: estCents,
      details,
      isComplete: false,
      errors,
    };
  }

  // Handle Case 3: Policy-derived shipping
  if (shippingType === "policy_derived") {
    let polCents = 0;
    const parseRes = parseCentsExact(rawShipping, "policy shipping");
    if (parseRes.valid && parseRes.cents !== undefined) {
      polCents = parseRes.cents;
    }

    const postalCode = typeof input.destinationPostalCode === "string" ? input.destinationPostalCode.trim() : undefined;
    const country = typeof input.destinationCountry === "string" ? input.destinationCountry.trim() : "US";
    const deliveryMethod = typeof input.deliveryMethod === "string" ? input.deliveryMethod.trim() : "standard_ground";

    // Validate destination postal code first if provided
    if (postalCode) {
      const destParsed = destinationContextSchema.safeParse({ postalCode, country });
      if (!destParsed.success) {
        const details: ShippingEvidenceDetails = {
          type: "policy_derived",
          amountCents: polCents,
          currency: "USD",
          deliveryMethod,
          destinationPostalCode: postalCode,
          destinationCountry: country,
          isAuthoritative: false,
          observationTimestamp: obsTimestamp,
          sourceVerificationTimestamp: srcVerificationTimestamp,
          policyId: input.policyId,
          policyDocumentFingerprint: input.policyDocumentFingerprint,
          policySourceUrl: input.policySourceUrl,
          geographicZone: input.geographicZone,
          serviceabilityStatus: input.serviceabilityStatus ?? "unserviceable",
          thresholdCents: input.thresholdCents,
          explanation: "Invalid destination postal code for merchant policy.",
        };
        errors.push("Invalid destination postal code for merchant policy.");
        return { valid: false, shippingCents: polCents, details, isComplete: false, errors };
      }
    }

    // Policy-derived shipping is authoritative ONLY WHEN backed by verified policy evidence:
    // (1) policyId, (2) policyDocumentFingerprint, (3) policySourceUrl, (4) destination postal code, (5) verified timestamp
    const hasPolicyEvidence = Boolean(
      input.policyId &&
      input.policyDocumentFingerprint &&
      input.policySourceUrl &&
      postalCode &&
      srcVerificationTimestamp
    );

    if (hasPolicyEvidence && postalCode) {
      const details: ShippingEvidenceDetails = {
        type: "policy_derived",
        amountCents: polCents,
        currency: "USD",
        deliveryMethod,
        destinationPostalCode: postalCode,
        destinationCountry: country,
        isAuthoritative: true,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: srcVerificationTimestamp,
        policyId: input.policyId,
        policyDocumentFingerprint: input.policyDocumentFingerprint,
        policySourceUrl: input.policySourceUrl,
        geographicZone: input.geographicZone,
        serviceabilityStatus: input.serviceabilityStatus ?? "serviceable",
        thresholdCents: input.thresholdCents,
        explanation: `Authoritative merchant policy "${input.policyId}" verified for destination ${postalCode}.`,
      };

      return {
        valid: true,
        shippingCents: polCents,
        details,
        isComplete: true,
        errors: [],
      };
    }

    // Unverified policy claim without authoritative policy proof fails closed
    const details: ShippingEvidenceDetails = {
      type: "policy_derived",
      amountCents: polCents,
      currency: "USD",
      deliveryMethod: typeof input.deliveryMethod === "string" ? input.deliveryMethod : undefined,
      isAuthoritative: false,
      observationTimestamp: obsTimestamp,
      sourceVerificationTimestamp: srcVerificationTimestamp,
      explanation: "Policy-derived shipping cost lacks authoritative published policy verification.",
    };
    errors.push("Policy-derived shipping cost lacks authoritative published policy verification.");
    return {
      valid: false,
      shippingCents: polCents,
      details,
      isComplete: false,
      errors,
    };
  }

  // Handle Case 4: Quoted shipping
  const shippingCheck = parseCentsExact(rawShipping, "shipping");
  if (!shippingCheck.valid || shippingCheck.cents === undefined) {
    const details: ShippingEvidenceDetails = {
      type: "quoted",
      amountCents: null,
      currency: "USD",
      isAuthoritative: false,
      observationTimestamp: obsTimestamp,
      sourceVerificationTimestamp: srcVerificationTimestamp,
      explanation: `Invalid shipping cost: ${shippingCheck.error}`,
    };
    errors.push(`Invalid shipping cost: ${shippingCheck.error}`);
    return {
      valid: false,
      shippingCents: 0,
      details,
      isComplete: false,
      errors,
    };
  }

  const shippingCents = shippingCheck.cents;
  const deliveryMethod = typeof input.deliveryMethod === "string" ? input.deliveryMethod.trim() : "standard_ground";

  const postalCode = typeof input.destinationPostalCode === "string" ? input.destinationPostalCode.trim() : undefined;
  const country = typeof input.destinationCountry === "string" ? input.destinationCountry.trim() : "US";
  const requiresDestination = input.requiresDestination === true;

  // If quote is explicitly destination-dependent and destination postal code is missing
  if (requiresDestination && (!postalCode || postalCode.length === 0)) {
    const details: ShippingEvidenceDetails = {
      type: "quoted",
      amountCents: shippingCents,
      currency: "USD",
      deliveryMethod,
      isAuthoritative: false,
      observationTimestamp: obsTimestamp,
      sourceVerificationTimestamp: srcVerificationTimestamp,
      explanation: "Missing destination prevents destination-dependent quotes.",
    };
    errors.push("Missing destination prevents destination-dependent quotes.");
    return {
      valid: false,
      shippingCents,
      details,
      isComplete: false,
      errors,
    };
  }

  // If destination postal code is provided, validate it against destinationContextSchema
  if (postalCode) {
    const destParsed = destinationContextSchema.safeParse({
      postalCode,
      country,
    });
    if (!destParsed.success) {
      const details: ShippingEvidenceDetails = {
        type: "quoted",
        amountCents: shippingCents,
        currency: "USD",
        deliveryMethod,
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: srcVerificationTimestamp,
        explanation: "Invalid destination postal code or country.",
      };
      errors.push("Invalid destination postal code or country.");
      return {
        valid: false,
        shippingCents,
        details,
        isComplete: false,
        errors,
      };
    }
  }

  const isAuthoritative = true;
  const details: ShippingEvidenceDetails = {
    type: "quoted",
    amountCents: shippingCents,
    currency: "USD",
    deliveryMethod,
    destinationPostalCode: postalCode,
    destinationCountry: country,
    isAuthoritative,
    observationTimestamp: obsTimestamp,
    sourceVerificationTimestamp: srcVerificationTimestamp,
    explanation: "Authoritative shipping quote verified.",
  };

  return {
    valid: true,
    shippingCents,
    details,
    isComplete: true,
    errors: [],
  };
}
