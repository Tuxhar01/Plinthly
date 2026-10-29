"use client";

import * as React from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "../ui/field";
import { Banner } from "../ui/banner";
import { StatusChip, StatusChipVariant } from "../ui/status-chip";
import { evaluatePurchaseApi, discoverCandidatesApi } from "../../lib/workflow/client-api";
import { PurchaseResponse, EvaluatePurchaseResponse } from "../../lib/workflow/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { CandidateComparisonGrid } from "./candidate-comparison-grid";

export interface CandidateEvaluationCardProps {
  purchase: PurchaseResponse;
  actorId: string;
  onRefreshRequested: () => void;
  loading?: boolean;
}

export function CandidateEvaluationCard({
  purchase,
  actorId,
  onRefreshRequested,
  loading: externalLoading,
}: CandidateEvaluationCardProps) {
  // Discovery state
  const [searchQuery, setSearchQuery] = React.useState<string>("Dell XPS 15");
  const [discoveryLoading, setDiscoveryLoading] = React.useState<boolean>(false);
  const [discoveredCandidates, setDiscoveredCandidates] = React.useState<readonly NormalizedProductCandidate[]>([]);
  const [discoveryNotice, setDiscoveryNotice] = React.useState<{ variant: "info" | "error" | "success"; text: string } | null>(null);

  // Candidate selection & editing state
  const [merchantName, setMerchantName] = React.useState<string>("Dell Official Store");
  const [itemTitle, setItemTitle] = React.useState<string>("Dell XPS 15 9530 Laptop");
  const [externalId, setExternalId] = React.useState<string>("cand_dell_xps_15");
  const [merchantUrl, setMerchantUrl] = React.useState<string>("https://dell.com/xps15");
  const [unitPriceDollars, setUnitPriceDollars] = React.useState<string>("120.00");
  const [shippingDollars, setShippingDollars] = React.useState<string>("10.00");
  const [isSyntheticCandidate, setIsSyntheticCandidate] = React.useState<boolean>(true);
  const [selectedCandidateObj, setSelectedCandidateObj] = React.useState<NormalizedProductCandidate | null>(null);
  const [availability] = React.useState<string>("IN_STOCK");

  const [internalLoading, setInternalLoading] = React.useState<boolean>(false);
  const loading = externalLoading !== undefined ? externalLoading : internalLoading;
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [evaluationResult, setEvaluationResult] = React.useState<EvaluatePurchaseResponse | null>(null);

  // Unified candidates list for AG Grid Procurement Studio
  const gridCandidates = React.useMemo(() => {
    if (discoveredCandidates.length > 0) {
      return discoveredCandidates;
    }
    return [
      {
        id: "cand_dell_xps_15_verified",
        externalId: "cand_dell_xps_15_verified",
        title: "[DEMO FIXTURE] Dell XPS 15 9530 Laptop",
        merchantName: "Dell Official Store",
        merchantUrl: "https://dell.com/xps15",
        unitPriceCents: 12000,
        shippingCents: 1000,
        totalCents: 13000,
        currency: purchase.currency || "USD",
        isComplete: true,
        shippingDetails: {
          type: "quoted" as const,
          amountCents: 1000,
          currency: purchase.currency || "USD",
          isAuthoritative: true,
          observationTimestamp: new Date().toISOString(),
          sourceVerificationTimestamp: new Date().toISOString(),
          explanation: "Authoritative ground shipping evidence attached",
        },
      },
    ];
  }, [discoveredCandidates, purchase.currency]);

  const isEvaluationAllowed =
    purchase.status === "REQUIREMENTS_CONFIRMED" ||
    purchase.status === "EVALUATED" ||
    purchase.status === "POLICY_PASSED" ||
    purchase.status === "POLICY_BLOCKED";

  // Discover real products via Channel3
  const handleDiscover = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    setDiscoveryLoading(true);
    setDiscoveryNotice(null);
    try {
      const res = await discoverCandidatesApi(purchase.id, { query }, { actorId });
      if (!res.ok) {
        setDiscoveryNotice({
          variant: "info",
          text: `Channel3 discovery unavailable: [${res.error.code}] ${res.error.message}. You can use the verified synthetic demonstration fixture below.`,
        });
        setDiscoveredCandidates([]);
      } else if (res.data.status === "empty") {
        setDiscoveryNotice({
          variant: "info",
          text: `Channel3 returned no candidates for "${query}": ${res.data.reason}`,
        });
        setDiscoveredCandidates([]);
      } else if (res.data.status === "source_error") {
        setDiscoveryNotice({
          variant: "info",
          text: `Channel3 provider reported: [${res.data.errorCode}] ${res.data.errorMessage}`,
        });
        setDiscoveredCandidates([]);
      } else {
        setDiscoveredCandidates(res.data.candidates);
        setDiscoveryNotice({
          variant: "success",
          text: `Discovered ${res.data.candidates.length} real candidate(s) from Channel3. Real products lack shipping quotes and upstream timestamps; evaluating them will deterministically fail policy.`,
        });
      }
    } finally {
      setDiscoveryLoading(false);
    }
  };

  // Select a real discovered candidate
  const handleSelectRealCandidate = (cand: NormalizedProductCandidate) => {
    setSelectedCandidateObj(cand);
    setItemTitle(cand.title);
    setMerchantName(cand.merchantName);
    setMerchantUrl(cand.merchantUrl);
    setExternalId(cand.externalId);
    setUnitPriceDollars((cand.unitPriceCents / 100).toFixed(2));
    setShippingDollars((cand.shippingCents / 100).toFixed(2));
    setIsSyntheticCandidate(false);
    setServerError(null);
    setEvaluationResult(null);
  };

  // Load verified synthetic demonstration fixture
  const handleLoadSyntheticFixture = () => {
    setSelectedCandidateObj(null);
    setItemTitle("[DEMO FIXTURE] Dell XPS 15 9530 Laptop");
    setMerchantName("Dell Official Store");
    setMerchantUrl("https://dell.com/xps15");
    setExternalId("cand_dell_xps_15_verified");
    setUnitPriceDollars("120.00");
    setShippingDollars("10.00");
    setIsSyntheticCandidate(true);
    setServerError(null);
    setEvaluationResult(null);
  };

  const handleEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const unitPriceCents = Math.round(parseFloat(unitPriceDollars) * 100);
    const shippingCents = Math.round(parseFloat(shippingDollars) * 100);

    setInternalLoading(true);
    try {
      const nowIso = new Date().toISOString();
      const rawObservations = isSyntheticCandidate
        ? [
            {
              requirementKey: "merchant_spec",
              value: "Dell XPS 15 or equivalent verified",
              status: "supports",
              sourceUrl: merchantUrl.trim() || "https://dell.com/xps15",
              sourceType: "merchant_spec",
              capturedAt: nowIso,
            },
            {
              requirementKey: "reputation_check",
              value: "Verified Business Account",
              status: "supports",
              sourceUrl: "https://reputation.example.com/merchant",
              sourceType: "reputation_registry",
              capturedAt: nowIso,
            },
            {
              requirementKey: "freshness",
              value: "Local-demo synthetic capture timestamp (demo only; not independent merchant proof)",
              status: "supports",
              sourceUrl: merchantUrl.trim() || "https://merchant.example.com",
              sourceType: "local_demo_synthetic",
              capturedAt: nowIso,
            },
          ]
        : [
            {
              requirementKey: "merchant_spec",
              value: itemTitle.trim(),
              status: "supports",
              sourceUrl: merchantUrl.trim(),
              sourceType: "channel3_listing",
              capturedAt: selectedCandidateObj?.shippingDetails?.sourceVerificationTimestamp || nowIso,
            },
            {
              requirementKey: "freshness",
              value: selectedCandidateObj?.shippingDetails?.sourceVerificationTimestamp
                ? `Authoritative verified quote timestamp: ${selectedCandidateObj.shippingDetails.sourceVerificationTimestamp}`
                : "Channel3 observation timestamp (upstream verification timestamp unconfirmed)",
              status: selectedCandidateObj?.shippingDetails?.sourceVerificationTimestamp ? "supports" : "missing",
              sourceUrl: selectedCandidateObj?.shippingDetails?.policySourceUrl || merchantUrl.trim(),
              sourceType: selectedCandidateObj?.shippingDetails?.type === "policy_derived" ? "merchant_policy" : "channel3_observation",
              capturedAt: selectedCandidateObj?.shippingDetails?.sourceVerificationTimestamp || nowIso,
            },
            ...(selectedCandidateObj?.shippingDetails?.destinationPostalCode
              ? [
                  {
                    requirementKey: "destination",
                    value: selectedCandidateObj.shippingDetails.destinationPostalCode,
                    status: "supports",
                    sourceUrl: selectedCandidateObj.shippingDetails.policySourceUrl || merchantUrl.trim(),
                    sourceType: "destination_evidence",
                    capturedAt: nowIso,
                  },
                ]
              : []),
            ...(selectedCandidateObj?.shippingDetails
              ? [
                  {
                    requirementKey: "shipping",
                    value: JSON.stringify(selectedCandidateObj.shippingDetails),
                    status: selectedCandidateObj.shippingDetails.isAuthoritative ? "supports" : "missing",
                    sourceUrl: selectedCandidateObj.shippingDetails.policySourceUrl || merchantUrl.trim(),
                    sourceType: selectedCandidateObj.shippingDetails.type,
                    capturedAt: nowIso,
                  },
                ]
              : []),
          ];

      const rawCandidatePayload: Record<string, unknown> =
        !isSyntheticCandidate && selectedCandidateObj
          ? {
              externalId: selectedCandidateObj.externalId,
              title: selectedCandidateObj.title,
              merchantName: selectedCandidateObj.merchantName,
              merchantUrl: selectedCandidateObj.merchantUrl,
              unitPriceCents: selectedCandidateObj.unitPriceCents,
              quantity: selectedCandidateObj.quantity ?? 1,
              shippingCents: selectedCandidateObj.shippingCents,
              currency: selectedCandidateObj.currency,
              availability: selectedCandidateObj.availability,
              shipping: selectedCandidateObj.shippingCents,
              shippingType: selectedCandidateObj.shippingDetails?.type,
              deliveryMethod: selectedCandidateObj.shippingDetails?.deliveryMethod,
              destinationPostalCode: selectedCandidateObj.shippingDetails?.destinationPostalCode,
              destinationCountry: selectedCandidateObj.shippingDetails?.destinationCountry,
              policyId: selectedCandidateObj.shippingDetails?.policyId,
              policyDocumentFingerprint: selectedCandidateObj.shippingDetails?.policyDocumentFingerprint,
              policySourceUrl: selectedCandidateObj.shippingDetails?.policySourceUrl,
              geographicZone: selectedCandidateObj.shippingDetails?.geographicZone,
              serviceabilityStatus: selectedCandidateObj.shippingDetails?.serviceabilityStatus,
              thresholdCents: selectedCandidateObj.shippingDetails?.thresholdCents,
              capturedAt: selectedCandidateObj.capturedAt ? new Date(selectedCandidateObj.capturedAt).toISOString() : nowIso,
              sourceVerificationTimestamp: selectedCandidateObj.shippingDetails?.sourceVerificationTimestamp,
              sellerName: selectedCandidateObj.sellerName,
              isMarketplace: selectedCandidateObj.isMarketplace,
              isDirectRetailer: selectedCandidateObj.isDirectRetailer,
              fulfillmentMethod: selectedCandidateObj.fulfillmentMethod,
              rawAttributes: selectedCandidateObj.rawSourceData?.rawAttributes ?? {},
            }
          : {
              externalId: externalId.trim() || "ext_candidate_1",
              title: itemTitle.trim() || "Item Title",
              merchantName: merchantName.trim() || "Merchant Name",
              merchantUrl: merchantUrl.trim() || "https://merchant.example.com",
              unitPriceCents: isNaN(unitPriceCents) ? 10000 : unitPriceCents,
              quantity: 1,
              shippingCents: isNaN(shippingCents) ? 0 : shippingCents,
              currency: "USD",
              availability: availability.trim() || "IN_STOCK",
            };

      const result = await evaluatePurchaseApi(
        purchase.id,
        {
          rawCandidate: rawCandidatePayload,
          rawObservations,
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
          expectedVersion: purchase.version,
        },
        { actorId }
      );

      if (!result.ok) {
        setServerError(`[${result.error.code}] ${result.error.message}`);
      } else {
        setEvaluationResult(result.data);
        onRefreshRequested();
      }
    } finally {
      setInternalLoading(false);
    }
  };

  const getSummaryVariant = (summary: EvaluatePurchaseResponse["summary"]): StatusChipVariant => {
    if (summary.allRequiredPassed) {
      return "pass";
    }
    if (summary.blockingRuleKeys.length > 0) {
      return "block";
    }
    if (summary.unknownRuleKeys.length > 0) {
      return "caution";
    }
    return "neutral";
  };

  const getSummaryLabel = (summary: EvaluatePurchaseResponse["summary"]): string => {
    if (summary.allRequiredPassed) {
      return "POLICY PASS";
    }
    if (summary.blockingRuleKeys.length > 0) {
      return `POLICY BLOCKED (${summary.blockingRuleKeys.length} rules)`;
    }
    if (summary.unknownRuleKeys.length > 0) {
      return `POLICY UNKNOWN (${summary.unknownRuleKeys.length} rules)`;
    }
    return "UNKNOWN";
  };

  return (
    <Card heading="2. Candidate Selection & Policy Evaluation" className="mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-[var(--line)]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-[var(--ink-muted)]">Current Workflow Status:</span>
          <StatusChip
            variant={
              purchase.status === "APPROVED" || purchase.status === "BUYER_APPROVED"
                ? "pass"
                : purchase.status === "ORDER_CREATED"
                ? "info"
                : purchase.status === "POLICY_PASSED"
                ? "pass"
                : "neutral"
            }
            label={purchase.status}
          />
          <span className="text-xs text-[var(--ink-muted)]">Version: {purchase.version}</span>
        </div>
        <Button variant="secondary" onClick={onRefreshRequested} loading={loading} disabled={loading} className="text-xs py-1 px-2.5">
          Refresh State
        </Button>
      </div>

      {purchase.status === "ORDER_CREATED" && (
        <div className="mb-4">
          <Banner variant="info">
            <strong>Candidate Evaluation Locked:</strong> This purchase has reached <code>ORDER_CREATED</code> with an active PayPal Sandbox order ({purchase.livePaymentAttempt?.paypalOrderId ?? "pending"}). Modifying candidate selection or re-evaluating policy is prohibited while an order is open to preserve commercial assurance invariants (guard P8: changes blocked by open payment).
          </Banner>
        </div>
      )}

      {serverError && (
        <div className="mb-4">
          <Banner variant="error">{serverError}</Banner>
        </div>
      )}

      {/* 2A. Product Discovery from Channel3 */}
      <div className="mb-6 p-4 rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface-raised)]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
          <div>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Channel3 External Product Discovery</h3>
            <p className="text-xs text-[var(--ink-muted)]">
              Query live retail candidates. Note: Channel3 provides catalog search without carrier shipping quotes.
            </p>
          </div>
          <StatusChip variant="info" label="Channel3 API" />
        </div>

        <div className="flex gap-2 mt-3">
          <Input
            id="channel3-query"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search products (e.g. Dell XPS 15)"
            disabled={discoveryLoading || !isEvaluationAllowed}
            className="flex-1 text-xs"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleDiscover}
            loading={discoveryLoading}
            disabled={discoveryLoading || !isEvaluationAllowed}
            className="text-xs"
          >
            Search Live Catalog
          </Button>
        </div>

        {discoveryNotice && (
          <div className="mt-3">
            <Banner variant={discoveryNotice.variant}>{discoveryNotice.text}</Banner>
          </div>
        )}

        {/* AG Grid Multi-Candidate Studio */}
        <CandidateComparisonGrid
          candidates={gridCandidates}
          selectedCandidateExternalId={externalId}
          onSelectCandidate={(cand) => {
            const c = cand as Partial<NormalizedProductCandidate>;
            if (c.externalId === "cand_dell_xps_15_verified" || String(c.externalId).includes("fixture")) {
              handleLoadSyntheticFixture();
            } else {
              handleSelectRealCandidate(cand as NormalizedProductCandidate);
            }
          }}
          budgetCents={purchase.budgetCents}
          currency={purchase.currency}
        />

        {discoveredCandidates.length > 0 && (
          <div className="mt-4 space-y-2">
            <span className="text-xs font-medium text-[var(--ink)]">Discovered Live Candidates:</span>
            <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
              {discoveredCandidates.map((cand) => (
                <div
                  key={cand.id || cand.externalId}
                  className="p-3 border border-[var(--line)] rounded-[var(--radius-control)] bg-[var(--surface)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[var(--ink)] truncate">{cand.title}</div>
                    <div className="text-[var(--ink-muted)]">
                      Merchant: {cand.merchantName} | Unit Price: ${(cand.unitPriceCents / 100).toFixed(2)}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-mono">
                        Shipping: MISSING from upstream
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 font-mono">
                        Timestamp: Local observation only
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => handleSelectRealCandidate(cand)}
                    disabled={!isEvaluationAllowed}
                    className="text-xs py-1 px-2 shrink-0"
                  >
                    Select Real Candidate
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2B. Demonstration Path Toggle */}
      <div className="mb-4 p-3 rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--ink)]">
              Candidate Provenance Mode:
            </span>
            <StatusChip
              variant={isSyntheticCandidate ? "pass" : "caution"}
              label={isSyntheticCandidate ? "Verified Synthetic Fixture" : "Real External Listing (Incomplete)"}
            />
          </div>
          <p className="text-[11px] text-[var(--ink-muted)] mt-1">
            {isSyntheticCandidate
              ? "Synthetic fixture includes verified shipping ($10.00), verified specs, and valid freshness timestamp to demonstrate PayPal Sandbox approval."
              : "Real Channel3 listing: lacks carrier-backed shipping quote and upstream signature; will fail policy verification."}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={handleLoadSyntheticFixture}
          disabled={!isEvaluationAllowed}
          className="text-xs py-1 px-3 whitespace-nowrap"
        >
          Load Verified Synthetic Fixture (for Demo)
        </Button>
      </div>

      {/* Synthetic Demonstration Data Notice */}
      <div className="mb-4">
        <Banner variant="info" id="synthetic-demo-notice">
          <strong>Demonstration Notice:</strong> Candidate product details, merchant identity, price, shipping, and evaluation observations are synthetic demonstration fixtures. They are not independently verified live retailer data, real-time inventory, or authenticated external merchant listings.
        </Banner>
      </div>

      {/* Candidate Data Display / Editing */}
      <form onSubmit={handleEvaluate} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Candidate Title" htmlFor="cand-title">
            <Input
              id="cand-title"
              value={itemTitle}
              onChange={(e) => setItemTitle(e.target.value)}
              disabled={loading || !isEvaluationAllowed}
              required
            />
          </Field>

          <Field label="Merchant Name" htmlFor="cand-merchant">
            <Input
              id="cand-merchant"
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
              disabled={loading || !isEvaluationAllowed}
              required
            />
          </Field>

          <Field label="Merchant URL" htmlFor="cand-url">
            <Input
              id="cand-url"
              type="url"
              value={merchantUrl}
              onChange={(e) => setMerchantUrl(e.target.value)}
              disabled={loading || !isEvaluationAllowed}
              required
            />
          </Field>

          <Field label="Candidate External ID" htmlFor="cand-ext-id">
            <Input
              id="cand-ext-id"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              disabled={loading || !isEvaluationAllowed}
              required
            />
          </Field>

          <Field label="Unit Price ($)" htmlFor="cand-price">
            <Input
              id="cand-price"
              type="number"
              step="0.01"
              value={unitPriceDollars}
              onChange={(e) => setUnitPriceDollars(e.target.value)}
              disabled={loading || !isEvaluationAllowed}
              required
            />
          </Field>

          <Field
            label="Shipping ($)"
            htmlFor="cand-shipping"
            hint={
              shippingDollars === "0.00"
                ? "Plinthly never assumes missing shipping is free."
                : "Authoritative shipping quote"
            }
          >
            <Input
              id="cand-shipping"
              type="number"
              step="0.01"
              value={shippingDollars}
              onChange={(e) => setShippingDollars(e.target.value)}
              disabled={loading || !isEvaluationAllowed}
              required
            />
          </Field>
        </div>

        <div className="flex justify-end pt-2">
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            disabled={loading || !isEvaluationAllowed}
          >
            Evaluate Candidate Policy
          </Button>
        </div>
      </form>

      {/* Evaluation Results Breakdown */}
      {evaluationResult && (
        <div className="mt-6 border-t border-[var(--line)] pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[var(--ink)]">Policy Engine Evaluation Result</h3>
            <StatusChip
              variant={getSummaryVariant(evaluationResult.summary)}
              label={getSummaryLabel(evaluationResult.summary)}
            />
          </div>

          {/* Explicitly distinguish UNKNOWN from PASS */}
          {evaluationResult.summary.unknownRuleKeys.length > 0 && !evaluationResult.summary.allRequiredPassed && (
            <div className="mb-3">
              <Banner variant="info">
                <strong>Policy Undetermined (UNKNOWN):</strong> Rules [
                {evaluationResult.summary.unknownRuleKeys.join(", ")}] could not be verified with complete evidence.
                UNKNOWN is strictly never converted to PASS.
              </Banner>
            </div>
          )}

          {evaluationResult.summary.blockingRuleKeys.length > 0 && (
            <div className="mb-3">
              <Banner variant="error">
                <strong>Policy Blocked (BLOCK):</strong> The candidate violates required procurement rules [
                {evaluationResult.summary.blockingRuleKeys.join(", ")}].
              </Banner>
            </div>
          )}

          {evaluationResult.summary.allRequiredPassed && (
            <div className="mb-3">
              <Banner variant="success">
                <strong>Policy Verification Succeeded (PASS):</strong> All required procurement assurance rules satisfied. Ready for buyer approval and PayPal Sandbox order creation.
              </Banner>
            </div>
          )}

          {/* Rule Breakdown Table */}
          {evaluationResult.ruleResults && Object.keys(evaluationResult.ruleResults).length > 0 && (
            <div className="overflow-x-auto border border-[var(--line)] rounded-[var(--radius-control)]">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[var(--surface-raised)] border-b border-[var(--line)]">
                    <th className="p-2 font-medium text-[var(--ink-muted)]">Rule Key</th>
                    <th className="p-2 font-medium text-[var(--ink-muted)]">Status</th>
                    <th className="p-2 font-medium text-[var(--ink-muted)]">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {Object.entries(evaluationResult.ruleResults).map(([key, res]) => (
                    <tr key={key} className="hover:bg-[var(--surface-raised)]">
                      <td className="p-2 font-mono font-semibold">{key}</td>
                      <td className="p-2">
                        <StatusChip
                          variant={
                            res.outcome === "pass"
                              ? "pass"
                              : res.outcome === "block"
                              ? "block"
                              : "caution"
                          }
                          label={res.outcome.toUpperCase()}
                        />
                      </td>
                      <td className="p-2 text-[var(--ink)]">{res.explanation?.reason || "Rule satisfied"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 text-[11px] font-mono text-[var(--ink-muted)] flex flex-col gap-1">
            <div>Snapshot Hash: {evaluationResult.snapshotHash}</div>
            <div>Evidence Fingerprint: {evaluationResult.evidenceFingerprint}</div>
          </div>
        </div>
      )}
    </Card>
  );
}
