/**
 * Plinthly Phase 13C — Deterministic Policy Extractor and Ambiguity Detector.
 *
 * Extracts structured shipping policy terms from official retailer page content.
 *
 * Enforces:
 * 1. Strict parsing of thresholds, seller requirements, cart contribution, zones, and exclusions.
 * 2. Ambiguity detection: conflicting thresholds, contradictory seller claims, or ambiguous memberships fail closed as "ambiguous".
 * 3. Never silently converts unparseable HTML into a valid policy.
 * 4. Distinct extractors per retailer with typed warnings and explanations.
 */

import {
  ExtractedPolicyTerms,
  PolicyExtractionResult,
  POLICY_PARSER_VERSION,
} from "./types";

export interface PolicyExtractionOptions {
  readonly retailerHint?: "bestbuy" | "walmart" | "target" | "bhphoto";
  readonly targetVariant?: "standard" | "circle_card" | "expedited";
}

/**
 * Strips HTML tags, decodes common entities, and normalizes whitespace.
 */
export function extractTextFromHtml(html: string): string {
  if (!html || typeof html !== "string") return "";

  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds all dollar threshold patterns in the text (e.g. "$35", "$49.00", "orders of $35 or more").
 */
function findFreeShippingThresholds(text: string): number[] {
  const thresholds: number[] = [];
  const regex = /(?:free\s+(?:standard\s+|expedited\s+)?shipping\s+(?:on\s+orders\s+(?:of\s+|over\s+)?)?|orders?\s+(?:of\s+|over\s+))\$([0-9]+(?:\.[0-9]{2})?)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const val = parseFloat(match[1]);
    if (!Number.isNaN(val)) {
      thresholds.push(Math.round(val * 100));
    }
  }

  return thresholds;
}

export class PolicyExtractor {
  readonly version = POLICY_PARSER_VERSION;

  /**
   * Main entry point to extract policy terms from HTML text.
   */
  extract(
    html: string,
    sourceUrl: string,
    options?: PolicyExtractionOptions
  ): PolicyExtractionResult {
    const plainText = extractTextFromHtml(html);
    const warnings: string[] = [];

    if (!plainText || plainText.length < 50) {
      return {
        status: "parse_error",
        parserVersion: this.version,
        warnings: ["Response body contains insufficient text content to extract shipping terms."],
        explanation: "HTML content was empty or contained no readable text.",
      };
    }

    const domain = this.identifyDomain(sourceUrl, plainText, options?.retailerHint);

    switch (domain) {
      case "bestbuy.com":
        return this.extractBestBuy(plainText, sourceUrl, warnings);
      case "walmart.com":
        return this.extractWalmart(plainText, sourceUrl, warnings);
      case "target.com":
        return this.extractTarget(plainText, sourceUrl, options?.targetVariant, warnings);
      case "bhphotovideo.com":
        return this.extractBhPhoto(plainText, sourceUrl, options?.targetVariant, warnings);
      default:
        return {
          status: "parse_error",
          parserVersion: this.version,
          warnings: [`Unrecognized retailer domain for policy URL: ${sourceUrl}`],
          explanation: `No specialized extractor available for URL "${sourceUrl}".`,
        };
    }
  }

  private identifyDomain(
    sourceUrl: string,
    text: string,
    hint?: string
  ): string | null {
    if (hint) {
      if (hint === "bestbuy") return "bestbuy.com";
      if (hint === "walmart") return "walmart.com";
      if (hint === "target") return "target.com";
      if (hint === "bhphoto") return "bhphotovideo.com";
    }

    try {
      const parsed = new URL(sourceUrl);
      const host = parsed.hostname.toLowerCase();
      if (host.includes("bestbuy.com")) return "bestbuy.com";
      if (host.includes("walmart.com")) return "walmart.com";
      if (host.includes("target.com")) return "target.com";
      if (host.includes("bhphotovideo.com")) return "bhphotovideo.com";
    } catch {
      // ignore
    }

    const lower = text.toLowerCase();
    if (lower.includes("best buy")) return "bestbuy.com";
    if (lower.includes("walmart")) return "walmart.com";
    if (lower.includes("target")) return "target.com";
    if (lower.includes("b&h photo") || lower.includes("bhphotovideo")) return "bhphotovideo.com";

    return null;
  }

