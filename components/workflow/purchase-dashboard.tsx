"use client";

import * as React from "react";
import { AppShell } from "../ui/app-shell";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Banner } from "../ui/banner";
import { StatusChip } from "../ui/status-chip";
import { ActorBar } from "./actor-bar";
import { PurchaseRequestCard } from "./purchase-request-card";
import { MultiItemProcurementStudio } from "./multi-item-procurement-studio";
import { CandidateEvaluationCard } from "./candidate-evaluation-card";
import { ApprovalCard } from "./approval-card";
import { PayPalCard } from "./paypal-card";
import { AuditCard } from "./audit-card";
import { ThemeToggle } from "../ui/theme-toggle";
import { getPurchaseApi, confirmBuyerApprovalApi } from "../../lib/workflow/client-api";
import { PurchaseResponse } from "../../lib/workflow/types";

export function PurchaseDashboard() {
  const [actorId, setActorId] = React.useState<string>("usr_buyer_1");
  const [activePurchase, setActivePurchase] = React.useState<PurchaseResponse | null>(null);
  const [lookupId, setLookupId] = React.useState<string>("");
  const [lookupLoading, setLookupLoading] = React.useState<boolean>(false);
  const [lookupError, setLookupError] = React.useState<string | null>(null);

  // Untrusted callback bridge handler:
  // When returning from PayPal, URL query params contain purchaseId, untrusted paypal_token, and paypal_status.
  // The dashboard fetches authoritative purchase state, then invokes the server-side confirmation API
  // under its established actor context. State is never trusted from query parameters alone.
  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const paramPurchaseId = params.get("purchaseId")?.trim();
    const paramToken = params.get("paypal_token")?.trim();

    if (!paramPurchaseId) return;

    void (async () => {
      setLookupId(paramPurchaseId);
      setLookupLoading(true);
      setLookupError(null);
      try {
        const fetchRes = await getPurchaseApi(paramPurchaseId, { actorId });
        if (!fetchRes.ok) {
          setLookupError(`[${fetchRes.error.code}] ${fetchRes.error.message}`);
          return;
        }
        setActivePurchase(fetchRes.data);

        // If returning from PayPal with an untrusted order token and status is ORDER_CREATED,
        // invoke the authoritative confirmation API using the dashboard's established actor context.
        if (paramToken && fetchRes.data.status === "ORDER_CREATED") {
          const confirmRes = await confirmBuyerApprovalApi(paramPurchaseId, {
            actorId,
            paypalOrderId: paramToken,
          });
          if (confirmRes.ok) {
            setActivePurchase(confirmRes.data);
          } else {
            setLookupError(`[${confirmRes.error.code}] ${confirmRes.error.message}`);
          }
        }
      } finally {
        setLookupLoading(false);
        // Safely clean PayPal token from URL query parameters without reloading
        if (paramToken && typeof window !== "undefined" && window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, `${window.location.pathname}?purchaseId=${encodeURIComponent(paramPurchaseId)}`);
        }
      }
    })();
  }, [actorId]);

  const handleFetchPurchase = async (idToFetch: string) => {
    const trimmed = idToFetch.trim();
    if (!trimmed) {
      setLookupError("Please enter a purchase ID.");
      return;
    }

    setLookupError(null);
    setLookupLoading(true);
    try {
      const result = await getPurchaseApi(trimmed, { actorId });
      if (!result.ok) {
        setLookupError(`[${result.error.code}] ${result.error.message}`);
      } else {
        setActivePurchase(result.data);
      }
    } finally {
      setLookupLoading(false);
    }
  };

  const handleRefreshActive = async () => {
    if (!activePurchase) return;
    await handleFetchPurchase(activePurchase.id);
  };

  const handlePurchaseCreated = (created: PurchaseResponse) => {
    setActivePurchase(created);
    setLookupId(created.id);
  };

  return (
    <AppShell
      headerActions={
        <div className="flex items-center gap-3">
          {activePurchase && (
            <span className="text-xs font-mono text-[var(--ink-muted)]">
              Active: {activePurchase.id}
            </span>
          )}
          <ThemeToggle />
        </div>
      }
    >
      <div className="max-w-4xl mx-auto py-4">
        {/* Local Demo Actor Selector */}
        <ActorBar currentActorId={actorId} onActorChange={setActorId} />

        {/* Purchase Lookup / Switcher */}
        <div className="border border-[var(--line)] bg-[var(--surface)] rounded-[var(--radius-card)] p-4 mb-6">
          {/* Quick-load Verified Demo Purchases */}
          <div className="mb-4 pb-4 border-b border-[var(--line)]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-1.5">
              <span className="text-xs font-semibold text-[var(--ink)]">
                Completed Sandbox Examples (Synthetic Demonstration Fixtures)
              </span>
              <span className="text-[11px] text-[var(--ink-muted)]">
                Click to inspect pre-verified purchases
              </span>
            </div>
            <p className="text-[11px] text-[var(--ink-muted)] mb-3 leading-relaxed">
              These sample purchases completed full deterministic policy evaluation, snapshot-bound approval, and server-verified PayPal Sandbox buyer approval. Product and merchant details are synthetic demonstration fixtures; funds remain uncaptured.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                id="quick-load-sample-1"
                variant="secondary"
                onClick={() => {
                  setLookupId("pur_1792633876502_s7jvwi22");
                  void handleFetchPurchase("pur_1792633876502_s7jvwi22");
                }}
                disabled={lookupLoading}
                className="text-xs font-mono py-1 px-3"
              >
                Sample 1: pur_1792633876502_s7jvwi22
              </Button>
              <Button
                id="quick-load-sample-2"
                variant="secondary"
                onClick={() => {
                  setLookupId("pur_1792654701712_f2iks5to");
                  void handleFetchPurchase("pur_1792654701712_f2iks5to");
                }}
                disabled={lookupLoading}
                className="text-xs font-mono py-1 px-3"
              >
                Sample 2: pur_1792654701712_f2iks5to
              </Button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div className="flex-1">
              <label htmlFor="lookup-purchase-id" className="text-xs font-medium text-[var(--ink)] block mb-1">
                Lookup Existing Purchase ID
              </label>
              <div className="flex gap-2">
                <Input
                  id="lookup-purchase-id"
                  value={lookupId}
                  onChange={(e) => setLookupId(e.target.value)}
                  placeholder="Enter purchase ID (e.g. prch_...)"
                  className="font-mono text-xs"
                />
                <Button
                  variant="secondary"
                  onClick={() => handleFetchPurchase(lookupId)}
                  loading={lookupLoading}
                  disabled={lookupLoading}
                  className="text-xs whitespace-nowrap"
                >
                  Load Purchase
                </Button>
              </div>
            </div>
            {activePurchase && (
              <Button
                variant="secondary"
                onClick={() => {
                  setActivePurchase(null);
                  setLookupId("");
                }}
                className="text-xs whitespace-nowrap"
              >
                + New Purchase
              </Button>
            )}
          </div>
          {lookupError && (
            <div className="mt-3">
              <Banner variant="error">{lookupError}</Banner>
            </div>
          )}
        </div>

        {/* Section A: Create Purchase Form */}
        {!activePurchase ? (
          <PurchaseRequestCard
            actorId={actorId}
            onPurchaseCreated={handlePurchaseCreated}
          />
        ) : (
          /* Active Purchase Workflow Stages */
          <div>
            {/* Active Purchase Summary Banner */}
            <Card className="mb-6 bg-[var(--surface-raised)] border-[var(--line)]">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--line)]">
                <div>
                  <span className="text-xs text-[var(--ink-muted)]">Active Purchase: </span>
                  <span className="font-mono font-bold text-sm text-[var(--ink)]">{activePurchase.id}</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip
                    variant={
                      activePurchase.status === "BUYER_APPROVED"
                        ? "pass"
                        : activePurchase.status === "ORDER_CREATED"
                        ? "info"
                        : activePurchase.status === "APPROVED"
                        ? "pass"
                        : "neutral"
                    }
                    label={
                      activePurchase.status === "BUYER_APPROVED"
                        ? "BUYER_APPROVED (UNCAPTURED)"
                        : activePurchase.status
                    }
                  />
                  <Button
                    id="purchase-refresh-btn"
                    variant="secondary"
                    onClick={handleRefreshActive}
                    loading={lookupLoading}
                    className="text-xs py-1 px-2.5"
                  >
                    Refresh
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-3 text-[var(--ink-muted)]">
                <div>
                  <span>Budget: </span>
                  <span className="font-medium text-[var(--ink)] font-mono">
                    ${(activePurchase.budgetCents / 100).toFixed(2)} {activePurchase.currency}
                  </span>
                </div>
                <div>
                  <span>Version: </span>
                  <span className="font-medium text-[var(--ink)] font-mono">{activePurchase.version}</span>
                </div>
                <div>
                  <span>Owner: </span>
                  <span className="font-medium text-[var(--ink)] font-mono">{activePurchase.ownerUserId}</span>
                </div>
                <div>
                  <span>Policy Version: </span>
                  <span className="font-medium text-[var(--ink)] font-mono">{activePurchase.policyVersion || "none"}</span>
                </div>
              </div>
            </Card>

            {/* Stage 1.5: Multi-Item Procurement Studio */}
            <MultiItemProcurementStudio
              key={`studio-${activePurchase.id}`}
              purchase={activePurchase}
              actorId={actorId}
              onRefreshRequested={handleRefreshActive}
              loading={lookupLoading}
            />

            {/* Stage 2: Candidate Selection & Evaluation */}
            <CandidateEvaluationCard
              purchase={activePurchase}
              actorId={actorId}
              onRefreshRequested={handleRefreshActive}
              loading={lookupLoading}
            />

            {/* Stage 3: Buyer Approval */}
            <ApprovalCard
              purchase={activePurchase}
              actorId={actorId}
              onRefreshRequested={handleRefreshActive}
              loading={lookupLoading}
            />

            {/* Stage 4: PayPal Sandbox & Independent Verification */}
            <PayPalCard
              purchase={activePurchase}
              actorId={actorId}
              onRefreshRequested={handleRefreshActive}
            />

            {/* Stage 5: Audit History */}
            <AuditCard
              key={`audit-${activePurchase.id}`}
              purchaseId={activePurchase.id}
              actorId={actorId}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
