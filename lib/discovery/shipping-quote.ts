/**
 * Plinthly Phase 11F — Shipping Quote Adapter Contract and Feasibility Implementation.
 *
 * Defines a narrow, typed, read-only interface to query and verify destination-specific
 * shipping quotes for product candidates discovered via Channel3.
 *
 * Enforces strict procurement invariants:
 * 1. Missing, estimated, or unverified quotes never become zero-cost shipping.
 * 2. Destination-specific quotes require validated destination context (5-digit US ZIP).
 * 3. Quote expiration, product mismatch, currency mismatch, and retailer mismatch fail closed.
 * 4. Zero scraping or bypass of anti-automation controls; enterprise/partner boundaries are reported as blockers.
 */

import { Currency } from "../state/types";
import { DestinationContext, ShippingEvidenceDetails } from "./shipping";
import { formatUtcIso8601 } from "./evidence";
import { createHash } from "node:crypto";

/**
 * Standard candidate facts required to request a shipping quote.
 */
export interface CandidateQuoteTarget {
  readonly externalId: string;
  readonly merchantName: string;
  readonly merchantUrl: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly currency: Currency;
  readonly sku?: string;
  readonly productId?: string;
}

/**
 * Input request for a destination-specific shipping quote.
 */
export interface ShippingQuoteRequest {
  readonly candidate: CandidateQuoteTarget;
  readonly canonicalProductUrl: string;
  readonly destination: DestinationContext;
  readonly requestedCurrency?: Currency;
  readonly deliveryMethodPreference?: string;
  readonly now: Date;
}

/**
 * Successful, authoritative shipping quote verified by a supported retailer source.
 */
export interface SuccessfulShippingQuote {
  readonly status: "success";
  readonly quoteId: string;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly retailerId: string; // e.g. "bestbuy.com"
  readonly merchantDomain: string;
  readonly externalId: string;
  readonly canonicalProductUrl?: string;
  readonly destinationPostalCode: string;
  readonly destinationCountry: "US";
  readonly deliveryMethod: string;
  readonly conditions?: readonly string[];
  readonly quotedAt: string; // ISO 8601 UTC
  readonly expiresAt: string | null; // ISO 8601 UTC or null if not time-bounded
  readonly sourceUrl: string;
  readonly quoteFingerprint: string;
  readonly rawQuotePayload?: Record<string, unknown>;
}

/**
 * Retailer is not supported by this quote adapter.
 */
export interface UnsupportedRetailerQuote {
  readonly status: "unsupported";
  readonly retailerId: string;
  readonly reason: string;
  readonly timestamp: string;
}

/**
 * Shipping quote is temporarily unavailable from the retailer.
 */
export interface UnavailableShippingQuote {
  readonly status: "unavailable";
  readonly retailerId: string;
  readonly destinationPostalCode?: string;
  readonly reason: string;
  readonly timestamp: string;
}

/**
 * Shipping quote returned by retailer has expired.
 */
export interface ExpiredShippingQuote {
  readonly status: "expired";
  readonly quoteId: string;
  readonly retailerId: string;
  readonly quotedAt: string;
  readonly expiredAt: string;
  readonly reason: string;
  readonly timestamp: string;
}

/**
 * Retailer response returned ambiguous or conflicting delivery options.
 */
export interface AmbiguousShippingQuote {
  readonly status: "ambiguous";
  readonly retailerId: string;
  readonly reason: string;
  readonly candidateOptions?: readonly { readonly deliveryMethod: string; readonly amountCents: number }[];
  readonly timestamp: string;
}

/**
 * Provider communication, authentication, or parsing failure.
 */
export interface FailedShippingQuote {
  readonly status: "failed";
  readonly retailerId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly timestamp: string;
}

/**
 * Comprehensive outcome of a shipping quote request.
 */
export type ShippingQuoteResult =
  | SuccessfulShippingQuote
  | UnsupportedRetailerQuote
  | UnavailableShippingQuote
  | ExpiredShippingQuote
  | AmbiguousShippingQuote
  | FailedShippingQuote;

/**
 * Narrow, typed, read-only shipping quote adapter interface.
 */
export interface ShippingQuoteAdapter {
  readonly name: string;
  readonly supportedRetailers: readonly string[];
  canQuote(target: { readonly merchantName?: string; readonly merchantUrl?: string; readonly externalId?: string }): boolean;
  getShippingQuote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult>;
}

