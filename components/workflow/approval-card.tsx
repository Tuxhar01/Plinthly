"use client";

import * as React from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Banner } from "../ui/banner";
import { StatusChip } from "../ui/status-chip";
import { approvePurchaseApi } from "../../lib/workflow/client-api";
import { PurchaseResponse, ApprovePurchaseResponse } from "../../lib/workflow/types";

export interface ApprovalCardProps {
  purchase: PurchaseResponse;
  actorId: string;
  onRefreshRequested: () => void;
  loading?: boolean;
}

export function ApprovalCard({
  purchase,
  actorId,
  onRefreshRequested,
  loading: externalLoading,
}: ApprovalCardProps) {
  const [internalLoading, setInternalLoading] = React.useState<boolean>(false);
  const loading = externalLoading !== undefined ? externalLoading : internalLoading;
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [isStale, setIsStale] = React.useState<boolean>(false);
  const [approvalResult, setApprovalResult] = React.useState<ApprovePurchaseResponse | null>(null);

  const candidate = purchase.selectedCandidate;
  const activeApproval = purchase.activeApproval;

  const handleApprove = async () => {
    if (!candidate) {
      setServerError("No candidate selected for this purchase.");
      return;
    }

    setServerError(null);
    setIsStale(false);
    setInternalLoading(true);

    try {
      const result = await approvePurchaseApi(
        purchase.id,
        {
          expectedSnapshotHash: candidate.snapshotHash,
          expectedTotalCents: candidate.totalCents,
          expectedCurrency: candidate.currency,
          expectedVersion: purchase.version,
        },
        { actorId }
      );

      if (!result.ok) {
        if (result.status === 409 || result.error.code === "concurrency_conflict" || result.error.code === "approval_integrity_violation") {
          setIsStale(true);
          setServerError(
            `[${result.error.code}] ${result.error.message}. The terms or version changed. Re-evaluation required before approval.`
          );
        } else {
          setServerError(`[${result.error.code}] ${result.error.message}`);
        }
      } else {
        setApprovalResult(result.data);
        onRefreshRequested();
      }
    } finally {
      setInternalLoading(false);
    }
  };

  const isEligibleForApproval = purchase.status === "POLICY_PASSED" && Boolean(candidate);

  const handleRefreshTerms = () => {
    setServerError(null);
    setIsStale(false);
    onRefreshRequested();
  };

  return (
    <Card heading="3. Buyer Approval & Terms Lock" className="mb-6">
      <p className="text-xs text-[var(--ink-muted)] mb-4">
        Review authoritative candidate snapshot and lock terms. Approval freezes the exact offer amount and candidate snapshot hash.
      </p>

      {/* Synthetic Demonstration Data Notice */}
      <div className="mb-4">
        <Banner variant="info" id="approval-synthetic-notice">
          <strong>Demonstration Notice:</strong> Approved terms lock against synthetic candidate snapshots for workflow evaluation; live merchant inventory is not verified.
        </Banner>
      </div>

      {serverError && (
        <div className="mb-4">
          <Banner variant="error">{serverError}</Banner>
        </div>
      )}

      {isStale && (
        <div className="mb-4">
          <Banner variant="info">
            <strong>Approval Stale:</strong> The server-side purchase version or terms changed. Click &quot;Refresh Terms&quot; to fetch the latest state.
          </Banner>
        </div>
      )}

      {/* Offer Terms Review */}
      {candidate ? (
        <div className="border border-[var(--line)] rounded-[var(--radius-control)] p-4 bg-[var(--surface-raised)] mb-4">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--line)]">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              Authoritative Candidate Terms
            </span>
            <StatusChip
              variant={activeApproval ? "pass" : "neutral"}
              label={activeApproval ? "APPROVED" : "PENDING APPROVAL"}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-[var(--ink-muted)]">Candidate Title: </span>
              <span className="font-medium text-[var(--ink)]">{candidate.title}</span>
            </div>
            <div>
              <span className="text-[var(--ink-muted)]">Merchant: </span>
              <span className="font-medium text-[var(--ink)]">{candidate.merchantName}</span>
            </div>
            <div>
              <span className="text-[var(--ink-muted)]">Unit Price: </span>
              <span className="font-medium text-[var(--ink)]">
                ${(candidate.unitPriceCents / 100).toFixed(2)} {candidate.currency}
              </span>
            </div>
            <div>
              <span className="text-[var(--ink-muted)]">Shipping: </span>
              <span className="font-medium text-[var(--ink)]">
                ${(candidate.shippingCents / 100).toFixed(2)} {candidate.currency}
              </span>
            </div>
            <div className="sm:col-span-2 pt-2 border-t border-[var(--line)] flex justify-between items-baseline">
              <span className="text-sm font-semibold text-[var(--ink)]">Locked Total Offer:</span>
              <span className="text-base font-bold text-[var(--ink)] font-mono">
                ${(candidate.totalCents / 100).toFixed(2)} {candidate.currency}
              </span>
            </div>
          </div>

          <div className="mt-3 pt-2 border-t border-[var(--line)] text-[11px] font-mono text-[var(--ink-muted)] space-y-1">
            <div className="truncate">Snapshot Hash: {candidate.snapshotHash}</div>
            <div className="truncate">Availability: {candidate.availability}</div>
          </div>
        </div>
      ) : (
        <div className="p-4 border border-[var(--line)] rounded-[var(--radius-control)] bg-[var(--surface-raised)] text-xs text-[var(--ink-muted)] mb-4">
          No candidate evaluated yet. Complete candidate evaluation in Step 2 to review terms and approve.
        </div>
      )}

      {/* Existing or New Approval Metadata */}
      {(activeApproval || approvalResult) && (
        <div className="p-3 border border-[var(--pass)] bg-[var(--pass-tint)] rounded-[var(--radius-control)] text-xs text-[var(--pass)] mb-4 flex flex-col gap-1">
          <div className="font-semibold">Purchase Successfully Approved</div>
          <div>Approval ID: {activeApproval?.id || approvalResult?.approvalId}</div>
          <div>Approver: {activeApproval?.approverUserId || approvalResult?.approverUserId}</div>
          <div>Approved At: {activeApproval?.approvedAt || approvalResult?.approvedAt}</div>
        </div>
      )}

      {/* Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <Button variant="secondary" onClick={handleRefreshTerms} loading={loading} disabled={loading} className="text-xs">
          Refresh Terms
        </Button>

        {isEligibleForApproval && (
          <Button
            variant="primary"
            onClick={handleApprove}
            loading={loading}
            disabled={loading || !candidate}
          >
            Approve Purchase Terms
          </Button>
        )}
      </div>
    </Card>
  );
}
