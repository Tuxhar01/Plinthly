# Phase 5.1 — PayPal Purchase Reference Integrity Fix Report

**Date:** 2026-10-20  
**Project:** Purchase Assurance  
**Workspace:** `C:\Users\Tushar Kumar\Desktop\Plinthly`  
**Verdict:** **PASS**

---

## 1. Root Cause

During the Phase 5 Read-Only Acceptance Audit, an integrity gap was identified in `confirmBuyerApproval()` within `lib/workflow/service.ts`:
- While `liveAttempt.paypalOrderId` was verified to belong to the local purchase, the independently retrieved PayPal order's purchase unit was not strictly validated for structural integrity or reference matching.
- Specifically, `remoteOrder.purchase_units` was treated as an optional array where `remoteOrder.purchase_units?.[0]` was inspected only if present (`if (unit?.amount)`). If PayPal had returned an empty array or missing amount, the amount and currency verification would not have executed.
- Furthermore, `remoteOrder.purchase_units[0].reference_id` was not validated against the internal `purchaseId`. An order created for a different purchase ID could theoretically have bypassed validation if order IDs and amounts aligned.
- The single-purchase-unit architectural assumption of Purchase Assurance was not explicitly enforced.

---

## 2. Code Changes

### Changes in `lib/workflow/service.ts` (`confirmBuyerApproval`)
1. **Remote Order ID Equality:**
   - Explicitly asserts `remoteOrder.id === liveAttempt.paypalOrderId`, throwing `order_id_mismatch` if mismatched or empty.
2. **Fail-Closed Purchase Unit Structure:**
   - Validates that `remoteOrder.purchase_units` is a non-empty array (`Array.isArray(remoteOrder.purchase_units) && remoteOrder.purchase_units.length > 0`), throwing `invalid_purchase_unit` otherwise.
   - Enforces the architectural invariant that Purchase Assurance orders contain exactly 1 purchase unit (`remoteOrder.purchase_units.length === 1`), throwing `invalid_purchase_unit` if multiple units are returned.
3. **Internal Purchase Reference Matching:**
   - Validates that `unit.reference_id` exists and is non-empty, throwing `reference_id_missing` if missing.
   - Validates that `unit.reference_id === purchaseId` exactly, throwing `reference_id_mismatch` if mismatched.
4. **Amount Structure & Value Validation:**
   - Asserts `unit.amount`, `unit.amount.value`, and `unit.amount.currency_code` exist, throwing `invalid_amount_structure` if missing or malformed.
   - Enforces `unit.amount.currency_code === eff.currency`, throwing `currency_mismatch` if mismatched.
   - Enforces `Math.round(parseFloat(unit.amount.value) * 100) === eff.totalCents`, throwing `amount_mismatch` if mismatched.
5. **Fail-Closed State Machine Protection:**
   - None of these failure paths advance the state machine or record audit events; state remains strictly in `ORDER_CREATED`.

---

## 3. Regression Tests

Added targeted regression test cases in `tests/paypal/service.test.ts` and `tests/paypal/api.test.ts`:

1. **`tests/paypal/service.test.ts`**:
   - `rejects buyer approval when PayPal order has empty or missing purchase_units`: asserts rejection with `invalid_purchase_unit`, confirms state remains `ORDER_CREATED`, and confirms no `buyer_approved` audit event is created.
   - `rejects buyer approval when PayPal order contains multiple purchase units`: asserts rejection with `invalid_purchase_unit` ("requires exactly 1 purchase unit"), confirms state remains `ORDER_CREATED`, and confirms no `buyer_approved` audit event is created.
   - `rejects buyer approval when purchase unit reference_id is missing`: asserts rejection with `reference_id_missing`, confirms state remains `ORDER_CREATED`, and confirms no `buyer_approved` audit event is created.
   - `rejects buyer approval when purchase unit reference_id does not match internal purchase ID`: asserts rejection with `reference_id_mismatch`, confirms state remains `ORDER_CREATED`, and confirms no `buyer_approved` audit event is created.
   - `rejects buyer approval when remote order id does not match payment attempt order id`: asserts rejection with `order_id_mismatch`, confirms state remains `ORDER_CREATED`, and confirms no `buyer_approved` audit event is created.
2. **`tests/paypal/api.test.ts`**:
   - `returns 400 when PayPal order reference_id does not match purchase ID`: asserts route handler returns HTTP 400 with error code `reference_id_mismatch`.

*Note:* All tests use mocked HTTP/PayPal client responses. Live PayPal Sandbox API verification remains unperformed.

---

## 4. Verification Execution & Exit Codes

| Command | Exit Code | Result | Details |
| :--- | :---: | :---: | :--- |
| `npm test` | **0** | **PASS** | 32 test files, 473 tests passed (6 new tests, 0 regressions) |
| `npx tsc --noEmit` | **0** | **PASS** | Zero TypeScript errors across codebase and tests |
| `npm run lint` | **0** | **PASS** | Zero ESLint warnings or errors |
| `npm run build` | **0** | **PASS** | Next.js production build succeeded with Turbopack |

---

## 5. Gate 1 Baseline Integrity Verification

The Gate 1 file `C:\paypal-gate1\gate1.mjs` was verified using SHA-256 before and after the fix:
- **Baseline Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Preflight Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Postflight Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Integrity Status:** **MATCH (Unchanged)**

---

## 6. Unresolved Limitations

1. **Unapplied PostgreSQL Migrations:** Migrations `20261020124600_phase1_domain` and `20261020150000_phase4_1_idempotency_audit` remain unapplied on this host due to the absence of a running PostgreSQL instance.
2. **Mocked Transports:** Tests are deterministic unit/integration tests with mocked transports. Live Sandbox end-to-end testing with real PayPal accounts requires environment credentials.
3. **Capture Scope:** Order capture endpoints and live-money transactions remain unimplemented, as required by Phase 5 and Phase 5.1 boundaries.

---

## 7. Git Status & Deployment Confirmation

- **Branch:** `master`
- No commits were made, no Git remotes exist, and nothing was published, pushed, deployed, captured, or transacted with real money.

---

## 8. Final Verdict

**PASS** — The purchase unit structure, single-unit invariant, internal purchase reference ID matching, and remote order ID verification are fully implemented and verified with regression tests. All verification commands exited 0. Phase 6 has not been started.
