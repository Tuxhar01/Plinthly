# Plinthly

> **Every purchase. Proven.**  
> Commercial Assurance and Deterministic Policy Verification for Autonomous AI Procurement.

---

## 1. Overview & The Commercial Assurance Problem

When autonomous AI agents or automated procurement workflows select products on behalf of buyers, they encounter a critical trust gap:
- **Offer Mutation:** Price, shipping fees, merchant identity, delivery conditions, or product availability can silently change between agent recommendation and payment authorization.
- **Unverified AI Claims:** Generic chatbots often fabricate or assume free shipping, overlook delivery constraints, or hallucinate product specifications without verifiable evidence.
- **Accidental Settlement:** Traditional payment bridges risk capturing buyer funds before offer terms are cryptographically locked and verified.

**Plinthly** is an **evidence-gated AI procurement agent** built for the PayPal AI Hackathon. Its defining capability is that **every purchasing decision must be supported by verifiable evidence, deterministic policy results, and buyer approval bound to an exact offer snapshot.**

---

## 2. System Architecture: Probabilistic LLM vs. Deterministic Policy

Plinthly enforces an architectural separation between natural-language understanding and procurement execution:

```
┌─────────────────────────────────┐
│ Buyer Natural-Language Request  │
└────────────────┬────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Gemini AI Intent Decomposer (Probabilistic Interface)    │
│ • Decomposes natural language into structured fields     │
│ • Extracts budget, quantity, and technical specifications│
│ • Flags unresolved ambiguities and confidence limits     │
│ • NEVER makes purchasing decisions or approves funds     │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Channel3 Discovery / Candidate Ingestion                 │
│ • Normalizes external listings into typed candidates     │
│ • Preserves raw observed values and provenance URLs      │
│ • Rejects assumption of free shipping ($0 != missing)    │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Deterministic Policy Engine (Zero Hallucination)         │
│ • Non-floating-point monetary evaluation (integer cents) │
│ • P-BUDGET: Total cost <= Budget                         │
│ • P-CURRENCY: Exact currency matching                    │
│ • P-FRESHNESS: Upstream verified timestamps <= threshold │
│ • P-EVIDENCE: Exact unit-aware specification matching    │
│ • Fails closed to UNKNOWN if evidence is unverified      │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Buyer Approval & Cryptographic Snapshot Binding          │
│ • SHA-256 snapshotHash binds price, shipping, retailer   │
│ • SHA-256 quoteFingerprint binds carrier quote facts     │
│ • Approval freezes exact snapshot hash and terms         │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ PayPal Sandbox Order Creation & Remote Verification      │
│ • Creates PayPal order with referenceId = purchaseId     │
│ • Verifies remote PayPal state via independent query     │
│ • STRICT INVARIANT: TERMINATES AT BUYER_APPROVED         │
│ • ZERO FUND CAPTURE / NO CAPTURE TRANSITIONS             │
└──────────────────────────────────────────────────────────┘
```

### What Gemini Does
- Analyzes buyer natural-language prompts (e.g. *"I need a laptop with at least 16GB RAM for under $1,200"*).
- Extracts structured procurement fields: `budgetCents`, `requestedQuantity`, and key-value technical specifications.
- Identifies missing facts and quantity ambiguities, displaying warnings to the buyer.
- **Gemini does NOT evaluate policy, does NOT decide candidate eligibility, and does NOT approve payments.**

### What Deterministic Policy Code Does
- Evaluates non-floating-point rules in pure TypeScript and PostgreSQL.
- Verifies exact specification equivalence (e.g. distinguishing decimal `16 GB` from binary `16 GiB`).
- Requires authoritative source timestamps; unverified observation times fail closed to `UNKNOWN`.
- Computes SHA-256 snapshot hashes binding candidate offer terms. The snapshot hash serves as an integrity binding check: any mismatch between the approved terms and executed terms detects mutation and invalidates buyer approval.


---

## 3. Product Discovery & Retailer Shipping Integrity

### Channel3 Catalog Integration
Plinthly connects to **Channel3** via the `SourceAdapter` abstraction to query live retailer listings:
- **What Channel3 supplies:** Product titles, merchant names, product URLs, and catalog unit prices.
- **What Channel3 does not supply:** Real-time carrier-backed destination shipping quotes or cryptographic retailer signatures.

### Why Live Candidates Fail Closed
Under Plinthly's procurement policy:
1. **Missing shipping is never assumed to be free shipping.**
2. A destination-dependent shipping quote requires a validated 5-digit US postal code and an authoritative quote provider.
3. Without an authoritative carrier quote or verified upstream capture timestamp, live Channel3 products evaluate to `UNKNOWN` under `P-FRESHNESS` and `P-EVIDENCE`.
4. **They remain strictly ineligible for buyer approval.** Plinthly never makes ineligible real products appear purchasable merely to create a superficial demo.

