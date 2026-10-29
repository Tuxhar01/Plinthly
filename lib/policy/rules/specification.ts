/**
 * Deterministic specification canonicalization and equivalence helpers.
 *
 * Enforces strict, conservative canonicalization of technical specifications:
 * 1. Supports RAM / memory capacities expressed in GB, GiB, and gigabytes,
 *    including whitespace and case variations.
 * 2. Parses and compares numeric values and units without floating-point arithmetic.
 * 3. Does not equate different capacities (e.g. 16GB != 32GB) or incompatible units (e.g. 16GB != 16MB).
 * 4. Missing, malformed, or ambiguous values never match.
 * 5. Unsupported units do not silently pass.
 * 6. Unsupported specification types (e.g. color, brand) remain strictly unchanged
 *    and use existing conservative case-insensitive string matching.
 * 7. Pure deterministic execution with zero AI or network dependencies.
 */

export type CapacityUnit =
  | "B"
  | "KB"
  | "MB"
  | "GB"
  | "TB"
  | "KiB"
  | "MiB"
  | "GiB"
  | "TiB";

export interface ParsedRamCapacity {
  readonly integerPart: bigint;
  readonly fractionalPart: bigint;
  readonly fractionalDigits: number;
  readonly unit: CapacityUnit;
  readonly bytes: bigint;
  readonly canonicalValue: string;
}

export interface CanonicalSpecification {
  readonly isSupported: boolean;
  readonly canonicalValue: string;
  readonly rawValue: string;
}

const UNIT_MULTIPLIERS: Record<CapacityUnit, bigint> = {
  B: BigInt(1),
  KB: BigInt(1_000),
  MB: BigInt(1_000_000),
  GB: BigInt("1000000000"),
  TB: BigInt("1000000000000"),
  KiB: BigInt(1_024),
  MiB: BigInt(1_048_576),
  GiB: BigInt("1073741824"),
  TiB: BigInt("1099511627776"),
};

const RAM_KEYS = new Set([
  "ram",
  "memory",
  "system_memory",
  "systemmemory",
  "ram_memory",
  "ram_size",
  "memory_size",
  "ram_capacity",
  "memory_capacity",
  "installed_ram",
  "installed_memory",
]);

/**
 * Checks if a requirement key represents RAM or system memory.
 */
export function isRamRequirementKey(key: unknown): boolean {
  if (typeof key !== "string") {
    return false;
  }
  const clean = key.trim().toLowerCase().replace(/[\s-_]+/g, "_");
  return RAM_KEYS.has(clean);
}

/**
 * Regex matching capacity numbers and unit tokens.
 * Matches: optional whitespace, non-negative integer digits, optional decimal point with digits,
 * optional separator (whitespace or hyphen), and alphabetic unit token.
 */
const CAPACITY_REGEX = /^\s*(\d+)(?:\.(\d+))?\s*(?:-\s*)?([a-zA-Z]+)\s*$/;

/**
 * Parses a raw unit string into its standard canonical CapacityUnit.
 * Strictly distinguishes decimal (SI: KB, MB, GB, TB) from binary (IEC: KiB, MiB, GiB, TiB) units.
 * Returns null if the unit is unsupported or ambiguous.
 */
export function parseCapacityUnit(rawUnit: string): CapacityUnit | null {
  const u = rawUnit.toLowerCase();
  switch (u) {
    case "b":
    case "byte":
    case "bytes":
      return "B";
    case "kb":
    case "kilobyte":
    case "kilobytes":
      return "KB";
    case "mb":
    case "megabyte":
    case "megabytes":
    case "meg":
    case "megs":
      return "MB";
    case "gb":
    case "gigabyte":
    case "gigabytes":
    case "gig":
    case "gigs":
      return "GB";
    case "tb":
    case "terabyte":
    case "terabytes":
      return "TB";
    case "kib":
    case "kibibyte":
    case "kibibytes":
      return "KiB";
    case "mib":
    case "mebibyte":
    case "mebibytes":
      return "MiB";
    case "gib":
    case "gibibyte":
    case "gibibytes":
      return "GiB";
    case "tib":
    case "tebibyte":
    case "tebibytes":
      return "TiB";
    default:
      return null;
  }
}

