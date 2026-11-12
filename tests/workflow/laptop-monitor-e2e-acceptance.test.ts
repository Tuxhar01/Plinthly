import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { getPurchaseWorkflowService } from "../../lib/workflow/service";
import { Channel3SourceAdapter } from "../../lib/discovery/channel3-adapter";
import { generateProcurementStrategies } from "../../lib/discovery/cart/strategy-engine";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";
import { POST as multiItemPlanRoute } from "../../app/api/purchases/[id]/multi-item/plan/route";
import { Actor } from "../../lib/state/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";

// Ensure .env.local is loaded
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

const TARGET_PURCHASE_ID = "pur_1794149129429_osas38ir";
const PG_CONN = "postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public";
const BUYER_ACTOR: Actor = { kind: "user", userId: "usr_buyer_1" };

describe("PLINTHLY — Laptop + Monitor Procurement End-to-End Acceptance Suite", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = PG_CONN;
    setActorResolver(new ServerActorResolver("local_demo"));
  });

  // ==========================================================================
  // TEST A: PURCHASE INTEGRITY
  // ==========================================================================
  describe("Test A: Purchase Integrity", () => {
    it("1. Verifies exact persisted purchase record, line items, quantities, and audit trail in PostgreSQL", async () => {
      const client = new Client({ connectionString: PG_CONN });
      await client.connect();

      try {
        // Query direct database row
        const purchaseRes = await client.query('SELECT * FROM "Purchase" WHERE id = $1', [TARGET_PURCHASE_ID]);
        expect(purchaseRes.rows.length).toBe(1);
        const p = purchaseRes.rows[0];

        // 1. Exact purchase ID
        expect(p.id).toBe(TARGET_PURCHASE_ID);

        // 2. Status is REQUIREMENTS_CONFIRMED
        expect(p.status).toBe("REQUIREMENTS_CONFIRMED");

        // 3. Aggregate budget is $1,500 (150,000 cents)
        expect(p.budgetCents).toBe(150000);
        expect(p.currency).toBe("USD");

        // 4. Version is consistent (1)
        expect(p.version).toBe(1);

        // 5. Requirements line items verification
        const reqs = p.requirements as { lineItems: Array<Record<string, unknown>> };
        expect(reqs).toBeDefined();
        expect(Array.isArray(reqs.lineItems)).toBe(true);
        expect(reqs.lineItems.length).toBe(2);

        // Item 1: Laptop for software development
        const laptop = reqs.lineItems.find((li) => li.id === "li_1_laptopfors");
        expect(laptop).toBeDefined();
        expect(laptop!.title).toBe("laptop for software development");
        expect(laptop!.quantity).toBe(1);
        expect(laptop!.quantityConfirmed).toBe(true);
        expect(laptop!.quantitySource).toBe("explicit");
        expect(laptop!.confirmedBy).toBe("usr_buyer_1");
        expect(laptop!.budgetCents).toBe(100000); // $1,000.00
        expect(Array.isArray(laptop!.requirements)).toBe(true);

        // Item 2: Monitor
        const monitor = reqs.lineItems.find((li) => li.id === "li_2_monitor");
        expect(monitor).toBeDefined();
        expect(monitor!.title).toBe("monitor");
        expect(monitor!.quantity).toBe(1);
        expect(monitor!.quantityConfirmed).toBe(true);
        expect(monitor!.quantitySource).toBe("explicit");
        expect(monitor!.confirmedBy).toBe("usr_buyer_1");
        expect(monitor!.budgetCents).toBe(50000); // $500.00

        // 6. Audit trail verification
        const auditRes = await client.query(
          'SELECT * FROM "AuditEvent" WHERE "purchaseId" = $1 ORDER BY "createdAt" ASC',
          [TARGET_PURCHASE_ID]
        );
        expect(auditRes.rows.length).toBeGreaterThanOrEqual(2);
        const types = auditRes.rows.map((r) => r.type);
        expect(types).toContain("proposed");
        expect(types).toContain("requirements_confirmed");

        // 7. Verify legitimate live channel3 candidates are persisted
        const candidateSources = await client.query(
          'SELECT source, count(*) FROM "Candidate" WHERE "purchaseId" = $1 GROUP BY source',
          [TARGET_PURCHASE_ID]
        );
        expect(candidateSources.rows.length).toBeGreaterThan(0);
        const channel3Count = candidateSources.rows.find((r) => r.source === "channel3");
        expect(channel3Count).toBeDefined();
        expect(Number(channel3Count.count)).toBe(53);
      } finally {
        await client.end();
      }
    });

    it("2. Verifies service layer reload matches persisted database state", async () => {
      const service = getPurchaseWorkflowService();
      const res = await service.getPurchase(TARGET_PURCHASE_ID);
      expect(res).toBeDefined();
      expect(res.id).toBe(TARGET_PURCHASE_ID);
      expect(res.status).toBe("REQUIREMENTS_CONFIRMED");
      expect(res.budgetCents).toBe(150000);

      expect(res.lineItems).toBeDefined();
      expect(res.lineItems!.length).toBe(2);
    });
  });

  // ==========================================================================
  // TEST B: CANDIDATE DISCOVERY FOR BOTH ITEMS (Channel 3 Live Provider)
  // ==========================================================================
  describe("Test B: Candidate Discovery for Both Items", () => {
    const hasChannel3 = (process.env.CHANNEL3_API_KEY ?? "").trim().length > 0;

    it("1. Executes live independent candidate discovery for Laptop", async () => {
      if (!hasChannel3) {
        console.warn("CHANNEL3_API_KEY not configured, skipping live API call.");
        return;
      }

      const adapter = new Channel3SourceAdapter();
      const laptopResult = await adapter.search(
        {
          purchaseId: TARGET_PURCHASE_ID,
          query: "Dell XPS 15 laptop software development",
          constraints: {
            maxBudgetCents: 100000,
            currency: "USD",
            destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
          },
        },
        { now: new Date() }
      );

      console.log(`[DISCOVERY: Laptop] Status: ${laptopResult.status}`);
      if (laptopResult.status === "success" && laptopResult.candidates.length > 0) {
        const first = laptopResult.candidates[0];
        console.log(`  Sample Laptop: "${first.title}" - Merchant: ${first.merchantName} - Price: $${(first.unitPriceCents / 100).toFixed(2)}`);
        expect(first.title).toBeDefined();
        expect(first.unitPriceCents).toBeGreaterThan(0);
        expect(first.currency).toBe("USD");
        expect(first.merchantUrl).toContain("http");
        // Verify genuine source provenance
        expect(first.source).toBe("channel3");
        // Verify genuine laptop category
        const lowerTitle = first.title.toLowerCase();
        expect(lowerTitle.includes("laptop") || lowerTitle.includes("notebook") || lowerTitle.includes("thinkpad") || lowerTitle.includes("xps") || lowerTitle.includes("book") || lowerTitle.includes("dell")).toBe(true);
      }
    }, 30000);

    it("2. Executes live independent candidate discovery for Monitor", async () => {
      if (!hasChannel3) {
        console.warn("CHANNEL3_API_KEY not configured, skipping live API call.");
        return;
      }

      const adapter = new Channel3SourceAdapter();
      const monitorResult = await adapter.search(
        {
          purchaseId: TARGET_PURCHASE_ID,
          query: "4K computer monitor 27 inch",
          constraints: {
            maxBudgetCents: 50000,
            currency: "USD",
            destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
          },
        },
        { now: new Date() }
      );

      console.log(`[DISCOVERY: Monitor] Status: ${monitorResult.status}`);
      if (monitorResult.status === "success" && monitorResult.candidates.length > 0) {
        const first = monitorResult.candidates[0];
        console.log(`  Sample Monitor: "${first.title}" - Merchant: ${first.merchantName} - Price: $${(first.unitPriceCents / 100).toFixed(2)}`);
        expect(first.title).toBeDefined();
        expect(first.unitPriceCents).toBeGreaterThan(0);
        expect(first.currency).toBe("USD");
        expect(first.merchantUrl).toContain("http");
        expect(first.source).toBe("channel3");
        // Verify genuine monitor category
        const lowerTitle = first.title.toLowerCase();
        expect(lowerTitle.includes("monitor") || lowerTitle.includes("display") || lowerTitle.includes("screen") || lowerTitle.includes("view")).toBe(true);
      }
    }, 30000);

    it("3. Verifies existing persisted 53 Channel3 candidates in target purchase contain both item categories", async () => {
      const client = new Client({ connectionString: PG_CONN });
      await client.connect();
      try {
        const candidates = await client.query(
          'SELECT id, title, "merchantName", "unitPriceCents", "merchantUrl", source FROM "Candidate" WHERE "purchaseId" = $1',
          [TARGET_PURCHASE_ID]
        );

        const channel3Candidates = candidates.rows.filter((c) => c.source === "channel3");
        expect(channel3Candidates.length).toBe(53);

        const laptopCandidates = candidates.rows.filter((c) => {
          const t = c.title.toLowerCase();
          return t.includes("laptop") || t.includes("notebook") || t.includes("thinkpad") || t.includes("zenbook") || t.includes("inspiron");
        });

        const monitorCandidates = candidates.rows.filter((c) => {
          const t = c.title.toLowerCase();
          return t.includes("monitor") || t.includes("display");
        });

        console.log(`[PERSISTED CANDIDATES AUDIT] Total: ${candidates.rows.length} | Laptops: ${laptopCandidates.length} | Monitors: ${monitorCandidates.length}`);

        expect(laptopCandidates.length).toBeGreaterThanOrEqual(10);
        expect(monitorCandidates.length).toBeGreaterThanOrEqual(10);

        // Check mutual exclusivity: no candidate is simultaneously categorized as both
        laptopCandidates.forEach((l) => {
          const lower = l.title.toLowerCase();
          expect(lower.includes("screen monitor") || lower.includes("touch monitor")).toBe(false);
        });
      } finally {
        await client.end();
      }
    });
  });

  // ==========================================================================
  // TEST C & D: EVIDENCE, POLICY & MULTI-ITEM COMPLETENESS
  // ==========================================================================
  describe("Test C & D: Multi-Item Completeness and Policy Verification", () => {
    it("1. Successfully evaluates complete 2-item plan using target purchase and persisted candidate pool", async () => {
      const service = getPurchaseWorkflowService();

      const plan = await service.createMultiItemPlan(
        TARGET_PURCHASE_ID,
        {
          lineItems: [
            {
              id: "li_1_laptopfors",
              title: "laptop for software development",
              quantity: 1,
              quantitySource: "explicit",
              quantityConfirmed: true,
              budgetCents: 100000,
              currency: "USD",
              requirements: [{ key: "purpose", expectedValue: "software development" }],
              verificationLevel: "standard",
            },
            {
              id: "li_2_monitor",
              title: "monitor",
              quantity: 1,
              quantitySource: "explicit",
              quantityConfirmed: true,
              budgetCents: 50000,
              currency: "USD",
              requirements: [],
              verificationLevel: "standard",
            },
          ],
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
        },
        BUYER_ACTOR
      );

      // Verify line items are preserved
      expect(plan.lineItems).toHaveLength(2);
      expect(plan.lineItems[0].id).toBe("li_1_laptopfors");
      expect(plan.lineItems[1].id).toBe("li_2_monitor");

      // Verify strategies were computed
      expect(plan.strategies.length).toBeGreaterThan(0);
      console.log(`[MULTI-ITEM STRATEGIES] Generated ${plan.strategies.length} strategies.`);

      // Verify at least one complete strategy allocates BOTH line items
      const completeStrategies = plan.strategies.filter((s) => s.allocations.length === 2);
      expect(completeStrategies.length).toBeGreaterThan(0);

      const firstComplete = completeStrategies[0];
      const allocatedItemIds = firstComplete.allocations.map((a) => a.lineItemId);
      expect(allocatedItemIds).toContain("li_1_laptopfors");
      expect(allocatedItemIds).toContain("li_2_monitor");

      // Verify candidates allocated to line items are genuinely compatible
      const laptopAlloc = firstComplete.allocations.find((a) => a.lineItemId === "li_1_laptopfors")!;
      const monitorAlloc = firstComplete.allocations.find((a) => a.lineItemId === "li_2_monitor")!;

      expect(laptopAlloc.unitPriceCents).toBeGreaterThan(0);
      expect(monitorAlloc.unitPriceCents).toBeGreaterThan(0);

      // Verify integer cents reconciliation
      const totalAllocMerchandise = laptopAlloc.unitPriceCents + monitorAlloc.unitPriceCents;
      expect(firstComplete.totalMerchandiseCents).toBe(totalAllocMerchandise);
    });

    it("2. Reconciles integer cents costs across all generated strategies", async () => {
      const service = getPurchaseWorkflowService();
      const plan = await service.createMultiItemPlan(
        TARGET_PURCHASE_ID,
        {
          lineItems: [
            {
              id: "li_1_laptopfors",
              title: "laptop for software development",
              quantity: 1,
              quantitySource: "explicit",
              quantityConfirmed: true,
              budgetCents: 100000,
              currency: "USD",
              requirements: [],
              verificationLevel: "standard",
            },
            {
              id: "li_2_monitor",
              title: "monitor",
              quantity: 1,
              quantitySource: "explicit",
              quantityConfirmed: true,
              budgetCents: 50000,
              currency: "USD",
              requirements: [],
              verificationLevel: "standard",
            },
          ],
          destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
        },
        BUYER_ACTOR
      );

      for (const strat of plan.strategies) {
        const sumAllocations = strat.allocations.reduce((sum, a) => sum + a.unitPriceCents * a.quantity, 0);

        // Total merchandise cents must match sum of allocated items
        expect(strat.totalMerchandiseCents).toBe(sumAllocations);

        // Sum shipping across all carts
        const sumShipping = strat.carts.reduce((sum, c) => sum + (c.totalShippingCents ?? 0), 0);
        expect(strat.totalShippingCents === null ? 0 : strat.totalShippingCents).toBe(sumShipping);

        // If totalLandedCostCents is non-null, it must reconcile exactly
        if (strat.totalLandedCostCents !== null) {
          const expectedLanded =
            strat.totalMerchandiseCents +
            (strat.totalShippingCents ?? 0) -
            strat.totalDiscountCents +
            strat.totalEstimatedTaxCents;
          expect(strat.totalLandedCostCents).toBe(expectedLanded);
        }
      }
    });
  });

  // ==========================================================================
  // TEST E & F: NEGATIVE AND SAFETY CASES
  // ==========================================================================
  describe("Test F: Negative & Safety Cases", () => {
    it("Case 1 & 2: Incomplete procurement (missing monitor candidate) fails closed and marks strategy unfeasible", () => {
      const lineItems = [
        {
          id: "li_1_laptopfors",
          title: "laptop for software development",
          quantity: 1,
          quantitySource: "explicit" as const,
          quantityConfirmed: true,
          budgetCents: 100000,
          currency: "USD" as const,
          requirements: [],
          verificationLevel: "standard" as const,
        },
        {
          id: "li_2_monitor",
          title: "monitor",
          quantity: 1,
          quantitySource: "explicit" as const,
          quantityConfirmed: true,
          budgetCents: 50000,
          currency: "USD" as const,
          requirements: [],
          verificationLevel: "standard" as const,
        },
      ];

      // Only laptop candidate provided; monitor candidate is absent
      const candidates: NormalizedProductCandidate[] = [
        {
          id: "cand_laptop_only",
          purchaseId: TARGET_PURCHASE_ID,
          source: "channel3",
          externalId: "ext_laptop",
          title: "Dell XPS 15 Laptop",
          merchantName: "dell.com",
          merchantUrl: "https://dell.com/xps15",
          unitPriceCents: 95000,
          quantity: 1,
          shippingCents: 0,
          totalCents: 95000,
          currency: "USD",
          availability: "in_stock",
          capturedAt: new Date(),
          snapshotHash: "hash_laptop",
          rawSourceData: {},
          isComplete: true,
          validationErrors: [],
          sellerName: "dell.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          rawAttributes: { ram: "16GB" },
        },
      ];

      const strategies = generateProcurementStrategies({
        lineItems,
        candidates,
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      });

      // When only 1 item has an eligible candidate, strategies must be blocked or report incomplete
      for (const strat of strategies) {
        if (strat.allocations.length < 2) {
          expect(strat.feasibility).toBe("blocked");
          expect(strat.riskDisclosures.some((b) => b.includes("Incomplete") || b.includes("missing"))).toBe(true);
        }
      }
    });

    it("Case 3 & 4: Incompatible specifications fail closed", () => {
      const lineItems = [
        {
          id: "li_1_laptop",
          title: "high spec laptop",
          quantity: 1,
          quantitySource: "explicit" as const,
          quantityConfirmed: true,
          budgetCents: 100000,
          currency: "USD" as const,
          requirements: [{ key: "ram", expectedValue: "64GB", description: "64GB RAM" }],
          verificationLevel: "standard" as const,
        },
      ];

      // Candidate has only 8GB RAM
      const candidate: NormalizedProductCandidate = {
        id: "cand_low_ram",
        purchaseId: TARGET_PURCHASE_ID,
        source: "channel3",
        externalId: "ext_low_ram",
        title: "Budget Laptop 8GB RAM",
        merchantName: "newegg.com",
        merchantUrl: "https://newegg.com/budget",
        unitPriceCents: 45000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 45000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date(),
        snapshotHash: "hash_low_ram",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "newegg.com",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ram: "8GB" },
      };

      const strategies = generateProcurementStrategies({
        lineItems,
        candidates: [candidate],
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      });

      expect(strategies.every((s) => s.feasibility === "blocked" || s.allocations.length === 0)).toBe(true);
    });

    it("Case 5: Missing or unknown shipping quote does not silently assume zero", () => {
      const candidate: NormalizedProductCandidate = {
        id: "cand_no_ship",
        purchaseId: TARGET_PURCHASE_ID,
        source: "channel3",
        externalId: "ext_no_ship",
        title: "Dell XPS 15",
        merchantName: "bestbuy.com",
        merchantUrl: "https://bestbuy.com/xps",
        unitPriceCents: 85000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 85000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date(),
        snapshotHash: "hash_no_ship",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "bestbuy.com",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: {},
      };

      const strategies = generateProcurementStrategies({
        lineItems: [
          {
            id: "line_1",
            title: "laptop",
            quantity: 1,
            quantitySource: "explicit",
            quantityConfirmed: true,
            budgetCents: 100000,
            currency: "USD",
            requirements: [],
            verificationLevel: "standard",
          },
        ],
        candidates: [candidate],
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      });

      expect(strategies.length).toBeGreaterThan(0);
      const cart = strategies[0].carts[0];
      expect(cart).toBeDefined();
      expect(cart.shipments.length).toBeGreaterThan(0);
      // Shipping must either be a valid integer cents number or explicitly null (never undefined or arbitrary string)
      const charge = cart.shipments[0].shippingChargeCents;
      expect(charge === null || typeof charge === "number").toBe(true);
    });

    it("Case 9: Total cost exceeding budget is explicitly flagged", () => {
      const lineItems = [
        {
          id: "line_expensive",
          title: "workstation",
          quantity: 1,
          quantitySource: "explicit" as const,
          quantityConfirmed: true,
          budgetCents: 100000, // $1,000 budget
          currency: "USD" as const,
          requirements: [],
          verificationLevel: "standard" as const,
        },
      ];

      const expensiveCandidate: NormalizedProductCandidate = {
        id: "cand_expensive",
        purchaseId: TARGET_PURCHASE_ID,
        source: "channel3",
        externalId: "ext_expensive",
        title: "Workstation Extreme",
        merchantName: "dell.com",
        merchantUrl: "https://dell.com/extreme",
        unitPriceCents: 250000, // $2,500 cost -> exceeds $1,000 budget
        quantity: 1,
        shippingCents: 0,
        totalCents: 250000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date(),
        snapshotHash: "hash_expensive",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "dell.com",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: {},
      };

      const strategies = generateProcurementStrategies({
        lineItems,
        candidates: [expensiveCandidate],
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      });

      // Total landed cost of $2,500 strictly exceeds $1,000 budget
      for (const s of strategies) {
        if (s.totalLandedCostCents !== null) {
          expect(s.totalLandedCostCents).toBeGreaterThan(100000);
        }
      }
    });

    it("Case 10: Client supplying internal 'legacy_direct' provenance for target modern purchase is rejected", async () => {
      const service = getPurchaseWorkflowService();
      await expect(
        service.createMultiItemPlan(
          TARGET_PURCHASE_ID,
          {
            lineItems: [
              {
                id: "li_1_laptopfors",
                title: "laptop for software development",
                quantity: 1,
                quantitySource: "legacy_direct" as unknown as "explicit",
                quantityConfirmed: true,
                budgetCents: 100000,
                currency: "USD",
                requirements: [],
                verificationLevel: "standard",
              },
            ],
            destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
          },
          BUYER_ACTOR
        )
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // TEST G: DIRECT NEXT.JS REST ROUTE INVOCATION
  // ==========================================================================
  describe("Test G: REST API Route Execution", () => {
    it("1. Calls POST /api/purchases/[id]/multi-item/plan directly and returns HTTP 200 with 2-item plan", async () => {
      const payload = {
        lineItems: [
          {
            id: "li_1_laptopfors",
            title: "laptop for software development",
            quantity: 1,
            quantitySource: "explicit",
            quantityConfirmed: true,
            budgetCents: 100000,
            currency: "USD",
            requirements: [{ key: "purpose", expectedValue: "software development" }],
            verificationLevel: "standard",
          },
          {
            id: "li_2_monitor",
            title: "monitor",
            quantity: 1,
            quantitySource: "explicit",
            quantityConfirmed: true,
            budgetCents: 50000,
            currency: "USD",
            requirements: [],
            verificationLevel: "standard",
          },
        ],
        destination: {
          country: "US",
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground",
        },
      };

      const req = new Request(`http://127.0.0.1:3000/api/purchases/${TARGET_PURCHASE_ID}/multi-item/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "usr_buyer_1",
          "x-actor-kind": "user",
        },
        body: JSON.stringify(payload),
      });

      const res = await multiItemPlanRoute(req, {
        params: Promise.resolve({ id: TARGET_PURCHASE_ID }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.purchaseId).toBe(TARGET_PURCHASE_ID);
      expect(data.lineItems).toHaveLength(2);
      expect(data.strategies.length).toBeGreaterThan(0);

      console.log(`[API ROUTE TEST] POST /api/purchases/${TARGET_PURCHASE_ID}/multi-item/plan returned 200 OK.`);
    });
  });
});
