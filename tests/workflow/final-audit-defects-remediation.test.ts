import { describe, it, expect } from "vitest";
import {
  evaluateProductSuitability,
  isSoftwareDevelopmentRequest,
  isVintageOrBudgetExplicitlyRequested,
  checkCandidateCompatibility,
  allocateCandidatesToLineItems,
  createCandidateAllocation,
} from "../../lib/discovery/cart/allocation";
import { generateProcurementStrategies } from "../../lib/discovery/cart/strategy-engine";
import {
  isValidSnapshotHash,
  resolveValidSnapshotHash,
  computeSnapshotHash,
} from "../../lib/state/snapshot";
import {
  reconstructCandidateFromRecord,
} from "../../lib/workflow/service";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { ProcurementLineItem } from "../../lib/discovery/cart/types";
import { CandidateRecord, EvidenceItemRecord } from "../../lib/workflow/repository";

describe("DEF-AUD-01: Product Relevance and Hardware Suitability", () => {
  const devLineItem: ProcurementLineItem = {
    id: "item_dev_laptop",
    title: "Laptop for software development",
    quantity: 1,
    budgetCents: 100000,
    currency: "USD",
    requirements: [{ key: "ram", expectedValue: "16GB" }],
    quantitySource: "explicit" as const,
    quantityConfirmed: true,
  };

  const thinkpadP50Candidate: NormalizedProductCandidate = {
    id: "cand_thinkpad_p50",
    purchaseId: "pur_test_01",
    externalId: "ext_thinkpad_p50",
    title: "Lenovo ThinkPad P50 15.6-inch Core i7-6700HQ 16GB RAM 512GB SSD Windows 10 Pro",
    merchantName: "PC Refurbished Outlet",
    merchantUrl: "https://pcoutlet.example.com/p50",
    unitPriceCents: 29900,
    quantity: 1,
    shippingCents: 0,
    totalCents: 29900,
    currency: "USD",
    availability: "in_stock",
    source: "channel3",
    capturedAt: new Date("2026-11-09T10:00:00Z"),
    snapshotHash: "a".repeat(64),
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "PC Refurbished Outlet",
    isDirectRetailerSeller: false,
    isMarketplace: true,
    fulfillmentMethod: "standard_ground",
    rawAttributes: {
      cpu: "Intel Core i7-6700HQ",
      ram: "16GB",
      storage: "512GB SSD",
      os: "Windows 10 Pro",
      releaseYear: 2015,
      condition: "refurbished",
    },
  };

  const modernLaptopCandidate: NormalizedProductCandidate = {
    id: "cand_ideapad_modern",
    purchaseId: "pur_test_01",
    externalId: "ext_ideapad_modern",
    title: "Lenovo IdeaPad Slim 5 16-inch Intel Core Ultra 5 125H 16GB RAM 512GB SSD Windows 11",
    merchantName: "Lenovo Official",
    merchantUrl: "https://lenovo.example.com/ideapad5",
    unitPriceCents: 69900,
    quantity: 1,
    shippingCents: 0,
    totalCents: 69900,
    currency: "USD",
    availability: "in_stock",
    source: "channel3",
    capturedAt: new Date("2026-11-09T10:00:00Z"),
    snapshotHash: "b".repeat(64),
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "Lenovo Official Store",
    isDirectRetailerSeller: true,
    isMarketplace: false,
    fulfillmentMethod: "standard_ground",
    rawAttributes: {
      cpu: "Intel Core Ultra 5 125H",
      ram: "16GB",
      storage: "512GB SSD",
      os: "Windows 11 Home",
      releaseYear: 2024,
      condition: "new",
    },
  };

  it("identifies software development queries deterministically", () => {
    expect(isSoftwareDevelopmentRequest(devLineItem)).toBe(true);
    expect(isSoftwareDevelopmentRequest({ ...devLineItem, title: "I need a coding machine" })).toBe(true);
    expect(isSoftwareDevelopmentRequest({ ...devLineItem, title: "Laptop for general web browsing" })).toBe(false);
  });

  it("marks obsolete 2015 ThinkPad P50 (6th-gen Intel) as unsuitable for modern software development", () => {
    const assessment = evaluateProductSuitability(devLineItem, thinkpadP50Candidate);
    expect(assessment.tier).toBe("unsuitable");
    expect(assessment.disclosures.length).toBeGreaterThan(0);
    expect(assessment.disclosures.some((d) => d.toLowerCase().includes("obsolete") || d.toLowerCase().includes("skylake"))).toBe(true);

    const compat = checkCandidateCompatibility(devLineItem, thinkpadP50Candidate);
    expect(compat.compatible).toBe(false);
    expect(compat.suitability?.tier).toBe("unsuitable");
  });

  it("marks modern 2024 laptop (Intel Core Ultra / 16GB) as compatible", () => {
    const assessment = evaluateProductSuitability(devLineItem, modernLaptopCandidate);
    expect(assessment.tier).toBe("compatible");
    expect(assessment.detectedSpecs.ramGb).toBe(16);

    const compat = checkCandidateCompatibility(devLineItem, modernLaptopCandidate);
    expect(compat.compatible).toBe(true);
    expect(compat.suitability?.tier).toBe("compatible");
  });

  it("never lets lower price override an unsuitable product in candidate allocation", () => {
    // ThinkPad P50 is $299 vs Modern Laptop $699; both are within budget ($1000)
    const result = allocateCandidatesToLineItems([devLineItem], [thinkpadP50Candidate, modernLaptopCandidate]);
    expect(result.unallocatedLineItemIds).toHaveLength(0);
    expect(result.allocations).toHaveLength(1);
    // Modern laptop MUST be allocated despite being higher priced
    expect(result.allocations[0].candidateId).toBe(modernLaptopCandidate.id);
    expect(result.allocations[0].suitability?.tier).toBe("compatible");
  });

  it("evaluates missing CPU-generation evidence as insufficient_evidence", () => {
    const missingCpuCand: NormalizedProductCandidate = {
      ...modernLaptopCandidate,
      id: "cand_no_cpu",
      title: "Laptop 16-inch 16GB RAM 512GB SSD",
      rawAttributes: { ram: "16GB" },
    };
    const assessment = evaluateProductSuitability(devLineItem, missingCpuCand);
    expect(assessment.tier).toBe("insufficient_evidence");
    expect(assessment.disclosures.some((d) => d.toLowerCase().includes("processor") || d.toLowerCase().includes("cpu"))).toBe(true);
  });

  it("evaluates missing RAM evidence as insufficient_evidence", () => {
    const missingRamCand: NormalizedProductCandidate = {
      ...modernLaptopCandidate,
      id: "cand_no_ram",
      title: "Laptop Core i7-13700H 512GB SSD",
      rawAttributes: { cpu: "Intel Core i7-13700H" },
    };
    const assessment = evaluateProductSuitability(devLineItem, missingRamCand);
    expect(assessment.tier).toBe("insufficient_evidence");
    expect(assessment.disclosures.some((d) => d.toLowerCase().includes("ram"))).toBe(true);
  });

  it("evaluates refurbished/used modern laptop as compatible_with_limitations with disclosure", () => {
    const refurbishedModern: NormalizedProductCandidate = {
      ...modernLaptopCandidate,
      id: "cand_refurb_modern",
      rawAttributes: {
        ...modernLaptopCandidate.rawAttributes,
        condition: "refurbished",
      },
    };
    const assessment = evaluateProductSuitability(devLineItem, refurbishedModern);
    expect(assessment.tier).toBe("compatible_with_limitations");
    expect(assessment.disclosures.some((d) => d.toLowerCase().includes("refurbished"))).toBe(true);
  });

  it("does not reject older/budget laptops when explicitly requested by user", () => {
    const explicitVintageLineItem: ProcurementLineItem = {
      ...devLineItem,
      title: "ThinkPad P50 for vintage software testing and legacy experiments",
    };
    expect(isVintageOrBudgetExplicitlyRequested(explicitVintageLineItem)).toBe(true);
    const assessment = evaluateProductSuitability(explicitVintageLineItem, thinkpadP50Candidate);
    expect(assessment.tier).toBe("compatible_with_limitations");
    expect(assessment.disclosures.some((d) => d.toLowerCase().includes("explicit"))).toBe(true);

    const compat = checkCandidateCompatibility(explicitVintageLineItem, thinkpadP50Candidate);
    expect(compat.compatible).toBe(true);
  });

  it("does not apply software-development hardware constraints to ordinary non-development laptops", () => {
    const basicLineItem: ProcurementLineItem = {
      ...devLineItem,
      title: "Basic laptop for checking email and casual browsing",
    };
    expect(isSoftwareDevelopmentRequest(basicLineItem)).toBe(false);
    const assessment = evaluateProductSuitability(basicLineItem, thinkpadP50Candidate);
    // For non-development requests, tier is compatible or compatible_with_limitations, never blocked as unsuitable for development
    expect(assessment.tier).not.toBe("unsuitable");
  });
});

