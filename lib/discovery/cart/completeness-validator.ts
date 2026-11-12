/**
 * Plinthly Phase 15 & Action 3 — Centralized Strategy Completeness & Integrity Validator.
 *
 * Enforces Strategy-Level Invariants:
 * 1. All requested line-item IDs must be represented in allocations.
 * 2. Allocated quantities must match requested quantities exactly (no partial or excess quantities).
 * 3. No duplicate or unintended candidate allocations exist across distinct line items.
 * 4. All allocated candidates satisfy mandatory specification & category compatibility constraints.
 * 5. Every shipment and retailer cart maps back cleanly to the original requested line items.
 * 6. Total cost reconciles exactly with allocated item costs, shipping, discounts, and defensible tax evidence.
 *
 * ACCEPTANCE INVARIANT:
 * No strategy can receive "feasible" status or Tier 1/2 ranking unless it completely satisfies
 * every mandatory requested line item and quantity.
 */

import {
  ProcurementLineItem,
  ProcurementStrategy,
  LineItemCandidateAllocation,
  StrategyFeasibility,
  StrategyTier,
} from "./types";
import { checkCandidateCompatibility } from "./allocation";
import { NormalizedProductCandidate } from "../types";

export interface CompletenessValidationOptions {
  readonly allowSharedCandidatesAcrossIdenticalItems?: boolean;
}

export interface LineItemQuantityDiscrepancy {
  readonly lineItemId: string;
  readonly lineItemTitle: string;
  readonly requestedQuantity: number;
  readonly allocatedQuantity: number;
  readonly status: "missing" | "partial" | "excess";
}

export interface IncompatibleAllocationDetail {
  readonly lineItemId: string;
  readonly candidateId: string;
  readonly candidateTitle: string;
  readonly reason: string;
}

export interface UnmappedShipmentItemDetail {
  readonly merchantName: string;
  readonly shipmentIndex: number;
  readonly lineItemId: string;
  readonly reason: string;
}

export interface DuplicateAllocationDetail {
  readonly candidateId: string;
  readonly lineItemIds: readonly string[];
  readonly occurrences: number;
}

