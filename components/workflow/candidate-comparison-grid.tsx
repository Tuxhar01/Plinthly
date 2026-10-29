"use client";

import * as React from "react";
import { AgGridReact } from "ag-grid-react";
import {
  ColDef,
  ModuleRegistry,
  AllCommunityModule,
  ICellRendererParams,
  RowSelectedEvent,
  themeQuartz,
} from "ag-grid-community";
import { CandidateSpecificationsSummary, NormalizedProductCandidate } from "../../lib/discovery/types";
import { StatusChip } from "../ui/status-chip";

// Register all community features once
ModuleRegistry.registerModules([AllCommunityModule]);

export interface CandidateGridRow {
  readonly id: string;
  readonly externalId: string;
  readonly title: string;
  readonly merchantName: string;
  readonly merchantUrl: string;
  readonly sellerName?: string;
  readonly isMarketplace?: boolean;
  readonly isDirectRetailer?: boolean;
  readonly fulfillmentMethod?: string;
  readonly unitPriceCents: number;
  readonly shippingCents: number | null;
  readonly shippingStatus: "quoted" | "missing" | "free_threshold" | "synthetic";
  readonly shippingType: "quoted" | "policy_derived" | "missing" | "synthetic";
  readonly shippingExplanation?: string;
  readonly destinationPostalCode?: string;
  readonly destinationCountry?: string;
  readonly policyId?: string;
  readonly policySourceUrl?: string;
  readonly totalCents: number | null;
  readonly currency: string;
  readonly isComplete: boolean;
  readonly source: string;
  readonly isSynthetic: boolean;
  readonly isDuplicate: boolean;
  readonly duplicateGroupKey: string;
  readonly duplicateReason?: string;
  readonly evidenceFreshness: string;
  readonly specificationsSummary?: CandidateSpecificationsSummary;
  readonly blockerReason?: string;
  readonly blockerAction?: string;
  readonly rawCandidate: NormalizedProductCandidate | Record<string, unknown>;
}

export interface CandidateComparisonGridProps {
  candidates: readonly (NormalizedProductCandidate | Record<string, unknown>)[];
  selectedCandidateExternalId?: string | null;
  onSelectCandidate: (candidate: NormalizedProductCandidate | Record<string, unknown>) => void;
  budgetCents?: number;
  currency?: string;
  destinationPostalCode?: string;
}

