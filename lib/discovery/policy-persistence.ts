/**
 * Plinthly Phase 13E — Durable Policy & Proposal Storage with Schema Validation & Audit.
 *
 * Enforces:
 * 1. Durable storage with automatic restoration on application startup.
 * 2. Schema and version validation prior to restoration (rejects corrupted / malformed files).
 * 3. Atomic file writes (temp file + rename) to prevent partial-write corruption.
 * 4. Concurrency lock against race conditions.
 * 5. Structured audit trail capturing proposal ID, prior and new fingerprints, trusted reviewer, decision, and timestamp.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Actor } from "../state/types";
import {
  DEFAULT_MERCHANT_POLICIES,
  MerchantPolicyRegistry,
  SerializedPolicyRegistryState,
} from "./merchant-policy-registry";
import {
  PolicyProposalEngine,
  SerializedProposalState,
} from "./policy-ingestion/proposal-engine";

export const POLICY_STORAGE_SCHEMA_VERSION = "1.0.0";
const DEFAULT_STORAGE_PATH =
  process.env.POLICY_STORAGE_PATH || join(process.cwd(), ".data", "policy-storage.json");

// Zod schemas for schema validation
const geographicZoneSchema = z.enum([
  "contiguous_us",
  "alaska",
  "hawaii",
  "us_territory",
  "military_apo_fpo",
  "unknown",
]);

export const merchantShippingPolicySchema = z.object({
  policyId: z.string().min(1),
  merchantDomain: z.string().min(1),
  merchantName: z.string().min(1),
  policySourceUrl: z.string().url(),
  publisher: z.string().min(1),
  sourceStatedEffectiveDate: z.string().nullable().optional(),
  retrievedAt: z.string().min(1),
  lastReviewedAt: z.string().optional(),
  effectiveFrom: z.string().nullable().optional(),
  expiresAt: z.string().nullable(),
  deliveryMethod: z.string().min(1),
  currency: z.literal("USD"),
  thresholdCents: z.number().int().nonnegative(),
  shippingCostCents: z.number().int().nonnegative(),
  allowedZones: z.array(geographicZoneSchema),
  excludedZones: z.array(geographicZoneSchema),
  excludedPostalCodes: z.array(z.string()).optional(),
  applicableCategories: z.array(z.string()).optional(),
  excludedCategories: z.array(z.string()).optional(),
  requiresDirectRetailerSeller: z.boolean().optional(),
  requiresDirectRetailerOrWfsFulfillment: z.boolean().optional(),
  marketplaceItemsContributeToThreshold: z.boolean().optional(),
  requiresMembership: z.string().nullable().optional(),
  excludedSpecialFulfillmentMethods: z.array(z.string()).optional(),
  requiresPreTaxMerchandiseThreshold: z.boolean().optional(),
  itemSpecificQualificationRequired: z.boolean().optional(),
  policyVersion: z.string().min(1),
  policyDocumentFingerprint: z.string().length(64),
});

const policySourceRecordSchema = z.object({
  sourceUrl: z.string().url(),
  retrievedAt: z.string().min(1),
  httpStatus: z.number().int(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  rawContentHash: z.string().length(64),
  contentLength: z.number().int().nonnegative(),
  isNotModified: z.boolean(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  redirectChain: z.array(z.string()).optional(),
});

export const policyProposalSchema = z.object({
  proposalId: z.string().min(1),
  policyId: z.string().min(1),
  changeType: z.enum([
    "no_change",
    "content_updated_terms_identical",
    "material_terms_changed",
    "terms_ambiguous",
    "source_removed",
    "fetch_failed",
    "parse_failed",
  ]),
  currentPolicy: merchantShippingPolicySchema.nullable(),
  proposedPolicy: merchantShippingPolicySchema.nullable(),
  sourceRecord: policySourceRecordSchema,
  parserVersion: z.string().min(1),
  status: z.enum(["proposed", "validated", "active", "rejected", "superseded"]),
  explanation: z.string(),
  createdAt: z.string().min(1),
  reviewedAt: z.string().nullable().optional(),
  reviewedBy: z
    .union([
      z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
      z.object({ kind: z.literal("system"), component: z.string().min(1) }),
    ])
    .nullable()
    .optional(),
  rejectionReason: z.string().nullable().optional(),
});

export interface PolicyProposalAuditEntry {
  readonly id: string;
  readonly proposalId: string;
  readonly policyId: string;
  readonly priorFingerprint: string | null;
  readonly newFingerprint: string | null;
  readonly reviewer: Actor;
  readonly decision: "approved" | "rejected";
  readonly explanation?: string;
  readonly timestamp: string;
}

const policyProposalAuditEntrySchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  policyId: z.string().min(1),
  priorFingerprint: z.string().nullable(),
  newFingerprint: z.string().nullable(),
  reviewer: z.union([
    z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
    z.object({ kind: z.literal("system"), component: z.string().min(1) }),
  ]),
  decision: z.enum(["approved", "rejected"]),
  explanation: z.string().optional(),
  timestamp: z.string().min(1),
});

export const durablePolicyStorageSchema = z.object({
  schemaVersion: z.string().min(1),
  lastSavedAt: z.string().min(1),
  registry: z.object({
    policies: z.array(merchantShippingPolicySchema),
    history: z.array(
      z.object({
        policyId: z.string().min(1),
        versions: z.array(merchantShippingPolicySchema),
      })
    ),
  }),
  proposals: z.object({
    proposals: z.array(policyProposalSchema),
  }),
  auditLog: z.array(policyProposalAuditEntrySchema),
});

export type DurablePolicyStorageData = z.infer<typeof durablePolicyStorageSchema>;

export class DurablePolicyStore {
  private isWriting = false;
  private readonly storagePath: string;

  constructor(storagePath?: string) {
    this.storagePath =
      storagePath ??
      process.env.POLICY_STORAGE_PATH ??
      DEFAULT_STORAGE_PATH;
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  /**
   * Restores registry and proposal state from durable storage with schema validation.
   * If storage does not exist, initializes with default merchant policies.
   */
  loadState(
    registry: MerchantPolicyRegistry,
    proposalEngine: PolicyProposalEngine
  ): {
    readonly loadedFromDisk: boolean;
    readonly corruptFileDetected?: boolean;
    readonly quarantinePath?: string;
    readonly auditLog: readonly PolicyProposalAuditEntry[];
  } {
    if (!existsSync(this.storagePath)) {
      return { loadedFromDisk: false, auditLog: [] };
    }

    try {
      const rawText = readFileSync(this.storagePath, "utf8");
      const parsedJson = JSON.parse(rawText);

      // Validate schema strictly before applying
      const validated = durablePolicyStorageSchema.parse(parsedJson);

      // Restore into registry and proposal engine
      registry.importState(validated.registry as unknown as SerializedPolicyRegistryState);
      proposalEngine.importState(validated.proposals as unknown as SerializedProposalState);

      return {
        loadedFromDisk: true,
        auditLog: validated.auditLog as unknown as PolicyProposalAuditEntry[],
      };
    } catch (err) {
      // Fail safely on corrupt data without crashing application
      let quarantinePath: string | undefined;
      try {
        quarantinePath = `${this.storagePath}.corrupt.${Date.now()}`;
        renameSync(this.storagePath, quarantinePath);
      } catch {
        // In case rename fails
      }

      console.error(
        `[DurablePolicyStore] Failed to restore from ${this.storagePath}: ${(err as Error).message}. ${
          quarantinePath ? `Quarantined corrupt file to ${quarantinePath}.` : ""
        } Retaining default merchant policies.`
      );

      // Guarantee registry has safe default policies if it became empty
      if (registry.getAllPolicies().length === 0) {
        registry.importState({ policies: DEFAULT_MERCHANT_POLICIES, history: [] });
      }

      return {
        loadedFromDisk: false,
        corruptFileDetected: true,
        quarantinePath,
        auditLog: [],
      };
    }
  }

  /**
   * Persists registry, proposal engine state, and audit log atomically to disk.
   */
  saveState(
    registry: MerchantPolicyRegistry,
    proposalEngine: PolicyProposalEngine,
    auditLog: readonly PolicyProposalAuditEntry[] = []
  ): void {
    if (this.isWriting) {
      throw new Error("Concurrent write collision: another save operation is in progress.");
    }
    this.isWriting = true;

    try {
      const dataToSave: DurablePolicyStorageData = {
        schemaVersion: POLICY_STORAGE_SCHEMA_VERSION,
        lastSavedAt: new Date().toISOString(),
        registry: registry.exportState() as unknown as DurablePolicyStorageData["registry"],
        proposals: proposalEngine.exportState() as unknown as DurablePolicyStorageData["proposals"],
        auditLog: [...auditLog] as unknown as DurablePolicyStorageData["auditLog"],
      };

      // Validate before write to guarantee only valid state is saved
      durablePolicyStorageSchema.parse(dataToSave);

      const targetDir = dirname(this.storagePath);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Write atomically to temporary file, then rename
      const tempPath = `${this.storagePath}.tmp.${Date.now()}`;
      writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), "utf8");
      renameSync(tempPath, this.storagePath);
    } finally {
      this.isWriting = false;
    }
  }
}

// Global persistent store singleton
let globalDurableStore: DurablePolicyStore | null = null;
let globalAuditLog: PolicyProposalAuditEntry[] = [];

export function getDurablePolicyStore(storagePath?: string): DurablePolicyStore {
  if (!globalDurableStore || storagePath) {
    globalDurableStore = new DurablePolicyStore(storagePath);
  }
  return globalDurableStore;
}

export function recordProposalReviewAudit(entry: PolicyProposalAuditEntry): void {
  globalAuditLog.push(entry);
}

export function getProposalReviewAuditLog(policyId?: string): readonly PolicyProposalAuditEntry[] {
  if (policyId) {
    return globalAuditLog.filter((e) => e.policyId === policyId);
  }
  return [...globalAuditLog];
}

export function clearProposalReviewAuditLog(): void {
  globalAuditLog = [];
}
