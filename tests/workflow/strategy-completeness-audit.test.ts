/**
 * Plinthly Phase 15 & Action 3 — Strategy Completeness & Mandatory Line-Item Coverage Audit.
 *
 * Verifies Acceptance Invariants:
 * 1. A strategy omitting the most expensive mandatory item must never receive FEASIBLE status.
 * 2. A strategy allocating only two of three requested items must be marked blocked/incomplete.
 * 3. Partial quantity allocations (allocated < requested) must be rejected fail-closed.
 * 4. Duplicate allocation of a single candidate across distinct items is rejected.
 * 5. Complete allocation across multiple retailers is verified complete and feasible.
 * 6. A valid complete strategy ($2,010 or $2,000) always ranks ahead of an incomplete strategy ($690)
 *    regardless of reported price.
 */

import { describe, it, expect } from "vitest";
import {
  validateStrategyCompleteness,
  assertStrategyCompleteness,
} from "../../lib/discovery/cart/completeness-validator";
import {
  buildStrategyFromAllocations,
  generateProcurementStrategies,
  compareStrategiesDefensively,
  getStrategyTier,
} from "../../lib/discovery/cart/strategy-engine";
import {
  checkCandidateCompatibility,
  allocateCandidatesToLineItems,
  getProductClassification,
} from "../../lib/discovery/cart/allocation";
import {
  ProcurementLineItem,
  ProcurementStrategy,
  LineItemCandidateAllocation,
} from "../../lib/discovery/cart/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { DestinationContext } from "../../lib/discovery/shipping";