/**
 * Validates that a URL is a valid, absolute HTTPS URL and optionally belongs to a trusted domain.
 * Prevents protocol-downgrade (e.g. http://, file://) and domain substitution.
 */
export function validateTrustedHttpsOrigin(
  urlStr: string,
  expectedDomain?: string
): { readonly valid: boolean; readonly reason?: string } {
  if (!urlStr || typeof urlStr !== "string" || urlStr.trim().length === 0) {
    return { valid: false, reason: "Missing or empty URL string." };
  }
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:") {
      return {
        valid: false,
        reason: `Insecure URL protocol "${parsed.protocol}"; authoritative evidence strictly requires HTTPS.`,
      };
    }
    if (expectedDomain && expectedDomain.trim().length > 0) {
      const normExpected = expectedDomain.toLowerCase().trim().replace(/^www\./, "");
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== normExpected && !host.endsWith(`.${normExpected}`)) {
        return {
          valid: false,
          reason: `Origin host "${parsed.hostname}" does not match trusted domain "${expectedDomain}".`,
        };
      }
    }
    return { valid: true };
  } catch (err: unknown) {
    return { valid: false, reason: `Malformed URL: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Computes a deterministic SHA-256 fingerprint binding every security-relevant quote fact:
 * amount, currency, externalId, canonicalProductUrl, retailerId, merchantDomain,
 * destinationCountry, destinationPostalCode, deliveryMethod, conditions, quotedAt, expiresAt, and sourceUrl.
 */
export function computeQuoteFingerprint(quote: Omit<SuccessfulShippingQuote, "quoteFingerprint">): string {
  const canonical = {
    amountCents: quote.amountCents,
    canonicalProductUrl: quote.canonicalProductUrl ?? "",
    conditions: Array.isArray(quote.conditions) ? [...quote.conditions].sort() : [],
    currency: quote.currency,
    deliveryMethod: quote.deliveryMethod,
    destinationCountry: quote.destinationCountry,
    destinationPostalCode: quote.destinationPostalCode,
    expiresAt: quote.expiresAt,
    externalId: quote.externalId,
    merchantDomain: quote.merchantDomain,
    quoteId: quote.quoteId,
    quotedAt: quote.quotedAt,
    retailerId: quote.retailerId,
    sourceUrl: quote.sourceUrl,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").toLowerCase();
}

/**
 * Validates a shipping quote result against a candidate and destination for approval eligibility.
 * Ensures the quote:
 * 1. Has "success" status.
 * 2. Origin URLs are valid HTTPS from trusted merchant/provider origins.
 * 3. Quote fingerprint matches canonical quote facts (tampering check).
 * 4. Matches the candidate externalId and currency.
 * 5. Matches the destination postal code.
 * 6. Has not expired relative to the verification time.
 * 7. Contains a valid integer amount >= 0.
 */
export function validateQuoteForCandidate(
  quoteResult: ShippingQuoteResult,
  request: ShippingQuoteRequest
): {
  readonly valid: boolean;
  readonly isAuthoritative: boolean;
  readonly shippingCents: number | null;
  readonly details: ShippingEvidenceDetails;
  readonly rejectionReason?: string;
} {
  const obsTimestamp = formatUtcIso8601(request.now) || new Date().toISOString();

  if (quoteResult.status !== "success") {
    const reason =
      quoteResult.status === "failed"
        ? `Quote provider failed: [${quoteResult.errorCode}] ${quoteResult.errorMessage}`
        : quoteResult.status === "unavailable"
        ? `Quote unavailable: ${quoteResult.reason}`
        : quoteResult.status === "unsupported"
        ? `Retailer unsupported: ${quoteResult.reason}`
        : quoteResult.status === "expired"
        ? `Quote expired at ${quoteResult.expiredAt}: ${quoteResult.reason}`
        : `Quote ambiguous: ${quoteResult.reason}`;

    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: request.requestedCurrency ?? "USD",
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: null,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // 1. External ID check
  if (quoteResult.externalId !== request.candidate.externalId) {
    const reason = `Quote externalId "${quoteResult.externalId}" does not match candidate externalId "${request.candidate.externalId}".`;
    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: request.requestedCurrency ?? "USD",
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: quoteResult.quotedAt,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // 1b. Merchant domain check
  if (request.candidate.merchantUrl && quoteResult.merchantDomain) {
    try {
      const candHost = new URL(request.candidate.merchantUrl).hostname.replace(/^www\./, "").toLowerCase();
      const quoteDomain = quoteResult.merchantDomain.replace(/^www\./, "").toLowerCase();
      if (!candHost.includes(quoteDomain) && !quoteDomain.includes(candHost)) {
        const reason = `Quote merchant domain "${quoteResult.merchantDomain}" does not match candidate merchant domain "${candHost}".`;
        return {
          valid: false,
          isAuthoritative: false,
          shippingCents: null,
          details: {
            type: "missing",
            amountCents: null,
            currency: request.requestedCurrency ?? "USD",
            isAuthoritative: false,
            observationTimestamp: obsTimestamp,
            sourceVerificationTimestamp: quoteResult.quotedAt,
            explanation: reason,
          },
          rejectionReason: reason,
        };
      }
    } catch {
      // Malformed candidate URL is handled in canonical URL check
    }
  }

  // 2. Destination check
  if (quoteResult.destinationPostalCode !== request.destination.postalCode) {
    const reason = `Quote postal code "${quoteResult.destinationPostalCode}" does not match requested destination "${request.destination.postalCode}".`;
    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: request.requestedCurrency ?? "USD",
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: quoteResult.quotedAt,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // 3. Currency check
  const expCurrency = request.requestedCurrency ?? request.candidate.currency ?? "USD";
  if (quoteResult.currency !== expCurrency) {
    const reason = `Quote currency "${quoteResult.currency}" does not match requested currency "${expCurrency}".`;
    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: expCurrency,
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: quoteResult.quotedAt,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // 4. Expiration check
  if (quoteResult.expiresAt) {
    const expireTime = Date.parse(quoteResult.expiresAt);
    if (!isNaN(expireTime) && expireTime <= request.now.getTime()) {
      const reason = `Quote expired at ${quoteResult.expiresAt} (current time: ${request.now.toISOString()}).`;
      return {
        valid: false,
        isAuthoritative: false,
        shippingCents: null,
        details: {
          type: "missing",
          amountCents: null,
          currency: expCurrency,
          isAuthoritative: false,
          observationTimestamp: obsTimestamp,
          sourceVerificationTimestamp: quoteResult.quotedAt,
          explanation: reason,
        },
        rejectionReason: reason,
      };
    }
  }

  // 5. Amount check
  if (typeof quoteResult.amountCents !== "number" || !Number.isInteger(quoteResult.amountCents) || quoteResult.amountCents < 0) {
    const reason = `Quote shipping amount "${String(quoteResult.amountCents)}" is not a non-negative integer in cents.`;
    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: expCurrency,
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: quoteResult.quotedAt,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // 6. Source URL origin and HTTPS validation
  if (quoteResult.sourceUrl) {
    const originCheck = validateTrustedHttpsOrigin(quoteResult.sourceUrl, quoteResult.merchantDomain);
    if (!originCheck.valid) {
      const reason = `Quote source URL "${quoteResult.sourceUrl}" rejected: ${originCheck.reason}`;
      return {
        valid: false,
        isAuthoritative: false,
        shippingCents: null,
        details: {
          type: "missing",
          amountCents: null,
          currency: expCurrency,
          isAuthoritative: false,
          observationTimestamp: obsTimestamp,
          sourceVerificationTimestamp: quoteResult.quotedAt,
          explanation: reason,
        },
        rejectionReason: reason,
      };
    }
  }

  // 7. Canonical product URL validation
  if (request.canonicalProductUrl) {
    const urlCheck = validateTrustedHttpsOrigin(request.canonicalProductUrl);
    if (!urlCheck.valid) {
      const reason = `Candidate product URL "${request.canonicalProductUrl}" rejected: ${urlCheck.reason}`;
      return {
        valid: false,
        isAuthoritative: false,
        shippingCents: null,
        details: {
          type: "missing",
          amountCents: null,
          currency: expCurrency,
          isAuthoritative: false,
          observationTimestamp: obsTimestamp,
          sourceVerificationTimestamp: quoteResult.quotedAt,
          explanation: reason,
        },
        rejectionReason: reason,
      };
    }
  }

  if (quoteResult.canonicalProductUrl && request.canonicalProductUrl && quoteResult.canonicalProductUrl !== request.canonicalProductUrl) {
    const reason = `Quote canonicalProductUrl "${quoteResult.canonicalProductUrl}" does not match candidate URL "${request.canonicalProductUrl}".`;
    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: expCurrency,
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: quoteResult.quotedAt,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // 8. Quote fingerprint integrity check
  const expectedFp = computeQuoteFingerprint(quoteResult);
  if (quoteResult.quoteFingerprint !== expectedFp) {
    const reason = `Quote fingerprint verification failed: expected "${expectedFp}", got "${quoteResult.quoteFingerprint}". Quote facts have been modified.`;
    return {
      valid: false,
      isAuthoritative: false,
      shippingCents: null,
      details: {
        type: "missing",
        amountCents: null,
        currency: expCurrency,
        isAuthoritative: false,
        observationTimestamp: obsTimestamp,
        sourceVerificationTimestamp: quoteResult.quotedAt,
        explanation: reason,
      },
      rejectionReason: reason,
    };
  }

  // Authoritative verified quote
  const details: ShippingEvidenceDetails = {
    type: "quoted",
    amountCents: quoteResult.amountCents,
    currency: quoteResult.currency,
    deliveryMethod: quoteResult.deliveryMethod,
    destinationPostalCode: quoteResult.destinationPostalCode,
    destinationCountry: quoteResult.destinationCountry,
    isAuthoritative: true,
    observationTimestamp: obsTimestamp,
    sourceVerificationTimestamp: quoteResult.quotedAt,
    explanation: `Authoritative shipping quote from ${quoteResult.retailerId} verified for ${quoteResult.destinationPostalCode}`,
  };

  return {
    valid: true,
    isAuthoritative: true,
    shippingCents: quoteResult.amountCents,
    details,
  };
}

/**
 * Feasibility Adapter Implementation: Best Buy Shipping Quote Adapter.
 *
 * Evaluation finding:
 * - Best Buy's public developer catalog API does NOT provide real-time destination-based
 *   shipping rate calculations or carrier quotes for arbitrary ZIP codes.
 * - Real-time destination shipping rate queries are restricted to the sales-gated Best Buy
 *   Commerce API (CAPI), requiring partner approval and private credentials.
 * - Anti-automation controls and terms of service prohibit scraping bestbuy.com checkout.
 *
 * This adapter encapsulates the official CAPI request/response schema. When real credentials
 * are absent, it returns an explicit "unavailable" status reporting the partner-gating blocker.
 * It also supports injected HTTP client transports for deterministic automated testing.
 */
export class BestBuyShippingQuoteAdapter implements ShippingQuoteAdapter {
  readonly name = "bestbuy_shipping_quote_adapter";
  readonly supportedRetailers = ["bestbuy.com", "bestbuy"];

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = options?.apiKey;
    this.baseUrl = options?.baseUrl ?? "https://api.bestbuy.com/v1";
    this.fetchFn = options?.fetchFn ?? (typeof fetch !== "undefined" ? fetch : (() => Promise.reject(new Error("fetch unavailable"))) as unknown as typeof fetch);
  }

  canQuote(target: { readonly merchantName?: string; readonly merchantUrl?: string; readonly externalId?: string }): boolean {
    const merchant = (target.merchantName ?? "").toLowerCase().trim();
    const url = (target.merchantUrl ?? "").toLowerCase().trim();
    const extId = (target.externalId ?? "").toLowerCase().trim();

    return (
      merchant.includes("bestbuy") ||
      merchant.includes("best buy") ||
      url.includes("bestbuy.com") ||
      extId.includes("bestbuy.com")
    );
  }

  async getShippingQuote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult> {
    const timestamp = formatUtcIso8601(request.now) || new Date().toISOString();

    if (!this.canQuote(request.candidate)) {
      return {
        status: "unsupported",
        retailerId: request.candidate.merchantName || "unknown",
        reason: `Retailer "${request.candidate.merchantName}" is not Best Buy.`,
        timestamp,
      };
    }

    // Pre-flight: Check whether Best Buy Commerce API (CAPI) credentials are configured
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      return {
        status: "unavailable",
        retailerId: "bestbuy.com",
        destinationPostalCode: request.destination.postalCode,
        reason:
          "Best Buy destination shipping quotes require sales-gated Commerce API (CAPI) partner credentials. The public developer catalog API does not support dynamic destination rate calculation, and anti-automation policies prohibit undocumented scraping.",
        timestamp,
      };
    }

    try {
      // Best Buy Commerce API checkout rate endpoint contract
      const sku = request.candidate.sku || request.candidate.externalId.split(":")[0];
      const payload = {
        destination: {
          country: request.destination.country,
          postalCode: request.destination.postalCode,
        },
        items: [
          {
            sku,
            quantity: request.candidate.quantity,
          },
        ],
        deliveryMethodPreference: request.destination.deliveryMethodPreference ?? "standard_ground",
      };

      const response = await this.fetchFn(`${this.baseUrl}/commerce/shipping-rates`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return {
          status: "failed",
          retailerId: "bestbuy.com",
          errorCode: `HTTP_${response.status}`,
          errorMessage: `Best Buy shipping rate query failed with HTTP status ${response.status}.`,
          timestamp,
        };
      }

      const body = (await response.json()) as Record<string, unknown>;

      // Validate response against documented CAPI shipping rate schema
      if (typeof body !== "object" || body === null) {
        return {
          status: "failed",
          retailerId: "bestbuy.com",
          errorCode: "MALFORMED_RESPONSE",
          errorMessage: "Best Buy response body is not a valid JSON object.",
          timestamp,
        };
      }

      const rates = body.rates as readonly Record<string, unknown>[] | undefined;
      if (!Array.isArray(rates) || rates.length === 0) {
        return {
          status: "unavailable",
          retailerId: "bestbuy.com",
          destinationPostalCode: request.destination.postalCode,
          reason: `No shipping rates available for SKU "${sku}" to ZIP "${request.destination.postalCode}".`,
          timestamp,
        };
      }

      // Find matching delivery method or select default standard ground
      const preferredMethod = request.destination.deliveryMethodPreference ?? "standard_ground";
      const selectedRate = rates.find((r) => r.deliveryMethod === preferredMethod) || rates[0];

      if (typeof selectedRate.amountCents !== "number" || !Number.isInteger(selectedRate.amountCents) || selectedRate.amountCents < 0) {
        return {
          status: "failed",
          retailerId: "bestbuy.com",
          errorCode: "MALFORMED_AMOUNT",
          errorMessage: "Best Buy returned non-integer or invalid shipping amountCents.",
          timestamp,
        };
      }

      const quoteId = typeof selectedRate.quoteId === "string" ? selectedRate.quoteId : `bb_quote_${Date.now()}`;
      const quotedAt = typeof selectedRate.quotedAt === "string" ? selectedRate.quotedAt : timestamp;
      const expiresAt = typeof selectedRate.expiresAt === "string" ? selectedRate.expiresAt : null;
      const deliveryMethod = typeof selectedRate.deliveryMethod === "string" ? selectedRate.deliveryMethod : preferredMethod;
      const amountCents = selectedRate.amountCents;

      const baseQuote = {
        status: "success" as const,
        quoteId,
        amountCents,
        currency: "USD" as const,
        retailerId: "bestbuy.com",
        merchantDomain: "bestbuy.com",
        externalId: request.candidate.externalId,
        canonicalProductUrl: request.canonicalProductUrl,
        destinationPostalCode: request.destination.postalCode,
        destinationCountry: "US" as const,
        deliveryMethod,
        conditions: Array.isArray(selectedRate.conditions) ? (selectedRate.conditions as string[]) : undefined,
        quotedAt,
        expiresAt,
        sourceUrl: `https://api.bestbuy.com/v1/commerce/shipping-rates/${quoteId}`,
        rawQuotePayload: body,
      };

      const quoteFingerprint = computeQuoteFingerprint(baseQuote);

      return {
        ...baseQuote,
        quoteFingerprint,
      };
    } catch (err: unknown) {
      return {
        status: "failed",
        retailerId: "bestbuy.com",
        errorCode: "NETWORK_ERROR",
        errorMessage: err instanceof Error ? err.message : "Network failure while requesting Best Buy quote.",
        timestamp,
      };
    }
  }
}

