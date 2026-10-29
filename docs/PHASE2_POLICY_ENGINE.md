# Phase 2 Policy Engine Documentation

Internal Working Title: **Purchase Assurance** (internal only; brand not cleared for public release).

---

## 1. Overview & Architectural Guarantees

The Phase 2 Policy Engine is a pure, deterministic TypeScript module located in `lib/policy/`. It evaluates purchasing candidates against confirmed buyer requirements, vendor allow-lists, freshness thresholds, and duplicate purchase history.

### Strict Guarantees:
1. **Zero External I/O:** The engine does not make network requests, execute database queries, or read filesystem/environment variables.
2. **Clock Isolation:** Functions never invoke `Date.now()`, `Math.random()`, or parameterless `new Date()`. The caller explicitly supplies the evaluation timestamp (`context.now`).
3. **Integer Cents Monetary Arithmetic:** All monetary amounts (`totalCents`, `budgetCents`, etc.) use non-negative integer cents bounded by `MAX_CENTS` (2,147,483,647). Floating-point arithmetic for currency is strictly prohibited.
4. **Zero AI/LLM Influence:** The engine contains no AI/LLM dependency, prompts, or scoring weights. External AI claims, override recommendations, or confidence scores cannot alter or bypass rule outcomes.
5. **Fail-Closed Failures:** Any missing, unverified, malformed, or out-of-range required input produces an explicit `unknown` outcome, which blocks aggregate approval.
6. **Immutability:** All input objects (`candidate`, `purchase`, `config`, `evidence`) remain completely unmutated throughout evaluation.

---

## 2. Standard Rule Catalog

All eight required rules are registered in the registry (`lib/policy/registry.ts`) with explicit keys and stable semantic versions:

| # | Rule Key | Version | Purpose | Pass Condition | Block Condition | Unknown Condition |
|---|---|---|---|---|---|---|
| 1 | `P-BUDGET` | `1.0.0` | Total within budget | Stored total <= confirmed budget | Stored total > confirmed budget | Missing/invalid budget or total, negative, non-integer, or > MAX_CENTS |
| 2 | `P-CURRENCY` | `1.0.0` | Supported currency | Both candidate and purchase currency are `"USD"` | Known valid ISO 4217 currency differs from `"USD"` (e.g., EUR, GBP, CAD) | Missing, empty, or unparseable currency code |
| 3 | `P-QUANTITY` | `1.0.0` | Requested quantity match | Authoritative candidate quantity === confirmed requested quantity | Quantities differ | Quantity missing, non-integer, <= 0, or > MAX_CENTS |
| 4 | `P-EVIDENCE` | `1.0.0` | Required attributes supported | All confirmed required attributes are supported by matching candidate evidence | Any required attribute has contradicting candidate evidence | Evidence missing, insufficient, belongs to another candidate, or has unresolvable conflicts |
| 5 | `P-AVAILABILITY` | `1.0.0` | Candidate in stock | Authoritative candidate availability is `"in_stock"` | Authoritative candidate availability is `"out_of_stock"` | Missing, empty, or ambiguous status (e.g. `"preorder"`, `"backordered"`, `"unknown"`) |
| 6 | `P-VENDOR` | `1.0.0` | Merchant on allow-list | Merchant name matches an entry on the caller-supplied allow-list | Merchant name is known but not on the allow-list | Merchant name or allow-list is missing, empty, or non-array |
| 7 | `P-FRESHNESS` | `1.0.0` | Evidence freshness window | All evidence items have `0 <= ageMs <= maxAgeMs` | Any valid evidence item has `ageMs > maxAgeMs` | Threshold missing/invalid (<= 0), missing/corrupt timestamps, or future evidence (`capturedAt > now`) |
| 8 | `P-DUPLICATE` | `1.0.0` | Duplicate purchase within 24h | Trustworthy & complete history confirms no matching purchase in `[now - 24h, now]` | Matching candidate was purchased in `[now - 24h, now]` | Candidate identity insufficient, corrupt timestamps, or history completeness unverified (`isHistoryComplete !== true`) |

---

## 3. Outcome Semantics: `block` vs. `unknown`

Every rule evaluates to exactly one of three deterministic outcomes:
- `"pass"`: The input data is authoritative, complete, valid, and meets the requirement.
- `"block"`: The input data is authoritative and valid, but definitively violates the requirement (e.g., total exceeds budget, merchant is disallowed, evidence contradicts specification).
- `"unknown"`: The evaluation cannot definitively confirm compliance because required information is absent, malformed, incomplete, or ambiguous (e.g., missing evidence, unverified history completeness, missing freshness threshold, future timestamps).

### Critical Distinction in Aggregate Evaluation:
Both `"block"` and `"unknown"` outcomes **prevent aggregate approval** (`allRequiredPassed: false`).
However, their operational semantics differ:
- A `block` indicates a definitive domain violation that requires selecting a different candidate or changing requirements.
- An `unknown` indicates an informational defect or unverified prerequisite (e.g., missing allow-list configuration or incomplete purchase history) that requires supplying authoritative data before reevaluation can succeed.

---

## 4. Aggregate Evaluation Contract

The engine provides one aggregate entrypoint: `evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluationResult`.

### Input Interface:
- `candidate`: Candidate facts (`id`, `totalCents`, `currency`, `quantity`, `availability`, `merchantName`, `externalId`, `snapshotHash`).
- `purchase`: Confirmed purchase requirements (`budgetCents`, `currency`, `requestedQuantity`, `requiredAttributes`).
- `evidence`: Optional array of evidence items (`candidateId`, `requirementKey`, `status`, `value`, `capturedAt`).
- `config`: Caller-supplied policy configuration:
  - `requiredRuleKeys`: Optional subset of rules to evaluate (defaults to all 8 standard rules).
  - `vendorAllowList`: List of approved merchant names.
  - `maxEvidenceAgeMs`: Maximum permitted evidence age in milliseconds.
  - `purchaseHistory`: Authoritative historical purchase records.
  - `isHistoryComplete`: Explicit boolean confirming whether purchase history is complete and trustworthy.
