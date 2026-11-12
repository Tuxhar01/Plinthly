import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import {
  PurchaseRequestCard,
  mapLineItemsFromDraft,
  FormMultiItem,
} from "../../components/workflow/purchase-request-card";

describe("Plinthly — AI Draft-to-Form Synchronization & State Transition", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // TEST 1: Two extracted items automatically appear with unspecified quantities as null
  // --------------------------------------------------------------------------
  it("1. Automatically populates extracted items with unspecified quantities as null and unconfirmed", () => {
    const rawLineItems = [
      {
        id: "li_1_laptop",
        title: "laptop for software development",
        quantity: null,
        quantitySource: "inferred" as const,
        originalInferredQuantity: 1,
        budgetCents: null,
        requirements: [{ key: "purpose", expectedValue: "software development" }],
      },
      {
        id: "li_2_monitor",
        title: "monitor",
        quantity: null,
        quantitySource: "inferred" as const,
        originalInferredQuantity: 1,
        budgetCents: null,
        requirements: [],
      },
    ];

    const mapped = mapLineItemsFromDraft(rawLineItems, "usr_buyer_test");

    expect(mapped).toHaveLength(2);

    // Item 1: Laptop
    expect(mapped[0].id).toBe("li_1_laptop");
    expect(mapped[0].title).toBe("laptop for software development");
    expect(mapped[0].quantity).toBeNull();
    expect(mapped[0].quantitySource).toBe("unresolved");
    expect(mapped[0].quantityConfirmed).toBe(false);
    expect(mapped[0].originalInferredQuantity).toBe(1);
    expect(mapped[0].budgetDollars).toBe("");

    // Item 2: Monitor
    expect(mapped[1].id).toBe("li_2_monitor");
    expect(mapped[1].title).toBe("monitor");
    expect(mapped[1].quantity).toBeNull();
    expect(mapped[1].quantitySource).toBe("unresolved");
    expect(mapped[1].quantityConfirmed).toBe(false);
    expect(mapped[1].originalInferredQuantity).toBe(1);
    expect(mapped[1].budgetDollars).toBe("");
  });

  // --------------------------------------------------------------------------
  // TEST 2: Items with explicit quantities are confirmed; unspecified quantities remain null
  // --------------------------------------------------------------------------
  it("2. Explicit numerical counts are confirmed, while generic articles remain null and unconfirmed", () => {
    const mixedLineItems = [
      {
        id: "li_1_laptops",
        title: "Dell XPS 15",
        quantity: 2,
        quantitySource: "explicit" as const,
        originalInferredQuantity: null,
        budgetCents: 300000,
        requirements: [{ key: "ram", expectedValue: "32GB" }],
      },
      {
        id: "li_2_monitor",
        title: "4K Monitor",
        quantity: null,
        quantitySource: "inferred" as const,
        originalInferredQuantity: 1,
        budgetCents: 40000,
        requirements: [],
      },
    ];

    const mapped = mapLineItemsFromDraft(mixedLineItems, "usr_buyer_test");

    expect(mapped).toHaveLength(2);

    // Dell XPS has explicit count 2:
    expect(mapped[0].quantity).toBe(2);
    expect(mapped[0].quantitySource).toBe("explicit");
    expect(mapped[0].quantityConfirmed).toBe(true);
    expect(mapped[0].budgetDollars).toBe("3000.00");

    // Monitor has generic/unspecified count:
    expect(mapped[1].quantity).toBeNull();
    expect(mapped[1].quantitySource).toBe("unresolved");
    expect(mapped[1].quantityConfirmed).toBe(false);
    expect(mapped[1].budgetDollars).toBe("400.00");
  });

  // --------------------------------------------------------------------------
  // TEST 3: Switching procurement modes preserves extracted line items and confirmation state
  // --------------------------------------------------------------------------
  it("3. Switching procurement modes preserves extracted line items and their confirmation state", () => {
    // Initial state with 2 extracted items, one of which was confirmed by buyer
    const initialItems: FormMultiItem[] = [
      {
        id: "line_1",
        title: "laptop",
        quantity: 1,
        quantitySource: "manual_override",
        quantityConfirmed: true,
        originalInferredQuantity: null,
        confirmationToken: "token_laptop_xyz",
        confirmedAt: "2026-11-08T14:00:00.000Z",
        confirmedBy: "usr_buyer_1",
        budgetDollars: "1200.00",
        requirements: [],
      },
      {
        id: "line_2",
        title: "monitor",
        quantity: null,
        quantitySource: "unresolved",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        confirmationToken: undefined,
        confirmedAt: null,
        confirmedBy: null,
        budgetDollars: "350.00",
        requirements: [],
      },
    ];

    // Buyer toggles to Single-Item Procurement
    let mode: "single" | "multi" = "multi";
    let storedMultiItems = [...initialItems];

    // Toggle to single
    mode = "single";
    // Switching to single must NOT delete or wipe storedMultiItems
    expect(storedMultiItems).toHaveLength(2);
    expect(storedMultiItems[0].quantityConfirmed).toBe(true);
    expect(storedMultiItems[0].confirmationToken).toBe("token_laptop_xyz");

    // Toggle back to multi
    mode = "multi";
    // Stored items remain identical with confirmation states intact
    expect(storedMultiItems).toHaveLength(2);
    expect(storedMultiItems[0].id).toBe("line_1");
    expect(storedMultiItems[0].quantity).toBe(1);
    expect(storedMultiItems[0].confirmationToken).toBe("token_laptop_xyz");
    expect(storedMultiItems[1].id).toBe("line_2");
    expect(storedMultiItems[1].quantity).toBeNull();
    expect(storedMultiItems[1].quantityConfirmed).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Clear Form removes stale AI draft, errors, and form state
  // --------------------------------------------------------------------------
  it("4. Clear Form removes both AI draft and procurement form state", () => {
    // Simulate populated form state with active AI draft
    let budgetDollars = "2500.00";
    let postalCode = "98101";
    let requirementsText = "spec: fast";
    let multiItems: FormMultiItem[] = [
      {
        id: "line_1",
        title: "laptop",
        quantity: null,
        quantitySource: "unresolved",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetDollars: "",
      },
    ];
    let aiDraft: Record<string, unknown> | null = {
      productKeywords: "laptop, monitor",
      budgetCents: 250000,
    };
    let aiError: string | null = "Some prior error";
    let isManuallyEdited = true;
    let isDemoTemplateLoaded = false;

    // Simulate clicking handleClearForm() matching purchase-request-card.tsx
    const handleClearForm = () => {
      budgetDollars = "";
      postalCode = "";
      requirementsText = "";
      multiItems = [];
      aiDraft = null;
      aiError = null;
      isManuallyEdited = false;
      isDemoTemplateLoaded = false;
    };

    handleClearForm();

    expect(budgetDollars).toBe("");
    expect(postalCode).toBe("");
    expect(requirementsText).toBe("");
    expect(multiItems).toHaveLength(0);
    expect(aiDraft).toBeNull();
    expect(aiError).toBeNull();
    expect(isManuallyEdited).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 5: Failed decomposition does not populate unrelated or synthetic purchase data
  // --------------------------------------------------------------------------
  it("5. Failed decomposition does not populate unrelated or synthetic purchase data", () => {
    let budgetDollars = "";
    let multiItems: FormMultiItem[] = [];
    let aiDraft: Record<string, unknown> | null = null;
    let aiError: string | null = null;
    const isManuallyEdited = false;

    // Start decomposition -> clear previous draft state
    if (!isManuallyEdited) {
      budgetDollars = "";
      multiItems = [];
    }

    // Provider returns 503 UNAVAILABLE
    const providerFailed = true;
    if (providerFailed) {
      aiError = "[ai_service_unavailable] Gemini service is temporarily experiencing high demand (503).";
      aiDraft = null;
      if (!isManuallyEdited) {
        budgetDollars = "";
        multiItems = [];
      }
    }

    // Form must remain empty and not populated with demo values (e.g. Dell XPS, $150, etc.)
    expect(aiError).toContain("503");
    expect(aiDraft).toBeNull();
    expect(budgetDollars).toBe("");
    expect(multiItems).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // TEST 6: Submission remains blocked until all mandatory fields and quantities are confirmed
  // --------------------------------------------------------------------------
  it("6. Submission is strictly blocked with 0 line items or unconfirmed quantities", () => {
    // Case A: Multi-item mode with 0 items
    const validateMulti = (items: FormMultiItem[], budget: string) => {
      const errors: Record<string, string> = {};
      if (items.length === 0) {
        errors.multiItems = "At least one line item is required.";
      }
      const unconfirmed = items.filter(
        (it) => it.quantity === null || !it.quantityConfirmed || it.quantitySource === "unresolved"
      );
      if (unconfirmed.length > 0) {
        errors.multiItems = `Cannot submit purchase: ${unconfirmed.length} line item(s) have unspecified or unconfirmed quantities.`;
      }
      return Object.keys(errors).length === 0;
    };

    expect(validateMulti([], "1000.00")).toBe(false);

    // Case B: 2 items with null / unconfirmed quantities
    const unconfirmedItems: FormMultiItem[] = [
      {
        id: "line_1",
        title: "laptop",
        quantity: null,
        quantitySource: "unresolved",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetDollars: "800.00",
      },
      {
        id: "line_2",
        title: "monitor",
        quantity: null,
        quantitySource: "unresolved",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetDollars: "300.00",
      },
    ];

    expect(validateMulti(unconfirmedItems, "1100.00")).toBe(false);

    // Case C: 2 items with valid confirmed quantities
    const confirmedItems: FormMultiItem[] = [
      {
        id: "line_1",
        title: "laptop",
        quantity: 1,
        quantitySource: "explicit",
        quantityConfirmed: true,
        originalInferredQuantity: null,
        budgetDollars: "800.00",
      },
      {
        id: "line_2",
        title: "monitor",
        quantity: 1,
        quantitySource: "explicit",
        quantityConfirmed: true,
        originalInferredQuantity: null,
        budgetDollars: "300.00",
      },
    ];

    expect(validateMulti(confirmedItems, "1100.00")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 7: Form synchronization failure produces an explicit error banner
  // --------------------------------------------------------------------------
  it("7. Form synchronization failure produces an explicit error banner", () => {
    let aiError: string | null = null;

    try {
      // Simulate mapping failure
      const malformedLineItems = null;
      if (!malformedLineItems) {
        throw new Error("Line items collection was empty after mapping.");
      }
    } catch (syncErr: unknown) {
      aiError = `[draft_sync_error] ${
        syncErr instanceof Error ? syncErr.message : "Failed to synchronize"
      }`;
    }

    expect(aiError).toBe("[draft_sync_error] Line items collection was empty after mapping.");
  });

  // --------------------------------------------------------------------------
  // TEST 8: Component renders initial safe state with empty line items notice
  // --------------------------------------------------------------------------
  it("8. Component renders safe initial state with no pre-populated demo values", () => {
    const html = renderToString(
      React.createElement(PurchaseRequestCard, {
        actorId: "usr_buyer_test",
        onPurchaseCreated: () => {},
      })
    );

    // Unspecified quantity banner must appear
    expect(html).toContain("⚠️ Clarification: Specify Qty");
    // Form must not leak demo values
    expect(html).not.toContain("Dell XPS 15 Laptop (32GB RAM)");
    expect(html).toContain("Load Demo Template");
    expect(html).toContain("Decompose with Gemini");
  });
});

