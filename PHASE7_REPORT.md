# Phase 7 — Purchase Assurance Frontend Integration Report

**Date:** 2026-10-20  
**Repository:** `C:\Users\Tushar Kumar\Desktop\Plinthly`  
**Verdict:** **PASS**

---

## 1. Executive Summary

Phase 7 implements the frontend interface for the Purchase Assurance procurement workflow. Built on top of the established design system tokens and server-side API contracts, the interface connects buyer purchase submission, candidate policy evaluation, terms approval, PayPal Sandbox order creation, buyer approval confirmation, independent payment verification, and audit event viewing.

### Key Architectural & Safety Guarantees
1. **No Client-Side Authority:** All state transitions, policy outcomes, pricing calculations, snapshot hashes, and verification statuses are computed and validated exclusively by server-side endpoints.
2. **Strict Non-Capture Guarantee:** The UI provides no mechanism or controls to capture funds. The workflow terminates after buyer approval and independent verification.
3. **No False Completion Claims:** `BUYER_APPROVED` is strictly labeled as `"BUYER_APPROVED (UNCAPTURED)"`. Orders observed as `COMPLETED` in PayPal Sandbox are explicitly marked as `"REMOTELY COMPLETED IN SANDBOX (UNCAPTURED LOCALLY)"`, preventing false claims of payment completion.
4. **Distinct Policy States:** Policy summaries strictly differentiate `PASS`, `BLOCK`, and `UNKNOWN`. Incomplete evidence producing `UNKNOWN` is never converted to `PASS`.
5. **Fail-Closed & Idempotent:** Stale terms and version conflicts (HTTP 409) prompt explicit re-evaluation. Re-submitting purchase requests with existing idempotency keys recovers existing purchase state safely.
6. **Explicit Audit Limitation Disclosure:** A permanent banner documents that standalone payment verification attempts update the payment attempt record and are not emitted as timeline audit events, per Phase 6.1 audit findings.

---

## 2. Preflight & Integrity Verification

### Gate 1 Artifact Integrity
- **Target File:** `C:\paypal-gate1\gate1.mjs`
- **Expected SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Measured SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Status:** **PASS** (File remains untouched, unread, unexecuted, and unmoved).

### Git Status
- Working tree: clean master branch with no commits yet.
- Zero files staged, committed, pushed, or deployed.

---

## 3. Screens & Components Implemented

### 3.1 Client API Layer (`lib/workflow/client-api.ts`)
A strongly-typed, server-agnostic API client wrapping `fetch` against the Next.js routes:
- `createPurchaseApi(req, options)`: Calls `POST /api/purchases` with budget, currency, requirements, quantity, and idempotency key.
- `getPurchaseApi(id, options)`: Calls `GET /api/purchases/[id]`.
- `evaluatePurchaseApi(id, req, options)`: Calls `POST /api/purchases/[id]/evaluate` with candidate terms and evidence observations.
- `approvePurchaseApi(id, req, options)`: Calls `POST /api/purchases/[id]/approve` with expected snapshot hash, total cents, and expected version.
- `createPayPalOrderApi(id, options)`: Calls `POST /api/purchases/[id]/paypal/create-order` with idempotency key.
- `confirmBuyerApprovalApi(id, options)`: Calls `POST /api/purchases/[id]/paypal/confirm-approval`.
- `verifyPayPalPaymentApi(id, options)`: Calls `POST /api/purchases/[id]/paypal/verify`.
- `getAuditHistoryApi(id, options)`: Calls `GET /api/purchases/[id]/audit`.
- All methods handle HTTP 400, 401, 403, 404, 409, 503, and network errors, returning structured `{ ok: true, data } | { ok: false, error }` results without substituting fake mock data.

### 3.2 Workflow Screen Components
1. **`PurchaseDashboard` (`components/workflow/purchase-dashboard.tsx`):**
   - Main container component with AppShell, header status badges, purchase switcher/lookup, active purchase overview, and progressive workflow stages.
2. **`PurchaseRequestCard` (`components/workflow/purchase-request-card.tsx` — Screen A):**
   - Inputs: Total budget in USD, quantity, requirement specs (one per line with key:value support), and reusable idempotency key.
   - Client-side validation: Budget > 0, integer quantity >= 1, at least 1 requirement.
   - Displays client error messages, loading spinners, server error banners, and success confirmation with the new purchase ID.
