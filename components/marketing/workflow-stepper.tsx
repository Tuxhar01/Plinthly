"use client";

import * as React from "react";
import {
  Search,
  Layers,
  ShieldCheck,
  Lock,
  CreditCard,
  ArrowRight,
  FileCode2,
  Check,
} from "lucide-react";

interface StepData {
  step: string;
  name: string;
  tagline: string;
  icon: React.ElementType;
  description: string;
  architectureDetails: string[];
  schemaBadge: string;
  codeSnippet: string;
}

const STEPS: StepData[] = [
  {
    step: "01",
    name: "Discover",
    tagline: "Natural Language to Atomic Items",
    icon: Search,
    description:
      "Enterprise buyers enter unstructured requests. Gemini 2.5 decomposes the natural language prompt into atomic, structured procurement line items. Crucially, unspecified quantities remain explicitly null and unconfirmed until buyer sign-off.",
    architectureDetails: [
      "Gemini 2.5 Flash decomposition with zero parameter hallucination",
      "Explicit confirmation required for quantities and destination ZIP",
      "Multi-merchant catalog discovery via Channel3 inventory bridges",
    ],
    schemaBadge: "INTENT_NORMALIZED",
    codeSnippet: `// Illustrative Gemini Decomposed Schema Output
{
  "purchaseId": "pur_1794149129429",
  "status": "REQUIREMENTS_CONFIRMED",
  "lineItems": [
    { "name": "Laptop for software dev", "qty": 1, "confirmed": true },
    { "name": "Monitor for workstation", "qty": 1, "confirmed": true }
  ],
  "budgetLimit": 1500.00,
  "destinationZip": "98101"
}`,
  },
  {
    step: "02",
    name: "Compare",
    tagline: "Combinatorial Allocation Solver",
    icon: Layers,
    description:
      "The multi-cart allocation engine analyzes combinations of available merchant offerings. It evaluates merchant-specific free-shipping thresholds, freight surcharges, and localized sales tax to produce candidate strategies.",
    architectureDetails: [
      "Simulates merchant minimums for free delivery thresholds",
      "Generates Balanced Optimal, Consolidated, and Lowest Cost allocations",
      "Calculates estimated landed cost inclusive of jurisdictional sales tax",
    ],
    schemaBadge: "STRATEGY_SYNTHESIS",
    codeSnippet: `// Illustrative Multi-Cart Strategy Synthesis
{
  "strategies": {
    "balanced": { "merchants": 2, "landedCost": 799.97, "shipping": 0.00 },
    "consolidated": { "merchants": 1, "landedCost": 819.45, "shipping": 0.00 },
    "lowestCost": { "merchants": 2, "landedCost": 789.20, "shipping": 9.99 }
  },
  "recommended": "balanced",
  "merchantInventoryState": "VERIFIED_ACTIVE"
}`,
  },
  {
    step: "03",
    name: "Verify",
    tagline: "Deterministic Spec & Policy Proofs",
    icon: ShieldCheck,
    description:
      "Before commitment, Plinthly executes automated suitability and compliance audits. Professional software laptop requests evaluate CPU generation, RAM, storage, and OS compatibility. Requests with unquoted shipping or stale items are flagged.",
    architectureDetails: [
      "Hardware suitability scoring (CPU microarchitecture, RAM ceilings)",
      "Strict zero-unquoted-fee rule prevents post-checkout surprises",
      "Corporate budget ceiling enforcement against total landed cost",
    ],
    schemaBadge: "SUITABILITY_VERIFIED",
    codeSnippet: `// Illustrative Deterministic Policy Proof
{
  "verdict": "COMPLIANT",
  "budgetRemaining": 700.03,
  "hardwareSuitability": {
    "laptop": { "status": "COMPATIBLE", "cpuGen": "Intel Core 5 120U", "ramGB": 16 },
    "monitor": { "status": "COMPATIBLE", "resolution": "1080p", "refreshHz": 100 }
  },
  "shippingQuoted": true,
  "policyExceptions": 0
}`,
  },
  {
    step: "04",
    name: "Approve",
    tagline: "Cryptographic Snapshot Ledger",
    icon: Lock,
    description:
      "When the procurement manager approves the purchase, Plinthly records the purchase manifest into a verifiable SHA-256 snapshot. PostgreSQL transactional state machines prevent unapproved cart mutations from altering the authorized purchase.",
    architectureDetails: [
      "Deterministic SHA-256 canonical hashing across items, tax, and freight",
      "PostgreSQL row-level locks and strict state-machine transitions",
      "Audit log records authorizing identity and pre-authorized ceiling",
    ],
    schemaBadge: "SNAPSHOT_LOCKED",
    codeSnippet: `// Illustrative Snapshot Digest
{
  "snapshotId": "snap_f4c935d21a8b",
  "snapshotHash": "sha256:f4c935d21a8b9487c90b62e4f014e389aa...",
  "approvedLandedCost": 799.97,
  "state": "APPROVED_LOCKED",
  "lockedAt": "2026-11-08T07:42:19.412Z",
  "locked": true
}`,
  },
  {
    step: "05",
    name: "Pay",
    tagline: "Atomic PayPal Orders v2 Settlement",
    icon: CreditCard,
    description:
      "Plinthly orchestrates settlement via official PayPal Orders v2 REST integration. Pre-capture landed cost validation ensures captured merchant payments do not exceed approved amounts (|Δ| = $0.00 in verified test runs). Webhook reconcilers ensure transaction auditability.",
    architectureDetails: [
      "PayPal Orders v2 REST client with automatic auth token renewal",
      "Pre-capture landed cost validation against approved total",
      "Idempotent webhook ledger recovery and merchant dispatch confirmation",
    ],
    schemaBadge: "SETTLED_VERIFIED",
    codeSnippet: `// Illustrative PayPal Orders v2 Settlement Receipt
{
  "orderId": "PAYPAL-ORDER-8NM72194X",
  "captureStatus": "COMPLETED",
  "variance": 0.00,
  "approvedAmount": 799.97,
  "capturedAmount": 799.97,
  "merchantDispatches": [
    { "merchant": "B&H Photo Video", "amount": 709.00 },
    { "merchant": "Best Buy Business", "amount": 90.97 }
  ]
}`,
  },
];