### Retailer Shipping Quote Adapters & Feasibility
Plinthly defines a typed, read-only `ShippingQuoteAdapter` contract:
- **Best Buy Feasibility Evaluation:** Best Buy's public catalog API does not provide real-time carrier shipping rates for arbitrary ZIP codes. Real-time rates require the sales-gated **Best Buy Commerce API (CAPI)**.
- When enterprise partner credentials are absent, Plinthly's `BestBuyShippingQuoteAdapter` reports an explicit `unavailable` blocker documenting the partner boundary. It strictly avoids scraping or undocumented bypasses.

---

## 4. Approval, Payment & Verification Invariants

1. **Exact Snapshot Binding:** Candidate offers are bound by a SHA-256 `snapshotHash` covering `unitPriceCents`, `shippingCents`, `totalCents`, `currency`, `quantity`, `merchantName`, `merchantUrl`, `availability`, and `source`.
2. **Quote Fingerprint Binding:** Shipping quotes are bound by a SHA-256 `quoteFingerprint` covering amount, currency, external ID, canonical product URL, merchant domain, postal code, delivery method, conditions, issue time, and expiry.
3. **Pre-Order Quote Expiration Check:** Expired shipping quotes are rejected immediately before PayPal Sandbox order creation (`quote_expired`), even if approved earlier.
4. **Adversarial Fail-Closed Guarantees:** Tampering with price, shipping, destination, URLs, or evidence after approval immediately rejects order creation with `approval_invalidated`.
5. **Idempotent Order Creation:** Duplicate order-creation calls safely return the existing open order without creating redundant remote PayPal orders.
6. **Independent Server-Side PayPal Verification:** Plinthly independently queries PayPal Sandbox to assert that the remote order reference ID, amount, and currency match internal records.
7. **Terminal Uncaptured Guarantee:** Plinthly deliberately stops at `BUYER_APPROVED (UNCAPTURED)`. **The application does not capture funds** or introduce capture transitions.

---

## 5. Judge & Evaluator Walkthrough (Local Demo)

The local demonstration runs entirely on loopback (`http://127.0.0.1:3001`).