- `now`: Caller-supplied evaluation timestamp (`Date`).
- `policyVersion`: Optional version identifier (defaults to `"1.0.0"`).

### Output Interface:
```ts
export interface PolicyEvaluationResult {
  summary: PolicySummary;
  ruleResults: Record<string, RuleResult>;
  evaluatedAt: Date;
  policyVersion: string;
}
```
The returned `summary` strictly implements Phase 1's `PolicySummary` contract:
- `allRequiredPassed`: `true` **only if** every required rule produces `"pass"`.
- `blockingRuleKeys`: Array of rule keys that evaluated to `"block"`.
- `unknownRuleKeys`: Array of rule keys that evaluated to `"unknown"`.

This summary object can be passed directly to the Phase 1 state machine transition command:
`{ kind: "apply_policy_summary", summary: result.summary, policyVersion: result.policyVersion }`.
- When `allRequiredPassed` is `true`, transition T4 moves purchase status to `POLICY_PASSED`.
- When `allRequiredPassed` is `false`, transition T5 moves purchase status to `POLICY_BLOCKED`.

---

## 5. Unresolved Owner Decisions

### OD-3 (Freshness Window Duration)
The Pactora blueprint specifies that evidence freshness must be verified against a maximum age window, but does **not** specify a production threshold duration (e.g., 1 hour, 24 hours, 7 days).
- **Resolution in Engine:** The policy engine refuses to silently default or invent a threshold. The caller must explicitly supply `maxEvidenceAgeMs` in `config`. If omitted or invalid (<= 0), `P-FRESHNESS` evaluates to `unknown`, failing closed.
- **Status:** Unresolved owner decision. A production freshness threshold must be formally established by product leadership prior to production deployment.

---

---

## 6. History Completeness, Candidate Identity & What Available Identifiers Establish

Rule `P-DUPLICATE` checks for duplicate purchases of the same candidate within a strict 24-hour window (`[now - 24h, now]`).

### What Available Identifiers Can and Cannot Establish:
1. **`(merchantName, externalId)` (Authoritative Merchant SKU):**
   - **Can Establish:** Cross-purchase product identity at a specific merchant. If both records have matching `merchantName` and `externalId`, the product is identified as the same item even if commercial terms, price, shipping, or snapshot hashes change. If `externalId` differs under the same merchant, it definitively proves they are distinct products.
   - **Cannot Establish:** Identity across *different* merchants (e.g. buying the same manufacturer item at Amazon vs. BestBuy), because `externalId` is merchant-scoped. Universal identifiers (e.g. UPC/GTIN) are not present in the Phase 1 schema.
2. **`snapshotHash` (Cryptographic Commercial Fingerprint):**
   - **Can Establish:** Exact commercial identity at the moment of capture (identical product, price, shipping, quantity, and merchant).
   - **Cannot Establish:** Persistent product identity if commercial terms change. A 1-cent price difference or shipping update produces a different `snapshotHash`. A differing `snapshotHash` alone *never* proves that two items are different products.
3. **Surrogate Row UUID (`id` / `candidateId`):**
   - **Explicitly Excluded:** In PostgreSQL, candidate `id` is a purchase-scoped UUID generated on each insert. It cannot establish product identity across separate purchases.

### Tri-State Identity Resolution in `P-DUPLICATE`:
- **`match` (Definitive duplicate):** Matching `(merchantName, externalId)` OR matching `snapshotHash`.
- **`distinct` (Definitively different):** Both have valid `(merchantName, externalId)` and `externalId` differs under the same merchant, or merchant names differ.
- **`incomparable` (Ambiguous):** Historical record lacks `externalId` and its `snapshotHash` differs. Because `snapshotHash` changes when prices fluctuate, a differing hash without a SKU cannot prove distinctness.
  - **Fail-Closed Rule:** If an incomparable item exists in the 24-hour window, `P-DUPLICATE` returns `unknown` rather than producing a false negative `pass`.

---

## 7. Evidence Semantic Value Matching

Rule `P-EVIDENCE` evaluates whether required attributes are supported:
- **Attribute Key Match:** Evidence must match the exact requirement key and belong to the selected candidate (`candidateId`).
- **Semantic Value Comparison:** When a requirement specifies an expected value (e.g. `{ key: "color", expectedValue: "blue" }`), the evidence `value` must semantically match the expected value (case-insensitive trimmed equality).
  - If evidence status is `"supports"`, but evidence `value` does not match `expectedValue`, the rule treats this as a semantic contradiction and returns `block`.
- **Sufficiency:** Supporting evidence items with empty or whitespace values are rejected as insufficient and return `unknown`.
- **Conflicting Values:** If multiple evidence items assert support with different values for the same attribute (e.g. `"ANSI"` vs. `"ISO"`), the conflict cannot be deterministically resolved and returns `unknown`.

---

## 8. Current Boundaries & Limitations

1. **Pure & In-Memory:** The engine is purely functional. It does not write to the database or mutate state.
2. **Not Yet Integrated:** The engine is not yet connected to Next.js API routes, front-end UI forms, product discovery/scraping pipelines (Channel3), or PayPal payment workflows.
3. **No End-to-End Enforcement Claim:** Full end-to-end policy enforcement will only be achieved once these upstream and downstream integrations are completed in subsequent phases.
