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

import { NormalizedProductCandidate } from "../types";
import { computeSnapshotHash } from "../../state/snapshot";
import { LineItemCandidateAllocation, ProcurementLineItem } from "./types";

export interface CandidateCompatibilityCheck {
  readonly compatible: boolean;
  readonly matchedSpecs: readonly string[];
  readonly contradictorySpecs: readonly string[];
  readonly missingSpecs: readonly string[];
  readonly score: number;
  readonly reason: string;
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

  for (const rawReq of lineItem.requirements) {
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

  const totalReqs = lineItem.requirements.length;
  const matchRatio = totalReqs > 0 ? matchedSpecs.length / totalReqs : 1.0;

  return {
    compatible: true,
    matchedSpecs,
    contradictorySpecs,
    missingSpecs,
    score: matchRatio,
    reason: `Compatible: ${matchedSpecs.length}/${totalReqs} requirements matched with verified evidence.`,
  };
}

/**
 * Converts a compatible candidate into a strongly typed LineItemCandidateAllocation.
 */
export function createCandidateAllocation(
  lineItem: ProcurementLineItem,
  candidate: NormalizedProductCandidate
): LineItemCandidateAllocation {
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

  const snapshotHash = computeSnapshotHash(snapshotInput);

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
  };
}

/**
 * Allocates candidates to line items deterministically while strictly preventing
 * accidental duplicate assignment of the same candidate to multiple distinct line items.
 */
export function allocateCandidatesToLineItems(
  lineItems: readonly ProcurementLineItem[],
  candidatePool: readonly NormalizedProductCandidate[],
  options: {
    readonly allowSharedCandidatesAcrossIdenticalItems?: boolean;
  } = {}
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
      const compatibleCandidates: { candidate: NormalizedProductCandidate; score: number }[] = [];

      for (const cand of candidatePool) {
        // Enforce duplicate allocation guard:
        if (assignedCandidateIds.has(cand.externalId) && !options.allowSharedCandidatesAcrossIdenticalItems) {
          continue;
        }

        const compat = checkCandidateCompatibility(lineItem, cand);
        if (compat.compatible) {
          // Score by spec match, availability, and unit price
          let score = compat.score * 1000;
          if (cand.availability === "in_stock") score += 500;
          // Prefer lower price
          score -= (cand.unitPriceCents / 100);
          compatibleCandidates.push({ candidate: cand, score });
        }
      }

      // Sort descending by score
      compatibleCandidates.sort((a, b) => b.score - a.score);
      if (compatibleCandidates.length > 0) {
        chosenCandidate = compatibleCandidates[0].candidate;
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
      allocations.push(createCandidateAllocation(lineItem, chosenCandidate));
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
