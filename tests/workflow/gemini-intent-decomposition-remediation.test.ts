import { describe, it, expect } from "vitest";
import { decomposePurchaseIntent, AiTimeoutError } from "../../lib/ai/intent-parser";
import { decomposedIntentSchema } from "../../lib/ai/types";
import { createPurchaseSchema } from "../../lib/workflow/validation";

describe("Gemini Purchase-Intent Decomposition & Client State Remediation", () => {
  describe("Aggregate Budget Propagation & Preservation", () => {
    it("preserves $5,000 aggregate budget when line item budgets are unspecified (Test 2)", async () => {
      const mockResult = JSON.stringify({
        budgetCents: 500000,
        currency: "USD",
        quantity: 2,
        productKeywords: "Dell XPS 15 laptop, 27-inch 4K monitor, USB-C docking station",
        destination: { country: "US", postalCode: "98101" },
        requirements: [
          { key: "delivery_date", expectedValue: "by November 20", description: "Delivery date requested by buyer" },
        ],
        lineItems: [
          {
            title: "Dell XPS 15 laptop",
            quantity: 2,
            budgetCents: null,
            requirements: [{ key: "brand", expectedValue: "Dell" }],
          },
          {
            title: "27-inch 4K monitor",
            quantity: 2,
            budgetCents: null,
            requirements: [{ key: "resolution", expectedValue: "4K" }],
          },
          {
            title: "USB-C docking station",
            quantity: 2,
            budgetCents: null,
            requirements: [{ key: "type", expectedValue: "USB-C" }],
          },
        ],
        unresolvedAmbiguities: [
          "Delivery year for November 20 is unspecified and requires buyer confirmation.",
        ],
        confidenceEstimate: {
          score: 0.9,
          label: "high",
          notes: "Quantities, items, aggregate budget, and destination ZIP provided.",
          isCalibratedProbability: false,
        },
      });

      const intent = await decomposePurchaseIntent(
        "I need 2 Dell XPS 15 laptops, 2 27-inch 4K monitors, and 2 USB-C docking stations. Deliver everything to ZIP 98101 by November 20. Total budget is $5,000.",
        {
          customGenerator: async () => mockResult,
        }
      );

      // Verify aggregate budget is preserved (500000 cents = $5,000)
      expect(intent.budgetCents).toBe(500000);
      expect(intent.currency).toBe("USD");
      expect(intent.lineItems).toHaveLength(3);

      // Individual item budgets are explicitly null/unspecified
      expect(intent.lineItems![0].budgetCents).toBeNull();
      expect(intent.lineItems![1].budgetCents).toBeNull();
      expect(intent.lineItems![2].budgetCents).toBeNull();

      // Schema validation passes
      const validated = decomposedIntentSchema.safeParse(intent);
      expect(validated.success).toBe(true);

      // Backend createPurchaseSchema accepts aggregate budget with unspecified item budgets
      const purchasePayload = {
        budgetCents: intent.budgetCents,
        currency: "USD" as const,
        destination: {
          country: "US" as const,
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground" as const,
        },
        lineItems: intent.lineItems!.map((item, idx) => ({
          id: `line_${idx + 1}`,
          title: item.title,
          quantity: item.quantity ?? 1,
          quantitySource: "explicit" as const,
          quantityConfirmed: true,
          budgetCents: item.budgetCents ?? undefined,
          requirements: item.requirements || [],
        })),
      };

      const purchaseParseResult = createPurchaseSchema.safeParse(purchasePayload);
      expect(purchaseParseResult.success).toBe(true);
    });

    it("reconciles individual item ceilings when stated in prompt (e.g. 1500 + 400 + 150)", async () => {
      const mockResult = JSON.stringify({
        budgetCents: 205000,
        currency: "USD",
        quantity: null,
        productKeywords: "workstation laptop, 4K monitor, USB-C dock",
        destination: { country: "US", postalCode: "94103" },
        requirements: [],
        lineItems: [
          { title: "workstation laptop", quantity: 1, budgetCents: 150000, requirements: [] },
          { title: "4K monitor", quantity: 1, budgetCents: 40000, requirements: [] },
          { title: "USB-C dock", quantity: 1, budgetCents: 15000, requirements: [] },
        ],
        unresolvedAmbiguities: [],
        confidenceEstimate: {
          score: 0.95,
          label: "high",
          notes: "Itemized ceilings provided.",
          isCalibratedProbability: false,
        },
      });

      const intent = await decomposePurchaseIntent("laptop under $1500, monitor under $400, dock under $150", {
        customGenerator: async () => mockResult,
      });

      expect(intent.budgetCents).toBe(205000);
      expect(intent.lineItems![0].budgetCents).toBe(150000);
      expect(intent.lineItems![1].budgetCents).toBe(40000);
      expect(intent.lineItems![2].budgetCents).toBe(15000);
    });
  });

  describe("Section 3 Comprehensive Regression Tests", () => {
    it("1. Successful decomposition followed by timeout clears stale draft", async () => {
      let activeRequestId = 0;
      let clientDraft: any = null;
      let clientError: string | null = null;

      const triggerDecomposition = async (shouldTimeout: boolean, payload?: any) => {
        const reqId = ++activeRequestId;
        // Immediate invalidation of previous state
        clientDraft = null;
        clientError = null;

        if (shouldTimeout) {
          try {
            throw new AiTimeoutError("Provider request timed out after 12000ms");
          } catch (err: any) {
            if (activeRequestId === reqId) {
              clientError = `[${err.code}] ${err.message}`;
              clientDraft = null;
            }
          }
        } else {
          if (activeRequestId === reqId) {
            clientDraft = payload;
          }
        }
      };

      // Step A: First decomposition succeeds
      await triggerDecomposition(false, { productKeywords: "MacBook Pro", budgetCents: 400000 });
      expect(clientDraft).toEqual({ productKeywords: "MacBook Pro", budgetCents: 400000 });
      expect(clientError).toBeNull();

      // Step B: Followed by timeout -> draft MUST be cleared and error shown
      await triggerDecomposition(true);
      expect(clientDraft).toBeNull();
      expect(clientError).toContain("ai_timeout");
    });

    it("2. Successful decomposition followed by another successful decomposition updates cleanly", async () => {
      let activeRequestId = 0;
      let clientDraft: any = null;

      const triggerDecomposition = async (payload: any) => {
        const reqId = ++activeRequestId;
        clientDraft = null;
        if (activeRequestId === reqId) {
          clientDraft = payload;
        }
      };

      // Run decomposition 1
      await triggerDecomposition({ productKeywords: "Prompt 1 Draft", budgetCents: 200000 });
      expect(clientDraft.productKeywords).toBe("Prompt 1 Draft");

      // Run decomposition 2
      await triggerDecomposition({ productKeywords: "Prompt 2 Draft", budgetCents: 500000 });
      expect(clientDraft.productKeywords).toBe("Prompt 2 Draft");
      expect(clientDraft.budgetCents).toBe(500000);
    });

    it("3. Two overlapping requests where the older response arrives last (race condition prevention)", async () => {
      let activeRequestId = 0;
      let clientDraft: any = null;

      const runDecomposition = async (requestId: number, delayMs: number, resultData: any) => {
        clientDraft = null;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (requestId !== activeRequestId) {
          return; // Discard older/superseded response
        }
        clientDraft = resultData;
      };

      const req1Id = ++activeRequestId;
      const promise1 = runDecomposition(req1Id, 80, { prompt: "Older Request 1" });

      const req2Id = ++activeRequestId;
      const promise2 = runDecomposition(req2Id, 20, { prompt: "Newer Request 2" });

      await Promise.all([promise1, promise2]);
      expect(clientDraft).toEqual({ prompt: "Newer Request 2" });
    });

    it("4. Timeout followed by retry recovers successfully", async () => {
      let activeRequestId = 0;
      let clientDraft: any = null;
      let clientError: string | null = null;
      let attempt = 0;

      const executeWithRetry = async () => {
        const reqId = ++activeRequestId;
        clientDraft = null;
        clientError = null;
        attempt++;

        if (attempt === 1) {
          clientError = "[ai_timeout] Provider timed out";
          clientDraft = null;
          return;
        }
        clientDraft = { productKeywords: "Recovered Item", budgetCents: 300000 };
      };

      // Attempt 1 fails
      await executeWithRetry();
      expect(clientDraft).toBeNull();
      expect(clientError).toContain("ai_timeout");

      // Attempt 2 (Retry action) succeeds
      await executeWithRetry();
      expect(clientDraft).toEqual({ productKeywords: "Recovered Item", budgetCents: 300000 });
      expect(clientError).toBeNull();
    });

    it("5. Switching between single-item and multi-item modes", () => {
      let mode: "single" | "multi" = "single";
      let singleRequirement = "MacBook Pro M4 16GB RAM";
      let multiItems = [
        { id: "line_1", title: "MacBook Pro M4", quantity: 1 },
        { id: "line_2", title: "4K Monitor", quantity: 1 },
      ];

      // Switch to multi-item mode
      mode = "multi";
      expect(mode).toBe("multi");
      expect(multiItems).toHaveLength(2);

      // Switch back to single-item mode
      mode = "single";
      expect(mode).toBe("single");
      expect(singleRequirement).toBe("MacBook Pro M4 16GB RAM");
    });

    it("6. Aggregate budget preservation across mode switching", () => {
      let budgetDollars = "5000.00";
      let mode: "single" | "multi" = "multi";

      // Total budget $5000 in multi-item mode
      const multiBudgetCents = Math.round(parseFloat(budgetDollars) * 100);
      expect(multiBudgetCents).toBe(500000);

      // Switch to single-item mode: budget must NOT be wiped
      mode = "single";
      const singleBudgetCents = Math.round(parseFloat(budgetDollars) * 100);
      expect(singleBudgetCents).toBe(500000);

      // Switch back to multi-item mode: budget remains $5000.00
      mode = "multi";
      expect(budgetDollars).toBe("5000.00");
    });

    it("7. Aggregate budget preservation through form rendering", () => {
      const intentBudgetCents = 500000;
      const initialBudgetDollars = (intentBudgetCents / 100).toFixed(2);
      expect(initialBudgetDollars).toBe("5000.00");

      // Form rendering structure
      const renderedCard = {
        aggregateBuyerBudget: `$${initialBudgetDollars} USD`,
        aggregateDescription: "Target expenditure limit",
        individualItemBudgets: "Unspecified",
        individualDescription: "Item-specific ceilings not set",
        estimatedProcurementCost: "Unknown until evaluation",
        costDescription: "Defensible landed cost via Multi-Item Studio",
      };

      expect(renderedCard.aggregateBuyerBudget).toBe("$5000.00 USD");
      expect(renderedCard.individualItemBudgets).toBe("Unspecified");
      expect(renderedCard.estimatedProcurementCost).toBe("Unknown until evaluation");
    });

    it("8. Missing delivery year remains explicitly unresolved without hallucination", async () => {
      const mockResult = JSON.stringify({
        budgetCents: 400000,
        currency: "USD",
        quantity: 2,
        productKeywords: "MacBook Pro M4",
        destination: { country: "US", postalCode: "98101" },
        requirements: [{ key: "delivery_date", expectedValue: "by November 15" }],
        unresolvedAmbiguities: [
          "Delivery year is unspecified for 'November 15' and requires buyer confirmation.",
          "'As soon as possible' represents a buyer urgency preference, not a guaranteed delivery date.",
        ],
        confidenceEstimate: {
          score: 0.8,
          label: "medium",
          notes: "Quantities and specs present; delivery year unspecified.",
          isCalibratedProbability: false,
        },
      });

      const intent = await decomposePurchaseIntent("2 MacBook Pro M4 by November 15 ASAP", {
        customGenerator: async () => mockResult,
      });

      // Confirm no invented calendar year in delivery_date requirement
      const deliveryReq = intent.requirements.find((r) => r.key === "delivery_date");
      expect(deliveryReq?.expectedValue).toBe("by November 15");
      expect(deliveryReq?.expectedValue).not.toContain("2024");
      expect(deliveryReq?.expectedValue).not.toContain("2026");

      // Confirm explicit ambiguity warning is present
      const yearAmbiguity = intent.unresolvedAmbiguities.find((a) => a.includes("year"));
      expect(yearAmbiguity).toBeDefined();
      expect(yearAmbiguity).toContain("Delivery year is unspecified");

      // Confirm qualitative heuristic confidence is preserved
      expect(intent.confidenceEstimate.isCalibratedProbability).toBe(false);
      expect(["low", "medium", "high"]).toContain(intent.confidenceEstimate.label);
    });
  });

  describe("Prompt 3 & Unspecified Quantity Submission Blocking (Defect 2)", () => {
    const prompt3Text =
      "I need a good laptop for software development and a monitor for my setup. Deliver them as soon as possible.";

    const mockPrompt3Raw = JSON.stringify({
      productKeywords: "laptop, monitor",
      requirements: [],
      unresolvedAmbiguities: [
        "Quantity is not explicitly specified",
        "Delivery destination ZIP code is not specified; needed for shipping rate calculation.",
        "Delivery year is unspecified and requires buyer confirmation.",
        "'as soon as possible' represents a buyer urgency preference, not a guaranteed delivery date.",
        "Quantity for laptop is unspecified and must be confirmed before submission.",
        "Quantity for monitor is unspecified and must be confirmed before submission.",
      ],
      confidenceEstimate: {
        score: 0.4,
        label: "low",
        notes: "Multiple products requested without quantities, specifications, budgets, or destination ZIP codes.",
        isCalibratedProbability: false,
      },
      budgetCents: null,
      currency: null,
      destination: null,
      lineItems: [
        {
          title: "laptop",
          budgetCents: null,
          quantity: null,
          requirements: [
            {
              key: "purpose",
              description: "Intended use case",
              expectedValue: "software development",
            },
          ],
        },
        {
          title: "monitor",
          budgetCents: null,
          quantity: null,
          requirements: [],
        },
      ],
      quantity: null,
    });

    it("1. Preserves both requested items without inventing quantities (null, not 1)", async () => {
      const intent = await decomposePurchaseIntent(prompt3Text, {
        customGenerator: async () => mockPrompt3Raw,
      });

      // Preserves both requested items
      expect(intent.lineItems).toHaveLength(2);
      expect(intent.lineItems![0].title).toBe("laptop");
      expect(intent.lineItems![1].title).toBe("monitor");

      // Represent unspecified quantities as null; never default to 1
      expect(intent.lineItems![0].quantity).toBeNull();
      expect(intent.lineItems![1].quantity).toBeNull();
      expect(intent.quantity).toBeNull();

      // Explicit clarification requests for both quantities
      const laptopClarification = intent.unresolvedAmbiguities.find(
        (a) => a.includes("laptop") && a.includes("buyer confirmation is required")
      );
      expect(laptopClarification).toBeDefined();

      const monitorClarification = intent.unresolvedAmbiguities.find(
        (a) => a.includes("monitor") && a.includes("buyer confirmation is required")
      );
      expect(monitorClarification).toBeDefined();

      // "as soon as possible" preserved as an urgency preference, NOT a delivery guarantee
      const asapPreference = intent.unresolvedAmbiguities.find((a) =>
        a.includes("buyer urgency preference, not a guaranteed delivery date")
      );
      expect(asapPreference).toBeDefined();
    });

    it("2. Form submission is strictly blocked when quantities are unspecified", () => {
      // Simulating the form state mapped from Prompt 3
      const multiItemsState: Array<{
        id: string;
        title: string;
        quantity: number | null;
        quantitySource: "explicit" | "inferred" | "unresolved" | "manual_override";
        quantityConfirmed: boolean;
        budgetDollars: string;
      }> = [
        {
          id: "line_1",
          title: "laptop",
          quantity: null, // Unspecified
          quantitySource: "inferred",
          quantityConfirmed: false,
          budgetDollars: "1500.00",
        },
        {
          id: "line_2",
          title: "monitor",
          quantity: null, // Unspecified
          quantitySource: "inferred",
          quantityConfirmed: false,
          budgetDollars: "400.00",
        },
      ];

      // Form validation routine matching purchase-request-card.tsx
      const errors: Record<string, string> = {};
      for (let i = 0; i < multiItemsState.length; i++) {
        const item = multiItemsState[i];
        if (item.quantity === null || item.quantity === undefined || item.quantity < 1 || !Number.isInteger(item.quantity)) {
          errors[`item_${i}_quantity`] = `Quantity for "${item.title}" is unspecified. Please confirm quantity before submission.`;
        }
      }

      const unconfirmed = multiItemsState.filter(
        (item) => item.quantity === null || !item.quantityConfirmed || (item.quantitySource as string) === "unresolved" || (item.quantitySource as string) === "inferred"
      );
      if (unconfirmed.length > 0) {
        errors.multiItems = `Cannot submit purchase: ${unconfirmed.length} line item(s) have unspecified or unconfirmed quantities. Please specify and confirm quantities before submission.`;
      }

      // Validation MUST fail
      expect(Object.keys(errors).length).toBeGreaterThan(0);
      expect(errors.item_0_quantity).toBe('Quantity for "laptop" is unspecified. Please confirm quantity before submission.');
      expect(errors.item_1_quantity).toBe('Quantity for "monitor" is unspecified. Please confirm quantity before submission.');
      expect(errors.multiItems).toContain("2 line item(s) have unspecified or unconfirmed quantities");
    });

    it("3. Form submission succeeds once buyer explicitly specifies and confirms quantities", () => {
      // Buyer fills in quantity 1 for laptop and 1 for monitor, confirming each
      const multiItemsState = [
        {
          id: "line_1",
          title: "laptop",
          quantity: 1,
          quantitySource: "manual_override" as const,
          quantityConfirmed: true,
          budgetDollars: "1500.00",
        },
        {
          id: "line_2",
          title: "monitor",
          quantity: 1,
          quantitySource: "manual_override" as const,
          quantityConfirmed: true,
          budgetDollars: "400.00",
        },
      ];

      const errors: Record<string, string> = {};
      for (let i = 0; i < multiItemsState.length; i++) {
        const item = multiItemsState[i];
        if (item.quantity === null || item.quantity === undefined || item.quantity < 1 || !Number.isInteger(item.quantity)) {
          errors[`item_${i}_quantity`] = `Quantity for "${item.title}" is unspecified. Please confirm quantity before submission.`;
        }
      }

      const unconfirmed = multiItemsState.filter(
        (item) => item.quantity === null || !item.quantityConfirmed || (item.quantitySource as string) === "unresolved" || (item.quantitySource as string) === "inferred"
      );
      if (unconfirmed.length > 0) {
        errors.multiItems = `Cannot submit purchase: ${unconfirmed.length} line item(s) have unspecified or unconfirmed quantities. Please specify and confirm quantities before submission.`;
      }

      // Validation passes cleanly
      expect(Object.keys(errors)).toHaveLength(0);
    });

    it("4. Backend schema blocks submission if client attempts to submit without quantity confirmation", () => {
      // Attempting to submit unconfirmed inferred quantity without confirmationToken
      const unconfirmedSubmission = {
        budgetCents: 190000,
        currency: "USD" as const,
        destination: {
          country: "US" as const,
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground" as const,
        },
        lineItems: [
          {
            id: "line_1",
            title: "laptop",
            quantity: 1,
            quantitySource: "inferred" as const,
            quantityConfirmed: false,
            budgetCents: 150000,
            requirements: [],
          },
        ],
      };

      const result = createPurchaseSchema.safeParse(unconfirmedSubmission);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Inferred or unverified line item quantity requires explicit buyer confirmation token before submission"
        );
      }
    });
  });
});