describe("DEF-AUD-02: Seller Classification Integrity", () => {
  const lineItem: ProcurementLineItem = {
    id: "item_laptop",
    title: "Dell XPS 15",
    quantity: 1,
    budgetCents: 150000,
    currency: "USD",
    requirements: [],
    quantitySource: "explicit" as const,
    quantityConfirmed: true,
  };

  const destination = {
    country: "US" as const,
    postalCode: "94103",
    deliveryMethodPreference: "standard_ground" as const,
  };

  it("includes verified first-party retailer in strat_authoritative_first_party", () => {
    const firstPartyCand: NormalizedProductCandidate = {
      id: "cand_fp",
      purchaseId: "pur_seller_01",
      externalId: "ext_fp",
      title: "Dell XPS 15 9530 Core i7 16GB RAM 512GB SSD",
      merchantName: "Dell Official Store",
      merchantUrl: "https://dell.com/xps15",
      unitPriceCents: 129900,
      quantity: 1,
      shippingCents: 0,
      totalCents: 129900,
      currency: "USD",
      availability: "in_stock",
      source: "channel3",
      capturedAt: new Date(),
      snapshotHash: "c".repeat(64),
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "Dell Technologies",
      isDirectRetailerSeller: true,
      isMarketplace: false,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { ram: "16GB" },
    };

    const strategies = generateProcurementStrategies({
      lineItems: [lineItem],
      candidates: [firstPartyCand],
      destination,
      now: new Date(),
    });

    const fpStrat = strategies.find((s) => s.strategyId === "strat_authoritative_first_party");
    expect(fpStrat).toBeDefined();
    expect(fpStrat?.allocations[0].isDirectRetailerSeller).toBe(true);
  });

  it("excludes third-party marketplace sellers from strat_authoritative_first_party", () => {
    const marketplaceCand: NormalizedProductCandidate = {
      id: "cand_mp",
      purchaseId: "pur_seller_02",
      externalId: "ext_mp",
      title: "Dell XPS 15 9530 Core i7 16GB RAM 512GB SSD",
      merchantName: "Electronics Marketplace Hub",
      merchantUrl: "https://market.example.com/xps15",
      unitPriceCents: 119900,
      quantity: 1,
      shippingCents: 0,
      totalCents: 119900,
      currency: "USD",
      availability: "in_stock",
      source: "channel3",
      capturedAt: new Date(),
      snapshotHash: "d".repeat(64),
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "Fast3P Deals",
      isDirectRetailerSeller: false,
      isMarketplace: true,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { ram: "16GB" },
    };

    const strategies = generateProcurementStrategies({
      lineItems: [lineItem],
      candidates: [marketplaceCand],
      destination,
      now: new Date(),
    });

    const fpStrat = strategies.find((s) => s.strategyId === "strat_authoritative_first_party");
    expect(fpStrat).toBeUndefined();
  });

  it("excludes candidates with unknown/unverified seller metadata from strat_authoritative_first_party", () => {
    const unknownCand: NormalizedProductCandidate = {
      id: "cand_unknown",
      purchaseId: "pur_seller_03",
      externalId: "ext_unk",
      title: "Dell XPS 15 9530 Core i7 16GB RAM 512GB SSD",
      merchantName: "Some Merchant",
      merchantUrl: "https://somemerchant.example.com/xps15",
      unitPriceCents: 125000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 125000,
      currency: "USD",
      availability: "in_stock",
      source: "channel3",
      capturedAt: new Date(),
      snapshotHash: "e".repeat(64),
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: undefined,
      isDirectRetailerSeller: undefined,
      isMarketplace: undefined,
      fulfillmentMethod: "standard_ground",
      rawAttributes: { ram: "16GB" },
    };

    const strategies = generateProcurementStrategies({
      lineItems: [lineItem],
      candidates: [unknownCand],
      destination,
      now: new Date(),
    });

    const fpStrat = strategies.find((s) => s.strategyId === "strat_authoritative_first_party");
    expect(fpStrat).toBeUndefined();

    expect(unknownCand.isDirectRetailerSeller).toBeUndefined();
    expect(unknownCand.isMarketplace).toBeUndefined();
  });

  it("reconstructs candidate from persisted database record preserving verified seller evidence", () => {
    const candRecord: CandidateRecord = {
      id: "cand_persisted_fp",
      purchaseId: "pur_persist_01",
      source: "channel3",
      externalId: "ext_persist_01",
      title: "Dell XPS 15 9530 Core i7 16GB",
      merchantName: "Dell Official",
      merchantUrl: "https://dell.com",
      unitPriceCents: 129900,
      quantity: 1,
      shippingCents: 0,
      totalCents: 129900,
      currency: "USD",
      availability: "in_stock",
      capturedAt: new Date(),
      snapshotHash: "f".repeat(64),
    };

    const sellerEvidence: EvidenceItemRecord = {
      id: "ev_seller_01",
      candidateId: "cand_persisted_fp",
      requirementKey: "seller_metadata",
      value: JSON.stringify({
        isDirectRetailerSeller: true,
        isMarketplace: false,
        sellerName: "Dell Official Retail",
        fulfillmentMethod: "next_day_air",
      }),
      sourceUrl: "https://dell.com",
      sourceType: "channel3_offer_seller",
      capturedAt: new Date(),
      status: "supports",
    };

    const reconstructed = reconstructCandidateFromRecord(candRecord, [sellerEvidence]);
    expect(reconstructed.isDirectRetailerSeller).toBe(true);
    expect(reconstructed.isMarketplace).toBe(false);
    expect(reconstructed.sellerName).toBe("Dell Official Retail");
    expect(reconstructed.fulfillmentMethod).toBe("next_day_air");
  });

  it("leaves seller classification undefined (unverified) when persisted candidate lacks seller evidence", () => {
    const candRecord: CandidateRecord = {
      id: "cand_persisted_no_ev",
      purchaseId: "pur_persist_02",
      source: "seeded",
      externalId: "ext_persist_02",
      title: "Dell XPS 15 9530 Core i7 16GB",
      merchantName: "Unknown Reseller",
      merchantUrl: "https://unknown.example.com",
      unitPriceCents: 110000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 110000,
      currency: "USD",
      availability: "in_stock",
      capturedAt: new Date(),
      snapshotHash: "0".repeat(64),
    };

    const reconstructed = reconstructCandidateFromRecord(candRecord, []);
    expect(reconstructed.isDirectRetailerSeller).toBeUndefined();
    expect(reconstructed.isMarketplace).toBeUndefined();
  });
});

