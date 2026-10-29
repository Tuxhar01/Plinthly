import {
  ApprovalFacts,
  CandidateFacts,
  InvalidationReason,
  PurchaseState,
} from "./types";
import { isValidEvidenceFingerprint } from "./snapshot";

export function deriveInvalidationReasons(
  approval: ApprovalFacts,
  state: PurchaseState
): InvalidationReason[] {
  const reasons: InvalidationReason[] = [];

  // 1. "candidate_changed" if selectedCandidate is null or selectedCandidate.id !== approval.candidateId.
  if (!state.selectedCandidate || state.selectedCandidate.id !== approval.candidateId) {
    reasons.push("candidate_changed");
  } else {
    // 2. Only when selectedCandidate is non-null and selectedCandidate.id === approval.candidateId:
    if (state.selectedCandidate.snapshotHash !== approval.snapshotHash) {
      reasons.push("snapshot_hash_changed");
    }
    if (state.selectedCandidate.totalCents !== approval.totalCents) {
      reasons.push("total_changed");
    }
    if (state.selectedCandidate.currency !== approval.currency) {
      reasons.push("currency_changed");
    }
  }

  // 3. "policy_version_changed" if state.policyVersion !== approval.policyVersion.
  if (state.policyVersion !== approval.policyVersion) {
    reasons.push("policy_version_changed");
  }

  // 4. "evidence_fingerprint_changed" if state.currentEvidenceFingerprint !== approval.evidenceFingerprint.
  // A null current fingerprint is a mismatch, not silently equal.
  if (state.currentEvidenceFingerprint !== approval.evidenceFingerprint) {
    reasons.push("evidence_fingerprint_changed");
  }

  // 5. "policy_superseded" if state.isPolicySuperseded is true.
  if (state.isPolicySuperseded === true) {
    reasons.push("policy_superseded");
  }

  return reasons;
}

export function proposedState(
  state: PurchaseState,
  command: { candidate: CandidateFacts; policyVersion: string | null }
): PurchaseState {
  let nextFingerprint: string | null = null;

  // Preserve state.currentEvidenceFingerprint if state.selectedCandidate is non-null,
  // the old and proposed candidate IDs are equal, the old and proposed snapshotHash values are equal,
  // and the current fingerprint is non-null.
  if (
    state.selectedCandidate !== null &&
    state.selectedCandidate.id === command.candidate.id &&
    state.selectedCandidate.snapshotHash === command.candidate.snapshotHash &&
    state.currentEvidenceFingerprint !== null &&
    isValidEvidenceFingerprint(state.currentEvidenceFingerprint)
  ) {
    nextFingerprint = state.currentEvidenceFingerprint;
  }

  return {
    ...state,
    selectedCandidate: command.candidate,
    policyVersion: command.policyVersion,
    currentEvidenceFingerprint: nextFingerprint,
  };
}

export function isCandidateUnchanged(
  eff: ApprovalFacts,
  command: { candidate: CandidateFacts; policyVersion: string | null }
): boolean {
  return (
    command.candidate.id === eff.candidateId &&
    command.candidate.snapshotHash === eff.snapshotHash &&
    command.candidate.totalCents === eff.totalCents &&
    command.candidate.currency === eff.currency &&
    command.policyVersion === eff.policyVersion
  );
}