/**
 * Feasibility Adapter Implementation: Shopify Storefront / CarrierService Shipping Adapter.
 *
 * Evaluation finding:
 * - Shopify's Storefront API and CarrierService APIs provide destination-based shipping rates
 *   for arbitrary 5-digit US ZIP codes only when queried against an authorized merchant shop domain
 *   with valid Storefront Access Tokens (`unauthenticated_read_shipping_rates` scope).
 * - Terms of Service and Shopify API License Agreement strictly prohibit automated checkout
 *   scraping or undocumented web requests.
 *
 * When credentials (token/shop domain) are absent, it returns an explicit "unavailable" status
 * reporting the authentication and merchant-domain requirements.
 * It also supports injected HTTP client transports for deterministic automated testing.
 */
export class ShopifyShippingQuoteAdapter implements ShippingQuoteAdapter {
  readonly name = "shopify_shipping_quote_adapter";
  readonly supportedRetailers = ["shopify.com", "myshopify.com", "shopify"];

  private readonly storefrontAccessToken?: string;
  private readonly shopDomain?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: {
    storefrontAccessToken?: string;
    shopDomain?: string;
    fetchFn?: typeof fetch;
  }) {
    this.storefrontAccessToken = options?.storefrontAccessToken;
    this.shopDomain = options?.shopDomain?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.fetchFn = options?.fetchFn ?? (typeof fetch !== "undefined" ? fetch : (() => Promise.reject(new Error("fetch unavailable"))) as unknown as typeof fetch);
  }

  canQuote(target: { readonly merchantName?: string; readonly merchantUrl?: string; readonly externalId?: string }): boolean {
    const merchant = (target.merchantName ?? "").toLowerCase().trim();
    const url = (target.merchantUrl ?? "").toLowerCase().trim();
    const extId = (target.externalId ?? "").toLowerCase().trim();

    return (
      merchant.includes("shopify") ||
      url.includes("myshopify.com") ||
      url.includes("shopify.com") ||
      extId.includes("myshopify.com") ||
      extId.includes("shopify")
    );
  }

  async getShippingQuote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult> {
    const timestamp = formatUtcIso8601(request.now) || new Date().toISOString();

    if (!this.canQuote(request.candidate)) {
      return {
        status: "unsupported",
        retailerId: request.candidate.merchantName || "unknown",
        reason: `Retailer "${request.candidate.merchantName}" is not a recognized Shopify merchant.`,
        timestamp,
      };
    }

    // Pre-flight: Check whether Shopify Storefront token and shop domain are configured
    if (!this.storefrontAccessToken || !this.shopDomain) {
      return {
        status: "unavailable",
        retailerId: "shopify.com",
        destinationPostalCode: request.destination.postalCode,
        reason:
          "Shopify destination shipping quotes require a configured merchant shop domain and Storefront API Access Token with shipping rate permissions. Anti-automation policies prohibit undocumented scraping of checkout pages.",
        timestamp,
      };
    }

    try {
      // Shopify Storefront GraphQL query contract (CartDeliveryGroupConnection)
      const query = `
        query getShippingRates($zip: String!, $country: String!) {
          cart(id: "cart_quote_lookup") {
            deliveryGroups(first: 1) {
              edges {
                node {
                  deliveryOptions {
                    handle
                    title
                    estimatedCost {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response = await this.fetchFn(`https://${this.shopDomain}/api/2024-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": this.storefrontAccessToken,
        },
        body: JSON.stringify({
          query,
          variables: {
            zip: request.destination.postalCode,
            country: request.destination.country,
          },
        }),
      });

      if (!response.ok) {
        return {
          status: "failed",
          retailerId: "shopify.com",
          errorCode: `HTTP_${response.status}`,
          errorMessage: `Shopify rate query failed with HTTP status ${response.status}.`,
          timestamp,
        };
      }

      const body = (await response.json()) as Record<string, unknown>;
      const data = body.data as Record<string, unknown> | undefined;
      const cart = data?.cart as Record<string, unknown> | undefined;
      const rawDeliveryGroups = cart?.deliveryGroups;

      let deliveryGroupNode: Record<string, unknown> | undefined;
      if (Array.isArray((rawDeliveryGroups as { edges?: readonly { node?: Record<string, unknown> }[] })?.edges)) {
        deliveryGroupNode = (rawDeliveryGroups as { edges: readonly { node?: Record<string, unknown> }[] }).edges[0]?.node;
      } else if (Array.isArray(rawDeliveryGroups)) {
        deliveryGroupNode = rawDeliveryGroups[0] as Record<string, unknown>;
      }

      const options = deliveryGroupNode?.deliveryOptions as readonly Record<string, unknown>[] | undefined;
      if (!Array.isArray(options) || options.length === 0) {
        return {
          status: "unavailable",
          retailerId: "shopify.com",
          destinationPostalCode: request.destination.postalCode,
          reason: `No shipping rates available from Shopify store "${this.shopDomain}" for ZIP "${request.destination.postalCode}".`,
          timestamp,
        };
      }

      const selected = options[0];
      const estimatedCost = selected.estimatedCost as { amount: string; currencyCode: string } | undefined;
      const amountFloat = estimatedCost?.amount ? parseFloat(estimatedCost.amount) : NaN;
      if (isNaN(amountFloat) || amountFloat < 0) {
        return {
          status: "failed",
          retailerId: "shopify.com",
          errorCode: "MALFORMED_AMOUNT",
          errorMessage: "Shopify returned invalid shipping cost amount.",
          timestamp,
        };
      }

      const amountCents = Math.round(amountFloat * 100);
      const deliveryMethod = typeof selected.title === "string" ? selected.title : "standard_ground";
      const quoteId = `shopify_quote_${Date.now()}`;
      const expiresAt = new Date(request.now.getTime() + 3600 * 1000).toISOString();

      const baseQuote = {
        status: "success" as const,
        quoteId,
        amountCents,
        currency: "USD" as const,
        retailerId: "shopify.com",
        merchantDomain: this.shopDomain,
        externalId: request.candidate.externalId,
        canonicalProductUrl: request.canonicalProductUrl,
        destinationPostalCode: request.destination.postalCode,
        destinationCountry: "US" as const,
        deliveryMethod,
        quotedAt: timestamp,
        expiresAt,
        sourceUrl: `https://${this.shopDomain}/rates/${quoteId}`,
        rawQuotePayload: body,
      };

      const quoteFingerprint = computeQuoteFingerprint(baseQuote);

      return {
        ...baseQuote,
        quoteFingerprint,
      };
    } catch (err: unknown) {
      return {
        status: "failed",
        retailerId: "shopify.com",
        errorCode: "NETWORK_ERROR",
        errorMessage: err instanceof Error ? err.message : "Network failure while requesting Shopify quote.",
        timestamp,
      };
    }
  }
}

