# Plinthly — Official 3-Minute Video Demo Script
## Truthful, Evidence-Aware Demonstration of Deterministic AI Procurement

- **Target Duration:** 2 minutes 45 seconds (165 seconds) — strictly capped below 3 minutes.
- **Environment:** Local loopback demonstration (`http://localhost:3001`).
- **Prerequisites:** Docker PostgreSQL running, Next.js dev server running on port 3001, valid `GEMINI_API_KEY` and `CHANNEL3_API_KEY` in `.env.local`.

---

### Sequence Breakdown

```
0:00 - 0:25 (25s) | Segment 1: The Commercial Assurance Problem
0:25 - 0:55 (30s) | Segment 2: Live Gemini Intent Decomposition
0:55 - 1:25 (30s) | Segment 3: Live Channel3 Catalog Discovery & Policy Fail-Closed
1:25 - 1:55 (30s) | Segment 4: AG Grid Studio & Cryptographic Terms Lock
1:55 - 2:25 (30s) | Segment 5: Local Audit History & Uncaptured Authorization Safeguard
2:25 - 2:45 (20s) | Segment 6: APIMatic Tooling & Hackathon Summary
```

---

### Segment 1: The Commercial Assurance Problem (0:00 - 0:25)

**Spoken Narration:**
> "Autonomous AI agents are beginning to make purchasing decisions on behalf of businesses and consumers. But today’s LLMs operate on ungrounded optimism: they hallucinate free shipping, overlook merchant reputation, and risk settling transactions before terms are verified.
>
> Plinthly is an evidence-gated procurement agent that introduces deterministic purchase assurance: every purchase must be backed by verifiable evidence, deterministic policy, and human authorization locked to an exact snapshot."

**Visual Action & Screen Focus:**
- Show Plinthly dashboard at `http://localhost:3001`.
- Clean header: **Plinthly — Every purchase. Proven.**
- Point to Card 1: **1. Submit Purchase Request**.

---

### Segment 2: Live Gemini Intent Decomposition (0:25 - 0:55)

**Spoken Narration:**
> "We start by entering a natural-language procurement prompt:
> *'Buy a Dell XPS 15 laptop with 16GB RAM for under $1,200.'*
>
> When we click 'Decompose with Gemini AI', Google Gemini analyzes the unstructured text.
>
> Notice the architecture: Gemini handles natural-language extraction only. It extracts a budget of $1,200 USD, a quantity of 1, and technical requirements. Crucially, it highlights ambiguities and confidence limits. Gemini does NOT evaluate policy, select winning merchants, or authorize payments.
>
> We click 'Confirm Requirements' to establish our purchase."

**Visual Action & Screen Focus:**
- Type into textarea: `Buy a Dell XPS 15 laptop with 16GB RAM for under $1,200`.
- Click **"Decompose with Gemini"** (live call to `gemini-3.5-flash-lite`).
- Observe extracted fields populated:
  - Total Budget: `$ 1200.00`
  - Requested Quantity: `1`
  - Purchase Requirements: `ram: 16 GB`
- Click **"Submit Purchase Request"** / Confirm button.
- *Fallback Note:* If Gemini API experiences transient latency or rate limit, click **"Regenerate / Use Draft"** with the pre-populated values.

---

### Segment 3: Live Channel3 Catalog Discovery & Policy Fail-Closed (0:55 - 1:25)

**Spoken Narration:**
> "In Section 2, we search real retailer catalogs via the Channel3 API.
>
> Channel3 queries real live merchant listings from Best Buy, Target, and Sam's Club, returning live product titles and catalog prices.
>
> But look closely at the shipping status: shipping is MISSING from upstream.
>
> In Plinthly, missing shipping is NEVER assumed to be free shipping. When we evaluate this live candidate against our deterministic policy engine, rule P-FRESHNESS evaluates to UNKNOWN. The candidate evaluates to POLICY BLOCKED, and the approval button remains strictly disabled. Plinthly protects buyers from ungrounded claims."

**Visual Action & Screen Focus:**
- Click **"Search Live Catalog"** under Channel3 External Product Discovery.
- Show live listings loaded into the AG Grid Candidate Studio:
  - Real listings from Best Buy / Target / Staples.
  - Shipping column displays: `MISSING from upstream`.
- Select any live candidate and click **"Evaluate Candidate Policy"**.
- Point to policy output:
  - `P-FRESHNESS: UNKNOWN` (Reason: *Upstream verification timestamp unconfirmed*).
  - Overall status: `POLICY BLOCKED`.
  - Buyer approval button remains disabled.

---

### Segment 4: AG Grid Studio & Cryptographic Terms Lock (1:25 - 1:55)

**Spoken Narration:**
> "To test downstream checkout safely, we switch to our demonstration fixture.
>
> In our AG Grid Multi-Candidate Studio, we inspect candidate items, shipping costs, and landed totals. This synthetic demonstration fixture contains a predefined shipping amount so we can exercise the positive policy path.
>
> All integer-cents policy rules evaluate and pass: status transitions to POLICY_PASSED.
>
> In Section 3, the buyer reviews the final offer. Plinthly computes a SHA-256 snapshot hash binding the unit price, shipping, retailer domain, and product URL. This snapshot hash serves as an integrity check: any tampering with terms immediately invalidates approval. We click 'Approve Purchase Terms'."

