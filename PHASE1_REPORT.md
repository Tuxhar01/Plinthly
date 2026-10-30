# Phase 1 Verification and Domain Architecture Report

Internal Working Title: **Purchase Assurance** (internal only; brand not cleared for public release).

---

## 1. Requirement Classification

| Tag | Requirement Description | Status |
|---|---|---|
| [BP] | Purchase status lifecycle (12 states: `DRAFT`, `REQUIREMENTS_CONFIRMED`, `EVALUATED`, `POLICY_BLOCKED`, `POLICY_PASSED`, `APPROVED`, `ORDER_CREATED`, `BUYER_APPROVED`, `CAPTURE_ATTEMPTED`, `COMPLETED`, `FAILED`, `CANCELLED`) | Implemented |
| [BP] | Cancellation allowed from any state before `CAPTURE_ATTEMPTED` | Implemented |
| [BP] | Approval binding: selected candidate, snapshot hash, total amount/currency, policy version, approver timestamp | Implemented |
| [BP] | Invalidation triggers: candidate change, amount change, snapshot change, policy version change, evidence freshness change. Cleared approval returns purchase to `EVALUATED` | Implemented |
| [BP] | Integer cents with ISO currency code; no floating-point arithmetic | Implemented |
| [BP] | Order creation uses server-derived total from stored candidate facts, not client amount | Implemented |
| [BP] | `BUYER_APPROVED` requires verified PayPal `APPROVED` status; redirect alone insufficient | Implemented |
| [BP] | `CAPTURE_ATTEMPTED` persisted before capture dispatched (write-ordering invariant; no capture code in Phase 1) | Implemented |
| [BP] | `COMPLETED` requires independent verification showing `COMPLETED` | Implemented |
| [BP] | Rejected capture or verified non-COMPLETED status results in `FAILED` | Implemented |
| [BP] | At most one live (`OPEN`) payment attempt per purchase | Implemented |
| [BP] | Audit event types (13 values, including additions) | Implemented |
| [BP] | Currency USD only (Pactora blueprint Section 8) | Implemented |
| [ADD] | Audit event `requirements_confirmed` (added to event list) | Implemented |
| [ADD] | Approval fields `evidenceFingerprint` and `approverUserId` | Implemented |
| [ADD] | PaymentAttempt fields `verifiedStatus`, `verifiedAt`, `failureReason`, and `purchaseId` | Implemented |
| [ADD] | PurchaseState field `policyEvidenceFingerprint` | Implemented |
| [ADD] | Audit payload field `paymentAttemptId` on `buyer_approved`, `completed`, `failed`, `cancelled` | Implemented |
| [ADD] | Enums for statuses, sources, outcomes, and event types | Implemented |
| [ADD] | Composite-key and purchase-consistency database foreign keys and pure integrity guards P1–P9 | Implemented |
| [ADD] | Proposed-state derivation for `select_candidate` from `APPROVED` (T2e / Section 8.3A) | Implemented |
| [OD] | OD-1: Retry after `FAILED` — default implemented: `FAILED` is terminal; no transition leaves `FAILED`. Attempt-level guard implemented | Implemented (Default) |
| [OD] | OD-2: Inconclusive capture — default implemented: purchase remains in `CAPTURE_ATTEMPTED`; no state change | Implemented (Default) |
| [OD] | OD-3: Freshness window — default implemented: invalidation by evidence fingerprint change only; no age-based window | Implemented (Default) |
| [OD] | OD-4: Policy override — default implemented: not permitted; exit from `POLICY_BLOCKED` only via reevaluation | Implemented (Default) |
| [OD] | OD-5: Commercial change after `ORDER_CREATED` — default implemented: rejected with `change_blocked_by_open_payment` | Implemented (Default) |

---

## 2. Files Created and Modified

