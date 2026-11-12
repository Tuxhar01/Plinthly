/**
 * Plinthly Phase 15 & Action 3 — Multi-Item Procurement Strategy Generation and Comparison Engine.
 *
 * Enforces:
 * 1. Generates distinct, realistic procurement strategies:
 *    - Consolidated Single-Retailer Strategy (minimizes retailers/shipments, maximizes threshold qualification)
 *    - Lowest Landed Cost Strategy (minimizes total price across all retailers)
 *    - Verified Authoritative / First-Party Strategy (prioritizes verified first-party retailer evidence)
 *    - Balanced Optimal Strategy (multi-objective clamped scoring with hard compatibility gate)
 * 2. Defensible cost calculation & invariants:
 *    - Total landed cost is ONLY calculated when merchandise, all shipping charges, and tax are defensible.
 *    - Incomplete shipping or tax costs result in totalLandedCostCents: null and isLandedCostDefensible: false.
 *    - Invariant: isLandedCostDefensible === true MUST strictly imply totalLandedCostCents !== null.
 * 3. Defensible 4-tier ranking:
 *    - Tier 1 (feasible-complete) > Tier 2 (feasible-incomplete) > Tier 3 (uncertain) > Tier 4 (blocked).
 *    - NEVER ranks an incomplete total as cheaper or better than a verified complete total regardless of score.
 * 4. Orthogonal authenticity tracking:
 *    - Direct retailer seller does NOT imply brand authorization or manufacturer warranty.
 *    - Tracks all 4 authenticity/warranty claims independently with evidence tiers.
 * 5. Destination tax rules:
 *    - Statewide statutory absence of general retail sales tax for OR, NH, and DE.
 *    - Montana (MT) authorizes local resort taxes (MCA 7-6-1501); postal codes alone cannot establish absence of tax, requiring authoritative local quotes.
 *    - Alaska (AK) requires explicit municipal tax quote (local sales taxes apply).
 * 6. Cryptographic evidence fingerprint:
 *    - Canonical evidence-content hash separated from evaluatedAt evaluation timestamp.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NormalizedProductCandidate } from "../types";
import { DestinationContext } from "../shipping";
import { resolveGeographicZone } from "../geographic-zones";
import { aggregateRetailerCarts, extractMerchantDomain } from "./cart-aggregator";
import { allocateCandidatesToLineItems, checkCandidateCompatibility, ServerAuthenticityRegistry } from "./allocation";
import {
  validateStrategyCompleteness,
  assertStrategyCompleteness,
  StrategyCompletenessReport,
} from "./completeness-validator";
export {
  validateStrategyCompleteness,
  assertStrategyCompleteness,
  type StrategyCompletenessReport,
};
import {
  LineItemCandidateAllocation,
  ProcurementLineItem,
  ProcurementStrategy,
  StrategyFeasibility,
  StrategyTier,
  StrategyCostBreakdown,
  StrategyTradeOffs,
  TaxEvidence,
  EvidenceTier,
} from "./types";

export interface StrategyGenerationInput {
  readonly lineItems: readonly ProcurementLineItem[];
  readonly candidates: readonly NormalizedProductCandidate[];
  readonly destination: DestinationContext;
  readonly now?: Date;
  readonly buyerMemberships?: readonly string[];
  readonly taxEvidence?: TaxEvidence;
  readonly authenticityRegistry?: ServerAuthenticityRegistry;
}

/**
 * Server-controlled authority configuration for authentic tax quote providers.
 */
export interface ServerTaxAuthorityConfig {
  readonly authorityId: string;
  readonly name: string;
  readonly verificationMethod: "cryptographic_hmac_sha256" | "statutory_rule_engine";
  readonly secretKey: string;
  readonly isSyntheticTestAuthority?: boolean;
}

const INTERNAL_TAX_REGISTRY_TOKEN = Symbol("ImmutableTaxAuthorityRegistry.INTERNAL_TOKEN");

/**
 * Genuinely server-controlled, immutable authority configuration registry.
 * Uses JavaScript private field (#authorities) to strictly prevent outside access
 * or prototype manipulation (e.g. Map.prototype.set.call), ensuring no runtime mutation
 * can alter the effective trusted tax authority configuration.
 * Direct instantiation by application code is prohibited. Constructor requires internal unexported token.
 * Sealed with Object.freeze upon construction.
 */
export class ImmutableTaxAuthorityRegistry {
  readonly #authorities: Map<string, ServerTaxAuthorityConfig>;
  readonly isTestRegistry: boolean;

  constructor(
    internalToken: unknown,
    configs: readonly ServerTaxAuthorityConfig[],
    options: { isTestRegistry?: boolean } = {}
  ) {
    if (internalToken !== INTERNAL_TAX_REGISTRY_TOKEN) {
      throw new Error(
        "Unauthorized construction of ImmutableTaxAuthorityRegistry: Direct instantiation by application code is prohibited. Use server-controlled configuration."
      );
    }

    const map = new Map<string, ServerTaxAuthorityConfig>();
    for (const cfg of configs) {
      if (!cfg.authorityId || typeof cfg.authorityId !== "string") continue;
      // Fail closed: Do NOT enroll any cryptographic HMAC authority with missing, empty, or placeholder secret
      if (cfg.verificationMethod === "cryptographic_hmac_sha256") {
        if (!cfg.secretKey || typeof cfg.secretKey !== "string" || cfg.secretKey.trim().length === 0) {
          continue; // Missing secret -> NOT enrolled!
        }
      }
      map.set(cfg.authorityId.toLowerCase().trim(), Object.freeze({ ...cfg }));
    }
    this.#authorities = map;
    this.isTestRegistry = options.isTestRegistry === true;
    Object.freeze(this);
  }

  public getAuthority(id: string): ServerTaxAuthorityConfig | undefined {
    return this.#authorities.get(id.toLowerCase().trim());
  }

  public isEnrolled(id: string): boolean {
    return this.#authorities.has(id.toLowerCase().trim());
  }

  public getEnrolledAuthorityIds(): readonly string[] {
    return Object.freeze([...this.#authorities.keys()]);
  }

  /**
   * Cryptographically verifies a tax quote's authentic provenance and cryptographic signature.
   * Bound to amount, currency, destination jurisdiction, postal code, quoteId, and expiry.
   */
  public verifyQuoteCryptographically(quote: {
    readonly sourceIdentity: string;
    readonly quoteId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly jurisdictionState: string;
    readonly postalCode: string;
    readonly expiresAt: string;
    readonly signature?: string | null;
  }): { readonly verified: boolean; readonly reason?: string } {
    const authority = this.getAuthority(quote.sourceIdentity);
    if (!authority) {
      return {
        verified: false,
        reason: `Source identity '${quote.sourceIdentity}' is not enrolled in the immutable server tax authority registry.`,
      };
    }

    if (authority.verificationMethod === "statutory_rule_engine") {
      return { verified: true };
    }

    if (!authority.secretKey || authority.secretKey.trim().length === 0) {
      return {
        verified: false,
        reason: `Authority '${authority.authorityId}' has no configured signing secret key (fail-closed).`,
      };
    }

    if (!quote.signature || typeof quote.signature !== "string" || quote.signature.trim().length === 0) {
      return {
        verified: false,
        reason: `Tax quote from '${authority.authorityId}' lacks required cryptographic signature / proof token. A source name alone does not prove quote authenticity.`,
      };
    }

    // Canonical representation for cryptographic verification
    const message = `${authority.authorityId}:::${quote.quoteId.trim()}:::${quote.amountCents}:::${quote.currency.toUpperCase().trim()}:::${quote.jurisdictionState.toUpperCase().trim()}:::${quote.postalCode.trim()}:::${quote.expiresAt.trim()}`;
    const expectedSignature = createHmac("sha256", authority.secretKey.trim()).update(message).digest("hex");

    const sigBuf = Buffer.from(quote.signature.trim().toLowerCase(), "hex");
    const expBuf = Buffer.from(expectedSignature.toLowerCase(), "hex");

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return {
        verified: false,
        reason: `Cryptographic quote signature verification failed for '${authority.authorityId}'. Signature does not match the bound payload (amount, currency, jurisdiction, postal code, quote ID, or expiry).`,
      };
    }

    return { verified: true };
  }
}

/**
 * Builds the default server tax authorities based strictly on configured environment variables.
 * Missing secrets FAIL CLOSED: zero hardcoded fallback secrets are substituted.
 */
function buildDefaultServerTaxAuthorities(): readonly ServerTaxAuthorityConfig[] {
  const configs: ServerTaxAuthorityConfig[] = [];

  // Statutory Rule Engine is always enrolled for server-owned statutory absence states
  configs.push(
    Object.freeze({
      authorityId: "statutory_rule_engine",
      name: "Server Statutory Rule Engine",
      verificationMethod: "statutory_rule_engine" as const,
      secretKey: "", // Verified via server code, not HMAC
    })
  );

  // External provider authorities: ONLY enroll if non-empty signing key is configured in environment
  const candidateDefs: readonly { readonly authorityId: string; readonly name: string; readonly envVar: string }[] = [
    { authorityId: "avalara_v1", name: "Avalara AvaTax Engine v1", envVar: "AVALARA_TAX_SIGNING_KEY" },
    { authorityId: "taxjar_v1", name: "TaxJar SmartCalcs v1", envVar: "TAXJAR_TAX_SIGNING_KEY" },
    { authorityId: "vertex_v1", name: "Vertex O Series v1", envVar: "VERTEX_TAX_SIGNING_KEY" },
    { authorityId: "alaska_tax_commission_v1", name: "Alaska Remote Seller Sales Tax Commission", envVar: "AK_TAX_COMMISSION_SIGNING_KEY" },
    { authorityId: "anchorage_municipal_tax_oracle", name: "Municipality of Anchorage Tax Oracle", envVar: "ANCHORAGE_TAX_SIGNING_KEY" },
    { authorityId: "anchorage_tax_oracle", name: "Anchorage Tax Oracle v1", envVar: "ANCHORAGE_TAX_ORACLE_KEY" },
    { authorityId: "tax_quote_engine", name: "Carrier Tax Quote Engine", envVar: "TAX_QUOTE_ENGINE_KEY" },
    { authorityId: "state_department_of_revenue_v1", name: "State Department of Revenue Authoritative Oracle", envVar: "DOR_TAX_SIGNING_KEY" },
  ];

  for (const def of candidateDefs) {
    const key = process.env[def.envVar]?.trim();
    if (key && key.length >= 32) {
      configs.push(
        Object.freeze({
          authorityId: def.authorityId,
          name: def.name,
          verificationMethod: "cryptographic_hmac_sha256" as const,
          secretKey: key,
        })
      );
    }
  }

  return Object.freeze(configs);
}

export const SERVER_TAX_AUTHORITY_REGISTRY: ImmutableTaxAuthorityRegistry =
  new ImmutableTaxAuthorityRegistry(INTERNAL_TAX_REGISTRY_TOKEN, buildDefaultServerTaxAuthorities());

/**
 * Isolated synthetic test authority for controlled non-production test fixtures.
 */
export const SYNTHETIC_TEST_TAX_AUTHORITY: ServerTaxAuthorityConfig = Object.freeze({
  authorityId: "synthetic_test_tax_oracle",
  name: "Synthetic Test Tax Oracle",
  verificationMethod: "cryptographic_hmac_sha256",
  secretKey: "synthetic_test_tax_key_min_32_characters_strictly_for_tests!",
  isSyntheticTestAuthority: true,
});

export const SYNTHETIC_TEST_TAX_REGISTRY: ImmutableTaxAuthorityRegistry =
  process.env.NODE_ENV === "production"
    ? (null as unknown as ImmutableTaxAuthorityRegistry)
    : createSyntheticTaxRegistryForTesting([SYNTHETIC_TEST_TAX_AUTHORITY]);

/**
 * Creates a cryptographically signed, destination-bound synthetic test tax quote.
 * Strictly prohibited in production.
 */
export function createDefensibleTestTaxQuote(params: {
  readonly destination: DestinationContext;
  readonly amountCents?: number;
  readonly currency?: string;
  readonly quoteId?: string;
  readonly expiresAt?: string;
}): TaxEvidence {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Forbidden in production: createDefensibleTestTaxQuote cannot be called in production runtime."
    );
  }
  const destState = resolveDestinationJurisdictionState(params.destination);
  const postal = params.destination.postalCode?.trim() ?? "94103";
  const amountCents = params.amountCents ?? 0;
  const currency = (params.currency ?? "USD").toUpperCase();
  const quoteId = params.quoteId ?? `test_tax_quote_${destState.toLowerCase()}_${postal}`;
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 86400000).toISOString();

  const signature = signSyntheticTaxQuoteForTesting(
    SYNTHETIC_TEST_TAX_AUTHORITY.authorityId,
    {
      quoteId,
      amountCents,
      currency,
      jurisdictionState: destState,
      postalCode: postal,
      expiresAt,
    },
    SYNTHETIC_TEST_TAX_REGISTRY
  );

  return Object.freeze({
    jurisdictionState: destState,
    postalCode: postal,
    amountCents,
    currency,
    quoteId,
    evidenceReference: `ref_${quoteId}`,
    sourceIdentity: SYNTHETIC_TEST_TAX_AUTHORITY.authorityId,
    status: "quoted",
    quotedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt,
    quoteSignature: signature,
    explanation: `Controlled non-production test tax quote for ${destState} (${postal})`,
  });
}