export function WorkflowStepper() {
  const [activeStepIndex, setActiveStepIndex] = React.useState(0);
  const activeStep = STEPS[activeStepIndex];

  return (
    <div className="w-full space-y-8">
      {/* Step Selector Horizontal Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
        {STEPS.map((step, idx) => {
          const isSelected = activeStepIndex === idx;
          const isPast = activeStepIndex > idx;
          const Icon = step.icon;

          return (
            <button
              key={step.step}
              type="button"
              onClick={() => setActiveStepIndex(idx)}
              className={`p-3 sm:p-4 rounded-xl border text-left transition-all duration-200 relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                isSelected
                  ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))] shadow-xs scale-[1.01]"
                  : "border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--canvas)] hover:border-[var(--ink-muted)]/50 hover:scale-[1.005]"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded transition-colors duration-200 ${
                    isSelected
                      ? "bg-[var(--accent)] text-[var(--on-accent)]"
                      : isPast
                      ? "bg-[#2E7D32]/10 text-[#2E7D32] dark:text-[#4ADE80]"
                      : "bg-[var(--line)] text-[var(--ink-muted)]"
                  }`}
                >
                  Step {step.step}
                </span>
                <Icon
                  className={`w-4 h-4 transition-colors duration-200 ${
                    isSelected
                      ? "text-[var(--accent)]"
                      : isPast
                      ? "text-[#2E7D32] dark:text-[#4ADE80]"
                      : "text-[var(--ink-muted)]"
                  }`}
                />
              </div>

              <div className="text-sm font-semibold text-[var(--ink)]">
                {step.name}
              </div>
              <div className="text-[11px] text-[var(--ink-muted)] truncate mt-0.5">
                {step.tagline}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected Step Detailed View Card with key transition */}
      <div
        key={activeStep.step}
        className="bg-[var(--surface)] border border-[var(--line)] rounded-xl p-5 sm:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center shadow-xs animate-fade-in-up duration-250"
      >
        {/* Left Col: Explanations and Architectural Invariants */}
        <div className="lg:col-span-6 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--accent)]">
                Stage {activeStep.step} Architecture
              </span>
              <span className="text-xs text-[var(--line)]">•</span>
              <span className="text-xs font-medium text-[var(--ink-muted)]">
                {activeStep.tagline}
              </span>
            </div>
            <h3
              style={{ fontFamily: "var(--font-display)" }}
              className="text-2xl sm:text-3xl font-semibold text-[var(--ink)] tracking-tight"
            >
              {activeStep.name}: {activeStep.tagline}
            </h3>
            <p className="text-sm text-[var(--ink-muted)] leading-relaxed pt-1">
              {activeStep.description}
            </p>
          </div>

          {/* Architecture Details Checklist */}
          <div className="space-y-2.5 pt-2">
            {activeStep.architectureDetails.map((detail, idx) => (
              <div key={idx} className="flex items-start gap-2.5 text-xs text-[var(--ink)]">
                <div className="p-0.5 rounded-full bg-[#2E7D32]/10 text-[#2E7D32] dark:text-[#4ADE80] mt-0.5">
                  <Check className="w-3 h-3" />
                </div>
                <span>{detail}</span>
              </div>
            ))}
          </div>

          {/* Step Navigators */}
          <div className="pt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={activeStepIndex === 0}
              onClick={() => setActiveStepIndex((prev) => Math.max(0, prev - 1))}
              className="text-xs font-medium px-3 py-1.5 rounded-[var(--radius-control)] border border-[var(--control-border)] text-[var(--ink)] hover:bg-[var(--canvas)] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 active:scale-[0.98]"
            >
              Previous Step
            </button>
            <button
              type="button"
              disabled={activeStepIndex === STEPS.length - 1}
              onClick={() => setActiveStepIndex((prev) => Math.min(STEPS.length - 1, prev + 1))}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 active:scale-[0.98]"
            >
              <span>Next: {STEPS[Math.min(STEPS.length - 1, activeStepIndex + 1)].name}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Right Col: Terminal / Code Proof Inspector */}
        <div className="lg:col-span-6 bg-[color-mix(in_srgb,var(--canvas)_90%,var(--surface))] border border-[var(--line)] rounded-xl overflow-hidden shadow-xs">
          <div className="px-4 py-2.5 border-b border-[var(--line)] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-[var(--accent)]" />
              <span className="font-mono text-[var(--ink)] text-[11px]">
                verified-contract-state.json
              </span>
            </div>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-[var(--surface)] text-[var(--accent)] border border-[var(--line)] animate-scale-in">
              {activeStep.schemaBadge}
            </span>
          </div>
          <pre className="p-4 text-xs font-mono text-[var(--ink)] overflow-x-auto leading-relaxed max-h-[340px]">
            <code>{activeStep.codeSnippet}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
