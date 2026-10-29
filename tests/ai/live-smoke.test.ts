import { describe, it, expect } from "vitest";
import dotenv from "dotenv";
import path from "path";
import { decomposePurchaseIntent } from "../../lib/ai/intent-parser";
import { decomposedIntentSchema } from "../../lib/ai/types";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const apiKey = process.env.GEMINI_API_KEY;
const hasApiKey = Boolean(apiKey && apiKey.trim().length > 0);
const configuredModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

/**
 * LIVE API SMOKE TESTS
 * These tests require active network access to Google Gemini and a valid GEMINI_API_KEY.
 * Skipped automatically when credentials are not configured.
 */
describe.skipIf(!hasApiKey)("Live Gemini Smoke Tests (Explicit Live Provider Verification)", () => {
  describe("1. Legacy/Retired Model Availability Check", () => {
    it("confirms gemini-2.5-flash fails model-availability check with 404 (retired model)", async () => {
      const prompt = "I need a laptop under $1,200 with 16 GB RAM.";
      const t0 = performance.now();

      let errorCaught: unknown;
      try {
        await decomposePurchaseIntent(prompt, {
          apiKey,
          model: "gemini-2.5-flash",
          timeoutMs: 8000,
        });
      } catch (err: unknown) {
        errorCaught = err;
      }

      const elapsed = Math.round(performance.now() - t0);
      expect(errorCaught).toBeDefined();

      const errMsg = errorCaught instanceof Error ? errorCaught.message : String(errorCaught);
      console.log(`[MODEL AVAILABILITY CHECK: gemini-2.5-flash FAILED AS EXPECTED] Elapsed: ${elapsed}ms | Error: ${errMsg}`);
      expect(
        errMsg.includes("404") ||
        errMsg.includes("NOT_FOUND") ||
        errMsg.includes("no longer available") ||
        errMsg.includes("failed")
      ).toBe(true);
    });
  });

  describe("2. Active Configured Model Live Verification", () => {
    it("Live Prompt A: decomposes 'I need a laptop under $1,200 with 16 GB RAM.' against configured model", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const prompt = "I need a laptop under $1,200 with 16 GB RAM.";
      const t0 = performance.now();

      const result = await decomposePurchaseIntent(prompt, {
        apiKey,
        model: configuredModel,
        timeoutMs: 15000,
      });

      const elapsed = Math.round(performance.now() - t0);

      console.log(`[LIVE TEST A SUCCESS] Model: ${configuredModel} | Latency: ${elapsed}ms`);
      console.log(`[LIVE TEST A] budgetCents: ${result.budgetCents}, currency: ${result.currency}, quantity: ${result.quantity}`);
      console.log(`[LIVE TEST A] productKeywords: "${result.productKeywords}"`);
      console.log(`[LIVE TEST A] requirements:`, JSON.stringify(result.requirements));
      console.log(`[LIVE TEST A] ambiguities:`, JSON.stringify(result.unresolvedAmbiguities));
      console.log(`[LIVE TEST A] confidenceEstimate:`, JSON.stringify(result.confidenceEstimate));

      // 1. Validate against production Zod schema
      const parsed = decomposedIntentSchema.parse(result);
      expect(parsed).toBeDefined();

      // 2. Budget is 120,000 cents ($1,200)
      expect(result.budgetCents).toBe(120000);

      // 3. Currency is USD
      expect(result.currency).toBe("USD");

      // 4. Quantity is 1 or null
      expect(result.quantity === 1 || result.quantity === null).toBe(true);

      // 5. 16 GB RAM is represented as a requirement
      const ramReq = result.requirements.find(
        (r) =>
          r.key.toLowerCase().includes("ram") ||
          r.key.toLowerCase().includes("memory") ||
          (r.expectedValue && r.expectedValue.includes("16")) ||
          (r.description && r.description.toLowerCase().includes("16"))
      );
      expect(ramReq).toBeDefined();

      // 6. Confidence estimate is model heuristic, not calibrated probability
      expect(result.confidenceEstimate.isCalibratedProbability).toBe(false);
    }, 20000);

    it("Live Prompt B: decomposes 'I need a laptop.' without inventing budget or quantity", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const prompt = "I need a laptop.";
      const t0 = performance.now();

      const result = await decomposePurchaseIntent(prompt, {
        apiKey,
        model: configuredModel,
        timeoutMs: 15000,
      });

      const elapsed = Math.round(performance.now() - t0);

      console.log(`[LIVE TEST B SUCCESS] Model: ${configuredModel} | Latency: ${elapsed}ms`);
      console.log(`[LIVE TEST B] budgetCents: ${result.budgetCents}, currency: ${result.currency}, quantity: ${result.quantity}`);
      console.log(`[LIVE TEST B] productKeywords: "${result.productKeywords}"`);
      console.log(`[LIVE TEST B] requirements:`, JSON.stringify(result.requirements));
      console.log(`[LIVE TEST B] ambiguities:`, JSON.stringify(result.unresolvedAmbiguities));
      console.log(`[LIVE TEST B] confidenceEstimate:`, JSON.stringify(result.confidenceEstimate));

      // 1. Validate against production Zod schema
      const parsed = decomposedIntentSchema.parse(result);
      expect(parsed).toBeDefined();

      // 2. Budget remains null (not invented)
      expect(result.budgetCents).toBeNull();

      // 3. Quantity remains null for generic singular reference ("a laptop")
      expect(result.quantity).toBeNull();

      // 4. Currency is null or USD if defaulted
      expect(result.currency === null || result.currency === "USD").toBe(true);

      // 5. Missing information is represented through unresolved ambiguities
      expect(result.unresolvedAmbiguities.length).toBeGreaterThan(0);

      // 6. Confidence estimate is model heuristic, not calibrated probability
      expect(result.confidenceEstimate.isCalibratedProbability).toBe(false);
    }, 20000);
  });
});
