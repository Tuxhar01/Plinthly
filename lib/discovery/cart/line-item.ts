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
import { ProcurementLineItem, QuantityProvenanceSource, VerificationLevel } from "./types";
import { verifyQuantityConfirmation } from "../../workflow/quantity-confirmation";

export interface LineItemValidationError {
  readonly lineItemId?: string;
  readonly code:
    | "duplicate_line_item_id"
    | "invalid_quantity"
    | "unconfirmed_inferred_quantity"
    | "unauthorized_legacy_provenance"
    | "invalid_confirmation_token"
    | "confirmation_actor_mismatch"
    | "confirmation_quantity_mismatch"
    | "confirmation_draft_mismatch"
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

export interface ValidateProcurementLineItemsOptions {
  isLegacyCompatibilityPath?: boolean;
  workflowContext?: "ai_decomposed" | "legacy_direct" | "manual_direct" | "manual_multi_item";
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  draftHash?: string;
  actorId?: string;
}

/**
 * Validates a collection of procurement line items against strict Plinthly integrity constraints.
 */
export function validateProcurementLineItems(
  items: unknown,
  defaultCurrency: Currency = "USD",
  options?: ValidateProcurementLineItemsOptions
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
    const hasValidQuantity =
      typeof quantity === "number" &&
      Number.isInteger(quantity) &&
      !Number.isNaN(quantity) &&
      quantity >= 1;

    if (!hasValidQuantity) {
      errors.push({
        lineItemId: id,
        code: "invalid_quantity",
        message: `Line item "${id}" quantity must be a positive integer greater than or equal to 1, received: ${quantity}.`,
      });
    }

    // 3b. Quantity Provenance and Confirmation Safeguard:
    let quantitySource: QuantityProvenanceSource;
    let quantityConfirmed = false;
    let confirmedAt: string | null = null;
    let confirmedBy: string | null = null;
    const confirmationToken =
      typeof raw.confirmationToken === "string" && raw.confirmationToken.trim().length > 0
        ? raw.confirmationToken.trim()
        : undefined;
    const originalInferredQuantity: number | null =
      typeof raw.originalInferredQuantity === "number" ? raw.originalInferredQuantity : null;

    const isLegacyAuthorized = Boolean(
      options?.isLegacyCompatibilityPath || options?.workflowContext === "legacy_direct"
    );

    if (raw.quantitySource === "legacy_direct" && !isLegacyAuthorized) {
      errors.push({
        lineItemId: id,
        code: "unauthorized_legacy_provenance",
        message: `Line item "${id}" cannot specify internal provenance "legacy_direct".`,
      });
      quantitySource = "unresolved";
    } else if (isLegacyAuthorized) {
      quantitySource = raw.quantitySource ?? "legacy_direct";
      quantityConfirmed = true;
      confirmedAt = options?.confirmedAt ?? null;
      confirmedBy = options?.confirmedBy ?? null;
    } else if (raw.quantitySource === "explicit") {
      quantitySource = "explicit";
      quantityConfirmed = raw.quantityConfirmed !== false;
      confirmedAt = options?.confirmedAt ?? null;
      confirmedBy = options?.confirmedBy ?? null;
    } else if (
      raw.quantitySource === "inferred" ||
      raw.quantitySource === "unresolved" ||
      raw.quantitySource === "manual_override" ||
      options?.workflowContext === "ai_decomposed"
    ) {
      quantitySource =
        raw.quantitySource === "inferred" ||
        raw.quantitySource === "unresolved" ||
        raw.quantitySource === "manual_override"
          ? raw.quantitySource
          : "unresolved";

      if (!confirmationToken) {
        errors.push({
          lineItemId: id,
          code: "unconfirmed_inferred_quantity",
          message: `Line item "${id}" has an unconfirmed inferred quantity (${quantity}). Buyer confirmation is required before submission.`,
        });
      } else {
        const receipt = verifyQuantityConfirmation(confirmationToken);
        if (!receipt) {
          errors.push({
            lineItemId: id,
            code: "invalid_confirmation_token",
            message: `Line item "${id}" has an invalid or forged confirmation token.`,
          });
        } else if (receipt.lineItemId !== id) {
          errors.push({
            lineItemId: id,
            code: "invalid_confirmation_token",
            message: `Line item "${id}" confirmation token was issued for a different line item ("${receipt.lineItemId}").`,
          });
        } else if (receipt.confirmedQuantity !== quantity) {
          errors.push({
            lineItemId: id,
            code: "confirmation_quantity_mismatch",
            message: `Line item "${id}" quantity (${quantity}) does not match confirmed quantity (${receipt.confirmedQuantity}).`,
          });
        } else if (options?.actorId && receipt.actorId !== options.actorId) {
          errors.push({
            lineItemId: id,
            code: "confirmation_actor_mismatch",
            message: `Line item "${id}" confirmation was issued for actor "${receipt.actorId}", but current actor is "${options.actorId}".`,
          });
        } else if (options?.draftHash && receipt.draftHash !== options.draftHash) {
          errors.push({
            lineItemId: id,
            code: "confirmation_draft_mismatch",
            message: `Line item "${id}" confirmation token draft hash does not match current draft state.`,
          });
        } else {
          quantityConfirmed = true;
          confirmedAt = receipt.confirmedAt ?? null;
          confirmedBy = receipt.actorId;
        }
      }
    } else {
      // Direct programmatic caller providing explicit integer quantity
      if (raw.quantityConfirmed === false) {
        quantitySource = "unresolved";
        quantityConfirmed = false;
        if (hasValidQuantity) {
          errors.push({
            lineItemId: id,
            code: "unconfirmed_inferred_quantity",
            message: `Line item "${id}" has an unconfirmed quantity. Buyer confirmation is required before submission.`,
          });
        }
      } else {
        quantitySource = "explicit";
        quantityConfirmed = true;
        confirmedAt = options?.confirmedAt ?? null;
        confirmedBy = options?.confirmedBy ?? null;
      }
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
      quantitySource,
      quantityConfirmed,
      originalInferredQuantity,
      confirmationToken,
      confirmedAt,
      confirmedBy,
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
      quantitySource: "legacy_direct",
      quantityConfirmed: true,
      originalInferredQuantity: null,
      confirmedAt: new Date().toISOString(),
      confirmedBy: "legacy_system",
      budgetCents,
      currency,
      requirements: normRequirements,
      verificationLevel: "standard",
    },
  ];
}

