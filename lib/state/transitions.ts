import {
  deriveInvalidationReasons,
  isCandidateUnchanged,
  proposedState,
} from "./approval";
import { deriveTotalCents, validateCandidateMoney } from "./money";
import {
  ApprovalFacts,
  AuditEventDraft,
  Command,
  Context,
  PaymentAttemptFacts,
  PurchaseState,
  TransitionErrorCode,
  TransitionResult,
} from "./types";
import { isValidEvidenceFingerprint } from "./snapshot";

const HEX_64_REGEX = /^[0-9a-f]{64}$/;

const VALID_PAYPAL_STATUSES = new Set([
  "CREATED",
  "PAYER_ACTION_REQUIRED",
  "APPROVED",
  "COMPLETED",
  "VOIDED",
]);

function fail(code: TransitionErrorCode, message: string): TransitionResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function checkStateIntegrity(state: PurchaseState): { ok: true } | { ok: false; code: TransitionErrorCode; message: string } {
  // P1 (purchase match): every fact's purchaseId equals state.purchaseId.
  if (state.selectedCandidate && state.selectedCandidate.purchaseId !== state.purchaseId) {
    return { ok: false, code: "cross_purchase_reference", message: "selectedCandidate.purchaseId does not match state.purchaseId" };
  }
  for (const app of state.approvals) {
    if (app.purchaseId !== state.purchaseId) {
      return { ok: false, code: "cross_purchase_reference", message: `approval ${app.id} purchaseId does not match state.purchaseId` };
    }
  }
  for (const att of state.paymentAttempts) {
    if (att.purchaseId !== state.purchaseId) {
      return { ok: false, code: "cross_purchase_reference", message: `paymentAttempt ${att.id} purchaseId does not match state.purchaseId` };
    }
  }

  // P2 (approval-candidate match): an effective approval whose candidateId differs from the selected candidate is inconsistent_state.
  const effectiveApprovals = state.approvals.filter((a) => a.invalidatedAt === null);
  for (const eff of effectiveApprovals) {
    if (!state.selectedCandidate || eff.candidateId !== state.selectedCandidate.id) {
      return { ok: false, code: "inconsistent_state", message: "Effective approval candidateId does not match selected candidate" };
    }
  }

  // P3 (attempt-approval match): every attempt's approvalId refers to an approval in state.approvals with the same purchaseId.
  for (const att of state.paymentAttempts) {
    const matchingApproval = state.approvals.find((a) => a.id === att.approvalId);
    if (!matchingApproval) {
      return { ok: false, code: "inconsistent_state", message: `Payment attempt ${att.id} references non-existent approval ${att.approvalId}` };
    }
    if (matchingApproval.purchaseId !== state.purchaseId) {
      return { ok: false, code: "cross_purchase_reference", message: `Payment attempt ${att.id} references approval with different purchaseId` };
    }
  }

  // P4 (attempt-approval effectiveness): a LIVE attempt's approvalId must refer to the effective approval.
  const liveAttempts = state.paymentAttempts.filter((a) => a.status === "OPEN");
  for (const live of liveAttempts) {
    const matchingApproval = state.approvals.find((a) => a.id === live.approvalId);
    if (!matchingApproval || matchingApproval.invalidatedAt !== null) {
      return { ok: false, code: "inconsistent_state", message: `LIVE attempt ${live.id} references an invalidated or missing approval` };
    }
  }

  // P5 (single effective approval): at most one approval with invalidatedAt === null.
  if (effectiveApprovals.length > 1) {
    return { ok: false, code: "inconsistent_state", message: "Multiple effective approvals found" };
  }

  // P6 (single live attempt): at most one attempt with status OPEN.
  if (liveAttempts.length > 1) {
    return { ok: false, code: "inconsistent_state", message: "Multiple LIVE payment attempts found" };
  }

  // P7 (attempt identifiers): a LIVE attempt has non-null paypalOrderId whenever the purchase status is ORDER_CREATED, BUYER_APPROVED, or CAPTURE_ATTEMPTED.
  if (
    state.status === "ORDER_CREATED" ||
    state.status === "BUYER_APPROVED" ||
    state.status === "CAPTURE_ATTEMPTED"
  ) {
    for (const live of liveAttempts) {
      if (!live.paypalOrderId) {
        return { ok: false, code: "inconsistent_state", message: "LIVE attempt in active payment status has null paypalOrderId" };
      }
    }
  }

  // P8 (status-attempt coherence): if purchase status is ORDER_CREATED, BUYER_APPROVED, or CAPTURE_ATTEMPTED, exactly one LIVE attempt exists.
  // A LIVE attempt is never allowed in DRAFT, REQUIREMENTS_CONFIRMED, EVALUATED, POLICY_BLOCKED, POLICY_PASSED, or APPROVED.
  if (
    state.status === "ORDER_CREATED" ||
    state.status === "BUYER_APPROVED" ||
    state.status === "CAPTURE_ATTEMPTED"
  ) {
    if (liveAttempts.length !== 1) {
      return { ok: false, code: "inconsistent_state", message: `Status ${state.status} requires exactly one LIVE attempt, found ${liveAttempts.length}` };
    }
  } else if (
    state.status === "DRAFT" ||
    state.status === "REQUIREMENTS_CONFIRMED" ||
    state.status === "EVALUATED" ||
    state.status === "POLICY_BLOCKED" ||
    state.status === "POLICY_PASSED" ||
    state.status === "APPROVED"
  ) {
    if (liveAttempts.length > 0) {
      return { ok: false, code: "inconsistent_state", message: `LIVE attempt not permitted in status ${state.status}` };
    }
  }

  // P9 (terminal consistency): if purchase status is COMPLETED, the attempt that completed the purchase has status COMPLETED.
  // If purchase status is FAILED, the most recent attempt has status FAILED.
  if (state.status === "COMPLETED") {
    if (state.paymentAttempts.length > 0) {
      const hasCompletedAttempt = state.paymentAttempts.some((a) => a.status === "COMPLETED");
      if (!hasCompletedAttempt) {
        return { ok: false, code: "inconsistent_state", message: "COMPLETED purchase has no COMPLETED payment attempt" };
      }
    }
  } else if (state.status === "FAILED") {
    if (state.paymentAttempts.length > 0) {
      const lastAttempt = state.paymentAttempts[state.paymentAttempts.length - 1];
      if (lastAttempt.status !== "FAILED") {
        return { ok: false, code: "inconsistent_state", message: "FAILED purchase most recent attempt is not FAILED" };
      }
    }
  }

  return { ok: true };
}

