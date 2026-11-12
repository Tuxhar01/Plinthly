/**
 * Plinthly Stage 2 Canonical Zod and TypeScript Parity Schemas.
 *
 * Implements Section 5.1, Section 7.1.1, Section 7.1.2, Section 7.1.3,
 * and Section 7.3 of Contract v2.0.11.
 *
 * Enforces strict bidirectional nested schema validation (C-48):
 * 1. Array and non-object element guards (ERR_MALFORMED_NESTED_STRUCTURE / 22023)
 * 2. Exact required-key set assertions (ERR_MISSING_PAYLOAD_FIELD / 22023)
 * 3. Unexpected-property whitelist guards (ERR_UNEXPECTED_PAYLOAD_FIELD / 22023)
 * 4. Property JSON typing assertions (ERR_INVALID_PROPERTY_TYPE / 22023)
 * 5. Strict non-nullability (ERR_NULL_PARAMETER / 22004)
 * 6. Preservation of explicitly optional nullable exemptionCode (exemption_code)
 */

import { z } from "zod";
import {
  CANONICAL_UNSIGNED_DECIMAL_REGEX,
  CANONICAL_SIGNED_DECIMAL_REGEX,
  CANONICAL_NEGATIVE_ZERO_REGEX,
} from "../state/money";
import {
  InvalidDecimalFormatError,
  AmountOutOfBoundsError,
  MissingPayloadFieldError,
  UnexpectedPayloadFieldError,
  MalformedNestedStructureError,
  InvalidPropertyTypeError,
  NullParameterError,
  UnsupportedAdjustmentError,
  ProviderTaxSumMismatchError,
} from "./stage2-errors";

// ============================================================================
// 1. Exact Key Whitelist & Type Validation Assertions (C-48)
// ============================================================================

export function assertValidJsonObject(val: unknown, contextName: string): Record<string, unknown> {
  if (val === null || val === undefined) {
    throw new NullParameterError(`${contextName} must not be null or undefined.`);
  }
  if (typeof val !== "object" || Array.isArray(val)) {
    throw new MalformedNestedStructureError(`${contextName} must be a non-null JSON object, got ${Array.isArray(val) ? "array" : typeof val}.`);
  }
  return val as Record<string, unknown>;
}

export function assertValidJsonArray(val: unknown, contextName: string): unknown[] {
  if (val === null || val === undefined) {
    throw new NullParameterError(`${contextName} array must not be null or undefined.`);
  }
  if (!Array.isArray(val)) {
    throw new MalformedNestedStructureError(`${contextName} must be a JSON array, got ${typeof val}.`);
  }
  return val;
}

export function assertExactKeySet(
  obj: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  contextName: string = "Object"
): void {
  const allowedSet = new Set<string>([...requiredKeys, ...optionalKeys]);
  const objKeys = Object.keys(obj);

  // 1. Missing required keys
  for (const reqKey of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, reqKey)) {
      throw new MissingPayloadFieldError(`${contextName} missing required field: "${reqKey}".`);
    }
  }

  // 2. Unexpected extraneous keys
  for (const actualKey of objKeys) {
    if (!allowedSet.has(actualKey)) {
      throw new UnexpectedPayloadFieldError(`${contextName} contains unexpected extraneous field: "${actualKey}".`);
    }
  }
}

// ============================================================================
// 2. Canonical Decimal String Schemas
// ============================================================================

export const canonicalDecimalStringZod = z
  .string({ message: "Monetary amount must be a decimal string." })
  .refine((val) => !CANONICAL_NEGATIVE_ZERO_REGEX.test(val), {
    message: "Negative zero is strictly prohibited in monetary inputs.",
  })
  .refine((val) => CANONICAL_UNSIGNED_DECIMAL_REGEX.test(val), {
    message: "String does not match canonical non-negative decimal regex: ^(0|[1-9][0-9]*)(\\.[0-9]{2})?$",
  });

