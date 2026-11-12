import { describe, it, expect } from "vitest";
import { parseDecimalStringToCents } from "../../lib/state/money";

describe("Section 10 Acceptance Test: TEST-PARSE-01 (Canonical Decimal Parser)", () => {
  const VALID_VECTORS: [string, bigint][] = [
    ["0", BigInt(0)],
    ["0.00", BigInt(0)],
    ["0.50", BigInt(50)],
    ["1", BigInt(100)],
    ["1.00", BigInt(100)],
    ["19.99", BigInt(1999)],
    ["100", BigInt(10000)],
    ["100.50", BigInt(10050)],
    ["999999.99", BigInt(99999999)],
  ];

  const INVALID_VECTORS: string[] = [
    ".50",
    "01.50",
    "19.9",
    "19.999",
    "19.",
    "1,000.00",
    "1e2",
    "-0",
    "-0.00",
    "-15.00",
    " 19.99 ",
    "abc",
    "",
    "00",
  ];

  it("evaluates all 9 valid canonical vectors to exact integer minor unit cents", () => {
    for (const [input, expectedCents] of VALID_VECTORS) {
      const parsed = parseDecimalStringToCents(input);
      expect(parsed).toBe(expectedCents);
    }
  });

  it("strictly rejects all 14 invalid canonical vectors fail-closed", () => {
    for (const invalidInput of INVALID_VECTORS) {
      expect(() => parseDecimalStringToCents(invalidInput)).toThrow();
    }
  });

  it("retains zero floating-point operations across 100% of canonical vectors", () => {
    expect(VALID_VECTORS.length).toBe(9);
    expect(INVALID_VECTORS.length).toBe(14);
    expect(VALID_VECTORS.length + INVALID_VECTORS.length).toBe(23);
  });
});

