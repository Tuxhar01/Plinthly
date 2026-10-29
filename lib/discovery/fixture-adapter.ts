import { CandidateSource } from "../state/types";
import { normalizeCandidate } from "./normalize";
import {
  DiscoveryContext,
  DiscoveryResult,
  ProductSearchRequest,
  RawDiscoveredCandidate,
  SourceAdapter,
  SourceAdapterCapabilities,
} from "./types";

/**
 * Explicit test fixtures demonstrating valid, malformed, incomplete, and conflicting candidates.
 * Clearly marked as test fixtures; never masquerades as a live retailer.
 */
export const FIXTURE_DATA: readonly (RawDiscoveredCandidate & { readonly keywords: readonly string[] })[] = [
  // 1. Fully valid 4K Monitor
  {
    keywords: ["monitor", "4k", "display", "screen"],
    externalId: "SKU-MON-4K-001",
    title: "UltraClear 27-inch 4K UHD Monitor",
    merchantName: "DisplayWorld",
    merchantUrl: "https://displayworld.example.com/products/SKU-MON-4K-001",
    unitPrice: "349.99",
    shipping: "15.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:00:00.000Z",
    rawAttributes: {
      resolution: "4K",
      refresh_rate: "144Hz",
      panel_type: "IPS",
      color: "black",
    },
  },
  // 2. Fully valid Mechanical Keyboard
  {
    keywords: ["keyboard", "mechanical", "keycaps", "typing"],
    externalId: "SKU-KB-MECH-002",
    title: "ProTypist Tenkeyless Mechanical Keyboard",
    merchantName: "KeycapsDirect",
    merchantUrl: "https://keycapsdirect.example.com/items/SKU-KB-MECH-002",
    unitPriceCents: 8900,
    shippingCents: 0,
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:05:00.000Z",
    rawAttributes: {
      layout: "ANSI",
      switch_type: "Tactile Brown",
      connectivity: "USB-C",
      color: "dark grey",
    },
  },
  // 3. Ergonomic Chair
  {
    keywords: ["chair", "ergonomic", "office", "seating"],
    externalId: "SKU-CHAIR-ERGO-003",
    title: "ErgoComfort High-Back Mesh Task Chair",
    merchantName: "OfficeEssentials",
    merchantUrl: "https://officeessentials.example.com/chair-003",
    unitPrice: "249.50",
    shipping: "25.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:10:00.000Z",
    rawAttributes: {
      material: "Mesh",
      adjustable_armrests: "yes",
      lumbar_support: "adjustable",
      weight_capacity: "300 lbs",
    },
  },
  // 4. Missing Unit Price (Malformed/Incomplete)
  {
    keywords: ["monitor", "missing-price"],
    externalId: "SKU-ERR-NOPRICE-004",
    title: "Faulty Listing Monitor Without Price",
    merchantName: "DisplayWorld",
    merchantUrl: "https://displayworld.example.com/faulty-item",
    shipping: "10.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:15:00.000Z",
    rawAttributes: {},
  },
  // 5. Malformed URL (Protocol violation: ftp://)
  {
    keywords: ["keyboard", "bad-url"],
    externalId: "SKU-ERR-BADURL-005",
    title: "Keyboard with Unsupported Protocol URL",
    merchantName: "KeycapsDirect",
    merchantUrl: "ftp://files.example.com/items/keyboard.html",
    unitPrice: "45.00",
    shipping: "5.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:20:00.000Z",
    rawAttributes: {},
  },
  // 6. Missing Shipping Cost (Cannot infer free shipping)
  {
    keywords: ["chair", "missing-shipping"],
    externalId: "SKU-ERR-NOSHIP-006",
    title: "Task Chair with Omitted Shipping Specification",
    merchantName: "OfficeEssentials",
    merchantUrl: "https://officeessentials.example.com/no-shipping",
    unitPrice: "199.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:25:00.000Z",
    rawAttributes: {},
  },
  // 7. Missing Availability (Cannot infer in_stock)
  {
    keywords: ["monitor", "missing-availability"],
    externalId: "SKU-ERR-NOAVAIL-007",
    title: "Monitor Listing Without Stock Availability",
    merchantName: "DisplayWorld",
    merchantUrl: "https://displayworld.example.com/no-avail",
    unitPrice: "299.00",
    shipping: "12.00",
    quantity: 1,
    currency: "USD",
    capturedAt: "2026-10-20T12:30:00.000Z",
    rawAttributes: {},
  },
  // 8. Unsupported Currency (EUR instead of USD)
  {
    keywords: ["keyboard", "euro-currency"],
    externalId: "SKU-ERR-EUR-008",
    title: "Euro Priced Mechanical Keyboard",
    merchantName: "EuropeanTech",
    merchantUrl: "https://eurotech.example.com/item-008",
    unitPrice: "75.00",
    shipping: "10.00",
    quantity: 1,
    currency: "EUR",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:35:00.000Z",
    rawAttributes: {},
  },
  // 9. Floating-point price passed as JavaScript number
  {
    keywords: ["mouse", "float-price"],
    externalId: "SKU-ERR-FLOAT-009",
    title: "Precision Mouse with Floating Point Price",
    merchantName: "TechStore",
    merchantUrl: "https://techstore.example.com/mouse-float",
    unitPrice: 29.99, // Number, not integer cents or string
    shipping: 5.0,
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-20T12:40:00.000Z",
    rawAttributes: {},
  },
] as const;

