# Plinthly — Public GitHub Release Curation Manifest

**Project:** Plinthly — Agentic Commerce & Purchase Assurance  
**Tagline:** *"Every purchase. Proven."*  
**Target Event:** PayPal AI Hackathon (*Build What's Next with PayPal and AI*)  
**Submission Deadline:** November 12, 2026, 12:00 PM Pacific Time  
**Author / Entrant:** Tushar Kumar  
**License:** MIT License (Copyright © 2026 Tushar Kumar)  
**Manifest Status:** **CURATED & AUDITED — READY FOR STAGING**  

---

## 1. Executive Summary

This manifest specifies the exact curation of files for Plinthly's first public release on GitHub. 

The curation strictly preserves **100% of functional code, architecture, database routines, test suites, and PayPal Developer Platform Sandbox integration**, while safely separating internal scratch scripts, temporary debugging logs, and internal phase audits from the public repository tree.

**Zero original local files were deleted.** All excluded files remain safely preserved on the local disk.

---

## 2. Categories of Included Files (Proposed for Public Git Release)

### A. Application Source Code & User Interface (48 files)
Full-stack Next.js 16 (Turbopack) frontend and React 19 UI components:
- **Application Pages & Layout:** `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `app/design/page.tsx`
- **UI Component System:** `components/ui/` (AppShell, Button, Card, Input, Banner, StatusChip, ThemeToggle, Tooltip)
- **Workflow & Procurement Components:** `components/workflow/`
  - `purchase-dashboard.tsx` (5-step milestone stepper & sample switcher)
  - `purchase-request-card.tsx` (Natural language intent entry & AI decomposition)
  - `multi-item-procurement-studio.tsx` (3-item workstation studio & strategy breakdown)
  - `candidate-evaluation-card.tsx` & `candidate-comparison-grid.tsx` (AG Grid candidate evidence)
  - `stage2-approval-modal.tsx` (Cryptographic SHA-256 snapshot approval gate)
  - `paypal-multi-cart-checkout.tsx` (Sequential capture with multi-merchant failure isolation)
  - `stage2-purchase-receipt.tsx` (Cryptographic settlement receipt & partial refund UI)
  - `audit-card.tsx` & `actor-bar.tsx` (Immutable audit ledger & local actor switcher)

### B. Backend API Routes & Services (33 files)
Next.js server-side API routes enforcing strict Zod validation, actor authentication, and monotonic transactions:
- **AI Intent Parsing:** `app/api/ai/decompose/route.ts`
- **Multi-Item Strategy Engine:** `app/api/purchases/[id]/multi-item/plan/route.ts`, `app/api/purchases/[id]/multi-item/approve/route.ts`
- **Relational Cart Orchestration:** `app/api/cart/allocate/route.ts`, `app/api/cart/checkout/route.ts`, `app/api/cart/aggregate/[aggregateId]/route.ts`
- **Sequential Capture & Refund:** `app/api/cart/capture/route.ts`, `app/api/cart/refund/route.ts`, `app/api/cart/status/[cartId]/route.ts`
- **PayPal Webhooks & Keys:** `app/api/webhooks/paypal/route.ts`, `app/api/admin/keys/revoke/route.ts`
- **Platform Health & Metrics:** `app/api/health/route.ts`, `app/api/metrics/route.ts` (Prometheus telemetry)
- **Core Workflow Engine (`lib/`):**
  - `lib/ai/` (Google Gemini intent decomposer & schema types)
  - `lib/discovery/cart/` (Pareto strategy engine, allocation, completeness validator, line items)
  - `lib/paypal/` (PayPal REST v2 client & OAuth2 token caching)
  - `lib/workflow/` (Cart capture service, state machine, landed-cost reconciler, gateway adapter, refund service, relational allocation service, stage2 client API, webhook reconciler)
  - `lib/crypto/` (Asymmetric attestation, OpenSSL X.509 verifier, PayPal CRC-32)
  - `lib/database/` (Stage 2 connection pool, Stage 3 worker pool manager)
  - `lib/queue/` (Webhook fast-ack durable queue)
  - `lib/tax/` (Statutory tax provider adapters)
  - `lib/telemetry/` (Structured JSON logger, alerts, metrics)
  - `lib/workers/` (Ingress workers, reconciliation workers, lease recovery)

### C. Database Architecture & Canonical Migrations (11 files)
Full PostgreSQL 15 schema, role permissions, and canonical routines:
- **Schema:** `prisma/schema.prisma`
- **Migrations (`prisma/migrations/`):**
  - `20261020124600_phase1_domain/migration.sql` (Stage 1 single-item schema)
  - `20261029141000_quantity_confirmation/migration.sql` (Draft row locking)
  - `20261107000000_stage2_schema/migration.sql` (Multi-retailer domain schema)
  - `20261107010000_stage2_trigger_hardening/migration.sql` (Database trigger invariants)
  - `20261107020000_stage2_canonical_routines/migration.sql` (Canonical routines `R2-01` to `R2-08`)
  - `20261107030000_stage2_crypto_remediation/migration.sql` (Asymmetric verification routines)
  - `20261107040000_stage2_cart_failure_routine/migration.sql` (Cart failure isolation)
  - `20261107050000_stage2_crypto_sentinel_fix/migration.sql` (Cryptographic sentinel remediation)
  - `20261108020000_stage3_webhook_queue_lease_recovery/migration.sql` (Lease recovery)
  - `20261108030000_stage3_refund_intent_pre_persistence/migration.sql` (DEF-P4-01 pre-persistence)
  - `init_roles.sql` (Least-privilege PostgreSQL roles: `app_orchestrator_role`, `webhook_processor_role`, etc.)

### D. Automated Test Suite (116 test files, 1,603 tests)
Complete regression, unit, adversarial, concurrency, and integration test coverage:
- `tests/acceptance/` (Concurrency locking, arithmetic invariants, routine pairings)
- `tests/database/` (Monotonic locks, routine privilege boundaries, schema integrity)
- `tests/e2e/` (Stage 3 PayPal Sandbox end-to-end lifecycle)
- `tests/fixtures/` (Synthetic certificates, mock payloads)
- `tests/integration/` (Live PayPal Sandbox REST v2 tests, gateway adapters, tax providers)
- `tests/security/` (mTLS workload identity, token forgery, header spoofing)
- `tests/ui/` (Multi-item evaluation UI, theme hydration, procurement studio flow)
- `tests/unit/` (Asymmetric signature verifier, decimal parser, discount allocation, telemetry)
- `tests/workers/` (Webhook ingress, queue resilience, lease recovery, DLQ)
- `tests/workflow/` (Strategy completeness audit, sequential capture, landed-cost reconciler, refund provenance, cart allocation)

### E. Primary Hackathon Documentation (13 files)
Canonical documentation curated for Devpost judges and public evaluators:
1. `README.md` — Core repository presentation, quickstart, Mode A (Local Demo) vs. Mode B (PayPal Sandbox), Model A Landed Cost formula.
2. `LICENSE` — Standard MIT License (Copyright © 2026 Tushar Kumar).
3. `PITCH_NARRATIVE.md` — Problem statement, commercial assurance manifesto, competitive differentiation.
4. `JUDGE_DEMO_RUNBOOK.md` — Sub-3-minute timestamped video script (2m 40s) and step-by-step judge walkthrough.
5. `PAYPAL_SANDBOX_E2E_EVIDENCE.md` — Empirical proof of live PayPal Developer Platform Sandbox interactions, order creation, capture, idempotency, refund intent, and partial refund.
6. `HACKATHON_FINALIZATION_REPORT.md` — Hackathon submission questions, official readiness assessment, and answers.
7. `HACKATHON_OFFICIAL_COMPLIANCE_MATRIX.md` — Requirement-by-requirement compliance matrix mapping project evidence to hackathon rules.
8. `HACKATHON_SUBMISSION_CHECKLIST.md` — Submission checklist with 4-state classification (`PASS`, `PENDING`, `UNVERIFIED`).
9. `TECHNICAL_ARCHITECTURE_OVERVIEW.md` — System architecture, canonical routines `R2-01` through `R2-08`, ER diagrams, and security model.
10. `FEATURE_AND_CAPABILITY_DISCLOSURE.md` — Transparent operational boundaries: live cloud APIs vs local DB vs sandbox adapters.
11. `STAGE_3_ARCHITECTURE_CONTRACT.md` — Contractual architectural specification for Stage 3 production boundaries.
12. `STAGE_3_ACCEPTANCE_MATRIX.md` — Stage 3 acceptance criteria and verification proofs.
13. `docs/ops/INCIDENT_RESPONSE_PLAYBOOKS.md` — Production operations and SRE incident response runbooks.

### F. Official Verification Scripts & Demo Evidence (14 files)
- `scripts/verify-baseline.js` — Verifies Stage 1 baseline Gate 1 and Dump SHA-256 hashes against PostgreSQL `plinthly_dev`.
- `scripts/verify-live-sandbox-evidence.js` — Read-only verification of `ApprovedMerchantCart`, `PaymentEvidenceRecord`, `CartRefundRecord`, `RefundEvidenceRecord`, and `WebhookTransmission` in `plinthly_stage2_dev`.
- `scripts/verify_migration_checksum.js` — Verifies SHA-256 checksums of Stage 2 migrations against filesystem.
- `scripts/verify_plinthly_dev_untouched.js` — Verifies Stage 1 database isolation (40 purchases, 0 stage 2 tables).
- `scripts/audit-paypal-sandbox-state.js` — Read-only script querying live PayPal Sandbox REST API for Order `4MT765021L9327907` status and authorization.
- `scripts/audit_baselines.js` — Audits database baseline tables.
- `scripts/audit_database_routines.js` — Audits routine definitions in PostgreSQL catalog.
- `scripts/audit_routine_privileges.js` — Audits privilege grants for `app_orchestrator_role`, `webhook_processor_role`, etc.
- `scripts/execute-live-sandbox-lifecycle.js` — Script executing the genuine PayPal Sandbox lifecycle for Order `4MT765021L9327907`.
- `scripts/last-live-sandbox-result.json` — Sanitized JSON record of the live PayPal Sandbox authorization, capture, retry, and partial refund.
- `scripts/browser-acceptance-check.js` — CDP browser automation script executing the 3-item workstation evaluation and capturing evidence screenshots.
- `scripts/browser-acceptance-evidence-1.png` — Screenshot showing loaded 3-item fixture.
- `scripts/browser-acceptance-evidence-2.png` — Screenshot showing 4 feasible strategies evaluated.
- `scripts/ops/reconcile-gateway-order.ts` — Production/operational triage CLI for reconciling gateway orders with database state.
- `scripts/init-webhook-queue.js` — Operational worker initialization script for webhook queue recovery.

### G. Container & Environment Configuration (8 files)
- `Dockerfile` — Production container build for Stage 3 production deployment.
- `docker-compose.yml` — Local multi-stage PostgreSQL service definition.
- `render.yaml` — Deployment configuration for hosting on Render.
- `package.json` & `package-lock.json` — Dependency declarations.
- `tsconfig.json` & `next.config.ts` — Build configurations.
- `eslint.config.mjs` — Code linting configuration.
- `.env.example` — Safe template with zero secret values.
- `.gitignore` — Ignore rules protecting sensitive files.

---

## 3. Files Excluded from Public Release (Preserved Locally)

The following files are excluded from public Git tracking to maintain repository cleanliness, prevent security leaks, and protect internal audit trails. **All files remain completely preserved on local disk:**

| Path / Pattern | Reason for Exclusion | Local Retention Status |
|---|---|:---:|
| `.env.local` | Contains private development database passwords and local API keys. Strictly excluded by `.gitignore`. | **PRESERVED** |
| `.env.stage2` | Contains isolated Stage 2 database connection strings. Strictly excluded by `.gitignore`. | **PRESERVED** |
| `.backups/plinthly_dev_stage1_baseline.dump` | Binary PostgreSQL dump file (112 KB). Directly read by `verify-baseline.js`. Excluded by `.gitignore`. | **PRESERVED** |
| `.data/` | Transient test persistence and corruption files created by Vitest. Excluded by `.gitignore`. | **PRESERVED** |
| `.next/` & `node_modules/` | Build cache and installed node packages. Excluded by `.gitignore`. | **PRESERVED** |
| `scripts/browser-acceptance-evidence.png` | Initial single screenshot; superseded by `browser-acceptance-evidence-1.png` and `2.png`. | **PRESERVED** |
| `scripts/routine_1.txt` .. `routine_8.txt` (8 files) | Intermediate text dumps of routines `R2-01`..`R2-08`. (Canonical SQL maintained in `prisma/migrations/20261107020000_stage2_canonical_routines/`). | **PRESERVED** |
| One-Time Migration Scripts (6 files):<br/>- `scripts/apply_stage2_migration.js`<br/>- `scripts/apply_phase2_migration.js`<br/>- `scripts/apply_crypto_remediation.js`<br/>- `scripts/apply_stage3_lease_recovery_migration.js`<br/>- `scripts/apply_stage3_refund_intent_migration.js`<br/>- `scripts/generate_phase2_migration.js` | One-time migration application/generation scripts used during development. All migrations are permanently tracked as standard SQL in `prisma/migrations/`. | **PRESERVED** |
| Ad-Hoc Diagnostic Scripts (13 files):<br/>- `scripts/check_payment_attempts.js`<br/>- `scripts/inspect_catalog.js`<br/>- `scripts/inspect_order.js`<br/>- `scripts/inspect_step.js`<br/>- `scripts/list_purchases.js`<br/>- `scripts/search_brain_for_id.js`<br/>- `scripts/search_crypto.js`<br/>- `scripts/print_auth_01.js`<br/>- `scripts/print_nonce_schema.js`<br/>- `scripts/print_sec63.js`<br/>- `scripts/print_sec8.js`<br/>- `scripts/extract_routines.js`<br/>- `scripts/find_functions.js` | Ad-hoc internal inspection scripts containing hardcoded developer queries or assistant-specific paths (`search_brain_for_id.js`). | **PRESERVED** |
| Historical Milestone Audit Reports (39 files):<br/>- `STAGE_1_FINAL_REVIEW_EVIDENCE.md`<br/>- `STAGE_2_DEF_CRYPT_01_REMEDIATION_REPORT.md`<br/>- `STAGE_2_DEF_SEC_V5_01_FINAL_ACCEPTANCE_AUDIT.md`<br/>- `STAGE_2_DEF_SEC_V5_01_REMEDIATION_REPORT.md`<br/>- `STAGE_2_IMPLEMENTATION_EXECUTION_PLAN.md`<br/>- `STAGE_2_PHASE_1_...` to `STAGE_2_PHASE_5_...` (19 files)<br/>- `STAGE_3_IMPLEMENTATION_EXECUTION_PLAN.md`<br/>- `STAGE_3_PHASE_1_...` to `STAGE_3_PHASE_5_...` (13 files)<br/>- `PRE_GITHUB_CLEANUP_REPORT.md` | Detailed forensic engineering checkpoint logs. They contain local Windows paths (`C:\Users\Tushar Kumar\...`). Their findings, contracts, and evidence are synthesized in the 13 primary public documents. | **PRESERVED** |

---

## 4. Security Audit Results

| Audit Check | Method | Result | Notes |
|---|---|:---:|---|
| **Secret & Token Leakage** | Regex scan for API keys (`AIzaSy...`, `sk-ant...`), PayPal client secrets, Bearer tokens | **PASS** | 0 secrets found across all proposed public files. |
| **Private Keys & Certificates** | Regex scan for `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY` | **PASS** | 0 private keys in code or documentation. (Only public X.509 leaf certificates and test certificates exist in `tests/fixtures/test-certificates.ts`). |
| **Buyer Personal Information** | Scan for buyer names, personal email addresses, and account numbers | **PASS** | Buyer details strictly redacted (`[REDACTED_BUYER_EMAIL]`, `[REDACTED_BUYER_ID]`, `[REDACTED_BUYER_NAME]`). Payee is synthetic sandbox merchant (`sb-iwdxd53443156@business.example.com`). |
| **Local Machine Paths** | Scan for `C:\Users\`, `C:/Users/`, `file:///c:/` in retained documentation | **PASS** | All retained public documentation files use portable relative links (`[link](filename.md)`). |
| **Git Tracking Exclusions** | `git ls-files .env*` | **PASS** | Only `.env.example` is tracked. `.env.local` and `.env.stage2` are untracked and excluded by `.gitignore`. |
| **Git Commit History** | `git log --all --full-history -- "**.env*"` | **PASS** | Historical commits (`4c555e8`, `b6c47f9`) contain zero credentials or private keys. |

---

## 5. Unresolved Concerns & Operational Notes

1. **`C:\paypal-gate1\gate1.mjs` Local Verification Dependency:**
   - In `scripts/verify-baseline.js` line 7, the script reads `C:\paypal-gate1\gate1.mjs` to calculate the Gate 1 baseline SHA-256 hash on this development rig.
   - External evaluators who do not have `C:\paypal-gate1\gate1.mjs` on their machines will see a filesystem error if running `verify-baseline.js`.
   - *Recommendation:* Keep `scripts/verify-baseline.js` intact for developer attestation, and document in `README.md` that general judges evaluate via `npm test` and `npm run dev` (Mode A).
2. **External Submitter Deliverables:**
   - Recording the 2m40s demo video (`JUDGE_DEMO_RUNBOOK.md`).
   - Uploading video to YouTube (Public or Unlisted).
   - Confirming GitHub repository visibility is set to Public.
   - Submitting the Devpost application before November 12, 2026, 12:00 PM PT.

---

## 6. Readiness Sign-Off

- **Application Source Code:** 100% complete, 0 modifications required.
- **Test Suite:** 116 test files, 1,603 tests passing, 0 failures.
- **Production Build:** Next.js 16.4.2 compiled and prerendered (19 routes).
- **Public Manifest Status:** **READY FOR REVIEW PRIOR TO STAGING.**

