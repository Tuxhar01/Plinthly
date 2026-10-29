import { EvidenceStatus } from "../state/types";
import { computeEvidenceFingerprint, EvidenceFingerprintItem } from "../state/snapshot";
import {
  parseRequirementSpec,
  ParsedRequirement,
  areSpecificationsEquivalent,
  canonicalizeSpecification,
} from "../policy/rules/evidence";
import { EvidenceRecord, EvidenceIngestionResult, NormalizedProductCandidate } from "./types";

/**
 * Raw observation item supplied by a source adapter or crawler.
 */
export interface SourceObservation {
  readonly requirementKey: string;
  readonly value: unknown;
  readonly status?: EvidenceStatus;
  readonly sourceUrl?: string;
  readonly sourceType?: string;
  readonly capturedAt?: string | Date;
}

export interface IngestEvidenceOptions {
  readonly candidate: NormalizedProductCandidate;
  readonly requiredAttributes?: readonly (string | ParsedRequirement | Record<string, unknown>)[];
  readonly rawObservations?: readonly SourceObservation[] | Record<string, unknown>;
  readonly defaultSourceUrl?: string;
  readonly defaultSourceType?: string;
  readonly defaultCapturedAt?: string | Date;
  readonly now: Date;
  readonly idGenerator?: () => string;
}

/**
 * Sentinel timestamp used when source observation timestamp is missing, empty, or unparseable,
 * ensuring no invalid Date instance is ever constructed or persisted in the database.
 * Unix epoch 0 (1970-01-01T00:00:00.000Z) is explicitly recognized by policy engines as
 * incomplete/missing evidence, failing closed and never passing freshness rules.
 */
export const UNKNOWN_TIMESTAMP_SENTINEL = new Date(0);
export const UNKNOWN_TIMESTAMP_SENTINEL_ISO = "1970-01-01T00:00:00.000Z";

/**
 * Formats a Date or timestamp string into strict ISO 8601 UTC representation (YYYY-MM-DDTHH:MM:SS.sssZ).
 * If the input is missing, empty, unparseable, or an invalid Date, returns an empty string or the raw unparseable string.
 * It strictly avoids substituting the current clock time or repairing invalid timestamps.
 */
export function formatUtcIso8601(val: unknown): string {
  if (val === undefined || val === null) {
    return "";
  }

  if (val instanceof Date) {
    if (isNaN(val.getTime())) {
      return "";
    }
    if (val.getTime() === 0) {
      return UNKNOWN_TIMESTAMP_SENTINEL_ISO;
    }
    return val.toISOString();
  }

  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      return "";
    }
    if (trimmed === UNKNOWN_TIMESTAMP_SENTINEL_ISO) {
      return UNKNOWN_TIMESTAMP_SENTINEL_ISO;
    }
    const parsed = Date.parse(trimmed);
    if (isNaN(parsed)) {
      // Return the unparseable string so the downstream policy engine (P-FRESHNESS)
      // fails closed with an unparseable timestamp error.
      return trimmed;
    }
    if (parsed === 0) {
      return UNKNOWN_TIMESTAMP_SENTINEL_ISO;
    }
    return new Date(parsed).toISOString();
  }

  return "";
}

export const ISO_8601_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Ingests source observations into deterministic, candidate-isolated EvidenceRecords
 * conforming to Phase 1 snapshot fingerprinting and Phase 2 policy rules.
 *
 * Untrusted data principles:
 * - Does not infer evidence for missing requirements.
 * - Does not elevate unverified AI output to "supports".
 * - Maintains strict candidate isolation (candidateId is strictly set to candidate.id).
 * - Distinguishes between "supports", "contradicts", and "missing".
 * - Missing or invalid timestamps are never defaulted to the current clock time.
 */
