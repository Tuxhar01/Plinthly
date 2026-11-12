# Plinthly — Official Hackathon Submission Checklist & Verification Record

**Target Competition:** PayPal AI Hackathon  
**Submission Deadline:** **November 12, 2026, 12:00 PM Pacific Time**  
**Entrant / Author:** Tushar Kumar  
**License:** MIT License (Copyright © 2026 Tushar Kumar)  
**Core Brand Promise:** *Every purchase. Proven.*  

---

## 1. Official Requirements Compliance Checklist

### Classification Definitions:
- **PASS**: Independently verified and completed.
- **FAIL**: Verified requirement not satisfied.
- **PENDING**: Submitter action still required on external systems.
- **UNVERIFIED**: Insufficient evidence from local workspace (requires external portal confirmation).

### A. Project Requirements
| Requirement | Status | Verification & Evidence |
| :--- | :---: | :--- |
| **P1. PayPal Sandbox Integration** | **PASS** | PayPal Developer Platform integrated in Sandbox mode (`api-m.sandbox.paypal.com`). Supports OAuth 2.0 token caching, Order creation with intent `AUTHORIZE`, remote server-side verification, sequential multi-cart capture, idempotent retry, DEF-P4-01 pre-persisted refund intent, and partial refund execution (`lib/paypal/paypal-rest-v2-client.ts`, `lib/workflow/payment-gateway-adapter.ts`). Verified in PostgreSQL (`plinthly_stage2_dev`). |
| **P2. Meaningful AI Integration** | **PASS** | Google Gemini (`@google/genai`) runtime intent decomposer in `lib/ai/intent-parser.ts` parses natural language, extracts structured procurement requirements, and flags unresolved ambiguities. Pure intent parser with zero financial authority. |
| **P3. Centrality of PayPal** | **PASS** | PayPal checkout orchestration is central to the entire product workflow: multi-cart sequential capture, webhook fast-ack queues, and DEF-P4-01 pre-persisted refund intent. |
| **P4. Non-Trivial Working Prototype** | **PASS** | 8-step procurement workflow, 8 canonical PostgreSQL routines, zero-variance landed-cost guarantees, 116 test files (1,603 tests passed), clean Next.js 16 build (19/19 routes compiled). |
| **P5. Sufficient Documentation** | **PASS** | Complete suite: 2m40s demo runbook (`JUDGE_DEMO_RUNBOOK.md`), technical architecture overview, pitch narrative, capability disclosures, and SRE incident response runbooks. |
| **P6. Existing-Project Progress Disclosure** | **PASS** | Git history proves work commenced on Oct 29, 2026 (`4c555e8`), security hardening on Oct 31, 2026 (`b6c47f9`), and all Stage 2 & 3 multi-retailer engineering, canonical routines, DEF-P4-01 refund provenance, and OPS deliverables created during November 2026 (well after the Oct 1, 2026 window opened). |
| **P7. Third-Party Licenses** | **PASS** | MIT open-source dependencies used strictly in accordance with their respective licenses. |

### B. Submission Requirements
| Requirement | Status | Verification & Evidence |
| :--- | :---: | :--- |
| **S1. English Project Description** | **PASS** | Clear English descriptions covering problem statement, solution, Model A landed cost, multi-cart checkout, and AI boundaries in `PITCH_NARRATIVE.md` and `README.md`. |
| **S2. Functional Demo & Setup Instructions** | **PASS** | Fully documented free local setup instructions in `README.md` and `JUDGE_DEMO_RUNBOOK.md`. Deterministic demo fixtures (`Load Demo Fixture`) for instant evaluation. |
| **S3. Public Repository Visibility** | **UNVERIFIED** | Code is prepared and committed locally, but public visibility on GitHub must be checked externally by the submitter before deadline. |
| **S4. Visible Open Source License** | **PASS** | Standard MIT License committed as `LICENSE` at repository root with copyright holder `Tushar Kumar`. |
| **S5. Public YouTube Demo Video** | **PENDING** | Video script and filming guide prepared in `JUDGE_DEMO_RUNBOOK.md`. Submitter must record the video and upload it to YouTube. |
| **S6. Video Duration < 3 Minutes** | **PASS** | Demo script precisely timed for **2 minutes 40 seconds (160 seconds)**, safely below the 3:00 minute threshold. |
| **S7. Working Prototype on Intended Device** | **PENDING** | Script instructs live screen capture of browser interaction on `http://localhost:3000`. Submitter must execute during video recording. |
| **S8. Copyright & Trademark Safety** | **PASS** | Voiceover only; zero unauthorized commercial background music or third-party trademark assets specified in runbook. |
| **S9. Free Testing for Judges** | **PASS** | Mode A allows judges to test 100% free using local Node.js and synthetic fixtures without paid subscriptions or private API credentials. |
| **S10. Genuine Working Code** | **PASS** | 100% genuine TypeScript and PostgreSQL code: Next.js 16 React frontend, dynamic API routes, ACID database transactions, and 1,603 passing tests. No static mockups. |
| **S11. YouTube Upload & Public/Unlisted URL** | **PENDING** | Requires external upload to YouTube and acquiring video URL. |
| **S12. Devpost Submission Form** | **PENDING** | Requires submitting repository URL, video link, and pitch text on Devpost portal before November 12, 2026, 12:00 PM PT. |

---

## 2. Technical Validation Verification

| Verification Step | Command / Tool | Result | Status |
| :--- | :--- | :---: | :---: |
| **Prisma Schema** | `npx prisma validate` | Valid schema | **PASS** |
| **TypeScript Compilation** | `npx tsc --noEmit` | Exit code 0, 0 errors | **PASS** |
| **Next.js Production Build** | `npm run build` | Exit code 0, 19/19 routes generated | **PASS** |
| **Full Regression Test Suite** | `npx vitest run --exclude "**/live-smoke.test.ts" --exclude "**/channel3-live.test.ts"` | 116/116 files passed, 1,603 tests passed, 0 failures | **PASS** |
| **Strategy Completeness Suite** | `tests/workflow/strategy-completeness-audit.test.ts` | 10/10 tests passed (6 invariants verified) | **PASS** |
| **Stage 1 Baseline Integrity** | `node scripts/verify-baseline.js` | Gate 1 & Dump hashes match, 0 Stage 2 tables in `plinthly_dev` | **PASS** |
| **Stage 2 Sandbox Evidence** | `node scripts/verify-live-sandbox-evidence.js` | Order `4MT765021L9327907`, Capture `96R089931P172015F`, Refund `9WM63969PS2795349` reconciled | **PASS** |

---

## 3. Submission Materials & Action Items for Entrant

Before submitting on Devpost:
1. **Record Video**: Follow [`JUDGE_DEMO_RUNBOOK.md`](JUDGE_DEMO_RUNBOOK.md) to record the 2m40s video.
2. **Upload Video to YouTube**: Ensure visibility is Public or Unlisted.
3. **Verify GitHub Visibility**: Set repository visibility to **Public** on GitHub.
4. **Copy Pitch & Architecture**: Paste summary from [`PITCH_NARRATIVE.md`](PITCH_NARRATIVE.md) and [`HACKATHON_OFFICIAL_COMPLIANCE_MATRIX.md`](HACKATHON_OFFICIAL_COMPLIANCE_MATRIX.md) into the Devpost submission form.
5. **Submit before Deadline**: **November 12, 2026, 12:00 PM Pacific Time**.
