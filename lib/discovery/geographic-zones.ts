/**
 * Plinthly Phase 13B — Geographic Eligibility & Destination Zone Resolver.
 *
 * Provides deterministic classification of delivery destinations across:
 * - Contiguous US (CONUS: 48 contiguous states + District of Columbia)
 * - Alaska (AK)
 * - Hawaii (HI)
 * - US Territories (Puerto Rico, US Virgin Islands, Guam, American Samoa, Northern Mariana Islands)
 * - Military Mail (APO, FPO, DPO)
 *
 * Models geographic serviceability and exclusions separately from shipping price calculations.
 */

export type GeographicZone =
  | "contiguous_us"
  | "alaska"
  | "hawaii"
  | "us_territory"
  | "military_apo_fpo"
  | "unknown";

export type DestinationServiceability =
  | "serviceable"
  | "excluded"
  | "unserviceable"
  | "unknown";

export interface GeographicResolutionResult {
  readonly postalCode: string;
  readonly zone: GeographicZone;
  readonly isContiguousUs: boolean;
  readonly stateOrTerritory?: string;
  readonly regionName: string;
  readonly description: string;
}

/**
 * Standard 5-digit US ZIP prefix mappings.
 */
interface PrefixRange {
  readonly min: number;
  readonly max: number;
  readonly zone: GeographicZone;
  readonly code: string;
  readonly name: string;
}

const SPECIFIC_ZONES: readonly PrefixRange[] = [
  // Puerto Rico (00600 - 00799, 00900 - 00999)
  { min: 600, max: 799, zone: "us_territory", code: "PR", name: "Puerto Rico" },
  { min: 900, max: 999, zone: "us_territory", code: "PR", name: "Puerto Rico" },
  // US Virgin Islands (00800 - 00899)
  { min: 800, max: 899, zone: "us_territory", code: "VI", name: "U.S. Virgin Islands" },
  // Military AE (09000 - 09899)
  { min: 9000, max: 9899, zone: "military_apo_fpo", code: "AE", name: "Armed Forces Europe / Africa / Middle East" },
  // Military AA (34000 - 34099)
  { min: 34000, max: 34099, zone: "military_apo_fpo", code: "AA", name: "Armed Forces Americas" },
  // Military AP (96200 - 96699)
  { min: 96200, max: 96699, zone: "military_apo_fpo", code: "AP", name: "Armed Forces Pacific" },
  // Hawaii (96700 - 96899, except 96799)
  { min: 96700, max: 96899, zone: "hawaii", code: "HI", name: "Hawaii" },
  // Guam and Northern Mariana Islands (96910 - 96952)
  { min: 96910, max: 96932, zone: "us_territory", code: "GU", name: "Guam" },
  { min: 96950, max: 96952, zone: "us_territory", code: "MP", name: "Northern Mariana Islands" },
  // Alaska (99500 - 99999)
  { min: 99500, max: 99999, zone: "alaska", code: "AK", name: "Alaska" },
];

/**
 * Resolves a US postal code to its deterministic geographic zone and serviceability region.
 * Handles 5-digit ZIPs and ZIP+4 format.
 */
export function resolveGeographicZone(postalCode: unknown): GeographicResolutionResult {
  if (typeof postalCode !== "string") {
    return {
      postalCode: "",
      zone: "unknown",
      isContiguousUs: false,
      regionName: "Unknown Region",
      description: "Postal code must be a string.",
    };
  }

  const clean = postalCode.trim();
  const match = /^(\d{5})(?:-\d{4})?$/.exec(clean);
  if (!match) {
    return {
      postalCode: clean,
      zone: "unknown",
      isContiguousUs: false,
      regionName: "Invalid ZIP",
      description: `"${clean}" is not a valid 5-digit US ZIP code format.`,
    };
  }

  const zip5Str = match[1];
  const zip5Num = parseInt(zip5Str, 10);

  // Exact ZIP overrides
  if (zip5Str === "96799") {
    return {
      postalCode: zip5Str,
      zone: "us_territory",
      isContiguousUs: false,
      stateOrTerritory: "AS",
      regionName: "American Samoa",
      description: "American Samoa (US Territory)",
    };
  }

  // Check specific non-contiguous and military zones
  for (const range of SPECIFIC_ZONES) {
    if (zip5Num >= range.min && zip5Num <= range.max) {
      return {
        postalCode: zip5Str,
        zone: range.zone,
        isContiguousUs: false,
        stateOrTerritory: range.code,
        regionName: range.name,
        description: `${range.name} (${range.code})`,
      };
    }
  }

  // Valid US 5-digit ZIP outside the specific non-contiguous/military ranges belongs to Contiguous US
  if (zip5Num >= 1000 && zip5Num <= 99499) {
    return {
      postalCode: zip5Str,
      zone: "contiguous_us",
      isContiguousUs: true,
      regionName: "Contiguous United States",
      description: "Contiguous United States (48 states + DC)",
    };
  }

  return {
    postalCode: zip5Str,
    zone: "unknown",
    isContiguousUs: false,
    regionName: "Unassigned ZIP",
    description: `ZIP "${zip5Str}" is unassigned or out of range.`,
  };
}

/**
 * Asserts whether a destination satisfies allowed and excluded zone constraints.
 * Models serviceability separately from monetary shipping cost.
 */
export function checkGeographicEligibility(params: {
  readonly destinationPostalCode: string;
  readonly allowedZones?: readonly GeographicZone[];
  readonly excludedZones?: readonly GeographicZone[];
  readonly excludedPostalCodes?: readonly string[];
}): {
  readonly eligible: boolean;
  readonly serviceability: DestinationServiceability;
  readonly zone: GeographicZone;
  readonly reason: string;
} {
  const geo = resolveGeographicZone(params.destinationPostalCode);

  if (geo.zone === "unknown") {
    return {
      eligible: false,
      serviceability: "unknown",
      zone: "unknown",
      reason: geo.description,
    };
  }

  // Check explicit postal code exclusions
  if (params.excludedPostalCodes && params.excludedPostalCodes.length > 0) {
    const isExcludedZip = params.excludedPostalCodes.some(
      (z) => z.trim().substring(0, 5) === geo.postalCode
    );
    if (isExcludedZip) {
      return {
        eligible: false,
        serviceability: "excluded",
        zone: geo.zone,
        reason: `Postal code ${geo.postalCode} is explicitly excluded from service.`,
      };
    }
  }

  // Check excluded zones
  if (params.excludedZones && params.excludedZones.length > 0) {
    if (params.excludedZones.includes(geo.zone)) {
      return {
        eligible: false,
        serviceability: "excluded",
        zone: geo.zone,
        reason: `Geographic zone "${geo.zone}" (${geo.regionName}) is excluded by policy.`,
      };
    }
  }

  // Check allowed zones (default to contiguous_us if not specified)
  const allowed = params.allowedZones && params.allowedZones.length > 0
    ? params.allowedZones
    : ["contiguous_us"];

  if (!allowed.includes(geo.zone)) {
    return {
      eligible: false,
      serviceability: "unserviceable",
      zone: geo.zone,
      reason: `Geographic zone "${geo.zone}" (${geo.regionName}) is not within allowed service zones: ${allowed.join(", ")}.`,
    };
  }

  return {
    eligible: true,
    serviceability: "serviceable",
    zone: geo.zone,
    reason: `Destination ${geo.postalCode} (${geo.regionName}) is serviceable within allowed zone "${geo.zone}".`,
  };
}
