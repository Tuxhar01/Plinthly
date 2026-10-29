import { PolicyOutcome, PolicySummary, EvidenceStatus, CandidateSource } from "../state/types";

export type RuleOutcome = PolicyOutcome;

export interface RuleExplanation {
  observed: unknown;
  expected: unknown;
  reason: string;
}

export interface RuleResult {
  ruleKey: string;
  ruleVersion: string;
  outcome: RuleOutcome;
  explanation: RuleExplanation;
}

export interface PolicyRuleContext {
  now: Date;
}

export interface PolicyRule<TInput = unknown> {
  readonly key: string;
  readonly version: string;
  evaluate(input: TInput, context?: PolicyRuleContext): RuleResult;
}

export type AnyPolicyRule = PolicyRule<unknown>;

// 1. P-BUDGET
export interface BudgetRuleInput {
  candidateTotalCents: unknown;
  budgetCents: unknown;
}

// 2. P-CURRENCY
export interface CurrencyRuleInput {
  candidateCurrency: unknown;
  purchaseCurrency: unknown;
}

// 3. P-QUANTITY
export interface QuantityRuleInput {
  candidateQuantity: unknown;
  requestedQuantity: unknown;
}

// 4. P-EVIDENCE
export interface EvidenceItemInput {
  id?: string;
  candidateId: string;
  requirementKey: string;
  status: EvidenceStatus | string;
  value?: string;
  sourceUrl?: string;
  sourceType?: string;
  capturedAt?: string | Date;
}

export type RequiredAttributeSpec =
  | string
  | { key: string; expectedValue?: string; value?: string }
  | { requirementKey: string; expectedValue?: string; value?: string };

export interface EvidenceRuleInput {
  candidateId: unknown;
  requiredAttributes: unknown;
  evidence: unknown;
}

// 5. P-AVAILABILITY
export interface AvailabilityRuleInput {
  availability: unknown;
}

// 6. P-VENDOR
export interface VendorRuleInput {
  merchantName: unknown;
  allowList: unknown;
}

// 7. P-FRESHNESS
export interface FreshnessRuleInput {
  evidence: unknown;
  maxAgeMs: unknown;
  candidateId?: unknown;
  requiredAttributes?: unknown;
}

// 8. P-DUPLICATE
export interface HistoricalPurchaseItem {
  purchaseId: string;
  candidateId?: string;
  externalId?: string;
  merchantName?: string;
  snapshotHash?: string;
  purchasedAt: Date | string;
}

export interface DuplicateRuleInput {
  candidate: unknown;
  history: unknown;
  isHistoryComplete: unknown;
}

// Aggregate Evaluation Types
export interface CandidateEvaluationFacts {
  id: string;
  purchaseId?: string;
  source?: CandidateSource;
  externalId?: string;
  title?: string;
  merchantName?: string;
  merchantUrl?: string;
  unitPriceCents?: number;
  quantity?: number;
  shippingCents?: number;
  totalCents?: number;
  currency?: string;
  availability?: string;
  snapshotHash?: string;
}

export interface PurchaseEvaluationFacts {
  id?: string;
  budgetCents?: number;
  currency?: string;
  requestedQuantity?: number;
  requiredAttributes?: readonly (string | RequiredAttributeSpec)[];
}

export interface PolicyConfig {
  requiredRuleKeys?: readonly string[];
  vendorAllowList?: readonly string[];
  maxEvidenceAgeMs?: number;
  purchaseHistory?: readonly HistoricalPurchaseItem[];
  isHistoryComplete?: boolean;
}

export interface PolicyEvaluationInput {
  candidate: CandidateEvaluationFacts;
  purchase: PurchaseEvaluationFacts;
  evidence?: readonly EvidenceItemInput[];
  config: PolicyConfig;
  now: Date;
  policyVersion?: string;
}

export interface PolicyEvaluationResult {
  summary: PolicySummary;
  ruleResults: Record<string, RuleResult>;
  evaluatedAt: Date;
  policyVersion: string;
}
