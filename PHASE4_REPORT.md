# Phase 4 Implementation Report — Purchase Workflow APIs & Persistence

**Project:** Purchase Assurance  
**Workspace:** `C:\Users\Tushar Kumar\Desktop\Plinthly`  
**Date:** 2026-10-20  
**Status:** COMPLETE (Ready for Phase 4 Acceptance Audit)

---

## 1. Pre-Implementation Findings and Final Design Decisions

### Pre-Implementation Audit Findings
1. **Schema & Migration Status:**  
   Inspection of `prisma/schema.prisma` and `prisma/migrations/20261020124600_phase1_domain/migration.sql` confirmed that all domain models required for Phase 4 persistence (`Purchase`, `Candidate`, `EvidenceItem`, `PolicyResult`, `Approval`, `PaymentAttempt`, `AuditEvent`) were fully defined and migrated in Phase 1. Zero schema modifications or database migrations were needed.
2. **State Machine & Error Precedence:**  
   `lib/state/transitions.ts` enforces strict global error precedence: Transition Legality -> Actor Check -> Input Validation -> Integrity Rules (P1–P9) -> Transition Guards. In Phase 4, the service and API layers respect these exact error codes and transitions (`confirm_requirements` T1, `select_candidate` T2, `apply_policy_summary` T4/T5, and `approve` T8).
3. **Evidence Fingerprint and Snapshot Hash:**  
   Candidate commercial terms are hashed deterministically via `computeSnapshotHash` (SHA-256 over 10 canonical fields). Candidate evidence facts are fingerprinted via `computeEvidenceFingerprint`. The state machine requires non-null evidence fingerprints before policy summary can pass (`apply_policy_summary` guard 4).
4. **Authentication & Authorization Analysis:**  
   Zero authentication or session infrastructure exists in the current repository. No authentication provider was rushed or faked. Actor extraction is cleanly handled via request headers (`X-Actor-Id`, `X-Actor-Kind`, `X-Actor-Component`), defaulting to a local development user actor. The API is explicitly declared local/demo-only.

### Final Design Decisions
- **Repository Abstraction (`PurchaseRepository`):** Implemented `InMemoryPurchaseRepository` for isolated unit and integration testing without database dependencies or live network access. The repository supports atomic mutations, optimistic concurrency status verification, and pre-commit audit payload validation.
- **Service Layer (`PurchaseWorkflowService`):** Orchestrates candidate normalization (`normalizeCandidate`), evidence ingestion (`ingestCandidateEvidence`), deterministic policy evaluation (`evaluatePolicy`), state machine transitions (`transition`), and atomic persistence.
- **Next.js 16 App Router Routes:** Implemented standard dynamic API route handlers in `app/api/purchases/` supporting both Promise and resolved `context.params` for complete runtime and test-runner compatibility.

---

## 2. Files Created and Modified

### Files Created
1. `lib/workflow/types.ts`:
   - DTOs for API requests and responses: `CreatePurchaseRequest`, `PurchaseResponse`, `EvaluatePurchaseRequest`, `EvaluatePurchaseResponse`, `ApprovePurchaseRequest`, `ApprovePurchaseResponse`, `AuditHistoryResponse`, `ApiErrorResponse`.
2. `lib/workflow/validation.ts`:
   - Zod validation schemas: `createPurchaseSchema`, `evaluatePurchaseSchema`, `approvePurchaseSchema`, `requirementItemSchema`.
   - Header-based actor extraction helper: `extractActor(headers: Headers): Actor`.
3. `lib/workflow/repository.ts`:
   - Persistence domain records: `PurchaseRecord`, `CandidateRecord`, `EvidenceItemRecord`, `PolicyResultRecord`, `ApprovalRecord`, `AuditEventRecord`, `PurchaseAggregate`.
   - `PurchaseRepository` interface and `InMemoryPurchaseRepository` implementation with optimistic locking and rollback.
