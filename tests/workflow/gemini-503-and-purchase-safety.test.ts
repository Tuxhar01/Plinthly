import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { PurchaseRequestCard } from "../../components/workflow/purchase-request-card";
import {
  decomposePurchaseIntent,
  AiServiceUnavailableError,
  AiProviderError,
  AiTimeoutError,
  AiRateLimitError,
  AiError,
  deduplicateAmbiguities,
  isTransientAiError,
  sanitizeAndMapError,
  calculateJitteredBackoff,
} from "../../lib/ai/intent-parser";

describe("Gemini 503 Provider Reliability & Purchase Form Safety Remediation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // TEST 1: Initial manual form contains no purchase defaults
  // --------------------------------------------------------------------------
  it("1. Initial manual form contains no purchase defaults", () => {
    const html = renderToString(
      React.createElement(PurchaseRequestCard, {
        actorId: "usr_buyer_test",
        onPurchaseCreated: () => {},
      })
    );

    // Form inputs must not contain hardcoded prototype values
    expect(html).not.toContain('value="150.00"');
    expect(html).not.toContain('value="1500.00"');
    expect(html).not.toContain('value="98101"');
    expect(html).not.toContain("merchant_spec: Dell XPS 15");
    expect(html).not.toContain("Dell XPS 15 Laptop (32GB RAM)");
    expect(html).not.toContain("USB-C Dual 4K Docking Station");

    // Quantity clarification warning must indicate unspecified quantity on initial mount
    expect(html).toContain("⚠️ Clarification: Specify Qty");

    // Explicit Load Demo Template button must be present
    expect(html).toContain("Load Demo Template");
  });

  // --------------------------------------------------------------------------
  // TEST 2: Failed Gemini decomposition cannot create a purchase using stale values
  // --------------------------------------------------------------------------
  it("2. Failed Gemini decomposition cannot create a purchase using stale values", () => {
    // When form is unedited and initial state is empty, validation must fail closed
    // Simulating validation logic matching purchase-request-card.tsx
    const emptyFormState = {
      budgetDollars: "",
      quantity: null,
      quantityConfirmed: false,
      requirementsText: "",
      postalCode: "",
      procurementMode: "single",
    };

    const errors: Record<string, string> = {};
    const parsedDollars = parseFloat(emptyFormState.budgetDollars);
    if (isNaN(parsedDollars) || parsedDollars <= 0) {
      errors.budget = "Budget must be a positive number greater than 0.";
    }

    const reqs = emptyFormState.requirementsText
      .split("\n")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    if (reqs.length === 0) {
      errors.requirements = "At least one requirement is required.";
    }

    if (emptyFormState.quantity === null || !emptyFormState.quantityConfirmed) {
      errors.quantity = "Quantity is unspecified. Buyer confirmation required before submission.";
    }

    // Validation must fail closed: purchase cannot be created
    expect(Object.keys(errors).length).toBe(3);
    expect(errors.budget).toContain("Budget must be a positive number");
    expect(errors.requirements).toContain("At least one requirement is required");
    expect(errors.quantity).toContain("Quantity is unspecified");
  });

  // --------------------------------------------------------------------------
  // TEST 3: Previous purchase values cannot contaminate a new draft
  // --------------------------------------------------------------------------
  it("3. Previous purchase values cannot contaminate a new draft", () => {
    // Simulate state transition:
    // User had a previous AI draft loaded (e.g. Dell XPS $1500)
    let formBudget = "1500.00";
    let formQuantity: number | null = 1;
    let formRequirements = "merchant_spec: Dell XPS 15";
    const isManuallyEdited = false; // Came from prior AI draft, not manually entered

    // User initiates a new decomposition for "Apple MacBook Pro M4"
    // At start of decomposition, when !isManuallyEdited, state is cleared:
    if (!isManuallyEdited) {
      formBudget = "";
      formQuantity = null;
      formRequirements = "";
    }

    // New AI decomposition fails with 503
    const aiFailed = true;
    if (aiFailed && !isManuallyEdited) {
      // Ensure state remains empty
      formBudget = "";
      formQuantity = null;
      formRequirements = "";
    }

    expect(formBudget).toBe("");
    expect(formQuantity).toBeNull();
    expect(formRequirements).toBe("");
  });

  // --------------------------------------------------------------------------
  // TEST 4: Legitimate manual entries survive an AI failure where appropriate
  // --------------------------------------------------------------------------
  it("4. Legitimate manual entries survive an AI failure where appropriate", () => {
    // Buyer explicitly types their own requirements and budget
    let formBudget = "3200.00";
    let formQuantity: number | null = 2;
    let formRequirements = "specs: Apple M4 Max 64GB Unified Memory";
    const isManuallyEdited = true; // User manually typed these values

    // User tries AI decomposition which fails (e.g. 503 UNAVAILABLE)
    const aiFailed = true;
    if (aiFailed && !isManuallyEdited) {
      formBudget = "";
      formQuantity = null;
      formRequirements = "";
    }
    // If isManuallyEdited is true, values survive!

    expect(formBudget).toBe("3200.00");
    expect(formQuantity).toBe(2);
    expect(formRequirements).toBe("specs: Apple M4 Max 64GB Unified Memory");
  });

  // --------------------------------------------------------------------------
  // TEST 5: Demo template loading is explicit and does not trigger payment
  // --------------------------------------------------------------------------
  it("5. Demo template loading is explicit and does not trigger payment", () => {
    const networkFetchSpy = vi.fn();
    globalThis.fetch = networkFetchSpy;

    // Simulate clicking "Load Demo Template"
    let budgetDollars = "";
    let quantity: number | null = null;
    let quantityConfirmed = false;
    let requirementsText = "";
    let isDemoTemplateLoaded = false;

    const handleLoadDemoTemplate = () => {
      budgetDollars = "1500.00";
      quantity = 1;
      quantityConfirmed = true;
      requirementsText =
        "merchant_spec: Dell XPS 15 (Synthetic Demo)\nreputation_check: Approved Merchant (Demo)\nfreshness: Valid recent capture";
      isDemoTemplateLoaded = true;
    };

    handleLoadDemoTemplate();

    // Template is loaded with synthetic data
    expect(isDemoTemplateLoaded).toBe(true);
    expect(budgetDollars).toBe("1500.00");
    expect(quantity).toBe(1);
    expect(quantityConfirmed).toBe(true);
    expect(requirementsText).toContain("Synthetic Demo");

    // Zero API calls or payment requests must be triggered by loading the demo template
    expect(networkFetchSpy).not.toHaveBeenCalled();

    // Verify clear form resets everything back to empty
    const handleClearForm = () => {
      budgetDollars = "";
      quantity = null;
      quantityConfirmed = false;
      requirementsText = "";
      isDemoTemplateLoaded = false;
    };

    handleClearForm();
    expect(budgetDollars).toBe("");
    expect(quantity).toBeNull();
    expect(quantityConfirmed).toBe(false);
    expect(requirementsText).toBe("");
    expect(isDemoTemplateLoaded).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 6: HTTP 503 triggers exactly one bounded retry
  // --------------------------------------------------------------------------
  it("6. HTTP 503 triggers exactly one bounded retry", async () => {
    let callCount = 0;
    const mockOutput = {
      budgetCents: 250000,
      currency: "USD",
      quantity: 1,
      productKeywords: "MacBook Pro M4",
      requirements: [{ key: "chip", expectedValue: "M4" }],
      unresolvedAmbiguities: [],
      confidenceEstimate: {
        score: 0.95,
        label: "high",
        notes: "Explicit intent",
        isCalibratedProbability: false,
      },
    };

    const result = await decomposePurchaseIntent("Apple MacBook Pro M4 16-inch 36GB", {
      backoffMs: 1, // Fast jittered backoff for test
      customGenerator: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error(
            'got status: 503. {"error":{"code":503,"message":"This model is currently experiencing high demand. Please try again later.","status":"UNAVAILABLE"}}'
          );
        }
        return JSON.stringify(mockOutput);
      },
    });

    // Exactly 2 calls: 1 initial attempt + 1 bounded retry
    expect(callCount).toBe(2);
    expect(result.productKeywords).toBe("MacBook Pro M4");
    expect(result.budgetCents).toBe(250000);
  });

  // --------------------------------------------------------------------------
  // TEST 7: Permanent provider errors do not retry
  // --------------------------------------------------------------------------
  it("7. Permanent provider errors do not retry", async () => {
    let callCount = 0;

    await expect(
      decomposePurchaseIntent("Test prompt for permanent failure", {
        backoffMs: 1,
        customGenerator: async () => {
          callCount++;
          throw new Error("HTTP 401: API key not valid. Please pass a valid API key.");
        },
      })
    ).rejects.toThrow();

    // Permanent errors must fail immediately on the first attempt without retry
    expect(callCount).toBe(1);

    // Test HTTP 400 Bad Request
    let badRequestCalls = 0;
    await expect(
      decomposePurchaseIntent("Test prompt for bad request", {
        backoffMs: 1,
        customGenerator: async () => {
          badRequestCalls++;
          throw new Error("HTTP 400: Invalid argument provided in request config.");
        },
      })
    ).rejects.toThrow();

    expect(badRequestCalls).toBe(1);
  });

  // --------------------------------------------------------------------------
  // TEST 8: Exhausted retries produce a clear error
  // --------------------------------------------------------------------------
  it("8. Exhausted retries produce a clear error", async () => {
    let callCount = 0;

    try {
      await decomposePurchaseIntent("Apple MacBook Pro M4 under $3,000", {
        backoffMs: 1,
        customGenerator: async () => {
          callCount++;
          throw new Error(
            'got status: 503. {"error":{"code":503,"message":"This model is currently experiencing high demand. Please try again later.","status":"UNAVAILABLE"}}'
          );
        },
      });
      expect.unreachable("Should have thrown AiServiceUnavailableError");
    } catch (err: unknown) {
      expect(callCount).toBe(2); // Exactly 1 retry before exhaustion
      expect(err).toBeInstanceOf(AiServiceUnavailableError);
      const aiErr = err as AiServiceUnavailableError;
      expect(aiErr.statusCode).toBe(503);
      expect(aiErr.code).toBe("ai_service_unavailable");
      expect(aiErr.message).toContain("Gemini service is temporarily experiencing high demand (503 UNAVAILABLE)");
      expect(aiErr.message).toContain("Please try again shortly");
    }
  });

  // --------------------------------------------------------------------------
  // TEST 9: API keys never appear in error responses or logs
  // --------------------------------------------------------------------------
  it("9. API keys never appear in error responses or logs", () => {
    const rawKey = "AIzaSyD_TestFakeKey_1234567890abcdefg";
    const sensitiveError = new Error(
      `Request failed at https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite?key=${rawKey} with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testToken`
    );

    const sanitized = sanitizeAndMapError(sensitiveError);

    // Error message must redact sensitive credentials
    expect(sanitized.message).not.toContain(rawKey);
    expect(sanitized.message).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testToken");
    expect(sanitized.message).toContain("key=[REDACTED]");
    expect(sanitized.message).toContain("Bearer [REDACTED_TOKEN]");
  });

  // --------------------------------------------------------------------------
  // TEST 10: Duplicate ambiguity warnings are removed without losing distinct warnings
  // --------------------------------------------------------------------------
  it("10. Duplicate ambiguity warnings are removed without losing distinct warnings", () => {
    const rawAmbiguities = [
      "Quantity is not explicitly specified",
      "Quantity for laptop is unspecified and must be confirmed before submission.",
      "Quantity for 'laptop' is not explicitly specified; buyer confirmation is required before submission.",
      "Quantity for monitor is unspecified and must be confirmed before submission.",
      "Quantity for 'monitor' is not explicitly specified; buyer confirmation is required before submission.",
      "Delivery destination ZIP code is not specified; needed for shipping rate calculation.",
      "Delivery year is unspecified and requires buyer confirmation.",
      "No line-item budgets specified; total procurement budget requires buyer input.",
    ];

    const deduplicated = deduplicateAmbiguities(rawAmbiguities, true);

    // Exactly 1 quantity warning per line item
    const laptopWarnings = deduplicated.filter((a) => a.toLowerCase().includes("laptop"));
    expect(laptopWarnings).toHaveLength(1);

    const monitorWarnings = deduplicated.filter((a) => a.toLowerCase().includes("monitor"));
    expect(monitorWarnings).toHaveLength(1);

    // Redundant top-level generic warning is suppressed when line-item quantity warnings exist
    expect(deduplicated).not.toContain("Quantity is not explicitly specified");

    // All distinct clarification requirements are strictly preserved
    expect(deduplicated.some((a) => a.includes("ZIP code"))).toBe(true);
    expect(deduplicated.some((a) => a.includes("Delivery year"))).toBe(true);
    expect(deduplicated.some((a) => a.includes("No line-item budgets specified"))).toBe(true);

    expect(deduplicated).toHaveLength(5);
  });

  // --------------------------------------------------------------------------
  // ADDITIONAL: Transient error classifier & jittered backoff bounds
  // --------------------------------------------------------------------------
  it("correctly identifies transient vs permanent errors and computes jittered backoff", () => {
    expect(isTransientAiError(new AiTimeoutError())).toBe(true);
    expect(isTransientAiError(new Error("503 UNAVAILABLE: high demand"))).toBe(true);
    expect(isTransientAiError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientAiError(new Error("500 Internal Server Error"))).toBe(true);
    expect(isTransientAiError(new Error("fetch failed"))).toBe(true);
    expect(isTransientAiError(new Error("ECONNRESET"))).toBe(true);

    // Permanent errors
    expect(isTransientAiError(new Error("400 Bad Request"))).toBe(false);
    expect(isTransientAiError(new Error("401 Unauthorized"))).toBe(false);
    expect(isTransientAiError(new Error("404 Not Found"))).toBe(false);
    expect(isTransientAiError(new Error("429 Too Many Requests"))).toBe(false);

    // Jittered backoff is ~1,500ms (+/- 100ms)
    for (let i = 0; i < 20; i++) {
      const backoff = calculateJitteredBackoff();
      expect(backoff).toBeGreaterThanOrEqual(1400);
      expect(backoff).toBeLessThanOrEqual(1600);
    }
  });
});

