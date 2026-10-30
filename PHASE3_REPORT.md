# Phase 3 Implementation Report — Product Discovery & Evidence Ingestion

Internal Working Title: **Purchase Assurance** (internal only; brand not cleared for public release).

---

## 1. Executive Summary

Phase 3 implements the deterministic product-discovery and evidence-ingestion layer for Purchase Assurance according to the Blueprint specifications. Discovered candidate data and external claims are treated strictly as untrusted input. The implementation preserves full provenance, performs non-floating-point monetary validation, extracts evidence items with candidate isolation and UTC timestamps, and interfaces with the Phase 1 state machine and Phase 2 deterministic policy engine.

Following the Phase 3 final acceptance audit, a targeted defect fix was applied to `lib/discovery/evidence.ts` and `lib/discovery/types.ts` to eliminate timestamp fallback to the current clock time. Missing or malformed observation timestamps now fail closed as `unknown` in `P-FRESHNESS` and are never silently repaired.

All 19 test suites and 353 tests pass. Gate 1 baseline SHA-256 remains exactly `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`. Zero Phase 0, 1, or 2 files were modified.

---

## 2. Targeted Defect Resolution: Timestamp Fallback

### The Defect
`formatUtcIso8601()` previously substituted `fallback.toISOString()` (`options.now`) when an observation timestamp was missing, invalid, or malformed. This had the unintended effect of making unverified or un-timestamped evidence appear freshly captured (0ms age), incorrectly satisfying `P-FRESHNESS`.

### The Resolution
1. **Removed Clock Fallback:** `formatUtcIso8601(val: unknown)` no longer accepts a fallback clock Date. If `val` is missing (`undefined`, `null`), empty string, or an invalid `Date`, it returns `""` (empty string). If `val` is an unparseable date string, it preserves the trimmed unparseable string.
2. **Strict Downstream Rejection:**
   - Empty string (`""`) and unparseable strings are evaluated by `parseCapturedAt()` in `lib/policy/rules/freshness.ts`.
   - Both produce `{ valid: false, error: ... }`, which causes `freshnessRule` to return `outcome: "unknown"` with reason `missing or invalid capturedAt timestamp`.
   - The aggregate policy engine (`evaluatePolicy`) fails closed with `allRequiredPassed: false` and places `P-FRESHNESS` in `unknownRuleKeys`.
3. **Fingerprint Invalidation:** If any evidence record contains an invalid or non-ISO-8601 UTC timestamp, `computeEvidenceFingerprint` is not called and `evidenceFingerprint` remains `""` (`isComplete: false`), preventing state machine policy approval.
4. **Valid UTC Normalization Preserved:** Valid timestamps (e.g., `"2026-10-20T08:30:00-04:00"`) continue to be normalized to canonical UTC ISO-8601 (`"2026-10-20T12:30:00.000Z"`).

---

## 3. Files Created & Modified

| File Path | Role & Responsibilities |
|---|---|
| `lib/discovery/types.ts` | Core domain interfaces: `ProductSearchRequest`, `SearchConstraints`, `RawDiscoveredCandidate`, `NormalizedProductCandidate`, `SourceAdapter`, `SourceAdapterCapabilities`, `DiscoveryResult`, `EvidenceRecord`, `EvidenceIngestionResult`. Updated with `invalidTimestampAttributeKeys`. |
| `lib/discovery/normalize.ts` | Validation and normalization engine: URL validation (http/https protocols), exact decimal string and integer money parsing (without float math), whitespace normalization, required field validation, and deterministic commercial snapshot hash computation via `computeSnapshotHash`. |
| `lib/discovery/evidence.ts` | Evidence ingestion and mapping: candidate isolation (`candidateId`), requirement key matching, status determination (`supports`, `contradicts`, `missing`), empty/whitespace rejection, conflict detection, strict ISO-8601 UTC timestamp formatting without clock fallback, and evidence fingerprint computation. |
| `lib/discovery/fixture-adapter.ts` | Deterministic fixture-backed source adapter: declares explicit capabilities, uses reproducible fixture datasets, simulates upstream errors, and handles search constraints without scraping or masquerading as live retailer. |
| `lib/discovery/index.ts` | Barrel exports for discovery module. |
| `tests/discovery/normalize.test.ts` | 18 tests: URL protocol validation, exact money parsing, MAX_CENTS and MAX_CENTS + 1 boundary tests, currency preservation, required fields, incomplete candidate flags, whitespace handling, and snapshot hash determinism. |
| `tests/discovery/evidence.test.ts` | 18 tests: Candidate isolation, requirement matching, status mapping, semantic contradictions, conflicting evidence values, timestamp formatting regression tests (missing, empty, malformed, invalid Date, valid UTC), and end-to-end freshness fail-closed tests. |
| `tests/discovery/adapter.test.ts` | 8 tests: Capabilities, query execution, empty result sets, simulated upstream failure, constraints filtering (budget, allow-list), and malformed fixture handling. |
| `tests/discovery/contracts.test.ts` | 5 tests: Typing compliance, translation to `CandidateFacts`, AI non-override invariant, and fail-closed behavior for unsupported/ambiguous evidence. |
| `tests/discovery/integration.test.ts` | 2 tests: Full pipeline integration: Discovery -> Candidate Selection -> Evidence Ingestion -> Policy Engine (`evaluatePolicy`) -> State Machine transitions (`transition` T1, T2, T4, T5, T6). |
| `tests/discovery/source-hygiene.test.ts` | 16 tests: Module isolation: no network calls, no scrapers, no AI model packages, no PrismaClient instantiation, pure offline execution. |

