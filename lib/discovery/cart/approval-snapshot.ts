/**
 * Plinthly Phase 15 — Multi-Item Approval Snapshot and Integrity Invalidation Engine.
 *
 * Enforces:
 * 1. Cryptographic binding of buyer approvals to the exact complete procurement snapshot:
 *    - All line item IDs and quantities
 *    - Selected candidate snapshot hashes and seller facts
 *    - Retailer cart groupings and threshold evaluations
 *    - Physical split-shipment groupings
 *    - Destination context and applicable policy versions
 * 2. Deterministic invalidation derivation:
 *    - Any modification to line items, quantities, allocations, cart composition,
 *      shipments, shipping fees, or destination invalidates the approval.
 */

import { createHash } from "node:crypto";
import { DestinationContext } from "../shipping";
import {
  MultiItemApprovalSnapshot,
  ProcurementLineItem,
  ProcurementStrategy,
} from "./types";

/**
 * Computes deterministic SHA-256 hash for a complete multi-item procurement strategy snapshot.
 */
export function computeMultiItemSnapshotHash(
  strategy: ProcurementStrategy,
  lineItems: readonly ProcurementLineItem[],
  destination: DestinationContext
): string {
  const canonical = {
    strategyId: strategy.strategyId,
    destination: {
      country: destination.country,
      postalCode: destination.postalCode,
      deliveryMethodPreference: destination.deliveryMethodPreference ?? "standard_ground",
    },
    lineItems: [...lineItems]
      .map((li) => ({
        id: li.id,
        title: li.title,
        quantity: li.quantity,
        budgetCents: li.budgetCents ?? null,
        currency: li.currency,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    allocations: [...strategy.allocations]
      .map((a) => ({
        lineItemId: a.lineItemId,
        candidateId: a.candidateId,
        externalId: a.externalId,
        unitPriceCents: a.unitPriceCents,
        quantity: a.quantity,
        snapshotHash: a.snapshotHash,
        merchantName: a.merchantName,
        sellerName: a.sellerName,
        isMarketplace: a.isMarketplace,
        fulfillmentMethod: a.fulfillmentMethod,
      }))
      .sort((a, b) => a.lineItemId.localeCompare(b.lineItemId)),
    carts: [...strategy.carts]
      .map((c) => ({
        merchantDomain: c.merchantDomain,
        merchandiseSubtotalCents: c.merchandiseSubtotalCents,
        totalShippingCents: c.totalShippingCents,
        policyVersion: c.thresholdEvaluation?.policyVersion ?? null,
        policyDocumentFingerprint: c.thresholdEvaluation?.policyDocumentFingerprint ?? null,
        shipmentCount: c.shipments.length,
      }))
      .sort((a, b) => a.merchantDomain.localeCompare(b.merchantDomain)),
    shipments: strategy.carts.flatMap((c) =>
      c.shipments.map((s) => ({
        shipmentId: s.shipmentId,
        merchantDomain: s.merchantDomain,
        sellerName: s.sellerName,
        fulfillmentMethod: s.fulfillmentMethod,
        merchandiseSubtotalCents: s.merchandiseSubtotalCents,
        shippingChargeCents: s.shippingChargeCents,
      }))
    ).sort((a, b) => a.shipmentId.localeCompare(b.shipmentId)),
    totalLandedCostCents: strategy.totalLandedCostCents,
    currency: strategy.currency,
  };

  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex").toLowerCase();
}

/**
 * Creates a complete immutable MultiItemApprovalSnapshot.
 */
export function createMultiItemApprovalSnapshot(params: {
  readonly snapshotId: string;
  readonly purchaseId: string;
  readonly strategy: ProcurementStrategy;
  readonly lineItems: readonly ProcurementLineItem[];
  readonly destination: DestinationContext;
  readonly approverUserId: string;
  readonly evidenceFingerprint: string;
  readonly approvedAt?: string;
}): MultiItemApprovalSnapshot {
  const {
    snapshotId,
    purchaseId,
    strategy,
    lineItems,
    destination,
    approverUserId,
    evidenceFingerprint,
    approvedAt = new Date().toISOString(),
  } = params;

  if (strategy.totalLandedCostCents === null || !strategy.isLandedCostDefensible) {
    throw new Error(
      `Cannot approve strategy "${strategy.name}" with incomplete or unverified landed cost.`
    );
  }

  const multiItemSnapshotHash = computeMultiItemSnapshotHash(strategy, lineItems, destination);

  return {
    snapshotId,
    purchaseId,
    strategyId: strategy.strategyId,
    multiItemSnapshotHash,
    evidenceFingerprint,
    totalLandedCostCents: strategy.totalLandedCostCents,
    currency: strategy.currency,
    destination,
    lineItems: strategy.allocations.map((a) => ({
      id: a.lineItemId,
      quantity: a.quantity,
      candidateId: a.candidateId,
      candidateSnapshotHash: a.snapshotHash,
    })),
    carts: strategy.carts.map((c) => ({
      merchantDomain: c.merchantDomain,
      merchandiseSubtotalCents: c.merchandiseSubtotalCents,
      shippingCents: c.totalShippingCents ?? 0,
      policyVersion: c.thresholdEvaluation?.policyVersion ?? null,
      shipmentCount: c.shipments.length,
    })),
    approverUserId,
    approvedAt,
    invalidatedAt: null,
    invalidationReason: null,
  };
}

export type MultiItemInvalidationReason =
  | "plan_modified"
  | "line_item_changed"
  | "candidate_changed"
  | "cart_composition_changed"
  | "shipment_split_changed"
  | "total_changed"
  | "policy_superseded"
  | "destination_changed"
  | "destination_excluded"
  | "evidence_fingerprint_changed";

/**
 * Derives invalidation reasons when comparing an existing MultiItemApprovalSnapshot against the current plan state.
 */
export function deriveMultiItemInvalidationReasons(
  snapshot: MultiItemApprovalSnapshot,
  currentStrategy: ProcurementStrategy,
  currentLineItems: readonly ProcurementLineItem[],
  currentDestination: DestinationContext,
  currentEvidenceFingerprint: string
): readonly MultiItemInvalidationReason[] {
  const reasons: MultiItemInvalidationReason[] = [];

  // 1. Destination check
  if (
    snapshot.destination.postalCode !== currentDestination.postalCode ||
    snapshot.destination.country !== currentDestination.country
  ) {
    reasons.push("destination_changed");
  }

  // 2. Line items check
  if (snapshot.lineItems.length !== currentLineItems.length) {
    reasons.push("line_item_changed");
  } else {
    for (const snapItem of snapshot.lineItems) {
      const curr = currentLineItems.find((li) => li.id === snapItem.id);
      if (!curr || curr.quantity !== snapItem.quantity) {
        reasons.push("line_item_changed");
        break;
      }
    }
  }

  // 3. Allocations / Candidates check
  for (const snapItem of snapshot.lineItems) {
    const alloc = currentStrategy.allocations.find((a) => a.lineItemId === snapItem.id);
    if (!alloc || alloc.candidateId !== snapItem.candidateId || alloc.snapshotHash !== snapItem.candidateSnapshotHash) {
      reasons.push("candidate_changed");
      break;
    }
  }

  // 4. Cart composition check
  if (snapshot.carts.length !== currentStrategy.carts.length) {
    reasons.push("cart_composition_changed");
  }

  // 5. Total cost check
  if (snapshot.totalLandedCostCents !== currentStrategy.totalLandedCostCents) {
    reasons.push("total_changed");
  }

  // 6. Evidence fingerprint check
  if (snapshot.evidenceFingerprint !== currentEvidenceFingerprint) {
    reasons.push("evidence_fingerprint_changed");
  }

  // 7. Full snapshot hash check
  const currentSnapshotHash = computeMultiItemSnapshotHash(currentStrategy, currentLineItems, currentDestination);
  if (snapshot.multiItemSnapshotHash !== currentSnapshotHash && reasons.length === 0) {
    reasons.push("plan_modified");
  }

  return reasons;
}

