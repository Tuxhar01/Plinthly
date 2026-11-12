import { describe, it, expect } from "vitest";
import {
  parseDecimalStringToCents,
  parseCartDecimalStringToCents,
  formatCentsToDecimal,
  CANONICAL_UNSIGNED_DECIMAL_REGEX,
  CANONICAL_SIGNED_DECIMAL_REGEX,
  CANONICAL_NEGATIVE_ZERO_REGEX,
  MAX_CART_CENTS,
  PG_BIGINT_MIN,
  PG_BIGINT_MAX,
} from "../../lib/state/money";
import {
  Stage2DomainError,
  InvalidDecimalFormatError,
  AmountOutOfBoundsError,
  MissingPayloadFieldError,
  UnexpectedPayloadFieldError,
  MalformedNestedStructureError,
  InvalidPropertyTypeError,
  NullParameterError,
  UnsupportedAdjustmentError,
  ProviderTaxSumMismatchError,
  STAGE2_ERROR_CODES,
  SQLSTATE_CODES,
} from "../../lib/contracts/stage2-errors";
import {
  canonicalDecimalStringZod,
  canonicalSignedDecimalStringZod,
  validateRawLineItems,
  validateNormalizedLineItems,
  validateRawJurisdictions,
  validateNormalizedJurisdictions,
  validateTaxEvidenceRoutineInvariants,
  TaxEvidenceRecordRoutineParams,
} from "../../lib/contracts/stage2-schemas";

const ZERO_BIGINT = BigInt(0);