export const canonicalSignedDecimalStringZod = z
  .string({ message: "Signed monetary amount must be a decimal string." })
  .refine((val) => !CANONICAL_NEGATIVE_ZERO_REGEX.test(val), {
    message: "Negative zero is strictly prohibited in monetary inputs.",
  })
  .refine((val) => CANONICAL_SIGNED_DECIMAL_REGEX.test(val), {
    message: "String does not match canonical signed decimal regex: ^-?(0|[1-9][0-9]*)(\\.[0-9]{2})?$",
  });

// ============================================================================
// 3. Raw Wire Schemas (Section 7.1.2 & 7.1.3 Wire Representation)
// ============================================================================

export const RAW_LINE_ITEM_REQUIRED_KEYS = [
  "id",
  "unit_price",
  "quantity",
  "subtotal",
  "discount_amount",
  "tax_amount",
] as const;

export const RAW_LINE_ITEM_OPTIONAL_KEYS = ["exemption_code"] as const;

export const rawLineItemWireZod = z
  .object({
    id: z.string().min(1, "id cannot be empty"),
    unit_price: canonicalDecimalStringZod,
    quantity: z.number().int().min(1, "quantity must be >= 1"),
    subtotal: canonicalDecimalStringZod,
    discount_amount: canonicalDecimalStringZod,
    tax_amount: canonicalDecimalStringZod,
    exemption_code: z.string().nullable().optional(),
  })
  .strict();

export type RawLineItemWire = z.infer<typeof rawLineItemWireZod>;

export const RAW_JURISDICTION_REQUIRED_KEYS = [
  "type",
  "code",
  "name",
  "rate_bps",
  "amount",
  "applies_to_shipping",
] as const;

export const rawJurisdictionWireZod = z
  .object({
    type: z.enum(["STATE", "COUNTY", "CITY", "SPECIAL"]),
    code: z.string().min(1, "code cannot be empty"),
    name: z.string().min(1, "name cannot be empty"),
    rate_bps: z.number().int().min(0, "rate_bps must be >= 0"),
    amount: canonicalDecimalStringZod,
    applies_to_shipping: z.boolean(),
  })
  .strict();

export type RawJurisdictionWire = z.infer<typeof rawJurisdictionWireZod>;

// ============================================================================
// 4. Normalized Parameter & Storage Schemas (Section 7.1.2 & 7.1.3 camelCase)
// ============================================================================

export const NORMALIZED_LINE_ITEM_REQUIRED_KEYS = [
  "itemIndex",
  "lineItemId",
  "itemSubtotalCents",
  "allocatedDiscountCents",
  "taxableAmountCents",
  "lineTaxCents",
  "taxabilityStatus",
] as const;

export const NORMALIZED_LINE_ITEM_OPTIONAL_KEYS = ["exemptionCode"] as const;

export const normalizedLineItemBreakdownZod = z
  .object({
    itemIndex: z.number().int().min(0, "itemIndex must be >= 0"),
    lineItemId: z.string().uuid("lineItemId must be a valid UUID"),
    itemSubtotalCents: z.number().int().min(1, "itemSubtotalCents must be > 0"),
    allocatedDiscountCents: z.number().int().min(0, "allocatedDiscountCents must be >= 0"),
    taxableAmountCents: z.number().int().min(0, "taxableAmountCents must be >= 0"),
    lineTaxCents: z.number().int().min(0, "lineTaxCents must be >= 0"),
    exemptionCode: z.string().nullable().optional(),
    taxabilityStatus: z.enum(["TAXABLE", "EXEMPT", "ZERO_RATED"]),
  })
  .strict()
  .refine(
    (item) => item.taxableAmountCents === item.itemSubtotalCents - item.allocatedDiscountCents,
    {
      message: "taxableAmountCents must equal itemSubtotalCents - allocatedDiscountCents",
    }
  )
  .refine(
    (item) => (item.taxabilityStatus === "EXEMPT" ? item.lineTaxCents === 0 : true),
    {
      message: "lineTaxCents must be 0 for EXEMPT line items",
    }
  );

export type NormalizedLineItemBreakdown = z.infer<typeof normalizedLineItemBreakdownZod>;