export function CandidateComparisonGrid({
  candidates,
  selectedCandidateExternalId,
  onSelectCandidate,
  budgetCents,
  currency = "USD",
  destinationPostalCode,
}: CandidateComparisonGridProps) {
  const [quickFilterText, setQuickFilterText] = React.useState<string>("");
  const [hideDuplicates, setHideDuplicates] = React.useState<boolean>(false);

  // Map incoming candidates to grid row model
  const rowData: CandidateGridRow[] = React.useMemo(() => {
    return candidates.map((cand, idx) => {
      const c = cand as Partial<NormalizedProductCandidate>;
      const externalId = String(c.externalId || `cand_${idx}`);
      const title = String(c.title || "Untitled Product");
      const merchantName = String(c.merchantName || "Unknown Merchant");
      const merchantUrl = String(c.merchantUrl || "");
      const unitPriceCents = typeof c.unitPriceCents === "number" ? c.unitPriceCents : 0;
      const isComplete = Boolean(c.isComplete);
      const isSynthetic = externalId.includes("verified") || externalId.includes("fixture");

      // Extract seller and marketplace provenance
      const sellerName = c.sellerName;
      const isMarketplace = c.isMarketplace;
      const isDirectRetailer = c.isDirectRetailer;
      const fulfillmentMethod = c.fulfillmentMethod;

      // Distinguish verified dynamic quote vs policy-derived threshold vs synthetic fixture vs missing
      const hasVerifiedShipping =
        (c.shippingDetails?.type === "quoted" || c.shippingDetails?.type === "policy_derived") &&
        Boolean(c.shippingDetails?.isAuthoritative) &&
        typeof c.shippingCents === "number" &&
        c.shippingCents >= 0 &&
        isComplete;

      let shippingStatus: CandidateGridRow["shippingStatus"] = "missing";
      let shippingType: CandidateGridRow["shippingType"] = "missing";

      if (isSynthetic) {
        shippingStatus = "synthetic";
        shippingType = "synthetic";
      } else if (hasVerifiedShipping) {
        if (c.shippingDetails?.type === "policy_derived") {
          shippingStatus = "free_threshold";
          shippingType = "policy_derived";
        } else {
          shippingStatus = "quoted";
          shippingType = "quoted";
        }
      }

      const shippingCents = hasVerifiedShipping && typeof c.shippingCents === "number" ? c.shippingCents : (isSynthetic && typeof c.shippingCents === "number" ? c.shippingCents : null);

      const shippingExplanation =
        c.shippingDetails?.explanation ||
        (hasVerifiedShipping
          ? "Authoritative shipping evidence attached"
          : isSynthetic
          ? "Synthetic demonstration fixture shipping"
          : "Missing from upstream catalog (shipping cannot be inferred as zero when absent)");

      const totalCents = shippingCents !== null ? unitPriceCents + shippingCents : null;

      const isDuplicate = Boolean(c.duplicateInfo?.isDuplicate);
      const duplicateGroupKey = c.duplicateInfo?.duplicateGroupKey || `grp_${idx}`;
      const duplicateReason = c.duplicateInfo?.duplicateReason;

      let evidenceFreshness = "Unverified observation";
      if (
        c.shippingDetails?.isAuthoritative &&
        c.shippingDetails?.type === "policy_derived" &&
        c.shippingDetails?.policyId
      ) {
        evidenceFreshness = `Policy: ${c.shippingDetails.policyId.replace(/^pol_/, "")}`;
      } else if (
        c.shippingDetails?.isAuthoritative &&
        c.shippingDetails?.type === "quoted" &&
        c.shippingDetails?.sourceVerificationTimestamp
      ) {
        evidenceFreshness = `Verified Quote: ${c.shippingDetails.sourceVerificationTimestamp.substring(0, 10)}`;
      } else if (c.capturedAt) {
        evidenceFreshness = `Observed: ${new Date(c.capturedAt).toISOString().substring(0, 10)}`;
      }

      // Blocker and resolution action
      let blockerReason = c.blockerReason;
      let blockerAction = c.blockerAction;

      if (!isComplete && !blockerReason) {
        if (!hasVerifiedShipping) {
          blockerReason = "Missing shipping rate from upstream catalog.";
          blockerAction = "Provide destination ZIP code to query carrier quote or evaluate merchant policy.";
        } else {
          blockerReason = c.validationErrors?.join("; ") || "Incomplete candidate specifications.";
          blockerAction = "Verify product specifications.";
        }
      } else if (budgetCents && totalCents !== null && totalCents > budgetCents) {
        blockerReason = `Landed cost ($${(totalCents / 100).toFixed(2)}) exceeds purchase budget ($${(budgetCents / 100).toFixed(2)}).`;
        blockerAction = "Increase purchase budget or select a lower-cost alternative.";
      }

      return {
        id: String(c.id || externalId),
        externalId,
        title,
        merchantName,
        merchantUrl,
        sellerName,
        isMarketplace,
        isDirectRetailer,
        fulfillmentMethod,
        unitPriceCents,
        shippingCents,
        shippingStatus,
        shippingType,
        shippingExplanation,
        destinationPostalCode: c.shippingDetails?.destinationPostalCode || destinationPostalCode,
        destinationCountry: c.shippingDetails?.destinationCountry || "US",
        policyId: c.shippingDetails?.policyId,
        policySourceUrl: c.shippingDetails?.policySourceUrl,
        totalCents,
        currency: c.currency || currency,
        isComplete,
        source: isSynthetic ? "Synthetic Demo Fixture" : "Channel3 Live Upstream",
        isSynthetic,
        isDuplicate,
        duplicateGroupKey,
        duplicateReason,
        evidenceFreshness,
        specificationsSummary: c.specificationsSummary,
        blockerReason,
        blockerAction,
        rawCandidate: cand,
      };
    });
  }, [candidates, currency, destinationPostalCode, budgetCents]);

  const displayRows = React.useMemo(() => {
    return hideDuplicates ? rowData.filter((r) => !r.isDuplicate) : rowData;
  }, [hideDuplicates, rowData]);

  // Selected row for drilldown inspector
  const activeSelectedRow = React.useMemo(() => {
    if (!selectedCandidateExternalId) return displayRows[0] || null;
    return displayRows.find((r) => r.externalId === selectedCandidateExternalId) || displayRows[0] || null;
  }, [displayRows, selectedCandidateExternalId]);

  // Summary counts
  const eligibleCount = rowData.filter((r) => r.isComplete && (!budgetCents || (r.totalCents !== null && r.totalCents <= budgetCents))).length;
  const blockedCount = rowData.length - eligibleCount;

  // Custom column definitions with enterprise audit renderers
  const columnDefs: ColDef<CandidateGridRow>[] = React.useMemo(() => {
    return [
      {
        headerName: "Candidate & Merchant",
        field: "title",
        flex: 2,
        minWidth: 260,
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const { title, merchantName, merchantUrl, sellerName, isMarketplace, isDirectRetailer, isSynthetic, isDuplicate, duplicateReason } = params.data;
          return (
            <div className="flex flex-col justify-center py-1 leading-snug">
              <span className="font-semibold text-xs truncate" title={title}>
                {title}
              </span>
              <div className="flex items-center gap-1.5 text-[11px] opacity-80 flex-wrap">
                <span className="font-medium text-[var(--ink-muted)]">{merchantName}</span>
                {sellerName && sellerName.toLowerCase() !== merchantName.toLowerCase() && (
                  <span className="text-[10px] text-[var(--ink-muted)] italic">
                    (Seller: {sellerName})
                  </span>
                )}
                {isMarketplace && (
                  <span className="inline-block text-[9px] uppercase px-1 py-0.2 bg-[var(--caution-tint)] text-[var(--caution)] rounded font-mono" title="Sold by third-party marketplace seller">
                    Marketplace
                  </span>
                )}
                {isDirectRetailer && (
                  <span className="inline-block text-[9px] uppercase px-1 py-0.2 bg-[var(--pass-tint)] text-[var(--pass)] rounded font-mono" title="Direct retailer inventory">
                    Direct
                  </span>
                )}
                {merchantUrl && (
                  <a
                    href={merchantUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent)] hover:underline inline-flex items-center text-[10px]"
                    onClick={(e) => e.stopPropagation()}
                    title="View canonical merchant product page"
                  >
                    ↗ Link
                  </a>
                )}
                {isSynthetic && (
                  <span className="inline-block text-[9px] uppercase px-1 py-0.2 bg-[var(--info-tint)] text-[var(--info)] rounded font-mono">
                    Fixture
                  </span>
                )}
                {isDuplicate && (
                  <span
                    className="inline-block text-[9px] uppercase px-1 py-0.2 bg-[var(--caution-tint)] text-[var(--caution)] rounded font-mono"
                    title={duplicateReason || "Duplicate offer of another candidate"}
                  >
                    Duplicate
                  </span>
                )}
              </div>
            </div>
          );
        },
      },
      {
        headerName: "Unit Price",
        field: "unitPriceCents",
        width: 110,
        sortable: true,
        // Currency-aware comparator: different currencies are grouped rather than falsely subtracted
        comparator: (valueA, valueB, nodeA, nodeB) => {
          const curA = nodeA?.data?.currency ?? "USD";
          const curB = nodeB?.data?.currency ?? "USD";
          if (curA !== curB) {
            return curA.localeCompare(curB);
          }
          return valueA - valueB;
        },
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const dollars = (params.data.unitPriceCents / 100).toFixed(2);
          return (
            <div className="font-mono text-xs font-semibold py-2">
              ${dollars} <span className="text-[10px] opacity-75">{params.data.currency}</span>
            </div>
          );
        },
      },
      {
        headerName: "Shipping Evidence",
        field: "shippingStatus",
        width: 170,
        sortable: true,
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const { shippingStatus, shippingCents, shippingExplanation, destinationPostalCode: destZip } = params.data;

          if (shippingStatus === "synthetic") {
            return (
              <div className="py-2" title={shippingExplanation}>
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[var(--info-tint)] text-[var(--info)] font-mono font-medium">
                  🧪 ${(shippingCents !== null ? (shippingCents / 100).toFixed(2) : "0.00")} (Demo)
                </span>
              </div>
            );
          }

          if (shippingStatus === "free_threshold" && shippingCents === 0) {
            return (
              <div className="py-2" title={shippingExplanation}>
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[var(--accent-tint,rgba(59,130,246,0.1))] text-[var(--accent)] font-mono font-medium">
                  ✓ Free (Policy)
                </span>
              </div>
            );
          }

          if (shippingStatus === "quoted" && shippingCents !== null) {
            return (
              <div className="py-2" title={shippingExplanation}>
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[var(--pass-tint)] text-[var(--pass)] font-mono">
                  ✓ ${(shippingCents / 100).toFixed(2)} {destZip ? `(${destZip})` : ""}
                </span>
              </div>
            );
          }

          return (
            <div className="py-2" title={shippingExplanation}>
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[var(--caution-tint)] text-[var(--caution)] font-medium">
                ⚠ Unknown (Missing)
              </span>
            </div>
          );
        },
      },
      {
        headerName: "Total Landed Cost",
        field: "totalCents",
        width: 160,
        sortable: true,
        // Honest comparison invariant: unknown landed cost must never be treated as cheaper than real totals.
        // Currency-aware comparator: different currencies are grouped rather than falsely compared as equivalent.
        comparator: (valueA, valueB, nodeA, nodeB) => {
          if (valueA === null && valueB === null) return 0;
          if (valueA === null) return 1; // null sorts after all numbers
          if (valueB === null) return -1;
          const curA = nodeA?.data?.currency ?? "USD";
          const curB = nodeB?.data?.currency ?? "USD";
          if (curA !== curB) {
            return curA.localeCompare(curB);
          }
          return valueA - valueB;
        },
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const { totalCents, currency: cur, isComplete } = params.data;
          if (isComplete && totalCents !== null) {
            const dollars = (totalCents / 100).toFixed(2);
            return (
              <div className="py-2 font-mono text-xs font-bold text-[var(--ink)]">
                ${dollars} <span className="text-[10px] font-normal">{cur}</span>
              </div>
            );
          }
          return (
            <div className="py-2" title="Total landed cost cannot be calculated without verified shipping">
              <span className="text-[11px] font-mono text-[var(--block)] italic">
                Unknown (Incomplete)
              </span>
            </div>
          );
        },
      },
      {
        headerName: "Specification Proof",
        width: 160,
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const summary = params.data.specificationsSummary;
          const missingCount = summary?.missing.length ?? 0;
          const inferredCount = summary ? Object.keys(summary.inferred).length : 0;
          const knownCount = summary ? Object.keys(summary.known).length : 0;

          if (missingCount > 0) {
            return (
              <div className="py-2" title={`Missing required specs: ${summary?.missing.join(", ")}`}>
                <span className="text-[10px] font-medium text-[var(--block)] bg-[var(--block-tint)] px-1.5 py-0.5 rounded">
                  ⚠ Missing ({missingCount})
                </span>
              </div>
            );
          }

          if (inferredCount > 0 && knownCount === 0) {
            return (
              <div className="py-2" title="Attributes were extracted by heuristic text matching; not verified facts">
                <span className="text-[10px] font-medium text-[var(--caution)] bg-[var(--caution-tint)] px-1.5 py-0.5 rounded">
                  ~ Inferred ({inferredCount})
                </span>
              </div>
            );
          }

          return (
            <div className="py-2" title={`${knownCount} verified structured specification(s)`}>
              <span className="text-[10px] font-medium text-[var(--pass)] bg-[var(--pass-tint)] px-1.5 py-0.5 rounded">
                ✓ {knownCount} Verified
              </span>
            </div>
          );
        },
      },
      {
        headerName: "Policy Verdict",
        field: "isComplete",
        width: 170,
        sortable: true,
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const { isComplete, totalCents, blockerReason } = params.data;
          const isOverBudget = budgetCents && totalCents !== null && totalCents > budgetCents;

          if (isComplete && !isOverBudget) {
            return (
              <div className="py-2">
                <StatusChip variant="pass" label="PASS (Eligible)" />
              </div>
            );
          }

          if (isOverBudget) {
            return (
              <div className="py-2" title={blockerReason}>
                <StatusChip variant="block" label="Over Budget" />
              </div>
            );
          }

          return (
            <div className="py-2" title={blockerReason || "Ineligible for approval"}>
              <StatusChip variant="caution" label="BLOCKED: Shipping" />
            </div>
          );
        },
      },
      {
        headerName: "Action",
        width: 150,
        pinned: "right",
        cellRenderer: (params: ICellRendererParams<CandidateGridRow>) => {
          if (!params.data) return null;
          const isSelected = params.data.externalId === selectedCandidateExternalId;
          return (
            <div className="py-1">
              <button
                type="button"
                id={`btn-select-candidate-${params.data.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectCandidate(params.data!.rawCandidate);
                }}
                className={`text-xs px-2.5 py-1 rounded font-medium transition-all ${
                  isSelected
                    ? "bg-[var(--accent)] text-white shadow-sm font-semibold"
                    : "bg-[var(--neutral-tint)] hover:bg-[var(--line)] text-[var(--ink)]"
                }`}
              >
                {isSelected ? "✓ Active Candidate" : "Select for Evaluation"}
              </button>
            </div>
          );
        },
      },
    ];
  }, [budgetCents, onSelectCandidate, selectedCandidateExternalId]);

  return (
    <div className="w-full flex flex-col gap-3 my-3">
      {/* Studio Header & Quick Filter */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-[var(--surface-raised)] border border-[var(--line)] rounded-[var(--radius-control)]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-[var(--ink)]">AG Grid Procurement Studio</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-[var(--line)] text-[var(--ink-muted)] rounded">
              v36.2 Community
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs">
            <span className="text-[var(--ink-muted)]">Found: {rowData.length}</span>
            <span className="text-[var(--pass)] font-medium">Eligible: {eligibleCount}</span>
            <span className="text-[var(--caution)] font-medium">Blocked: {blockedCount}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              id="grid-hide-duplicates"
              checked={hideDuplicates}
              onChange={(e) => setHideDuplicates(e.target.checked)}
              className="rounded border-[var(--line)] text-[var(--accent)]"
            />
            <span>Hide Duplicates</span>
          </label>

          <label htmlFor="grid-search-filter" className="sr-only">
            Filter Candidates
          </label>
          <input
            id="grid-search-filter"
            type="text"
            aria-label="Filter candidates by title or merchant"
            placeholder="Filter title or merchant..."
            value={quickFilterText}
            onChange={(e) => setQuickFilterText(e.target.value)}
            className="text-xs px-2.5 py-1 rounded border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>
      </div>

      {/* AG Grid Container */}
      <div
        role="region"
        aria-label="AG Grid Multi-Candidate Procurement Comparison Studio"
        className="w-full rounded-[var(--radius-control)] overflow-hidden border border-[var(--line)] shadow-sm"
        style={{ height: "340px", width: "100%" }}
      >
        <AgGridReact<CandidateGridRow>
          theme={themeQuartz.withParams({
            backgroundColor: "var(--surface)",
            foregroundColor: "var(--ink)",
            headerBackgroundColor: "var(--surface-raised)",
            borderColor: "var(--line)",
            accentColor: "var(--accent)",
          })}
          rowData={displayRows}
          columnDefs={columnDefs}
          quickFilterText={quickFilterText}
          rowSelection="single"
          headerHeight={38}
          rowHeight={46}
          pagination={true}
          paginationPageSize={5}
          paginationPageSizeSelector={[5, 10, 20]}
          onRowSelected={(event: RowSelectedEvent<CandidateGridRow>) => {
            if (event.node.isSelected() && event.data) {
              onSelectCandidate(event.data.rawCandidate);
            }
          }}
          defaultColDef={{
            resizable: true,
            sortable: true,
          }}
          overlayNoRowsTemplate="<div class='p-4 text-xs text-muted'>No product candidates discovered yet. Use search above or load the demo fixture.</div>"
        />
      </div>

      {/* Interactive Candidate Evidence & Blocker Inspector */}
      {activeSelectedRow && (
        <div className="p-3 bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-control)] text-xs flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] pb-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--ink)]">Evidence & Blocker Drilldown:</span>
              <span className="font-mono text-[var(--ink-muted)] text-[11px] truncate max-w-xs">{activeSelectedRow.title}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--ink-muted)]">Destination:</span>
              <span className="font-mono font-medium text-[var(--ink)]">{activeSelectedRow.destinationPostalCode || "None specified"} (US)</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Column 1: Landed Cost & Shipping Details */}
            <div className="flex flex-col gap-1 bg-[var(--surface-raised)] p-2 rounded border border-[var(--line)]">
              <span className="font-semibold text-[11px] text-[var(--ink-muted)] uppercase tracking-wider">Landed Cost Truth</span>
              <div className="flex justify-between items-center text-xs mt-0.5">
                <span>Product Price:</span>
                <span className="font-mono font-medium">${(activeSelectedRow.unitPriceCents / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span>Shipping:</span>
                <span className="font-mono font-medium">
                  {activeSelectedRow.shippingCents !== null ? `$${(activeSelectedRow.shippingCents / 100).toFixed(2)}` : "Unknown"}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs font-semibold pt-1 border-t border-[var(--line)]">
                <span>Total Landed Cost:</span>
                <span className="font-mono">
                  {activeSelectedRow.totalCents !== null ? `$${(activeSelectedRow.totalCents / 100).toFixed(2)}` : "Incomplete (Unknown)"}
                </span>
              </div>
              <span className="text-[10px] text-[var(--ink-muted)] mt-1 italic">
                {activeSelectedRow.shippingExplanation}
              </span>
            </div>

            {/* Column 2: Specification Proof & Provenance */}
            <div className="flex flex-col gap-1 bg-[var(--surface-raised)] p-2 rounded border border-[var(--line)]">
              <span className="font-semibold text-[11px] text-[var(--ink-muted)] uppercase tracking-wider">Specification Proof</span>
              {activeSelectedRow.specificationsSummary ? (
                <div className="flex flex-col gap-1 text-[11px] mt-0.5">
                  <div>
                    <span className="text-[var(--pass)] font-medium">Verified: </span>
                    {Object.keys(activeSelectedRow.specificationsSummary.known).length > 0 ? (
                      <span className="font-mono text-[10px]">
                        {Object.entries(activeSelectedRow.specificationsSummary.known).map(([k, v]) => `${k}=${v}`).join(", ")}
                      </span>
                    ) : (
                      <span className="italic text-[var(--ink-muted)]">none</span>
                    )}
                  </div>
                  {Object.keys(activeSelectedRow.specificationsSummary.inferred).length > 0 && (
                    <div>
                      <span className="text-[var(--caution)] font-medium">Inferred (Unverified): </span>
                      <span className="font-mono text-[10px]">
                        {Object.entries(activeSelectedRow.specificationsSummary.inferred).map(([k, v]) => `${k}=${v}`).join(", ")}
                      </span>
                    </div>
                  )}
                  {activeSelectedRow.specificationsSummary.missing.length > 0 && (
                    <div>
                      <span className="text-[var(--block)] font-medium">Missing: </span>
                      <span className="font-mono text-[10px] text-[var(--block)]">
                        {activeSelectedRow.specificationsSummary.missing.join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <span className="text-[11px] text-[var(--ink-muted)] mt-0.5 italic">No structured specification proof available.</span>
              )}
            </div>

            {/* Column 3: Blocker & Required Action */}
            <div className="flex flex-col gap-1 bg-[var(--surface-raised)] p-2 rounded border border-[var(--line)]">
              <span className="font-semibold text-[11px] text-[var(--ink-muted)] uppercase tracking-wider">Approval Blocker & Next Step</span>
              {activeSelectedRow.blockerReason ? (
                <div className="flex flex-col gap-1 mt-0.5">
                  <span className="text-[11px] text-[var(--block)] font-medium">
                    Issue: {activeSelectedRow.blockerReason}
                  </span>
                  {activeSelectedRow.blockerAction && (
                    <span className="text-[10px] text-[var(--ink)] bg-[var(--neutral-tint)] p-1 rounded font-medium">
                      Action Needed: {activeSelectedRow.blockerAction}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1 mt-0.5">
                  <span className="text-[var(--pass)] font-medium text-[11px]">✓ No blockers identified.</span>
                  <span className="text-[10px] text-[var(--ink-muted)]">Candidate snapshot and landed cost satisfy all required procurement invariants.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-[var(--ink-muted)] px-1">
        <span>Click any row or button to load the candidate into the deterministic evaluation engine below.</span>
        <span>Authoritative evidence strictly required for buyer approval.</span>
      </div>
    </div>
  );
}