3. **`CandidateEvaluationCard` (`components/workflow/candidate-evaluation-card.tsx` — Screen B):**
   - Displays candidate details (merchant, URL, title, unit price, shipping, availability).
   - "Evaluate Candidate Policy" button calling the policy engine endpoint.
   - Displays policy evaluation summary: `POLICY PASS`, `POLICY BLOCKED`, or `POLICY UNKNOWN`.
   - Table of individual rules with rule keys, status chips (`pass`, `block`, `caution`), and server-returned reason strings.
   - Shows authoritative `snapshotHash` and `evidenceFingerprint`.
4. **`ApprovalCard` (`components/workflow/approval-card.tsx` — Screen C):**
   - Displays locked offer terms: unit price, shipping, exact total USD, snapshot hash, and availability.
   - "Approve Purchase Terms" button submitting exact `expectedSnapshotHash`, `expectedTotalCents`, `expectedCurrency`, and `expectedVersion`.
   - Stale approval handling: If server returns HTTP 409 (concurrency conflict or version mismatch), renders an informational banner requiring terms refresh.
   - Displays approval ID, approver user ID, and approval timestamp upon approval.
5. **`PayPalCard` (`components/workflow/paypal-card.tsx` — Screens D & E):**
   - Step 4A: "Create Sandbox Order" button available only when status is `APPROVED`.
   - On order creation: Renders PayPal order ID, attempt status, and an external link to approve the order in PayPal Sandbox.
   - Step 4B: Distinct actions for "Confirm Buyer Approval" and "Independently Verify PayPal Status".
   - Clear status indicators: `ORDER_CREATED`, `BUYER_APPROVED (UNCAPTURED)`, `REMOTELY COMPLETED (UNCAPTURED)`, `VOIDED`, `MISMATCH REJECTED`, `TRANSIENT TIMEOUT`, and `API ERROR`.
   - Explicit banner: *"Notice: This state does NOT mean payment is complete. Workflow is held before funds capture."*
   - Strictly no capture button or capture route.
6. **`AuditCard` (`components/workflow/audit-card.tsx` — Screen F):**
   - "Load Audit History" button fetching immutable audit trail events.
   - Displays event timeline with type badges, timestamps, actors, and JSON payload inspector.
   - Displays explicit notice of the Phase 6.1 audit finding regarding payment attempt records vs audit timeline entries.
7. **`ActorBar` (`components/workflow/actor-bar.tsx`):**
   - Dropdown switcher between `usr_buyer_1` (primary owner), `usr_buyer_2` (secondary owner), and `usr_unauthorized` (non-owner for 403 testing).
   - Explicitly notes that caller headers are active only in local demo mode.

---

## 4. API Integration & Backend Gaps

| API Route | Method | Purpose | Integrated | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `/api/purchases` | POST | Create purchase | Yes | Sends idempotency key & requirements |
| `/api/purchases/[id]` | GET | Fetch purchase details | Yes | Used for refresh & lookup |
| `/api/purchases/[id]/evaluate` | POST | Run policy evaluation | Yes | Submits candidate & observation data |
| `/api/purchases/[id]/approve` | POST | Lock & approve terms | Yes | Submits snapshot hash & total cents |
| `/api/purchases/[id]/paypal/create-order` | POST | Create Sandbox order | Yes | Initiates PayPal Sandbox order |
| `/api/purchases/[id]/paypal/confirm-approval` | POST | Confirm buyer approval | Yes | Validates remote approval |
| `/api/purchases/[id]/paypal/verify` | POST | Independent verification | Yes | Validates terms directly from Sandbox |
| `/api/purchases/[id]/audit` | GET | Retrieve audit history | Yes | Displays timeline events |

### Backend Gaps Documented
1. **No Funds Capture Endpoint:** The backend does not expose `/api/purchases/[id]/paypal/capture` or advance purchases to `COMPLETED`. The UI adheres strictly to this limitation.
2. **Audit Event Limitations:** The backend does not emit standalone `PAYMENT_VERIFIED` or `PAYMENT_VERIFICATION_FAILED` events into `audit_events`. Verification results are retrieved through the verify API and stored in `payment_attempts`. The UI clearly disclaims this limitation in `AuditCard`.

