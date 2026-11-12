import * as fs from "fs";
import * as dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { decomposePurchaseIntent, SYSTEM_INSTRUCTION, GEMINI_SCHEMA } from "../lib/ai/intent-parser";
import { decomposedIntentSchema } from "../lib/ai/types";

// Load environment variables
if (fs.existsSync(".env.local")) {
  const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
}

const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const apiKey = process.env.GEMINI_API_KEY || "";

if (!apiKey) {
  console.error("ERROR: GEMINI_API_KEY is not set.");
  process.exit(1);
}

const PROMPTS = [
  {
    id: "PROMPT_1",
    label: "MacBook Pro M4 Single/Multi Target",
    text: "I need 2 MacBook Pro M4 laptops with 16GB RAM and 512GB SSD, delivered to ZIP 98101 by November 15. My total budget is $4,000.",
  },
  {
    id: "PROMPT_2",
    label: "Multi-Item Procurement ($5,000 aggregate budget)",
    text: "I need 2 Dell XPS 15 laptops, 2 27-inch 4K monitors, and 2 USB-C docking stations. Deliver everything to ZIP 98101 by November 20. Total budget is $5,000.",
  },
  {
    id: "PROMPT_3",
    label: "Ambiguous Procurement Request (Unspecified Quantities)",
    text: "I need a good laptop for software development and a monitor for my setup. Deliver them as soon as possible.",
  },
];

interface AttemptRecord {
  attemptNumber: number;
  httpStatus: number | string;
  outcome: "succeeded" | "timed_out" | "connection_error" | "failed_validation" | "error";
  latencyMs: number;
  retryReason: string | null;
  errorMessage?: string;
}

interface EvidenceReport {
  promptId: string;
  promptLabel: string;
  exactInput: string;
  modelIdentifier: string;
  attempts: AttemptRecord[];
  rawProviderResponse: string;
  rawParsedJson: any;
  finalValidatedExtraction: any;
  schemaValidationPassed: boolean;
  differencesBetweenRawAndNormalized: string[];
}

