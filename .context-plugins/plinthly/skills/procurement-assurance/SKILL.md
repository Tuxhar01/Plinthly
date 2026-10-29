---
name: plinthly-procurement-assurance
description: Deterministic procurement policy governance, multi-vendor candidate discovery, and uncaptured PayPal authorization workflows.
---

# Plinthly Autonomous Procurement Assurance Skill

This skill provides autonomous AI coding assistants with deterministic, version-aware API context generated from Plinthly's OpenAPI 3.1 contract.

## API Contracts & Boundaries

1. **Natural-Language Requirement Decomposition (`POST /api/ai/decompose`):**
   - Extracts structured parameters (`budgetCents`, `currency`, `quantity`, `requirements`).
   - Identifies ambiguities without guessing or inventing unstated requirements.

2. **Catalog Discovery (`POST /api/discovery/search`):**
   - Queries multi-vendor retailer catalogs with full merchant provenance.
   - Missing shipping rates are NEVER inferred as $0.00.

3. **Deterministic Policy Evaluation (`POST /api/purchases/{id}/evaluate`):**
   - Executes server-side deterministic policy rules (`P-BUDGET`, `P-CURRENCY`, `P-QUANTITY`, `P-AVAILABILITY`, `P-EVIDENCE`, `P-FRESHNESS`).
   - Requires verified evidence before granting `allRequiredPassed: true`.

4. **Human Buyer Approval (`POST /api/purchases/{id}/approve`):**
   - Strictly reserved for human users (`kind: "user"`). System actors are blocked from self-approving.
   - Cryptographically binds approval to an immutable candidate snapshot hash.

5. **PayPal Payment Authorization (`POST /api/purchases/{id}/orders` & `POST /api/purchases/{id}/paypal/verify`):**
   - Enforces `intent=AUTHORIZE`.
   - Never captures funds autonomously. Gate 1 safeguard permanently protects against unauthorized capture.
