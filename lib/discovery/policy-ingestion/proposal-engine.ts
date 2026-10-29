/**
 * Plinthly Phase 13C — Merchant Policy Change Proposal and Review Engine.
 *
 * Enforces:
 * 1. Safe change detection comparing raw content hashes and extracted canonical terms.
 * 2. Human review gating: material changes and ambiguous extractions are staged as "proposed"
 *    and NEVER automatically published to active evaluation.
 * 3. Non-material changes (e.g. promotional banner or layout change with identical terms)
 *    update audit review timestamps without invalidating live decisions.
 * 4. Human approval workflow: approving a proposal marks it "validated", publishes a new version,
 *    and marks prior versions as "superseded".
 * 5. Immutable audit trails with historical proposal tracking.
 */

import { randomUUID } from "node:crypto";
import { Actor } from "../../state/types";
import {
  computePolicyFingerprint,
  MerchantShippingPolicy,
} from "../merchant-policy";
import { MerchantPolicyRegistry } from "../merchant-policy-registry";
import {
  ExtractedPolicyTerms,
  PolicyChangeProposal,
  PolicyExtractionResult,
  PolicySourceRecord,
} from "./types";
import { recordProposalReviewAudit, PolicyProposalAuditEntry } from "../policy-persistence";

export class PolicyProposalError extends Error {
  constructor(
    public readonly code:
      | "invalid_status_transition"
      | "proposal_not_found"
      | "missing_proposed_policy"
      | "unauthorized_actor"
      | "version_conflict",
    message: string
  ) {
    super(message);
    this.name = "PolicyProposalError";
  }
}

export interface SerializedProposalState {
  readonly proposals: readonly PolicyChangeProposal[];
}

/**
 * Checks whether extracted policy terms match an existing policy's canonical terms.
 */
export function areCanonicalTermsEqual(
  extracted: ExtractedPolicyTerms,
  existing: MerchantShippingPolicy
): boolean {
  if (extracted.thresholdCents !== existing.thresholdCents) return false;
  if (extracted.shippingCostCents !== existing.shippingCostCents) return false;
  if (extracted.deliveryMethod !== existing.deliveryMethod) return false;
  if (extracted.currency !== existing.currency) return false;
  if (
    (extracted.requiresDirectRetailerSeller ?? false) !==
    (existing.requiresDirectRetailerSeller ?? false)
  ) {
    return false;
  }
  if (
    (extracted.requiresDirectRetailerOrWfsFulfillment ?? false) !==
    (existing.requiresDirectRetailerOrWfsFulfillment ?? false)
  ) {
    return false;
  }
  if (
    (extracted.marketplaceItemsContributeToThreshold ?? false) !==
    (existing.marketplaceItemsContributeToThreshold ?? false)
  ) {
    return false;
  }
  if ((extracted.requiresMembership ?? null) !== (existing.requiresMembership ?? null)) {
    return false;
  }
  if (
    (extracted.requiresPreTaxMerchandiseThreshold ?? false) !==
    (existing.requiresPreTaxMerchandiseThreshold ?? false)
  ) {
    return false;
  }
  if (
    (extracted.itemSpecificQualificationRequired ?? false) !==
    (existing.itemSpecificQualificationRequired ?? false)
  ) {
    return false;
  }

  // Compare zones
  const sortZones = (zones: readonly string[]) => [...zones].sort().join(",");
  if (sortZones(extracted.allowedZones) !== sortZones(existing.allowedZones)) return false;
  if (sortZones(extracted.excludedZones) !== sortZones(existing.excludedZones)) return false;

  // Compare categories & special methods
  const sortStrings = (arr?: readonly string[]) => (arr ? [...arr].sort().join(",") : "");
  if (sortStrings(extracted.excludedCategories) !== sortStrings(existing.excludedCategories)) {
    return false;
  }
  if (
    sortStrings(extracted.excludedSpecialFulfillmentMethods) !==
    sortStrings(existing.excludedSpecialFulfillmentMethods)
  ) {
    return false;
  }

  return true;
}

/**
 * Creates a next version string given a current version (e.g. "2.0.0" -> "2.1.0").
 */