async function evaluatePrompt(p: typeof PROMPTS[0]): Promise<EvidenceReport> {
  console.log(`\n================================================================================`);
  console.log(`[EVALUATING] ${p.id}: ${p.label}`);
  console.log(`Input: "${p.text}"`);
  console.log(`Model: ${modelName}`);
  console.log(`================================================================================`);

  const ai = new GoogleGenAI({ apiKey });
  const attempts: AttemptRecord[] = [];
  let rawProviderResponse = "";
  let rawParsedJson: any = null;

  const maxAttempts = 2;
  for (let a = 1; a <= maxAttempts; a++) {
    const t0 = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: p.text,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: GEMINI_SCHEMA,
          temperature: 0.1,
        },
      });
      const latencyMs = Date.now() - t0;
      rawProviderResponse = response.text || "";

      // Validate JSON parse
      try {
        rawParsedJson = JSON.parse(rawProviderResponse);
        attempts.push({
          attemptNumber: a,
          httpStatus: 200,
          outcome: "succeeded",
          latencyMs,
          retryReason: null,
        });
        console.log(`  Attempt ${a}: HTTP 200 OK (${latencyMs}ms) - SUCCESS`);
        break;
      } catch (jsonErr: any) {
        attempts.push({
          attemptNumber: a,
          httpStatus: 200,
          outcome: "failed_validation",
          latencyMs,
          retryReason: "Response body was not valid JSON",
          errorMessage: jsonErr.message,
        });
        console.log(`  Attempt ${a}: HTTP 200 but failed JSON validation (${latencyMs}ms)`);
      }
    } catch (err: any) {
      const latencyMs = Date.now() - t0;
      const isTimeout =
        err.name === "AbortError" ||
        err.message?.includes("timed out") ||
        err.message?.includes("ETIMEDOUT") ||
        latencyMs >= 10000;
      const isConnection =
        err.message?.includes("fetch failed") ||
        err.message?.includes("ECONNRESET") ||
        err.message?.includes("connection");

      const outcome = isTimeout ? "timed_out" : isConnection ? "connection_error" : "error";
      const httpStatus = err.status || (isTimeout ? "504 Gateway Timeout" : "Network Error");
      const retryReason = a < maxAttempts ? `Transient failure: ${err.message}` : null;

      attempts.push({
        attemptNumber: a,
        httpStatus,
        outcome,
        latencyMs,
        retryReason,
        errorMessage: err.message,
      });
      console.log(`  Attempt ${a}: ${httpStatus} (${latencyMs}ms) - ${outcome}`);
    }
  }

  // Application post-processing and schema validation
  console.log(`\n[POST-PROCESSING] Running application normalization...`);
  const finalValidatedExtraction = await decomposePurchaseIntent(p.text, {
    customGenerator: async () => rawProviderResponse,
  });

  const schemaCheck = decomposedIntentSchema.safeParse(finalValidatedExtraction);
  const schemaValidationPassed = schemaCheck.success;

  // Compute differences between raw and normalized output
  const diffs: string[] = [];

  // Check budget differences
  if (rawParsedJson.budgetCents !== finalValidatedExtraction.budgetCents) {
    diffs.push(
      `Aggregate budget: Raw was ${rawParsedJson.budgetCents} cents ($${rawParsedJson.budgetCents ? (rawParsedJson.budgetCents / 100).toFixed(2) : "null"}); Normalized is ${finalValidatedExtraction.budgetCents} cents ($${finalValidatedExtraction.budgetCents ? (finalValidatedExtraction.budgetCents / 100).toFixed(2) : "null"}).`
    );
  }

  // Check quantity differences
  if (rawParsedJson.quantity !== finalValidatedExtraction.quantity) {
    diffs.push(
      `Top-level quantity: Raw was ${rawParsedJson.quantity ?? "null"}; Normalized is ${finalValidatedExtraction.quantity ?? "null"} (quantitySource: "${finalValidatedExtraction.quantitySource}").`
    );
  }

  // Check line items differences
  if (Array.isArray(rawParsedJson.lineItems) && Array.isArray(finalValidatedExtraction.lineItems)) {
    finalValidatedExtraction.lineItems.forEach((normItem: any, idx: number) => {
      const rawItem = rawParsedJson.lineItems[idx];
      if (rawItem) {
        if (rawItem.quantity !== normItem.quantity) {
          diffs.push(
            `Line item [${idx + 1}] "${normItem.title}" quantity: Raw was ${rawItem.quantity ?? "null"}; Normalized is ${normItem.quantity ?? "null"} (source: "${normItem.quantitySource}").`
          );
        }
        if (rawItem.budgetCents !== normItem.budgetCents) {
          diffs.push(
            `Line item [${idx + 1}] "${normItem.title}" budget: Raw was ${rawItem.budgetCents ?? "null"}; Normalized is ${normItem.budgetCents ?? "null"}.`
          );
        }
      }
    });
  }

  // Check ambiguities differences
  const rawAmbiguitiesCount = Array.isArray(rawParsedJson.unresolvedAmbiguities)
    ? rawParsedJson.unresolvedAmbiguities.length
    : 0;
  const normAmbiguitiesCount = finalValidatedExtraction.unresolvedAmbiguities.length;
  if (rawAmbiguitiesCount !== normAmbiguitiesCount) {
    diffs.push(
      `Unresolved ambiguities: Raw provider returned ${rawAmbiguitiesCount} items; Normalized application added ${normAmbiguitiesCount - rawAmbiguitiesCount} verified clarification checks (total ${normAmbiguitiesCount}).`
    );
  }

  console.log(`Schema Validation: ${schemaValidationPassed ? "PASSED" : "FAILED"}`);
  console.log(`Differences identified (${diffs.length}):`);
  diffs.forEach((d) => console.log(`  - ${d}`));

  return {
    promptId: p.id,
    promptLabel: p.label,
    exactInput: p.text,
    modelIdentifier: modelName,
    attempts,
    rawProviderResponse,
    rawParsedJson,
    finalValidatedExtraction,
    schemaValidationPassed,
    differencesBetweenRawAndNormalized: diffs,
  };
}

async function main() {
  const reports: EvidenceReport[] = [];
  for (const p of PROMPTS) {
    const rep = await evaluatePrompt(p);
    reports.push(rep);
  }

  fs.writeFileSync(
    "scripts/final-gemini-provider-evidence.json",
    JSON.stringify(reports, null, 2),
    "utf-8"
  );
  console.log("\n[COMPLETE] Saved evidence to scripts/final-gemini-provider-evidence.json");
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});

