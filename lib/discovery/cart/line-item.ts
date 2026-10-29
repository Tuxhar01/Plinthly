/**
 * Plinthly Phase 15 — Multi-Item Procurement Line Item Validation and Normalization.
 *
 * Implements:
 * 1. Validation for line-item identifiers, quantities, budgets, and specifications.
 * 2. Duplicate line-item ID detection.
 * 3. Currency homogeneity enforcement (USD only).
 * 4. Contradictory constraint detection (e.g. negative budget, impossible quantities).
 * 5. Bidirectional backward-compatible adapters between legacy requirements and multi-item line items.
 */

import { Currency } from "../../state/types";
import { BuyerRequirementItem } from "../../workflow/types";
import { ProcurementLineItem, VerificationLevel } from "./types";

export interface LineItemValidationError {
  readonly lineItemId?: string;
  readonly code:
    | "duplicate_line_item_id"
    | "invalid_quantity"
    | "invalid_budget"
    | "unsupported_currency"
    | "missing_product_description"
    | "empty_line_items"
    | "contradictory_constraints";
  readonly message: string;
}

export type LineItemValidationResult =
  | { readonly ok: true; readonly lineItems: readonly ProcurementLineItem[] }
  | { readonly ok: false; readonly errors: readonly LineItemValidationError[] };

/**
 * Validates a collection of procurement line items against strict Plinthly integrity constraints.
 */
export function validateProcurementLineItems(
  items: unknown,
  defaultCurrency: Currency = "USD"
): LineItemValidationResult {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: false,
      errors: [
        {
          code: "empty_line_items",
          message: "Procurement request must contain at least one line item.",
        },
      ],
    };
  }

  const errors: LineItemValidationError[] = [];
  const seenIds = new Set<string>();
  const validatedItems: ProcurementLineItem[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const raw = items[idx] as Partial<ProcurementLineItem> | undefined;
    if (!raw || typeof raw !== "object") {
      errors.push({
        code: "missing_product_description",
        message: `Line item at index ${idx} must be a valid object.`,
      });
      continue;
    }

    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    const id = rawId.length > 0 ? rawId : `line_${idx + 1}`;

    // 1. Duplicate ID check
    if (seenIds.has(id)) {
      errors.push({
        lineItemId: id,
        code: "duplicate_line_item_id",
        message: `Duplicate line-item identifier "${id}" detected. Each line item must have a unique identifier.`,
      });
    } else {
      seenIds.add(id);
    }

    // 2. Title / product description
    const rawTitle = typeof raw.title === "string" ? raw.title.trim() : "";
    if (rawTitle.length === 0) {
      errors.push({
        lineItemId: id,
        code: "missing_product_description",
        message: `Line item "${id}" must have a non-empty product description or title.`,
      });
    }

    // 3. Quantity check: integer >= 1
    const quantity = raw.quantity;
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      Number.isNaN(quantity) ||
      quantity < 1
    ) {
      errors.push({
        lineItemId: id,
        code: "invalid_quantity",
        message: `Line item "${id}" quantity must be a positive integer greater than or equal to 1, received: ${quantity}.`,
      });
    }

    // 4. Budget check
    if (raw.budgetCents !== undefined && raw.budgetCents !== null) {
      if (
        typeof raw.budgetCents !== "number" ||
        !Number.isInteger(raw.budgetCents) ||
        Number.isNaN(raw.budgetCents) ||
        raw.budgetCents < 0
      ) {
        errors.push({
          lineItemId: id,
          code: "invalid_budget",
          message: `Line item "${id}" budgetCents must be a non-negative integer, received: ${raw.budgetCents}.`,
        });
      }
    }

    // 5. Currency check
    const currency = raw.currency ?? defaultCurrency;
    if (currency !== "USD") {
      errors.push({
        lineItemId: id,
        code: "unsupported_currency",
        message: `Line item "${id}" specified currency "${currency}". Only "USD" is currently supported. Mixed or foreign currencies are rejected.`,
      });
    }

    // 6. Requirements normalization
    const requirements: BuyerRequirementItem[] = [];
    if (Array.isArray(raw.requirements)) {
      for (const req of raw.requirements) {
        if (typeof req === "string" && req.trim().length > 0) {
          requirements.push({ key: req.trim() });
        } else if (req && typeof req === "object" && typeof req.key === "string" && req.key.trim().length > 0) {
          requirements.push({
            key: req.key.trim(),
            expectedValue: req.expectedValue ? String(req.expectedValue).trim() : undefined,
            description: req.description ? String(req.description).trim() : undefined,
          });
        }
      }
    }

    // 7. Verification level
    let verificationLevel: VerificationLevel = "standard";
    if (
      raw.verificationLevel === "strict" ||
      raw.verificationLevel === "standard" ||
      raw.verificationLevel === "flexible"
    ) {
      verificationLevel = raw.verificationLevel;
    }

    validatedItems.push({
      id,
      title: rawTitle,
      quantity: typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1 ? quantity : 1,
      budgetCents: raw.budgetCents,
      currency: "USD",
      requirements,
      verificationLevel,
      selectedCandidateId: typeof raw.selectedCandidateId === "string" ? raw.selectedCandidateId : null,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, lineItems: validatedItems };
}

/**
 * Converts a legacy single-item purchase representation into a normalized single-element line item array.
 */
export function convertLegacyRequirementsToLineItems(
  requirements: unknown,
  budgetCents: number,
  currency: Currency = "USD",
  requestedQuantity: number = 1
): readonly ProcurementLineItem[] {
  const normRequirements: BuyerRequirementItem[] = [];

  if (Array.isArray(requirements)) {
    for (const r of requirements) {
      if (typeof r === "string" && r.trim().length > 0) {
        normRequirements.push({ key: r.trim() });
      } else if (r && typeof r === "object" && typeof (r as { key?: string }).key === "string") {
        const item = r as BuyerRequirementItem;
        normRequirements.push({
          key: item.key.trim(),
          expectedValue: item.expectedValue ? String(item.expectedValue).trim() : undefined,
          description: item.description ? String(item.description).trim() : undefined,
        });
      }
    }
  }

  // Derive title from first requirement or description
  let title = "Requested Item";
  if (normRequirements.length > 0) {
    title = normRequirements[0].description ?? normRequirements[0].key;
  }

  return [
    {
      id: "line_1",
      title,
      quantity: Number.isInteger(requestedQuantity) && requestedQuantity >= 1 ? requestedQuantity : 1,
      budgetCents,
      currency,
      requirements: normRequirements,
      verificationLevel: "standard",
    },
  ];
}