---

## 4. Normalization, Validation, and Snapshot Rules

1. **Protocol and URL Safety:** Only `http:` and `https:` URLs with non-empty hostnames are accepted. Protocols like `javascript:`, `data:`, `file:`, or `ftp:` are rejected as invalid URLs.
2. **Exact Arithmetic without Floating-Point Errors:**
   - Float values (e.g., `29.99` as a JavaScript number) are strictly rejected to avoid IEEE 754 precision inaccuracies.
   - Money is accepted as integer cents or exact decimal strings (`/^\d+(\.\d{1,2})?$/`).
   - Parsed using `BigInt(integerPart) * BigInt(100) + BigInt(fractionPart)` and bounds-checked against `MAX_CENTS` (2,147,483,647). Boundary tests verify `MAX_CENTS` passes and `MAX_CENTS + 1` fails closed.
3. **No Inferred Commercial Terms:**
   - Free shipping ($0) is never assumed if shipping is absent; omission yields an incomplete candidate.
   - Stock availability is never inferred if absent; omission yields an incomplete candidate.
   - Currency must be explicitly `"USD"`.
4. **Snapshot Hash Generation:**
   - Complete candidates compute `snapshotHash` using Phase 1's `computeSnapshotHash` covering the 10 canonical commercial fields: `availability`, `currency`, `externalId`, `merchantName`, `merchantUrl`, `quantity`, `shippingCents`, `source`, `totalCents`, and `unitPriceCents`.
   - Raw source payload is preserved untouched under `candidate.rawSourceData` for forensic auditing.
5. **AI Non-Override Invariant:** External AI confidence, recommendation flags, or bypass tags cannot override evidence status, missing fields, or policy outcomes.

---

## 5. Verification Commands & Operational Results

| Command | Exit Code | Outcome |
|---|---|---|
| `npm run lint` | `0` | Clean; 0 warnings, 0 errors. |
| `npx tsc --noEmit` | `0` | Clean TypeScript compilation; 0 type errors. |
| `npm test` | `0` | **19 test suites passed**, **353 tests passed**, 0 failed. |
| `npx prisma validate` | `0` | Prisma schema at `prisma/schema.prisma` is valid. |
| `npx prisma generate` | `0` | Prisma Client v7.10.1 generated successfully. |
| Gate 1 SHA-256 pre-check | `0` | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` |
| Gate 1 SHA-256 post-check | `0` | `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` |
| `git remote -v` | `0` | Empty; no remote configured. |

---

## 6. Known Limitations & Unresolved Decisions

1. **Merchant Identity Boundary:** Natural product identity `(merchantName, externalId)` is merchant-scoped. Cross-merchant identity resolution requires universal identifiers (UPC/GTIN/EAN) which are not part of the current feed schema.
2. **Text Normalization Scope:** Evidence comparison uses case-insensitive, trimmed string comparison. It does not perform semantic translation across metric/imperial units or synonym matching.
3. **Source Adapter Breadth:** Only the fixture-backed adapter is active. Live retailer integrations or external HTTP scraping remain explicitly prohibited until Phase 4 authorization.