### Created Files:
1. `lib/state/types.ts`
2. `lib/state/transitions.ts`
3. `lib/state/approval.ts`
4. `lib/state/snapshot.ts`
5. `lib/state/money.ts`
6. `lib/state/policy-summary.ts`
7. `lib/audit/events.ts`
8. `lib/audit/writer.ts`
9. `prisma/migrations/20261020124600_phase1_domain/migration.sql`
10. `tests/state/transitions.test.ts`
11. `tests/state/approval.test.ts`
12. `tests/state/integrity.test.ts`
13. `tests/state/money-snapshot.test.ts`
14. `tests/state/policy-summary.test.ts`
15. `tests/state/source-hygiene.test.ts`
16. `tests/audit/writer.test.ts`
17. `docs/PHASE1_STATE_MACHINE.md`
18. `PHASE1_REPORT.md`

### Modified Files:
1. `prisma/schema.prisma` (Preserved generator `client` and datasource `db` exactly; added 6 enums and 7 models).

No other files beyond those listed were created or modified.

---

## 3. Authoritative Transition Table as Implemented

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

### Error-returning Behaviours:
- `ORDER_CREATED` + `observe_paypal_order` with `status: CREATED` or `PAYER_ACTION_REQUIRED` and matching `orderId` → `payment_not_yet_approved`.
- `ORDER_CREATED` + `observe_paypal_order` with `status: VOIDED`, `COMPLETED`, or any other status and matching `orderId` → `unexpected_paypal_status`.
- `CAPTURE_ATTEMPTED` + `observe_paypal_order` with valid non-COMPLETED status is T14, not an error.
- Any `observe_paypal_order` with an unknown status string → `unexpected_paypal_status`.
- `observe_paypal_order` from any status other than `ORDER_CREATED` or `CAPTURE_ATTEMPTED` → `illegal_transition`.
- `record_capture_attempt`, `record_capture_rejected`, `approve`, `create_order`, and `evaluate` from any status not listed in table → `illegal_transition`.
- `select_candidate` from `DRAFT`, `COMPLETED`, `FAILED`, or `CANCELLED` → `illegal_transition`.
- `reevaluate` from any status other than `POLICY_BLOCKED`, `POLICY_PASSED`, or `APPROVED` → `illegal_transition`.

---

## 4. Error Precedence

### Global Precedence Order (Section 6.1):
1. **Command permitted from status** → `illegal_transition`
2. **Actor permitted for command** → `invalid_actor`
3. **Input validation** → `invalid_input`
4. **State-integrity checks (P1 to P9 in order)** → `cross_purchase_reference` or `inconsistent_state`
5. **Transition-specific guards in table row order**

Demonstrated in:
- `tests/state/transitions.test.ts`: "Precedence: APPROVED input whose effective approval candidateId differs is rejected by P2 before T9/T10"
- `tests/state/transitions.test.ts`: "checks all 132 pairs for illegal_transition vs permitted transition"

### Guard-Order Rule for T4 and T5 (Section 6.2) & Resolution:
1. Summary condition check runs in Step 3 (`invalid_input` if summary condition invalid)
2. Step 4 integrity checks (P1 to P9) run before transition-specific guards. Under Rule P8, an OPEN attempt in `EVALUATED` is an integrity defect and returns `inconsistent_state`.
3. Transition-specific guards run in Step 5 (after P1–P9) in Section 6.2 order:
   - `command.policyVersion` non-empty → otherwise `guard_failed` (`policy_version_missing`)
   - `selectedCandidate` non-null → otherwise `guard_failed` (`no_selected_candidate`)
   - `currentEvidenceFingerprint` non-null → otherwise `guard_failed` (`evidence_fingerprint_missing`)
   - No LIVE attempt exists → otherwise `attempt_already_open`

**Note on `attempt_already_open`:** Under strict Section 6.1 precedence and Rule P8, an OPEN attempt in `EVALUATED` is intercepted at Step 4 by P8 (`inconsistent_state`). Guard 5 is retained in code as defensive handling, but cannot be reached under standard Step 4 integrity enforcement.