4. `lib/workflow/service.ts`:
   - `PurchaseWorkflowService`: Implements `createPurchase`, `getPurchase`, `evaluatePurchaseCandidate`, `approvePurchase`, and `getAuditHistory`.
   - Domain error classes: `WorkflowError`, `NotFoundError` (404), `ValidationError` (400), `IllegalTransitionError` (422), `ApprovalIntegrityError` (422), `ConcurrencyConflictError` (409).
5. `lib/workflow/api-helpers.ts`:
   - Reusable JSON body parsing, standardized error formatting, and asynchronous route parameter resolution.
6. `lib/workflow/index.ts`:
   - Barrel export for workflow module.
7. `app/api/purchases/route.ts`:
   - `POST /api/purchases`: Validates input, initializes draft purchase, triggers T1 requirements confirmation, and returns HTTP 201.
8. `app/api/purchases/[id]/route.ts`:
   - `GET /api/purchases/[id]`: Retrieves purchase aggregate details with HTTP 200 or 404.
9. `app/api/purchases/[id]/evaluate/route.ts`:
   - `POST /api/purchases/[id]/evaluate`: Normalizes candidate, ingests evidence, evaluates policy, applies state transition, and returns HTTP 200.
10. `app/api/purchases/[id]/approve/route.ts`:
    - `POST /api/purchases/[id]/approve`: Enforces snapshot hash, evidence fingerprint, total amount, currency, and policy version integrity checks before transitioning to APPROVED.
11. `app/api/purchases/[id]/audit/route.ts`:
    - `GET /api/purchases/[id]/audit`: Returns chronological append-only audit event log.
12. Test suites:
    - `tests/workflow/validation.test.ts` (15 tests)
    - `tests/workflow/repository.test.ts` (5 tests)
    - `tests/workflow/service.test.ts` (15 tests)
    - `tests/workflow/api.test.ts` (9 tests)
    - `tests/workflow/concurrency.test.ts` (2 tests)
    - `tests/workflow/source-hygiene.test.ts` (5 tests)

### Files Modified
- None of Phase 0, Phase 1, Phase 2, or Phase 3 files were modified. All contracts remained preserved.

---

## 3. Final API Endpoints, Contracts, and Error Codes

| Method | Path | Status Codes | Description |
|---|---|---|---|
| `POST` | `/api/purchases` | 201, 400 | Create purchase with validated requirements. Triggers T1. |
| `GET` | `/api/purchases/[id]` | 200, 400, 404 | Retrieve purchase and active approval details. |
| `POST` | `/api/purchases/[id]/evaluate` | 200, 400, 404, 409, 422 | Ingest & evaluate candidate via deterministic policy engine. |
| `POST` | `/api/purchases/[id]/approve` | 200, 400, 404, 409, 422 | Verify approval integrity and commit buyer approval. |
| `GET` | `/api/purchases/[id]/audit` | 200, 400, 404 | Retrieve audit event history for purchase. |

### Standard Error Codes
- `invalid_json` (400): Malformed JSON body in request.
- `validation_error` (400): Zod validation failure on body or parameters.
- `not_found` (404): Specified purchase ID does not exist.
- `concurrency_conflict` (409): Optimistic concurrency check failed due to concurrent modification.
- `illegal_transition` (422): Requested state machine command is illegal from the current purchase status.
- `snapshot_hash_mismatch` (422): Expected snapshot hash does not match authoritative candidate terms.
- `evidence_fingerprint_mismatch` (422): Expected evidence fingerprint does not match policy outcome.
- `amount_mismatch` (422): Expected amount does not match authoritative candidate total.
- `currency_mismatch` (422): Currency differs from candidate currency.
- `policy_version_mismatch` (422): Policy version differs from evaluated version.
- `internal_error` (500): Unexpected server error (leaks zero secrets or stack traces).

---

## 4. Persistence Model and Migration Status