function bumpMinorVersion(version: string): string {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  if (parts.length === 3 && !parts.some(Number.isNaN)) {
    return `${parts[0]}.${parts[1] + 1}.0`;
  }
  return `${version}.1`;
}

export class PolicyProposalEngine {
  private readonly proposals = new Map<string, PolicyChangeProposal>();

  getProposal(proposalId: string): PolicyChangeProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  getAllProposals(): readonly PolicyChangeProposal[] {
    return Array.from(this.proposals.values());
  }

  /**
   * Evaluates ingestion inputs and creates a proposal or maintains active policy.
   */
  evaluateIngestion(
    sourceRecord: PolicySourceRecord,
    extractionResult: PolicyExtractionResult,
    currentPolicy: MerchantShippingPolicy | null
  ): PolicyChangeProposal {
    const proposalId = `prop_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const policyId =
      currentPolicy?.policyId ??
      `pol_${extractionResult.terms?.merchantDomain.replace(/\./g, "_") ?? "unknown"}_auto`;

    // 1. Source Removed (404/410)
    if (sourceRecord.httpStatus === 404 || sourceRecord.httpStatus === 410) {
      const proposal: PolicyChangeProposal = {
        proposalId,
        policyId,
        changeType: "source_removed",
        currentPolicy,
        proposedPolicy: null,
        sourceRecord,
        parserVersion: extractionResult.parserVersion,
        status: "proposed", // Human must approve removal
        explanation: `Authoritative source returned HTTP ${sourceRecord.httpStatus}. Proposed policy removal requires human review.`,
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      };
      this.proposals.set(proposalId, proposal);
      return proposal;
    }

    // 2. Unchanged (HTTP 304 or identical raw HTML hash)
    if (
      sourceRecord.isNotModified ||
      (currentPolicy && sourceRecord.rawContentHash && sourceRecord.rawContentHash === currentPolicy.policyDocumentFingerprint)
    ) {
      const proposal: PolicyChangeProposal = {
        proposalId,
        policyId,
        changeType: "no_change",
        currentPolicy,
        proposedPolicy: currentPolicy,
        sourceRecord,
        parserVersion: extractionResult.parserVersion,
        status: "active",
        explanation: "Authoritative policy source is unchanged (conditional 304 or identical content hash).",
        createdAt: new Date().toISOString(),
        reviewedAt: new Date().toISOString(),
        reviewedBy: { kind: "system", component: "policy_proposal_engine" },
        rejectionReason: null,
      };
      this.proposals.set(proposalId, proposal);
      return proposal;
    }

    // 3. Parse Error
    if (extractionResult.status === "parse_error" || !extractionResult.terms) {
      const proposal: PolicyChangeProposal = {
        proposalId,
        policyId,
        changeType: "parse_failed",
        currentPolicy,
        proposedPolicy: null,
        sourceRecord,
        parserVersion: extractionResult.parserVersion,
        status: "proposed",
        explanation: `Policy extraction failed: ${extractionResult.explanation}. Warnings: ${extractionResult.warnings.join("; ")}`,
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      };
      this.proposals.set(proposalId, proposal);
      return proposal;
    }

    // 4. Ambiguous Terms
    if (extractionResult.status === "ambiguous") {
      const proposal: PolicyChangeProposal = {
        proposalId,
        policyId,
        changeType: "terms_ambiguous",
        currentPolicy,
        proposedPolicy: null,
        sourceRecord,
        parserVersion: extractionResult.parserVersion,
        status: "proposed",
        explanation: `Extractor detected ambiguous or conflicting policy terms: ${extractionResult.explanation}. Warnings: ${extractionResult.warnings.join("; ")}`,
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      };
      this.proposals.set(proposalId, proposal);
      return proposal;
    }

    // 5. Extracted Terms Evaluation
    const terms = extractionResult.terms;
    const nowIso = new Date().toISOString();

    if (currentPolicy) {
      const termsMatch = areCanonicalTermsEqual(terms, currentPolicy);

      if (termsMatch) {
        // Raw content changed, but business terms are 100% identical!
        const proposal: PolicyChangeProposal = {
          proposalId,
          policyId,
          changeType: "content_updated_terms_identical",
          currentPolicy,
          proposedPolicy: {
            ...currentPolicy,
            lastReviewedAt: nowIso,
            retrievedAt: sourceRecord.retrievedAt,
          },
          sourceRecord,
          parserVersion: extractionResult.parserVersion,
          status: "active",
          explanation: "Source HTML content updated (e.g. promotional banners, styling), but canonical shipping terms are identical. No material change.",
          createdAt: nowIso,
          reviewedAt: nowIso,
          reviewedBy: { kind: "system", component: "policy_proposal_engine" },
          rejectionReason: null,
        };
        this.proposals.set(proposalId, proposal);
        return proposal;
      }
    }

    // Material terms changed or new policy!
    const nextVersion = currentPolicy
      ? bumpMinorVersion(currentPolicy.policyVersion)
      : "1.0.0";

    const proposedRaw: Omit<MerchantShippingPolicy, "policyDocumentFingerprint"> = {
      policyId,
      merchantDomain: terms.merchantDomain,
      merchantName: terms.merchantName,
      policySourceUrl: sourceRecord.sourceUrl,
      publisher: currentPolicy?.publisher ?? `${terms.merchantName} Corporate`,
      sourceStatedEffectiveDate: null,
      retrievedAt: sourceRecord.retrievedAt,
      lastReviewedAt: nowIso,
      effectiveFrom: null,
      expiresAt: null,
      deliveryMethod: terms.deliveryMethod,
      currency: terms.currency,
      thresholdCents: terms.thresholdCents,
      shippingCostCents: terms.shippingCostCents,
      allowedZones: terms.allowedZones,
      excludedZones: terms.excludedZones,
      excludedCategories: terms.excludedCategories,
      excludedSpecialFulfillmentMethods: terms.excludedSpecialFulfillmentMethods,
      requiresDirectRetailerSeller: terms.requiresDirectRetailerSeller,
      requiresDirectRetailerOrWfsFulfillment: terms.requiresDirectRetailerOrWfsFulfillment,
      marketplaceItemsContributeToThreshold: terms.marketplaceItemsContributeToThreshold,
      requiresMembership: terms.requiresMembership,
      requiresPreTaxMerchandiseThreshold: terms.requiresPreTaxMerchandiseThreshold,
      itemSpecificQualificationRequired: terms.itemSpecificQualificationRequired,
      policyVersion: nextVersion,
    };

    const proposedPolicy: MerchantShippingPolicy = {
      ...proposedRaw,
      policyDocumentFingerprint: computePolicyFingerprint(proposedRaw),
    };

    const proposal: PolicyChangeProposal = {
      proposalId,
      policyId,
      changeType: "material_terms_changed",
      currentPolicy,
      proposedPolicy,
      sourceRecord,
      parserVersion: extractionResult.parserVersion,
      status: "proposed", // Human approval required!
      explanation: currentPolicy
        ? `Material shipping policy terms changed for ${terms.merchantName}: previous threshold $${(currentPolicy.thresholdCents / 100).toFixed(2)}, proposed threshold $${(terms.thresholdCents / 100).toFixed(2)}. Staged for human review.`
        : `New shipping policy discovered for ${terms.merchantName} ($${(terms.thresholdCents / 100).toFixed(2)} threshold). Staged for human review.`,
      createdAt: nowIso,
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
    };

    this.proposals.set(proposalId, proposal);
    return proposal;
  }

  /**
   * Approves a proposed policy change and publishes it into the active policy registry.
   */
  approveProposal(
    proposalId: string,
    actor: Actor,
    registry: MerchantPolicyRegistry
  ): {
    readonly approvedProposal: PolicyChangeProposal;
    readonly publishedPolicy: MerchantShippingPolicy;
  } {
    if (actor.kind !== "user") {
      throw new PolicyProposalError(
        "unauthorized_actor",
        "Only authenticated user actors can approve policy proposals."
      );
    }

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new PolicyProposalError("proposal_not_found", `Proposal "${proposalId}" not found.`);
    }

    if (proposal.status !== "proposed") {
      throw new PolicyProposalError(
        "invalid_status_transition",
        `Cannot approve proposal in status "${proposal.status}". Only "proposed" proposals can be approved.`
      );
    }

    if (!proposal.proposedPolicy) {
      throw new PolicyProposalError(
        "missing_proposed_policy",
        `Cannot approve proposal "${proposalId}" without a valid proposed policy.`
      );
    }

    // Version conflict validation
    if (registry.isPolicyActive(proposal.proposedPolicy.policyId, proposal.proposedPolicy.policyVersion)) {
      throw new PolicyProposalError(
        "version_conflict",
        `Policy version "${proposal.proposedPolicy.policyVersion}" for "${proposal.proposedPolicy.policyId}" is already active.`
      );
    }

    if (registry.getPolicyVersion(proposal.proposedPolicy.policyId, proposal.proposedPolicy.policyVersion)) {
      throw new PolicyProposalError(
        "version_conflict",
        `Policy version "${proposal.proposedPolicy.policyVersion}" for "${proposal.proposedPolicy.policyId}" has already been published in policy history.`
      );
    }

    const nowIso = new Date().toISOString();

    const updatedProposal: PolicyChangeProposal = {
      ...proposal,
      status: "validated",
      reviewedAt: nowIso,
      reviewedBy: actor,
      rejectionReason: null,
    };

    // Publish to the registry
    registry.publishPolicy(proposal.proposedPolicy);

    this.proposals.set(proposalId, updatedProposal);

    // Record structured review audit entry
    const auditEntry: PolicyProposalAuditEntry = {
      id: `prop_aud_${Date.now()}_${randomUUID().slice(0, 8)}`,
      proposalId,
      policyId: proposal.policyId,
      priorFingerprint: proposal.currentPolicy?.policyDocumentFingerprint ?? null,
      newFingerprint: proposal.proposedPolicy.policyDocumentFingerprint,
      reviewer: actor,
      decision: "approved",
      timestamp: nowIso,
    };
    recordProposalReviewAudit(auditEntry);

    return {
      approvedProposal: updatedProposal,
      publishedPolicy: proposal.proposedPolicy,
    };
  }

  /**
   * Rejects a proposed policy change. Active registry remains unchanged.
   */
  rejectProposal(
    proposalId: string,
    reason: string,
    actor: Actor
  ): PolicyChangeProposal {
    if (actor.kind !== "user") {
      throw new PolicyProposalError(
        "unauthorized_actor",
        "Only authenticated user actors can reject policy proposals."
      );
    }

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new PolicyProposalError("proposal_not_found", `Proposal "${proposalId}" not found.`);
    }

    if (proposal.status !== "proposed") {
      throw new PolicyProposalError(
        "invalid_status_transition",
        `Cannot reject proposal in status "${proposal.status}". Only "proposed" proposals can be rejected.`
      );
    }

    const nowIso = new Date().toISOString();
    const updatedProposal: PolicyChangeProposal = {
      ...proposal,
      status: "rejected",
      reviewedAt: nowIso,
      reviewedBy: actor,
      rejectionReason: reason,
    };

    this.proposals.set(proposalId, updatedProposal);

    // Record structured review audit entry
    const auditEntry: PolicyProposalAuditEntry = {
      id: `prop_aud_${Date.now()}_${randomUUID().slice(0, 8)}`,
      proposalId,
      policyId: proposal.policyId,
      priorFingerprint: proposal.currentPolicy?.policyDocumentFingerprint ?? null,
      newFingerprint: null,
      reviewer: actor,
      decision: "rejected",
      explanation: reason,
      timestamp: nowIso,
    };
    recordProposalReviewAudit(auditEntry);

    return updatedProposal;
  }

  /**
   * Serializes proposal state for durability across application restarts.
   */
  exportState(): SerializedProposalState {
    return {
      proposals: Array.from(this.proposals.values()),
    };
  }

  /**
   * Restores proposal state from persistent storage.
   */
  importState(state: SerializedProposalState): void {
    this.proposals.clear();
    for (const p of state.proposals) {
      this.proposals.set(p.proposalId, p);
    }
  }
}