Demonstrated in:
- `tests/state/transitions.test.ts`:
  - `T4 precedence sequence > Step 1: Invalid summary -> invalid_input`
  - `T4 precedence sequence > Step 2: Empty policy version -> guard_failed 'policy_version_missing'`
  - `T4 precedence sequence > Step 3: Missing selected candidate -> guard_failed 'no_selected_candidate'`
  - `T4 precedence sequence > Step 4: Missing evidence fingerprint -> guard_failed 'evidence_fingerprint_missing'`
  - `T4 precedence sequence > Precedence P8 over T4: An OPEN attempt in EVALUATED returns inconsistent_state before T4 guards`
  - `T5 precedence sequence > Step 1: Invalid summary -> invalid_input`
  - `T5 precedence sequence > Step 2: Empty policy version -> guard_failed 'policy_version_missing'`
  - `T5 precedence sequence > Step 3: Missing selected candidate -> guard_failed 'no_selected_candidate'`
  - `T5 precedence sequence > Step 4: Missing evidence fingerprint -> guard_failed 'evidence_fingerprint_missing'`
  - `T5 precedence sequence > Precedence P8 over T5: An OPEN attempt in EVALUATED returns inconsistent_state before T5 guards`

---

## 5. Approval Invalidation

### Derivation Rules:
- Current facts derivation: fixed order (1) `candidate_changed`, (2) `snapshot_hash_changed`, `total_changed`, `currency_changed`, (3) `policy_version_changed`, (4) `evidence_fingerprint_changed`.
- T2e Proposed-State derivation (`proposedState`):
  - Preserves known `currentEvidenceFingerprint` when `selectedCandidate` is non-null, candidate IDs match, `snapshotHash` matches, and current fingerprint is non-null.
  - Sets proposed fingerprint to `null` when candidate/evidence identity changes or was null.
  - Candidate-unchanged check rejects identical commercial facts and policy version with `guard_failed` (`candidate_unchanged`).

Demonstrated in:
- `tests/state/approval.test.ts`:
  - `detects candidate_changed when selectedCandidate id differs`
  - `candidate_changed suppresses snapshot, total, and currency comparisons`
  - `detects snapshot_hash_changed`
  - `detects total_changed`
  - `detects currency_changed`
  - `detects policy_version_changed`
  - `detects evidence_fingerprint_changed`
  - `detects evidence_fingerprint_changed when currentEvidenceFingerprint is null and approval has value`
  - `returns multiple reasons in fixed order when multiple fields change`
  - `preserves known fingerprint for policy-version-only change with identical candidate id and snapshotHash`
  - `sets proposed fingerprint to null when candidate id changes`
  - `sets proposed fingerprint to null when snapshotHash changes`
  - `detects candidate_unchanged when all fields match EFF`

---

## 6. Stale Approval Handling (Section 8.8)

- **T10 is pure rejection:** When `create_order` finds `INV(EFF)` non-empty, it returns `{ ok: false, error: { code: "approval_invalidated", message: "..." } }`. State is unchanged and zero events are emitted.
- **T9 persists invalidation:** The caller issues `reevaluate` (T9) from `APPROVED`, which persists invalidation by setting `invalidatedAt := now` and `invalidationReason := INV(EFF).join(",")`, transitioning the purchase to `EVALUATED`.

Demonstrated in:
- `tests/state/transitions.test.ts`: `T10 on stale approval (policy version changed in state) returns approval_invalidated without state change`
- `tests/state/transitions.test.ts`: `T9 persists invalidation after stale T10 rejection`
- `tests/state/transitions.test.ts`: `Precedence: APPROVED input whose effective approval candidateId differs is rejected by P2 before T9/T10`

---

## 7. Attempt Lifecycle

- A purchase has at most one live attempt (`status === "OPEN"`).
- Terminal attempt status transitions:
  - `T13`: `OPEN` → `COMPLETED`
  - `T14`: `OPEN` → `FAILED` (verified status non-COMPLETED)
  - `T15`: `OPEN` → `FAILED` (capture rejected)
  - `T16`: `OPEN` → `CANCELLED` (cancellation during `ORDER_CREATED` or `BUYER_APPROVED`)
- No transition leaves an attempt `OPEN` after its terminal outcome.

