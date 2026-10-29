import { CandidateSource, Currency } from "../state/types";
import { computeDuplicateGroupKey, normalizeCandidate, normalizeMerchantAlias, parseCentsExact } from "./normalize";
import {
  CandidateDuplicateInfo,
  DiscoveryContext,
  DiscoveryResult,
  ProductSearchRequest,
  RawDiscoveredCandidate,
  SourceAdapter,
  SourceAdapterCapabilities,
} from "./types";
import { searchChannel3 } from "../channel3/client";
import {
  Channel3Error,
  Channel3SearchOptions,
  Channel3SearchResponse,
} from "../channel3/types";
import { getShippingQuoteAdapter, validateQuoteForCandidate } from "./shipping-quote";
import { getMerchantPolicyRegistry } from "./merchant-policy-registry";

export interface Channel3AdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  searchFn?: (options: Channel3SearchOptions) => Promise<Channel3SearchResponse>;
  defaultShippingCents?: number;
}

/**
 * Production Channel3 product discovery adapter implementing the SourceAdapter boundary.
 *
 * Untrusted data & evidence integrity principles:
 * - Upstream data is strictly untrusted.
 * - Missing shipping or stock data is never invented; missing critical fields cause normalization
 *   to mark the candidate incomplete so policy engines fail closed.
 * - Timestamps and specification proofs are not fabricated from titles.
 * - Fail-closed: unconfigured or failed upstream calls return explicit source_error or empty states,
 *   never falling back to synthetic fixtures masquerading as live products.
 */
export class Channel3SourceAdapter implements SourceAdapter {
  readonly name = "channel3_source_adapter";
  readonly source: CandidateSource = "channel3";
  private readonly options: Channel3AdapterOptions;

  constructor(options: Channel3AdapterOptions = {}) {
    this.options = options;
  }

  getCapabilities(): SourceAdapterCapabilities {
    return {
      name: this.name,
      supportedCurrencies: ["USD"],
      supportsStockStatus: true,
      supportsSpecificationAttributes: true,
      supportsPagination: false,
    };
  }