/**
 * Parses a RAM capacity string into exact integer/fractional BigInt parts and exact byte count.
 * Floating-point arithmetic is strictly forbidden to prevent precision anomalies.
 * Returns null if the value is missing, malformed, lacks a unit, or uses an unsupported unit.
 */
export function parseRamCapacity(raw: unknown): ParsedRamCapacity | null {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = CAPACITY_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }

  const intStr = match[1];
  const fracStr = match[2];
  const unit = parseCapacityUnit(match[3]);
  if (!unit) {
    return null;
  }

  const integerPart = BigInt(intStr);

  let fractionalPart = BigInt(0);
  let fractionalDigits = 0;
  let fracClean = "";

  if (fracStr !== undefined) {
    // Strip trailing zeros from fractional part without float parsing
    fracClean = fracStr.replace(/0+$/, "");
    if (fracClean.length > 0) {
      fractionalPart = BigInt(fracClean);
      fractionalDigits = fracClean.length;
    }
  }

  const multiplier = UNIT_MULTIPLIERS[unit];
  let bytes = integerPart * multiplier;

  if (fractionalDigits > 0) {
    const scale = BigInt(10) ** BigInt(fractionalDigits);
    const fracProduct = fractionalPart * multiplier;
    if (fracProduct % scale !== BigInt(0)) {
      // Inexact fractional byte capacity cannot be conservatively represented as an exact byte count
      return null;
    }
    bytes += fracProduct / scale;
  }

  // Canonicalize string format: "16GB", "16GiB", or "0.5GB"
  const canonicalValue =
    fractionalDigits > 0
      ? `${integerPart}.${fracClean}${unit}`
      : `${integerPart}${unit}`;

  return {
    integerPart,
    fractionalPart,
    fractionalDigits,
    unit,
    bytes,
    canonicalValue,
  };
}

/**
 * Canonicalizes a specification attribute key and value.
 * If the specification type is supported (e.g. RAM capacity), returns the canonical representation.
 * If unsupported or non-capacity, returns conservative lowercase trimmed representation.
 */
export function canonicalizeSpecification(key: string, rawValue: unknown): CanonicalSpecification {
  const strVal = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();

  if (isRamRequirementKey(key)) {
    const parsedRam = parseRamCapacity(strVal);
    if (parsedRam) {
      return {
        isSupported: true,
        canonicalValue: parsedRam.canonicalValue,
        rawValue: strVal,
      };
    }
    return {
      isSupported: false,
      canonicalValue: strVal.toLowerCase(),
      rawValue: strVal,
    };
  }

  return {
    isSupported: false,
    canonicalValue: strVal.toLowerCase(),
    rawValue: strVal,
  };
}

/**
 * Deterministically tests whether an observed specification value matches the required value.
 *
 * Rules:
 * 1. For supported RAM specifications:
 *    - If expected value is a valid RAM capacity (e.g. "16GB", "16 gigabytes"),
 *      the observed value MUST also parse to a valid RAM capacity and have identical
 *      canonical representation (capacity + unit).
 *    - Different capacities (16GB vs 32GB) or incompatible units (16GB vs 16MB) return false.
 *    - Malformed or unsupported units return false.
 *    - If expected value is not a capacity (e.g. "DDR5"), falls back to case-insensitive exact matching.
 * 2. For unsupported specification types (e.g. color, os):
 *    - Performs conservative case-insensitive trimmed string matching.
 */
export function areSpecificationsEquivalent(
  key: string,
  expectedVal: unknown,
  observedVal: unknown
): boolean {
  if (typeof expectedVal !== "string" || typeof observedVal !== "string") {
    return false;
  }

  const expTrimmed = expectedVal.trim();
  const obsTrimmed = observedVal.trim();
  if (expTrimmed.length === 0 || obsTrimmed.length === 0) {
    return false;
  }

  if (isRamRequirementKey(key)) {
    const expRam = parseRamCapacity(expTrimmed);
    if (expRam) {
      // Expected value is a valid RAM capacity
      const obsRam = parseRamCapacity(obsTrimmed);
      if (!obsRam) {
        // Observed value is not a valid RAM capacity (e.g. unsupported unit, malformed)
        return false;
      }
      return expRam.bytes === obsRam.bytes;
    }
  }

  // Fallback for non-RAM or non-capacity specifications
  return expTrimmed.toLowerCase() === obsTrimmed.toLowerCase();
}