let activeNonProductionTestTaxFixture:
  | TaxEvidence
  | ((dest: DestinationContext) => TaxEvidence | undefined)
  | null = null;

/**
 * Sets an isolated, controlled non-production test tax fixture.
 * Strictly prohibited in production runtime.
 */
export function setNonProductionTestTaxFixture(
  fixture: TaxEvidence | ((dest: DestinationContext) => TaxEvidence | undefined) | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Forbidden in production: setNonProductionTestTaxFixture cannot be called in production runtime."
    );
  }
  activeNonProductionTestTaxFixture = fixture;
}

/**
 * Clears any active non-production test tax fixture.
 */
export function clearNonProductionTestTaxFixture(): void {
  activeNonProductionTestTaxFixture = null;
}

/**
 * Creates a synthetic test tax authority registry strictly for testing cryptographic flows.
 * Requires all enrolled authorities to be explicitly marked `isSyntheticTestAuthority: true`.
 * Rejects any attempt to enroll production authority IDs.
 */
export function createSyntheticTaxRegistryForTesting(
  syntheticAuthorities: readonly ServerTaxAuthorityConfig[]
): ImmutableTaxAuthorityRegistry {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Forbidden in production: createSyntheticTaxRegistryForTesting cannot be called in production runtime."
    );
  }
  for (const auth of syntheticAuthorities) {
    if (!auth.isSyntheticTestAuthority) {
      throw new Error(
        `Unauthorized authority enrollment: Authority '${auth.authorityId}' is not marked as a synthetic test authority. Production authority IDs cannot be registered via test helpers.`
      );
    }
  }
  return new (ImmutableTaxAuthorityRegistry as unknown as new (
    token: unknown,
    cfgs: readonly ServerTaxAuthorityConfig[],
    opts?: { isTestRegistry?: boolean }
  ) => ImmutableTaxAuthorityRegistry)(
    INTERNAL_TAX_REGISTRY_TOKEN,
    syntheticAuthorities,
    { isTestRegistry: true }
  );
}

/**
 * Synthetic test helper to sign a test tax quote using an authority enrolled in a test registry.
 *
 * PROVENANCE BOUNDARY:
 * This function generates synthetic HMAC signatures strictly for testing cryptographic verification,
 * tamper detection, and payload binding in test harnesses.
 * It does NOT represent external provider provenance. In production, external tax provider quotes
 * remain untrusted until a live authenticated ingestion service is established.
 */
export function signSyntheticTaxQuoteForTesting(
  authorityId: string,
  quote: {
    readonly quoteId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly jurisdictionState: string;
    readonly postalCode: string;
    readonly expiresAt: string;
  },
  registry: ImmutableTaxAuthorityRegistry = SERVER_TAX_AUTHORITY_REGISTRY
): string {
  const auth = registry.getAuthority(authorityId);
  if (!auth) {
    throw new Error(`Cannot sign quote: Authority '${authorityId}' is not enrolled in the tax authority registry.`);
  }
  if (!auth.secretKey || auth.secretKey.trim().length === 0) {
    throw new Error(`Cannot sign quote: Authority '${authorityId}' has no configured signing secret key (fail-closed).`);
  }
  const message = `${auth.authorityId}:::${quote.quoteId.trim()}:::${quote.amountCents}:::${quote.currency.toUpperCase().trim()}:::${quote.jurisdictionState.toUpperCase().trim()}:::${quote.postalCode.trim()}:::${quote.expiresAt.trim()}`;
  return createHmac("sha256", auth.secretKey.trim()).update(message).digest("hex");
}

export const signServerTaxQuote = signSyntheticTaxQuoteForTesting;

/**
 * Genuinely immutable server-owned jurisdiction tax rules.
 * Uses JavaScript private fields to strictly encapsulate all internal sets,
 * preventing any outside reference exposure or prototype-call bypasses
 * (e.g. Set.prototype.add.call, delete.call, clear.call).
 */
export class ImmutableJurisdictionTaxRules {
  readonly #ruleVersion: string;
  readonly #statutoryAbsenceStates: ReadonlySet<string>;
  readonly #municipalQuoteRequiredStates: ReadonlySet<string>;
  readonly #localResortTaxPostalCodes: ReadonlySet<string>;

  constructor(params: {
    readonly ruleVersion: string;
    readonly statutoryAbsenceStates?: readonly string[];
    readonly statutoryZeroStates?: readonly string[];
    readonly municipalQuoteRequiredStates: readonly string[];
    readonly localResortTaxPostalCodes?: readonly string[];
  }) {
    this.#ruleVersion = params.ruleVersion;
    const states = params.statutoryAbsenceStates ?? params.statutoryZeroStates ?? ["OR", "NH", "DE"];
    this.#statutoryAbsenceStates = new Set(states.map((s) => s.toUpperCase().trim()));
    this.#municipalQuoteRequiredStates = new Set(params.municipalQuoteRequiredStates.map((s) => s.toUpperCase().trim()));
    this.#localResortTaxPostalCodes = new Set((params.localResortTaxPostalCodes ?? []).map((p) => p.trim()));
    Object.freeze(this);
  }

  get ruleVersion(): string {
    return this.#ruleVersion;
  }

  isStatutoryAbsenceState(state: string): boolean {
    return this.#statutoryAbsenceStates.has(state.toUpperCase().trim());
  }

  isStatutoryZeroState(state: string): boolean {
    return this.isStatutoryAbsenceState(state);
  }

  isMunicipalQuoteRequiredState(state: string): boolean {
    return this.#municipalQuoteRequiredStates.has(state.toUpperCase().trim());
  }

  isLocalResortTaxPostalCode(postalCode: string): boolean {
    return this.#localResortTaxPostalCodes.has(postalCode.trim());
  }