export const NORMALIZED_JURISDICTION_REQUIRED_KEYS = [
  "componentType",
  "jurisdictionCode",
  "jurisdictionName",
  "rateBps",
  "taxAmountCents",
  "appliesToShipping",
] as const;

export const normalizedJurisdictionBreakdownZod = z
  .object({
    componentType: z.enum(["STATE", "COUNTY", "CITY", "SPECIAL"]),
    jurisdictionCode: z.string().min(1, "jurisdictionCode cannot be empty"),
    jurisdictionName: z.string().min(1, "jurisdictionName cannot be empty"),
    rateBps: z.number().int().min(0, "rateBps must be >= 0"),
    taxAmountCents: z.number().int().min(0, "taxAmountCents must be >= 0"),
    appliesToShipping: z.boolean(),
  })
  .strict();

export type NormalizedJurisdictionBreakdown = z.infer<typeof normalizedJurisdictionBreakdownZod>;

// ============================================================================
// 5. C-48 Exact Deep Validation Helpers
// ============================================================================

export function validateRawLineItems(data: unknown): RawLineItemWire[] {
  const arr = assertValidJsonArray(data, "Raw line items");
  if (arr.length === 0) {
    throw new AmountOutOfBoundsError("Raw line items array cannot be empty.");
  }

  const results: RawLineItemWire[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rawObj = assertValidJsonObject(arr[i], `Raw line item at index ${i}`);
    assertExactKeySet(rawObj, RAW_LINE_ITEM_REQUIRED_KEYS, RAW_LINE_ITEM_OPTIONAL_KEYS, `Raw line item at index ${i}`);

    // Check non-nullable properties
    for (const key of RAW_LINE_ITEM_REQUIRED_KEYS) {
      if (rawObj[key] === null) {
        throw new NullParameterError(`Raw line item [${i}].${key} cannot be null.`);
      }
    }

    const parseResult = rawLineItemWireZod.safeParse(rawObj);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      if (issue.code === "invalid_type") {
        throw new InvalidPropertyTypeError(`Raw line item [${i}].${issue.path.join(".")}: ${issue.message}`);
      }
      throw new InvalidDecimalFormatError(`Raw line item [${i}].${issue.path.join(".")}: ${issue.message}`);
    }
    results.push(parseResult.data);
  }
  return results;
}

export function validateNormalizedLineItems(data: unknown): NormalizedLineItemBreakdown[] {
  const arr = assertValidJsonArray(data, "line_items_breakdown");
  if (arr.length === 0) {
    throw new AmountOutOfBoundsError("line_items_breakdown array cannot be empty.");
  }

  const seenIndices = new Set<number>();
  const results: NormalizedLineItemBreakdown[] = [];

  for (let i = 0; i < arr.length; i++) {
    const rawObj = assertValidJsonObject(arr[i], `Normalized line item at index ${i}`);
    assertExactKeySet(
      rawObj,
      NORMALIZED_LINE_ITEM_REQUIRED_KEYS,
      NORMALIZED_LINE_ITEM_OPTIONAL_KEYS,
      `Normalized line item at index ${i}`
    );

    // Check non-nullable properties
    for (const key of NORMALIZED_LINE_ITEM_REQUIRED_KEYS) {
      if (rawObj[key] === null) {
        throw new NullParameterError(`Normalized line item [${i}].${key} cannot be null.`);
      }
    }

    const parseResult = normalizedLineItemBreakdownZod.safeParse(rawObj);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      if (issue.code === "invalid_type") {
        throw new InvalidPropertyTypeError(`Normalized line item [${i}].${issue.path.join(".")}: ${issue.message}`);
      }
      throw new MalformedNestedStructureError(`Normalized line item [${i}].${issue.path.join(".")}: ${issue.message}`);
    }

    if (seenIndices.has(parseResult.data.itemIndex)) {
      throw new MalformedNestedStructureError(`Duplicate itemIndex ${parseResult.data.itemIndex} in line_items_breakdown.`);
    }
    seenIndices.add(parseResult.data.itemIndex);

    results.push(parseResult.data);
  }
  return results;
}

