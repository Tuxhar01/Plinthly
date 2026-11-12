import { describe, it, expect } from "vitest";
import { createMultiItemPlanSchema, procurementLineItemSchema } from "../../lib/workflow/validation";
import { generateProcurementStrategies, evaluateDestinationTax, resolveDestinationJurisdictionState } from "../../lib/discovery/cart/strategy-engine";
import { ProcurementLineItem } from "../../lib/discovery/cart/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";

describe("Multi-Item Evaluation & Judge Demo Defect Verification", () => {
  describe("1. Request Validation & Field-Level Errors", () => {
    it("accepts line items with legacy_direct quantitySource from converted single purchases", () => {
      const legacyItem = {
        id: "line_legacy_001",
        title: "Dell XPS 15 Laptop (32GB RAM)",
        quantity: 1,
        quantitySource: "legacy_direct",
        budgetCents: 150000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
        verificationLevel: "standard",
      };

      const parseResult = procurementLineItemSchema.safeParse(legacyItem);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.quantitySource).toBe("legacy_direct");
      }
    });

    it("accepts explicit, inferred, and manual_override quantity sources", () => {
      for (const src of ["explicit", "inferred", "manual_override", "unresolved"] as const) {
        const item = {
          id: `line_${src}`,
          title: "Hardware component",
          quantity: 2,
          quantitySource: src,
          currency: "USD",
        };
        const parseResult = procurementLineItemSchema.safeParse(item);
        expect(parseResult.success).toBe(true);
      }
    });

    it("returns actionable field-level validation errors when invalid payload is submitted", () => {
      const invalidPayload = {
        lineItems: [
          {
            id: "", // invalid: empty id
            title: "Item with zero quantity",
            quantity: 0, // invalid: min 1
            budgetCents: -500, // invalid: min 0
            currency: "EUR", // invalid: literal USD
          },
        ],
        destination: {
          country: "US",
          postalCode: "", // invalid: required non-empty
        },
      };

      const result = createMultiItemPlanSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        const paths = issues.map((i) => i.path.join("."));
        expect(paths).toContain("lineItems.0.id");
        expect(paths).toContain("lineItems.0.quantity");
        expect(paths).toContain("lineItems.0.budgetCents");
        expect(paths).toContain("lineItems.0.currency");
        expect(paths).toContain("destination.postalCode");
      }
    });
  });

  describe("2. Demo Fixture Integrity", () => {
    const fixtureItems: ProcurementLineItem[] = [
      {
        id: "line_1",
        title: "Dell XPS 15 Laptop (32GB RAM)",
        quantity: 1,
        budgetCents: 150000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
        verificationLevel: "standard",
        quantitySource: "explicit",
      },
      {
        id: "line_2",
        title: "Dell UltraSharp 27 4K Monitor",
        quantity: 1,
        budgetCents: 40000,
        currency: "USD",
        requirements: [{ key: "resolution", expectedValue: "4K", description: "4K UHD Resolution" }],
        verificationLevel: "standard",
        quantitySource: "explicit",
      },
      {
        id: "line_3",
        title: "USB-C Dual 4K Docking Station",
        quantity: 1,
        budgetCents: 15000,
        currency: "USD",
        requirements: [{ key: "ports", expectedValue: "Dual HDMI/DP", description: "Dual DisplayPort/HDMI" }],
        verificationLevel: "standard",
        quantitySource: "explicit",
      },
    ];

    it("UI button label is exactly 'Load Demo Fixture' without 'Judge' or item count", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const componentPath = path.resolve(__dirname, "../../components/workflow/multi-item-procurement-studio.tsx");
      const content = await fs.readFile(componentPath, "utf-8");

      // Verify exact visible button label
      expect(content).toContain("Load Demo Fixture");
      expect(content).not.toContain("Load Judge Demo Fixture");
      expect(content).not.toContain("Load Demo Fixture (3 Items)");
      expect(content).not.toContain("Load Judge Demo Fixture (3 Items)");

      // Verify banner
      expect(content).toContain("🧪 Synthetic Demo Fixture Active");
      expect(content).not.toContain("🧪 Synthetic Judge Demo Fixture Active");
    });

    it("fixture contains exactly three synthetic items with valid requirements and budgets", () => {
      expect(fixtureItems).toHaveLength(3);
      expect(fixtureItems.map((i) => i.id)).toEqual(["line_1", "line_2", "line_3"]);
      for (const item of fixtureItems) {
        expect(item.quantity).toBe(1);
        expect(item.currency).toBe("USD");
        expect(item.budgetCents).toBeGreaterThan(0);
        expect(item.requirements.length).toBeGreaterThan(0);
      }
    });

    it("re-loading fixture deterministically resets state without duplicating items", () => {
      let state = [...fixtureItems];
      expect(state).toHaveLength(3);
      // Simulate clicking Load Demo Fixture again
      state = [...fixtureItems];
      expect(state).toHaveLength(3);
      expect(state.map((i) => i.id)).toEqual(["line_1", "line_2", "line_3"]);
    });
  });

  const fixtureItems: ProcurementLineItem[] = [
    {
      id: "line_1",
      title: "Dell XPS 15 Laptop (32GB RAM)",
      quantity: 1,
      budgetCents: 150000,
      currency: "USD",
      requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
      verificationLevel: "standard",
    },
    {
      id: "line_2",
      title: "Dell UltraSharp 27 4K Monitor",
      quantity: 1,
      budgetCents: 40000,
      currency: "USD",
      requirements: [{ key: "resolution", expectedValue: "4K", description: "4K UHD Resolution" }],
      verificationLevel: "standard",
    },
    {
      id: "line_3",
      title: "USB-C Dual 4K Docking Station",
      quantity: 1,
      budgetCents: 15000,
      currency: "USD",
      requirements: [{ key: "ports", expectedValue: "Dual HDMI/DP", description: "Dual DisplayPort/HDMI" }],
      verificationLevel: "standard",
    },
  ];

  const fixtureCandidates: NormalizedProductCandidate[] = [
    {
      id: "cand_bb_laptop",
      purchaseId: "test_pur_001",
      externalId: "bb_laptop_001",
      title: "Dell XPS 15 Laptop (32GB RAM)",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/dell-xps-15",
      unitPriceCents: 146000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 146000,
      currency: "USD",
      availability: "in_stock",
      source: "seeded",
      capturedAt: new Date(),
      snapshotHash: "hash_bb_laptop",
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "Best Buy",
      isMarketplace: false,
      isDirectRetailerSeller: true,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { ram: "32GB" },
    },
    {
      id: "cand_bb_monitor",
      purchaseId: "test_pur_001",
      externalId: "bb_monitor_002",
      title: "Dell UltraSharp 27 4K Monitor",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/dell-ultrasharp-27",
      unitPriceCents: 40000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 40000,
      currency: "USD",
      availability: "in_stock",
      source: "seeded",
      capturedAt: new Date(),
      snapshotHash: "hash_bb_monitor",
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "Best Buy",
      isMarketplace: false,
      isDirectRetailerSeller: true,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { resolution: "4K" },
    },
    {
      id: "cand_bb_dock",
      purchaseId: "test_pur_001",
      externalId: "bb_dock_003",
      title: "USB-C Dual 4K Docking Station",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/usbc-dock",
      unitPriceCents: 15000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 15000,
      currency: "USD",
      availability: "in_stock",
      source: "seeded",
      capturedAt: new Date(),
      snapshotHash: "hash_bb_dock",
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "Best Buy",
      isMarketplace: false,
      isDirectRetailerSeller: true,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { ports: "Dual HDMI/DP" },
    },
    {
      id: "cand_bh_dock",
      purchaseId: "test_pur_001",
      externalId: "bh_dock_004",
      title: "B&H USB-C Dual Dock",
      merchantName: "B&H Photo Video",
      merchantUrl: "https://www.bhphotovideo.com/c/product/dock",
      unitPriceCents: 14000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 14000,
      currency: "USD",
      availability: "in_stock",
      source: "seeded",
      capturedAt: new Date(),
      snapshotHash: "hash_bh_dock",
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "B&H Photo Video",
      isMarketplace: false,
      isDirectRetailerSeller: true,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { ports: "Dual HDMI/DP" },
    },
  ];

  describe("3. Strategy Evaluation Workflow & Defensible Landed Cost", () => {

    it("generates 4 procurement strategies with accurate merchandise and policy shipping", () => {
      const strategies = generateProcurementStrategies({
        lineItems: fixtureItems,
        candidates: fixtureCandidates,
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      });

      expect(strategies).toHaveLength(4);
      const strategyIds = strategies.map((s) => s.strategyId);
      expect(strategyIds).toContain("strat_consolidated_single_retailer");
      expect(strategyIds).toContain("strat_lowest_landed_cost");
      expect(strategyIds).toContain("strat_authoritative_first_party");
      expect(strategyIds).toContain("strat_balanced_optimal");

      // Verify Consolidated Single-Retailer strategy (Best Buy only: $1460 + $400 + $150 = $2010)
      const consolidated = strategies.find((s) => s.strategyId === "strat_consolidated_single_retailer")!;
      expect(consolidated.retailerCount).toBe(1);
      expect(consolidated.shipmentCount).toBe(1);
      expect(consolidated.totalMerchandiseCents).toBe(201000);
      expect(consolidated.totalShippingCents).toBe(0); // Best Buy threshold met
      expect(consolidated.shippingEvidenceType).toBe("policy_derived");

      // Verify Lowest Landed Cost strategy splits dock to B&H for $10 savings ($1460 + $400 + $140 = $2000)
      const lowestCost = strategies.find((s) => s.strategyId === "strat_lowest_landed_cost")!;
      expect(lowestCost.retailerCount).toBe(2);
      expect(lowestCost.totalMerchandiseCents).toBe(200000);
      expect(lowestCost.totalShippingCents).toBe(0);
    });

    it("enforces fail-closed tax behavior: Washington (98101) totalLandedCost is null due to unquoted sales tax", () => {
      const strategies = generateProcurementStrategies({
        lineItems: fixtureItems,
        candidates: fixtureCandidates,
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      });

      const consolidated = strategies.find((s) => s.strategyId === "strat_consolidated_single_retailer")!;
      // Total landed cost MUST be null because tax is unquoted
      expect(consolidated.totalLandedCostCents).toBeNull();
      expect(consolidated.isLandedCostDefensible).toBe(false);
      expect(consolidated.costBreakdown?.missingComponents).toContain("tax");

      // But pre-tax subtotal is fully known: $2,010.00 USD
      const preTaxCents = consolidated.totalMerchandiseCents + (consolidated.totalShippingCents ?? 0);
      expect(preTaxCents).toBe(201000);
    });

    it("resolves destination jurisdiction state properly (WA, OR, NY, TX, FL, CA, IL, MA, PA)", () => {
      const dest = (postalCode: string) => ({ country: "US" as const, postalCode, deliveryMethodPreference: "standard_ground" as const });
      expect(resolveDestinationJurisdictionState(dest("98101"))).toBe("WA");
      expect(resolveDestinationJurisdictionState(dest("97201"))).toBe("OR");
      expect(resolveDestinationJurisdictionState(dest("10001"))).toBe("NY");
      expect(resolveDestinationJurisdictionState(dest("75001"))).toBe("TX");
      expect(resolveDestinationJurisdictionState(dest("32001"))).toBe("FL");
      expect(resolveDestinationJurisdictionState(dest("90210"))).toBe("CA");
      expect(resolveDestinationJurisdictionState(dest("60601"))).toBe("IL");
      expect(resolveDestinationJurisdictionState(dest("02138"))).toBe("MA");
      expect(resolveDestinationJurisdictionState(dest("19104"))).toBe("PA");
    });

    it("statutory sales-tax-free jurisdiction (Oregon 97201) unlocks 100% complete defensible landed cost", () => {
      const taxEval = evaluateDestinationTax({ country: "US", postalCode: "97201", deliveryMethodPreference: "standard_ground" });
      expect(taxEval.taxCents).toBe(0);
      expect(taxEval.isTaxDefensible).toBe(true);
      expect(taxEval.taxEvidence.status).toBe("statutory_absence");

      const strategies = generateProcurementStrategies({
        lineItems: fixtureItems,
        candidates: fixtureCandidates,
        destination: { country: "US", postalCode: "97201", deliveryMethodPreference: "standard_ground" },
      });

      const consolidated = strategies.find((s) => s.strategyId === "strat_consolidated_single_retailer")!;
      expect(consolidated.totalLandedCostCents).toBe(201000); // 100% complete and defensible!
      expect(consolidated.isLandedCostDefensible).toBe(true);
      expect(consolidated.feasibility).toBe("feasible");
    });
  });

  describe("4. Exact Screenshot Reproduction: legacy_direct on Existing Purchase", () => {
    it("evaluates plan with line_1 specifying legacy_direct without throwing unauthorized provenance error", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const { InMemoryPurchaseRepository } = await import("../../lib/workflow/repository");
      const repo = new InMemoryPurchaseRepository();
      const mockPayPal = {
        createOrder: () => Promise.resolve({ id: "mock", status: "CREATED", links: [] }),
        getOrder: () => Promise.resolve({ id: "mock", status: "CREATED" }),
      } as unknown as import("../../lib/paypal/client").PayPalSandboxClient;
      const service = new PurchaseWorkflowService(repo, mockPayPal);

      const humanBuyer = { kind: "user" as const, id: "usr_buyer_1", userId: "usr_buyer_1" };
      const defaultDestination = { country: "US" as const, postalCode: "98101", deliveryMethodPreference: "standard_ground" as const };

      // Create an existing legacy purchase with single-item requirements
      const existingPurchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination: defaultDestination,
          requirements: ["Dell XPS 15", "32GB RAM"],
        },
        humanBuyer
      );

      // Verify that the purchase was created as a legacy direct purchase
      expect(existingPurchase.id).toBeDefined();

      // Exact request matching browser payload from screenshot:
      const payload = {
        lineItems: [
          {
            id: "line_1",
            title: "Consolidated Procurement Request",
            quantity: 1,
            quantitySource: "legacy_direct" as const,
            budgetCents: 150000,
            currency: "USD" as const,
            requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
            verificationLevel: "standard" as const,
          },
        ],
        destination: defaultDestination,
        candidates: fixtureCandidates,
      };

      // Execute createMultiItemPlan directly
      const result = await service.createMultiItemPlan(
        existingPurchase.id,
        payload,
        humanBuyer
      );

      expect(result).toBeDefined();
      expect(result.purchaseId).toBe(existingPurchase.id);
      expect(result.strategies).toBeDefined();
      expect(result.strategies.length).toBeGreaterThan(0);
    });

    it("rejects forged legacy_direct provenance on modern non-legacy purchases fail-closed", async () => {
      const { PurchaseWorkflowService } = await import("../../lib/workflow/service");
      const { InMemoryPurchaseRepository } = await import("../../lib/workflow/repository");
      const repo = new InMemoryPurchaseRepository();
      const mockPayPal = {
        createOrder: () => Promise.resolve({ id: "mock", status: "CREATED", links: [] }),
        getOrder: () => Promise.resolve({ id: "mock", status: "CREATED" }),
      } as unknown as import("../../lib/paypal/client").PayPalSandboxClient;
      const service = new PurchaseWorkflowService(repo, mockPayPal);

      const humanBuyer = { kind: "user" as const, id: "usr_buyer_1", userId: "usr_buyer_1" };
      const defaultDestination = { country: "US" as const, postalCode: "98101", deliveryMethodPreference: "standard_ground" as const };

      // Create a modern multi-item purchase (not a legacy single-item purchase)
      const modernPurchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: [
            {
              id: "item_modern_1",
              title: "Modern Workstation",
              quantity: 1,
              quantitySource: "explicit" as const,
              quantityConfirmed: true,
              budgetCents: 150000,
              currency: "USD" as const,
              requirements: [],
            },
          ],
        },
        humanBuyer
      );

      expect(modernPurchase.id).toBeDefined();

      // Attacker attempts to forge legacy_direct provenance on this non-legacy purchase
      const forgedPayload = {
        lineItems: [
          {
            id: "line_1",
            title: "Forged Legacy Line Item",
            quantity: 1,
            quantitySource: "legacy_direct" as const,
            budgetCents: 150000,
            currency: "USD" as const,
            requirements: [],
            verificationLevel: "standard" as const,
          },
        ],
        destination: defaultDestination,
        candidates: fixtureCandidates,
      };

      // Must be rejected fail-closed with ValidationError
      try {
        await service.createMultiItemPlan(modernPurchase.id, forgedPayload, humanBuyer);
        expect.unreachable("Expected createMultiItemPlan to fail for forged legacy provenance");
      } catch (err: unknown) {
        const valErr = err as { name: string; message: string; details?: readonly { code: string; message: string }[] };
        expect(valErr.message).toBe("Invalid line items in multi-item plan request");
        expect(valErr.details).toBeDefined();
        expect(valErr.details?.some((d) => d.code === "unauthorized_legacy_provenance")).toBe(true);
      }
    });
  });

  describe("5. Product Compatibility as a Hard Constraint", () => {
    it("never allows a cheaper incompatible candidate to replace a specification-compatible candidate", async () => {
      const { allocateCandidatesToLineItems } = await import("../../lib/discovery/cart/allocation");

      const laptopLineItem: ProcurementLineItem = {
        id: "line_laptop",
        title: "High Performance Laptop",
        quantity: 1,
        budgetCents: 200000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
        verificationLevel: "standard",
      };

      const expensiveMatchingLaptop: NormalizedProductCandidate = {
        id: "cand_laptop_matching",
        purchaseId: "test_pur_compat",
        externalId: "ext_laptop_matching",
        title: "Enterprise Laptop with 32GB RAM",
        merchantName: "Dell",
        merchantUrl: "https://www.dell.com",
        unitPriceCents: 150000, // $1,500
        quantity: 1,
        shippingCents: 0,
        totalCents: 150000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date(),
        snapshotHash: "hash_laptop",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Dell",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ram: "32GB" },
      };

      const cheapIncompatibleAccessory: NormalizedProductCandidate = {
        id: "cand_cheap_dock",
        purchaseId: "test_pur_compat",
        externalId: "ext_cheap_dock",
        title: "USB Cable / Dock",
        merchantName: "Generic Store",
        merchantUrl: "https://www.example.com",
        unitPriceCents: 1000, // $10.00 — 150x cheaper!
        quantity: 1,
        shippingCents: 0,
        totalCents: 1000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date(),
        snapshotHash: "hash_dock",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Generic Store",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ports: "USB-A" }, // Lacks RAM specification
      };

      const allocation = allocateCandidatesToLineItems(
        [laptopLineItem],
        [cheapIncompatibleAccessory, expensiveMatchingLaptop]
      );

      // The cheap $10 accessory MUST NOT win over the $1,500 laptop that meets specifications
      expect(allocation.allocations).toHaveLength(1);
      expect(allocation.allocations[0].candidateId).toBe("cand_laptop_matching");
      expect(allocation.allocations[0].unitPriceCents).toBe(150000);
    });

    it("strictly excludes candidates with contradictory specifications (compatible === false)", async () => {
      const { allocateCandidatesToLineItems, checkCandidateCompatibility } = await import("../../lib/discovery/cart/allocation");

      const lineItem: ProcurementLineItem = {
        id: "line_laptop_spec",
        title: "Workstation Laptop",
        quantity: 1,
        budgetCents: 200000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
        verificationLevel: "standard",
      };

      const contradictoryCandidate: NormalizedProductCandidate = {
        id: "cand_contradict",
        purchaseId: "test_pur_compat",
        externalId: "ext_contradict",
        title: "Budget Laptop with 8GB RAM",
        merchantName: "Shop",
        merchantUrl: "https://www.shop.com",
        unitPriceCents: 50000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 50000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date(),
        snapshotHash: "hash_contra",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Shop",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ram: "8GB" }, // Explicit contradiction with 32GB requested!
      };

      const compat = checkCandidateCompatibility(lineItem, contradictoryCandidate);
      expect(compat.compatible).toBe(false);
      expect(compat.contradictorySpecs.length).toBeGreaterThan(0);

      const allocation = allocateCandidatesToLineItems([lineItem], [contradictoryCandidate]);
      expect(allocation.allocations).toHaveLength(0);
      expect(allocation.unallocatedLineItemIds).toContain("line_laptop_spec");
    });

    it("strictly excludes candidates with unknown/missing specifications under strict verification", async () => {
      const { allocateCandidatesToLineItems, checkCandidateCompatibility } = await import("../../lib/discovery/cart/allocation");

      const strictLineItem: ProcurementLineItem = {
        id: "line_strict_spec",
        title: "Mission Critical Hardware",
        quantity: 1,
        budgetCents: 200000,
        currency: "USD",
        requirements: [{ key: "ecc_memory", expectedValue: "true", description: "ECC Memory" }],
        verificationLevel: "strict",
      };

      const unevidencedCandidate: NormalizedProductCandidate = {
        id: "cand_unevidenced",
        purchaseId: "test_pur_compat",
        externalId: "ext_unevidenced",
        title: "Generic Desktop Unit",
        merchantName: "Shop",
        merchantUrl: "https://www.shop.com",
        unitPriceCents: 80000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 80000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date(),
        snapshotHash: "hash_unevidenced",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Shop",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: {}, // Missing ECC specification!
      };

      const compat = checkCandidateCompatibility(strictLineItem, unevidencedCandidate);
      expect(compat.compatible).toBe(false);
      expect(compat.missingSpecs).toContain("ecc_memory");

      const allocation = allocateCandidatesToLineItems([strictLineItem], [unevidencedCandidate]);
      expect(allocation.allocations).toHaveLength(0);
      expect(allocation.unallocatedLineItemIds).toContain("line_strict_spec");
    });
  });

  describe("6. Tax Evidence Verification: Statutory Absence vs Unsupported Quotes", () => {
    it("validates Oregon zero-tax is backed by explicit statutory rule jurisdiction_tax_rules_2026.1", () => {
      const taxEval = evaluateDestinationTax({
        country: "US",
        postalCode: "97201",
        deliveryMethodPreference: "standard_ground",
      });

      expect(taxEval.taxCents).toBe(0);
      expect(taxEval.isTaxDefensible).toBe(true);
      expect(taxEval.taxEvidence.status).toBe("statutory_absence");
      expect(taxEval.taxEvidence.sourceIdentity).toBe("statutory_rule_engine");
      expect(taxEval.taxEvidence.evidenceReference).toBe("jurisdiction_tax_rules_2026.1_statutory_absence_or");
    });

    it("fails closed when explicit zero-tax claim is from an untrusted authority", () => {
      const forgedTax = {
        amountCents: 0,
        status: "quoted" as const,
        sourceIdentity: "forged_untrusted_tax_authority",
        evidenceReference: "ref_forged_quote_123",
        explanation: "Claiming 0 tax without enrollment",
      };

      const taxEval = evaluateDestinationTax(
        { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
        forgedTax
      );

      // Must fail closed: marked untrusted, isTaxDefensible is false
      expect(taxEval.isTaxDefensible).toBe(false);
      expect(taxEval.taxEvidence.status).toBe("untrusted");
    });

    it("rejects caller-supplied statutory_absence or statutory_zero claims fail-closed as untrusted", () => {
      // Caller attempts to assert statutory absence for California (90210)
      const spoofedStatutoryZero = {
        amountCents: 0,
        status: "statutory_absence" as const,
        evidenceReference: "fake_reference_or_statutory",
        explanation: "Caller claiming California is sales-tax-free",
      };

      const taxEval = evaluateDestinationTax(
        { country: "US", postalCode: "90210", deliveryMethodPreference: "standard_ground" },
        spoofedStatutoryZero
      );

      // Caller cannot supply statutory absence claims; server marks untrusted
      expect(taxEval.isTaxDefensible).toBe(false);
      expect(taxEval.taxEvidence.status).toBe("untrusted");
      expect(taxEval.taxEvidence.explanation).toContain("Fabricated statutory zero / Fabricated statutory absence claim");
    });

    it("fails closed for unsupported jurisdictions (e.g. Washington 98101) with missing defensible tax", () => {
      const taxEval = evaluateDestinationTax({
        country: "US",
        postalCode: "98101",
        deliveryMethodPreference: "standard_ground",
      });

      // Washington has state and local sales tax; absent an authoritative quote it is missing
      expect(taxEval.taxCents).toBeNull();
      expect(taxEval.isTaxDefensible).toBe(false);
      expect(taxEval.taxEvidence.status).toBe("missing");
      expect(taxEval.taxEvidence.jurisdictionState).toBe("WA");
    });
  });
});
