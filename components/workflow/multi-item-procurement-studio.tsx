"use client";

import * as React from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { Banner } from "../ui/banner";
import {
  ProcurementLineItem,
  ProcurementStrategy,
  RetailerCart,
  PlannedShipment,
  MultiItemProcurementPlan,
} from "../../lib/discovery/cart/types";
import { PurchaseResponse } from "../../lib/workflow/types";
import { allocateCartsApi } from "../../lib/workflow/stage2-client-api";

interface MultiItemProcurementStudioProps {
  readonly purchase: PurchaseResponse;
  readonly actorId: string;
  readonly onRefreshRequested: () => Promise<void>;
  readonly loading?: boolean;
  readonly onProceedToCheckout?: (aggregateId: string) => void;
}

export function MultiItemProcurementStudio({
  purchase,
  actorId,
  onRefreshRequested,
  loading = false,
  onProceedToCheckout,
}: MultiItemProcurementStudioProps) {
  const [lineItems, setLineItems] = React.useState<ProcurementLineItem[]>(() => {
    if (purchase.lineItems && purchase.lineItems.length > 0) {
      return [...purchase.lineItems];
    }
    return [
      {
        id: "line_1",
        title: "Dell XPS 15 Laptop (32GB RAM)",
        quantity: 1,
        budgetCents: 150000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
        verificationLevel: "standard",
      },
      {
        id: "line_2",
        title: "Dell UltraSharp 27 4K Monitor",
        quantity: 1,
        budgetCents: 40000,
        currency: "USD",
        requirements: [{ key: "resolution", expectedValue: "4K", description: "4K UHD Resolution" }],
        verificationLevel: "standard",
      },
      {
        id: "line_3",
        title: "USB-C Dual 4K Docking Station",
        quantity: 1,
        budgetCents: 15000,
        currency: "USD",
        requirements: [{ key: "ports", expectedValue: "Dual HDMI/DP", description: "Dual DisplayPort/HDMI" }],
        verificationLevel: "standard",
      },
    ];
  });

  const [plan, setPlan] = React.useState<MultiItemProcurementPlan | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = React.useState<string | null>(null);
  const [customPostalCode, setCustomPostalCode] = React.useState<string | null>(null);
  const effectivePostalCode =
    customPostalCode ??
    purchase.destination?.postalCode ??
    purchase.multiItemSnapshot?.destination?.postalCode ??
    "98101";
  const [itemsModifiedAfterApproval, setItemsModifiedAfterApproval] = React.useState<boolean>(false);
  const [isJudgeFixtureActive, setIsJudgeFixtureActive] = React.useState<boolean>(false);

  const activeStrategyId =
    selectedStrategyId ||
    purchase.multiItemSnapshot?.strategyId ||
    plan?.strategies[0]?.strategyId ||
    null;
  const [planLoading, setPlanLoading] = React.useState<boolean>(false);
  const [approving, setApproving] = React.useState<boolean>(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<"strategies" | "carts" | "shipments" | "items">(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search).get("tab");
      if (p === "carts" || p === "shipments" || p === "items" || p === "strategies") return p;
    }
    return "strategies";
  });

  const handleGeneratePlan = async (
    overrideItems?: ProcurementLineItem[],
    overrideCandidates?: Record<string, unknown>[]
  ) => {
    setPlanLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    // Client requests must never supply internal provenance
    const itemsToEvaluate = (overrideItems ?? lineItems).map((item) => {
      if (item.quantitySource === "legacy_direct") {
        const { quantitySource: _stripped, ...rest } = item;
        return rest as ProcurementLineItem;
      }
      return item;
    });

    try {
      const res = await fetch(`/api/purchases/${encodeURIComponent(purchase.id)}/multi-item/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": actorId,
          "x-actor-kind": "user",
        },
        body: JSON.stringify({
          lineItems: itemsToEvaluate,
          destination: {
            country: "US",
            postalCode: effectivePostalCode.trim() || "98101",
            deliveryMethodPreference: "standard_ground",
          },
          ...(overrideCandidates && overrideCandidates.length > 0 ? { candidates: overrideCandidates } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        const detailStr = data.error?.details && Array.isArray(data.error.details)
          ? ` (${data.error.details.map((d: { path?: string; message?: string }) => `${d.path ?? "field"}: ${d.message ?? "invalid"}`).join("; ")})`
          : "";
        throw new Error(data.error?.message ? `${data.error.message}${detailStr}` : `Failed to evaluate plan (${res.status})`);
      }

      setPlan(data);
      if (data.strategies && data.strategies.length > 0) {
        setSelectedStrategyId(data.strategies[0].strategyId);
      }
      setSuccessMsg(`Evaluated ${data.strategies?.length ?? 0} feasible procurement strategies.`);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Plan generation failed.");
    } finally {
      setPlanLoading(false);
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    if (!plan && !planLoading && purchase.lineItems && purchase.lineItems.length > 0) {
      const timer = setTimeout(() => {
        if (!cancelled) {
          void handleGeneratePlan();
        }
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchase.id]);

  const handleLoadJudgeFixture = async () => {
    setIsJudgeFixtureActive(true);
    const fixtureItems: ProcurementLineItem[] = [
      {
        id: "line_1",
        title: "Dell XPS 15 Laptop (32GB RAM)",
        quantity: 1,
        budgetCents: 150000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB RAM" }],
        verificationLevel: "standard",
        quantitySource: "explicit",
      },
      {
        id: "line_2",
        title: "Dell UltraSharp 27 4K Monitor",
        quantity: 1,
        budgetCents: 40000,
        currency: "USD",
        requirements: [{ key: "resolution", expectedValue: "4K", description: "4K UHD Resolution" }],
        verificationLevel: "standard",
        quantitySource: "explicit",
      },
      {
        id: "line_3",
        title: "USB-C Dual 4K Docking Station",
        quantity: 1,
        budgetCents: 15000,
        currency: "USD",
        requirements: [{ key: "ports", expectedValue: "Dual HDMI/DP", description: "Dual DisplayPort/HDMI" }],
        verificationLevel: "standard",
        quantitySource: "explicit",
      },
    ];
    setLineItems(fixtureItems);

    const fixtureCandidates = [
      {
        id: `${purchase.id}_cand_bb_laptop`,
        purchaseId: purchase.id,
        externalId: "bb_laptop_001",
        title: "Dell XPS 15 Laptop (32GB RAM)",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/dell-xps-15",
        unitPriceCents: 146000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 146000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date().toISOString(),
        snapshotHash: `hash_bb_laptop_${purchase.id}`,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ram: "32GB" },
      },
      {
        id: `${purchase.id}_cand_bb_monitor`,
        purchaseId: purchase.id,
        externalId: "bb_monitor_002",
        title: "Dell UltraSharp 27 4K Monitor",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/dell-ultrasharp-27",
        unitPriceCents: 40000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 40000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date().toISOString(),
        snapshotHash: `hash_bb_monitor_${purchase.id}`,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { resolution: "4K" },
      },
      {
        id: `${purchase.id}_cand_bb_dock`,
        purchaseId: purchase.id,
        externalId: "bb_dock_003",
        title: "USB-C Dual 4K Docking Station",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/usbc-dock",
        unitPriceCents: 15000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 15000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date().toISOString(),
        snapshotHash: `hash_bb_dock_${purchase.id}`,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ports: "Dual HDMI/DP" },
      },
      {
        id: `${purchase.id}_cand_bh_dock`,
        purchaseId: purchase.id,
        externalId: "bh_dock_004",
        title: "B&H USB-C Dual Dock",
        merchantName: "B&H Photo Video",
        merchantUrl: "https://www.bhphotovideo.com/c/product/dock",
        unitPriceCents: 14000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 14000,
        currency: "USD",
        availability: "in_stock",
        source: "seeded",
        capturedAt: new Date().toISOString(),
        snapshotHash: `hash_bh_dock_${purchase.id}`,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "B&H Photo Video",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawAttributes: { ports: "Dual HDMI/DP" },
      },
    ];

    await handleGeneratePlan(fixtureItems, fixtureCandidates);
  };

  const handleApproveStrategy = async (strategy: ProcurementStrategy) => {
    if (!strategy.isLandedCostDefensible || strategy.feasibility !== "feasible") {
      setErrorMsg("Cannot approve strategy: landed cost contains unquoted shipping fees or unfulfilled items.");
      return;
    }

    setApproving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/purchases/${encodeURIComponent(purchase.id)}/multi-item/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": actorId,
          "x-actor-kind": "user",
        },
        body: JSON.stringify({
          strategyId: strategy.strategyId,
          expectedTotalLandedCostCents: strategy.totalLandedCostCents,
          expectedCurrency: strategy.currency,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || `Failed to approve strategy (${res.status})`);
      }

      // Automatically persist relational allocation to PostgreSQL plinthly_stage2_dev
      let allocatedAggId: string | null = null;
      try {
        const allocRes = await allocateCartsApi(
          {
            userId: actorId,
            strategy: strategy.name || strategy.strategyId,
            planLifecycleStatus: "ACTIVE",
            lineItems: lineItems.map((li: ProcurementLineItem) => ({
              itemDescription: li.title,
              targetQuantity: li.quantity,
              maxUnitCents: li.budgetCents || 500000,
            })),
            carts: strategy.carts.map((cart: RetailerCart) => {
              const disc = cart.thresholdEvaluation?.discountCents ?? 0;
              const ship = cart.totalShippingCents ?? 0;
              const merch = cart.merchandiseSubtotalCents;
              const total = merch - disc + ship;
              return {
                merchantId: (cart.merchantDomain || "merchant").replace(/\./g, "_"),
                merchantPayeeEmail: `payee@${cart.merchantDomain || "merchant.test"}`,
                merchandiseSubtotalCents: merch,
                discountCents: disc,
                shippingTotalCents: ship,
                taxAmountCents: 0,
                totalCartCents: total,
                currency: cart.currency || "USD",
                allocations: cart.items.map((item) => {
                  const idx = lineItems.findIndex((li) => li.id === item.lineItemId);
                  return {
                    lineItemIndex: idx >= 0 ? idx : 0,
                    allocatedQuantity: item.quantity,
                    allocatedUnitCents: item.unitPriceCents,
                  };
                }),
              };
            }),
            snapshotPayload: {
              purchaseId: purchase.id,
              strategyId: strategy.strategyId,
              approvedAt: new Date().toISOString(),
            },
          },
          { actorId }
        );

        if (allocRes.success) {
          allocatedAggId = allocRes.approvalAggregateId;
        }
      } catch (allocErr) {
        console.warn("Auto-allocation note:", allocErr);
      }

      setSuccessMsg(
        `Strategy "${strategy.name}" approved successfully! ${
          allocatedAggId ? `Stage 2 Aggregate ${allocatedAggId.slice(0, 8)}... created.` : ""
        }`
      );
      await onRefreshRequested();
      if (allocatedAggId && onProceedToCheckout) {
        onProceedToCheckout(allocatedAggId);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Strategy approval failed.");
    } finally {
      setApproving(false);
    }
  };

  const activeStrategy = plan?.strategies.find((s) => s.strategyId === activeStrategyId) ?? plan?.strategies[0];

  return (
    <Card className="mb-6 border-[var(--line)]">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--line)]">
        <div>
          <h2 className="text-base font-semibold text-[var(--ink)]">Multi-Item Procurement Studio</h2>
          <p className="text-xs text-[var(--ink-muted)]">
            Multi-line item requirements, retailer cart threshold aggregation, split-shipment dispatch, and landed cost strategy comparison.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
            <span className="whitespace-nowrap">Ship to ZIP:</span>
            <input
              type="text"
              value={effectivePostalCode}
              onChange={(e) => {
                setCustomPostalCode(e.target.value);
                if (purchase.status === "APPROVED") {
                  setItemsModifiedAfterApproval(true);
                }
              }}
              placeholder="98101"
              maxLength={10}
              className="w-20 px-2 py-1 text-xs border border-[var(--line)] rounded bg-[var(--surface-raised)] font-mono text-[var(--ink)]"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setItemsModifiedAfterApproval(false);
              void handleLoadJudgeFixture();
            }}
            loading={planLoading}
            disabled={loading}
            className="text-xs py-1.5 px-3 whitespace-nowrap"
          >
            Load Demo Fixture
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setItemsModifiedAfterApproval(false);
              void handleGeneratePlan();
            }}
            loading={planLoading}
            disabled={loading}
            className="text-xs py-1.5 px-3 whitespace-nowrap"
          >
            {plan ? "Re-Evaluate Strategies" : "Evaluate Multi-Item Plan"}
          </Button>
        </div>
      </div>

      {/* Synthetic Demo Fixture Active Indicator */}
      {isJudgeFixtureActive && (
        <div className="mt-3 p-3 bg-[var(--surface-sunken)] border border-[var(--accent)]/30 rounded-md text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[var(--accent)] flex items-center gap-1">
              🧪 Synthetic Demo Fixture Active
            </span>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-[var(--surface-raised)] border border-[var(--line)] text-[var(--ink-muted)]">
              Non-Live Simulation
            </span>
          </div>
          <p className="text-[var(--ink-muted)]">
            Loaded 3 synthetic enterprise hardware items across 2 simulated retailers (Best Buy, B&amp;H Photo Video). Evaluates single-retailer consolidation vs multi-retailer optimization with zero live financial transactions.
          </p>
        </div>
      )}

      {/* Persisted Approval Snapshot Indicator */}
      {purchase.multiItemSnapshot && (
        <div className="mt-3">
          {purchase.multiItemSnapshot.invalidatedAt ? (
            <Banner variant="error">
              <strong>⚠️ Approval Snapshot Invalidated:</strong> Reason: {purchase.multiItemSnapshot.invalidationReason || "terms_changed"}.
              <div className="mt-0.5 text-[11px]">
                Material inputs changed since approval. Re-evaluation required before checkout order creation.
              </div>
            </Banner>
          ) : (
            <Banner variant="success">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <strong>✓ Approved Strategy Locked: &quot;{purchase.multiItemSnapshot.strategyId}&quot;</strong>
                <span className="text-[11px] font-mono text-[var(--ink-muted)]">
                  Approver: {purchase.multiItemSnapshot.approverUserId}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-mono">
                Snapshot Hash: <span className="break-all">{purchase.multiItemSnapshot.multiItemSnapshotHash}</span>
              </div>
              <div className="mt-0.5 text-[11px]">
                Locked Pre-Tax Landed Cost: ${(purchase.multiItemSnapshot.totalLandedCostCents / 100).toFixed(2)} USD across {purchase.multiItemSnapshot.carts.length} retailer cart(s) (taxes calculated at merchant checkout).
              </div>
            </Banner>
          )}
        </div>
      )}

      {itemsModifiedAfterApproval && purchase.status === "APPROVED" && (
        <div className="mt-3">
          <Banner variant="info">
            <strong>Notice:</strong> Material procurement inputs (items, quantities, budgets, or destination) were modified. The current approval snapshot will be invalidated upon re-evaluation or checkout.
          </Banner>
        </div>
      )}

      {errorMsg && (
        <div className="mt-3">
          <Banner variant="error">{errorMsg}</Banner>
        </div>
      )}

      {successMsg && (
        <div className="mt-3">
          <Banner variant="info">{successMsg}</Banner>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-[var(--line)] mt-4 text-xs font-medium">
        <button
          onClick={() => setActiveTab("strategies")}
          className={`py-2 px-3 border-b-2 transition-all duration-150 active:scale-[0.98] cursor-pointer ${
            activeTab === "strategies"
              ? "border-[var(--accent)] text-[var(--accent)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)] hover:border-[var(--line)]"
          }`}
        >
          Strategy Comparison ({plan?.strategies.length ?? 0})
        </button>
        <button
          onClick={() => setActiveTab("carts")}
          className={`py-2 px-3 border-b-2 transition-all duration-150 active:scale-[0.98] cursor-pointer ${
            activeTab === "carts"
              ? "border-[var(--accent)] text-[var(--accent)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)] hover:border-[var(--line)]"
          }`}
        >
          Retailer Carts ({activeStrategy?.carts.length ?? 0})
        </button>
        <button
          onClick={() => setActiveTab("shipments")}
          className={`py-2 px-3 border-b-2 transition-all duration-150 active:scale-[0.98] cursor-pointer ${
            activeTab === "shipments"
              ? "border-[var(--accent)] text-[var(--accent)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)] hover:border-[var(--line)]"
          }`}
        >
          Split Shipments ({activeStrategy?.shipmentCount ?? 0})
        </button>
        <button
          onClick={() => setActiveTab("items")}
          className={`py-2 px-3 border-b-2 transition-all duration-150 active:scale-[0.98] cursor-pointer ${
            activeTab === "items"
              ? "border-[var(--accent)] text-[var(--accent)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)] hover:border-[var(--line)]"
          }`}
        >
          Buyer Line Items ({lineItems.length})
        </button>
      </div>

      {/* Tab 1: Strategies Comparison */}
      {activeTab === "strategies" && (
        <div className="pt-4 space-y-4 animate-fade-in-up duration-250">
          {!plan || plan.strategies.length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--ink-muted)] bg-[var(--surface-raised)] rounded-md border border-[var(--line)]">
              No plan evaluated yet. Click <strong>Evaluate Multi-Item Plan</strong> to discover candidates, group retailer carts, and compare strategies.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {plan.strategies.map((strategy) => {
                const isSelected = strategy.strategyId === selectedStrategyId;
                const preTaxCents =
                  strategy.totalMerchandiseCents +
                  (strategy.totalShippingCents ?? 0) -
                  (strategy.totalDiscountCents || 0);
                const costBreakdown = strategy.costBreakdown;
                const isTaxDefensible = costBreakdown?.isTaxDefensible ?? false;
                const taxCents = costBreakdown?.taxCents ?? null;
                const isTaxStatutoryZero = isTaxDefensible && taxCents === 0;
                const hasMissingTax =
                  costBreakdown?.missingComponents?.includes("tax") ?? !strategy.isLandedCostDefensible;
                const hasMissingShipping = strategy.totalShippingCents === null;

                return (
                  <div
                    key={strategy.strategyId}
                    onClick={() => setSelectedStrategyId(strategy.strategyId)}
                    className={`p-4 rounded-lg border cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-xs active:scale-[0.99] ${
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--surface)] ring-1 ring-[var(--accent)] shadow-xs"
                        : "border-[var(--line)] bg-[var(--surface-raised)] hover:border-[var(--control-border)] hover:bg-[var(--surface)]"
                    }`}
                  >
                    <div className="flex items-center justify-between pb-2 border-b border-[var(--line)]">
                      <span className="font-semibold text-xs text-[var(--ink)]">{strategy.name}</span>
                      <StatusChip
                        variant={
                          strategy.feasibility === "feasible"
                            ? "pass"
                            : strategy.feasibility === "uncertain"
                            ? "caution"
                            : "block"
                        }
                        label={strategy.feasibility.toUpperCase()}
                      />
                    </div>

                    <p className="text-xs text-[var(--ink-muted)] my-2 min-h-[32px] line-clamp-2">
                      {strategy.description}
                    </p>

                    <div className="space-y-1.5 text-xs pt-2 border-t border-[var(--line)] font-mono">
                      <div className="flex justify-between">
                        <span className="text-[var(--ink-muted)]">Merchandise:</span>
                        <span className="text-[var(--ink)] font-semibold">
                          ${(strategy.totalMerchandiseCents / 100).toFixed(2)} USD
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--ink-muted)]">Shipping:</span>
                        <span className={strategy.totalShippingCents === null ? "text-[var(--color-caution)] font-bold" : "text-[var(--ink)]"}>
                          {strategy.totalShippingCents !== null ? (
                            <>
                              ${(strategy.totalShippingCents / 100).toFixed(2)} USD
                              {strategy.shippingEvidenceType === "policy_derived" && (
                                <span className="ml-1 text-[10px] text-[var(--accent)] font-normal">(Policy-Derived)</span>
                              )}
                            </>
                          ) : (
                            "UNQUOTED"
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between font-semibold pt-1 border-t border-[var(--line)]">
                        <span className="text-[var(--ink)]">Pre-Tax Landed Subtotal:</span>
                        <span className="text-[var(--ink)]">
                          {hasMissingShipping
                            ? "Pending Shipping Quote"
                            : `$${(preTaxCents / 100).toFixed(2)} USD`}
                        </span>
                      </div>
                      <div className="flex justify-between pt-0.5">
                        <span className="text-[var(--ink-muted)]">Destination Sales Tax:</span>
                        <span className={isTaxStatutoryZero ? "text-[var(--accent)] font-medium" : isTaxDefensible && taxCents !== null ? "text-[var(--ink)] font-medium" : "text-[var(--color-caution)] font-medium"}>
                          {isTaxStatutoryZero ? (
                            "✓ $0.00 USD (Statutory Sales-Tax-Free)"
                          ) : isTaxDefensible && taxCents !== null ? (
                            `✓ $${(taxCents / 100).toFixed(2)} USD (Authoritative Quote)`
                          ) : (
                            "⚠️ Unquoted (Pending Checkout)"
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between font-bold pt-1.5 border-t border-[var(--line-strong)]">
                        <span className="text-[var(--ink)]">Total Landed Cost:</span>
                        <span className={strategy.totalLandedCostCents !== null ? "text-[var(--accent)] text-sm" : "text-[var(--color-caution)] text-xs"}>
                          {strategy.totalLandedCostCents !== null
                            ? `$${(strategy.totalLandedCostCents / 100).toFixed(2)} USD`
                            : `Pre-Tax: $${(preTaxCents / 100).toFixed(2)} USD (Pending Tax)`}
                        </span>
                      </div>
                    </div>

                    {!strategy.isLandedCostDefensible && (
                      <div className="mt-2 text-[10px] text-[var(--ink-muted)] bg-[var(--surface-sunken)] p-2 rounded border border-[var(--line)] space-y-1">
                        <div className="font-semibold text-[var(--ink)] flex items-center gap-1">
                          <span>🔒 Purchase Assurance Fail-Closed Rule</span>
                        </div>
                        <div>
                          {hasMissingTax
                            ? "Sales tax is strictly not guessed or estimated. Total landed cost cannot be finalized until merchant checkout binds an authoritative tax quote."
                            : "Shipping charge is unquoted; landed cost cannot be defended."}
                        </div>
                        <div className="text-[var(--accent)] font-medium">
                          💡 Tip: Change Ship to ZIP above to Oregon <strong>97201</strong> (or NH <strong>03101</strong> / DE <strong>19801</strong>) to test 100% complete defensible landed cost ($0.00 statutory sales tax).
                        </div>
                      </div>
                    )}

                    <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
                      <span>{strategy.retailerCount} Retailer Cart(s)</span>
                      <span>{strategy.shipmentCount} Shipment(s)</span>
                      <span className={strategy.allocations.length === lineItems.length ? "text-[var(--accent)] font-medium" : "text-[var(--color-caution)] font-bold"}>
                        {strategy.allocations.length === lineItems.length
                          ? `✓ All ${lineItems.length} Items Covered`
                          : `⚠️ ${strategy.allocations.length}/${lineItems.length} Items Covered`}
                      </span>
                    </div>

                    {/* Line-item fulfillment breakdown */}
                    <div className="mt-2 text-[10px] bg-[var(--surface-sunken)] p-2 rounded border border-[var(--line)] space-y-1">
                      <div className="font-semibold text-xs text-[var(--ink)] mb-1">
                        Item Allocation Coverage ({strategy.allocations.length}/{lineItems.length}):
                      </div>
                      {lineItems.map((li) => {
                        const alloc = strategy.allocations.find((a) => a.lineItemId === li.id);
                        return (
                          <div key={li.id} className="flex items-center justify-between py-1 px-1 rounded hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)] transition-colors duration-150 border-b border-[var(--line)] last:border-0 font-mono">
                            <span className="truncate max-w-[170px] text-[var(--ink)] flex items-center gap-1">
                              {alloc ? (
                                <span className="text-[var(--accent)] font-bold">✓</span>
                              ) : (
                                <span className="text-[var(--color-caution)] font-bold">✗</span>
                              )}
                              <span title={li.title}>{li.title}</span>
                            </span>
                            <span className="text-[var(--ink-muted)] shrink-0 ml-1">
                              {alloc ? (
                                <>
                                  <span className="font-semibold text-[var(--ink)]">{alloc.merchantName}</span>
                                  <span className="ml-1">(${(alloc.unitPriceCents / 100).toFixed(2)})</span>
                                </>
                              ) : (
                                <span className="text-[var(--color-caution)] font-semibold">UNALLOCATED</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {strategy.riskDisclosures.length > 0 && (
                      <div className="mt-2 text-[10px] text-[var(--color-caution)] bg-[var(--surface-sunken)] p-1.5 rounded">
                        ⚠️ {strategy.riskDisclosures[0]}
                      </div>
                    )}

                    <div className="mt-4">
                      <Button
                        variant={isSelected ? "primary" : "secondary"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedStrategyId(strategy.strategyId);
                          handleApproveStrategy(strategy);
                        }}
                        loading={approving && isSelected}
                        disabled={!strategy.isLandedCostDefensible || strategy.feasibility !== "feasible"}
                        className="w-full text-xs py-1"
                      >
                        {strategy.feasibility === "feasible" && strategy.isLandedCostDefensible
                          ? "Approve & Open Multi-Cart Checkout Gate"
                          : hasMissingTax
                          ? `Tax Quote Required for Checkout (Pre-Tax: $${(preTaxCents / 100).toFixed(2)})`
                          : "Incomplete Shipping / Evidence"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Retailer Carts */}
      {activeTab === "carts" && (
        <div className="pt-4 space-y-4 animate-fade-in-up duration-250">
          {!activeStrategy || activeStrategy.carts.length === 0 ? (
            <div className="text-xs text-[var(--ink-muted)] text-center py-4">No cart data available.</div>
          ) : (
            activeStrategy.carts.map((cart: RetailerCart) => (
              <div key={cart.merchantDomain} className="p-4 rounded border border-[var(--line)] bg-[var(--surface-raised)]">
                <div className="flex items-center justify-between border-b border-[var(--line)] pb-2 mb-3">
                  <div>
                    <span className="font-semibold text-sm text-[var(--ink)]">{cart.merchantName}</span>
                    <span className="ml-2 font-mono text-xs text-[var(--ink-muted)]">({cart.merchantDomain})</span>
                  </div>
                  <div className="text-right">
                    <span className="font-mono font-bold text-xs text-[var(--ink)]">
                      ${(cart.merchandiseSubtotalCents / 100).toFixed(2)} USD
                    </span>
                  </div>
                </div>

                {cart.thresholdEvaluation && (
                  <div className="mb-3 p-2.5 rounded bg-[var(--surface)] border border-[var(--line)] text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-[var(--ink)]">Free Shipping Policy Evaluation:</span>
                      <StatusChip
                        variant={cart.thresholdEvaluation.thresholdSatisfied ? "pass" : "caution"}
                        label={cart.thresholdEvaluation.thresholdSatisfied ? "QUALIFIED" : "THRESHOLD NOT MET"}
                      />
                    </div>
                    <p className="text-[var(--ink-muted)] text-[11px] mb-1">
                      {cart.thresholdEvaluation.explanation}
                    </p>
                    <div className="w-full bg-[var(--line)] h-1.5 rounded-full overflow-hidden mt-1.5">
                      <div
                        className="bg-[var(--accent)] h-full transition-all"
                        style={{
                          width: `${Math.min(
                            100,
                            (cart.thresholdEvaluation.qualifyingMerchandiseSubtotalCents /
                              Math.max(1, cart.thresholdEvaluation.thresholdCents)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-[var(--ink-muted)] uppercase tracking-wider">
                    Cart Items ({cart.items.length}):
                  </span>
                  {cart.items.map((item) => (
                    <div
                      key={item.candidateId}
                      className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded bg-[var(--surface)] border border-[var(--line)] hover:border-[var(--control-border)] hover:bg-[var(--surface-raised)] transition-all duration-150"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[var(--ink)]">{item.title}</span>
                        {item.isMarketplace ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-raised)] border border-[var(--line)] text-[var(--ink-muted)]">
                            Marketplace ({item.sellerName})
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-tint)] text-[var(--accent)]">
                            Direct Retailer
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[var(--ink)]">
                        {item.quantity} × ${(item.unitPriceCents / 100).toFixed(2)} = ${(item.lineItemTotalCents / 100).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 3: Split Shipments */}
      {activeTab === "shipments" && (
        <div className="pt-4 space-y-3 animate-fade-in-up duration-250">
          {!activeStrategy || activeStrategy.shipmentCount === 0 ? (
            <div className="text-xs text-[var(--ink-muted)] text-center py-4">No shipments planned.</div>
          ) : (
            activeStrategy.carts.flatMap((c) => c.shipments).map((ship: PlannedShipment) => (
              <div key={ship.shipmentId} className="p-3.5 rounded border border-[var(--line)] bg-[var(--surface-raised)] text-xs">
                <div className="flex items-center justify-between border-b border-[var(--line)] pb-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-[var(--ink)]">{ship.shipmentId}</span>
                    <span className="text-[var(--ink-muted)]">via {ship.merchantDomain}</span>
                  </div>
                  <StatusChip
                    variant={
                      ship.shippingEvidenceType === "quoted"
                        ? "pass"
                        : ship.shippingEvidenceType === "policy_derived"
                        ? "info"
                        : "caution"
                    }
                    label={
                      ship.shippingEvidenceType === "quoted"
                        ? "RETAILER QUOTED"
                        : ship.shippingEvidenceType === "policy_derived"
                        ? "POLICY-DERIVED"
                        : "UNQUOTED"
                    }
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-[var(--ink-muted)] mb-2 font-mono">
                  <div>
                    <span>Seller: </span>
                    <span className="text-[var(--ink)]">{ship.sellerName}</span>
                  </div>
                  <div>
                    <span>Fulfillment: </span>
                    <span className="text-[var(--ink)]">{ship.fulfillmentMethod}</span>
                  </div>
                  <div>
                    <span>Shipping: </span>
                    <span className="text-[var(--ink)] font-bold">
                      {ship.shippingChargeCents !== null
                        ? ship.shippingEvidenceType === "policy_derived"
                          ? `$${(ship.shippingChargeCents / 100).toFixed(2)} (Policy Threshold)`
                          : `$${(ship.shippingChargeCents / 100).toFixed(2)} (Quoted)`
                        : "Unquoted"}
                    </span>
                  </div>
                  <div>
                    <span>Delivery Date: </span>
                    <span className="text-[var(--ink)]">{ship.deliveryDate ?? "Unverified Carrier"}</span>
                  </div>
                </div>

                <p className="text-[11px] text-[var(--ink-muted)] bg-[var(--surface)] p-2 rounded border border-[var(--line)]">
                  ℹ️ {ship.explanation}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 4: Buyer Line Items */}
      {activeTab === "items" && (
        <div className="pt-4 space-y-3 animate-fade-in-up duration-250">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-semibold text-[var(--ink)]">
              Procurement Line Items ({lineItems.length})
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setLineItems([
                  ...lineItems,
                  {
                    id: `line_${lineItems.length + 1}`,
                    title: "New Item",
                    quantity: 1,
                    budgetCents: 5000,
                    currency: "USD",
                    requirements: [],
                    verificationLevel: "standard",
                  },
                ])
              }
              className="text-xs py-1 px-2.5"
            >
              + Add Item
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border border-[var(--line)]">
              <thead className="bg-[var(--surface-raised)] text-[var(--ink-muted)] border-b border-[var(--line)]">
                <tr>
                  <th className="p-2">ID</th>
                  <th className="p-2">Title / Description</th>
                  <th className="p-2 w-20">Quantity</th>
                  <th className="p-2 w-28">Budget (USD)</th>
                  <th className="p-2">Required Specs</th>
                  <th className="p-2">Verification</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {lineItems.map((item, idx) => (
                  <tr key={item.id} className="bg-[var(--surface)] hover:bg-[color-mix(in_srgb,var(--ink)_2.5%,var(--surface))] transition-colors duration-150">
                    <td className="p-2 font-mono text-[var(--ink)]">
                      <div>{item.id}</div>
                      {isJudgeFixtureActive && (
                        <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-[var(--surface-raised)] text-[var(--ink-muted)] border border-[var(--line)]">
                          Synthetic
                        </span>
                      )}
                    </td>
                    <td className="p-2 font-medium text-[var(--ink)]">
                      <input
                        type="text"
                        value={item.title}
                        onChange={(e) => {
                          const updated = [...lineItems];
                          updated[idx] = { ...item, title: e.target.value };
                          setLineItems(updated);
                          if (purchase.status === "APPROVED") setItemsModifiedAfterApproval(true);
                        }}
                        className="w-full px-2 py-1 text-xs border border-[var(--line)] rounded bg-[var(--surface-raised)] text-[var(--ink)] hover:border-[var(--control-border)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] transition-colors duration-150"
                      />
                    </td>
                    <td className="p-2 font-mono text-[var(--ink)]">
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={item.quantity}
                        onChange={(e) => {
                          const updated = [...lineItems];
                          updated[idx] = {
                            ...item,
                            quantity: parseInt(e.target.value, 10) || 1,
                          };
                          setLineItems(updated);
                          if (purchase.status === "APPROVED") setItemsModifiedAfterApproval(true);
                        }}
                        className="w-16 px-2 py-1 text-xs border border-[var(--line)] rounded bg-[var(--surface-raised)] text-[var(--ink)]"
                      />
                    </td>
                    <td className="p-2 font-mono text-[var(--ink)]">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={item.budgetCents ? (item.budgetCents / 100).toFixed(2) : "0.00"}
                        onChange={(e) => {
                          const updated = [...lineItems];
                          updated[idx] = {
                            ...item,
                            budgetCents: Math.round((parseFloat(e.target.value) || 0) * 100),
                          };
                          setLineItems(updated);
                          if (purchase.status === "APPROVED") setItemsModifiedAfterApproval(true);
                        }}
                        className="w-24 px-2 py-1 text-xs border border-[var(--line)] rounded bg-[var(--surface-raised)] text-[var(--ink)]"
                      />
                    </td>
                    <td className="p-2 text-[var(--ink-muted)]">
                      {item.requirements
                        .map((r) => (typeof r === "string" ? r : `${r.key}: ${r.expectedValue || "any"}`))
                        .join(", ") || "None"}
                    </td>
                    <td className="p-2">
                      <span className="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] border border-[var(--line)] text-[10px]">
                        {item.verificationLevel ?? "standard"}
                      </span>
                    </td>
                    <td className="p-2 text-right">
                      {lineItems.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            setLineItems(lineItems.filter((_, i) => i !== idx));
                          }}
                          className="text-xs text-red-600 hover:text-red-700 font-medium"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