export function validateRawJurisdictions(data: unknown): RawJurisdictionWire[] {
  const arr = assertValidJsonArray(data, "Raw jurisdictions");
  if (arr.length === 0) {
    throw new AmountOutOfBoundsError("Raw jurisdictions array cannot be empty.");
  }

  const results: RawJurisdictionWire[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rawObj = assertValidJsonObject(arr[i], `Raw jurisdiction at index ${i}`);
    assertExactKeySet(rawObj, RAW_JURISDICTION_REQUIRED_KEYS, [], `Raw jurisdiction at index ${i}`);

    for (const key of RAW_JURISDICTION_REQUIRED_KEYS) {
      if (rawObj[key] === null) {
        throw new NullParameterError(`Raw jurisdiction [${i}].${key} cannot be null.`);
      }
    }

    const parseResult = rawJurisdictionWireZod.safeParse(rawObj);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      if (issue.code === "invalid_type") {
        throw new InvalidPropertyTypeError(`Raw jurisdiction [${i}].${issue.path.join(".")}: ${issue.message}`);
      }
      throw new InvalidDecimalFormatError(`Raw jurisdiction [${i}].${issue.path.join(".")}: ${issue.message}`);
    }
    results.push(parseResult.data);
  }
  return results;
}

export function validateNormalizedJurisdictions(data: unknown): NormalizedJurisdictionBreakdown[] {
  const arr = assertValidJsonArray(data, "jurisdiction_breakdown");
  if (arr.length === 0) {
    throw new AmountOutOfBoundsError("jurisdiction_breakdown array cannot be empty.");
  }

  const results: NormalizedJurisdictionBreakdown[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rawObj = assertValidJsonObject(arr[i], `Normalized jurisdiction at index ${i}`);
    assertExactKeySet(rawObj, NORMALIZED_JURISDICTION_REQUIRED_KEYS, [], `Normalized jurisdiction at index ${i}`);

    for (const key of NORMALIZED_JURISDICTION_REQUIRED_KEYS) {
      if (rawObj[key] === null) {
        throw new NullParameterError(`Normalized jurisdiction [${i}].${key} cannot be null.`);
      }
    }

    const parseResult = normalizedJurisdictionBreakdownZod.safeParse(rawObj);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      if (issue.code === "invalid_type") {
        throw new InvalidPropertyTypeError(`Normalized jurisdiction [${i}].${issue.path.join(".")}: ${issue.message}`);
      }
      throw new MalformedNestedStructureError(`Normalized jurisdiction [${i}].${issue.path.join(".")}: ${issue.message}`);
    }
    results.push(parseResult.data);
  }
  return results;
}

// ============================================================================
// 6. Tax Evidence Routine Parameters (R2-01 — 30 Canonical Fields)
// ============================================================================

export interface TaxEvidenceRecordRoutineParams {
  readonly cartId: string;
  readonly providerName: "TAXJAR" | "AVALARA" | "STRIPE_TAX";
  readonly taxQuoteId: string;
  readonly providerApiVersion: string;
  readonly signatureAlgorithm: "RSA-SHA256" | "ECDSA-P256";
  readonly providerTimestamp: string;
  readonly validUntil: string;
  readonly currency: "USD";
  readonly providerMerchandiseSubtotalCents: bigint;
  readonly providerDiscountCents: bigint;
  readonly providerShippingCents: bigint;
  readonly providerAdjustmentCents: bigint;
  readonly providerTotalCents: bigint;
  readonly totalTaxCents: bigint;
  readonly merchandiseTaxCents: bigint;
  readonly shippingTaxCents: bigint;
  readonly taxableShippingBaseCents: bigint;
  readonly jurisdictionCode: string;
  readonly lineItemsBreakdown: readonly NormalizedLineItemBreakdown[];
  readonly jurisdictionBreakdown: readonly NormalizedJurisdictionBreakdown[];
  readonly authorityId: string;
  readonly certificateNumber: string;
  readonly rawPayload: Buffer | Uint8Array;
  readonly statutoryPayloadHash: Buffer | Uint8Array;
  readonly statutorySignature: Buffer | Uint8Array;
  readonly verifierIdentity: string;
  readonly attestationKeyId: string;
  readonly attestationTimestamp: string;
  readonly verifierAttestationSignature: Buffer | Uint8Array;
  readonly nonce: string;
}

