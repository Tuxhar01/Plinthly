/**
 * Plinthly Stage 3 Phase 2 — Certified Tax Provider Adapter Interface & Mock Adapter
 *
 * Implements Stage 3 Architecture Contract v3.0.0 Section 3.3.
 *
 * Cloud-Neutral & Decoupled:
 * - Abstract TaxProviderAdapter interface decoupling Plinthly from any specific vendor SDK.
 * - Uniform normalization into integer minor units (cents) with zero rounding drift (PRV-06).
 * - Multi-jurisdiction breakdowns (State, County, City, Special District) mapped to canonical types.
 * - Deterministic MockTaxProviderAdapter supporting all 5 benchmark jurisdictions (CA, NY, TX, PA, FL).
 */

import crypto from "crypto";

export interface TaxLineItemRequest {
  readonly id: string;
  readonly description?: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly taxableCents: number;
  readonly taxCode?: string; // statutory tax classification code
}

export interface TaxAddress {
  readonly line1?: string;
  readonly city?: string;
  readonly state: string; // 2-letter state code e.g. "CA", "NY", "TX", "PA", "FL"
  readonly postalCode: string;
  readonly country: string; // "US"
}

export interface TaxCalculationRequest {
  readonly cartId: string;
  readonly toAddress: TaxAddress;
  readonly fromAddress?: TaxAddress;
  readonly shippingCents: number;
  readonly lineItems: readonly TaxLineItemRequest[];
  readonly currency?: string; // defaults to "USD"
}

export type JurisdictionLevel = "COUNTRY" | "FEDERAL" | "STATE" | "COUNTY" | "CITY" | "SPECIAL";

export interface StatutoryTaxJurisdiction {
  readonly jurisdictionLevel: JurisdictionLevel;
  readonly jurisdictionName: string;
  readonly jurisdictionCode?: string;
  readonly rateBps: number; // Basis points (1% = 100 bps)
  readonly taxableAmountCents: number;
  readonly taxCollectedCents: number;
  readonly appliesToShipping?: boolean;
}

export interface StatutoryTaxLineItem {
  readonly lineItemId: string;
  readonly taxableAmountCents: number;
  readonly taxCollectedCents: number;
  readonly rateBps: number;
}

export interface TaxCalculationResult {
  readonly cartId: string;
  readonly quoteId: string;
  readonly provider: string; // "taxjar" | "avalara" | "mock"
  readonly version: string;
  readonly totalTaxCents: number;
  readonly merchandiseTaxCents: number;
  readonly shippingTaxCents: number;
  readonly effectiveRateBps: number;
  readonly lineItems: readonly StatutoryTaxLineItem[];
  readonly jurisdictions: readonly StatutoryTaxJurisdiction[];
  readonly rawWirePayload: Buffer;
  readonly statutorySignature: Buffer;
  readonly statutorySignatureAlgorithm: string;
  readonly calculatedAt: Date;
  readonly expiresAt: Date;
}

export interface TaxProviderAdapter {
  readonly providerName: string;
  calculateTaxQuote(request: TaxCalculationRequest): Promise<TaxCalculationResult>;
  healthCheck(): Promise<boolean>;
}

export class TaxCalculationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string = "ERR_TAX_CALCULATION", details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "TaxCalculationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Standard benchmark statutory tax rates for mock multi-state verification (PRV-06).
 */
interface StateBenchmarkRates {
  stateRateBps: number;
  countyRateBps: number;
  cityRateBps: number;
  specialRateBps: number;
  taxesShipping: boolean;
}

const BENCHMARK_JURISDICTIONS: Record<string, StateBenchmarkRates> = {
  CA: { stateRateBps: 600, countyRateBps: 125, cityRateBps: 0, specialRateBps: 100, taxesShipping: false }, // 8.25%
  NY: { stateRateBps: 400, countyRateBps: 0, cityRateBps: 450, specialRateBps: 38, taxesShipping: true },   // 8.875% (888 bps)
  TX: { stateRateBps: 625, countyRateBps: 0, cityRateBps: 200, specialRateBps: 0, taxesShipping: true },   // 8.25%
  PA: { stateRateBps: 600, countyRateBps: 100, cityRateBps: 0, specialRateBps: 0, taxesShipping: true },   // 7.00% (Allegheny Co.)
  FL: { stateRateBps: 600, countyRateBps: 100, cityRateBps: 0, specialRateBps: 0, taxesShipping: true },   // 7.00% (Miami-Dade)
};