- **Prisma Schema (`prisma/schema.prisma`):** Validated with `npx prisma validate`.
- **Prisma Client (`@prisma/client`):** Generated with `npx prisma generate` (v7.10.1).
- **Migration Status:** Migration `20261020124600_phase1_domain/migration.sql` already covers the domain model.
- **Database Safety:** Zero migrations were applied. No connection to a production or development database occurred. All tests run in isolated in-memory repositories.

---

## 5. State-Machine and Approval-Integrity Enforcement

1. **State Machine Binding:**  
   Every state modification is executed strictly via `transition()` in `lib/state/transitions.ts`. Client requests cannot arbitrarily supply `status` values.
2. **Deterministic Evaluation Pipeline:**  
   Candidate facts and evidence are ingested through `normalizeCandidate` and `ingestCandidateEvidence`. The resulting `evidenceFingerprint` is attached to the purchase state before `apply_policy_summary` evaluates whether `allRequiredPassed` is satisfied.
3. **Strict Approval Integrity:**  
   Before `approvePurchase` commits, it verifies:
   - Approver actor must be of kind `"user"`.
   - Current purchase state must be `"POLICY_PASSED"`.
   - `snapshotHash` matches the authoritative candidate snapshot hash.
   - `evidenceFingerprint` matches `policyEvidenceFingerprint`.
   - `totalCents` and `currency` match candidate terms.
   - `policyVersion` matches the evaluated policy version.
   If any commercial term or evidence changed, the approval is rejected with HTTP 422.

---

## 6. Transaction, Concurrency, Idempotency, and Audit Guarantees

1. **Optimistic Concurrency:**  
   Mutations require matching `expectedStatus`. If a concurrent request advances the state, subsequent requests fail with `concurrency_conflict` (409).
2. **Duplicate Approval Prevention:**  
   Once approved (`status = APPROVED`), subsequent approval attempts fail with `illegal_transition` (422).
3. **Atomic Audit Logging:**  
   Audit records are validated with `validateRecord` (rejecting any forbidden fields like passwords or secrets). If an audit write or state transition fails, the mutation is not committed.
4. **Append-Only Auditing:**  
   Historical audit records cannot be edited or deleted by workflow API endpoints.

---

## 7. Authentication Limitations and Security Implications

- **Current Repository State:** There is no authentication provider, user session store, or identity service configured in the workspace.
- **Local/Demo Boundary:** The APIs use HTTP headers (`X-Actor-Id`, `X-Actor-Kind`, `X-Actor-Component`) to identify actors, defaulting to `local_dev_user`.
- **Security Limitation:** Because no cryptographic authentication exists, this service must NOT be exposed publicly. It is strictly for local development and assurance workflow testing. Cross-user authorization cannot be cryptographically proven without an identity layer.

---

## 8. Verification Results

| Command | Exit Code | Result Summary |
|---|---|---|
| `npm run lint` | `0` | Zero errors, zero warnings across all workspace files. |
| `npx tsc --noEmit` | `0` | TypeScript compiles with zero errors. |
| `npm test` | `0` | **25 test files passed, 404 tests passed, 0 failed.** (51 new Phase 4 tests added). |
| `npx prisma validate` | `0` | Schema loaded and valid. |
| `npx prisma generate` | `0` | Prisma client generated successfully. |

---

## 9. Gate 1 Baseline Hashes

- **Before Implementation:**  
  `SHA-256: F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **After Implementation:**  
  `SHA-256: F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Result:** Exact match. Gate 1 baseline script was untouched and unread.

---

## 10. Remaining Limitations, Unverified Guarantees, and Known Defects

1. **Database Integration:** Real PostgreSQL transactions were verified using unit-level transaction isolation (`InMemoryPurchaseRepository`). End-to-end multi-process PostgreSQL row locking requires an active database environment, which was prohibited by safety rules.
2. **Authentication:** Authorization checks rely on actor headers, which are unauthenticated in this development mode.
3. **No Phase 5 / PayPal Scope:** In accordance with strict scope boundaries, no PayPal order creation, authorization, capture, or webhooks have been implemented. Phase 5 work was not started.