**Visual Action & Screen Focus:**
- Click **"Load Verified Synthetic Fixture (for Demo)"**.
- AG Grid highlights row:
  - Title: `[DEMO FIXTURE] Dell XPS 15 9530 Laptop`
  - Unit Price: `$120.00 USD` | Shipping: `✓ $10.00 USD` | Landed Cost: `$130.00 USD`.
- Click **"Evaluate Candidate Policy"** &rarr; status updates to `POLICY_PASSED`.
- Scroll to Section 3 (**Buyer Approval & Terms Lock**):
  - Point to Authoritative Candidate Terms.
  - Highlight SHA-256 Snapshot Hash: `1a78a481d0...`.
- Click **"Approve Purchase Terms"** &rarr; badge updates to `APPROVED`.

---

### Segment 5: Local Audit History & Uncaptured Authorization Safeguard (1:55 - 2:25)

**Spoken Narration:**
> "In Section 4 and 5, we inspect a completed purchase record to walk through the payment safeguards and local audit trail.
>
> In Plinthly's workflow, PayPal Sandbox orders are created with payment intent set strictly to AUTHORIZE, and the application does not capture funds.
>
> In earlier testing when the orders were active, our backend performed an independent server-side status query directly against PayPal Sandbox, verifying that the remote order reference and amount matched our approved snapshot before recording BUYER_APPROVED (UNCAPTURED).
>
> In Section 5, we see the complete chronological audit trail. While historical Sandbox orders expire remotely over time at PayPal, our local database preserves the complete, tamper-evident record of the authorization."

**Visual Action & Screen Focus:**
- Click **"Sample 1: pur_1792633876502_s7jvwi22"** in the dashboard header.
- Scroll to Section 4 (**PayPal Sandbox Order & Independent Verification**).
- Point to **Non-Capture Architecture** banner:
  - *"Funds capture, payments, and real-money transactions are strictly prohibited."*
- Point to Step 4a: PayPal Order ID `2JW38959VY1221001` (Attempt Status: `OPEN`).
- Point to Step 4b: `BUYER_APPROVED (UNCAPTURED)`.
- Scroll to Section 5 (**Audit History & Event Timeline**):
  - Show chronological timeline of all 9 immutable events: `requirements_confirmed` &rarr; `proposed` &rarr; `evaluated` &rarr; `policy_passed` &rarr; `approved` &rarr; `order_created` &rarr; `buyer_approved`.

---

### Segment 6: APIMatic Tooling & Hackathon Summary (2:25 - 2:45)

**Spoken Narration:**
> "For developer experience, we created an OpenAPI 3.1 specification for Plinthly and packaged a local context plugin verified using the APIMatic context-plugins CLI, enabling AI assistants to understand our assurance contracts.
>
> With 737 automated tests passing, zero funds captured, and strict separation between probabilistic LLM intent and deterministic policy verification, Plinthly establishes the foundation for trusted autonomous commerce.
>
> Every purchase. Proven."

**Visual Action & Screen Focus:**
- Briefly display terminal showing test suite:
  - `Test Files: 52 passed (52) | Tests: 737 passed (737)`.
- Return to dashboard header showing clean terminal assurance state.
- Fade to logo / title screen: **Plinthly — Every purchase. Proven.**

---

### Fallback & Troubleshooting Instructions

| Step / Scenario | Expected Demonstration Flow | Truthful Evidence & Fallback Guidance |
| :--- | :--- | :--- |
| **Gemini Intent Decomposition** | Live decomposition via `gemini-3.5-flash-lite` in ~1.4s. | If API key is absent or Gemini has network timeout, use pre-filled form fields: `$150.00`, 1 unit, `merchant_spec: Dell XPS 15`. |
| **Channel3 Discovery** | Live API returns ~25 real retail products from Best Buy, Target, etc. | If Channel3 API key is absent, candidate list displays synthetic demonstration fixture automatically. |
| **Live Policy Evaluation** | `P-FRESHNESS` reports `UNKNOWN`; candidate displays `POLICY BLOCKED`. | Expected behavior! Live candidates MUST fail closed because upstream catalog lacks verified destination shipping. |
| **Synthetic Demonstration Fixture** | Selected from AG Grid with predefined `$10.00` shipping. | Explicitly labeled in UI and narration: synthetic demonstration fixture containing a predefined shipping amount to exercise the positive policy path. Not a live carrier quote. |
| **PayPal Sandbox Walkthrough** | Click **"Sample 1: pur_1792633876502_s7jvwi22"** in dashboard header. | Demonstrates the recorded local audit history (`BUYER_APPROVED (UNCAPTURED)`). Note: older remote Sandbox order tokens expire at PayPal (HTTP 404), so this is presented as a local audit record walkthrough rather than an active remote query. |