describe("DEF-AUD-03: Snapshot Hash Integrity", () => {
  const candidateInput = {
    id: "cand_hash_test",
    purchaseId: "pur_hash_test",
    source: "channel3" as const,
    externalId: "ext_hash_test",
    title: "Test Laptop Core i7",
    merchantName: "Test Merchant",
    merchantUrl: "https://merchant.example.com",
    unitPriceCents: 100000,
    quantity: 1,
    shippingCents: 1500,
    totalCents: 101500,
    currency: "USD",
    availability: "in_stock",
  };

  const expectedCanonicalHash = computeSnapshotHash(candidateInput);

  it("validates 64-hex format and rejects whitespace-padded strings", () => {
    expect(isValidSnapshotHash("a".repeat(64))).toBe(true);
    expect(isValidSnapshotHash("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef")).toBe(true);

    // Rejections
    expect(isValidSnapshotHash(null)).toBe(false);
    expect(isValidSnapshotHash(undefined)).toBe(false);
    expect(isValidSnapshotHash("")).toBe(false);
    expect(isValidSnapshotHash("   ")).toBe(false);
    expect(isValidSnapshotHash(" ".repeat(64))).toBe(false); // PostgreSQL CHAR(64) spaces
    expect(isValidSnapshotHash("not-a-hex-hash")).toBe(false);
    expect(isValidSnapshotHash("a".repeat(63))).toBe(false); // Short
    expect(isValidSnapshotHash("a".repeat(65))).toBe(false); // Long
    expect(isValidSnapshotHash("g".repeat(64))).toBe(false); // Non-hex
  });

  it("recomputes canonical hash when raw hash is null or undefined", () => {
    expect(resolveValidSnapshotHash(null, candidateInput)).toBe(expectedCanonicalHash);
    expect(resolveValidSnapshotHash(undefined, candidateInput)).toBe(expectedCanonicalHash);
  });

  it("recomputes canonical hash when raw hash is an empty string", () => {
    expect(resolveValidSnapshotHash("", candidateInput)).toBe(expectedCanonicalHash);
  });

  it("recomputes canonical hash when raw hash is a 64-space string (PostgreSQL CHAR padding)", () => {
    const paddedChar64 = " ".repeat(64);
    expect(resolveValidSnapshotHash(paddedChar64, candidateInput)).toBe(expectedCanonicalHash);
  });

  it("recomputes canonical hash when raw hash is malformed non-empty text", () => {
    expect(resolveValidSnapshotHash("invalid-hash-value-12345", candidateInput)).toBe(expectedCanonicalHash);
  });

  it("preserves legitimate historical 64-hex hash without recomputation", () => {
    const historicalHash = "f4c935d21a8b7e0c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c";
    expect(resolveValidSnapshotHash(historicalHash, candidateInput)).toBe(historicalHash);
  });

  it("produces deterministic, stable canonical hash across repeated invocations", () => {
    const hash1 = resolveValidSnapshotHash(null, candidateInput);
    const hash2 = resolveValidSnapshotHash(" ".repeat(64), candidateInput);
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(expectedCanonicalHash);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});