### Step 1: Start the Local Stack
```bash
# 1. Start local PostgreSQL
docker compose up -d db

# 2. Install dependencies, generate Prisma client & apply database migrations
npm install
npx prisma generate
npx prisma migrate deploy

# 3. Start local Next.js server on loopback port 3001
npx next dev . -H 127.0.0.1 -p 3001
```
Open **[http://127.0.0.1:3001](http://127.0.0.1:3001)** in your browser.

### Step 2: Test Natural-Language Procurement
1. In Card 1 (**Purchase Request & Intent Decomposition**), enter:
   ```text
   Buy a Dell XPS 15 laptop with 16GB RAM for under $1,200
   ```
2. Click **"Decompose with Gemini AI"**.
3. Observe Gemini's structured extraction:
   - Budget: `$1,200.00 USD`
   - Quantity: `1`
   - Requirements: `ram: 16GB`
   - Extracted limitations and ambiguities clearly shown.
4. Click **"Confirm Requirements & Create Purchase"**.

### Step 3: Test Real Channel3 Discovery (Fails Closed)
1. In Card 2 (**Candidate Selection & Policy Evaluation**), under *Channel3 External Product Discovery*, click **"Search Live Catalog"**.
2. If Channel3 is configured, real listings appear with badges:
   - `Source: Channel3 Live Offer`
   - `Shipping: MISSING from upstream`
   - `Timestamp: Local observation only`
3. Click **"Select Real Candidate"** and **"Evaluate Candidate Policy"**.
4. Observe the deterministic policy outcome:
   - Rule `P-FRESHNESS` reports `UNKNOWN` with the reason: *"Upstream verification timestamp unconfirmed."*
   - Status chip displays `POLICY BLOCKED` or `POLICY UNKNOWN`.
   - Buyer approval remains **locked and disabled**, demonstrating that Plinthly protects buyers from unverified claims.

### Step 4: Test Synthetic Demonstration Fixture (Full Sandbox Flow)
1. Click **"Load Verified Synthetic Fixture (for Demo)"**.
2. Notice the candidate provenance indicator switches to `Verified Synthetic Fixture`.
   > **Note on Demonstration Fixtures:** This synthetic demonstration fixture contains a predefined shipping amount so we can exercise the positive policy path. It is not a live carrier quote or retailer-issued verification.
3. Click **"Evaluate Candidate Policy"**.
4. Observe: All rules pass &rarr; Status transitions to `POLICY_PASSED`.
5. Proceed to Card 3 (**Buyer Approval & Terms Lock**):
   - Review frozen SHA-256 snapshot integrity hash and evidence fingerprint.
   - Click **"Approve Purchase Terms"** &rarr; transitions to `APPROVED`.
6. Proceed to Card 4 (**PayPal Sandbox & Settlement Verification**):
   - Click **"Create Sandbox Order"** &rarr; creates PayPal Sandbox order referencing the purchase ID (`intent=AUTHORIZE`).
   - Click **"Approve in PayPal Sandbox ↗"** to log into PayPal Sandbox and authorize the order.
   - Return to Plinthly and click **"Verify PayPal Order"**.
   - Observe: Independent server-side query confirms buyer approval, displaying `BUYER_APPROVED (UNCAPTURED)`.
   - Notice: Funds are uncaptured, preserving commercial assurance.

### Step 5: Inspect Existing Verified Records
Plinthly contains two pre-verified sandbox purchases in PostgreSQL:
- **Sample 1:** `pur_1792633876502_s7jvwi22` (PayPal Order: `2JW38959VY1221001`, verified uncaptured)
- **Sample 2:** `pur_1792654701712_f2iks5to` (PayPal Order: `6TN25543HL618580V`, verified uncaptured)

Click either sample button on the dashboard to inspect complete immutable audit histories.
> **Note on Historical Records:** These records demonstrate the completed local audit history and terminal uncaptured state (`BUYER_APPROVED`). Note that remote Sandbox order tokens expire over time at PayPal, so these records serve as a local audit-trail walkthrough rather than an active remote PayPal query.

---

## 6. Developer Experience & APIMatic Context Plugins

Plinthly integrates with the **APIMatic Context Plugins** developer tooling:
1. **Plinthly Assurance Context Plugin:** Packaged locally in `.context-plugins/plinthly` from our OpenAPI 3.1 specification (`docs/openapi.yaml`) and installed into developer environments using the official `context-plugins` CLI (`npx context-plugins install ./.context-plugins/plinthly --targets vscode -y`). Provides structured procurement assurance skills and API contracts for AI assistants.
2. **Context Plugin Marketplace Ecosystem:** Allows AI coding assistants (such as Cursor, VS Code, and Claude Code) to load API schemas and skills on demand.
3. **Architecture Boundary:** These plugins are developer-environment context packages for AI assistants. They are distinct from hosted SaaS microservices or commercial gateway infrastructure.

---

## 7. Security & Safety Model

- **Restricted Local-Demo Authentication:** `AUTH_MODE=local_demo` is strictly limited to local loopback development. In production (`NODE_ENV=production`), untrusted actor headers are rejected and fail closed.
- **Hosted Production Readiness Disclaimer:** Plinthly is configured for local demonstration. Hosted production deployment requires an enterprise identity provider (OIDC/SAML) and a managed PostgreSQL instance with mutual TLS.
- **Strict HTTPS Origin Verification:** Quote provider URLs and canonical product URLs are strictly validated to prevent protocol downgrade (`http://`, `file://`) or origin substitution.
- **Stateless Return Bridge:** PayPal callbacks do not trust client query parameters. Authoritative status is verified exclusively server-to-server.
- **No Secret Exposure:** Error messages and API responses sanitize internal stack traces and database credentials.

---

## 8. Verification & Test Suite

Run the verified test suite (66 test files covering deterministic policy, cryptographic snapshot binding, state machine transitions, and PayPal Sandbox integration):

```bash
# 1. Run all unit and integration tests (with PostgreSQL active)
npm test

# 2. Run adversarial invariant suite specifically (pure in-memory, zero external dependencies)
npx vitest run tests/workflow/adversarial-invariants.test.ts

# 3. TypeScript strict typecheck (0 errors)
npx tsc --noEmit

# 4. ESLint code validation (0 errors, 0 warnings)
npm run lint
```

---

## 9. AI-Use Disclosure & Hackathon Compliance

- **Development Assistance:** Plinthly was developed using agentic pair programming with the **Google DeepMind Antigravity IDE** (powered by Gemini models) for code scaffolding, type modeling, and comprehensive adversarial test suites.
- **Runtime Model Role:** At runtime, **Google Gemini** powers natural-language requirement extraction in `lib/ai/decomposer.ts`. **Gemini never makes purchasing decisions, policy evaluations, or financial approvals.**
- **Deterministic Code Boundary:** All purchasing decisions, eligibility gates, snapshot hashes, state transitions, and payment verifications are deterministic TypeScript and PostgreSQL code.

---

## 10. License

This project is licensed under the terms of the [MIT License](LICENSE).  
Copyright (c) 2026 Tushar Kumar. All rights reserved.