---

## 5. UI State, Error Handling & Accessibility

- **Input Validation:** Client checks for positive budget amounts, integer quantities, and non-empty requirement lists before sending requests.
- **Server Error Mapping:**
  - `400`: Displays field or input validation failure reasons.
  - `401`: Displays authentication required notice.
  - `403`: Displays forbidden ownership error banner.
  - `404`: Displays purchase not found banner.
  - `409`: Displays stale approval / version conflict banner prompting terms re-evaluation.
  - `503`: Displays database unavailable banner.
  - Network Failure: Displays connectivity failure banner without substituting mock data.
- **Accessibility & Contrast:**
  - Semantic HTML: `<form>`, `<label>`, `<input>`, `<button>`, `<table>`, `role="alert"`, `role="status"`.
  - Design Tokens: Reused all WCAG AA/AAA compliant color tokens (`--canvas`, `--surface`, `--ink`, `--ink-muted`, `--accent`, `--pass`, `--caution`, `--block`).
  - Responsive: Single-column on mobile viewports; responsive multi-column layouts on desktop.

---

## 6. Test Evidence & Validation

### Test Methodology Note
- **All frontend tests run in an isolated test environment using mocked API responses and React SSR (`renderToString`).**
- No real network requests were made to PayPal Sandbox or PostgreSQL databases during testing.

### Tooling Verification Results

| Tool / Check | Command | Exit Code | Result |
| :--- | :--- | :--- | :--- |
| **Vitest Test Suite** | `npm test` | `0` | **34 test files, 509 tests passed** |
| **Type Check** | `npx tsc --noEmit` | `0` | **0 errors** |
| **ESLint** | `npm run lint` | `0` | **0 errors, 0 warnings** |
| **Prisma Schema Validation** | `npx prisma validate` | `0` | **Valid** |
| **Prisma Client Generation** | `npx prisma generate` | `0` | **Client generated successfully** |
| **Next.js Production Build** | `npm run build` | `0` | **Turbopack production build succeeded** |
| **Gate 1 SHA-256 Hash** | PowerShell `Get-FileHash` | `0` | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` |

### New Frontend Test Coverage (`tests/workflow/frontend.test.ts` — 17 tests)
1. `createPurchaseApi` 201 success.
2. `getPurchaseApi` 403 Forbidden with structured error.
3. 503 Database Unavailable handling.
4. Network failure structured error mapping.
5. Idempotency key and actor header propagation.
6. Execution of `evaluatePurchaseApi`, `approvePurchaseApi`, `createPayPalOrderApi`, `confirmBuyerApprovalApi`, `verifyPayPalPaymentApi`, and `getAuditHistoryApi`.
7. `PurchaseRequestCard` rendering with accessible inputs.
8. `CandidateEvaluationCard` rendering with candidate controls.
9. Strict distinction between `UNKNOWN` and `PASS` in policy evaluation.
10. `ApprovalCard` exact candidate terms and snapshot hash presentation.
11. `ApprovalCard` approved state metadata rendering.
12. `PayPalCard` order creation button enabled only for approved purchases.
13. `PayPalCard` strictly labeling `BUYER_APPROVED` as uncaptured, preventing false "paid" or "completed" claims.
14. Verification that no funds capture buttons exist in the UI.
15. Distinct controls for Confirm Approval and Independent Verification.
16. `AuditCard` rendering with Phase 6.1 limitation banner.
17. `ActorBar` local demo actor switcher and `PurchaseDashboard` root component rendering.

---

## 7. Known Limitations

1. **Unapplied Migration:** Migration `prisma/migrations/20261019000000_phase4_1_durable_persistence/migration.sql` remains unapplied per instructions.
2. **Payment Capture:** Payment capture is intentionally excluded.
3. **Live Testing:** All automated tests execute with mocked boundaries. Live integration with PayPal Sandbox and PostgreSQL was not run.

---

## 8. Verdict

**PASS** — The frontend integration for Purchase Assurance is complete, adheres to all architectural invariants and UX guidelines, passes all tests, typechecks, linter checks, and production builds with zero errors or warnings, preserves the Gate 1 artifact, and avoids false claims of payment completion.