describe("Plinthly Strategy Completeness & Line-Item Coverage Audit", () => {
  const oregonDestination: DestinationContext = {
    country: "US",
    postalCode: "97201",
    deliveryMethodPreference: "standard_ground",
  };

  const sampleLaptopItem: ProcurementLineItem = {
    id: "line_laptop",
    title: "Dell XPS 15 Laptop (32GB RAM)",
    currency: "USD",
    quantity: 1,
    budgetCents: 150000,
    requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
    verificationLevel: "standard",
    quantitySource: "explicit",
  };

  const sampleMonitorItem: ProcurementLineItem = {
    id: "line_monitor",
    title: "Dell UltraSharp 27 4K Monitor",
    currency: "USD",
    quantity: 1,
    budgetCents: 40000,
    requirements: [{ key: "resolution", expectedValue: "4K", description: "4K Resolution" }],
    verificationLevel: "standard",
    quantitySource: "explicit",
  };

  const sampleDockItem: ProcurementLineItem = {
    id: "line_dock",
    title: "USB-C Dual 4K Docking Station",
    currency: "USD",
    quantity: 1,
    budgetCents: 15000,
    requirements: [{ key: "ports", expectedValue: "Dual HDMI/DP", description: "Dual DisplayPort" }],
    verificationLevel: "standard",
    quantitySource: "explicit",
  };

  const threeLineItems = [sampleLaptopItem, sampleMonitorItem, sampleDockItem];

  const candidateLaptopBB: NormalizedProductCandidate = {
    id: "cand_laptop_bb",
    purchaseId: "pur_test_audit",
    externalId: "bb_laptop_001",
    title: "Dell XPS 15 Laptop (32GB RAM)",
    merchantName: "Best Buy",
    merchantUrl: "https://www.bestbuy.com/site/laptop",
    unitPriceCents: 146000,
    quantity: 1,
    shippingCents: 0,
    totalCents: 146000,
    currency: "USD",
    availability: "in_stock",
    source: "seeded",
    capturedAt: new Date(),
    snapshotHash: "hash_laptop",
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "Best Buy",
    isMarketplace: false,
    isDirectRetailerSeller: true,
    fulfillmentMethod: "standard_ground",
    rawAttributes: { ram: "32GB" },
  };

  const candidateMonitorBB: NormalizedProductCandidate = {
    id: "cand_monitor_bb",
    purchaseId: "pur_test_audit",
    externalId: "bb_monitor_002",
    title: "Dell UltraSharp 27 4K Monitor",
    merchantName: "Best Buy",
    merchantUrl: "https://www.bestbuy.com/site/monitor",
    unitPriceCents: 40000,
    quantity: 1,
    shippingCents: 0,
    totalCents: 40000,
    currency: "USD",
    availability: "in_stock",
    source: "seeded",
    capturedAt: new Date(),
    snapshotHash: "hash_monitor",
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "Best Buy",
    isMarketplace: false,
    isDirectRetailerSeller: true,
    fulfillmentMethod: "standard_ground",
    rawAttributes: { resolution: "4K" },
  };

  const candidateDockBB: NormalizedProductCandidate = {
    id: "cand_dock_bb",
    purchaseId: "pur_test_audit",
    externalId: "bb_dock_003",
    title: "USB-C Dual 4K Docking Station",
    merchantName: "Best Buy",
    merchantUrl: "https://www.bestbuy.com/site/dock",
    unitPriceCents: 15000,
    quantity: 1,
    shippingCents: 0,
    totalCents: 15000,
    currency: "USD",
    availability: "in_stock",
    source: "seeded",
    capturedAt: new Date(),
    snapshotHash: "hash_dock_bb",
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "Best Buy",
    isMarketplace: false,
    isDirectRetailerSeller: true,
    fulfillmentMethod: "standard_ground",
    rawAttributes: { ports: "Dual HDMI/DP" },
  };

  const candidateDockBH: NormalizedProductCandidate = {
    id: "cand_dock_bh",
    purchaseId: "pur_test_audit",
    externalId: "bh_dock_004",
    title: "B&H USB-C Dual Dock",
    merchantName: "B&H Photo Video",
    merchantUrl: "https://www.bhphotovideo.com/c/dock",
    unitPriceCents: 14000,
    quantity: 1,
    shippingCents: 0,
    totalCents: 14000,
    currency: "USD",
    availability: "in_stock",
    source: "seeded",
    capturedAt: new Date(),
    snapshotHash: "hash_dock_bh",
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "B&H Photo Video",
    isMarketplace: false,
    isDirectRetailerSeller: true,
    fulfillmentMethod: "standard_ground",
    rawAttributes: { ports: "Dual HDMI/DP" },
  };

  describe("Product Category Classification & Hard Compatibility Gate", () => {
    it("correctly identifies product classifications from title", () => {
      expect(getProductClassification("Dell XPS 15 Laptop (32GB RAM)")).toBe("laptop");
      expect(getProductClassification("Dell UltraSharp 27 4K Monitor")).toBe("monitor");
      expect(getProductClassification("USB-C Dual 4K Docking Station")).toBe("dock");
      expect(getProductClassification("B&H USB-C Dual Dock")).toBe("dock");
      expect(getProductClassification("Dell Universal Laptop Docking Station")).toBe("dock");
    });

    it("strictly rejects allocating a docking station to a laptop line item", () => {
      const compat = checkCandidateCompatibility(sampleLaptopItem, candidateDockBH);
      expect(compat.compatible).toBe(false);
      expect(compat.contradictorySpecs.some((s) => s.includes("category contradiction"))).toBe(true);
    });

    it("strictly rejects allocating a monitor to a docking station line item", () => {
      const compat = checkCandidateCompatibility(sampleDockItem, candidateMonitorBB);
      expect(compat.compatible).toBe(false);
      expect(compat.contradictorySpecs.some((s) => s.includes("category contradiction"))).toBe(true);
    });

    it("strictly rejects allocating a laptop to a monitor line item", () => {
      const compat = checkCandidateCompatibility(sampleMonitorItem, candidateLaptopBB);
      expect(compat.compatible).toBe(false);
      expect(compat.contradictorySpecs.some((s) => s.includes("category contradiction"))).toBe(true);
    });
  });

  describe("Centralized Strategy Completeness Validator", () => {
    it("1. Strategy omitting the most expensive mandatory item (laptop) is never marked FEASIBLE", () => {
      // Allocate only monitor ($400) and dock ($140) => $540 or $690
      const incompleteResult = allocateCandidatesToLineItems(
        threeLineItems,
        [candidateMonitorBB, candidateDockBH]
      );
      expect(incompleteResult.allocations.length).toBe(2);
      expect(incompleteResult.unallocatedLineItemIds).toContain("line_laptop");

      const strategy = buildStrategyFromAllocations(
        "strat_incomplete_missing_laptop",
        "Incomplete Missing Laptop",
        "Only allocated monitor and dock",
        incompleteResult.allocations,
        threeLineItems,
        oregonDestination
      );

      const report = validateStrategyCompleteness(strategy, threeLineItems);
      expect(report.isComplete).toBe(false);
      expect(report.missingLineItemIds).toContain("line_laptop");

      // Invariant: Missing mandatory item must NEVER receive FEASIBLE status
      expect(strategy.feasibility).toBe("blocked");
      expect(strategy.feasibility).not.toBe("feasible");
      expect(strategy.isLandedCostDefensible).toBe(false);
      expect(strategy.totalLandedCostCents).toBeNull();
      expect(getStrategyTier(strategy)).toBe(4);
    });

    it("2. Strategy allocating only two of three requested items is marked blocked", () => {
      // Allocate only laptop ($1,460) and monitor ($400) => missing dock
      const incompleteResult = allocateCandidatesToLineItems(
        threeLineItems,
        [candidateLaptopBB, candidateMonitorBB]
      );
      expect(incompleteResult.allocations.length).toBe(2);
      expect(incompleteResult.unallocatedLineItemIds).toContain("line_dock");

      const strategy = buildStrategyFromAllocations(
        "strat_missing_dock",
        "Missing Dock",
        "Allocated laptop and monitor only",
        incompleteResult.allocations,
        threeLineItems,
        oregonDestination
      );

      expect(strategy.feasibility).toBe("blocked");
      expect(strategy.isLandedCostDefensible).toBe(false);
      expect(strategy.totalLandedCostCents).toBeNull();
    });

    it("3. Partial quantity allocation (allocated < requested) is strictly rejected", () => {
      const multiQuantityMonitorItem: ProcurementLineItem = {
        ...sampleMonitorItem,
        quantity: 2, // Requested 2 monitors
      };

      const result = allocateCandidatesToLineItems(
        [multiQuantityMonitorItem],
        [candidateMonitorBB] // Only 1 candidate allocated
      );

      // Mutate allocation to have quantity 1 (partial)
      const partialAllocation: LineItemCandidateAllocation = {
        ...result.allocations[0],
        quantity: 1, // Allocated 1 of 2
      };

      const strategy = buildStrategyFromAllocations(
        "strat_partial_quantity",
        "Partial Quantity Strategy",
        "Only fulfilled 1 of 2 monitors",
        [partialAllocation],
        [multiQuantityMonitorItem],
        oregonDestination
      );

      const report = validateStrategyCompleteness(strategy, [multiQuantityMonitorItem]);
      expect(report.isComplete).toBe(false);
      expect(report.quantityDiscrepancies.some((q) => q.status === "partial")).toBe(true);
      expect(strategy.feasibility).toBe("blocked");
      expect(strategy.isLandedCostDefensible).toBe(false);
      expect(strategy.totalLandedCostCents).toBeNull();
    });

    it("4. Duplicate allocation of a single candidate across distinct items is rejected", () => {
      // Forged strategy that duplicates dock to satisfy both dock and monitor
      const allocDock1: LineItemCandidateAllocation = {
        lineItemId: "line_dock",
        candidateId: candidateDockBB.id,
        externalId: candidateDockBB.externalId,
        title: candidateDockBB.title,
        merchantName: candidateDockBB.merchantName,
        merchantUrl: candidateDockBB.merchantUrl,
        unitPriceCents: candidateDockBB.unitPriceCents,
        quantity: 1,
        currency: "USD",
        availability: "in_stock",
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        isWfsFulfilled: false,
        fulfillmentMethod: "standard_ground",
        requiresSpecialDelivery: false,
        snapshotHash: "hash1",
        capturedAt: new Date().toISOString(),
        authenticity: {
          sellerName: "Best Buy",
          isDirectRetailerSeller: true,
          isMarketplace: false,
          isManufacturerAuthorized: false,
          authorizationEvidence: null,
          isProductAuthenticVerified: false,
          authenticityEvidence: null,
          warrantyCoverage: "unverified",
          warrantyEvidence: null,
          evidenceTier: "unknown",
        },
        matchedSpecs: ["ports"],
        contradictorySpecs: [],
        missingSpecs: [],
      };

      const allocDockForgedMonitor: LineItemCandidateAllocation = {
        ...allocDock1,
        lineItemId: "line_monitor", // Forged duplicate
      };

      const strategy = buildStrategyFromAllocations(
        "strat_duplicate_candidate",
        "Duplicate Candidate Strat",
        "Same candidate assigned to multiple items",
        [allocDock1, allocDockForgedMonitor],
        [sampleDockItem, sampleMonitorItem],
        oregonDestination
      );

      const report = validateStrategyCompleteness(strategy, [sampleDockItem, sampleMonitorItem]);
      expect(report.isComplete).toBe(false);
      expect(report.duplicateAllocations.length).toBeGreaterThan(0);
      expect(strategy.feasibility).toBe("blocked");
    });

    it("5. Complete allocation across multiple retailers is verified complete and feasible", () => {
      const fullCandidates = [
        candidateLaptopBB, // Best Buy ($1,460)
        candidateMonitorBB, // Best Buy ($400)
        candidateDockBH, // B&H Photo Video ($140)
      ];

      const strategies = generateProcurementStrategies({
        lineItems: threeLineItems,
        candidates: fullCandidates,
        destination: oregonDestination,
      });

      expect(strategies.length).toBeGreaterThan(0);
      const lowestCostStrat = strategies.find((s) => s.strategyId === "strat_lowest_landed_cost");
      expect(lowestCostStrat).toBeDefined();

      // Verify all 3 line items are present
      expect(lowestCostStrat!.allocations.length).toBe(3);
      const allocatedIds = lowestCostStrat!.allocations.map((a) => a.lineItemId);
      expect(allocatedIds).toContain("line_laptop");
      expect(allocatedIds).toContain("line_monitor");
      expect(allocatedIds).toContain("line_dock");

      // Verify exact integer costs: $1,460 + $400 + $140 = $2,000.00
      expect(lowestCostStrat!.totalMerchandiseCents).toBe(200000);
      expect(lowestCostStrat!.retailerCount).toBe(2); // Best Buy + B&H Photo Video
      expect(lowestCostStrat!.feasibility).toBe("feasible");
      expect(lowestCostStrat!.isLandedCostDefensible).toBe(true);

      const report = validateStrategyCompleteness(lowestCostStrat!, threeLineItems);
      expect(report.isComplete).toBe(true);
      expect(report.errors).toHaveLength(0);
    });

    it("6. A valid complete strategy with a higher cost always outranks an incomplete cheaper strategy", () => {
      // Complete strategy: Best Buy Consolidated ($2,010.00 USD)
      const completeAllBB = allocateCandidatesToLineItems(
        threeLineItems,
        [candidateLaptopBB, candidateMonitorBB, candidateDockBB]
      );
      const completeStrategy = buildStrategyFromAllocations(
        "strat_complete_consolidated",
        "Consolidated Complete",
        "All 3 items from Best Buy",
        completeAllBB.allocations,
        threeLineItems,
        oregonDestination
      );

      expect(completeStrategy.feasibility).toBe("feasible");
      expect(completeStrategy.totalMerchandiseCents).toBe(201000);
      expect(getStrategyTier(completeStrategy)).toBe(1);

      // Incomplete strategy: omitting laptop ($400 + $140 = $540 or $690)
      const incompleteAllBH = allocateCandidatesToLineItems(
        threeLineItems,
        [candidateMonitorBB, candidateDockBH]
      );
      const incompleteStrategy = buildStrategyFromAllocations(
        "strat_incomplete_cheaper",
        "Incomplete Cheaper",
        "Omitted laptop, only $540",
        incompleteAllBH.allocations,
        threeLineItems,
        oregonDestination
      );

      expect(incompleteStrategy.feasibility).toBe("blocked");
      expect(getStrategyTier(incompleteStrategy)).toBe(4);

      // Defensive comparator: Complete Strategy (Tier 1) MUST rank before Incomplete Strategy (Tier 4)
      const comparison = compareStrategiesDefensively(completeStrategy, incompleteStrategy);
      expect(comparison).toBeLessThan(0); // completeStrategy < incompleteStrategy (complete ranks first)

      const reverseComparison = compareStrategiesDefensively(incompleteStrategy, completeStrategy);
      expect(reverseComparison).toBeGreaterThan(0); // incompleteStrategy ranks after complete
    });
  });
});

