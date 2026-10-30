# Phase 2 Verification and Policy Engine Report (Post-Audit)

Internal Working Title: **Purchase Assurance** (internal only; brand not cleared for public release).

---

## 1. Executive Summary & Targeted Audit Disposition

Following the Phase 2 targeted correctness audit covering Duplicate Identity (Audit A), Evidence Semantics (Audit B), Freshness (Audit C), and Aggregate Fail-Closed Behavior (Audit D), minimal deterministic corrections were applied to `lib/policy/rules/duplicate.ts`, `lib/policy/rules/evidence.ts`, `lib/policy/rules/freshness.ts`, and `lib/policy/evaluator.ts`.

All 13 test suites and 286 tests run and pass without regressions across Phase 0, Phase 1, and Phase 2.
Gate 1 hash was verified before and after the audit and remains:
`F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`.

---

## 2. Audit Findings & Implemented Corrections

### Audit A — Duplicate Identity (`lib/policy/rules/duplicate.ts`)
1. **Algorithm Analysis:**
   - Previous logic relied on `target.id === historical.candidateId` as a fallback. In PostgreSQL, candidate `id` is a purchase-scoped UUID generated on each insert, rendering cross-purchase UUID equality ineffective.
   - If commercial terms (price, shipping) change, `snapshotHash` changes. Relying on `snapshotHash` alone would allow the exact same product SKU to evade duplicate detection.
   - If a historical record within the 24-hour window lacked an `externalId` and had a differing `snapshotHash`, previous code assumed non-match and returned `pass` (a potential false negative).
2. **Minimal Deterministic Correction Applied:**
   - Replaced surrogate UUID comparison with a tri-state identity comparison (`compareCandidateIdentity`):
     - **`match` (Duplicate):** Identical `snapshotHash` OR identical normalized `(merchantName, externalId)`. Detects duplicates even if `snapshotHash` changes due to price fluctuations or candidate UUID changes.
     - **`distinct` (Different Product):** Both records have valid `(merchantName, externalId)` and `externalId` differs under the same merchant, or merchants differ.
     - **`incomparable` (Ambiguous):** Historical item in the 24-hour window lacks `externalId` while `snapshotHash` differs. Because `snapshotHash` changes with price, non-matching hash without SKU cannot prove distinctness. The rule returns **`unknown`** (`incomparable_historical_candidate_identity`), preventing false negatives.
3. **Identifier Capabilities Documented:**
   - `(merchantName, externalId)`: Establishes persistent product identity at a specific merchant. Cannot establish cross-merchant identity (no universal UPC/GTIN in schema).
   - `snapshotHash`: Establishes exact commercial identity at capture time. Cannot establish persistent product identity across price changes.
   - `candidateId`: Local database row surrogate. Explicitly excluded from cross-purchase product identity.

### Audit B — Evidence Semantics (`lib/policy/rules/evidence.ts`)
1. **Semantic Value Validation:**
   - Updated `evidenceRule` to compare evidence `value` against requirement expected values (`expectedValue`), rather than merely verifying row existence.
   - When a requirement specifies an expected value (e.g. `{ key: "color", expectedValue: "blue" }`), the evidence `value` must semantically match (case-insensitive, trimmed).
   - If evidence status is `"supports"`, but evidence `value` contradicts the expected value (e.g. `"red"` vs. `"blue"`), it is treated as a semantic contradiction and returns **`block`**.
   - If evidence status is `"supports"`, but evidence `value` is empty or whitespace, it is rejected as insufficient and returns **`unknown`**.
   - If multiple evidence items assert support with conflicting values for the same attribute (e.g. `"ANSI"` vs. `"ISO"`), it returns **`unknown`** (unresolved conflict).

### Audit C — Freshness (`lib/policy/rules/freshness.ts`)
1. **Evaluation Scope:**
   - Updated `freshnessRule` to filter evidence strictly to the selected candidate (`candidateId`), preventing stale evidence from unrelated candidates from causing false blocks.
   - Validates that freshness is verified for all evidence required to support the purchase: if required attributes are specified and an attribute lacks supporting evidence, freshness cannot be established and returns **`unknown`**.
   - Strict threshold validation: missing or invalid `maxAgeMs` (<= 0, non-integer) returns `unknown`, never a permissive default.
   - Pure clock isolation: evaluation timestamp `context.now` is strictly required; no parameterless `new Date()` or `Date.now()`.

### Audit D — Aggregate Fail-Closed Behavior (`lib/policy/evaluator.ts`)
1. **Duplicate Rule Key Rejection:**
   - Evaluator strictly checks `config.requiredRuleKeys` for duplicates. If duplicate keys are detected, it fails closed with **`unknown`** and prevents approval.
   - Every unique required rule runs exactly once.
   - Unrecognized rule keys are not silently ignored; they produce an `unknown` outcome in `unknownRuleKeys`.
   - Aggregate `allRequiredPassed` is `true` only when every required rule produces `pass`.
   - Zero AI influence: external AI recommendations or override flags cannot alter rule outcomes.