Demonstrated in:
- `tests/state/transitions.test.ts`: `T13: CAPTURE_ATTEMPTED + observe_paypal_order (COMPLETED) -> COMPLETED`
- `tests/state/transitions.test.ts`: `T14: CAPTURE_ATTEMPTED + observe_paypal_order (non-COMPLETED) -> FAILED`
- `tests/state/transitions.test.ts`: `T14 with each non-COMPLETED status at CAPTURE_ATTEMPTED moves to FAILED`
- `tests/state/transitions.test.ts`: `T15: CAPTURE_ATTEMPTED + record_capture_rejected -> FAILED`
- `tests/state/transitions.test.ts`: `T16: cancel from ORDER_CREATED with LIVE attempt -> CANCELLED`
- `tests/state/transitions.test.ts`: `after every successful cancel, no attempt has status OPEN`

---

## 8. Cancellation

- Permitted only from: `DRAFT` (T17), `REQUIREMENTS_CONFIRMED`, `EVALUATED`, `POLICY_BLOCKED`, `POLICY_PASSED`, `APPROVED`, `ORDER_CREATED`, `BUYER_APPROVED` (T16).
- Forbidden from `CAPTURE_ATTEMPTED`, `COMPLETED`, `FAILED`, and `CANCELLED` (`illegal_transition`).
- **Section 8.5 invariant:** At most one live attempt may exist. If a live attempt exists, cancellation is permitted only from `ORDER_CREATED` and `BUYER_APPROVED`; in any other status, an open attempt is rejected as `inconsistent_state`.
- **PayPal Order Preservation:** Cancellation does **NOT** void a PayPal order. `LIVE.paypalOrderId` is strictly retained in state, and no PayPal API call is made.

Demonstrated in:
- `tests/state/transitions.test.ts`: `T16: cancel from ORDER_CREATED with LIVE attempt -> CANCELLED`
- `tests/state/transitions.test.ts`: `T17: cancel from DRAFT -> CANCELLED`
- `tests/state/transitions.test.ts`: `cancel from CAPTURE_ATTEMPTED, COMPLETED, FAILED, CANCELLED returns illegal_transition`
- `tests/state/transitions.test.ts`: `after every successful cancel, no attempt has status OPEN`

---

## 9. Policy Evidence Fingerprint Behaviour

- `T4` and `T5` require `currentEvidenceFingerprint` non-null at guard position (4). If null, returns `guard_failed` with message `"evidence_fingerprint_missing"`, mutating zero state and emitting zero events.
- `T7` requires both `currentEvidenceFingerprint` and `policyEvidenceFingerprint` non-null. If either is null, returns `guard_failed` (`"evidence_fingerprint_missing"`). If equal, returns `guard_failed` (`"no_change_to_reassess"`). If different, transitions to `EVALUATED` and clears `policyEvidenceFingerprint`.
- `T8` requires `currentEvidenceFingerprint` non-null (`guard_failed` / `"evidence_fingerprint_missing"`).

Demonstrated in:
- `tests/state/transitions.test.ts`: `T4 precedence sequence > Step 4: Missing evidence fingerprint -> guard_failed 'evidence_fingerprint_missing'`
- `tests/state/transitions.test.ts`: `T5 precedence sequence > Step 4: Missing evidence fingerprint -> guard_failed 'evidence_fingerprint_missing'`
- `tests/state/transitions.test.ts`: `T7 guard failures when fingerprints are missing or equal`
- `tests/state/approval.test.ts`: `approve with currentEvidenceFingerprint null returns guard_failed`

---

## 10. Integrity Checks (P1 to P9)