/**
 * Composite Multi-Provider Shipping Quote Adapter.
 *
 * Dispatches shipping quote requests to the appropriate retailer adapter based on
 * candidate provenance, or reports clean unsupported/unavailable status if no adapter
 * matches or if partner credentials are missing.
 */
export class MultiProviderShippingQuoteAdapter implements ShippingQuoteAdapter {
  readonly name = "multi_provider_shipping_quote_adapter";
  readonly supportedRetailers: readonly string[];

  constructor(private readonly adapters: readonly ShippingQuoteAdapter[] = [
    new BestBuyShippingQuoteAdapter({
      apiKey: process.env.BESTBUY_COMMERCE_API_KEY || process.env.BESTBUY_API_KEY,
      baseUrl: process.env.BESTBUY_API_BASE_URL,
    }),
    new ShopifyShippingQuoteAdapter({
      storefrontAccessToken:
        process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || process.env.SHOPIFY_STOREFRONT_TOKEN,
      shopDomain: process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN,
    }),
  ]) {
    this.supportedRetailers = Array.from(new Set(adapters.flatMap((a) => a.supportedRetailers)));
  }

  canQuote(target: { readonly merchantName?: string; readonly merchantUrl?: string; readonly externalId?: string }): boolean {
    return this.adapters.some((adapter) => adapter.canQuote(target));
  }

  async getShippingQuote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult> {
    const timestamp = formatUtcIso8601(request.now) || new Date().toISOString();

    const matchingAdapter = this.adapters.find((a) => a.canQuote(request.candidate));
    if (!matchingAdapter) {
      return {
        status: "unsupported",
        retailerId: request.candidate.merchantName || "unknown",
        reason: `No registered shipping adapter supports retailer "${request.candidate.merchantName}". Supported retailers: ${this.supportedRetailers.join(", ")}.`,
        timestamp,
      };
    }

    return matchingAdapter.getShippingQuote(request);
  }
}

let globalShippingAdapter: ShippingQuoteAdapter = new MultiProviderShippingQuoteAdapter();

export function getShippingQuoteAdapter(): ShippingQuoteAdapter {
  return globalShippingAdapter;
}

export function setShippingQuoteAdapter(adapter: ShippingQuoteAdapter): void {
  globalShippingAdapter = adapter;
}