const ZERO_BIGINT = BigInt(0);

export function validateTaxEvidenceRoutineInvariants(
  params: TaxEvidenceRecordRoutineParams
): void {
  // C-42 / C-44B: provider_adjustment_cents must be strictly 0
  if (params.providerAdjustmentCents !== ZERO_BIGINT) {
    throw new UnsupportedAdjustmentError(
      `Non-zero provider adjustment (${params.providerAdjustmentCents}) is prohibited under Model A.`
    );
  }

  // Currency strictly USD
  if (params.currency !== "USD") {
    throw new ProviderTaxSumMismatchError(`Currency must be strictly USD, got ${params.currency}`);
  }

  // Jurisdiction code format: ^[A-Z]{2}(-[A-Z0-9]+)*$ (C-47)
  const JURISDICTION_CODE_REGEX = /^[A-Z]{2}(-[A-Z0-9]+)*$/;
  if (!JURISDICTION_CODE_REGEX.test(params.jurisdictionCode)) {
    throw new MalformedNestedStructureError(
      `jurisdictionCode "${params.jurisdictionCode}" does not match canonical pattern: ^[A-Z]{2}(-[A-Z0-9]+)*$`
    );
  }

  // Component-to-total equality (7.1.6 Invariant 1): merchTax + shipTax === totalTax
  if (params.merchandiseTaxCents + params.shippingTaxCents !== params.totalTaxCents) {
    throw new ProviderTaxSumMismatchError(
      `merchandiseTaxCents (${params.merchandiseTaxCents}) + shippingTaxCents (${params.shippingTaxCents}) !== totalTaxCents (${params.totalTaxCents})`
    );
  }

  // Provider landed invoice reconciliation (7.1.6 Invariant 2): subtotal - discount + shipping + tax === total
  const calculatedTotal =
    params.providerMerchandiseSubtotalCents -
    params.providerDiscountCents +
    params.providerShippingCents +
    params.totalTaxCents;

  if (calculatedTotal !== params.providerTotalCents) {
    throw new ProviderTaxSumMismatchError(
      `Calculated provider total (${calculatedTotal}) !== providerTotalCents (${params.providerTotalCents})`
    );
  }

  // Line items sum equality (7.1.6 Invariant 4): sum(lineTaxCents) === merchandiseTaxCents
  const sumLineTax = params.lineItemsBreakdown.reduce((acc, curr) => acc + BigInt(curr.lineTaxCents), ZERO_BIGINT);
  if (sumLineTax !== params.merchandiseTaxCents) {
    throw new ProviderTaxSumMismatchError(
      `Sum of lineTaxCents (${sumLineTax}) !== merchandiseTaxCents (${params.merchandiseTaxCents})`
    );
  }

  // Jurisdiction sum equality (7.1.6 Invariant 5): sum(taxAmountCents) === totalTaxCents
  const sumJurisdictionTax = params.jurisdictionBreakdown.reduce((acc, curr) => acc + BigInt(curr.taxAmountCents), ZERO_BIGINT);
  if (sumJurisdictionTax !== params.totalTaxCents) {
    throw new ProviderTaxSumMismatchError(
      `Sum of jurisdiction taxAmountCents (${sumJurisdictionTax}) !== totalTaxCents (${params.totalTaxCents})`
    );
  }

  // Taxable shipping base cannot exceed shipping amount
  if (params.taxableShippingBaseCents > params.providerShippingCents) {
    throw new ProviderTaxSumMismatchError(
      `taxableShippingBaseCents (${params.taxableShippingBaseCents}) exceeds providerShippingCents (${params.providerShippingCents})`
    );
  }
}