### Checked on Input State in Pure State Layer:
- **P1 (purchase match):** Every fact (`selectedCandidate`, `approvals`, `paymentAttempts`) has `purchaseId === state.purchaseId`. Failure: `cross_purchase_reference`.
- **P2 (approval-candidate match):** An effective approval whose `candidateId` differs from `selectedCandidate.id` is `inconsistent_state`.
- **P3 (attempt-approval match):** Every attempt's `approvalId` references an approval in `state.approvals` with same `purchaseId`. Failure: `cross_purchase_reference` or `inconsistent_state`.
- **P4 (attempt-approval effectiveness):** A LIVE attempt's `approvalId` must refer to an effective approval (`invalidatedAt === null`). Failure: `inconsistent_state`.
- **P5 (single effective approval):** At most one approval with `invalidatedAt === null`. Failure: `inconsistent_state`.
- **P6 (single live attempt):** At most one attempt with status `OPEN`. Failure: `inconsistent_state`.
- **P7 (attempt identifiers):** LIVE attempt has non-null `paypalOrderId` in `ORDER_CREATED`, `BUYER_APPROVED`, `CAPTURE_ATTEMPTED`. Failure: `inconsistent_state`.
- **P8 (status-attempt coherence):** Exactly one LIVE attempt in active payment statuses; zero LIVE attempts in pre-order statuses. Failure: `inconsistent_state`.
- **P9 (terminal consistency):** `COMPLETED` purchase has a `COMPLETED` attempt; `FAILED` purchase most recent attempt has status `FAILED`. Failure: `inconsistent_state`.

Demonstrated in:
- `tests/state/integrity.test.ts`: 16 tests covering all P1–P9 failure rules and companion valid fixtures.

### Database-Enforced Constraints:
- Preferred composite foreign keys accepted and validated by Prisma 7:
  - `Approval`: `FOREIGN KEY ("candidateId", "purchaseId") REFERENCES "Candidate"("id", "purchaseId")`
  - `PaymentAttempt`: `FOREIGN KEY ("approvalId", "purchaseId") REFERENCES "Approval"("id", "purchaseId")`
  - `Purchase`: `FOREIGN KEY ("selectedCandidateId", "id") REFERENCES "Candidate"("id", "purchaseId")`
  - `Candidate`: `FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id")`
- Partial unique indexes in migration:
  - `"approval_one_effective_per_purchase"` ON `"Approval" ("purchaseId") WHERE "invalidatedAt" IS NULL`
  - `"payment_attempt_one_live_per_purchase"` ON `"PaymentAttempt" ("purchaseId") WHERE "status" = 'OPEN'`

### What Neither Enforces (Section 10.3):
1. That the caller loaded every approval and attempt for the purchase, and no others.
2. That the stored `snapshotHash` matches the candidate's fields at query time.
3. That the `currentEvidenceFingerprint` was computed from the stored evidence rows.
4. That a PayPal observation came from PayPal.

---

## 11. Prisma Models, Enums, and Mapping Consistency Check

### Enums (6):
1. `PurchaseStatus` (12 values)
2. `CandidateSource` (2 values: `channel3`, `seeded`)
3. `EvidenceStatus` (3 values: `supports`, `contradicts`, `missing`)
4. `PolicyOutcome` (3 values: `pass`, `block`, `unknown`)
5. `PaymentAttemptStatus` (4 values: `OPEN`, `COMPLETED`, `FAILED`, `CANCELLED`)
6. `AuditEventType` (13 values)

### Models (7):
`Purchase`, `Candidate`, `EvidenceItem`, `PolicyResult`, `Approval`, `PaymentAttempt`, `AuditEvent`.

### Composite Key Usage:
- All preferred composite foreign keys declared in section 10.1 were accepted by Prisma 7 `validate` and `generate`. No fallback single-column relations were required.
- Partial unique index names used:
  - `"approval_one_effective_per_purchase"`
  - `"payment_attempt_one_live_per_purchase"`

### Field-to-Column Mapping Confirmation:
- `PaymentAttemptFacts` (id, purchaseId, approvalId, idempotencyKey, paypalOrderId, status, verifiedStatus, verifiedAt, failureReason) 100% maps to `PaymentAttempt` columns.
- `ApprovalFacts` (id, purchaseId, candidateId, snapshotHash, totalCents, currency, policyVersion, evidenceFingerprint, approverUserId, approvedAt, invalidatedAt, invalidationReason) 100% maps to `Approval` columns.
- `PurchaseState.policyEvidenceFingerprint` maps to `Purchase.policyEvidenceFingerprint`.
- `PurchaseState.selectedCandidate` maps to `Purchase.selectedCandidateId` plus the `Candidate` relation row.