describe("Stage 2 Exact Decimal-String Parser (Contract v2.0.11 Sec 7.3)", () => {
  describe("Regex Unit Assertions", () => {
    it("should compile canonical unsigned regex correctly", () => {
      expect(CANONICAL_UNSIGNED_DECIMAL_REGEX.source).toBe("^(0|[1-9][0-9]*)(\\.[0-9]{2})?$");
    });

    it("should compile canonical signed regex correctly", () => {
      expect(CANONICAL_SIGNED_DECIMAL_REGEX.source).toBe("^-?(0|[1-9][0-9]*)(\\.[0-9]{2})?$");
    });

    it("should detect negative zero formats", () => {
      expect(CANONICAL_NEGATIVE_ZERO_REGEX.test("-0")).toBe(true);
      expect(CANONICAL_NEGATIVE_ZERO_REGEX.test("-0.00")).toBe(true);
      expect(CANONICAL_NEGATIVE_ZERO_REGEX.test("0")).toBe(false);
      expect(CANONICAL_NEGATIVE_ZERO_REGEX.test("0.00")).toBe(false);
    });
  });

  describe("Canonical 23 Test Vectors Table (Section 7.3.5)", () => {
    // 9 Valid Vectors
    it("Vector 1: '0' -> Accepted, 0 cents", () => {
      const result = parseDecimalStringToCents("0");
      expect(result).toBe(BigInt(0));
    });

    it("Vector 2: '0.00' -> Accepted, 0 cents", () => {
      const result = parseDecimalStringToCents("0.00");
      expect(result).toBe(BigInt(0));
    });

    it("Vector 3: '0.50' -> Accepted, 50 cents", () => {
      const result = parseDecimalStringToCents("0.50");
      expect(result).toBe(BigInt(50));
    });

    it("Vector 4: '1' -> Accepted, 100 cents", () => {
      const result = parseDecimalStringToCents("1");
      expect(result).toBe(BigInt(100));
    });

    it("Vector 5: '1.00' -> Accepted, 100 cents", () => {
      const result = parseDecimalStringToCents("1.00");
      expect(result).toBe(BigInt(100));
    });

    it("Vector 6: '19.99' -> Accepted, 1999 cents", () => {
      const result = parseDecimalStringToCents("19.99");
      expect(result).toBe(BigInt(1999));
    });

    it("Vector 7: '100' -> Accepted, 10000 cents", () => {
      const result = parseDecimalStringToCents("100");
      expect(result).toBe(BigInt(10000));
    });

    it("Vector 8: '100.50' -> Accepted, 10050 cents", () => {
      const result = parseDecimalStringToCents("100.50");
      expect(result).toBe(BigInt(10050));
    });

    it("Vector 9: '999999.99' -> Accepted, 99999999 cents", () => {
      const result = parseDecimalStringToCents("999999.99");
      expect(result).toBe(BigInt(99999999));
    });

    // 14 Invalid Vectors
    it("Vector 10: '.50' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents(".50")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents(".50");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 11: '01.50' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("01.50")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("01.50");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 12: '19.9' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("19.9")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("19.9");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 13: '19.999' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("19.999")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("19.999");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 14: '19.' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("19.")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("19.");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 15: '1,000.00' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("1,000.00")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("1,000.00");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 16: '1e2' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("1e2")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("1e2");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 17: '-0' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("-0")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("-0");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 18: '-0.00' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("-0.00")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("-0.00");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 19: '-15.00' (unsigned) -> Rejected with ERR_AMOUNT_OUT_OF_BOUNDS (22003)", () => {
      expect(() => parseDecimalStringToCents("-15.00")).toThrow(AmountOutOfBoundsError);
      try {
        parseDecimalStringToCents("-15.00");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_AMOUNT_OUT_OF_BOUNDS);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_NUMERIC_RANGE);
      }
    });

    it("Vector 20: ' 19.99 ' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents(" 19.99 ")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents(" 19.99 ");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 21: 'abc' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("abc")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("abc");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 22: '' (empty) -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("Vector 23: '00' -> Rejected with ERR_INVALID_DECIMAL_FORMAT (22023)", () => {
      expect(() => parseDecimalStringToCents("00")).toThrow(InvalidDecimalFormatError);
      try {
        parseDecimalStringToCents("00");
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });
  });

  describe("Signed Parsing Mode", () => {
    it("should accept valid negative amounts when signed=true", () => {
      expect(parseDecimalStringToCents("-15.00", { signed: true })).toBe(BigInt(-1500));
      expect(parseDecimalStringToCents("-0.50", { signed: true })).toBe(BigInt(-50));
      expect(parseDecimalStringToCents("-100", { signed: true })).toBe(BigInt(-10000));
      expect(parseDecimalStringToCents("-100.50", { signed: true })).toBe(BigInt(-10050));
    });

    it("should accept valid positive amounts when signed=true", () => {
      expect(parseDecimalStringToCents("19.99", { signed: true })).toBe(BigInt(1999));
      expect(parseDecimalStringToCents("0", { signed: true })).toBe(BigInt(0));
      expect(parseDecimalStringToCents("0.00", { signed: true })).toBe(BigInt(0));
    });

    it("should reject negative zero even when signed=true", () => {
      expect(() => parseDecimalStringToCents("-0", { signed: true })).toThrow(InvalidDecimalFormatError);
      expect(() => parseDecimalStringToCents("-0.00", { signed: true })).toThrow(InvalidDecimalFormatError);
    });

    it("should reject invalid decimal formats when signed=true", () => {
      expect(() => parseDecimalStringToCents("-.50", { signed: true })).toThrow(InvalidDecimalFormatError);
      expect(() => parseDecimalStringToCents("-01.50", { signed: true })).toThrow(InvalidDecimalFormatError);
      expect(() => parseDecimalStringToCents("-19.9", { signed: true })).toThrow(InvalidDecimalFormatError);
      expect(() => parseDecimalStringToCents("-19.999", { signed: true })).toThrow(InvalidDecimalFormatError);
      expect(() => parseDecimalStringToCents("-19.", { signed: true })).toThrow(InvalidDecimalFormatError);
      expect(() => parseDecimalStringToCents("-1,000.00", { signed: true })).toThrow(InvalidDecimalFormatError);
    });
  });

  describe("Cart & Bounds Enforcement", () => {
    it("should parse cart amounts within [0, 999999999]", () => {
      expect(parseCartDecimalStringToCents("0.00")).toBe(BigInt(0));
      expect(parseCartDecimalStringToCents("9999999.99")).toBe(BigInt(999999999));
    });

    it("should reject cart amounts exceeding MAX_CART_CENTS", () => {
      expect(() => parseCartDecimalStringToCents("10000000.00")).toThrow(AmountOutOfBoundsError);
    });

    it("should reject amounts outside PostgreSQL BIGINT range", () => {
      // 92233720368547758.07 * 100 = 9223372036854775807 (PG_BIGINT_MAX) -> valid
      expect(parseDecimalStringToCents("92233720368547758.07")).toBe(PG_BIGINT_MAX);

      // Exceeding PG_BIGINT_MAX throws AmountOutOfBoundsError
      expect(() => parseDecimalStringToCents("92233720368547758.08")).toThrow(AmountOutOfBoundsError);
      expect(() => parseDecimalStringToCents("99999999999999999.99")).toThrow(AmountOutOfBoundsError);

      // Test with custom max bounds
      expect(() =>
        parseDecimalStringToCents("100.00", {
          maxCents: BigInt(5000),
        })
      ).toThrow(AmountOutOfBoundsError);

      expect(() =>
        parseDecimalStringToCents("10.00", {
          minCents: BigInt(2000),
        })
      ).toThrow(AmountOutOfBoundsError);
    });
  });

  describe("Two-Decimal Formatting", () => {
    it("should format cents to canonical decimal string", () => {
      expect(formatCentsToDecimal(BigInt(0))).toBe("0.00");
      expect(formatCentsToDecimal(BigInt(50))).toBe("0.50");
      expect(formatCentsToDecimal(BigInt(100))).toBe("1.00");
      expect(formatCentsToDecimal(BigInt(1999))).toBe("19.99");
      expect(formatCentsToDecimal(BigInt(10050))).toBe("100.50");
      expect(formatCentsToDecimal(BigInt(-1500))).toBe("-15.00");
      expect(formatCentsToDecimal(BigInt(-50))).toBe("-0.50");
    });
  });

  describe("Stage 2 Strict Zod Schemas & C-48 Nested Enforcement", () => {
    describe("Decimal String Zod Schemas", () => {
      it("should accept valid canonical decimal strings", () => {
        expect(canonicalDecimalStringZod.parse("19.99")).toBe("19.99");
        expect(canonicalDecimalStringZod.parse("0")).toBe("0");
        expect(canonicalDecimalStringZod.parse("0.00")).toBe("0.00");
        expect(canonicalDecimalStringZod.parse("100.50")).toBe("100.50");
      });

      it("should reject negative zero in Zod schema", () => {
        expect(() => canonicalDecimalStringZod.parse("-0")).toThrow();
        expect(() => canonicalDecimalStringZod.parse("-0.00")).toThrow();
        expect(() => canonicalSignedDecimalStringZod.parse("-0")).toThrow();
        expect(() => canonicalSignedDecimalStringZod.parse("-0.00")).toThrow();
      });

      it("should accept signed decimals in signed schema", () => {
        expect(canonicalSignedDecimalStringZod.parse("-15.00")).toBe("-15.00");
        expect(canonicalSignedDecimalStringZod.parse("15.00")).toBe("15.00");
      });
    });

    describe("Raw Line Items Validation (C-48 Exact Key Whitelisting)", () => {
      const validRawItem = {
        id: "item-123",
        unit_price: "15.00",
        quantity: 1,
        subtotal: "15.00",
        discount_amount: "1.00",
        tax_amount: "1.26",
        exemption_code: null,
      };

      it("should accept valid raw line items with nullable exemption_code", () => {
        const parsed = validateRawLineItems([validRawItem]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe("item-123");
        expect(parsed[0].exemption_code).toBeNull();
      });

      it("should accept valid raw line items omitting optional exemption_code", () => {
        const { exemption_code, ...withoutExemption } = validRawItem;
        const parsed = validateRawLineItems([withoutExemption]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe("item-123");
      });

      it("should reject missing required field with ERR_MISSING_PAYLOAD_FIELD (22023)", () => {
        const { unit_price, ...incomplete } = validRawItem;
        expect(() => validateRawLineItems([incomplete])).toThrow(MissingPayloadFieldError);
        try {
          validateRawLineItems([incomplete]);
        } catch (err: any) {
          expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_MISSING_PAYLOAD_FIELD);
          expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
        }
      });

      it("should reject unexpected extraneous field with ERR_UNEXPECTED_PAYLOAD_FIELD (22023)", () => {
        const withExtra = { ...validRawItem, unexpectedField: "hack" };
        expect(() => validateRawLineItems([withExtra])).toThrow(UnexpectedPayloadFieldError);
        try {
          validateRawLineItems([withExtra]);
        } catch (err: any) {
          expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_UNEXPECTED_PAYLOAD_FIELD);
          expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
        }
      });

      it("should reject null required field with ERR_NULL_PARAMETER (22004)", () => {
        const withNull = { ...validRawItem, unit_price: null };
        expect(() => validateRawLineItems([withNull])).toThrow(NullParameterError);
        try {
          validateRawLineItems([withNull]);
        } catch (err: any) {
          expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_NULL_PARAMETER);
          expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_NULL);
        }
      });

      it("should reject non-object elements with ERR_MALFORMED_NESTED_STRUCTURE (22023)", () => {
        expect(() => validateRawLineItems(["malformed-string"])).toThrow(MalformedNestedStructureError);
        expect(() => validateRawLineItems([null])).toThrow(NullParameterError);
      });
    });

    describe("Normalized Line Items Validation (Section 7.1.2 — 8 Canonical Keys)", () => {
      const validNormalizedItem = {
        itemIndex: 0,
        lineItemId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        itemSubtotalCents: 1500,
        allocatedDiscountCents: 100,
        taxableAmountCents: 1400,
        lineTaxCents: 126,
        exemptionCode: null,
        taxabilityStatus: "TAXABLE" as const,
      };

      it("should accept valid normalized line item breakdown", () => {
        const parsed = validateNormalizedLineItems([validNormalizedItem]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].lineItemId).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
      });

      it("should enforce taxableAmountCents === itemSubtotalCents - allocatedDiscountCents", () => {
        const invalidMath = { ...validNormalizedItem, taxableAmountCents: 1450 };
        expect(() => validateNormalizedLineItems([invalidMath])).toThrow(MalformedNestedStructureError);
      });

      it("should enforce lineTaxCents === 0 when taxabilityStatus is EXEMPT", () => {
        const invalidExempt = {
          ...validNormalizedItem,
          taxabilityStatus: "EXEMPT",
          lineTaxCents: 50,
          exemptionCode: "STATUTORY_GROCERY_EXEMPT",
        };
        expect(() => validateNormalizedLineItems([invalidExempt])).toThrow(MalformedNestedStructureError);
      });

      it("should reject duplicate itemIndex across normalized line items", () => {
        const item0 = { ...validNormalizedItem, itemIndex: 0 };
        const item0Dup = { ...validNormalizedItem, itemIndex: 0, lineItemId: "a47ac10b-58cc-4372-a567-0e02b2c3d478" };
        expect(() => validateNormalizedLineItems([item0, item0Dup])).toThrow(MalformedNestedStructureError);
      });
    });

    describe("Jurisdiction Validation (Section 7.1.3 — 6 Canonical Keys)", () => {
      const validRawJurisdiction = {
        type: "STATE" as const,
        code: "US-CA",
        name: "CALIFORNIA",
        rate_bps: 600,
        amount: "0.84",
        applies_to_shipping: true,
      };

      const validNormalizedJurisdiction = {
        componentType: "STATE" as const,
        jurisdictionCode: "US-CA",
        jurisdictionName: "CALIFORNIA",
        rateBps: 600,
        taxAmountCents: 84,
        appliesToShipping: true,
      };

      it("should accept valid raw and normalized jurisdiction structures", () => {
        const raw = validateRawJurisdictions([validRawJurisdiction]);
        expect(raw).toHaveLength(1);
        expect(raw[0].code).toBe("US-CA");

        const norm = validateNormalizedJurisdictions([validNormalizedJurisdiction]);
        expect(norm).toHaveLength(1);
        expect(norm[0].jurisdictionCode).toBe("US-CA");
      });

      it("should reject unexpected keys in raw jurisdiction with ERR_UNEXPECTED_PAYLOAD_FIELD", () => {
        const extra = { ...validRawJurisdiction, illegalField: "test" };
        expect(() => validateRawJurisdictions([extra])).toThrow(UnexpectedPayloadFieldError);
      });

      it("should reject missing required keys in normalized jurisdiction with ERR_MISSING_PAYLOAD_FIELD", () => {
        const { jurisdictionName, ...missing } = validNormalizedJurisdiction;
        expect(() => validateNormalizedJurisdictions([missing])).toThrow(MissingPayloadFieldError);
      });

      it("should reject null values in non-nullable jurisdiction fields", () => {
        const nullField = { ...validNormalizedJurisdiction, rateBps: null };
        expect(() => validateNormalizedJurisdictions([nullField])).toThrow(NullParameterError);
      });
    });

    describe("Tax Evidence Routine Mathematical Invariants (Section 7.1.6)", () => {
      const mockParams: TaxEvidenceRecordRoutineParams = {
        cartId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        providerName: "TAXJAR",
        taxQuoteId: "tax_quote_12345",
        providerApiVersion: "v2",
        signatureAlgorithm: "RSA-SHA256",
        providerTimestamp: "2026-11-07T10:00:00Z",
        validUntil: "2026-11-07T11:00:00Z",
        currency: "USD",
        providerMerchandiseSubtotalCents: BigInt(1500),
        providerDiscountCents: BigInt(100),
        providerShippingCents: BigInt(500),
        providerAdjustmentCents: ZERO_BIGINT,
        providerTotalCents: BigInt(2026),
        totalTaxCents: BigInt(126),
        merchandiseTaxCents: BigInt(126),
        shippingTaxCents: ZERO_BIGINT,
        taxableShippingBaseCents: ZERO_BIGINT,
        jurisdictionCode: "US-CA",
        lineItemsBreakdown: [
          {
            itemIndex: 0,
            lineItemId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            itemSubtotalCents: 1500,
            allocatedDiscountCents: 100,
            taxableAmountCents: 1400,
            lineTaxCents: 126,
            exemptionCode: null,
            taxabilityStatus: "TAXABLE",
          },
        ],
        jurisdictionBreakdown: [
          {
            componentType: "STATE",
            jurisdictionCode: "US-CA",
            jurisdictionName: "CALIFORNIA",
            rateBps: 900,
            taxAmountCents: 126,
            appliesToShipping: false,
          },
        ],
        authorityId: "auth-taxjar-01",
        certificateNumber: "cert-2026-001",
        rawPayload: Buffer.from("{}"),
        statutoryPayloadHash: Buffer.alloc(32),
        statutorySignature: Buffer.from("sig"),
        verifierIdentity: "tax_worker_pod_01",
        attestationKeyId: "key_attest_01",
        attestationTimestamp: "2026-11-07T10:00:00Z",
        verifierAttestationSignature: Buffer.from("attestsig"),
        nonce: "nonce_quote_001",
      };

      it("should accept valid, perfectly reconciled tax quote parameters", () => {
        expect(() => validateTaxEvidenceRoutineInvariants(mockParams)).not.toThrow();
      });

      it("should reject non-zero provider adjustment with ERR_UNSUPPORTED_ADJUSTMENT (C-42, C-44B)", () => {
        const withAdjustment = { ...mockParams, providerAdjustmentCents: BigInt(50) };
        expect(() => validateTaxEvidenceRoutineInvariants(withAdjustment)).toThrow(UnsupportedAdjustmentError);
      });

      it("should reject component sum mismatch (merchTax + shipTax !== totalTax)", () => {
        const mismatch = { ...mockParams, shippingTaxCents: BigInt(10) };
        expect(() => validateTaxEvidenceRoutineInvariants(mismatch)).toThrow(ProviderTaxSumMismatchError);
      });

      it("should reject invoice landed total mismatch", () => {
        const mismatch = { ...mockParams, providerTotalCents: BigInt(9999) };
        expect(() => validateTaxEvidenceRoutineInvariants(mismatch)).toThrow(ProviderTaxSumMismatchError);
      });

      it("should reject line item tax sum mismatch", () => {
        const mismatch = { ...mockParams, merchandiseTaxCents: BigInt(200), totalTaxCents: BigInt(200) };
        expect(() => validateTaxEvidenceRoutineInvariants(mismatch)).toThrow(ProviderTaxSumMismatchError);
      });

      it("should reject jurisdiction tax sum mismatch", () => {
        const mismatch = {
          ...mockParams,
          jurisdictionBreakdown: [
            {
              ...mockParams.jurisdictionBreakdown[0],
              taxAmountCents: 50,
            },
          ],
        };
        expect(() => validateTaxEvidenceRoutineInvariants(mismatch)).toThrow(ProviderTaxSumMismatchError);
      });

      it("should reject invalid jurisdictionCode format (C-47)", () => {
        const invalidCode = { ...mockParams, jurisdictionCode: "invalid_code_123" };
        expect(() => validateTaxEvidenceRoutineInvariants(invalidCode)).toThrow(MalformedNestedStructureError);
      });
    });
  });
});