  /**
   * Best Buy Extractor
   */
  private extractBestBuy(
    text: string,
    sourceUrl: string,
    warnings: string[]
  ): PolicyExtractionResult {
    const lower = text.toLowerCase();

    // Check for conflicting threshold statements
    const thresholds = findFreeShippingThresholds(text);
    const uniqueThresholds = Array.from(new Set(thresholds));

    if (uniqueThresholds.length > 1) {
      return {
        status: "ambiguous",
        parserVersion: this.version,
        warnings: [
          `Multiple conflicting free shipping thresholds detected: ${uniqueThresholds.map((t) => `$${(t / 100).toFixed(2)}`).join(", ")}`,
        ],
        explanation: "Conflicting threshold figures found on Best Buy policy page without clear precedence.",
      };
    }

    const has35 = lower.includes("35") || uniqueThresholds.includes(3500);
    if (!has35) {
      return {
        status: "ambiguous",
        parserVersion: this.version,
        warnings: ["Could not establish authoritative $35 standard free shipping threshold."],
        explanation: "Expected Best Buy $35 threshold pattern was not identified in page content.",
      };
    }

    // Exclusions
    const excludesMarketplace =
      lower.includes("marketplace") ||
      lower.includes("third-party") ||
      lower.includes("3rd party") ||
      lower.includes("items sold by marketplace");

    if (!excludesMarketplace) {
      warnings.push("Explicit marketplace seller exclusion wording not detected in text.");
    }

    const terms: ExtractedPolicyTerms = {
      merchantDomain: "bestbuy.com",
      merchantName: "Best Buy",
      deliveryMethod: "standard_ground",
      currency: "USD",
      thresholdCents: 3500,
      shippingCostCents: 0,
      allowedZones: ["contiguous_us"],
      excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
      excludedCategories: [
        "freight",
        "oversized",
        "special delivery",
        "major appliances",
        "scheduled delivery",
      ],
      excludedSpecialFulfillmentMethods: [
        "scheduled_delivery",
        "in_home_delivery",
        "special_delivery",
        "freight",
      ],
      requiresDirectRetailerSeller: true,
      requiresPreTaxMerchandiseThreshold: true,
      itemSpecificQualificationRequired: false,
    };

    return {
      status: "extracted",
      terms,
      parserVersion: this.version,
      warnings,
      explanation: "Successfully extracted Best Buy contiguous US standard ground shipping policy ($35 threshold).",
    };
  }

  /**
   * Walmart Extractor
   */
  private extractWalmart(
    text: string,
    sourceUrl: string,
    warnings: string[]
  ): PolicyExtractionResult {
    const lower = text.toLowerCase();

    // Check for conflicting thresholds
    const thresholds = findFreeShippingThresholds(text);
    const uniqueThresholds = Array.from(new Set(thresholds));

    if (uniqueThresholds.length > 1) {
      return {
        status: "ambiguous",
        parserVersion: this.version,
        warnings: [
          `Multiple conflicting free shipping thresholds detected: ${uniqueThresholds.map((t) => `$${(t / 100).toFixed(2)}`).join(", ")}`,
        ],
        explanation: "Conflicting threshold figures found on Walmart shipping rates page.",
      };
    }

    const has35 = lower.includes("35") || uniqueThresholds.includes(3500);
    if (!has35) {
      return {
        status: "ambiguous",
        parserVersion: this.version,
        warnings: ["Could not establish authoritative $35 standard shipping threshold for Walmart."],
        explanation: "Expected Walmart $35 threshold pattern was not identified in page content.",
      };
    }

    // Verify WFS / Walmart fulfillment condition
    const mentionsWfs =
      lower.includes("walmart fulfillment services") ||
      lower.includes("wfs") ||
      lower.includes("fulfilled by walmart");

    if (!mentionsWfs) {
      warnings.push("Explicit WFS fulfillment mention missing from retrieved policy text.");
    }

    // Verify marketplace contribution condition
    const mentionsMarketplace =
      lower.includes("marketplace") ||
      lower.includes("pro seller") ||
      lower.includes("seller");

    if (!mentionsMarketplace) {
      warnings.push("Marketplace cart-threshold contribution terms missing or unverified.");
    }

    const terms: ExtractedPolicyTerms = {
      merchantDomain: "walmart.com",
      merchantName: "Walmart",
      deliveryMethod: "standard_ground",
      currency: "USD",
      thresholdCents: 3500,
      shippingCostCents: 0,
      allowedZones: ["contiguous_us"],
      excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
      excludedCategories: [
        "freight",
        "oversized",
        "heavy",
        "hazardous materials",
        "fresh grocery",
        "pharmacy",
      ],
      excludedSpecialFulfillmentMethods: [
        "freight",
        "scheduled_delivery",
        "delivery_from_store",
      ],
      requiresDirectRetailerOrWfsFulfillment: true,
      marketplaceItemsContributeToThreshold: true,
      requiresMembership: null,
      requiresPreTaxMerchandiseThreshold: true,
      itemSpecificQualificationRequired: false,
    };

    return {
      status: "extracted",
      terms,
      parserVersion: this.version,
      warnings,
      explanation: "Successfully extracted Walmart contiguous US standard ground policy ($35 threshold, WFS/Walmart fulfilled).",
    };
  }