---

## 12. Fingerprint and Snapshot Definitions

- **`computeSnapshotHash`**: SHA-256 hex digest over canonical JSON of exactly 10 sorted keys: `availability`, `currency`, `externalId`, `merchantName`, `merchantUrl`, `quantity`, `shippingCents`, `source`, `totalCents`, `unitPriceCents`. Excludes `title`, `capturedAt`, `id`, `purchaseId`, `snapshotHash`, and `evidence`.
- **`computeEvidenceFingerprint`**: Requires ISO 8601 UTC `capturedAt`. Canonicalises items with sorted keys, sorts serialised strings by code-unit comparison, and hashes JSON array. Permutation invariant; sensitive to duplicates; empty set yields SHA-256 of `"[]"`.

Demonstrated in:
- `tests/state/money-snapshot.test.ts`: 23 tests verifying determinism, permutations, duplicate sensitivity, and ISO format validation.

---

## 13. Audit Writer Behaviour and Payload Trace

### Implementation:
- `InMemoryAuditStore` and `createPrismaAuditStore(delegate)`.
- The delegate uses a structural type without importing `@prisma/client`.
- Runtime validation checks every record before writing; one invalid record rejects the entire batch without mutating the store.
- Deep scan rejects forbidden keys matching `/secret|token|password|authorization|clientsecret/i`.

### Payload Trace to State or Command:
- `proposed`: `budgetCents`, `currency` ← purchase initialization parameters.
- `requirements_confirmed`: empty payload.
- `evaluated`: `candidateId` ← command candidate id (T2) or state selected candidate id (T3, T6, T7, T9); `reason` ← transition-specific reason string.
- `policy_blocked`: `blockingRuleKeys`, `unknownRuleKeys` ← command policy summary.
- `policy_passed`: `policyVersion` ← command policy version.
- `approved`: all fields ← `selectedCandidate` facts, state `policyVersion`, state `currentEvidenceFingerprint`, and context `actor.userId`.
- `approval_invalidated`: `approvalId` ← EFF id; `reasons` ← derived invalidation reasons.
- `order_created`: `paymentAttemptId` ← context ID; `approvalId` ← EFF id; `paypalOrderId` ← command; `totalCents` ← EFF total.
- `buyer_approved`: `paymentAttemptId`, `paypalOrderId` ← LIVE attempt; `verifiedStatus` ("APPROVED"), `observedAt` ← observation.
- `capture_attempted`: `paymentAttemptId` ← LIVE attempt.
- `completed`: `paymentAttemptId`, `paypalOrderId` ← LIVE attempt; `verifiedStatus` ("COMPLETED"), `observedAt` ← observation.
- `failed`: `paymentAttemptId` ← LIVE attempt; `source`, `reason`, `verifiedStatus` ← observation or command.
- `cancelled`: `fromStatus` ← `state.status`; `paymentAttemptId` ← LIVE attempt id or null; `reason` ← command.

Transaction boundary: transitions return state and drafts; the caller persists them together in one database transaction.

---

## 14. Test Coverage Counts from Actual Run

Total tests executed: **168 passed**, 0 failed across 9 test files.