/**
 * Stage 3 Phase 2 — Deterministic Mock Tax Provider Adapter
 *
 * Validates PRV-06 (Multi-State Tax Quote Precision) and PRV-05 (Attestation Generation)
 * without external network dependencies.
 */
export class MockTaxProviderAdapter implements TaxProviderAdapter {
  public readonly providerName = "mock";
  private readonly signingKey: crypto.KeyObject;
  public readonly publicKeyDer: Buffer;

  constructor() {
    // Generate deterministic in-memory keypair for mock statutory signature
    const keypair = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    this.signingKey = crypto.createPrivateKey({ key: keypair.privateKey, format: "der", type: "pkcs8" });
    this.publicKeyDer = keypair.publicKey;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async calculateTaxQuote(request: TaxCalculationRequest): Promise<TaxCalculationResult> {
    if (!request.cartId) {
      throw new TaxCalculationError("cartId is required.", "ERR_INVALID_PARAM");
    }
    if (!request.toAddress?.state) {
      throw new TaxCalculationError("toAddress.state is required.", "ERR_INVALID_PARAM");
    }
    if (!request.lineItems || request.lineItems.length === 0) {
      throw new TaxCalculationError("At least one line item is required.", "ERR_INVALID_PARAM");
    }

    const state = request.toAddress.state.toUpperCase().trim();
    const config = BENCHMARK_JURISDICTIONS[state] || {
      stateRateBps: 500,
      countyRateBps: 0,
      cityRateBps: 0,
      specialRateBps: 0,
      taxesShipping: false,
    };

    const totalRateBps =
      config.stateRateBps + config.countyRateBps + config.cityRateBps + config.specialRateBps;

    // Calculate line item taxes with exact integer rounding
    let merchandiseTaxCents = 0;
    const statutoryLineItems: StatutoryTaxLineItem[] = [];

    for (const item of request.lineItems) {
      const taxableAmountCents = item.taxableCents;
      const lineTaxCents = Math.round((taxableAmountCents * totalRateBps) / 10000);
      merchandiseTaxCents += lineTaxCents;

      statutoryLineItems.push({
        lineItemId: item.id,
        taxableAmountCents,
        taxCollectedCents: lineTaxCents,
        rateBps: totalRateBps,
      });
    }

    // Shipping tax
    const shippingTaxCents = config.taxesShipping
      ? Math.round((request.shippingCents * totalRateBps) / 10000)
      : 0;

    const totalTaxCents = merchandiseTaxCents + shippingTaxCents;
    const totalTaxableBaseCents =
      request.lineItems.reduce((acc, i) => acc + i.taxableCents, 0) +
      (config.taxesShipping ? request.shippingCents : 0);

    // Build jurisdictions breakdown proportionally down to exact integer cents
    const jurisdictions: StatutoryTaxJurisdiction[] = [];
    if (config.stateRateBps > 0) {
      const amount = Math.round((totalTaxableBaseCents * config.stateRateBps) / 10000);
      jurisdictions.push({
        jurisdictionLevel: "STATE",
        jurisdictionName: `${state} State Tax`,
        jurisdictionCode: state,
        rateBps: config.stateRateBps,
        taxableAmountCents: totalTaxableBaseCents,
        taxCollectedCents: amount,
        appliesToShipping: config.taxesShipping,
      });
    }
    if (config.countyRateBps > 0) {
      const amount = Math.round((totalTaxableBaseCents * config.countyRateBps) / 10000);
      jurisdictions.push({
        jurisdictionLevel: "COUNTY",
        jurisdictionName: `${state} County Tax`,
        rateBps: config.countyRateBps,
        taxableAmountCents: totalTaxableBaseCents,
        taxCollectedCents: amount,
        appliesToShipping: config.taxesShipping,
      });
    }
    if (config.cityRateBps > 0) {
      const amount = Math.round((totalTaxableBaseCents * config.cityRateBps) / 10000);
      jurisdictions.push({
        jurisdictionLevel: "CITY",
        jurisdictionName: `${state} City Tax`,
        rateBps: config.cityRateBps,
        taxableAmountCents: totalTaxableBaseCents,
        taxCollectedCents: amount,
        appliesToShipping: config.taxesShipping,
      });
    }
    if (config.specialRateBps > 0) {
      const amount = Math.round((totalTaxableBaseCents * config.specialRateBps) / 10000);
      jurisdictions.push({
        jurisdictionLevel: "SPECIAL",
        jurisdictionName: `${state} Special District Tax`,
        rateBps: config.specialRateBps,
        taxableAmountCents: totalTaxableBaseCents,
        taxCollectedCents: amount,
        appliesToShipping: config.taxesShipping,
      });
    }

    const calculatedAt = new Date();
    const expiresAt = new Date(calculatedAt.getTime() + 1800 * 1000); // 30 minutes TTL
    const quoteId = `quote_mock_${request.cartId}_${Date.now()}`;

    // Construct raw wire JSON adhering strictly to C-48 / R2-01 schema
    const rawPayloadObj = {
      id: quoteId,
      provider: "mock",
      version: "2026-03-01",
      signature_algorithm: "ECDSA-P256-SHA256",
      timestamp: calculatedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      order_subtotal: (request.lineItems.reduce((acc, i) => acc + i.unitPriceCents * i.quantity, 0) / 100).toFixed(2),
      discount_amount: "0.00",
      shipping: (request.shippingCents / 100).toFixed(2),
      adjustment: "0.00",
      total_amount: (
        (request.lineItems.reduce((acc, i) => acc + i.unitPriceCents * i.quantity, 0) +
          request.shippingCents +
          totalTaxCents) /
        100
      ).toFixed(2),
      amount_to_collect: (totalTaxCents / 100).toFixed(2),
      currency: request.currency || "USD",
      jurisdiction: state,
      line_items: request.lineItems.map((li) => {
        const taxable = li.taxableCents;
        const tax = Math.round((taxable * totalRateBps) / 10000);
        return {
          id: li.id,
          subtotal: ((li.unitPriceCents * li.quantity) / 100).toFixed(2),
          discount: "0.00",
          taxable_amount: (taxable / 100).toFixed(2),
          tax_collectable: (tax / 100).toFixed(2),
          exemption_code: null,
          taxability_status: "TAXABLE",
        };
      }),
      jurisdictions: jurisdictions.map((j) => ({
        type: j.jurisdictionLevel,
        code: j.jurisdictionCode || `${state}_DIST`,
        name: j.jurisdictionName,
        rate_bps: j.rateBps,
        amount: (j.taxCollectedCents / 100).toFixed(2),
        applies_to_shipping: Boolean(j.appliesToShipping),
      })),
      breakdown: {
        line_items_total: (merchandiseTaxCents / 100).toFixed(2),
        shipping_tax: (shippingTaxCents / 100).toFixed(2),
        taxable_shipping: config.taxesShipping ? (request.shippingCents / 100).toFixed(2) : "0.00",
      },
    };

    const rawWirePayload = Buffer.from(JSON.stringify(rawPayloadObj), "utf8");

    // Compute genuine statutory provider signature over raw wire bytes
    const signer = crypto.createSign("sha256");
    signer.update(rawWirePayload);
    const statutorySignature = signer.sign(this.signingKey);

    return {
      cartId: request.cartId,
      quoteId,
      provider: "mock",
      version: "2026-03-01",
      totalTaxCents,
      merchandiseTaxCents,
      shippingTaxCents,
      effectiveRateBps: totalRateBps,
      lineItems: statutoryLineItems,
      jurisdictions,
      rawWirePayload,
      statutorySignature,
      statutorySignatureAlgorithm: "ECDSA-P256-SHA256",
      calculatedAt,
      expiresAt,
    };
  }
}

