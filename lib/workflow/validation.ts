import { z } from "zod";
import { MAX_CENTS } from "../state/money";
import { Actor } from "../state/types";
import { destinationContextSchema, DestinationContext } from "../discovery/shipping";
export { destinationContextSchema };
export type { DestinationContext };

export const HEX_64_REGEX = /^[0-9a-f]{64}$/;

/**
 * Requirement spec schema: either a non-empty string or an object with key & expectedValue.
 */
export const requirementItemSchema = z.union([
  z.string().min(1, "Requirement key cannot be empty"),
  z.object({
    key: z.string().min(1, "Requirement key cannot be empty"),
    expectedValue: z.string().optional(),
    description: z.string().optional(),
  }),
]);

/**
 * Line item schema for multi-item procurement requests.
 */
export const procurementLineItemSchema = z.object({
  id: z.string().trim().min(1, "line item id cannot be empty"),
  title: z.string().trim().min(1, "title cannot be empty"),
  quantity: z.number().int().min(1, "quantity must be at least 1"),
  budgetCents: z.number().int().min(0).max(MAX_CENTS).optional(),
  currency: z.literal("USD").default("USD"),
  requirements: z.array(requirementItemSchema).optional().default([]),
  verificationLevel: z.enum(["strict", "standard", "flexible"]).optional().default("standard"),
  selectedCandidateId: z.string().nullable().optional(),
});

/**
 * Schema for POST /api/purchases
 */
export const createPurchaseSchema = z.object({
  budgetCents: z
    .number({ message: "budgetCents must be a number" })
    .int("budgetCents must be an integer")
    .positive("budgetCents must be greater than zero")
    .max(MAX_CENTS, `budgetCents exceeds maximum allowed (${MAX_CENTS})`),
  currency: z.literal("USD", {
    message: 'Only "USD" currency is supported',
  }),
  requirements: z
    .array(requirementItemSchema, { message: "requirements must be an array" })
    .default([]),
  lineItems: z.array(procurementLineItemSchema).min(1).optional(),
  requestedQuantity: z
    .number()
    .int()
    .min(1, "requestedQuantity must be at least 1")
    .optional()
    .default(1),
  destination: destinationContextSchema.optional(),
  confirmImmediately: z.boolean().optional().default(true),
  idempotencyKey: z
    .string()
    .min(1, "idempotencyKey cannot be empty")
    .max(128, "idempotencyKey cannot exceed 128 characters")
    .optional(),
}).refine(
  (data) => (data.requirements && data.requirements.length > 0) || (data.lineItems && data.lineItems.length > 0),
  { message: "Either requirements or lineItems must be provided", path: ["requirements"] }
);

/**
 * Schema for POST /api/purchases/[id]/evaluate
 */
export const evaluatePurchaseSchema = z.object({
  candidateId: z.string().optional(),
  rawCandidate: z.record(z.string(), z.unknown()).optional(),
  rawObservations: z
    .union([
      z.record(z.string(), z.unknown()),
      z.array(z.record(z.string(), z.unknown())),
    ])
    .optional(),
  requiredRuleKeys: z.array(z.string().min(1)).optional(),
  maxEvidenceAgeMs: z.number().int().positive().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

/**
 * Schema for POST /api/purchases/[id]/approve
 */
export const approvePurchaseSchema = z.object({
  expectedSnapshotHash: z
    .string()
    .regex(HEX_64_REGEX, "expectedSnapshotHash must be 64 lowercase hex characters")
    .optional(),
  expectedEvidenceFingerprint: z
    .string()
    .regex(HEX_64_REGEX, "expectedEvidenceFingerprint must be 64 lowercase hex characters")
    .optional(),
  expectedTotalCents: z
    .number()
    .int()
    .positive()
    .max(MAX_CENTS)
    .optional(),
  expectedCurrency: z.literal("USD").optional(),
  policyVersion: z.string().min(1).optional(),
  expectedVersion: z.number().int().positive().optional(),
  expectedDestination: destinationContextSchema.optional(),
});

/**
 * Schema for POST /api/purchases/[id]/paypal/create-order
 */
export const createPayPalOrderSchema = z.object({
  idempotencyKey: z
    .string()
    .min(1, "idempotencyKey cannot be empty")
    .max(128, "idempotencyKey cannot exceed 128 characters")
    .optional(),
  targetCartMerchantDomain: z.string().trim().optional(),
  destination: destinationContextSchema.optional(),
  intent: z.literal("AUTHORIZE", { message: 'Only intent "AUTHORIZE" is permitted.' }).optional(),
});

/**
 * Schema for POST /api/purchases/[id]/multi-item/plan
 */
export const createMultiItemPlanSchema = z.object({
  lineItems: z.array(procurementLineItemSchema).min(1, "At least one line item is required"),
  candidates: z.array(z.record(z.string(), z.unknown())).optional(),
  destination: destinationContextSchema.optional(),
  buyerMemberships: z.array(z.string().min(1)).optional(),
});

/**
 * Schema for POST /api/purchases/[id]/multi-item/approve
 */
export const approveMultiItemPlanSchema = z.object({
  strategyId: z.string().min(1, "strategyId is required"),
  expectedSnapshotHash: z.string().regex(HEX_64_REGEX, "expectedSnapshotHash must be 64 lowercase hex characters").optional(),
  expectedTotalLandedCostCents: z.number().int().positive().max(MAX_CENTS).optional(),
  expectedCurrency: z.literal("USD").optional(),
  destination: destinationContextSchema.optional(),
  candidates: z.array(z.record(z.string(), z.unknown())).optional(),
});

/**
 * Schema for POST /api/purchases/[id]/paypal/confirm-approval
 */
export const confirmBuyerApprovalSchema = z.object({
  paypalOrderId: z.string().min(1, "paypalOrderId cannot be empty").optional(),
});

/**
 * Schemas for Product Discovery (Channel3)
 */
export const searchConstraintsSchema = z.object({
  maxBudgetCents: z.number().int().positive().max(MAX_CENTS).optional(),
  currency: z.literal("USD").optional(),
  minQuantity: z.number().int().positive().optional(),
  requiredAttributes: z.array(z.string().min(1)).optional(),
  merchantAllowList: z.array(z.string().min(1)).optional(),
  destination: destinationContextSchema.optional(),
});

export const discoverProductsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "query cannot be empty")
    .max(500, "query exceeds maximum length of 500 characters"),
  purchaseId: z.string().trim().min(1, "purchaseId is required"),
  constraints: searchConstraintsSchema.optional(),
});

export const purchaseDiscoverSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "query cannot be empty")
    .max(500, "query exceeds maximum length of 500 characters"),
  constraints: searchConstraintsSchema.optional(),
});

/**
 * Parses and extracts the actor from request headers.
 * NOTE: In deployment mode, use ActorResolver (auth.ts) for secure server-side identity verification.
 */
export function extractActor(headers: Headers): Actor {
  const actorId = headers.get("x-actor-id")?.trim();
  const actorKind = headers.get("x-actor-kind")?.trim().toLowerCase();
  const component = headers.get("x-actor-component")?.trim();

  if (actorKind === "system") {
    return {
      kind: "system",
      component: component || actorId || "system_workflow_engine",
    };
  }

  return {
    kind: "user",
    userId: actorId || "local_dev_user",
  };
}