| Test File | Test Count | Features Tested |
|---|---|---|
| `tests/state/transitions.test.ts` | 49 | 22 transition rows (T1–T17), 132 status/command pairs (28 permitted, 104 illegal), 10 T4/T5 precedence rows, 6 T2e scenarios, 5 T9/T10 stale approval tests, 6 other error cases |
| `tests/state/integrity.test.ts` | 16 | Integrity rules P1 through P9, multiple fact types, and companion valid fixtures |
| `tests/state/approval.test.ts` | 19 | User vs system actor, binding checks, 7 invalidation triggers separately, combined triggers, T2e proposed-state derivation |
| `tests/state/money-snapshot.test.ts` | 23 | Overflow, invalid money, canonical snapshot key order, 6 permutations of evidence items, tie-breaking, ISO regex |
| `tests/state/policy-summary.test.ts` | 7 | All-pass, block, unknown, duplicates, empty required keys, extra keys |
| `tests/state/source-hygiene.test.ts` | 33 | AST/regex check across all files in `lib/state` and `lib/audit` for forbidden packages, clocks, randoms, and PrismaClient |
| `tests/audit/writer.test.ts` | 9 | All 13 event payloads, secret key detection, invalid actors/occurredAt, delegate createMany call |
| `tests/tokens.test.ts` (Phase 0) | 8 | Contrast ratios, dark/light themes |
| `tests/source.test.ts` (Phase 0) | 4 | Phase 0 file hygiene |

---

## 15. Exact Command Outputs (Section 16)

### 1. `node --version`
```text
v22.17.0
```

### 2. `npm --version`
```text
10.9.2
```

### 3. `npm run lint`
```text
> purchase-assurance@0.1.0 lint
> eslint
```
Exit code: 0

### 4. `npx tsc --noEmit`
```text
Exit code: 0 (clean output, 0 errors)
```

### 5. `npm test`
```text
 ✓ tests/source.test.ts (4 tests) 24ms
 ✓ tests/state/source-hygiene.test.ts (33 tests) 26ms
 ✓ tests/tokens.test.ts (8 tests) 36ms
 ✓ tests/state/integrity.test.ts (16 tests) 31ms
 ✓ tests/state/money-snapshot.test.ts (23 tests) 40ms
 ✓ tests/state/approval.test.ts (19 tests) 37ms
 ✓ tests/state/policy-summary.test.ts (7 tests) 22ms
 ✓ tests/audit/writer.test.ts (9 tests) 38ms
 ✓ tests/state/transitions.test.ts (49 tests) 75ms

 Test Files  9 passed (9)
      Tests  168 passed (168)
   Start at  12:59:31
   Duration  660ms
```
Exit code: 0

### 6. `npx prisma validate`
```text
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma\schema.prisma.
The schema at prisma\schema.prisma is valid 🚀
```
Exit code: 0

### 7. `npx prisma generate`
```text
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma\schema.prisma.

✔ Generated Prisma Client (v7.10.1) to .\node_modules\@prisma\client in 346ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)
```
Exit code: 0

### 8. `npx prisma migrate diff --help`
```text
Compares the database schema from two arbitrary sources, and outputs the differences either as a human-readable summary (by default) or an executable script.

Options
  -h, --help               Display this help message
  --config                 Custom path to your Prisma config file
  -o, --output             Writes to a file instead of stdout

From and To inputs (1 `--from-...` and 1 `--to-...` must be provided):
  --from-empty             Flag to assume from or to is an empty datamodel
  --to-empty
  --from-schema            Path to a Prisma schema file, uses the datamodel for the diff
  --to-schema
  --from-migrations        Path to the Prisma Migrate migrations directory
  --to-migrations
  --from-config-datasource Flag to use the datasource from the Prisma config file
  --to-config-datasource

Flags
  --script                 Render a SQL script to stdout instead of the default human readable summary
  --exit-code              Change the exit code behavior to signal if the diff is empty or not
```
Exit code: 0