export function ingestCandidateEvidence(options: IngestEvidenceOptions): EvidenceIngestionResult {
  const { candidate, defaultSourceUrl, defaultSourceType = "merchant_feed" } = options;
  const candidateId = candidate.id;
  const sourceUrl = defaultSourceUrl ?? (candidate.merchantUrl || "https://source.local/unknown");

  // Normalize raw observations into an array of SourceObservation
  const observationList: SourceObservation[] = [];
  if (Array.isArray(options.rawObservations)) {
    for (const item of options.rawObservations) {
      if (item && typeof item === "object" && typeof item.requirementKey === "string") {
        observationList.push(item);
      }
    }
  } else if (options.rawObservations && typeof options.rawObservations === "object") {
    for (const [key, val] of Object.entries(options.rawObservations)) {
      observationList.push({
        requirementKey: key,
        value: val,
      });
    }
  }

  // Ensure destination observation is preserved if candidate possesses destination details
  if (
    candidate?.shippingDetails?.destinationPostalCode &&
    !observationList.some((o) => o.requirementKey.trim().toLowerCase() === "destination")
  ) {
    observationList.push({
      requirementKey: "destination",
      value: candidate.shippingDetails.destinationPostalCode,
      status: "supports",
      sourceUrl: candidate.shippingDetails.policySourceUrl || sourceUrl,
      sourceType: "destination_evidence",
      capturedAt: formatUtcIso8601(
        candidate.shippingDetails.sourceVerificationTimestamp ?? candidate.capturedAt
      ),
    });
  }

  // Parse required attributes
  const requirements: ParsedRequirement[] = [];
  if (options.requiredAttributes && options.requiredAttributes.length > 0) {
    for (const rawReq of options.requiredAttributes) {
      const parsed = parseRequirementSpec(rawReq);
      if (parsed) {
        requirements.push(parsed);
      }
    }
  }

  const evidenceRecords: EvidenceRecord[] = [];
  const missingAttributeKeys: string[] = [];
  const contradictedAttributeKeys: string[] = [];
  const supportedAttributeKeys: string[] = [];
  const conflictingAttributeKeys: string[] = [];

  // Track requirement keys processed to handle observations not explicitly listed in requirements
  const processedKeys = new Set<string>();

  for (const req of requirements) {
    processedKeys.add(req.key.toLowerCase());

    // Find observations matching this requirement key (case-insensitive)
    let matchingObs = observationList.filter(
      (o) => o.requirementKey.trim().toLowerCase() === req.key.toLowerCase()
    );

    // If no explicit observation but candidate possesses authoritative shipping details, synthesize evidence
    if (matchingObs.length === 0 && candidate?.shippingDetails?.isAuthoritative) {
      const cleanReq = req.key.toLowerCase();
      if (cleanReq === "free_shipping") {
        matchingObs = [
          {
            requirementKey: req.key,
            value: candidate.shippingCents === 0 ? "free" : `${candidate.shippingCents} cents`,
            status: candidate.shippingCents === 0 ? "supports" : "contradicts",
            sourceUrl: candidate.shippingDetails.policySourceUrl || sourceUrl,
            sourceType: candidate.shippingDetails.type === "policy_derived" ? "merchant_policy" : "carrier_quote",
            capturedAt: formatUtcIso8601(candidate.shippingDetails.sourceVerificationTimestamp),
          },
        ];
      } else if (cleanReq === "shipping") {
        matchingObs = [
          {
            requirementKey: req.key,
            value: `${candidate.shippingCents} cents`,
            status: "supports",
            sourceUrl: candidate.shippingDetails.policySourceUrl || sourceUrl,
            sourceType: candidate.shippingDetails.type === "policy_derived" ? "merchant_policy" : "carrier_quote",
            capturedAt: formatUtcIso8601(candidate.shippingDetails.sourceVerificationTimestamp),
          },
        ];
      } else if (cleanReq === "destination" && candidate.shippingDetails?.destinationPostalCode) {
        matchingObs = [
          {
            requirementKey: req.key,
            value: candidate.shippingDetails.destinationPostalCode,
            status: "supports",
            sourceUrl: candidate.shippingDetails.policySourceUrl || sourceUrl,
            sourceType: "destination_evidence",
            capturedAt: formatUtcIso8601(
              candidate.shippingDetails.sourceVerificationTimestamp ?? candidate.capturedAt
            ),
          },
        ];
      }
    }

    if (matchingObs.length === 0) {
      // Evidence is missing; capture timestamp is empty, not defaulted to now
      missingAttributeKeys.push(req.key);
      const id = options.idGenerator ? options.idGenerator() : `evi_missing_${candidateId}_${req.key}`;
      evidenceRecords.push({
        id,
        candidateId,
        requirementKey: req.key,
        value: "",
        sourceUrl,
        sourceType: defaultSourceType,
        capturedAt: "",
        status: "missing",
        rawObservedValue: undefined,
      });
      continue;
    }

    // Check for conflicting observations within the source data
    const nonMissingValues = new Set<string>();
    for (const obs of matchingObs) {
      if (typeof obs.value === "string" && obs.value.trim().length > 0) {
        const canonical = canonicalizeSpecification(req.key, obs.value);
        nonMissingValues.add(canonical.canonicalValue);
      }
    }

    if (nonMissingValues.size > 1) {
      conflictingAttributeKeys.push(req.key);
    }

    for (let i = 0; i < matchingObs.length; i++) {
      const obs = matchingObs[i];
      const id = options.idGenerator ? options.idGenerator() : `evi_${candidateId}_${req.key}_${i}`;
      const itemUrl = obs.sourceUrl?.trim() || sourceUrl;
      const itemSourceType = obs.sourceType?.trim() || defaultSourceType;

      let rawTime: unknown = undefined;
      if ("capturedAt" in obs) {
        rawTime = obs.capturedAt;
      } else if (options.defaultCapturedAt !== undefined) {
        rawTime = options.defaultCapturedAt;
      } else if (candidate && candidate.capturedAt && candidate.rawSourceData?.capturedAt) {
        rawTime = candidate.capturedAt;
      }

      const itemCapturedAt = formatUtcIso8601(rawTime);

      let status: EvidenceStatus = obs.status ?? "supports";
      const itemSourceTypeLower = itemSourceType.toLowerCase();
      const isExplicitlyInferred =
        itemSourceTypeLower.includes("inferred") ||
        itemSourceTypeLower.includes("heuristic") ||
        itemSourceTypeLower.includes("ai_inference") ||
        Boolean((obs as { isInferred?: boolean }).isInferred);

      if (isExplicitlyInferred) {
        status = "missing";
      }

      let strValue = "";

      if (typeof obs.value === "string") {
        strValue = obs.value.trim();
      } else if (obs.value !== undefined && obs.value !== null) {
        strValue = String(obs.value).trim();
      }

      if (strValue.length === 0) {
        status = "missing";
      } else if (obs.status === "contradicts") {
        status = "contradicts";
      } else if (req.expectedValue !== undefined) {
        // Compare with expected value using conservative specification equivalence
        const matches = areSpecificationsEquivalent(req.key, req.expectedValue, strValue);
        if (!matches) {
          status = "contradicts";
        }
      }

      if (status === "contradicts") {
        if (!contradictedAttributeKeys.includes(req.key)) {
          contradictedAttributeKeys.push(req.key);
        }
      } else if (status === "supports") {
        if (!supportedAttributeKeys.includes(req.key)) {
          supportedAttributeKeys.push(req.key);
        }
      } else if (status === "missing") {
        if (!missingAttributeKeys.includes(req.key)) {
          missingAttributeKeys.push(req.key);
        }
      }

      const canonical = canonicalizeSpecification(req.key, strValue);
      const normalizedValue = canonical.isSupported ? canonical.canonicalValue : strValue;

      evidenceRecords.push({
        id,
        candidateId,
        requirementKey: req.key,
        value: normalizedValue,
        sourceUrl: itemUrl,
        sourceType: itemSourceType,
        capturedAt: itemCapturedAt,
        status,
        rawObservedValue: obs.value,
      });
    }
  }

  // Also ingest any additional source observations not part of explicit requirements
  for (const obs of observationList) {
    const key = obs.requirementKey.trim();
    if (processedKeys.has(key.toLowerCase())) {
      continue;
    }
    processedKeys.add(key.toLowerCase());

    const id = options.idGenerator ? options.idGenerator() : `evi_${candidateId}_${key}_extra`;
    const itemUrl = obs.sourceUrl?.trim() || sourceUrl;
    const itemSourceType = obs.sourceType?.trim() || defaultSourceType;

    let rawTime: unknown = undefined;
    if ("capturedAt" in obs) {
      rawTime = obs.capturedAt;
    } else if (options.defaultCapturedAt !== undefined) {
      rawTime = options.defaultCapturedAt;
    } else if (candidate && candidate.capturedAt && candidate.rawSourceData?.capturedAt) {
      rawTime = candidate.capturedAt;
    }

    const itemCapturedAt = formatUtcIso8601(rawTime);

    let strValue = "";
    if (typeof obs.value === "string") {
      strValue = obs.value.trim();
    } else if (obs.value !== undefined && obs.value !== null) {
      strValue = String(obs.value).trim();
    }

    const itemSourceTypeLower = itemSourceType.toLowerCase();
    const isExplicitlyInferred =
      itemSourceTypeLower.includes("inferred") ||
      itemSourceTypeLower.includes("heuristic") ||
      itemSourceTypeLower.includes("ai_inference") ||
      Boolean((obs as { isInferred?: boolean }).isInferred);

    const status: EvidenceStatus = isExplicitlyInferred
      ? "missing"
      : obs.status ?? (strValue.length > 0 ? "supports" : "missing");

    const canonical = canonicalizeSpecification(key, strValue);
    const normalizedValue = canonical.isSupported ? canonical.canonicalValue : strValue;

    evidenceRecords.push({
      id,
      candidateId,
      requirementKey: key,
      value: normalizedValue,
      sourceUrl: itemUrl,
      sourceType: itemSourceType,
      capturedAt: itemCapturedAt,
      status,
      rawObservedValue: obs.value,
    });
  }

  // Detect any records with invalid, missing, or sentinel capture timestamps
  const invalidTimestampAttributeKeys: string[] = [];
  for (const r of evidenceRecords) {
    if (
      r.status !== "missing" &&
      (!r.capturedAt ||
        !ISO_8601_UTC_REGEX.test(r.capturedAt) ||
        r.capturedAt === UNKNOWN_TIMESTAMP_SENTINEL_ISO)
    ) {
      if (!invalidTimestampAttributeKeys.includes(r.requirementKey)) {
        invalidTimestampAttributeKeys.push(r.requirementKey);
      }
    }
  }

  // Compute evidence fingerprint conforming to Phase 1 computeEvidenceFingerprint
  let evidenceFingerprint = "";
  const allTimestampsValid = invalidTimestampAttributeKeys.length === 0 && missingAttributeKeys.length === 0;

  if (allTimestampsValid && evidenceRecords.length > 0) {
    try {
      const fingerprintItems: EvidenceFingerprintItem[] = evidenceRecords.map((r) => ({
        requirementKey: r.requirementKey,
        value: r.value,
        sourceUrl: r.sourceUrl,
        sourceType: r.sourceType,
        capturedAt: r.capturedAt,
        status: r.status,
      }));
      evidenceFingerprint = computeEvidenceFingerprint(fingerprintItems);
    } catch {
      evidenceFingerprint = "";
    }
  } else if (evidenceRecords.length === 0) {
    evidenceFingerprint = computeEvidenceFingerprint([]);
  }

  const isComplete =
    missingAttributeKeys.length === 0 &&
    contradictedAttributeKeys.length === 0 &&
    conflictingAttributeKeys.length === 0 &&
    invalidTimestampAttributeKeys.length === 0;

  return {
    candidateId,
    evidenceRecords,
    evidenceFingerprint,
    missingAttributeKeys,
    contradictedAttributeKeys,
    supportedAttributeKeys,
    conflictingAttributeKeys,
    invalidTimestampAttributeKeys,
    isComplete,
  };
}