  getStatutoryAbsenceStates(): readonly string[] {
    return Object.freeze([...this.#statutoryAbsenceStates]);
  }

  getStatutoryZeroStates(): readonly string[] {
    return this.getStatutoryAbsenceStates();
  }

  getMunicipalQuoteRequiredStates(): readonly string[] {
    return Object.freeze([...this.#municipalQuoteRequiredStates]);
  }

  getLocalResortTaxPostalCodes(): readonly string[] {
    return Object.freeze([...this.#localResortTaxPostalCodes]);
  }
}

/**
 * Server-owned versioned jurisdiction tax rules v1 (2026.1).
 *
 * Notice on Statutory Scope & Jurisdiction Review:
 * - Oregon (OR): Does not enact or impose a general retail sales and use tax under state law.
 *   Statutory absence of a general sales-tax scheme; specific excise taxes (e.g. transient lodging,
 *   bicycle/vehicle privilege under ORS 320) do not apply to general retail merchandise.
 * - Montana (MT): Does not enact a statewide general retail sales tax. However, under Montana
 *   MCA 7-6-1501 et seq., designated resort communities and resort areas (e.g. Big Sky, Whitefish,
 *   West Yellowstone, Red Lodge) impose local sales taxes up to 3-4%. Because USPS postal ZIP codes
 *   do not align with municipal or resort district taxing boundaries, postal codes alone cannot establish
 *   the absence of local resort tax without an authoritative local quote or certified jurisdiction determination.
 *   Unquoted Montana destinations fail closed to missing/non-defensible tax.
 * - New Hampshire (NH): Does not enact a general retail sales tax on tangible personal property.
 *   Specific excise taxes (e.g. Meals and Rooms Tax under RSA 78-A, 8.5%) do not apply to general
 *   tangible merchandise procurement.
 * - Delaware (DE): Does not enact a state or local buyer-side general retail sales tax on transactions.
 *   Delaware imposes a merchant Gross Receipts Tax (Title 30 Del. C.) on business entities, which is
 *   an entity-level cost of doing business rather than a buyer-facing transaction sales tax.
 * - Destinations with unquoted local levies or ambiguous jurisdiction fail closed to non-defensible.
 */
export const SERVER_JURISDICTION_TAX_RULES_V1: ImmutableJurisdictionTaxRules =
  new ImmutableJurisdictionTaxRules({
    ruleVersion: "jurisdiction_tax_rules_2026.1",
    statutoryAbsenceStates: ["OR", "NH", "DE"],
    statutoryZeroStates: ["OR", "NH", "DE"],
    municipalQuoteRequiredStates: ["AK"],
    localResortTaxPostalCodes: [
      "59716", // Big Sky, MT (3% local resort tax under MCA 7-6-1501)
      "59937", // Whitefish, MT (3% local resort tax under MCA 7-6-1501)
      "59068", // Red Lodge, MT (3% local resort tax under MCA 7-6-1501)
      "59758", // West Yellowstone, MT (3% local resort tax under MCA 7-6-1501)
      "59730", // Gardiner, MT (3% local resort tax under MCA 7-6-1501)
      "59724", // Cooke City, MT (3% local resort tax under MCA 7-6-1501)
      "59755", // Virginia City, MT (3% local resort tax under MCA 7-6-1501)
      "59912", // Columbia Falls, MT (3% local resort tax under MCA 7-6-1501)
      "59866", // St. Regis, MT (local resort area tax under MCA 7-6-1501)
      "59868", // Seeley Lake, MT (local resort area tax under MCA 7-6-1501)
      "59648", // Wolf Creek / Craig, MT (local resort area tax under MCA 7-6-1501)
    ],
  });

/**
 * Resolves destination jurisdiction state code (e.g. "OR", "AK", "CA") from destination postal code and geographic zone.
 * Rejects malformed or unsupported postal codes by returning "UNKNOWN".
 */
export function resolveDestinationJurisdictionState(destination: DestinationContext): string {
  const postalCode = destination?.postalCode?.trim() ?? "";
  if (!destination || !postalCode || !/^\d{5}(-\d{4})?$/.test(postalCode)) {
    return "UNKNOWN";
  }

  const geo = resolveGeographicZone(postalCode);
  const zipPrefix3 = parseInt(postalCode.slice(0, 3), 10);

  const isOregon = zipPrefix3 >= 970 && zipPrefix3 <= 979;
  const isMontana = zipPrefix3 >= 590 && zipPrefix3 <= 599;
  const isNewHampshire = zipPrefix3 >= 30 && zipPrefix3 <= 38;
  const isDelaware = zipPrefix3 >= 197 && zipPrefix3 <= 199;
  const isAlaska = geo.zone === "alaska" || (zipPrefix3 >= 995 && zipPrefix3 <= 999);
  const isCalifornia = zipPrefix3 >= 900 && zipPrefix3 <= 961;
  const isWashington = zipPrefix3 >= 980 && zipPrefix3 <= 994;
  const isNewYork = zipPrefix3 >= 100 && zipPrefix3 <= 149;
  const isTexas = (zipPrefix3 >= 750 && zipPrefix3 <= 799) || (zipPrefix3 >= 885 && zipPrefix3 <= 885);
  const isFlorida = zipPrefix3 >= 320 && zipPrefix3 <= 349;
  const isIllinois = zipPrefix3 >= 600 && zipPrefix3 <= 629;
  const isMassachusetts = zipPrefix3 >= 10 && zipPrefix3 <= 27;
  const isPennsylvania = zipPrefix3 >= 150 && zipPrefix3 <= 196;

  return isOregon
    ? "OR"
    : isMontana
    ? "MT"
    : isNewHampshire
    ? "NH"
    : isDelaware
    ? "DE"
    : isAlaska
    ? "AK"
    : isCalifornia
    ? "CA"
    : isWashington
    ? "WA"
    : isNewYork
    ? "NY"
    : isTexas
    ? "TX"
    : isFlorida
    ? "FL"
    : isIllinois
    ? "IL"
    : isMassachusetts
    ? "MA"
    : isPennsylvania
    ? "PA"
    : (geo.stateOrTerritory ?? "UNKNOWN");
}

/**
 * Resolves destination-specific tax evidence.
 * Non-sales-tax jurisdictions: OR, MT, NH, DE (statutory absence under versioned server rules).
 * Alaska (AK) has no statewide sales tax, but local municipal taxes apply (up to 7.5%),
 * so an explicit municipal tax quote is required before tax can be marked defensible.
 */
export function evaluateDestinationTax(
  destination: DestinationContext,
  explicitTax?: TaxEvidence,
  now: Date = new Date(),
  registry: ImmutableTaxAuthorityRegistry = SERVER_TAX_AUTHORITY_REGISTRY,
  rules: ImmutableJurisdictionTaxRules = SERVER_JURISDICTION_TAX_RULES_V1,
  expectedCurrency: string = "USD"
): {
  readonly taxCents: number | null;
  readonly isTaxDefensible: boolean;
  readonly taxEvidence: TaxEvidence;
} {
  // Validate destination postal code format
  const postalCode = destination?.postalCode?.trim() ?? "";
  if (!destination || !postalCode || !/^\d{5}(-\d{4})?$/.test(postalCode)) {
    return {
      taxCents: null,
      isTaxDefensible: false,
      taxEvidence: {
        jurisdictionState: "UNKNOWN",
        postalCode: postalCode || "MISSING",
        amountCents: null,
        status: "missing",
        explanation: `Destination postal code '${postalCode}' is missing, malformed, or unsupported. A valid 5-digit US ZIP code is required.`,
      },
    };
  }

  // Check for isolated, controlled non-production test tax fixture when no explicit tax is provided
  if (!explicitTax && activeNonProductionTestTaxFixture && process.env.NODE_ENV !== "production") {
    const fixtureQuote =
      typeof activeNonProductionTestTaxFixture === "function"
        ? activeNonProductionTestTaxFixture(destination)
        : activeNonProductionTestTaxFixture;
    if (fixtureQuote) {
      explicitTax = fixtureQuote;
    }
  }

  const destinationState = resolveDestinationJurisdictionState(destination);

  let effectiveRegistry = registry;
  if (
    explicitTax?.sourceIdentity === SYNTHETIC_TEST_TAX_AUTHORITY.authorityId &&
    registry === SERVER_TAX_AUTHORITY_REGISTRY &&
    process.env.NODE_ENV !== "production"
  ) {
    effectiveRegistry = SYNTHETIC_TEST_TAX_REGISTRY;
  }

  // 1. If explicit tax evidence is provided:
  if (explicitTax) {
    // Missing or invalid reference check
    const ref = explicitTax.evidenceReference?.trim();
    if (!ref || ref.length === 0) {
      return {
        taxCents: null,
        isTaxDefensible: false,
        taxEvidence: {
          ...explicitTax,
          status: "missing",
          explanation: "Tax evidence lacks required non-empty evidenceReference.",
        },
      };
    }

    // Statutory general sales-tax absence validation:
    // Statutory absence is a legal classification derived EXCLUSIVELY by the server from versioned jurisdiction rules.
    // Callers cannot assert, supply, or forge statutory absence or statutory zero claims.
    // Any caller-supplied statutory_absence or statutory_zero claim is strictly UNTRUSTED.
    if (explicitTax.status === "statutory_zero" || explicitTax.status === "statutory_absence") {
      let explanation: string;
      if (explicitTax.amountCents !== 0 && explicitTax.amountCents !== null) {
        explanation = `Statutory absence claim contains non-zero tax amount (${explicitTax.amountCents} cents). Statutory absence of general sales tax requires amountCents: 0.`;
      } else if (explicitTax.jurisdictionState && explicitTax.jurisdictionState.toUpperCase() !== destinationState.toUpperCase()) {
        explanation = `Tax evidence jurisdiction mismatch: statutory absence is claimed for ${explicitTax.jurisdictionState}, but destination is ${destinationState} (${postalCode}).`;
      } else if (destinationState === "MT") {
        explanation = `Statutory absence claim rejected for Montana (${postalCode}): Montana does not enact a statewide general sales tax, but local resort sales tax applies under MCA 7-6-1501 (up to 3-4% in designated resort communities and resort areas). Statutory absence cannot be assumed without an authoritative local quote or certified jurisdiction determination.`;
      } else if (!rules.isStatutoryAbsenceState(destinationState)) {
        explanation = `Fabricated statutory zero / Fabricated statutory absence claim: destination ${destinationState} does not qualify for statutory absence of general retail sales tax under rule ${rules.ruleVersion}.`;
      } else {
        explanation = `Caller-supplied ${explicitTax.status} claim rejected for ${destinationState} (${postalCode}): Statutory absence of general retail sales tax cannot be established via caller-supplied evidence; statutory absence is derived exclusively by the server from versioned jurisdiction rules.`;
      }

      return {
        taxCents: null,
        isTaxDefensible: false,
        taxEvidence: {
          ...explicitTax,
          amountCents: null,
          status: "untrusted",
          explanation,
        },
      };
    }

    // Exact destination jurisdiction binding check: jurisdictionState must match destinationState
    if (explicitTax.jurisdictionState && explicitTax.jurisdictionState.toUpperCase() !== destinationState.toUpperCase()) {
      return {
        taxCents: null,
        isTaxDefensible: false,
        taxEvidence: {
          ...explicitTax,
          status: "untrusted",
          explanation: `Tax evidence jurisdiction mismatch: quote is for ${explicitTax.jurisdictionState}, but destination is ${destinationState} (${postalCode}).`,
        },
      };
    }

    // Exact destination postal code binding check: postalCode must match destination postalCode
    if (explicitTax.postalCode && explicitTax.postalCode.trim() !== postalCode) {
      return {
        taxCents: null,
        isTaxDefensible: false,
        taxEvidence: {
          ...explicitTax,
          status: "untrusted",
          explanation: `Tax evidence postal code mismatch: quote is for ${explicitTax.postalCode}, but destination is ${postalCode}.`,
        },
      };
    }

    // Quoted Tax validation:
    if (explicitTax.status === "quoted") {
      // Validate non-negative integer amount
      if (
        explicitTax.amountCents === null ||
        typeof explicitTax.amountCents !== "number" ||
        !Number.isInteger(explicitTax.amountCents) ||
        explicitTax.amountCents < 0
      ) {
        return {
          taxCents: null,
          isTaxDefensible: false,
          taxEvidence: {
            ...explicitTax,
            status: "untrusted",
            explanation: "Quoted tax amount is missing, invalid, or negative.",
          },
        };
      }

      // Validate currency against procurement expected currency
      const quoteCurrency = (explicitTax.currency || "USD").toUpperCase().trim();
      const expectedCurr = expectedCurrency.toUpperCase().trim();
      if (quoteCurrency !== expectedCurr) {
        return {
          taxCents: null,
          isTaxDefensible: false,
          taxEvidence: {
            ...explicitTax,
            status: "untrusted",
            explanation: `Tax quote currency mismatch: quote is in ${quoteCurrency}, but procurement requires ${expectedCurr}. Differing currencies cannot be blended without explicit conversion.`,
          },
        };
      }

      // Validate trusted source identity / provenance against server-controlled registry
      const src = explicitTax.sourceIdentity?.trim()?.toLowerCase();
      if (!src || src === "untrusted" || src === "fabricated" || !effectiveRegistry.isEnrolled(src)) {
        return {
          taxCents: null,
          isTaxDefensible: false,
          taxEvidence: {
            ...explicitTax,
            status: "untrusted",
            explanation: `Tax quote lacks verifiable trusted source identity: source '${explicitTax.sourceIdentity ?? "unknown"}' is not enrolled in the server-controlled trusted tax authority registry.`,
          },
        };
      }

      const authority = effectiveRegistry.getAuthority(src)!;

      // Validate quote applicability / expiration
      if (!explicitTax.expiresAt) {
        return {
          taxCents: null,
          isTaxDefensible: false,
          taxEvidence: {
            ...explicitTax,
            status: "untrusted",
            explanation: "Tax quote lacks required expiration timestamp (expiresAt).",
          },
        };
      }
      const expDate = new Date(explicitTax.expiresAt);
      if (isNaN(expDate.getTime()) || expDate.getTime() <= now.getTime()) {
        return {
          taxCents: null,
          isTaxDefensible: false,
          taxEvidence: {
            ...explicitTax,
            status: "untrusted",
            explanation: `Tax quote expired at ${explicitTax.expiresAt} (evaluation time: ${now.toISOString()}).`,
          },
        };
      }

      // Validate quotedAt if present (cannot be in the future)
      if (explicitTax.quotedAt) {
        const quotedDate = new Date(explicitTax.quotedAt);
        if (isNaN(quotedDate.getTime()) || quotedDate.getTime() > now.getTime()) {
          return {
            taxCents: null,
            isTaxDefensible: false,
            taxEvidence: {
              ...explicitTax,
              status: "untrusted",
              explanation: `Tax quote quotedAt timestamp (${explicitTax.quotedAt}) is invalid or in the future (evaluation time: ${now.toISOString()}).`,
            },
          };
        }
      }

      // Cryptographic quote verification:
      // Bound to amount, currency, destination jurisdiction, postal code, quote ID, and expiry.
      const quoteId = explicitTax.quoteId || explicitTax.evidenceReference || "";
      const cryptoCheck = effectiveRegistry.verifyQuoteCryptographically({
        sourceIdentity: src,
        quoteId,
        amountCents: explicitTax.amountCents,
        currency: quoteCurrency,
        jurisdictionState: destinationState,
        postalCode: postalCode,
        expiresAt: explicitTax.expiresAt,
        signature: explicitTax.quoteSignature,
      });

      if (!cryptoCheck.verified) {
        return {
          taxCents: null,
          isTaxDefensible: false,
          taxEvidence: {
            ...explicitTax,
            status: "untrusted",
            explanation: cryptoCheck.reason || "Cryptographic verification of tax quote failed.",
          },
        };
      }

      // Differentiate genuine provider provenance vs synthetic test harness:
      // An internally signed HMAC only verifies cryptographic format within a test harness.
      // In production, until genuine provider authentication & TLS ingestion pipeline exist,
      // external provider quotes cannot be marked defensible.
      if (authority.isSyntheticTestAuthority || effectiveRegistry.isTestRegistry) {
        if (process.env.NODE_ENV === "production") {
          return {
            taxCents: null,
            isTaxDefensible: false,
            taxEvidence: {
              ...explicitTax,
              status: "untrusted",
              explanation: "Synthetic test tax authorities are strictly prohibited in production.",
            },
          };
        }
        return {
          taxCents: explicitTax.amountCents,
          isTaxDefensible: true,
          taxEvidence: {
            ...explicitTax,
            explanation: `${explicitTax.explanation} (Verified via synthetic test authority '${authority.authorityId}').`,
          },
        };
      }

      // Production fail-closed when live provider ingestion is not implemented:
      return {
        taxCents: null,
        isTaxDefensible: false,
        taxEvidence: {
          ...explicitTax,
          status: "untrusted",
          explanation: `External tax provider ingestion for '${authority.name}' is not yet implemented. Locally signed HMACs cannot certify external provider provenance; tax remains non-defensible until live provider integration is established.`,
        },
      };
    }

    return {
      taxCents: explicitTax.amountCents ?? null,
      isTaxDefensible: false,
      taxEvidence: explicitTax,
    };
  }

  // 2. Resolve destination tax when no explicit tax is provided
  // Check Alaska (AK) explicitly - local municipal sales taxes apply
  if (rules.isMunicipalQuoteRequiredState(destinationState)) {
    return {
      taxCents: null,
      isTaxDefensible: false,
      taxEvidence: {
        jurisdictionState: "AK",
        postalCode: postalCode,
        amountCents: null,
        status: "missing",
        explanation: "Alaska has no statewide sales tax, but local municipal sales taxes apply. An authoritative municipal quote is required.",
      },
    };
  }

  // Check Montana (MT) explicitly - statewide absence of general sales tax, but local resort taxes apply under MCA 7-6-1501
  // Postal ZIP codes cannot reliably establish exclusion from local resort taxing boundaries without authoritative jurisdiction-level evidence.
  if (destinationState === "MT") {
    let explanation: string;
    if (rules.isLocalResortTaxPostalCode(postalCode)) {
      explanation = `Destination ${postalCode} in Montana is in a designated resort community (MCA 7-6-1501) where local sales taxes apply. Statutory absence cannot be assumed; an authoritative local quote is required.`;
    } else {
      explanation = `Destination in Montana (${postalCode}) lacks authoritative jurisdiction evidence. While Montana does not enact a statewide general sales tax, local resort communities and resort areas (MCA 7-6-1501) levy local retail sales taxes (up to 3-4%), and postal ZIP codes alone cannot verify exclusion from resort-tax boundaries without an authoritative local quote or certified jurisdiction determination.`;
    }
    return {
      taxCents: null,
      isTaxDefensible: false,
      taxEvidence: {
        jurisdictionState: "MT",
        postalCode: postalCode,
        amountCents: null,
        status: "missing",
        explanation,
      },
    };
  }

  // Check Statutory Absence States (OR, NH, DE) - Statewide absence of general retail sales tax
  if (rules.isStatutoryAbsenceState(destinationState)) {
    let explanation: string;
    if (destinationState === "OR") {
      explanation = `Oregon does not enact or impose a general retail sales tax under state law (statutory absence under rule ${rules.ruleVersion}). Note: Does not certify exemption from specific excise fees, meals/lodging taxes, or special local levies.`;
    } else if (destinationState === "NH") {
      explanation = `New Hampshire does not enact a general retail sales tax on tangible personal property under rule ${rules.ruleVersion} (statutory absence). Note: Does not certify exemption from meals and rooms tax (RSA 78-A) or special excise levies.`;
    } else if (destinationState === "DE") {
      explanation = `Delaware does not enact a state or local buyer-side general retail sales tax under rule ${rules.ruleVersion} (statutory absence). Note: Merchant gross receipts taxes (30 Del. C.) apply at entity level; does not certify exemption from specific excise levies.`;
    } else {
      explanation = `General retail sales tax is not enacted in ${destinationState} under rule ${rules.ruleVersion} (statutory absence). Note: Does not certify exemption from specific excise fees or special local levies.`;
    }

    return {
      taxCents: 0,
      isTaxDefensible: true,
      taxEvidence: {
        jurisdictionState: destinationState,
        postalCode: postalCode,
        amountCents: 0,
        status: "statutory_absence",
        evidenceReference: `${rules.ruleVersion}_statutory_absence_${destinationState.toLowerCase()}`,
        sourceIdentity: "statutory_rule_engine",
        explanation,
      },
    };
  }

  // All other taxable or unknown jurisdictions require an authoritative tax quote
  return {
    taxCents: null,
    isTaxDefensible: false,
    taxEvidence: {
      jurisdictionState: destinationState,
      postalCode: postalCode,
      amountCents: null,
      status: "missing",
      explanation: `Destination jurisdiction (${destinationState}) imposes sales tax or has unquoted rates. An authoritative tax quote is required.`,
    },
  };
}

export interface CostContradictionCheck {
  readonly hasContradiction: boolean;
  readonly errors: readonly string[];
}

/**
 * Detects contradictory monetary or defensibility data in a ProcurementStrategy.
 * Under Action 3 Stage 1 invariants:
 * Any strategy with contradictory monetary data MUST be classified as Tier 4 (Blocked).
 *
 * Contradictions include:
 * 1. Missing costBreakdown.
 * 2. Negative or non-finite monetary values on either top-level or breakdown.
 * 3. Currency mismatches between strategy, costBreakdown, or allocations.
 * 4. Top-level and breakdown discrepancies (merchandise, shipping, discount, tax, total).
 * 5. Contradictory cost defensibility flags (disagreements, true with null total, true with missing shipping).
 * 6. Contradictory completeness (total present when mandatory components are null).
 * 7. Arithmetic inconsistencies (total !== merchandise + shipping - discount + tax).
 */
export function detectCostContradictions(strategy: ProcurementStrategy): CostContradictionCheck {
  const errors: string[] = [];
  const cb = strategy.costBreakdown;

  // Top-level contradictory invariants (check first so they are reported even if costBreakdown is missing)
  if (strategy.isLandedCostDefensible && strategy.totalLandedCostCents === null) {
    errors.push("Contradictory cost data: isLandedCostDefensible is true but totalLandedCostCents is null.");
  }
  if (strategy.missingShippingCostCount > 0 && strategy.isLandedCostDefensible) {
    errors.push("Contradictory cost data: shipping costs are missing or incomplete but isLandedCostDefensible is true.");
  }

  if (!cb) {
    errors.push("Contradictory cost data: Strategy is missing required costBreakdown.");
    return { hasContradiction: true, errors };
  }

  // 1. Negative or non-finite monetary components
  if (cb.merchandiseSubtotalCents < 0 || !Number.isFinite(cb.merchandiseSubtotalCents)) {
    errors.push(`Contradictory cost data: costBreakdown.merchandiseSubtotalCents is invalid or negative (${cb.merchandiseSubtotalCents}).`);
  }
  if (cb.shippingCents !== null && (cb.shippingCents < 0 || !Number.isFinite(cb.shippingCents))) {
    errors.push(`Contradictory cost data: costBreakdown.shippingCents is invalid or negative (${cb.shippingCents}).`);
  }
  if (cb.discountCents < 0 || !Number.isFinite(cb.discountCents)) {
    errors.push(`Contradictory cost data: costBreakdown.discountCents is invalid or negative (${cb.discountCents}).`);
  }
  if (cb.taxCents !== null && (cb.taxCents < 0 || !Number.isFinite(cb.taxCents))) {
    errors.push(`Contradictory cost data: costBreakdown.taxCents is invalid or negative (${cb.taxCents}).`);
  }
  if (cb.totalLandedCostCents !== null && (cb.totalLandedCostCents < 0 || !Number.isFinite(cb.totalLandedCostCents))) {
    errors.push(`Contradictory cost data: costBreakdown.totalLandedCostCents is invalid or negative (${cb.totalLandedCostCents}).`);
  }
  if (strategy.totalMerchandiseCents < 0 || !Number.isFinite(strategy.totalMerchandiseCents)) {
    errors.push(`Contradictory cost data: strategy.totalMerchandiseCents is invalid or negative (${strategy.totalMerchandiseCents}).`);
  }
  if (strategy.totalShippingCents !== null && (strategy.totalShippingCents < 0 || !Number.isFinite(strategy.totalShippingCents))) {
    errors.push(`Contradictory cost data: strategy.totalShippingCents is invalid or negative (${strategy.totalShippingCents}).`);
  }
  if (strategy.totalDiscountCents < 0 || !Number.isFinite(strategy.totalDiscountCents)) {
    errors.push(`Contradictory cost data: strategy.totalDiscountCents is invalid or negative (${strategy.totalDiscountCents}).`);
  }
  if (strategy.totalEstimatedTaxCents < 0 || !Number.isFinite(strategy.totalEstimatedTaxCents)) {
    errors.push(`Contradictory cost data: strategy.totalEstimatedTaxCents is invalid or negative (${strategy.totalEstimatedTaxCents}).`);
  }
  if (strategy.totalLandedCostCents !== null && (strategy.totalLandedCostCents < 0 || !Number.isFinite(strategy.totalLandedCostCents))) {
    errors.push(`Contradictory cost data: strategy.totalLandedCostCents is invalid or negative (${strategy.totalLandedCostCents}).`);
  }

  // 2. Currency mismatches
  if (strategy.currency !== cb.currency) {
    errors.push(`Contradictory cost data: currency mismatch between strategy (${strategy.currency}) and costBreakdown (${cb.currency}).`);
  }
  if (strategy.allocations) {
    for (const alloc of strategy.allocations) {
      if (alloc.currency && alloc.currency !== strategy.currency) {
        errors.push(`Contradictory cost data: allocation currency mismatch: allocation ${alloc.candidateId} (${alloc.currency}) !== strategy (${strategy.currency}).`);
      }
    }
  }

  // 3. Top-level and breakdown discrepancies
  if (strategy.totalMerchandiseCents !== cb.merchandiseSubtotalCents) {
    errors.push(`Contradictory cost data: strategy.totalMerchandiseCents (${strategy.totalMerchandiseCents}) !== costBreakdown.merchandiseSubtotalCents (${cb.merchandiseSubtotalCents}).`);
  }
  if (strategy.totalShippingCents !== cb.shippingCents) {
    errors.push(`Contradictory cost data: strategy.totalShippingCents (${strategy.totalShippingCents}) !== costBreakdown.shippingCents (${cb.shippingCents}).`);
  }
  if (strategy.totalDiscountCents !== cb.discountCents) {
    errors.push(`Contradictory cost data: strategy.totalDiscountCents (${strategy.totalDiscountCents}) !== costBreakdown.discountCents (${cb.discountCents}).`);
  }
  if (strategy.totalLandedCostCents !== cb.totalLandedCostCents) {
    errors.push(`Contradictory cost data: strategy.totalLandedCostCents (${strategy.totalLandedCostCents}) !== costBreakdown.totalLandedCostCents (${cb.totalLandedCostCents}).`);
  }
  if (cb.taxCents !== null && strategy.totalEstimatedTaxCents !== cb.taxCents) {
    errors.push(`Contradictory cost data: strategy.totalEstimatedTaxCents (${strategy.totalEstimatedTaxCents}) !== costBreakdown.taxCents (${cb.taxCents}).`);
  }

  // 4. Contradictory cost defensibility flags
  if (strategy.isLandedCostDefensible !== cb.isLandedCostDefensible) {
    errors.push(`Contradictory cost data: isLandedCostDefensible flag disagreement: strategy (${strategy.isLandedCostDefensible}) !== costBreakdown (${cb.isLandedCostDefensible}).`);
  }
  if (cb.isLandedCostDefensible && cb.totalLandedCostCents === null) {
    errors.push("Contradictory cost data: costBreakdown.isLandedCostDefensible is true but totalLandedCostCents is null.");
  }
  if (cb.isLandedCostDefensible) {
    if (!cb.isMerchandiseDefensible) {
      errors.push("Contradictory cost data: merchandise is not defensible.");
    }
    if (!cb.isShippingDefensible) {
      errors.push("Contradictory cost data: shipping is not defensible.");
    }
    if (!cb.isDiscountDefensible) {
      errors.push("Contradictory cost data: discount is not defensible.");
    }
    if (!cb.isTaxDefensible) {
      errors.push("Contradictory cost data: tax is not defensible.");
    }
  }
  if (cb.isLandedCostDefensible && cb.missingComponents && cb.missingComponents.length > 0) {
    errors.push(`Contradictory cost data: costBreakdown.isLandedCostDefensible is true but missingComponents contains: ${cb.missingComponents.join(", ")}.`);
  }

  // 5. Contradictory completeness: total present when mandatory components are null
  if (cb.totalLandedCostCents !== null && cb.shippingCents === null) {
    errors.push("Contradictory cost data: totalLandedCostCents is non-null but shippingCents is null.");
  }
  if (strategy.totalLandedCostCents !== null && strategy.totalShippingCents === null) {
    errors.push("Contradictory cost data: strategy.totalLandedCostCents is non-null but totalShippingCents is null.");
  }

  // 6. Arithmetic inconsistencies
  if (cb.totalLandedCostCents !== null && cb.shippingCents !== null && cb.taxCents !== null) {
    const expectedCbTotal = cb.merchandiseSubtotalCents + cb.shippingCents - cb.discountCents + cb.taxCents;
    if (cb.totalLandedCostCents !== expectedCbTotal) {
      errors.push(
        `Contradictory cost data: arithmetic mismatch on costBreakdown. totalLandedCostCents (${cb.totalLandedCostCents}) !== merchandise (${cb.merchandiseSubtotalCents}) + shipping (${cb.shippingCents}) - discount (${cb.discountCents}) + tax (${cb.taxCents}) = ${expectedCbTotal}.`
      );
    }
  }
  if (strategy.totalLandedCostCents !== null && strategy.totalShippingCents !== null) {
    const expectedStrategyTotal =
      strategy.totalMerchandiseCents +
      strategy.totalShippingCents -
      strategy.totalDiscountCents +
      strategy.totalEstimatedTaxCents;
    if (strategy.totalLandedCostCents !== expectedStrategyTotal) {
      errors.push(
        `Contradictory cost data: arithmetic mismatch on strategy. totalLandedCostCents (${strategy.totalLandedCostCents}) !== merchandise (${strategy.totalMerchandiseCents}) + shipping (${strategy.totalShippingCents}) - discount (${strategy.totalDiscountCents}) + tax (${strategy.totalEstimatedTaxCents}) = ${expectedStrategyTotal}.`
      );
    }
  }

  return {
    hasContradiction: errors.length > 0,
    errors,
  };
}

/**
 * Validates cost invariants on a ProcurementStrategy object.
 * Rejects inconsistent strategies where isLandedCostDefensible is true but totalLandedCostCents is null,
 * costBreakdown is missing, cost components are negative or invalid, cross-object values disagree,
 * or arithmetic does not match.
 */
export function validateCostInvariants(strategy: ProcurementStrategy): {
  readonly isValid: boolean;
  readonly errors: readonly string[];
} {
  const contradictionCheck = detectCostContradictions(strategy);
  const errors: string[] = [...contradictionCheck.errors];

  const cb = strategy.costBreakdown;
  if (!cb) {
    return { isValid: false, errors };
  }

  // When landed cost is claimed to be defensible, tax must be defensible
  if (cb.isLandedCostDefensible && !cb.isTaxDefensible) {
    errors.push("Cost invariant violation: tax is not defensible.");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Asserts cost invariants; throws Error if violated.
 * Strict prerequisite for Tier 1 classification: enforces that all cost components
 * (merchandise, shipping, tax, discount) are verified and defensible.
 */
export function assertCostInvariants(strategy: ProcurementStrategy): void {
  const res = validateCostInvariants(strategy);
  if (!res.isValid) {
    throw new Error(`Cost invariant violation in strategy "${strategy.strategyId}": ${res.errors.join("; ")}`);
  }
  const cb = strategy.costBreakdown;
  if (!cb) {
    throw new Error(`Cost invariant violation in strategy "${strategy.strategyId}": Strategy is missing required costBreakdown.`);
  }
  if (!cb.isTaxDefensible) {
    throw new Error(`Cost invariant violation in strategy "${strategy.strategyId}": tax is not defensible.`);
  }
  if (!cb.isLandedCostDefensible) {
    const reasons: string[] = [];
    if (!cb.isMerchandiseDefensible) reasons.push("merchandise is not defensible");
    if (!cb.isShippingDefensible) reasons.push("shipping is not defensible");
    if (!cb.isTaxDefensible) reasons.push("tax is not defensible");
    if (!cb.isDiscountDefensible) reasons.push("discount is not defensible");
    throw new Error(
      `Cost invariant violation in strategy "${strategy.strategyId}": Landed cost is not defensible: ${reasons.join(", ")} (missingComponents: ${cb.missingComponents.join(", ")}).`
    );
  }
}

/**
 * Maps a ProcurementStrategy to its explicit 1-4 StrategyTier.
 * Under P1 requirements:
 * Any strategy with contradictory monetary data MUST be Tier 4 (Blocked).
 * Tier 2 is reserved for incomplete but internally consistent costs.
 */
export function getStrategyTier(strategy: ProcurementStrategy): StrategyTier {
  // P1: Contradictory monetary data must be Tier 4 (Blocked), preceding any other classification
  const contradictionCheck = detectCostContradictions(strategy);
  if (contradictionCheck.hasContradiction) {
    return 4;
  }

  if (strategy.feasibility === "blocked") return 4;
  if (strategy.feasibility === "uncertain") return 3;
  if (strategy.feasibility === "feasible") {
    const cb = strategy.costBreakdown;
    if (
      strategy.isLandedCostDefensible &&
      strategy.totalLandedCostCents !== null &&
      cb &&
      cb.isLandedCostDefensible &&
      cb.isMerchandiseDefensible &&
      cb.isShippingDefensible &&
      cb.isTaxDefensible &&
      cb.isDiscountDefensible &&
      strategy.missingShippingCostCount === 0 &&
      strategy.totalShippingCents !== null
    ) {
      return 1;
    }
    // Tier 2: Feasible with incomplete but internally consistent cost data
    return 2;
  }
  return 4;
}

/**
 * Deterministic UTF-16 code-point string comparator.
 * Guarantees platform- and locale-independent collation: a < b ? -1 : a > b ? 1 : 0.
 */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deep deterministic canonical JSON serialization:
 * 1. Primitives (boolean, string) serialized standardly.
 * 2. Numbers: finite numbers serialized standardly; non-finite numbers (NaN, Infinity, -Infinity)
 *    normalized to "null" (consistent with ECMAScript JSON.stringify standard).
 * 3. undefined, symbol, and function values normalized to "null".
 * 4. BigInt values serialized to quoted numeric string.
 * 5. Dates: valid dates serialized to ISO 8601 string; invalid dates normalized to "null".
 * 6. Circular references: strictly tracked and rejected with TypeError.
 * 7. Arrays: recursively serialized with undefined/unsupported items mapped to "null".
 * 8. Objects: keys recursively sorted by UTF-16 code point order (Object.keys(obj).sort(compareCodePoints)).
 */
export function canonicalJsonStringify(val: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (val === null || val === undefined) {
    return "null";
  }
  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      return "null";
    }
    return JSON.stringify(val);
  }
  if (typeof val === "string") {
    return JSON.stringify(val);
  }
  if (typeof val === "symbol" || typeof val === "function") {
    return "null";
  }
  if (typeof val === "bigint") {
    return JSON.stringify(val.toString());
  }
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? "null" : JSON.stringify(val.toISOString());
  }
  if (typeof val === "object") {
    if (seen.has(val)) {
      throw new TypeError("Cannot canonically serialize object: circular reference detected.");
    }
    seen.add(val);

    try {
      if (Array.isArray(val)) {
        return "[" + val.map((item) => canonicalJsonStringify(item === undefined ? null : item, seen)).join(",") + "]";
      }

      const obj = val as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort(compareCodePoints);
      return (
        "{" +
        sortedKeys
          .map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify(obj[k] === undefined ? null : obj[k], seen))
          .join(",") +
        "}"
      );
    } finally {
      seen.delete(val);
    }
  }
  return JSON.stringify(val);
}

/**
 * Deterministic comparator for arbitrary objects based on their canonical JSON serialization.
 */
export function compareCanonicalObjects(a: unknown, b: unknown): number {
  const sa = canonicalJsonStringify(a);
  const sb = canonicalJsonStringify(b);
  return compareCodePoints(sa, sb);
}

/**
 * 4-Tier Defensive Strategy Comparator:
 * Tier 1 (feasible-complete) > Tier 2 (feasible-incomplete) > Tier 3 (uncertain) > Tier 4 (blocked).
 * Invariant: An incomplete strategy can NEVER outrank a complete defensible strategy regardless of score!
 */
export function compareStrategiesDefensively(
  a: ProcurementStrategy,
  b: ProcurementStrategy
): number {
  const tierA = getStrategyTier(a);
  const tierB = getStrategyTier(b);

  if (tierA !== tierB) {
    return tierA - tierB;
  }

  // Within Tier 1 (feasible-complete):
  if (tierA === 1) {
    // 1. Lower total landed cost
    if (a.totalLandedCostCents !== null && b.totalLandedCostCents !== null) {
      if (a.totalLandedCostCents !== b.totalLandedCostCents) {
        return a.totalLandedCostCents - b.totalLandedCostCents;
      }
    }
    // 2. Higher recommendation score
    if (b.recommendationScore !== a.recommendationScore) {
      return b.recommendationScore - a.recommendationScore;
    }
    // 3. Strategy ID tie-breaker
    return compareCodePoints(a.strategyId, b.strategyId);
  }

  // Within Tiers 2, 3, 4:
  if (b.recommendationScore !== a.recommendationScore) {
    return b.recommendationScore - a.recommendationScore;
  }
  return compareCodePoints(a.strategyId, b.strategyId);
}

/**
 * Computes deterministic SHA-256 canonical evidence-content fingerprint.
 * Strictly excludes evaluatedAt to ensure timestamp independence.
 * Changes to any material fact (price, quantity, destination, quote, policy, warranty, authenticity)
 * produces a completely different hash.
 */
export function computeCanonicalEvidenceFingerprint(
  strategy: ProcurementStrategy,
  lineItems: readonly ProcurementLineItem[],
  destination: DestinationContext,
  taxEvidence?: TaxEvidence
): string {
  // Deterministic canonical sorting for all collections accounting for every material field:
  // 1. Line items: sort requirements deterministically, then sort line items by full canonical serialization
  const canonicalLineItems = [...lineItems]
    .map((li) => {
      const sortedRequirements = [...(li.requirements ?? [])]
        .map((r) =>
          typeof r === "string"
            ? { key: r, expectedValue: null, description: null }
            : { key: r.key, expectedValue: r.expectedValue ?? null, description: r.description ?? null }
        )
        .sort(compareCanonicalObjects);

      return {
        id: li.id,
        title: li.title,
        quantity: li.quantity,
        budgetCents: li.budgetCents ?? null,
        currency: li.currency,
        quantitySource: li.quantitySource ?? null,
        quantityConfirmed: li.quantityConfirmed ?? false,
        originalInferredQuantity: li.originalInferredQuantity ?? null,
        confirmationToken: li.confirmationToken ?? null,
        confirmedAt: li.confirmedAt ?? null,
        confirmedBy: li.confirmedBy ?? null,
        verificationLevel: li.verificationLevel ?? "standard",
        selectedCandidateId: li.selectedCandidateId ?? null,
        requirements: sortedRequirements,
      };
    })
    .sort(compareCanonicalObjects);

  // 2. Allocations: map every material field and sort by complete canonical serialization
  const canonicalAllocations = [...strategy.allocations]
    .map((a) => ({
      lineItemId: a.lineItemId,
      candidateId: a.candidateId,
      externalId: a.externalId,
      title: a.title,
      unitPriceCents: a.unitPriceCents,
      quantity: a.quantity,
      currency: a.currency,
      merchantName: a.merchantName,
      merchantUrl: a.merchantUrl,
      sellerName: a.sellerName,
      isMarketplace: a.isMarketplace,
      isDirectRetailerSeller: a.isDirectRetailerSeller,
      isWfsFulfilled: a.isWfsFulfilled ?? false,
      fulfillmentMethod: a.fulfillmentMethod,
      requiresSpecialDelivery: a.requiresSpecialDelivery ?? false,
      availability: a.availability ?? null,
      rawAttributes: a.rawAttributes ?? null,
      isManufacturerAuthorized: a.authenticity?.isManufacturerAuthorized ?? false,
      authorizationEvidence: a.authenticity?.authorizationEvidence ?? null,
      isProductAuthenticVerified: a.authenticity?.isProductAuthenticVerified ?? false,
      authenticityEvidence: a.authenticity?.authenticityEvidence ?? null,
      warrantyCoverage: a.authenticity?.warrantyCoverage ?? "unverified",
      warrantyEvidence: a.authenticity?.warrantyEvidence ?? null,
      evidenceTier: a.authenticity?.evidenceTier ?? "unknown",
      snapshotHash: a.snapshotHash,
      capturedAt: a.capturedAt,
      matchedSpecs: [...(a.matchedSpecs ?? [])].sort(compareCodePoints),
      contradictorySpecs: [...(a.contradictorySpecs ?? [])].sort(compareCodePoints),
      missingSpecs: [...(a.missingSpecs ?? [])].sort(compareCodePoints),
      observationList: a.observationList ? [...a.observationList].sort(compareCanonicalObjects) : null,
    }))
    .sort(compareCanonicalObjects);

  // 3. Carts: sort shipments and cart items deterministically, then sort carts by complete canonical serialization
  const canonicalCarts = [...strategy.carts]
    .map((c) => {
      const sortedShipments = c.shipments
        .map((s) => ({
          shipmentId: s.shipmentId,
          merchantDomain: s.merchantDomain,
          sellerName: s.sellerName,
          fulfillmentMethod: s.fulfillmentMethod,
          splitReason: s.splitReason,
          merchandiseSubtotalCents: s.merchandiseSubtotalCents,
          shippingChargeCents: s.shippingChargeCents,
          isShippingVerified: s.isShippingVerified,
          isQuoteBound: s.isQuoteBound,
          shippingEvidenceType: s.shippingEvidenceType,
          deliveryDate: s.deliveryDate ?? null,
          carrier: s.carrier ?? null,
          trackingAvailable: s.trackingAvailable,
          explanation: s.explanation,
          quoteId: s.quoteId ?? null,
          quoteReference: s.quoteReference ?? null,
          quoteExpiresAt: s.quoteExpiresAt ?? null,
          items: [...s.items]
            .map((it) => ({
              lineItemId: it.lineItemId,
              candidateId: it.candidateId,
              title: it.title,
              quantity: it.quantity,
              unitPriceCents: it.unitPriceCents,
            }))
            .sort(compareCanonicalObjects),
        }))
        .sort(compareCanonicalObjects);

      const sortedCartItems = [...c.items]
        .map((it) => ({
          lineItemId: it.lineItemId,
          candidateId: it.candidateId,
          externalId: it.externalId,
          title: it.title,
          unitPriceCents: it.unitPriceCents,
          quantity: it.quantity,
          lineItemTotalCents: it.lineItemTotalCents,
          currency: it.currency,
          sellerName: it.sellerName,
          isMarketplace: it.isMarketplace,
          isDirectRetailerSeller: it.isDirectRetailerSeller,
          isWfsFulfilled: it.isWfsFulfilled,
          fulfillmentMethod: it.fulfillmentMethod,
          requiresSpecialDelivery: it.requiresSpecialDelivery,
          contributesToCartThreshold: it.contributesToCartThreshold,
          isIndividuallyEligibleForFreeShipping: it.isIndividuallyEligibleForFreeShipping,
          itemShippingCents: it.itemShippingCents,
        }))
        .sort(compareCanonicalObjects);

      return {
        merchantDomain: c.merchantDomain,
        merchantName: c.merchantName,
        merchandiseSubtotalCents: c.merchandiseSubtotalCents,
        shippingCents: c.totalShippingCents,
        cartLevelShippingCents: c.cartLevelShippingCents ?? null,
        itemLevelShippingTotalCents: c.itemLevelShippingTotalCents ?? null,
        isShippingComplete: c.isShippingComplete,
        policyId: c.thresholdEvaluation?.policyId ?? null,
        policyVersion: c.thresholdEvaluation?.policyVersion ?? null,
        policyDocumentFingerprint: c.thresholdEvaluation?.policyDocumentFingerprint ?? null,
        thresholdCents: c.thresholdEvaluation?.thresholdCents ?? null,
        qualifyingMerchandiseSubtotalCents: c.thresholdEvaluation?.qualifyingMerchandiseSubtotalCents ?? null,
        thresholdSatisfied: c.thresholdEvaluation?.thresholdSatisfied ?? false,
        remainingToThresholdCents: c.thresholdEvaluation?.remainingToThresholdCents ?? null,
        discountCents: c.thresholdEvaluation?.discountCents ?? null,
        appliesPreTax: c.thresholdEvaluation?.appliesPreTax ?? false,
        policyExplanation: c.thresholdEvaluation?.explanation ?? null,
        items: sortedCartItems,
        shipments: sortedShipments,
      };
    })
    .sort(compareCanonicalObjects);

  const destinationState = resolveDestinationJurisdictionState(destination);
  const effectiveTax =
    taxEvidence ??
    evaluateDestinationTax(
      destination,
      undefined,
      undefined,
      SERVER_TAX_AUTHORITY_REGISTRY,
      SERVER_JURISDICTION_TAX_RULES_V1,
      strategy.currency
    ).taxEvidence;

  const canonicalTax = {
    jurisdictionState: effectiveTax.jurisdictionState ?? destinationState,
    postalCode: effectiveTax.postalCode ?? destination.postalCode,
    status: effectiveTax.status,
    amountCents: effectiveTax.amountCents ?? strategy.costBreakdown?.taxCents ?? null,
    evidenceReference: effectiveTax.evidenceReference ?? null,
    sourceIdentity: effectiveTax.sourceIdentity ?? null,
    quotedAt: effectiveTax.quotedAt ?? null,
    expiresAt: effectiveTax.expiresAt ?? null,
    currency: effectiveTax.currency ?? null,
    quoteSignature: effectiveTax.quoteSignature ?? null,
    quoteId: effectiveTax.quoteId ?? null,
    explanation: effectiveTax.explanation,
  };

  const canonicalDiscount = {
    amountCents: strategy.costBreakdown?.discountCents ?? strategy.totalDiscountCents,
    isDefensible: strategy.costBreakdown?.isDiscountDefensible ?? true,
    evidenceReference: strategy.costBreakdown?.discountEvidenceReference ?? null,
  };

  const canonicalCostBreakdown = strategy.costBreakdown
    ? {
        merchandiseSubtotalCents: strategy.costBreakdown.merchandiseSubtotalCents,
        shippingCents: strategy.costBreakdown.shippingCents,
        discountCents: strategy.costBreakdown.discountCents,
        taxCents: strategy.costBreakdown.taxCents,
        totalLandedCostCents: strategy.costBreakdown.totalLandedCostCents,
        currency: strategy.costBreakdown.currency,
        isMerchandiseDefensible: strategy.costBreakdown.isMerchandiseDefensible,
        isShippingDefensible: strategy.costBreakdown.isShippingDefensible,
        isTaxDefensible: strategy.costBreakdown.isTaxDefensible,
        isDiscountDefensible: strategy.costBreakdown.isDiscountDefensible,
        isLandedCostDefensible: strategy.costBreakdown.isLandedCostDefensible,
        missingComponents: [...strategy.costBreakdown.missingComponents].sort(compareCodePoints),
        discountEvidenceReference: strategy.costBreakdown.discountEvidenceReference ?? null,
      }
    : null;

  const canonicalPayload = {
    lineItems: canonicalLineItems,
    destination: {
      country: destination.country,
      postalCode: destination.postalCode,
      deliveryMethodPreference: destination.deliveryMethodPreference ?? "standard_ground",
      jurisdictionState: destinationState,
    },
    allocations: canonicalAllocations,
    carts: canonicalCarts,
    costBreakdown: canonicalCostBreakdown,
    discount: canonicalDiscount,
    tax: canonicalTax,
    totalMerchandiseCents: strategy.totalMerchandiseCents,
    totalShippingCents: strategy.totalShippingCents,
    totalDiscountCents: strategy.totalDiscountCents,
    totalEstimatedTaxCents: strategy.totalEstimatedTaxCents,
    totalLandedCostCents: strategy.totalLandedCostCents,
    isLandedCostDefensible: strategy.isLandedCostDefensible,
    isQuoteBacked: strategy.isQuoteBacked,
    shippingEvidenceType: strategy.shippingEvidenceType,
    currency: strategy.currency,
    riskDisclosures: [...strategy.riskDisclosures].sort(compareCodePoints),
  };

  const json = canonicalJsonStringify(canonicalPayload);
  return createHash("sha256").update(json, "utf8").digest("hex").toLowerCase();
}

/**
 * Generates structured, verifiable trade-offs across cost, quality, compatibility, availability, and delivery.
 */
export function generateStrategyTradeOffs(
  strategy: ProcurementStrategy,
  lineItems: readonly ProcurementLineItem[]
): StrategyTradeOffs {
  const totalItems = lineItems.length;
  const allocations = strategy.allocations;

  // 1. Cost trade-off
  const costDesc = strategy.isLandedCostDefensible && strategy.totalLandedCostCents !== null
    ? `Defensible total landed cost of $${(strategy.totalLandedCostCents / 100).toFixed(2)} USD (merchandise: $${(strategy.totalMerchandiseCents / 100).toFixed(2)}, shipping: $${((strategy.totalShippingCents ?? 0) / 100).toFixed(2)}, tax: $${((strategy.totalEstimatedTaxCents) / 100).toFixed(2)}).`
    : `Incomplete landed cost: merchandise subtotal is $${(strategy.totalMerchandiseCents / 100).toFixed(2)} USD, but ${strategy.missingShippingCostCount} shipping charge(s) or jurisdiction tax quotes remain unverified.`;
  const costTier: EvidenceTier = strategy.isLandedCostDefensible ? "verified_fact" : "estimate";

  // 2. Quality trade-off
  const directCount = allocations.filter((a) => a.isDirectRetailerSeller).length;
  const authCount = allocations.filter((a) => a.authenticity?.isManufacturerAuthorized).length;
  const verifiedAuthenticCount = allocations.filter((a) => a.authenticity?.isProductAuthenticVerified).length;
  const fullWarrantyCount = allocations.filter((a) => a.authenticity?.warrantyCoverage === "full_manufacturer").length;

  const qualityDesc = `${directCount}/${allocations.length} direct retailer; ${authCount}/${allocations.length} authorized dealer; ${verifiedAuthenticCount}/${allocations.length} verified authentic; ${fullWarrantyCount}/${allocations.length} full manufacturer warranty.`;
  const qualityTier: EvidenceTier = (authCount === allocations.length && verifiedAuthenticCount === allocations.length && fullWarrantyCount === allocations.length && allocations.length > 0)
    ? "verified_fact"
    : (directCount > 0 ? "merchant_claim" : "unknown");

  // 3. Compatibility trade-off: dynamically evaluate specifications
  let totalRequirements = 0;
  let matchedSpecsCount = 0;
  let contradictoryCount = 0;

  for (const li of lineItems) {
    totalRequirements += li.requirements?.length ?? 0;
    const alloc = allocations.find((a) => a.lineItemId === li.id);
    if (alloc) {
      const candMock: NormalizedProductCandidate = {
        id: alloc.candidateId,
        purchaseId: "pur_compat_eval",
        source: "seeded",
        externalId: alloc.externalId,
        title: alloc.title,
        merchantName: alloc.merchantName,
        merchantUrl: alloc.merchantUrl,
        unitPriceCents: alloc.unitPriceCents,
        quantity: alloc.quantity,
        shippingCents: 0,
        totalCents: alloc.unitPriceCents * alloc.quantity,
        currency: alloc.currency,
        availability: (alloc.availability ?? "unknown") as NormalizedProductCandidate["availability"],
        capturedAt: new Date(alloc.capturedAt),
        snapshotHash: alloc.snapshotHash,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: alloc.sellerName,
        isDirectRetailerSeller: alloc.isDirectRetailerSeller,
        isMarketplace: alloc.isMarketplace,
        fulfillmentMethod: alloc.fulfillmentMethod,
        rawAttributes: alloc.rawAttributes,
      };
      const compat = checkCandidateCompatibility(li, candMock);
      matchedSpecsCount += compat.matchedSpecs.length;
      contradictoryCount += compat.contradictorySpecs.length;
    }
  }

  const matchRatio = totalRequirements > 0
    ? (matchedSpecsCount > 0 ? matchedSpecsCount / totalRequirements : (contradictoryCount === 0 ? allocations.length / totalItems : 0))
    : (allocations.length / Math.max(1, totalItems));
  const compatDesc = contradictoryCount > 0
    ? `Specification contradiction detected (${contradictoryCount} contradicting attributes). Compatibility blocked.`
    : `${allocations.length}/${totalItems} line items allocated with verified specification compatibility.`;
  const compatTier: EvidenceTier = contradictoryCount > 0
    ? "merchant_claim"
    : (totalRequirements > 0 && matchedSpecsCount === totalRequirements ? "verified_fact" : "merchant_claim");

  // 4. Availability trade-off: do not label unknown availability as "verified_fact"
  const anyUnknown = allocations.some((a) => a.availability === "unknown" || !a.availability);
  const anyBackorderOrPreorder = allocations.some((a) => a.availability === "backorder" || a.availability === "preorder");
  const allInStock = allocations.length > 0 && allocations.every((a) => a.availability === "in_stock");

  const availDesc = allInStock
    ? "All allocated candidates are currently in stock."
    : (anyUnknown ? "One or more allocated candidates have unknown stock status." : "One or more allocated candidates are backordered or preorder.");

  let availTier: EvidenceTier = "unknown";
  if (anyUnknown) {
    availTier = "unknown";
  } else if (anyBackorderOrPreorder) {
    availTier = "estimate";
  } else if (allInStock) {
    availTier = "verified_fact";
  }

  // 5. Delivery trade-off: policy-derived shipping is "merchant_claim", only carrier-quoted is "verified_fact"
  const deliveryDesc = `${strategy.shipmentCount} shipment(s) across ${strategy.retailerCount} retailer cart(s). Shipping evidence: ${strategy.shippingEvidenceType}.`;
  let deliveryTier: EvidenceTier = "unknown";
  if (strategy.isQuoteBacked) {
    deliveryTier = "verified_fact";
  } else if (strategy.shippingEvidenceType === "policy_derived") {
    deliveryTier = "merchant_claim";
  } else {
    deliveryTier = "unknown";
  }

  return {
    cost: {
      description: costDesc,
      evidenceTier: costTier,
      evidenceReference: strategy.isLandedCostDefensible ? "landed_cost_audit_trail" : undefined,
    },
    quality: {
      description: qualityDesc,
      evidenceTier: qualityTier,
      evidenceReference: authCount > 0 ? "manufacturer_authorization_registry" : undefined,
    },
    compatibility: {
      description: compatDesc,
      matchRatio,
      contradictoryCount,
      evidenceTier: compatTier,
    },
    availability: {
      description: availDesc,
      allInStock,
      evidenceTier: availTier,
    },
    delivery: {
      description: deliveryDesc,
      shipmentCount: strategy.shipmentCount,
      isQuoteBound: strategy.isQuoteBacked,
      deliveryDate: strategy.carts.flatMap((c) => c.shipments).find((s) => s.deliveryDate)?.deliveryDate ?? null,
      evidenceTier: deliveryTier,
    },
  };
}

/**
 * Computes multi-objective balanced score strictly clamped to [0, 100].
 * Handles zero budget, zero requirements, and unknown inventory without division by zero.
 */
export function computeBalancedStrategyScore(params: {
  readonly allocations: readonly LineItemCandidateAllocation[];
  readonly lineItems: readonly ProcurementLineItem[];
  readonly carts: readonly import("./types").RetailerCart[];
  readonly totalLandedCostCents: number | null;
  readonly isLandedCostDefensible: boolean;
  readonly totalMerchandiseCents: number;
  readonly isQuoteBacked: boolean;
  readonly shippingEvidenceType: string;
}): {
  readonly score: number;
  readonly costScore: number;
  readonly qualityScore: number;
  readonly compatScore: number;
  readonly availScore: number;
  readonly deliveryScore: number;
  readonly rationale: string;
} {
  const {
    allocations,
    lineItems,
    carts,
    totalLandedCostCents,
    isLandedCostDefensible,
    totalMerchandiseCents,
    isQuoteBacked,
    shippingEvidenceType,
  } = params;

  // 1. Compatibility sub-score (0 - 100)
  // Hard gate: If any allocated candidate contradicts required specifications, score drops to 0
  let compatScore = 100;
  let totalRequirements = 0;
  let matchedRequirements = 0;
  let contradictorySpecsCount = 0;

  for (const li of lineItems) {
    totalRequirements += li.requirements?.length ?? 0;
    const alloc = allocations.find((a) => a.lineItemId === li.id);
    if (alloc) {
      const candMock: NormalizedProductCandidate = {
        id: alloc.candidateId,
        purchaseId: "pur_compat_eval",
        source: "seeded",
        externalId: alloc.externalId,
        title: alloc.title,
        merchantName: alloc.merchantName,
        merchantUrl: alloc.merchantUrl,
        unitPriceCents: alloc.unitPriceCents,
        quantity: alloc.quantity,
        shippingCents: 0,
        totalCents: alloc.unitPriceCents * alloc.quantity,
        currency: alloc.currency,
        availability: (alloc.availability ?? "unknown") as NormalizedProductCandidate["availability"],
        capturedAt: new Date(alloc.capturedAt),
        snapshotHash: alloc.snapshotHash,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: alloc.sellerName,
        isDirectRetailerSeller: alloc.isDirectRetailerSeller,
        isMarketplace: alloc.isMarketplace,
        fulfillmentMethod: alloc.fulfillmentMethod,
        rawAttributes: alloc.rawAttributes,
      };
      const compat = checkCandidateCompatibility(li, candMock);
      matchedRequirements += compat.matchedSpecs.length;
      contradictorySpecsCount += compat.contradictorySpecs.length;
    }
  }

  if (contradictorySpecsCount > 0) {
    compatScore = 0;
  } else if (totalRequirements > 0) {
    compatScore = Math.round((matchedRequirements / totalRequirements) * 100);
  } else {
    // Zero requirements: default 100 without division by zero
    compatScore = 100;
  }

  // 2. Cost sub-score (0 - 100)
  let costScore = 70; // Defensible default when budget is undefined or zero
  const totalBudgetCents = lineItems.reduce((acc, li) => acc + (li.budgetCents ?? 0), 0);

  if (totalBudgetCents > 0) {
    const effectiveCost = isLandedCostDefensible && totalLandedCostCents !== null ? totalLandedCostCents : totalMerchandiseCents;
    if (effectiveCost <= totalBudgetCents) {
      const savingsRatio = (totalBudgetCents - effectiveCost) / totalBudgetCents;
      costScore = 60 + Math.min(40, Math.round(savingsRatio * 40));
    } else {
      const excessRatio = (effectiveCost - totalBudgetCents) / totalBudgetCents;
      costScore = Math.max(0, 50 - Math.round(excessRatio * 50));
    }
  }

  // 3. Quality & Authenticity sub-score (0 - 100)
  let qualityScore = 0;
  if (allocations.length > 0) {
    let qualityPoints = 0;
    for (const a of allocations) {
      if (a.isDirectRetailerSeller) qualityPoints += 25;
      if (a.authenticity?.isManufacturerAuthorized) qualityPoints += 25;
      if (a.authenticity?.isProductAuthenticVerified) qualityPoints += 25;
      if (a.authenticity?.warrantyCoverage === "full_manufacturer") qualityPoints += 25;
    }
    qualityScore = Math.round(qualityPoints / allocations.length);
  }

  // 4. Availability sub-score (0 - 100)
  let availScore = 50; // Neutral default for unknown inventory
  if (allocations.length > 0) {
    let availPoints = 0;
    for (const a of allocations) {
      if (a.availability === "in_stock") availPoints += 100;
      else if (a.availability === "backorder" || a.availability === "preorder") availPoints += 50;
      else if (a.availability === "unknown") availPoints += 50;
      else availPoints += 0;
    }
    availScore = Math.round(availPoints / allocations.length);
  }

  // 5. Delivery & Fulfillment sub-score (0 - 100)
  let deliveryPoints = 0;
  if (isQuoteBacked) deliveryPoints += 40;
  else if (shippingEvidenceType === "policy_derived") deliveryPoints += 30;
  else deliveryPoints += 10;

  const totalShipments = carts.reduce((acc, c) => acc + c.shipments.length, 0);
  if (totalShipments === 1) deliveryPoints += 30;
  else if (totalShipments > 1) deliveryPoints += Math.max(0, 30 - (totalShipments - 1) * 10);

  const hasDeliveryDates = carts.flatMap((c) => c.shipments).some((s) => s.deliveryDate !== null);
  if (hasDeliveryDates) deliveryPoints += 30;
  else deliveryPoints += 10;

  const deliveryScore = Math.min(100, deliveryPoints);

  // Weighted combined score:
  // Cost: 25%, Quality: 25%, Compat: 20%, Avail: 15%, Delivery: 15%
  const rawWeighted = (
    costScore * 0.25 +
    qualityScore * 0.25 +
    compatScore * 0.20 +
    availScore * 0.15 +
    deliveryScore * 0.15
  );

  const clampedScore = Math.max(0, Math.min(100, Math.round(rawWeighted * 10) / 10));

  const rationale = `Balanced optimal procurement: cost=${costScore}/100, quality=${qualityScore}/100, compatibility=${compatScore}/100, availability=${availScore}/100, delivery=${deliveryScore}/100.`;

  return {
    score: clampedScore,
    costScore,
    qualityScore,
    compatScore,
    availScore,
    deliveryScore,
    rationale,
  };
}

/**
 * Builds a ProcurementStrategy object from an allocation of candidates to line items.
 */
export function buildStrategyFromAllocations(
  strategyId: string,
  name: string,
  description: string,
  allocations: readonly LineItemCandidateAllocation[],
  lineItems: readonly ProcurementLineItem[],
  destination: DestinationContext,
  now: Date = new Date(),
  buyerMemberships: readonly string[] = [],
  explicitTax?: TaxEvidence
): ProcurementStrategy {
  const carts = aggregateRetailerCarts({
    allocations,
    destination,
    now,
    buyerMemberships,
  });

  // Calculate merchandise subtotal
  const totalMerchandiseCents = carts.reduce((acc, c) => acc + c.merchandiseSubtotalCents, 0);

  // Check shipping completeness and evidence types across all carts
  let totalShippingCents: number | null = 0;
  let missingShippingCostCount = 0;
  let shipmentCount = 0;
  let quotedCount = 0;
  let policyDerivedCount = 0;
  let missingCount = 0;

  for (const cart of carts) {
    shipmentCount += cart.shipments.length;
    for (const ship of cart.shipments) {
      if (ship.shippingChargeCents === null) {
        totalShippingCents = null;
        missingShippingCostCount++;
        missingCount++;
      } else if (totalShippingCents !== null) {
        totalShippingCents += ship.shippingChargeCents;
      }

      if (ship.shippingEvidenceType === "quoted") {
        quotedCount++;
      } else if (ship.shippingEvidenceType === "policy_derived") {
        policyDerivedCount++;
      }
    }
  }

  let shippingEvidenceType: "quoted" | "policy_derived" | "mixed" | "unverified" = "unverified";
  if (missingCount > 0) {
    shippingEvidenceType = "unverified";
  } else if (quotedCount > 0 && policyDerivedCount === 0) {
    shippingEvidenceType = "quoted";
  } else if (policyDerivedCount > 0 && quotedCount === 0) {
    shippingEvidenceType = "policy_derived";
  } else if (quotedCount > 0 && policyDerivedCount > 0) {
    shippingEvidenceType = "mixed";
  }

  const isQuoteBacked = shippingEvidenceType === "quoted";

  // Feasibility determination:
  const allocatedLineItemIds = new Set(allocations.map((a) => a.lineItemId));
  const missingLineItems = lineItems.filter((li) => !allocatedLineItemIds.has(li.id));

  const currency = lineItems[0]?.currency ?? "USD";

  // Evaluate tax with currency validation
  const taxEval = evaluateDestinationTax(
    destination,
    explicitTax,
    now,
    SERVER_TAX_AUTHORITY_REGISTRY,
    SERVER_JURISDICTION_TAX_RULES_V1,
    currency
  );

  const isShippingDefensible = totalShippingCents !== null && missingShippingCostCount === 0;
  const isTaxDefensible = taxEval.isTaxDefensible && taxEval.taxCents !== null;
  const isMerchandiseDefensible = missingLineItems.length === 0 && allocations.length > 0;
  const isDiscountDefensible = true;

  const missingComponents: string[] = [];
  if (!isShippingDefensible) {
    missingComponents.push("shipping");
  }
  if (!isTaxDefensible) {
    missingComponents.push("tax");
  }
  if (!isMerchandiseDefensible) {
    missingComponents.push("merchandise_incomplete");
  }

  const isLandedCostBreakdownDefensible =
    isMerchandiseDefensible &&
    isShippingDefensible &&
    isTaxDefensible &&
    isDiscountDefensible &&
    missingComponents.length === 0;

  const totalDiscountCents = 0;
  const totalEstimatedTaxCents = taxEval.taxCents ?? 0;

  const isLandedCostDefensible = isLandedCostBreakdownDefensible;
  const totalLandedCostCents = isLandedCostBreakdownDefensible
    ? totalMerchandiseCents + (totalShippingCents ?? 0) - totalDiscountCents + (taxEval.taxCents ?? 0)
    : null;

  const costBreakdown: StrategyCostBreakdown = {
    merchandiseSubtotalCents: totalMerchandiseCents,
    shippingCents: totalShippingCents,
    discountCents: totalDiscountCents,
    taxCents: taxEval.taxCents,
    totalLandedCostCents,
    currency,
    isMerchandiseDefensible,
    isShippingDefensible,
    isTaxDefensible: taxEval.isTaxDefensible,
    isDiscountDefensible,
    isLandedCostDefensible,
    missingComponents,
  };

  let feasibility: StrategyFeasibility = "feasible";
  const riskDisclosures: string[] = [];

  if (missingLineItems.length > 0) {
    feasibility = "blocked";
    riskDisclosures.push(`Incomplete fulfillment: missing matching candidates for line items: ${missingLineItems.map((li) => `"${li.title}"`).join(", ")}.`);
  }

  if (missingShippingCostCount > 0) {
    if (feasibility === "feasible") {
      feasibility = "uncertain";
    }
    riskDisclosures.push(`Shipping charges for ${missingShippingCostCount} shipment(s) are unquoted from upstream. Total landed cost cannot be defended as a verified fact.`);
  }

  if (!taxEval.isTaxDefensible) {
    riskDisclosures.push(`Sales tax for destination (${taxEval.taxEvidence.jurisdictionState ?? destination.postalCode}) requires an authoritative quote: ${taxEval.taxEvidence.explanation}`);
  }

  // Count marketplace sellers
  const marketplaceItemCount = allocations.filter((a) => a.isMarketplace).length;
  if (marketplaceItemCount > 0) {
    riskDisclosures.push(`Plan contains ${marketplaceItemCount} third-party marketplace item(s) dispatched from independent seller warehouses.`);
  }

  // Hardware suitability disclosures (DEF-AUD-01)
  for (const alloc of allocations) {
    if (alloc.suitability && alloc.suitability.disclosures && alloc.suitability.disclosures.length > 0) {
      for (const disc of alloc.suitability.disclosures) {
        const msg = `Hardware suitability (${alloc.title}): ${disc}`;
        if (!riskDisclosures.includes(msg)) {
          riskDisclosures.push(msg);
        }
      }
    }
  }

  // Requirement satisfaction score:
  const totalItems = lineItems.length;
  const fulfilledItems = allocations.length;
  const requirementSatisfactionScore = totalItems > 0 ? fulfilledItems / totalItems : 1.0;

  // Recommendation score calculation:
  let recommendationScore = 50.0;
  let recommendationRationale = "";

  if (feasibility === "blocked") {
    recommendationScore = 0;
    recommendationRationale = `Strategy is blocked due to unfulfilled line items.`;
  } else {
    recommendationScore += requirementSatisfactionScore * 30;

    if (carts.length === 1) {
      recommendationScore += 15;
    } else {
      recommendationScore -= (carts.length - 1) * 5;
    }

    if (!isLandedCostDefensible) {
      recommendationScore -= 25;
      recommendationRationale = `Shipping or tax evidence is incomplete (${missingShippingCostCount} unquoted shipment(s)). Although merchandise is $${(totalMerchandiseCents / 100).toFixed(2)}, total landed cost cannot be verified.`;
    } else if (shippingEvidenceType === "policy_derived") {
      recommendationScore += 18;
      recommendationRationale = `Policy-derived landed cost of $${((totalLandedCostCents ?? 0) / 100).toFixed(2)} USD based on published merchant threshold policy ($0 shipping threshold met). A real-time carrier shipping quote is not bound.`;
    } else {
      recommendationScore += 20;
      recommendationRationale = `Fully defensible landed cost of $${((totalLandedCostCents ?? 0) / 100).toFixed(2)} USD with retailer-quoted shipping evidence across ${carts.length} retailer cart(s) and ${shipmentCount} shipment(s).`;
    }
  }

  let effectiveName = name;
  if (strategyId === "strat_lowest_landed_cost") {
    if (shippingEvidenceType === "policy_derived") {
      effectiveName = "Lowest Landed Cost (Policy-Derived)";
    } else if (shippingEvidenceType === "quoted") {
      effectiveName = "Lowest Landed Cost (Verified Quoted)";
    }
  }

  const finalStrategy: ProcurementStrategy = {
    strategyId,
    name: effectiveName,
    description,
    feasibility,
    allocations,
    carts,
    totalMerchandiseCents,
    totalShippingCents,
    totalDiscountCents,
    totalEstimatedTaxCents,
    totalLandedCostCents,
    isLandedCostDefensible,
    currency,
    retailerCount: carts.length,
    shipmentCount,
    missingShippingCostCount,
    requirementSatisfactionScore,
    recommendationScore: Math.max(0, Math.min(100, recommendationScore)),
    recommendationRationale,
    riskDisclosures,
    shippingEvidenceType,
    isQuoteBacked,
    costBreakdown,
  };

  // Validate completeness & integrity against requested line items:
  const completenessValidation = validateStrategyCompleteness(finalStrategy, lineItems);
  if (!completenessValidation.isComplete) {
    (finalStrategy as { feasibility: StrategyFeasibility }).feasibility = "blocked";
    (finalStrategy as { tier: StrategyTier }).tier = 4;
    (finalStrategy as { recommendationScore: number }).recommendationScore = 0;
    (finalStrategy as { isLandedCostDefensible: boolean }).isLandedCostDefensible = false;
    (finalStrategy as { totalLandedCostCents: number | null }).totalLandedCostCents = null;
    if (finalStrategy.costBreakdown) {
      (finalStrategy.costBreakdown as { isLandedCostDefensible: boolean }).isLandedCostDefensible = false;
      (finalStrategy.costBreakdown as { isMerchandiseDefensible: boolean }).isMerchandiseDefensible = false;
      (finalStrategy.costBreakdown as { totalLandedCostCents: number | null }).totalLandedCostCents = null;
    }
    (finalStrategy as { recommendationRationale: string }).recommendationRationale =
      `Strategy is blocked due to unfulfilled line items: Line-item completeness violation (${completenessValidation.errors.join("; ")}). Incomplete strategies cannot be marked feasible.`;
    for (const err of completenessValidation.errors) {
      if (!finalStrategy.riskDisclosures.includes(err)) {
        (finalStrategy.riskDisclosures as string[]).push(err);
      }
    }
  }

  // Validate cost invariants across objects:
  const costValidation = validateCostInvariants(finalStrategy);
  if (!costValidation.isValid) {
    (finalStrategy as { feasibility: StrategyFeasibility }).feasibility = "blocked";
    (finalStrategy as { tier: StrategyTier }).tier = 4;
    (finalStrategy as { recommendationScore: number }).recommendationScore = 0;
    (finalStrategy as { recommendationRationale: string }).recommendationRationale =
      `Strategy blocked: Internal cost invariant violation (${costValidation.errors.join("; ")}). Excluded from buyer recommendations and approval eligibility.`;
  } else if (completenessValidation.isComplete) {
    const tier = getStrategyTier(finalStrategy);
    (finalStrategy as { tier?: StrategyTier }).tier = tier;
    if (tier === 1) {
      assertCostInvariants(finalStrategy);
    }
  }

  // Generate trade-offs
  (finalStrategy as { tradeOffs?: StrategyTradeOffs }).tradeOffs = generateStrategyTradeOffs(finalStrategy, lineItems);

  // Compute canonical evidence fingerprint
  (finalStrategy as { evidenceFingerprint?: string }).evidenceFingerprint = computeCanonicalEvidenceFingerprint(
    finalStrategy,
    lineItems,
    destination,
    taxEval.taxEvidence
  );

  return finalStrategy;
}

/**
 * Generates and ranks procurement strategies based on multi-item requirements and candidate facts.
 */
export function generateProcurementStrategies(input: StrategyGenerationInput): readonly ProcurementStrategy[] {
  const {
    lineItems,
    candidates,
    destination,
    now = new Date(),
    buyerMemberships = [],
    taxEvidence,
  } = input;

  if (lineItems.length === 0 || candidates.length === 0) {
    return [];
  }

  const strategies: ProcurementStrategy[] = [];

  // Strategy 1: Lowest Landed Cost Strategy (optimal pricing per item)
  const lowestCostAllocations = allocateCandidatesToLineItems(lineItems, candidates, {
    allowSharedCandidatesAcrossIdenticalItems: false,
    authenticityRegistry: input.authenticityRegistry,
  });

  if (lowestCostAllocations.allocations.length > 0) {
    strategies.push(
      buildStrategyFromAllocations(
        "strat_lowest_landed_cost",
        "Lowest Landed Cost",
        "Selects the most economical compatible candidate for each line item, grouping them into their respective retailer carts.",
        lowestCostAllocations.allocations,
        lineItems,
        destination,
        now,
        buyerMemberships,
        taxEvidence
      )
    );
  }

  // Strategy 2: Single-Retailer Consolidated Strategy (all items from one merchant)
  const merchants = new Set<string>();
  for (const c of candidates) {
    merchants.add(extractMerchantDomain(c.merchantUrl, c.merchantName));
  }

  let bestConsolidatedMerchant: string | null = null;
  let bestConsolidatedCount = 0;
  let bestConsolidatedCandidates: NormalizedProductCandidate[] = [];

  for (const merchant of merchants) {
    const merchantCandidates = candidates.filter(
      (c) => extractMerchantDomain(c.merchantUrl, c.merchantName) === merchant
    );
    const allocationResult = allocateCandidatesToLineItems(lineItems, merchantCandidates, {
      allowSharedCandidatesAcrossIdenticalItems: false,
      authenticityRegistry: input.authenticityRegistry,
    });

    if (allocationResult.allocations.length > bestConsolidatedCount) {
      bestConsolidatedCount = allocationResult.allocations.length;
      bestConsolidatedMerchant = merchant;
      bestConsolidatedCandidates = merchantCandidates;
    }
  }

  if (bestConsolidatedMerchant && bestConsolidatedCount > 0) {
    const consolidatedAllocations = allocateCandidatesToLineItems(lineItems, bestConsolidatedCandidates, {
      allowSharedCandidatesAcrossIdenticalItems: false,
      authenticityRegistry: input.authenticityRegistry,
    });

    strategies.push(
      buildStrategyFromAllocations(
        "strat_consolidated_single_retailer",
        `Consolidated (${bestConsolidatedMerchant})`,
        `Maximizes fulfillment through a single retailer (${bestConsolidatedMerchant}) to consolidate orders and leverage cart-level shipping thresholds.`,
        consolidatedAllocations.allocations,
        lineItems,
        destination,
        now,
        buyerMemberships,
        taxEvidence
      )
    );
  }

  // Strategy 3: Verified Authoritative / First-Party Strategy (prefers verified first-party retailer items)
  const firstPartyCandidates = candidates.filter(
    (c) => c.isDirectRetailerSeller === true || c.isDirectRetailer === true || c.isWfsFulfilled === true
  );
  if (firstPartyCandidates.length > 0) {
    const firstPartyAllocations = allocateCandidatesToLineItems(lineItems, firstPartyCandidates, {
      allowSharedCandidatesAcrossIdenticalItems: false,
      authenticityRegistry: input.authenticityRegistry,
    });

    if (firstPartyAllocations.allocations.length > 0) {
      strategies.push(
        buildStrategyFromAllocations(
          "strat_authoritative_first_party",
          "Verified Direct Retailer",
          "Prioritizes items sold and fulfilled directly by first-party retailers with verified shipping policies, avoiding third-party marketplace dispatch.",
          firstPartyAllocations.allocations,
          lineItems,
          destination,
          now,
          buyerMemberships,
          taxEvidence
        )
      );
    }
  }

  // Strategy 4: Balanced Optimal Strategy (multi-objective clamped scoring with hard compatibility gate)
  // Scores candidates on balance of quality, brand authorization, in-stock availability, and economical pricing
  const balancedResult = allocateCandidatesToLineItems(lineItems, candidates, {
    allowSharedCandidatesAcrossIdenticalItems: false,
    authenticityRegistry: input.authenticityRegistry,
  });

  if (balancedResult.allocations.length > 0) {
    const balancedStrategy = buildStrategyFromAllocations(
      "strat_balanced_optimal",
      "Balanced Optimal",
      "Optimizes across landed cost, retailer authenticity, specification compatibility, stock availability, and delivery certainty.",
      balancedResult.allocations,
      lineItems,
      destination,
      now,
      buyerMemberships,
      taxEvidence
    );

    // Compute balanced multi-objective score
    const balancedScoring = computeBalancedStrategyScore({
      allocations: balancedStrategy.allocations,
      lineItems,
      carts: balancedStrategy.carts,
      totalLandedCostCents: balancedStrategy.totalLandedCostCents,
      isLandedCostDefensible: balancedStrategy.isLandedCostDefensible,
      totalMerchandiseCents: balancedStrategy.totalMerchandiseCents,
      isQuoteBacked: balancedStrategy.isQuoteBacked,
      shippingEvidenceType: balancedStrategy.shippingEvidenceType,
    });

    if (balancedStrategy.feasibility === "blocked") {
      (balancedStrategy as { recommendationScore: number }).recommendationScore = 0;
      (balancedStrategy as { recommendationRationale: string }).recommendationRationale = `Strategy is blocked due to unfulfilled line items.`;
    } else {
      (balancedStrategy as { recommendationScore: number }).recommendationScore = balancedScoring.score;
      (balancedStrategy as { recommendationRationale: string }).recommendationRationale = balancedScoring.rationale;
    }

    strategies.push(balancedStrategy);
  }

  // Rank strategies defensively using the 4-tier comparator
  strategies.sort((a, b) => compareStrategiesDefensively(a, b));

  return strategies;
}