### 9. Migrate Diff Command Output Saved to `prisma/migrations/20261020124600_phase1_domain/migration.sql`
Generated via: `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
Appended manual partial unique indexes:
- `CREATE UNIQUE INDEX "approval_one_effective_per_purchase" ON "Approval" ("purchaseId") WHERE "invalidatedAt" IS NULL;`
- `CREATE UNIQUE INDEX "payment_attempt_one_live_per_purchase" ON "PaymentAttempt" ("purchaseId") WHERE "status" = 'OPEN';`

### 10. `Get-FileHash` for gate1.mjs Before and After
Before starting:
```text
Algorithm  Hash                                                              Path
---------  ----                                                              ----
SHA256     F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451 C:\paypal-gate1\gate1.mjs
```

After finishing:
```text
Algorithm  Hash                                                              Path
---------  ----                                                              ----
SHA256     F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451 C:\paypal-gate1\gate1.mjs
```
Comparison: **MATCH (identical)**.

`npm run build`: Not run, because Phase 1 defines pure state and Prisma models without client UI or routes, and the production server routing check completed in Phase 0 sign-off.

---

## 16. Deviations from Specification

1. **`PurchaseState.policyEvidenceFingerprint`**: Added as an explicit field to track the evidence fingerprint at the moment policy passed, enabling T7's change detection without external state.
2. **`PaymentAttemptFacts` fields**: Added `verifiedStatus`, `verifiedAt`, `failureReason`, and `purchaseId` to enable pure-state tracking of PayPal observations and terminal failure reasons.
3. **Audit payload `paymentAttemptId`**: Included on `buyer_approved`, `completed`, `failed`, and `cancelled` to enable precise trace of attempts across the lifecycle.
4. **T6 vs T7 Difference**: T6 (`POLICY_BLOCKED`) allows reevaluation without fingerprint comparison because the policy failed; T7 (`POLICY_PASSED`) requires evidence to have changed (`currentEvidenceFingerprint !== policyEvidenceFingerprint`) to justify reevaluation.
5. **T2e Proposed-State Derivation**: Evaluated against a proposed state produced by `proposedState(state, command)`. When selected candidate ID and snapshot hash match the existing candidate, the known fingerprint is preserved to avoid false evidence-change invalidations.
6. **Strict Error Precedence Resolution (Option 2)**: Maintained strict Section 6.1 global error precedence without creating a T4/T5 exception. Step 4 integrity checks (including Rule P8) run before Step 5 transition-specific guards. Consequently, an OPEN attempt in status `EVALUATED` is intercepted by Rule P8 (`inconsistent_state`) before transition-specific guards are reached. The Section 15 precedence test suite was updated to use valid input states that pass P1–P9, with explicit tests proving that P8 intercepts open attempts in `EVALUATED` before T4/T5 guards.

---

## 17. Outstanding Owner Decisions (Unresolved)

- **OD-1: Retry after FAILED**: FAILED remains terminal in Phase 1; retry logic is deferred.
- **OD-2: Inconclusive capture**: The purchase remains in `CAPTURE_ATTEMPTED`; no automatic timeout or retry command exists.
- **OD-3: Freshness window**: Invalidation is triggered solely by fingerprint mismatch, without an age-based expiration window.
- **OD-4: Policy override**: Not permitted; exit from `POLICY_BLOCKED` is exclusively through reevaluation.
- **OD-5: Commercial change after ORDER_CREATED**: Rejected with `change_blocked_by_open_payment`. Cancellation is the sole exit.

---

## 18. Known Limitations

- **No runtime database verification**: The database connection has not been opened.
- **Migration unapplied**: The generated migration in `prisma/migrations/20261020124600_phase1_domain/migration.sql` is unapplied.
- **Partial indexes untested against PostgreSQL**: The manual partial unique indexes are defined in SQL but have not been executed against a running PostgreSQL engine.
- **PayPal observations are TypeScript types only**: The state machine trusts observation types; no network verification is performed.
- **Inconclusive capture (OD-2)**: No transition exists to exit `CAPTURE_ATTEMPTED` without PayPal order resolution.
- **Cancellation does not void PayPal orders**: Retains `paypalOrderId` without sending a void request.
- **Freshness is fingerprint-only (OD-3)**: No timestamp-based expiration.
- **T2e proposed-state evidence identity convention**: Conservatively represented by `(candidate.id, candidate.snapshotHash)`.

---

## 19. Phase Completion Confirmation

- Zero Phase 2+ work (no PayPal SDK calls, no Channel3 integration, no LLM calls, no API routes, no UI changes) was started.
- Gate 1 SHA-256 before: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- Gate 1 SHA-256 after: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- Match result: **PERFECT MATCH**.
