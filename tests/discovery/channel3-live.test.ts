import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { Channel3SourceAdapter } from "../../lib/discovery/channel3-adapter";
import { searchChannel3 } from "../../lib/channel3/client";
import { channel3SearchResponseSchema } from "../../lib/channel3/types";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";
import { evaluatePolicy } from "../../lib/policy/evaluator";

// Load .env.local safely if present in local dev/test environment
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const rawKey = process.env.CHANNEL3_API_KEY?.trim() ?? "";
const hasChannel3Key = rawKey.length > 0;

/**
 * Live Channel3 API Integration Smoke Test.
 *
 * This test makes real HTTPS calls to https://api.trychannel3.com/v1/search.
 * It is credential-gated and executes ONLY when CHANNEL3_API_KEY is configured.
 * In ordinary CI/offline test runs without credentials, it is explicitly skipped.
 *
 * Never prints or logs secrets or authorization headers.
 */
describe.skipIf(!hasChannel3Key)("Channel3 Live API Integration Smoke Test (Live Provider)", () => {
  const now = new Date();

  it("executes real search query against Channel3 API and validates response schema", async () => {
    const startTime = Date.now();
    const response = await searchChannel3({
      query: "laptop",
      limit: 5,
    });
    const latencyMs = Date.now() - startTime;

    // 1. Validate response against strict runtime Zod schema
    const parsed = channel3SearchResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);

    expect(Array.isArray(response.products)).toBe(true);
    console.log(
      `[Channel3 Live] Successfully retrieved ${response.products.length} products in ${latencyMs}ms.`
    );

    if (response.products.length > 0) {
      const firstProduct = response.products[0];
      expect(typeof firstProduct.id).toBe("string");
      expect(firstProduct.id.length).toBeGreaterThan(0);
      expect(typeof firstProduct.title).toBe("string");
      expect(firstProduct.title.length).toBeGreaterThan(0);

      if (firstProduct.offers && firstProduct.offers.length > 0) {
        const firstOffer = firstProduct.offers[0];
        expect(typeof firstOffer.url).toBe("string");
        expect(typeof firstOffer.domain).toBe("string");
        expect(firstOffer.price).toBeDefined();
        expect(typeof firstOffer.price.price).toBe("number");
        expect(typeof firstOffer.price.currency).toBe("string");
      }
    }
  }, 15000);

  it("normalizes real Channel3 products through Channel3SourceAdapter without data loss", async () => {
    const adapter = new Channel3SourceAdapter();
    const result = await adapter.search(
      {
        query: "mechanical keyboard",
        purchaseId: "pur_live_test_001",
      },
      { now }
    );

    expect(result.status === "success" || result.status === "empty").toBe(true);

    if (result.status === "success") {
      expect(result.candidates.length).toBeGreaterThan(0);
      const firstCand = result.candidates[0];

      expect(firstCand.source).toBe("channel3");
      expect(firstCand.title.length).toBeGreaterThan(0);
      expect(firstCand.merchantName.length).toBeGreaterThan(0);
      expect(firstCand.merchantUrl.startsWith("http")).toBe(true);

      // Verify that shipping is not fabricated when absent upstream
      if (firstCand.shippingCents === 0 && !firstCand.isComplete) {
        expect(firstCand.validationErrors.some((e) => e.includes("shipping"))).toBe(true);
      }

      // Verify source provenance preservation
      expect(firstCand.rawSourceData.provider).toBe("channel3");
      expect(firstCand.rawSourceData.attribution).toContain("Channel3");
    }
  }, 15000);

  it("3. executes live discovery-to-policy evaluation diagnostic on real laptop candidates", async () => {
    // Phase 11D requirement:
    // One bounded live search for a laptop under $1,200 with RAM requirement
    const budgetCents = 120000; // $1,200.00
    const currency = "USD";
    const requiredSpecs = [{ key: "ram", expectedValue: "16GB" }];

    const adapter = new Channel3SourceAdapter();
    const result = await adapter.search(
      {
        query: "laptop 16GB",
        purchaseId: "pur_live_diag_11d",
        constraints: {
          maxBudgetCents: budgetCents,
          currency: "USD",
          minQuantity: 1,
        },
      },
      { now }
    );

    expect(result.status === "success" || result.status === "empty").toBe(true);

    if (result.status === "success") {
      console.log(`\n=== Live Discovery-to-Policy Diagnostics (${result.candidates.length} candidates) ===`);

      for (let i = 0; i < Math.min(result.candidates.length, 5); i++) {
        const candidate = result.candidates[i];

        // 1. Evidence ingestion
        const ingestion = ingestCandidateEvidence({
          candidate,
          requiredAttributes: requiredSpecs,
          rawObservations: candidate.rawSourceData.rawAttributes as Record<string, unknown>,
          now,
        });

        // 2. Policy evaluation
        const policyResult = evaluatePolicy({
          config: {
            requiredRuleKeys: [
              "P-BUDGET",
              "P-CURRENCY",
              "P-QUANTITY",
              "P-AVAILABILITY",
              "P-EVIDENCE",
              "P-FRESHNESS",
            ],
          },
          purchase: {
            budgetCents,
            currency,
            requestedQuantity: 1,
            requiredAttributes: requiredSpecs,
          },
          candidate: {
            id: candidate.id,
            merchantName: candidate.merchantName,
            unitPriceCents: candidate.unitPriceCents,
            shippingCents: candidate.shippingCents,
            totalCents: candidate.totalCents,
            currency: candidate.currency,
            quantity: candidate.quantity,
            availability: candidate.availability,
            snapshotHash: candidate.snapshotHash,
          },
          evidence: ingestion.evidenceRecords,
          now,
        });

        console.log(`\nCandidate [${i + 1}]: "${candidate.title.slice(0, 50)}..."`);
        console.log(`  Provenance: Merchant=${candidate.merchantName} | ExternalId=${candidate.externalId}`);
        console.log(`  Merchant URL: ${candidate.merchantUrl}`);
        console.log(`  Price: $${(candidate.unitPriceCents / 100).toFixed(2)} ${candidate.currency}`);
        console.log(`  Availability: "${candidate.availability}"`);
        console.log(
          `  Shipping cost: ${candidate.shippingCents > 0 ? `$${(candidate.shippingCents / 100).toFixed(2)}` : "MISSING from upstream"}`
        );
        console.log(`  Candidate completeness: isComplete=${candidate.isComplete} (${candidate.validationErrors.join(", ") || "complete"})`);
        console.log(`  Technical Requirement (RAM):`);
        const ramEvidence = ingestion.evidenceRecords.find((e) => e.requirementKey === "ram");
        console.log(`    Observed value: "${ramEvidence?.value || "NONE"}" | Status: "${ramEvidence?.status || "missing"}"`);
        console.log(`    Observation timestamp: "${ramEvidence?.capturedAt || "UNVERIFIED (empty)"}"`);
        console.log(`  Policy Evaluation Results:`);
        for (const [rKey, rVal] of Object.entries(policyResult.ruleResults)) {
          console.log(`    ${rKey}: ${rVal.outcome.toUpperCase()}`);
        }
        console.log(`  Approval Eligibility: allRequiredPassed=${policyResult.summary.allRequiredPassed}`);

        // Verified invariants:
        // A. If shipping was missing from upstream, isComplete must be false
        if (candidate.rawSourceData.shipping === undefined) {
          expect(candidate.isComplete).toBe(false);
        }

        // B. If specifications lack trusted proof, P-EVIDENCE must not silently pass
        if (ingestion.missingAttributeKeys.includes("ram") || ramEvidence?.status !== "supports") {
          expect(policyResult.ruleResults["P-EVIDENCE"].outcome).not.toBe("pass");
        }

        // C. If observation timestamp is empty/unverified, P-FRESHNESS must not silently pass
        if (!ramEvidence?.capturedAt) {
          expect(policyResult.ruleResults["P-FRESHNESS"].outcome).not.toBe("pass");
        }

        // D. Candidate must NOT be eligible for buyer approval without complete evidence
        expect(policyResult.summary.allRequiredPassed).toBe(false);
      }
    }
  }, 15000);
});