export interface StrategyCompletenessReport {
  readonly isComplete: boolean;
  readonly strategyId: string;
  readonly strategyName: string;
  readonly missingLineItemIds: readonly string[];
  readonly quantityDiscrepancies: readonly LineItemQuantityDiscrepancy[];
  readonly duplicateAllocations: readonly DuplicateAllocationDetail[];
  readonly incompatibleAllocations: readonly IncompatibleAllocationDetail[];
  readonly unmappedShipmentItems: readonly UnmappedShipmentItemDetail[];
  readonly costReconciliationErrors: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Centrally validates the completeness and integrity of a ProcurementStrategy against
 * the requested ProcurementLineItems.
 */
export function validateStrategyCompleteness(
  strategy: ProcurementStrategy,
  requestedLineItems: readonly ProcurementLineItem[],
  options: CompletenessValidationOptions = {}
): StrategyCompletenessReport {
  const missingLineItemIds: string[] = [];
  const quantityDiscrepancies: LineItemQuantityDiscrepancy[] = [];
  const duplicateAllocations: DuplicateAllocationDetail[] = [];
  const incompatibleAllocations: IncompatibleAllocationDetail[] = [];
  const unmappedShipmentItems: UnmappedShipmentItemDetail[] = [];
  const costReconciliationErrors: string[] = [];
  const errors: string[] = [];

  const requestedItemsMap = new Map<string, ProcurementLineItem>();
  for (const item of requestedLineItems) {
    requestedItemsMap.set(item.id, item);
  }

  // 1. All requested line-item IDs are represented & 2. Allocated quantities match requested
  const allocationsByLineItem = new Map<string, LineItemCandidateAllocation[]>();
  for (const alloc of strategy.allocations) {
    const existing = allocationsByLineItem.get(alloc.lineItemId) ?? [];
    existing.push(alloc);
    allocationsByLineItem.set(alloc.lineItemId, existing);
  }

  for (const item of requestedLineItems) {
    const allocs = allocationsByLineItem.get(item.id);
    if (!allocs || allocs.length === 0) {
      missingLineItemIds.push(item.id);
      quantityDiscrepancies.push({
        lineItemId: item.id,
        lineItemTitle: item.title,
        requestedQuantity: item.quantity,
        allocatedQuantity: 0,
        status: "missing",
      });
      errors.push(
        `Mandatory line item "${item.title}" (ID: ${item.id}) is not allocated in strategy "${strategy.name}".`
      );
    } else {
      const allocatedQty = allocs.reduce((sum, a) => sum + (Number.isInteger(a.quantity) ? a.quantity : 0), 0);
      if (allocatedQty !== item.quantity) {
        quantityDiscrepancies.push({
          lineItemId: item.id,
          lineItemTitle: item.title,
          requestedQuantity: item.quantity,
          allocatedQuantity: allocatedQty,
          status: allocatedQty < item.quantity ? "partial" : "excess",
        });
        errors.push(
          `Quantity mismatch for line item "${item.title}" (ID: ${item.id}): allocated ${allocatedQty} of requested ${item.quantity}.`
        );
      }
    }
  }

  // 3. No duplicate or unintended allocations exist
  for (const alloc of strategy.allocations) {
    if (!requestedItemsMap.has(alloc.lineItemId)) {
      errors.push(
        `Unintended allocation in strategy "${strategy.name}": allocation references non-existent line item ID "${alloc.lineItemId}".`
      );
    }
  }

  const candidateAllocationMap = new Map<string, string[]>();
  for (const alloc of strategy.allocations) {
    const candKey = alloc.externalId || alloc.candidateId;
    const existing = candidateAllocationMap.get(candKey) ?? [];
    existing.push(alloc.lineItemId);
    candidateAllocationMap.set(candKey, existing);
  }

  if (!options.allowSharedCandidatesAcrossIdenticalItems) {
    for (const [candKey, lineIds] of candidateAllocationMap.entries()) {
      if (lineIds.length > 1) {
        const sortedLineIds = [...lineIds].sort();
        duplicateAllocations.push({
          candidateId: candKey,
          lineItemIds: sortedLineIds,
          occurrences: lineIds.length,
        });
        errors.push(
          `Duplicate allocation: candidate "${candKey}" is allocated to multiple distinct line items: ${sortedLineIds.join(", ")}.`
        );
      }
    }
  }

  // 4. All candidates satisfy mandatory compatibility constraints
  for (const alloc of strategy.allocations) {
    const item = requestedItemsMap.get(alloc.lineItemId);
    if (!item) continue;

    const pseudoCandidate: NormalizedProductCandidate = {
      id: alloc.candidateId,
      purchaseId: "",
      externalId: alloc.externalId,
      title: alloc.title,
      merchantName: alloc.merchantName,
      merchantUrl: alloc.merchantUrl,
      unitPriceCents: alloc.unitPriceCents,
      quantity: alloc.quantity,
      shippingCents: 0,
      totalCents: alloc.unitPriceCents * alloc.quantity,
      currency: alloc.currency as "USD",
      availability: alloc.availability,
      source: "seeded",
      capturedAt: new Date(alloc.capturedAt),
      snapshotHash: alloc.snapshotHash,
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: alloc.sellerName,
      isMarketplace: alloc.isMarketplace,
      isDirectRetailerSeller: alloc.isDirectRetailerSeller,
      fulfillmentMethod: alloc.fulfillmentMethod,
      rawAttributes: alloc.rawAttributes,
      observationList: alloc.observationList,
    };

    const compat = checkCandidateCompatibility(item, pseudoCandidate);
    if (!compat.compatible) {
      incompatibleAllocations.push({
        lineItemId: alloc.lineItemId,
        candidateId: alloc.candidateId,
        candidateTitle: alloc.title,
        reason: compat.reason,
      });
      errors.push(
        `Incompatible allocation for line item "${item.title}": candidate "${alloc.title}" is not compatible (${compat.reason}).`
      );
    }
  }

  // 5. Every shipment and retailer cart maps back to original requested items
  const allocatedItemsInShipments = new Map<string, number>();
  for (const cart of strategy.carts) {
    let shipIdx = 0;
    for (const ship of cart.shipments) {
      shipIdx++;
      for (const shipItem of ship.items) {
        if (!requestedItemsMap.has(shipItem.lineItemId)) {
          unmappedShipmentItems.push({
            merchantName: cart.merchantName,
            shipmentIndex: shipIdx,
            lineItemId: shipItem.lineItemId,
            reason: `Shipment contains item with lineItemId "${shipItem.lineItemId}" which is not in requested line items.`,
          });
          errors.push(
            `Unmapped shipment item in ${cart.merchantName} shipment #${shipIdx}: lineItemId "${shipItem.lineItemId}" is not a requested line item.`
          );
        } else {
          const currentCount = allocatedItemsInShipments.get(shipItem.lineItemId) ?? 0;
          allocatedItemsInShipments.set(shipItem.lineItemId, currentCount + shipItem.quantity);
        }
      }
    }
  }

  for (const item of requestedLineItems) {
    const shippedQty = allocatedItemsInShipments.get(item.id) ?? 0;
    if (shippedQty !== item.quantity && allocationsByLineItem.has(item.id)) {
      unmappedShipmentItems.push({
        merchantName: "all_carts",
        shipmentIndex: 0,
        lineItemId: item.id,
        reason: `Cart shipments total quantity (${shippedQty}) does not equal requested quantity (${item.quantity}).`,
      });
      errors.push(
        `Fulfillment discrepancy: item "${item.title}" (ID: ${item.id}) has ${shippedQty} units in shipments but requires ${item.quantity}.`
      );
    }
  }

  // 6. Total cost reconciles exactly with allocated item costs, shipping, and defensible tax evidence
  // Merchandise subtotal check:
  const calculatedMerchandiseCents = strategy.allocations.reduce(
    (sum, a) => sum + (a.unitPriceCents * a.quantity),
    0
  );
  if (calculatedMerchandiseCents !== strategy.totalMerchandiseCents) {
    const err = `Merchandise arithmetic error: sum of allocations (${calculatedMerchandiseCents} cents) does not match totalMerchandiseCents (${strategy.totalMerchandiseCents} cents).`;
    costReconciliationErrors.push(err);
    errors.push(err);
  }

  const cartsMerchandiseSum = strategy.carts.reduce(
    (sum, c) => sum + c.merchandiseSubtotalCents,
    0
  );
  if (cartsMerchandiseSum !== strategy.totalMerchandiseCents) {
    const err = `Cart merchandise sum mismatch: sum of retailer carts (${cartsMerchandiseSum} cents) does not match totalMerchandiseCents (${strategy.totalMerchandiseCents} cents).`;
    costReconciliationErrors.push(err);
    errors.push(err);
  }

  // Shipping charges:
  let calculatedShippingCents: number | null = 0;
  for (const cart of strategy.carts) {
    for (const ship of cart.shipments) {
      if (ship.shippingChargeCents === null) {
        calculatedShippingCents = null;
        break;
      }
      calculatedShippingCents += ship.shippingChargeCents;
    }
    if (calculatedShippingCents === null) break;
  }

  if (calculatedShippingCents !== strategy.totalShippingCents) {
    const err = `Shipping sum mismatch: sum of shipments (${calculatedShippingCents}) does not match totalShippingCents (${strategy.totalShippingCents}).`;
    costReconciliationErrors.push(err);
    errors.push(err);
  }

  // Landed cost check:
  if (strategy.isLandedCostDefensible) {
    if (strategy.totalShippingCents === null) {
      const err = `Landed cost defensibility violation: isLandedCostDefensible is true but totalShippingCents is null.`;
      costReconciliationErrors.push(err);
      errors.push(err);
    }
    const expectedLanded =
      strategy.totalMerchandiseCents +
      (strategy.totalShippingCents ?? 0) -
      strategy.totalDiscountCents +
      strategy.totalEstimatedTaxCents;
    if (strategy.totalLandedCostCents !== expectedLanded) {
      const err = `Total landed cost arithmetic mismatch: totalLandedCostCents is ${strategy.totalLandedCostCents} but expected ${expectedLanded} cents.`;
      costReconciliationErrors.push(err);
      errors.push(err);
    }
  } else {
    if (strategy.totalLandedCostCents !== null) {
      const err = `Landed cost defensibility violation: isLandedCostDefensible is false but totalLandedCostCents is not null (${strategy.totalLandedCostCents}).`;
      costReconciliationErrors.push(err);
      errors.push(err);
    }
  }

  const isComplete =
    errors.length === 0 &&
    missingLineItemIds.length === 0 &&
    quantityDiscrepancies.length === 0 &&
    duplicateAllocations.length === 0 &&
    incompatibleAllocations.length === 0 &&
    unmappedShipmentItems.length === 0 &&
    costReconciliationErrors.length === 0;

  return {
    isComplete,
    strategyId: strategy.strategyId,
    strategyName: strategy.name,
    missingLineItemIds,
    quantityDiscrepancies,
    duplicateAllocations,
    incompatibleAllocations,
    unmappedShipmentItems,
    costReconciliationErrors,
    errors,
  };
}

/**
 * Asserts that a strategy is complete and valid.
 * Throws an Error with all violations if incomplete.
 */
export function assertStrategyCompleteness(
  strategy: ProcurementStrategy,
  requestedLineItems: readonly ProcurementLineItem[],
  options?: CompletenessValidationOptions
): void {
  const report = validateStrategyCompleteness(strategy, requestedLineItems, options);
  if (!report.isComplete) {
    throw new Error(
      `Strategy completeness violation in "${strategy.name}" (${strategy.strategyId}): ${report.errors.join("; ")}`
    );
  }
}