export function transition(
  state: PurchaseState,
  command: Command,
  context: Context
): TransitionResult {
  // Precedence 1: Command permitted from current status (section 7 table)
  switch (command.kind) {
    case "confirm_requirements":
      if (state.status !== "DRAFT") {
        return fail("illegal_transition", `Cannot confirm_requirements from ${state.status}`);
      }
      break;

    case "select_candidate":
      if (
        state.status !== "REQUIREMENTS_CONFIRMED" &&
        state.status !== "EVALUATED" &&
        state.status !== "POLICY_PASSED" &&
        state.status !== "POLICY_BLOCKED" &&
        state.status !== "APPROVED" &&
        state.status !== "ORDER_CREATED" &&
        state.status !== "BUYER_APPROVED" &&
        state.status !== "CAPTURE_ATTEMPTED"
      ) {
        return fail("illegal_transition", `Cannot select_candidate from ${state.status}`);
      }
      break;

    case "evaluate":
      if (state.status !== "EVALUATED") {
        return fail("illegal_transition", `Cannot evaluate from ${state.status}`);
      }
      break;

    case "apply_policy_summary":
      if (state.status !== "EVALUATED") {
        return fail("illegal_transition", `Cannot apply_policy_summary from ${state.status}`);
      }
      break;

    case "reevaluate":
      if (
        state.status !== "POLICY_BLOCKED" &&
        state.status !== "POLICY_PASSED" &&
        state.status !== "APPROVED"
      ) {
        return fail("illegal_transition", `Cannot reevaluate from ${state.status}`);
      }
      break;

    case "approve":
      if (state.status !== "POLICY_PASSED") {
        return fail("illegal_transition", `Cannot approve from ${state.status}`);
      }
      break;

    case "create_order":
      if (state.status !== "APPROVED") {
        return fail("illegal_transition", `Cannot create_order from ${state.status}`);
      }
      break;

    case "observe_paypal_order":
      if (state.status !== "ORDER_CREATED" && state.status !== "CAPTURE_ATTEMPTED") {
        return fail("illegal_transition", `Cannot observe_paypal_order from ${state.status}`);
      }
      break;

    case "record_capture_attempt":
      if (state.status !== "BUYER_APPROVED") {
        return fail("illegal_transition", `Cannot record_capture_attempt from ${state.status}`);
      }
      break;

    case "record_capture_rejected":
      if (state.status !== "CAPTURE_ATTEMPTED") {
        return fail("illegal_transition", `Cannot record_capture_rejected from ${state.status}`);
      }
      break;

    case "cancel":
      if (
        state.status !== "DRAFT" &&
        state.status !== "REQUIREMENTS_CONFIRMED" &&
        state.status !== "EVALUATED" &&
        state.status !== "POLICY_BLOCKED" &&
        state.status !== "POLICY_PASSED" &&
        state.status !== "APPROVED" &&
        state.status !== "ORDER_CREATED" &&
        state.status !== "BUYER_APPROVED"
      ) {
        return fail("illegal_transition", `Cannot cancel from ${state.status}`);
      }
      break;

    default:
      return fail("illegal_transition", "Unknown command kind");
  }

  // Precedence 2: Actor permitted for command
  if (command.kind === "approve") {
    if (context.actor.kind !== "user") {
      return fail("invalid_actor", "approve requires actor of kind 'user'");
    }
  }

  // Precedence 3: Input invalid: money, currency, empty reason, malformed fields, missing context identifier
  if (!context.now || !(context.now instanceof Date) || Number.isNaN(context.now.getTime())) {
    return fail("invalid_input", "context.now must be a valid Date");
  }

  if (command.kind === "cancel") {
    if (!command.reason || command.reason.trim().length === 0) {
      return fail("invalid_input", "cancel command requires non-empty reason");
    }
  }

  if (command.kind === "record_capture_rejected") {
    if (!command.reason || command.reason.trim().length === 0) {
      return fail("invalid_input", "record_capture_rejected command requires non-empty reason");
    }
  }

  if (command.kind === "create_order") {
    if (!context.newPaymentAttemptId || context.newPaymentAttemptId.trim().length === 0) {
      return fail("invalid_input", "create_order requires context.newPaymentAttemptId");
    }
    if (!command.idempotencyKey || command.idempotencyKey.trim().length === 0) {
      return fail("invalid_input", "create_order requires non-empty idempotencyKey");
    }
    if (!command.paypalOrderId || command.paypalOrderId.trim().length === 0) {
      return fail("invalid_input", "create_order requires non-empty paypalOrderId");
    }
  }

  if (command.kind === "approve") {
    if (!context.newApprovalId || context.newApprovalId.trim().length === 0) {
      return fail("invalid_input", "approve requires context.newApprovalId");
    }
  }

  if (command.kind === "select_candidate") {
    const cand = command.candidate;
    if (cand.purchaseId !== state.purchaseId) {
      return fail("cross_purchase_reference", "Candidate purchaseId does not match state.purchaseId");
    }
    if (cand.currency !== "USD" || !validateCandidateMoney(cand)) {
      return fail("invalid_input", "Candidate money or currency is invalid");
    }
    if (!HEX_64_REGEX.test(cand.snapshotHash)) {
      return fail("invalid_input", "Candidate snapshotHash must be 64 lowercase hex characters");
    }
  }

  if (command.kind === "observe_paypal_order") {
    const obs = command.observation;
    if (!obs || !VALID_PAYPAL_STATUSES.has(obs.status)) {
      return fail("unexpected_paypal_status", `Unexpected PayPal status: ${obs?.status}`);
    }
  }

  if (command.kind === "apply_policy_summary") {
    const summary = command.summary;
    const isT4Candidate = summary && summary.allRequiredPassed === true;
    const isT5Candidate =
      summary &&
      summary.allRequiredPassed === false &&
      (summary.blockingRuleKeys?.length > 0 || summary.unknownRuleKeys?.length > 0);

    // 1. Summary condition (input check)
    if (!isT4Candidate && !isT5Candidate) {
      return fail("invalid_input", "Invalid policy summary condition");
    }
  }

  // Precedence 4: State-integrity checks (P1 to P9)
  const integrity = checkStateIntegrity(state);
  if (!integrity.ok) {
    return fail(integrity.code, integrity.message);
  }

  // Precedence 5: Transition-specific guards
  const eff = state.approvals.find((a) => a.invalidatedAt === null) || null;
  const live = state.paymentAttempts.find((a) => a.status === "OPEN") || null;

  switch (command.kind) {
    case "confirm_requirements": {
      // T1: DRAFT -> REQUIREMENTS_CONFIRMED
      const next: PurchaseState = {
        ...state,
        status: "REQUIREMENTS_CONFIRMED",
      };
      const events: AuditEventDraft[] = [
        {
          type: "requirements_confirmed",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {},
        },
      ];
      return { ok: true, next, events };
    }

    case "select_candidate": {
      // T2f: ORDER_CREATED, BUYER_APPROVED, CAPTURE_ATTEMPTED
      if (
        state.status === "ORDER_CREATED" ||
        state.status === "BUYER_APPROVED" ||
        state.status === "CAPTURE_ATTEMPTED"
      ) {
        return fail("change_blocked_by_open_payment", `Commercial change blocked by open payment in status ${state.status}`);
      }

      // T2e: APPROVED
      if (state.status === "APPROVED") {
        if (live !== null) {
          return fail("attempt_already_open", "Cannot select_candidate with open payment attempt");
        }
        if (!eff) {
          return fail("guard_failed", "no_effective_approval");
        }

        // Candidate-unchanged check
        if (isCandidateUnchanged(eff, command)) {
          return fail("guard_failed", "candidate_unchanged");
        }

        const propState = proposedState(state, command);
        const invReasons = deriveInvalidationReasons(eff, propState);

        if (invReasons.length === 0) {
          return fail("guard_failed", "no_change_to_reassess");
        }

        const nextApprovals: ApprovalFacts[] = state.approvals.map((a) => {
          if (a.id === eff.id) {
            return {
              ...a,
              invalidatedAt: context.now,
              invalidationReason: invReasons.join(","),
            };
          }
          return a;
        });

        const next: PurchaseState = {
          ...state,
          status: "EVALUATED",
          selectedCandidate: command.candidate,
          policyVersion: command.policyVersion,
          currentEvidenceFingerprint: null,
          policyEvidenceFingerprint: null,
          approvals: nextApprovals,
        };

        const events: AuditEventDraft[] = [
          {
            type: "approval_invalidated",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              approvalId: eff.id,
              reasons: invReasons,
            },
          },
          {
            type: "evaluated",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              candidateId: command.candidate.id,
              reason: "candidate_selected",
            },
          },
        ];

        return { ok: true, next, events };
      }

      // T2, T2b, T2c, T2d: REQUIREMENTS_CONFIRMED, EVALUATED, POLICY_PASSED, POLICY_BLOCKED
      if (live !== null) {
        return fail("attempt_already_open", "Cannot select_candidate with open payment attempt");
      }
      if (eff !== null) {
        return fail("guard_failed", "Effective approval present in non-APPROVED state");
      }

      const next: PurchaseState = {
        ...state,
        status: "EVALUATED",
        selectedCandidate: command.candidate,
        policyVersion: command.policyVersion,
        currentEvidenceFingerprint: null,
        policyEvidenceFingerprint: null,
      };

      const events: AuditEventDraft[] = [
        {
          type: "evaluated",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            candidateId: command.candidate.id,
            reason: "candidate_selected",
          },
        },
      ];

      return { ok: true, next, events };
    }

    case "evaluate": {
      // T3: EVALUATED
      if (!state.selectedCandidate) {
        return fail("guard_failed", "no_selected_candidate");
      }
      if (live !== null) {
        return fail("attempt_already_open", "Live payment attempt exists");
      }

      const events: AuditEventDraft[] = [
        {
          type: "evaluated",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            candidateId: state.selectedCandidate.id,
            reason: "evaluation_recorded",
          },
        },
      ];

      return { ok: true, next: { ...state }, events };
    }

    case "apply_policy_summary": {
      // Guard order per Section 6.2:
      // (1) summary condition -> checked in step 3
      // (2) command.policyVersion non-empty -> else guard_failed "policy_version_missing"
      if (!command.policyVersion || command.policyVersion.trim().length === 0) {
        return fail("guard_failed", "policy_version_missing");
      }
      // (3) selectedCandidate non-null -> else guard_failed "no_selected_candidate"
      if (!state.selectedCandidate) {
        return fail("guard_failed", "no_selected_candidate");
      }
      // (4) currentEvidenceFingerprint non-null -> else guard_failed "evidence_fingerprint_missing"
      if (state.currentEvidenceFingerprint === null) {
        return fail("guard_failed", "evidence_fingerprint_missing");
      }
      // (5) no LIVE exists -> else attempt_already_open
      if (live !== null) {
        return fail("attempt_already_open", "Live payment attempt exists");
      }

      if (command.summary.allRequiredPassed) {
        // T4: -> POLICY_PASSED
        // Require an actual 64-character lowercase hexadecimal SHA-256 fingerprint before transitioning to POLICY_PASSED
        if (state.currentEvidenceFingerprint.trim().length === 0) {
          return fail("guard_failed", "evidence_fingerprint_missing");
        }
        if (!isValidEvidenceFingerprint(state.currentEvidenceFingerprint)) {
          return fail("guard_failed", "evidence_fingerprint_invalid");
        }

        const next: PurchaseState = {
          ...state,
          status: "POLICY_PASSED",
          policyVersion: command.policyVersion,
          policyEvidenceFingerprint: state.currentEvidenceFingerprint,
        };
        const events: AuditEventDraft[] = [
          {
            type: "policy_passed",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              policyVersion: command.policyVersion,
            },
          },
        ];
        return { ok: true, next, events };
      } else {
        // T5: -> POLICY_BLOCKED
        const next: PurchaseState = {
          ...state,
          status: "POLICY_BLOCKED",
          policyVersion: command.policyVersion,
          policyEvidenceFingerprint: isValidEvidenceFingerprint(state.currentEvidenceFingerprint)
            ? state.currentEvidenceFingerprint
            : null,
        };
        const events: AuditEventDraft[] = [
          {
            type: "policy_blocked",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              blockingRuleKeys: [...command.summary.blockingRuleKeys],
              unknownRuleKeys: [...command.summary.unknownRuleKeys],
            },
          },
        ];
        return { ok: true, next, events };
      }
    }

    case "reevaluate": {
      if (state.status === "POLICY_BLOCKED") {
        // T6
        if (!state.selectedCandidate) {
          return fail("guard_failed", "no_selected_candidate");
        }
        if (live !== null) {
          return fail("attempt_already_open", "Live payment attempt exists");
        }
        const next: PurchaseState = {
          ...state,
          status: "EVALUATED",
        };
        const events: AuditEventDraft[] = [
          {
            type: "evaluated",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              candidateId: state.selectedCandidate.id,
              reason: "reevaluation_requested",
            },
          },
        ];
        return { ok: true, next, events };
      }

      if (state.status === "POLICY_PASSED") {
        // T7
        if (!state.selectedCandidate) {
          return fail("guard_failed", "no_selected_candidate");
        }
        if (state.currentEvidenceFingerprint === null || state.currentEvidenceFingerprint.trim().length === 0) {
          return fail("guard_failed", "evidence_fingerprint_missing");
        }
        if (state.policyEvidenceFingerprint === null || state.policyEvidenceFingerprint.trim().length === 0) {
          return fail("guard_failed", "evidence_fingerprint_missing");
        }
        if (!isValidEvidenceFingerprint(state.currentEvidenceFingerprint) || !isValidEvidenceFingerprint(state.policyEvidenceFingerprint)) {
          return fail("guard_failed", "evidence_fingerprint_invalid");
        }
        if (state.currentEvidenceFingerprint === state.policyEvidenceFingerprint) {
          return fail("guard_failed", "no_change_to_reassess");
        }

        const next: PurchaseState = {
          ...state,
          status: "EVALUATED",
          policyEvidenceFingerprint: null,
        };
        const events: AuditEventDraft[] = [
          {
            type: "evaluated",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              candidateId: state.selectedCandidate.id,
              reason: "reassessment_required",
            },
          },
        ];
        return { ok: true, next, events };
      }

      if (state.status === "APPROVED") {
        // T9
        if (!eff) {
          return fail("guard_failed", "no_effective_approval");
        }
        if (live !== null) {
          return fail("attempt_already_open", "Live payment attempt exists");
        }

        const invReasons = deriveInvalidationReasons(eff, state);
        if (invReasons.length === 0) {
          return fail("guard_failed", "no_change_to_reassess");
        }

        const nextApprovals: ApprovalFacts[] = state.approvals.map((a) => {
          if (a.id === eff.id) {
            return {
              ...a,
              invalidatedAt: context.now,
              invalidationReason: invReasons.join(","),
            };
          }
          return a;
        });

        const next: PurchaseState = {
          ...state,
          status: "EVALUATED",
          approvals: nextApprovals,
        };

        const events: AuditEventDraft[] = [
          {
            type: "approval_invalidated",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              approvalId: eff.id,
              reasons: invReasons,
            },
          },
          {
            type: "evaluated",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              candidateId: state.selectedCandidate?.id ?? null,
              reason: "reassessment_required",
            },
          },
        ];
        return { ok: true, next, events };
      }

      return fail("illegal_transition", `Cannot reevaluate from ${state.status}`);
    }

    case "approve": {
      // T8: POLICY_PASSED -> APPROVED
      if (!state.policyVersion) {
        return fail("guard_failed", "policy_version_missing");
      }
      if (!state.selectedCandidate) {
        return fail("guard_failed", "no_selected_candidate");
      }
      if (state.currentEvidenceFingerprint === null || state.currentEvidenceFingerprint.trim().length === 0) {
        return fail("guard_failed", "evidence_fingerprint_missing");
      }
      if (!isValidEvidenceFingerprint(state.currentEvidenceFingerprint)) {
        return fail("guard_failed", "evidence_fingerprint_invalid");
      }
      if (state.policyEvidenceFingerprint === null || state.policyEvidenceFingerprint.trim().length === 0) {
        return fail("guard_failed", "evidence_fingerprint_missing");
      }
      if (!isValidEvidenceFingerprint(state.policyEvidenceFingerprint)) {
        return fail("guard_failed", "evidence_fingerprint_invalid");
      }
      if (state.currentEvidenceFingerprint !== state.policyEvidenceFingerprint) {
        return fail("guard_failed", "evidence_fingerprint_mismatch");
      }
      if (eff !== null) {
        return fail("guard_failed", "Effective approval already exists");
      }
      if (live !== null) {
        return fail("attempt_already_open", "Live payment attempt exists");
      }

      const newApproval: ApprovalFacts = {
        id: context.newApprovalId!,
        purchaseId: state.purchaseId,
        candidateId: state.selectedCandidate.id,
        snapshotHash: state.selectedCandidate.snapshotHash,
        totalCents: state.selectedCandidate.totalCents,
        currency: state.selectedCandidate.currency,
        policyVersion: state.policyVersion,
        evidenceFingerprint: state.currentEvidenceFingerprint,
        approverUserId: (context.actor as { kind: "user"; userId: string }).userId,
        approvedAt: context.now,
        invalidatedAt: null,
        invalidationReason: null,
      };

      const next: PurchaseState = {
        ...state,
        status: "APPROVED",
        approvals: [...state.approvals, newApproval],
      };

      const events: AuditEventDraft[] = [
        {
          type: "approved",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            approvalId: newApproval.id,
            candidateId: newApproval.candidateId,
            snapshotHash: newApproval.snapshotHash,
            totalCents: newApproval.totalCents,
            currency: newApproval.currency,
            policyVersion: newApproval.policyVersion,
            evidenceFingerprint: newApproval.evidenceFingerprint,
            approverUserId: newApproval.approverUserId,
          },
        },
      ];

      return { ok: true, next, events };
    }

    case "create_order": {
      // T10: APPROVED -> ORDER_CREATED
      if (!eff) {
        return fail("guard_failed", "no_effective_approval");
      }
      if (live !== null) {
        return fail("attempt_already_open", "Live payment attempt already exists");
      }

      // Check staleness via INV(EFF)
      const invReasons = deriveInvalidationReasons(eff, state);
      if (invReasons.length > 0) {
        return fail("approval_invalidated", `Approval is stale: ${invReasons.join(",")}`);
      }

      // Amount match check
      const cand = state.selectedCandidate;
      if (!cand) {
        return fail("guard_failed", "no_selected_candidate");
      }
      const derivedTotal = deriveTotalCents(cand.unitPriceCents, cand.quantity, cand.shippingCents);
      if (eff.totalCents !== derivedTotal) {
        return fail("amount_mismatch", `Approval total ${eff.totalCents} does not match derived total ${derivedTotal}`);
      }

      const newAttempt: PaymentAttemptFacts = {
        id: context.newPaymentAttemptId!,
        purchaseId: state.purchaseId,
        approvalId: eff.id,
        idempotencyKey: command.idempotencyKey,
        paypalOrderId: command.paypalOrderId,
        status: "OPEN",
        requestedIntent: "AUTHORIZE",
        verifiedStatus: null,
        verifiedAt: null,
        failureReason: null,
      };

      const next: PurchaseState = {
        ...state,
        status: "ORDER_CREATED",
        paymentAttempts: [...state.paymentAttempts, newAttempt],
      };

      const events: AuditEventDraft[] = [
        {
          type: "order_created",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            paymentAttemptId: newAttempt.id,
            approvalId: eff.id,
            paypalOrderId: command.paypalOrderId,
            totalCents: eff.totalCents,
            requestedIntent: "AUTHORIZE",
          },
        },
      ];

      return { ok: true, next, events };
    }

    case "observe_paypal_order": {
      if (!live) {
        return fail("inconsistent_state", "No LIVE payment attempt found");
      }
      if (command.observation.orderId !== live.paypalOrderId) {
        return fail("order_id_mismatch", `Observed orderId ${command.observation.orderId} does not match LIVE attempt orderId ${live.paypalOrderId}`);
      }

      if (state.status === "ORDER_CREATED") {
        // T11
        if (command.observation.status === "APPROVED") {
          const nextAttempts: PaymentAttemptFacts[] = state.paymentAttempts.map((a) => {
            if (a.id === live.id) {
              return {
                ...a,
                verifiedStatus: "APPROVED",
                verifiedAt: command.observation.observedAt,
              };
            }
            return a;
          });

          const next: PurchaseState = {
            ...state,
            status: "BUYER_APPROVED",
            paymentAttempts: nextAttempts,
          };

          const events: AuditEventDraft[] = [
            {
              type: "buyer_approved",
              purchaseId: state.purchaseId,
              actor: context.actor,
              occurredAt: context.now,
              payload: {
                paymentAttemptId: live.id,
                paypalOrderId: live.paypalOrderId!,
                verifiedStatus: "APPROVED",
                observedAt: command.observation.observedAt.toISOString(),
              },
            },
          ];

          return { ok: true, next, events };
        } else if (
          command.observation.status === "CREATED" ||
          command.observation.status === "PAYER_ACTION_REQUIRED"
        ) {
          return fail("payment_not_yet_approved", `Payment order is in status ${command.observation.status}`);
        } else {
          return fail("unexpected_paypal_status", `Unexpected PayPal status in ORDER_CREATED: ${command.observation.status}`);
        }
      }

      if (state.status === "CAPTURE_ATTEMPTED") {
        if (command.observation.status === "COMPLETED") {
          // T13: -> COMPLETED
          const nextAttempts: PaymentAttemptFacts[] = state.paymentAttempts.map((a) => {
            if (a.id === live.id) {
              return {
                ...a,
                status: "COMPLETED",
                verifiedStatus: "COMPLETED",
                verifiedAt: command.observation.observedAt,
                failureReason: null,
              };
            }
            return a;
          });

          const next: PurchaseState = {
            ...state,
            status: "COMPLETED",
            paymentAttempts: nextAttempts,
          };

          const events: AuditEventDraft[] = [
            {
              type: "completed",
              purchaseId: state.purchaseId,
              actor: context.actor,
              occurredAt: context.now,
              payload: {
                paymentAttemptId: live.id,
                paypalOrderId: live.paypalOrderId!,
                verifiedStatus: "COMPLETED",
                observedAt: command.observation.observedAt.toISOString(),
              },
            },
          ];

          return { ok: true, next, events };
        } else {
          // T14: -> FAILED
          const nextAttempts: PaymentAttemptFacts[] = state.paymentAttempts.map((a) => {
            if (a.id === live.id) {
              return {
                ...a,
                status: "FAILED",
                verifiedStatus: command.observation.status,
                verifiedAt: command.observation.observedAt,
                failureReason: "verified_status_not_completed",
              };
            }
            return a;
          });

          const next: PurchaseState = {
            ...state,
            status: "FAILED",
            paymentAttempts: nextAttempts,
          };

          const events: AuditEventDraft[] = [
            {
              type: "failed",
              purchaseId: state.purchaseId,
              actor: context.actor,
              occurredAt: context.now,
              payload: {
                paymentAttemptId: live.id,
                source: "verified_status",
                reason: "verified_status_not_completed",
                verifiedStatus: command.observation.status,
              },
            },
          ];

          return { ok: true, next, events };
        }
      }

      return fail("illegal_transition", `Cannot observe_paypal_order from ${state.status}`);
    }

    case "record_capture_attempt": {
      // T12: BUYER_APPROVED -> CAPTURE_ATTEMPTED
      if (!live || !live.paypalOrderId) {
        return fail("inconsistent_state", "No LIVE payment attempt with orderId found");
      }

      const next: PurchaseState = {
        ...state,
        status: "CAPTURE_ATTEMPTED",
      };

      const events: AuditEventDraft[] = [
        {
          type: "capture_attempted",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            paymentAttemptId: live.id,
          },
        },
      ];

      return { ok: true, next, events };
    }

    case "record_capture_rejected": {
      // T15: CAPTURE_ATTEMPTED -> FAILED
      if (!live) {
        return fail("inconsistent_state", "No LIVE payment attempt found");
      }

      const nextAttempts: PaymentAttemptFacts[] = state.paymentAttempts.map((a) => {
        if (a.id === live.id) {
          return {
            ...a,
            status: "FAILED",
            failureReason: command.reason,
          };
        }
        return a;
      });

      const next: PurchaseState = {
        ...state,
        status: "FAILED",
        paymentAttempts: nextAttempts,
      };

      const events: AuditEventDraft[] = [
        {
          type: "failed",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            paymentAttemptId: live.id,
            source: "capture_rejected",
            reason: command.reason,
            verifiedStatus: null,
          },
        },
      ];

      return { ok: true, next, events };
    }

    case "cancel": {
      // Section 8.5 cancellation invariant:
      // At most one LIVE attempt exists.
      // If a LIVE attempt exists, T16 applies only when purchase status is ORDER_CREATED or BUYER_APPROVED.
      // A LIVE attempt in any other purchase status is inconsistent_state.
      if (live !== null) {
        if (state.status !== "ORDER_CREATED" && state.status !== "BUYER_APPROVED") {
          return fail("inconsistent_state", `LIVE attempt cannot be cancelled from status ${state.status}`);
        }
      }

      if (state.status === "DRAFT") {
        // T17: DRAFT -> CANCELLED
        if (live !== null) {
          return fail("inconsistent_state", "LIVE attempt present in DRAFT");
        }

        const next: PurchaseState = {
          ...state,
          status: "CANCELLED",
        };

        const events: AuditEventDraft[] = [
          {
            type: "cancelled",
            purchaseId: state.purchaseId,
            actor: context.actor,
            occurredAt: context.now,
            payload: {
              fromStatus: "DRAFT",
              paymentAttemptId: null,
              reason: command.reason,
            },
          },
        ];

        return { ok: true, next, events };
      }

      // T16: REQUIREMENTS_CONFIRMED, EVALUATED, POLICY_BLOCKED, POLICY_PASSED, APPROVED, ORDER_CREATED, BUYER_APPROVED
      let nextAttempts = state.paymentAttempts;
      let cancelledAttemptId: string | null = null;

      if (live !== null) {
        cancelledAttemptId = live.id;
        nextAttempts = state.paymentAttempts.map((a) => {
          if (a.id === live.id) {
            return {
              ...a,
              status: "CANCELLED",
              failureReason: command.reason,
            };
          }
          return a;
        });
      }

      const next: PurchaseState = {
        ...state,
        status: "CANCELLED",
        paymentAttempts: nextAttempts,
      };

      const events: AuditEventDraft[] = [
        {
          type: "cancelled",
          purchaseId: state.purchaseId,
          actor: context.actor,
          occurredAt: context.now,
          payload: {
            fromStatus: state.status,
            paymentAttemptId: cancelledAttemptId,
            reason: command.reason,
          },
        },
      ];

      return { ok: true, next, events };
    }
  }
}