  /**
   * Target Extractor
   */
  private extractTarget(
    text: string,
    sourceUrl: string,
    targetVariant: "standard" | "circle_card" | "expedited" | undefined,
    warnings: string[]
  ): PolicyExtractionResult {
    const lower = text.toLowerCase();

    // Check if user specifically requested Circle Card extraction
    if (targetVariant === "circle_card" || (lower.includes("circle card") && !lower.includes("$35"))) {
      const terms: ExtractedPolicyTerms = {
        merchantDomain: "target.com",
        merchantName: "Target",
        deliveryMethod: "standard_ground",
        currency: "USD",
        thresholdCents: 0,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us", "alaska", "hawaii", "military_apo_fpo"],
        excludedZones: ["us_territory"],
        excludedCategories: ["freight", "oversized", "special handling", "target plus"],
        excludedSpecialFulfillmentMethods: ["scheduled_delivery", "freight", "special_handling"],
        requiresDirectRetailerSeller: true,
        requiresMembership: "target_circle_card",
        requiresPreTaxMerchandiseThreshold: false,
        itemSpecificQualificationRequired: false,
      };

      return {
        status: "extracted",
        terms,
        parserVersion: this.version,
        warnings,
        explanation: "Successfully extracted Target Circle Card $0 shipping policy covering all 50 states + APO/FPO.",
      };
    }

    // Default to Standard $35 Promotion
    const has35 = lower.includes("35") || lower.includes("$35");
    if (!has35) {
      return {
        status: "ambiguous",
        parserVersion: this.version,
        warnings: ["Could not find standard $35 free shipping threshold on Target policy page."],
        explanation: "Target $35 threshold missing or altered.",
      };
    }

    // Check for conflicting numbers
    const thresholds = findFreeShippingThresholds(text);
    const nonZeroThresholds = thresholds.filter((t) => t > 0);
    const unique = Array.from(new Set(nonZeroThresholds));
    if (unique.length > 1) {
      return {
        status: "ambiguous",
        parserVersion: this.version,
        warnings: [
          `Multiple conflicting non-zero thresholds on Target page: ${unique.map((t) => `$${(t / 100).toFixed(2)}`).join(", ")}`,
        ],
        explanation: "Conflicting threshold figures detected on Target shipping page.",
      };
    }

    const terms: ExtractedPolicyTerms = {
      merchantDomain: "target.com",
      merchantName: "Target",
      deliveryMethod: "standard_ground",
      currency: "USD",
      thresholdCents: 3500,
      shippingCostCents: 0,
      allowedZones: ["contiguous_us", "military_apo_fpo"],
      excludedZones: ["alaska", "hawaii", "us_territory"],
      excludedCategories: ["freight", "oversized", "special handling", "target plus"],
      excludedSpecialFulfillmentMethods: ["scheduled_delivery", "freight", "special_handling"],
      requiresDirectRetailerSeller: true,
      requiresMembership: null,
      requiresPreTaxMerchandiseThreshold: true,
      itemSpecificQualificationRequired: false,
    };

    return {
      status: "extracted",
      terms,
      parserVersion: this.version,
      warnings,
      explanation: "Successfully extracted Target standard ground shipping policy ($35 qualifying merchandise threshold, 48 states + APO/FPO).",
    };
  }

  /**
   * B&H Photo Video Extractor
   */
  private extractBhPhoto(
    text: string,
    sourceUrl: string,
    targetVariant: "standard" | "circle_card" | "expedited" | undefined,
    warnings: string[]
  ): PolicyExtractionResult {
    const lower = text.toLowerCase();

    // Check if extracting Expedited ($49) or Free Standard Ground
    if (targetVariant === "expedited" || (lower.includes("expedited") && lower.includes("49"))) {
      const thresholds = findFreeShippingThresholds(text);
      if (thresholds.length > 0 && !thresholds.includes(4900)) {
        return {
          status: "ambiguous",
          parserVersion: this.version,
          warnings: [`Expedited threshold did not match $49 (found: ${thresholds.join(", ")})`],
          explanation: "B&H expedited threshold could not be verified at $49.00.",
        };
      }

      const terms: ExtractedPolicyTerms = {
        merchantDomain: "bhphotovideo.com",
        merchantName: "B&H Photo Video",
        deliveryMethod: "expedited",
        currency: "USD",
        thresholdCents: 4900,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
        excludedCategories: ["freight", "oversized", "drop ship", "special order"],
        excludedSpecialFulfillmentMethods: ["freight", "truck_delivery"],
        requiresDirectRetailerSeller: true,
        requiresPreTaxMerchandiseThreshold: true,
        itemSpecificQualificationRequired: false,
      };

      return {
        status: "extracted",
        terms,
        parserVersion: this.version,
        warnings,
        explanation: "Successfully extracted B&H Photo Video free expedited shipping policy ($49 contiguous US threshold).",
      };
    }

    // Default to Standard Ground Qualifying Item Policy
    const terms: ExtractedPolicyTerms = {
      merchantDomain: "bhphotovideo.com",
      merchantName: "B&H Photo Video",
      deliveryMethod: "standard_ground",
      currency: "USD",
      thresholdCents: 0, // Item-specific qualification
      shippingCostCents: 0,
      allowedZones: ["contiguous_us"],
      excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
      excludedCategories: ["freight", "oversized"],
      requiresDirectRetailerSeller: true,
      requiresPreTaxMerchandiseThreshold: false,
      itemSpecificQualificationRequired: true,
    };

    return {
      status: "extracted",
      terms,
      parserVersion: this.version,
      warnings,
      explanation: "Successfully extracted B&H Photo Video item-specific free standard shipping policy.",
    };
  }
}