---

## 3. Files Created and Modified

### Files Modified During Targeted Audit:
1. `lib/policy/types.ts`: Added `RequiredAttributeSpec`, updated `FreshnessRuleInput` and `PurchaseEvaluationFacts`.
2. `lib/policy/rules/duplicate.ts`: Implemented `compareCandidateIdentity` (tri-state), eliminated surrogate UUID matching, added fail-closed incomparable detection.
3. `lib/policy/rules/evidence.ts`: Implemented semantic value comparison against `expectedValue`, empty value rejection, and conflicting value detection.
4. `lib/policy/rules/freshness.ts`: Implemented candidate isolation and required-attribute evidence freshness verification.
5. `lib/policy/evaluator.ts`: Implemented duplicate required rule key rejection and passed candidateId/requiredAttributes to freshness evaluation.
6. `tests/policy/rules.test.ts`: Added 12 new targeted tests (total 63 tests).
7. `tests/policy/aggregate.test.ts`: Added 2 new targeted tests (total 14 tests).
8. `docs/PHASE2_POLICY_ENGINE.md`: Updated with identifier capabilities, incomparable identity resolution, and semantic evidence value matching.
9. `PHASE2_REPORT.md`: This report.

---

## 4. Test Suite Execution & Counts

Vitest execution summary: **13 test files passed, 286 tests passed, 0 failed.**

### Test Breakdown by Suite:
| Suite File | Category | Tests Passed | Status |
|---|---|:---:|:---:|
| `tests/policy/rules.test.ts` | Phase 2 Policy Rules | 63 | **PASS** |
| `tests/policy/source-hygiene.test.ts` | Phase 2 Purity / Hygiene | 37 | **PASS** |
| `tests/policy/aggregate.test.ts` | Phase 2 Aggregate Evaluation | 14 | **PASS** |
| `tests/policy/registry.test.ts` | Phase 2 Rule Registry | 4 | **PASS** |
| `tests/state/transitions.test.ts` | Phase 1 State Machine | 49 | **PASS** |
| `tests/state/source-hygiene.test.ts` | Phase 1 Purity / Hygiene | 33 | **PASS** |
| `tests/state/money-snapshot.test.ts` | Phase 1 Money / Snapshot | 23 | **PASS** |
| `tests/state/approval.test.ts` | Phase 1 Approval Invalidation | 19 | **PASS** |
| `tests/state/integrity.test.ts` | Phase 1 P1–P9 Integrity | 16 | **PASS** |
| `tests/audit/writer.test.ts` | Phase 1 Audit Event Logging | 9 | **PASS** |
| `tests/tokens.test.ts` | Phase 0 WCAG Contrast & Tokens | 8 | **PASS** |
| `tests/state/policy-summary.test.ts` | Phase 1 Policy Summary | 7 | **PASS** |
| `tests/source.test.ts` | Phase 0 Source Constraints | 4 | **PASS** |
| **Total** | **All 13 Suites** | **286** | **PASS** |

---

## 5. Verification Commands and Exit Codes

| Command | Exit Code | Observed Output | Status |
|---|:---:|---|:---:|
| `npm run lint` | `0` | Zero warnings, zero errors (`eslint`) | **PASS** |
| `npx tsc --noEmit` | `0` | Zero TypeScript compilation errors | **PASS** |
| `npm test` | `0` | 13 test files passed, 286 tests passed | **PASS** |
| `npx prisma validate` | `0` | Prisma schema at `prisma/schema.prisma` is valid | **PASS** |
| `npx prisma generate` | `0` | Prisma Client generated successfully (v7.10.1) | **PASS** |

---

## 6. Gate 1 Hash Baseline Verification

Command: `powershell -Command "Get-FileHash -Algorithm SHA256 'C:\paypal-gate1\gate1.mjs'"`

* Baseline: `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
* **Pre-Audit Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` (**MATCH**)
* **Post-Audit Hash:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` (**MATCH**)
* `C:\paypal-gate1` was not modified or inspected.

---

## 7. Retained Limitations & Unresolved Decisions

1. **OD-3 (Freshness Window Duration):** Unresolved owner decision. No production freshness duration is specified in the blueprint. The engine requires explicit caller configuration (`maxAgeMs > 0`) and never defaults.
2. **Identity Scope Limitation:** Available identifiers establish product identity within a merchant (`externalId` + `merchantName`) or exact commercial snapshot (`snapshotHash`). Universal cross-merchant product identification (e.g. UPC/GTIN) is not supported by the data model.
3. **Execution Boundaries:** The engine is purely in-memory and functional. No database writes, API routes, UI components, Channel3 discovery, or PayPal flows have been implemented.
4. **Phase Isolation:** Git remote is empty, no branches published/pushed, no migrations applied, and Phase 3 has not started.