  async search(request: ProductSearchRequest, context: DiscoveryContext): Promise<DiscoveryResult> {
    const trimmedQuery = request.query.trim();
    if (trimmedQuery.length === 0) {
      return {
        status: "empty",
        reason: "Search query is empty.",
        timestamp: context.now,
      };
    }

    // Build Channel3 API filters from search constraints
    const filters: Record<string, unknown> = {};
    const constraints = request.constraints;

    if (constraints?.maxBudgetCents !== undefined && constraints.maxBudgetCents > 0) {
      // Channel3 expects price in standard currency units (dollars, not cents)
      filters.price = {
        max_price: constraints.maxBudgetCents / 100,
      };
    }

    if (constraints?.merchantAllowList && constraints.merchantAllowList.length > 0) {
      filters.website_ids = [...constraints.merchantAllowList];
    }

    // Execute upstream search
    let response: Channel3SearchResponse;
    try {
      const searchFn = this.options.searchFn ?? searchChannel3;
      response = await searchFn({
        query: trimmedQuery,
        limit: 20,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        timeoutMs: this.options.timeoutMs,
        fetchFn: this.options.fetchFn,
      });
    } catch (err: unknown) {
      if (err instanceof Channel3Error) {
        return {
          status: "source_error",
          errorCode: err.code,
          errorMessage: err.message,
          timestamp: context.now,
        };
      }

      return {
        status: "source_error",
        errorCode: "CHANNEL3_UNEXPECTED_ERROR",
        errorMessage: err instanceof Error ? err.message : "Unexpected Channel3 adapter failure.",
        timestamp: context.now,
      };
    }

    const rawCandidates: RawDiscoveredCandidate[] = [];
    const seenExternalIds = new Set<string>();
    const quoteAdapter = constraints?.destination ? getShippingQuoteAdapter() : null;
    const duplicateGroupMap = new Map<string, string>();

    for (const product of response.products) {
      if (!product.offers || product.offers.length === 0) {
        // Product has no merchant offers (no pricing or merchant buy link)
        continue;
      }

      for (let offerIdx = 0; offerIdx < product.offers.length; offerIdx++) {
        const offer = product.offers[offerIdx];
        const externalId = `${product.id}:${offer.domain || `offer_${offerIdx}`}`;

        // Deduplicate identical merchant offers
        if (seenExternalIds.has(externalId)) {
          continue;
        }
        seenExternalIds.add(externalId);

        // Normalize availability string
        let availabilityStr = "";
        if (typeof offer.availability === "string") {
          const availLower = offer.availability.toLowerCase().trim();
          if (availLower === "instock") {
            availabilityStr = "in_stock";
          } else if (availLower === "outofstock") {
            availabilityStr = "out_of_stock";
          } else {
            availabilityStr = availLower;
          }
        }

        // Price formatting: preserve exact decimal string
        let unitPriceStr: string | undefined = undefined;
        if (offer.price && typeof offer.price.price === "number") {
          unitPriceStr = offer.price.price.toFixed(2);
        }

        // Map structured attributes and provenance
        const rawAttributes: Record<string, unknown> = {
          ...(product.structured_attributes ?? {}),
          provider: "channel3",
          attribution: "Channel3 (trychannel3.com)",
          brand: product.brands?.[0]?.name,
          condition: offer.condition,
          commission_rate: offer.max_commission_rate,
          channel3_product_id: product.id,
        };

        if (product.materials && product.materials.length > 0) {
          rawAttributes.materials = product.materials.join(", ");
        }

        if (product.description) {
          rawAttributes.description = product.description;
        }

        // Destination-aware shipping evidence enrichment (Carrier Quotes & Deterministic Merchant Policies)
        let shippingVal = this.options.defaultShippingCents;
        let shippingTypeVal: string | undefined = undefined;
        let deliveryMethodVal: string | undefined = undefined;
        let destPostalVal: string | undefined = undefined;
        let destCountryVal: string | undefined = undefined;
        let capturedAtVal: string | undefined = undefined;
        let sourceVerificationTimestampVal: string | undefined = undefined;
        let policyIdVal: string | undefined = undefined;
        let policyFingerprintVal: string | undefined = undefined;
        let policySourceUrlVal: string | undefined = undefined;
        let geographicZoneVal: import("./geographic-zones").GeographicZone | undefined = undefined;
        let serviceabilityStatusVal: import("./geographic-zones").DestinationServiceability | undefined = undefined;
        let thresholdCentsVal: number | undefined = undefined;

        const unitPriceCheck = parseCentsExact(unitPriceStr, "unitPrice");
        const parsedUnitPriceCents =
          unitPriceCheck.valid && unitPriceCheck.cents !== undefined ? unitPriceCheck.cents : 0;

        const offerAny = offer as Record<string, unknown>;
        const sellerName =
          (typeof offerAny.seller === "string" ? offerAny.seller : undefined) ??
          (typeof offerAny.seller_name === "string" ? offerAny.seller_name : undefined) ??
          (typeof rawAttributes.seller === "string" ? rawAttributes.seller : undefined) ??
          (typeof rawAttributes.seller_name === "string" ? rawAttributes.seller_name : undefined);

        let isDirectRetailerSeller: boolean | undefined = undefined;
        if (offerAny.is_direct_retailer === true || rawAttributes.is_direct_retailer === true) {
          isDirectRetailerSeller = true;
        } else if (offerAny.is_direct_retailer === false || rawAttributes.is_direct_retailer === false) {
          isDirectRetailerSeller = false;
        } else if (sellerName !== undefined && offer.domain !== undefined) {
          isDirectRetailerSeller =
            normalizeMerchantAlias(sellerName) === normalizeMerchantAlias(offer.domain);
        }

        const isMarketplace =
          offerAny.is_marketplace === true ||
          offerAny.marketplace === true ||
          rawAttributes.is_marketplace === true ||
          rawAttributes.marketplace === true ||
          (sellerName !== undefined &&
            offer.domain !== undefined &&
            normalizeMerchantAlias(sellerName) !== normalizeMerchantAlias(offer.domain)) ||
          isDirectRetailerSeller === false;

        const isWfsFulfilled =
          offerAny.is_wfs === true ||
          offerAny.wfs === true ||
          rawAttributes.is_wfs === true ||
          rawAttributes.fulfilled_by === "Walmart" ||
          rawAttributes.fulfilled_by === "WFS";

        const requiresSpecialDelivery =
          offerAny.requires_special_delivery === true ||
          rawAttributes.requires_special_delivery === true;

        const isFreeShippingEligibleItem =
          offerAny.free_shipping_eligible === true ||
          rawAttributes.free_shipping_eligible === true ||
          rawAttributes.is_free_shipping_eligible === true;

        if (constraints?.destination && parsedUnitPriceCents > 0) {
          // Priority 1: Query dynamic carrier quote adapter
          let quoteFailedWithHardBlocker = false;

          if (quoteAdapter) {
            try {
              const quoteRequest = {
                candidate: {
                  externalId,
                  merchantName: offer.domain || "Unknown Merchant",
                  merchantUrl: offer.url || "",
                  unitPriceCents: parsedUnitPriceCents,
                  quantity: constraints.minQuantity ?? 1,
                  currency: ((offer.price?.currency || "").toUpperCase() as Currency) || "USD",
                  productId: product.id,
                  sku: product.id,
                },
                canonicalProductUrl: offer.url || "",
                destination: constraints.destination,
                requestedCurrency: "USD" as Currency,
                now: context.now,
              };

              const quoteRes = await quoteAdapter.getShippingQuote(quoteRequest);
              const quoteValidation = validateQuoteForCandidate(quoteRes, quoteRequest);

              if (quoteValidation.valid && quoteValidation.shippingCents !== null && quoteRes.status === "success") {
                shippingVal = quoteValidation.shippingCents;
                shippingTypeVal = "quoted";
                deliveryMethodVal = quoteRes.deliveryMethod;
                destPostalVal = quoteRes.destinationPostalCode;
                destCountryVal = quoteRes.destinationCountry;
                capturedAtVal = quoteRes.quotedAt;
                sourceVerificationTimestampVal = quoteRes.quotedAt;
              } else {
                const statusStr = quoteRes.status !== "success" ? quoteRes.status : "quote_validation_failed";
                rawAttributes.shipping_blocker_status = statusStr;
                rawAttributes.shipping_blocker_reason =
                  quoteValidation.rejectionReason ||
                  ("reason" in quoteRes
                    ? quoteRes.reason
                    : "errorMessage" in quoteRes
                    ? quoteRes.errorMessage
                    : "Shipping quote validation failed");

                // Phase 13A Hard Invariant: If a quote adapter is actively configured and was queried,
                // and returned an expired quote, validation failure (mismatched destination, expired, tampered),
                // or explicit unconfigured blocker, do not silently discard the quote blocker or fall back to free policy.
                if (
                  quoteRes.status !== "unsupported" &&
                  (quoteRes.status as string) !== "unserviceable"
                ) {
                  quoteFailedWithHardBlocker = true;
                }
              }
            } catch {
              // Fail closed; leave shippingVal as unquoted
            }
          }

          // Priority 2: If dynamic quote is absent, unsupported, or unserviceable (and not a hard quote rejection),
          // evaluate published merchant policy engine
          if (shippingVal === undefined && !quoteFailedWithHardBlocker) {
            const policyOutcome = getMerchantPolicyRegistry().evaluateCandidate({
              candidate: {
                externalId,
                unitPriceCents: parsedUnitPriceCents,
                quantity: constraints.minQuantity ?? 1,
                merchantName: offer.domain || "Unknown Merchant",
                merchantUrl: offer.url,
                title: product.title,
                sellerName,
                isMarketplace,
                isDirectRetailerSeller,
                isWfsFulfilled,
                requiresSpecialDelivery,
                isFreeShippingEligibleItem,
                rawAttributes,
              },
              destination: constraints.destination,
              now: context.now,
              requestedCurrency: "USD",
            });

            if (policyOutcome) {
              if (
                policyOutcome.status === "satisfied" &&
                policyOutcome.isApplicable &&
                policyOutcome.shippingCents !== null
              ) {
                shippingVal = policyOutcome.shippingCents;
                shippingTypeVal = "policy_derived";
                deliveryMethodVal = policyOutcome.deliveryMethod ?? "standard_ground";
                destPostalVal = constraints.destination.postalCode;
                destCountryVal = constraints.destination.country;
                capturedAtVal = context.now.toISOString();
                sourceVerificationTimestampVal = context.now.toISOString();
                policyIdVal = policyOutcome.policyId;
                policyFingerprintVal = policyOutcome.policyDocumentFingerprint;
                policySourceUrlVal = policyOutcome.policySourceUrl;
                geographicZoneVal = policyOutcome.geographicZone;
                serviceabilityStatusVal = policyOutcome.serviceability;
                thresholdCentsVal = policyOutcome.thresholdCents;

                rawAttributes.shipping_policy_id = policyOutcome.policyId;
                rawAttributes.shipping_policy_status = "satisfied";
                rawAttributes.shipping_policy_source_url = policyOutcome.policySourceUrl;
                rawAttributes.shipping_policy_explanation = policyOutcome.explanation;
                delete rawAttributes.shipping_blocker_status;
                delete rawAttributes.shipping_blocker_reason;
              } else {
                // Document policy evaluation failure details alongside carrier blocker status
                rawAttributes.shipping_policy_status = policyOutcome.status;
                rawAttributes.shipping_policy_explanation = policyOutcome.explanation;
                if (!rawAttributes.shipping_blocker_status) {
                  rawAttributes.shipping_blocker_status = policyOutcome.status;
                  rawAttributes.shipping_blocker_reason = policyOutcome.explanation;
                }
              }
            }
          }
        }

        const rawCandidate: RawDiscoveredCandidate = {
          externalId,
          title: product.title,
          merchantName: offer.domain || "Unknown Merchant",
          merchantUrl: offer.url,
          unitPrice: unitPriceStr,
          quantity: constraints?.minQuantity ?? 1,
          currency: (offer.price?.currency || "").toUpperCase() as Currency,
          availability: availabilityStr,
          sellerName,
          isMarketplace,
          isDirectRetailer: isDirectRetailerSeller,
          fulfillmentMethod: isWfsFulfilled ? "WFS" : undefined,
          // Shipping is absent from Channel3 offers unless enriched by authoritative destination quote adapter or policy engine
          shipping: shippingVal,
          shippingType: shippingTypeVal,
          deliveryMethod: deliveryMethodVal,
          destinationPostalCode: destPostalVal,
          destinationCountry: destCountryVal,
          requiresDestination: Boolean(constraints?.destination),
          policyId: policyIdVal,
          policyDocumentFingerprint: policyFingerprintVal,
          policySourceUrl: policySourceUrlVal,
          geographicZone: geographicZoneVal,
          serviceabilityStatus: serviceabilityStatusVal,
          thresholdCents: thresholdCentsVal,
          // CapturedAt is set when verified source timestamp is provided
          capturedAt: capturedAtVal,
          sourceVerificationTimestamp: sourceVerificationTimestampVal,
          sourceUrl: offer.url,
          provider: "channel3",
          attribution: "Channel3 product search API (https://trychannel3.com)",
          productId: product.id,
          rawAttributes,
          rawSourceData: {
            provider: "channel3",
            attribution: "Channel3 product search API (https://trychannel3.com)",
            productId: product.id,
            domain: offer.domain,
            offerUrl: offer.url,
            rawProduct: product,
            rawOffer: offer,
          },
        };

        rawCandidates.push(rawCandidate);
      }
    }

    if (rawCandidates.length === 0) {
      return {
        status: "empty",
        reason: `No merchant offers found for query "${request.query}".`,
        timestamp: context.now,
      };
    }

    // Normalize each candidate through the standard deterministic normalizer with duplicate offer tracking
    const normalizedList = rawCandidates.map((raw, idx) => {
      const candidateId = context.candidateIdGenerator
        ? context.candidateIdGenerator()
        : `cand_ch3_${idx + 1}_${String(raw.externalId || "unknown")}`;

      const duplicateGroupKey = computeDuplicateGroupKey({
        merchantName: raw.merchantName as string,
        merchantUrl: raw.merchantUrl as string,
        title: raw.title as string,
        externalId: raw.externalId as string,
      });

      const isDuplicate = duplicateGroupMap.has(duplicateGroupKey);
      const canonicalExternalId = duplicateGroupMap.get(duplicateGroupKey) || String(raw.externalId);
      if (!isDuplicate) {
        duplicateGroupMap.set(duplicateGroupKey, canonicalExternalId);
      }

      const duplicateInfo: CandidateDuplicateInfo = {
        isDuplicate,
        duplicateGroupKey,
        canonicalExternalId,
        duplicateReason: isDuplicate
          ? `Duplicate offer of primary candidate "${canonicalExternalId}"`
          : "Primary offer in group",
      };

      return normalizeCandidate(raw, {
        purchaseId: request.purchaseId,
        source: this.source,
        now: context.now,
        candidateId,
        duplicateInfo,
        requiredAttributes: constraints?.requiredAttributes,
      });
    });

    // Apply constraints filter
    let filtered = normalizedList;

    if (constraints) {
      if (constraints.maxBudgetCents !== undefined && constraints.maxBudgetCents > 0) {
        // For complete candidates, verify budget; incomplete candidates are preserved for visibility/review
        filtered = filtered.filter(
          (c) => !c.isComplete || c.totalCents <= (constraints.maxBudgetCents as number)
        );
      }

      if (constraints.merchantAllowList && constraints.merchantAllowList.length > 0) {
        const allowed = new Set(constraints.merchantAllowList.map((m) => m.toLowerCase().trim()));
        filtered = filtered.filter((c) => allowed.has(c.merchantName.toLowerCase().trim()));
      }
    }

    if (filtered.length === 0) {
      return {
        status: "empty",
        reason: `Products matched query "${request.query}", but none satisfied the search constraints.`,
        timestamp: context.now,
      };
    }

    return {
      status: "success",
      candidates: filtered,
      totalFound: filtered.length,
      timestamp: context.now,
    };
  }
}