export class FixtureSourceAdapter implements SourceAdapter {
  readonly name = "fixture_source_adapter";
  readonly source: CandidateSource;
  private readonly fixtures: readonly (RawDiscoveredCandidate & { readonly keywords: readonly string[] })[];

  constructor(options?: {
    source?: CandidateSource;
    customFixtures?: readonly (RawDiscoveredCandidate & { readonly keywords: readonly string[] })[];
  }) {
    this.source = options?.source ?? "channel3";
    this.fixtures = options?.customFixtures ?? FIXTURE_DATA;
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
    const query = request.query.trim().toLowerCase();

    // Simulated source error trigger
    if (query === "__trigger_source_error__") {
      return {
        status: "source_error",
        errorCode: "FIXTURE_UPSTREAM_UNAVAILABLE",
        errorMessage: "Simulated upstream provider failure in fixture adapter.",
        timestamp: context.now,
      };
    }

    if (query.length === 0) {
      return {
        status: "empty",
        reason: "Search query is empty.",
        timestamp: context.now,
      };
    }

    // Match fixtures by query words against title, merchantName, or keywords
    const queryTokens = query.split(/\s+/).filter(Boolean);
    const matchedFixtures = this.fixtures.filter((fix) => {
      const titleLower = typeof fix.title === "string" ? fix.title.toLowerCase() : "";
      const merchantLower = typeof fix.merchantName === "string" ? fix.merchantName.toLowerCase() : "";
      const keywordMatches = fix.keywords.some((kw) => queryTokens.some((token) => kw.includes(token)));
      const textMatches = queryTokens.some((token) => titleLower.includes(token) || merchantLower.includes(token));
      return keywordMatches || textMatches;
    });

    if (matchedFixtures.length === 0) {
      return {
        status: "empty",
        reason: `No products found matching query "${request.query}".`,
        timestamp: context.now,
      };
    }

    // Normalize each candidate
    const normalizedList = matchedFixtures.map((raw, idx) => {
      const candidateId = context.candidateIdGenerator
        ? context.candidateIdGenerator()
        : `cand_fix_${idx + 1}_${String(raw.externalId || "unknown")}`;

      return normalizeCandidate(raw, {
        purchaseId: request.purchaseId,
        source: this.source,
        now: context.now,
        candidateId,
      });
    });

    // Apply constraints filter
    let filtered = normalizedList;
    const constraints = request.constraints;

    if (constraints) {
      if (constraints.maxBudgetCents !== undefined && constraints.maxBudgetCents > 0) {
        filtered = filtered.filter(
          (c) => c.isComplete && c.totalCents <= (constraints.maxBudgetCents as number)
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
