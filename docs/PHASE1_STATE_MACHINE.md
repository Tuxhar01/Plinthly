# Phase 1 Purchase State Machine Documentation

Internal Working Title: **Purchase Assurance** (internal only; brand not cleared for public release).

---

## 1. Scope and Architecture Overview

The Phase 1 Purchase Domain State Machine is a pure, deterministic TypeScript module located in `lib/state/`. It has:
- **Zero I/O, network, database, or external process calls.**
- **Pure clock isolation:** Transitions never call `Date.now()`, `Math.random()`, or `new Date()`. The caller supplies `context.now`.
- **Immutability:** States are never mutated in place. All transitions produce new state objects and event arrays, or an error.
- **Fail-safe rejections:** Rejected transitions return `{ ok: false, error: { code, message } }`, never mutating state and never emitting events.

---

## 2. Domain Enumerations and Facts

### Enumerations
- **PurchaseStatus (12 values):** `DRAFT`, `REQUIREMENTS_CONFIRMED`, `EVALUATED`, `POLICY_BLOCKED`, `POLICY_PASSED`, `APPROVED`, `ORDER_CREATED`, `BUYER_APPROVED`, `CAPTURE_ATTEMPTED`, `COMPLETED`, `FAILED`, `CANCELLED`.
- **PaymentAttemptStatus (4 values):** `OPEN`, `COMPLETED`, `FAILED`, `CANCELLED`.
- **CandidateSource (2 values):** `channel3`, `seeded`.
- **EvidenceStatus (3 values):** `supports`, `contradicts`, `missing`.
- **PolicyOutcome (3 values):** `pass`, `block`, `unknown`.
- **AuditEventType (13 values):** `proposed`, `requirements_confirmed`, `evaluated`, `policy_blocked`, `policy_passed`, `approved`, `approval_invalidated`, `order_created`, `buyer_approved`, `capture_attempted`, `completed`, `failed`, `cancelled`.
- **PayPalOrderStatus (5 values):** `CREATED`, `PAYER_ACTION_REQUIRED`, `APPROVED`, `COMPLETED`, `VOIDED`.
- **InvalidationReason (6 values):** `candidate_changed`, `snapshot_hash_changed`, `total_changed`, `currency_changed`, `policy_version_changed`, `evidence_fingerprint_changed`.

---

## 3. Authoritative Transition Table

