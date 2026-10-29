import { describe, it, expect } from "vitest";
import { normalizeCandidate, parseCentsExact, validateUrl } from "../../lib/discovery/normalize";
import { RawDiscoveredCandidate } from "../../lib/discovery/types";

describe("Phase 3 Candidate Normalization and Validation", () => {
  const baseRaw: RawDiscoveredCandidate = {
    externalId: "PROD-101",
    title: "Ergonomic Mechanical Keyboard",
    merchantName: "Keycaps Depot",
    merchantUrl: "https://keycapsdepot.example.com/item/101",
    unitPrice: "89.99",
    shipping: "10.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:00:00.000Z",
  };

  const testContext = {
    purchaseId: "purch_test_123",
    source: "channel3" as const,
    now: new Date("2026-10-20T12:30:00.000Z"),
    candidateId: "cand_test_123",
  };

  it("normalizes a valid candidate with accurate decimal conversion and snapshot hash", () => {
    const candidate = normalizeCandidate(baseRaw, testContext);

    expect(candidate.isComplete).toBe(true);
    expect(candidate.validationErrors).toEqual([]);
    expect(candidate.id).toBe("cand_test_123");
    expect(candidate.purchaseId).toBe("purch_test_123");
    expect(candidate.externalId).toBe("PROD-101");
    expect(candidate.title).toBe("Ergonomic Mechanical Keyboard");
    expect(candidate.merchantName).toBe("Keycaps Depot");
    expect(candidate.merchantUrl).toBe("https://keycapsdepot.example.com/item/101");
    expect(candidate.unitPriceCents).toBe(8999);
    expect(candidate.shippingCents).toBe(1000);
    expect(candidate.quantity).toBe(1);
    expect(candidate.totalCents).toBe(9999);
    expect(candidate.currency).toBe("USD");
    expect(candidate.availability).toBe("in_stock");
    expect(candidate.snapshotHash).toHaveLength(64);
    expect(candidate.rawSourceData).toMatchObject(baseRaw);
  });

  describe("URL validation and protocol enforcement", () => {
    it("accepts valid https and http URLs", () => {
      const httpsCheck = validateUrl("https://store.example.com/product/1");
      expect(httpsCheck.valid).toBe(true);
      expect(httpsCheck.normalized).toBe("https://store.example.com/product/1");

      const httpCheck = validateUrl("http://store.example.com/product/1");
      expect(httpCheck.valid).toBe(true);
    });

    it("rejects non-http protocols (ftp, javascript, data, file)", () => {
      expect(validateUrl("ftp://files.example.com/p").valid).toBe(false);
      expect(validateUrl("javascript:alert(1)").valid).toBe(false);
      expect(validateUrl("data:text/html,test").valid).toBe(false);
      expect(validateUrl("file:///etc/passwd").valid).toBe(false);
    });

    it("rejects empty, unparseable, or hostname-less URLs", () => {
      expect(validateUrl("").valid).toBe(false);
      expect(validateUrl("not a url").valid).toBe(false);
      expect(validateUrl(null).valid).toBe(false);
      expect(validateUrl(undefined).valid).toBe(false);
    });
  });

  describe("Monetary parsing without floating-point arithmetic", () => {
    it("parses valid integer cents correctly", () => {
      const res = parseCentsExact(4999, "unitPrice");
      expect(res.valid).toBe(true);
      expect(res.cents).toBe(4999);
    });

    it("parses exact decimal strings without float errors", () => {
      expect(parseCentsExact("29.99", "price").cents).toBe(2999);
      expect(parseCentsExact("$29.99", "price").cents).toBe(2999);
      expect(parseCentsExact("0.50", "price").cents).toBe(50);
      expect(parseCentsExact("0.5", "price").cents).toBe(50);
      expect(parseCentsExact("100", "price").cents).toBe(10000);
      expect(parseCentsExact("0", "shipping").cents).toBe(0);
    });

    it("strictly rejects floating-point numbers to prevent IEEE 754 precision loss", () => {
      const res = parseCentsExact(29.99, "price");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Floating-point arithmetic is forbidden");
    });

    it("rejects negative numbers, scientific notation, and malformed strings", () => {
      expect(parseCentsExact(-50, "price").valid).toBe(false);
      expect(parseCentsExact("-29.99", "price").valid).toBe(false);
      expect(parseCentsExact("1e3", "price").valid).toBe(false);
      expect(parseCentsExact("29.999", "price").valid).toBe(false); // 3 decimals
      expect(parseCentsExact("free", "shipping").valid).toBe(false);
      expect(parseCentsExact("", "price").valid).toBe(false);
      expect(parseCentsExact(null, "price").valid).toBe(false);
    });

    it("accepts MAX_CENTS boundary and rejects MAX_CENTS + 1", () => {
      // MAX_CENTS = 2147483647
      const maxInt = parseCentsExact(2147483647, "unitPrice");
      expect(maxInt.valid).toBe(true);
      expect(maxInt.cents).toBe(2147483647);

      const overMaxInt = parseCentsExact(2147483648, "unitPrice");
      expect(overMaxInt.valid).toBe(false);
      expect(overMaxInt.error).toContain("exceeds maximum allowable cents");

      const maxDecimalStr = parseCentsExact("21474836.47", "unitPrice");
      expect(maxDecimalStr.valid).toBe(true);
      expect(maxDecimalStr.cents).toBe(2147483647);

      const overMaxDecimalStr = parseCentsExact("21474836.48", "unitPrice");
      expect(overMaxDecimalStr.valid).toBe(false);
      expect(overMaxDecimalStr.error).toContain("exceeds maximum allowable cents");
    });
  });

  describe("Currency preservation", () => {
    it("rejects non-USD currencies", () => {
      const candidate = normalizeCandidate(
        { ...baseRaw, currency: "EUR" },
        testContext
      );
      expect(candidate.isComplete).toBe(false);
      expect(candidate.validationErrors.some((e) => e.includes("Unsupported currency \"EUR\""))).toBe(true);
    });

    it("rejects missing currency", () => {
      const candidate = normalizeCandidate(
        { ...baseRaw, currency: undefined },
        testContext
      );
      expect(candidate.isComplete).toBe(false);
      expect(candidate.validationErrors.some((e) => e.includes("Missing currency"))).toBe(true);
    });
  });

  describe("Required fields and incomplete candidate handling", () => {
    it("rejects missing externalId", () => {
      const candidate = normalizeCandidate(
        { ...baseRaw, externalId: "" },
        testContext
      );
      expect(candidate.isComplete).toBe(false);
      expect(candidate.validationErrors.some((e) => e.includes("externalId"))).toBe(true);
    });

    it("rejects missing title or merchantName", () => {
      const noTitle = normalizeCandidate({ ...baseRaw, title: "   " }, testContext);
      expect(noTitle.isComplete).toBe(false);
      expect(noTitle.validationErrors.some((e) => e.includes("title"))).toBe(true);

      const noMerchant = normalizeCandidate({ ...baseRaw, merchantName: "" }, testContext);
      expect(noMerchant.isComplete).toBe(false);
      expect(noMerchant.validationErrors.some((e) => e.includes("merchantName"))).toBe(true);
    });

    it("does not infer free shipping when shipping is omitted", () => {
      const noShipping = normalizeCandidate(
        { ...baseRaw, shipping: undefined, shippingCents: undefined },
        testContext
      );
      expect(noShipping.isComplete).toBe(false);
      expect(noShipping.validationErrors.some((e) => e.includes("Shipping cannot be inferred as zero"))).toBe(true);
    });

    it("does not infer in_stock availability when availability is omitted", () => {
      const noAvail = normalizeCandidate(
        { ...baseRaw, availability: undefined },
        testContext
      );
      expect(noAvail.isComplete).toBe(false);
      expect(noAvail.validationErrors.some((e) => e.includes("Availability cannot be inferred"))).toBe(true);
    });
  });

  describe("Whitespace normalization and provenance retention", () => {
    it("trims and normalizes whitespace while retaining raw source data", () => {
      const candidate = normalizeCandidate(
        {
          ...baseRaw,
          title: "  Ergonomic   High-Back   Chair  ",
          merchantName: "  Office   World  ",
        },
        testContext
      );

      expect(candidate.title).toBe("Ergonomic High-Back Chair");
      expect(candidate.merchantName).toBe("Office World");
      expect(candidate.rawSourceData.title).toBe("  Ergonomic   High-Back   Chair  ");
      expect(candidate.rawSourceData.merchantName).toBe("  Office   World  ");
    });
  });

  describe("Snapshot hash determinism", () => {
    it("produces identical snapshot hashes for equivalent normalized candidates", () => {
      const candA = normalizeCandidate(baseRaw, testContext);
      const candB = normalizeCandidate(
        {
          ...baseRaw,
          unitPriceCents: 8999, // integer cents equivalent to "89.99"
          shippingCents: 1000,
        },
        { ...testContext, candidateId: "cand_different_uuid" } // UUID does not affect snapshot hash
      );

      expect(candA.snapshotHash).toBe(candB.snapshotHash);
    });

    it("changes snapshot hash when commercial attributes change", () => {
      const candA = normalizeCandidate(baseRaw, testContext);
      const candPriceChanged = normalizeCandidate(
        { ...baseRaw, unitPrice: "94.99" },
        testContext
      );
      const candShippingChanged = normalizeCandidate(
        { ...baseRaw, shipping: "12.00" },
        testContext
      );

      expect(candA.snapshotHash).not.toBe(candPriceChanged.snapshotHash);
      expect(candA.snapshotHash).not.toBe(candShippingChanged.snapshotHash);
    });
  });
});
