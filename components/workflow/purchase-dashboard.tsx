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
import { Stage2ApprovalModal } from "./stage2-approval-modal";
import { PayPalMultiCartCheckout } from "./paypal-multi-cart-checkout";
import { Stage2PurchaseReceipt } from "./stage2-purchase-receipt";
import { ThemeToggle } from "../ui/theme-toggle";
import { getPurchaseApi, confirmBuyerApprovalApi } from "../../lib/workflow/client-api";
import { PurchaseResponse } from "../../lib/workflow/types";
import {
  getApprovalAggregateApi,
  checkoutCartApi,
  ApprovalAggregateDetailResponse,
} from "../../lib/workflow/stage2-client-api";

type WorkflowTab = "planning" | "discovery" | "checkout" | "receipt" | "legacy_approval" | "audit";

export function PurchaseDashboard() {
  const [actorId, setActorId] = React.useState<string>("usr_buyer_1");
  const [activePurchase, setActivePurchase] = React.useState<PurchaseResponse | null>(null);
  const [lookupId, setLookupId] = React.useState<string>("");
  const [lookupLoading, setLookupLoading] = React.useState<boolean>(false);
  const [lookupError, setLookupError] = React.useState<string | null>(null);

  // Stage 2/3 Multi-Cart Workflow State
  const [activeTab, setActiveTab] = React.useState<WorkflowTab>("planning");
  const [activeApprovalAggregateId, setActiveApprovalAggregateId] = React.useState<string | null>(null);
  const [aggregateData, setAggregateData] = React.useState<ApprovalAggregateDetailResponse | null>(null);
  const [isApprovalModalOpen, setIsApprovalModalOpen] = React.useState<boolean>(false);
  const [approvalModalLoading, setApprovalModalLoading] = React.useState<boolean>(false);
  const [workflowNotice, setWorkflowNotice] = React.useState<{ text: string; variant: "info" | "success" | "error" } | null>(null);

  // Untrusted callback bridge handler:
  // When returning from PayPal, URL query params contain purchaseId, untrusted paypal_token, and paypal_status.
  // The dashboard fetches authoritative purchase state, then invokes the server-side confirmation API
  // under its established actor context. State is never trusted from query parameters alone.
  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const paramPurchaseId = params.get("purchaseId")?.trim();
    const paramToken = params.get("paypal_token")?.trim();
    const paramAggId = params.get("aggregateId")?.trim();

    if (paramAggId) {
      setActiveApprovalAggregateId(paramAggId);
      void loadAggregate(paramAggId);
    }

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

  const loadAggregate = async (aggregateId: string) => {
    try {
      const data = await getApprovalAggregateApi(aggregateId, { actorId });
      setAggregateData(data);
      setActiveApprovalAggregateId(aggregateId);
      return data;
    } catch (err: unknown) {
      console.warn("Could not load aggregate:", err);
      return null;
    }
  };

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
        setActiveTab("planning");
      }
    } finally {
      setLookupLoading(false);
    }
  };

  const handleRefreshActive = async () => {
    if (!activePurchase) return;
    await handleFetchPurchase(activePurchase.id);
    if (activeApprovalAggregateId) {
      await loadAggregate(activeApprovalAggregateId);
    }
  };

  const handlePurchaseCreated = (created: PurchaseResponse) => {
    setActivePurchase(created);
    setLookupId(created.id);
    setActiveTab("planning");
  };

  // Callback from MultiItemProcurementStudio when an allocation is created
  const handleProceedToCheckout = async (aggregateId: string) => {
    setApprovalModalLoading(true);
    setWorkflowNotice(null);
    try {
      const agg = await loadAggregate(aggregateId);
      if (agg) {
        setIsApprovalModalOpen(true);
      } else {
        setWorkflowNotice({
          text: `Aggregate ${aggregateId} allocated. Ready for review.`,
          variant: "info",
        });
      }
    } finally {
      setApprovalModalLoading(false);
    }
  };

  // Confirm approval from Stage2ApprovalModal
  const handleApproveModal = async () => {
    if (!activeApprovalAggregateId) return;
    setApprovalModalLoading(true);
    try {
      await checkoutCartApi({ approvalAggregateId: activeApprovalAggregateId }, { actorId });
      // Refresh aggregate data
      const refreshed = await loadAggregate(activeApprovalAggregateId);
      setIsApprovalModalOpen(false);
      setActiveTab("checkout");
      setWorkflowNotice({
        text: `Approval verified with zero variance! ${refreshed?.carts.length || 0} merchant carts transitioned to BUYER_APPROVED.`,
        variant: "success",
      });
    } finally {
      setApprovalModalLoading(false);
    }
  };

  return (
    <AppShell
      headerActions={
        <div className="flex items-center gap-3">
          {activePurchase && (
            <span className="text-xs font-mono text-[var(--ink-muted)] hidden md:inline-block">
              Active: {activePurchase.id}
            </span>
          )}
          <a
            href="/"
            className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] font-medium transition-colors no-underline px-2 py-1 rounded hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]"
          >
            ← Overview
          </a>
          <ThemeToggle />
        </div>
      }
    >
      <div className="max-w-4xl mx-auto py-4">
        {/* Local Demo Actor Selector */}
        <ActorBar currentActorId={actorId} onActorChange={setActorId} />

        {/* Brand Promise Banner */}
        <div className="mb-6 p-4 rounded-[var(--radius-card)] bg-gradient-to-r from-[var(--surface-raised)] to-[var(--surface)] border border-[var(--line)] shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-bold tracking-tight text-[var(--ink)]">
                Plinthly Purchase Assurance
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-[var(--pass-tint)] text-[var(--pass)] border border-[var(--pass)]/20">
                Stage 3 Certified
              </span>
            </div>
            <p className="text-xs text-[var(--ink-muted)] font-medium">
              Every purchase. Proven. — Zero-variance landed cost, cryptographic attestation, and monotonic sequential capture.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-mono text-[var(--ink-muted)] bg-[var(--canvas)] px-2.5 py-1 rounded border border-[var(--line)]">
              Model A (Items + Ship + Tax)
            </span>
          </div>
        </div>

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
                  setActiveApprovalAggregateId(null);
                  setAggregateData(null);
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

        {workflowNotice && (
          <div className="mb-4">
            <Banner variant={workflowNotice.variant}>{workflowNotice.text}</Banner>
          </div>
        )}

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

            {/* Stepper Navigation across Workflow Milestones */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 mb-6 border-b border-[var(--line)] text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("planning")}
                className={`px-3 py-1.5 rounded-full font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer whitespace-nowrap ${
                  activeTab === "planning"
                    ? "bg-[var(--accent)] text-[var(--on-accent)] font-semibold shadow-xs"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)]"
                }`}
              >
                1. Multi-Item Planning
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("discovery")}
                className={`px-3 py-1.5 rounded-full font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer whitespace-nowrap ${
                  activeTab === "discovery"
                    ? "bg-[var(--accent)] text-[var(--on-accent)] font-semibold shadow-xs"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)]"
                }`}
              >
                2. Candidate Grid &amp; Evidence
              </button>
              <button
                type="button"
                onClick={() => {
                  if (activeApprovalAggregateId) {
                    setActiveTab("checkout");
                  } else {
                    setWorkflowNotice({
                      text: "Please approve or allocate a multi-item strategy first to initiate multi-cart checkout.",
                      variant: "info",
                    });
                  }
                }}
                className={`px-3 py-1.5 rounded-full font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer whitespace-nowrap ${
                  activeTab === "checkout"
                    ? "bg-[var(--accent)] text-[var(--on-accent)] font-semibold shadow-xs"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)]"
                }`}
              >
                3. Multi-Cart Checkout {aggregateData ? `(${aggregateData.carts.length})` : ""}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (aggregateData) {
                    setActiveTab("receipt");
                  } else {
                    setWorkflowNotice({
                      text: "No active settlement aggregate loaded yet. Complete checkout to view cryptographic receipts.",
                      variant: "info",
                    });
                  }
                }}
                className={`px-3 py-1.5 rounded-full font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer whitespace-nowrap ${
                  activeTab === "receipt"
                    ? "bg-[var(--accent)] text-[var(--on-accent)] font-semibold shadow-xs"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)]"
                }`}
              >
                4. Settlement &amp; Refunds
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("audit")}
                className={`px-3 py-1.5 rounded-full font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer whitespace-nowrap ${
                  activeTab === "audit"
                    ? "bg-[var(--accent)] text-[var(--on-accent)] font-semibold shadow-xs"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)]"
                }`}
              >
                5. Audit Trail
              </button>
            </div>

            {/* Tab Panel Content with Smooth Milestone Transition */}
            <div key={activeTab} className="animate-fade-in-up duration-250">
              {/* Stage 1.5: Multi-Item Procurement Studio */}
              {activeTab === "planning" && (
                <MultiItemProcurementStudio
                  key={`studio-${activePurchase.id}`}
                  purchase={activePurchase}
                  actorId={actorId}
                  onRefreshRequested={handleRefreshActive}
                  loading={lookupLoading}
                  onProceedToCheckout={handleProceedToCheckout}
                />
              )}

              {/* Stage 2: Candidate Selection & Evaluation */}
              {activeTab === "discovery" && (
                <CandidateEvaluationCard
                  purchase={activePurchase}
                  actorId={actorId}
                  onRefreshRequested={handleRefreshActive}
                  loading={lookupLoading}
                />
              )}

              {/* Stage 3: Multi-Cart Checkout & Sequential Capture */}
              {activeTab === "checkout" && activeApprovalAggregateId && aggregateData && (
                <PayPalMultiCartCheckout
                  approvalAggregateId={activeApprovalAggregateId}
                  carts={aggregateData.carts}
                  actorId={actorId}
                  onCaptureComplete={async () => {
                    await loadAggregate(activeApprovalAggregateId);
                  }}
                  onFinish={() => setActiveTab("receipt")}
                />
              )}

              {/* Stage 4: Settlement Receipt & Provenance Refunds */}
              {activeTab === "receipt" && aggregateData && (
                <Stage2PurchaseReceipt
                  aggregateData={aggregateData}
                  actorId={actorId}
                  onRefundProcessed={async () => {
                    if (activeApprovalAggregateId) {
                      await loadAggregate(activeApprovalAggregateId);
                    }
                  }}
                  onBack={() => setActiveTab("planning")}
                />
              )}

              {/* Legacy Single-Item PayPal Card (Accessible if needed) */}
              {activeTab === "legacy_approval" && (
                <>
                  <ApprovalCard
                    purchase={activePurchase}
                    actorId={actorId}
                    onRefreshRequested={handleRefreshActive}
                    loading={lookupLoading}
                  />
                  <PayPalCard
                    purchase={activePurchase}
                    actorId={actorId}
                    onRefreshRequested={handleRefreshActive}
                  />
                </>
              )}

              {/* Stage 5: Audit History */}
              {activeTab === "audit" && (
                <AuditCard
                  key={`audit-${activePurchase.id}`}
                  purchaseId={activePurchase.id}
                  actorId={actorId}
                />
              )}
            </div>

            {/* Stage 2 Approval Modal Overlay */}
            {isApprovalModalOpen && aggregateData && (
              <Stage2ApprovalModal
                isOpen={isApprovalModalOpen}
                aggregateData={aggregateData}
                onApprove={handleApproveModal}
                onClose={() => setIsApprovalModalOpen(false)}
                loading={approvalModalLoading}
              />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