| # | From | Command | Guards (in order) | To | Effects | Events (in order) |
|---|---|---|---|---|---|---|
| T1 | DRAFT | confirm_requirements | none | REQUIREMENTS_CONFIRMED | none | `requirements_confirmed` |
| T2 | REQUIREMENTS_CONFIRMED | select_candidate | candidate valid per section 8.1; no LIVE; no EFF | EVALUATED | `selectedCandidate := candidate; policyVersion := command.policyVersion; currentEvidenceFingerprint := null; policyEvidenceFingerprint := null` | `evaluated(candidateId: candidate.id, reason: candidate_selected)` |
| T2b | EVALUATED | select_candidate | candidate valid per section 8.1; no LIVE; no EFF | EVALUATED | as T2 | `evaluated(candidateId: candidate.id, reason: candidate_selected)` |
| T2c | POLICY_PASSED | select_candidate | candidate valid per section 8.1; no LIVE; no EFF | EVALUATED | as T2 | `evaluated(candidateId: candidate.id, reason: candidate_selected)` |
| T2d | POLICY_BLOCKED | select_candidate | candidate valid per section 8.1; no LIVE; no EFF | EVALUATED | as T2 | `evaluated(candidateId: candidate.id, reason: candidate_selected)` |
| T2e | APPROVED | select_candidate | candidate valid per section 8.1; no LIVE; EFF exists; candidate-unchanged check (section 8.3A) passes; INV'(EFF, command) non-empty | EVALUATED | `EFF.invalidatedAt := now; EFF.invalidationReason := INV'(EFF, command).join(","); selectedCandidate := candidate; policyVersion := command.policyVersion; currentEvidenceFingerprint := null; policyEvidenceFingerprint := null` | `approval_invalidated(approvalId: EFF.id, reasons: INV'(EFF, command))`, then `evaluated(candidateId: candidate.id, reason: candidate_selected)` |
| T2f | ORDER_CREATED, BUYER_APPROVED, CAPTURE_ATTEMPTED | select_candidate | none beyond precedence | unchanged | none | none (error: `change_blocked_by_open_payment`) |
| T3 | EVALUATED | evaluate | `selectedCandidate` non-null (else guard_failed "no_selected_candidate"); no LIVE | EVALUATED | none | `evaluated(candidateId: selectedCandidate.id, reason: evaluation_recorded)` |
| T4 | EVALUATED | apply_policy_summary | Per section 6.2: (1) `summary.allRequiredPassed === true`; (2) `command.policyVersion` non-empty (else guard_failed "policy_version_missing"); (3) `selectedCandidate` non-null (else guard_failed "no_selected_candidate"); (4) `currentEvidenceFingerprint` non-null (else guard_failed "evidence_fingerprint_missing"); (5) no LIVE (else `attempt_already_open`) | POLICY_PASSED | `policyVersion := command.policyVersion; policyEvidenceFingerprint := currentEvidenceFingerprint` | `policy_passed(policyVersion)` |
| T5 | EVALUATED | apply_policy_summary | Per section 6.2: (1) `summary.allRequiredPassed === false` and at least one blocking or unknown key; (2) `command.policyVersion` non-empty (else guard_failed "policy_version_missing"); (3) `selectedCandidate` non-null (else guard_failed "no_selected_candidate"); (4) `currentEvidenceFingerprint` non-null (else guard_failed "evidence_fingerprint_missing"); (5) no LIVE (else `attempt_already_open`) | POLICY_BLOCKED | `policyVersion := command.policyVersion; policyEvidenceFingerprint := currentEvidenceFingerprint` | `policy_blocked(blockingRuleKeys, unknownRuleKeys)` |
| T6 | POLICY_BLOCKED | reevaluate | `selectedCandidate` non-null (else guard_failed "no_selected_candidate"); no LIVE | EVALUATED | none | `evaluated(candidateId: selectedCandidate.id, reason: reevaluation_requested)` |
| T7 | POLICY_PASSED | reevaluate | `selectedCandidate` non-null (else guard_failed "no_selected_candidate"); `currentEvidenceFingerprint` non-null (else guard_failed "evidence_fingerprint_missing"); `policyEvidenceFingerprint` non-null (else guard_failed "evidence_fingerprint_missing"); `currentEvidenceFingerprint !== policyEvidenceFingerprint` (else guard_failed "no_change_to_reassess") | EVALUATED | `policyEvidenceFingerprint := null` | `evaluated(candidateId: selectedCandidate.id, reason: reassessment_required)` |
| T8 | POLICY_PASSED | approve | `actor.kind === "user"`; `policyVersion` non-null (else guard_failed "policy_version_missing"); `selectedCandidate` non-null (else guard_failed "no_selected_candidate"); `currentEvidenceFingerprint` non-null (else guard_failed "evidence_fingerprint_missing"); `newApprovalId` supplied; no EFF; no LIVE | APPROVED | append new approval per section 8.2 | `approved` |
| T9 | APPROVED | reevaluate | EFF exists (else guard_failed "no_effective_approval"); no LIVE; `INV(EFF)` non-empty (else guard_failed "no_change_to_reassess") | EVALUATED | `EFF.invalidatedAt := now; EFF.invalidationReason := INV(EFF).join(",")` | `approval_invalidated(approvalId: EFF.id, reasons: INV(EFF))`, then `evaluated(candidateId: selectedCandidate.id, reason: reassessment_required)` |
| T10 | APPROVED | create_order | actor any; EFF exists (else guard_failed "no_effective_approval"); no LIVE (else `attempt_already_open`); `newPaymentAttemptId` supplied (else `invalid_input`); `command.idempotencyKey` and `command.paypalOrderId` non-empty (else `invalid_input`); `INV(EFF)` empty (else `approval_invalidated`, section 8.8, no state change); `EFF.totalCents` equals `deriveTotalCents(selectedCandidate)` (else `amount_mismatch`) | ORDER_CREATED | append new attempt: `status: OPEN, approvalId: EFF.id, purchaseId: state.purchaseId, idempotencyKey: command.idempotencyKey, paypalOrderId: command.paypalOrderId, verifiedStatus: null, verifiedAt: null, failureReason: null` | `order_created` |
| T11 | ORDER_CREATED | observe_paypal_order | LIVE exists; `observation.orderId === LIVE.paypalOrderId` (else `order_id_mismatch`); `observation.status === "APPROVED"` | BUYER_APPROVED | `LIVE.verifiedStatus := "APPROVED"; LIVE.verifiedAt := observation.observedAt` | `buyer_approved` |
| T12 | BUYER_APPROVED | record_capture_attempt | LIVE exists; `LIVE.paypalOrderId` non-null | CAPTURE_ATTEMPTED | none | `capture_attempted` |
| T13 | CAPTURE_ATTEMPTED | observe_paypal_order | LIVE exists; `observation.orderId === LIVE.paypalOrderId` (else `order_id_mismatch`); `observation.status === "COMPLETED"` | COMPLETED | `LIVE.status := COMPLETED; LIVE.verifiedStatus := "COMPLETED"; LIVE.verifiedAt := observation.observedAt; LIVE.failureReason := null` | `completed` |
| T14 | CAPTURE_ATTEMPTED | observe_paypal_order | LIVE exists; `observation.orderId === LIVE.paypalOrderId` (else `order_id_mismatch`); `observation.status` is a valid `PayPalOrderStatus` other than `"COMPLETED"` | FAILED | `LIVE.status := FAILED; LIVE.verifiedStatus := observation.status; LIVE.verifiedAt := observation.observedAt; LIVE.failureReason := "verified_status_not_completed"` | `failed(paymentAttemptId: LIVE.id, source: verified_status, reason: "verified_status_not_completed", verifiedStatus: observation.status)` |
| T15 | CAPTURE_ATTEMPTED | record_capture_rejected | LIVE exists; `command.reason` non-empty | FAILED | `LIVE.status := FAILED; LIVE.failureReason := command.reason` | `failed(paymentAttemptId: LIVE.id, source: capture_rejected, reason: command.reason, verifiedStatus: null)` |
| T16 | REQUIREMENTS_CONFIRMED, EVALUATED, POLICY_BLOCKED, POLICY_PASSED, APPROVED, ORDER_CREATED, BUYER_APPROVED | cancel | `command.reason` non-empty; section 8.5 cancellation invariant holds | CANCELLED | if LIVE exists: `LIVE.status := CANCELLED; LIVE.failureReason := command.reason; LIVE.paypalOrderId` retained | `cancelled(fromStatus, paymentAttemptId: LIVE.id or null)` |
| T17 | DRAFT | cancel | `command.reason` non-empty; no LIVE | CANCELLED | none | `cancelled(fromStatus: DRAFT, paymentAttemptId: null)` |

---

## 4. Error Precedence Rules

### 4.1 Global Precedence (Section 6.1)
1. **Command not permitted from current status** → `illegal_transition`.
2. **Actor not permitted for command** → `invalid_actor` (`approve` requires `actor.kind === "user"`).
3. **Input invalid** → `invalid_input` (negative/overflow money, non-USD currency, malformed 64-char hex hashes, missing IDs, empty reasons).
4. **State-integrity checks (P1 to P9 in order)** → `cross_purchase_reference` or `inconsistent_state`.
5. **Transition-specific guards** in table row order.

### 4.2 Guard-Order Rule for T4 and T5 (Section 6.2) & Precedence Resolution
T4 and T5 preserve the strict Section 6.1 global error precedence:
1. Summary condition check runs in Step 3 (`invalid_input` if summary format is invalid).
2. Step 4 integrity checks (P1 to P9) run before any transition-specific guards. Under Rule P8, an OPEN attempt in status `EVALUATED` is an integrity defect and is rejected with `inconsistent_state`.
3. Transition-specific guards run in Step 5 (after P1–P9) in Section 6.2 order:
   - `command.policyVersion` non-empty → otherwise `guard_failed`, reason `"policy_version_missing"`.
   - `selectedCandidate` non-null → otherwise `guard_failed`, reason `"no_selected_candidate"`.
   - `currentEvidenceFingerprint` non-null → otherwise `guard_failed`, reason `"evidence_fingerprint_missing"`.
   - No LIVE attempt exists → otherwise `attempt_already_open`.

**Note on `attempt_already_open`:** Under the authoritative transition table and Rule P8, an OPEN attempt in `EVALUATED` is intercepted at Step 4 by P8 (`inconsistent_state`). Guard 5 is retained as defensive code in case transition guards are evaluated without integrity checking, but cannot be reached under standard Step 4 integrity enforcement.

---

## 5. Approval Invalidation and Stale Approval Handling

### 5.1 Invalidation Reasons Derivation (Fixed Order)
1. `"candidate_changed"` if `selectedCandidate === null` or `selectedCandidate.id !== approval.candidateId`.
2. Only if `selectedCandidate.id === approval.candidateId`:
   - `"snapshot_hash_changed"` if candidate snapshotHash differs.
   - `"total_changed"` if candidate totalCents differs.
   - `"currency_changed"` if candidate currency differs.
3. `"policy_version_changed"` if `state.policyVersion !== approval.policyVersion`.
4. `"evidence_fingerprint_changed"` if `state.currentEvidenceFingerprint !== approval.evidenceFingerprint` (null is a mismatch).

### 5.2 Proposed-State Derivation for T2e (Section 8.3A)
- Checks candidate unchanged first: if identical candidate commercial facts and policy version, returns `guard_failed` (`"candidate_unchanged"`).
- Uses `proposedState(state, command)`:
  - If proposed candidate ID and snapshot hash match the old candidate, and current evidence fingerprint is non-null, the known fingerprint is preserved (representing unchanged evidence identity).
  - Otherwise, `currentEvidenceFingerprint` is set to `null` (evidence identity changed and must be recomputed).
- Rejection if `INV'` is empty (`guard_failed`, reason `"no_change_to_reassess"`).

### 5.3 Stale Approval at Order Creation (Section 8.8)
- **T10 is pure rejection:** If `INV(EFF)` is non-empty, T10 returns error `approval_invalidated` with reasons in message. State is NOT mutated; approval is NOT invalidated; zero events emitted.
- **Persistence via T9:** The caller must invoke `reevaluate` (T9) from `APPROVED` to persist invalidation and transition to `EVALUATED`.

---

## 6. Attempt Lifecycle and Cancellation

- At most one LIVE (`status === "OPEN"`) payment attempt per purchase.
- Terminal outcomes:
  - `T13`: `COMPLETED`
  - `T14`, `T15`: `FAILED`
  - `T16`: `CANCELLED`
- Cancellation never voids a PayPal order; `paypalOrderId` is preserved.
