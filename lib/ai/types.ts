import { z } from "zod";
import { MAX_CENTS } from "../state/money";

/**
 * Maximum character length for natural language purchase request prompts.
 * Bounding input length prevents prompt stuffing and resource exhaustion.
 */
export const MAX_PROMPT_LENGTH = 2000;
export const MIN_PROMPT_LENGTH = 3;

/**
 * Request payload schema for decomposing natural-language intent.
 */
export const decomposeRequestSchema = z.object({
  prompt: z
    .string({ message: "Prompt must be a string." })
    .trim()
    .min(MIN_PROMPT_LENGTH, `Prompt must be at least ${MIN_PROMPT_LENGTH} characters.`)
    .max(MAX_PROMPT_LENGTH, `Prompt cannot exceed ${MAX_PROMPT_LENGTH} characters.`),
});

export type DecomposeRequest = z.infer<typeof decomposeRequestSchema>;

/**
 * Single requirement extracted from natural language.
 */
export const decomposedRequirementSchema = z.object({
  key: z.string().min(1, "Requirement key cannot be empty."),
  expectedValue: z.string().optional(),
  description: z.string().optional(),
});

export type DecomposedRequirement = z.infer<typeof decomposedRequirementSchema>;

/**
 * Minimal destination context extracted from natural language.
 */
export const decomposedDestinationSchema = z.object({
  country: z.literal("US").default("US"),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Valid 5-digit US ZIP code required"),
});

export type DecomposedDestination = z.infer<typeof decomposedDestinationSchema>;

/**
 * Confidence indicator schema.
 * Enforces explicit non-calibrated heuristic identification.
 */
export const confidenceEstimateSchema = z.object({
  score: z.number().min(0).max(1),
  label: z.enum(["low", "medium", "high"]),
  notes: z.string(),
  isCalibratedProbability: z.literal(false),
});

export type ConfidenceEstimate = z.infer<typeof confidenceEstimateSchema>;

/**
 * Schema for structured draft requirements extracted from natural language.
 *
 * Invariants:
 * - budgetCents is integer cents or null if unspecified.
 * - currency is "USD" or null if unspecified.
 * - quantity is integer >= 1 when explicitly numbered, or null if unspecified / generic singular.
 * - productKeywords is non-empty string.
 * - requirements contains extracted requirement keys, expected values and descriptions.
 * - unresolvedAmbiguities lists missing info, questions, or contradictions.
 * - confidenceEstimate is strictly identified as a model estimate, never a calibrated probability.
 *
 * Quantity Semantics:
 * - Explicit numerical count stated (e.g. "2 laptops", "quantity: 3", "1 laptop"): extracted as integer.
 * - Generic phrasing without explicit numerical count (e.g. "a laptop", "an office chair", "laptops"):
 *   extracted as null, and recorded under unresolvedAmbiguities for buyer confirmation in Stage 1 UI.
 */
export const decomposedIntentSchema = z.object({
  budgetCents: z
    .preprocess(
      (val) => (val === undefined || val === 0 || (typeof val === "number" && val <= 0) ? null : val),
      z
        .number()
        .int("Budget cents must be an integer.")
        .positive("Budget cents must be positive.")
        .max(MAX_CENTS, `Budget cents cannot exceed ${MAX_CENTS}.`)
        .nullable()
    ),
  currency: z
    .preprocess(
      (val) => (val === "USD" ? "USD" : null),
      z.literal("USD").nullable()
    ),
  quantity: z
    .preprocess(
      (val) => (val === undefined || (typeof val === "number" && val <= 0) ? null : val),
      z
        .number()
        .int("Quantity must be an integer.")
        .positive("Quantity must be positive.")
        .nullable()
    ),
  productKeywords: z.string().min(1, "Product keywords cannot be empty."),
  destination: decomposedDestinationSchema.nullable().optional(),
  requirements: z.array(decomposedRequirementSchema),
  unresolvedAmbiguities: z.array(z.string()),
  confidenceEstimate: confidenceEstimateSchema,
});

export type DecomposedIntent = z.infer<typeof decomposedIntentSchema>;
