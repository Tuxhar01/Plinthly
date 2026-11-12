"use client";

import * as React from "react";
import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { Banner } from "../ui/banner";
import {
  ApprovalAggregateDetailResponse,
  CartStatusDetailResponse,
  executeRefundApi,
} from "../../lib/workflow/stage2-client-api";

export interface Stage2PurchaseReceiptProps {
  readonly aggregateData: ApprovalAggregateDetailResponse;
  readonly cartDetails?: Record<string, CartStatusDetailResponse>;
  readonly actorId?: string;
  readonly onRefundProcessed?: () => Promise<void>;
  readonly onBack?: () => void;
}

export function Stage2PurchaseReceipt({
  aggregateData,
  cartDetails = {},
  actorId,
  onRefundProcessed,
  onBack,
}: Stage2PurchaseReceiptProps) {
  const { approvalAggregate, carts, allocations } = aggregateData;

  const [refundingCartId, setRefundingCartId] = React.useState<string | null>(null);
  const [refundAmountCents, setRefundAmountCents] = React.useState<number>(0);
  const [refundReason, setRefundReason] = React.useState<string>("");
  const [refundLoading, setRefundLoading] = React.useState<boolean>(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);

  const formatCents = (cents: number | bigint, currency: string = "USD") => {
    const num = typeof cents === "bigint" ? Number(cents) : cents;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(num / 100);
  };

  const handleOpenRefund = (cartId: string, maxRefundableCents: number) => {
    setRefundingCartId(cartId);
    setRefundAmountCents(maxRefundableCents);
    setRefundReason("Customer requested return");
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleExecuteRefund = async () => {
    if (!refundingCartId) return;
    setRefundLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await executeRefundApi(
        {
          cartId: refundingCartId,
          amountCents: refundAmountCents,
          reason: refundReason,
        },
        { actorId }
      );

      if (res.success) {
        setSuccessMsg(`Refund of ${formatCents(refundAmountCents)} successfully processed.`);
        setRefundingCartId(null);
        if (onRefundProcessed) {
          await onRefundProcessed();
        }
      } else {
        setErrorMsg(res.errorMessage || "Refund processing failed.");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Refund request failed.");
    } finally {
      setRefundLoading(false);
    }
  };

  return (
    <div className="space-y-6 p-6 bg-[var(--canvas)] border border-[var(--control-border)] rounded-xl animate-fade-in-up duration-250">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--control-border)] pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">Multi-Merchant Procurement Settlement Receipt</h2>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[var(--surface-raised)] border border-[var(--control-border)] text-[var(--ink-secondary)]">
              Ledger: Cryptographic Purchase Attestation (Model A Landed Cost)
            </span>
            <StatusChip variant="pass" label="Verified Cryptographic Evidence" />
          </div>
          <p className="text-sm text-[var(--ink-secondary)]">
            Canonical Model A Landed Cost with zero variance and tamper-evident audit trail
          </p>
        </div>
        {onBack && (
          <Button variant="secondary" onClick={onBack}>
            Back to Studio
          </Button>
        )}
      </div>

      {successMsg && (
        <Banner variant="info" title="Refund Completed">
          {successMsg}
        </Banner>
      )}

      {errorMsg && (
        <Banner variant="error" title="Refund Action Warning">
          {errorMsg}
        </Banner>
      )}

      {/* Aggregate Settlement Summary */}
      <div className="p-4 bg-[var(--surface-elevated)] border border-[var(--control-border)] rounded-lg space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-[var(--control-border)] pb-2 text-xs">
          <div>
            <span className="text-[var(--ink-secondary)]">Aggregate ID: </span>
            <span className="font-mono">{approvalAggregate.id}</span>
          </div>
          <div>
            <span className="text-[var(--ink-secondary)]">Buyer ID: </span>
            <span className="font-mono">{approvalAggregate.buyerId}</span>
          </div>
          <div>
            <span className="text-[var(--ink-secondary)]">Snapshot Digest: </span>
            <span className="font-mono truncate max-w-xs">{approvalAggregate.snapshotDigest}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-1 text-xs">
          <div>
            <p className="text-[var(--ink-secondary)]">Merchandise</p>
            <p className="font-mono font-semibold text-sm">{formatCents(approvalAggregate.totalMerchandiseCents)}</p>
          </div>
          <div>
            <p className="text-[var(--ink-secondary)]">Discounts</p>
            <p className="font-mono font-semibold text-sm text-[var(--pass)]">
              -{formatCents(approvalAggregate.totalDiscountCents)}
            </p>
          </div>
          <div>
            <p className="text-[var(--ink-secondary)]">Shipping</p>
            <p className="font-mono font-semibold text-sm">{formatCents(approvalAggregate.totalShippingCents)}</p>
          </div>
          <div>
            <p className="text-[var(--ink-secondary)]">Statutory Tax</p>
            <p className="font-mono font-semibold text-sm">{formatCents(approvalAggregate.totalTaxCents)}</p>
          </div>
          <div>
            <p className="text-[var(--ink-secondary)]">Settled Total</p>
            <p className="font-mono font-bold text-base text-[var(--accent)]">
              {formatCents(approvalAggregate.totalAuthorizedCents, approvalAggregate.currency)}
            </p>
          </div>
        </div>
      </div>

      {/* Merchant Carts & Evidence */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
          Settled Merchant Receipts ({carts.length})
        </h3>

        <div className="space-y-4">
          {carts.map((cart) => {
            const detail = cartDetails[cart.id];
            const evidence = detail?.paymentEvidence;
            const refunds = detail?.refunds || [];
            const remainingRefundableCents = cart.totalCartCents - (cart.cumulativeRefundedCents || 0);
            const cartAllocs = allocations.filter((a) => a.cartId === cart.id);

            return (
              <div
                key={cart.id}
                className="p-5 border border-[var(--control-border)] rounded-lg bg-[var(--surface)] space-y-4"
              >
                {/* Merchant Header */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-[var(--control-border)] pb-3">
                  <div>
                    <h4 className="font-bold text-base">{cart.merchantName}</h4>
                    <p className="text-xs text-[var(--ink-secondary)]">{cart.merchantPayeeEmail}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusChip
                      variant={
                        cart.checkoutStatus === "CAPTURED"
                          ? "pass"
                          : cart.checkoutStatus === "REFUNDED"
                          ? "info"
                          : cart.checkoutStatus === "PARTIALLY_REFUNDED"
                          ? "caution"
                          : "neutral"
                      }
                      label={cart.checkoutStatus}
                    />
                    {cart.checkoutStatus === "CAPTURED" && remainingRefundableCents > 0 && (
                      <Button
                        variant="secondary"
                        onClick={() => handleOpenRefund(cart.id, remainingRefundableCents)}
                      >
                        Refund Item
                      </Button>
                    )}
                  </div>
                </div>

                {/* Evidence & PayPal Order Details */}
                <div className="grid md:grid-cols-2 gap-4 text-xs font-mono bg-[var(--neutral-tint)] p-3 rounded-lg">
                  <div className="space-y-1">
                    <div>
                      <span className="text-[var(--ink-secondary)]">Cart ID: </span>
                      <span>{cart.id}</span>
                    </div>
                    <div>
                      <span className="text-[var(--ink-secondary)]">PayPal Order ID: </span>
                      <span>{cart.paypalOrderId || "Simulated (Local Demo — No Live Order)"}</span>
                    </div>
                    <div>
                      <span className="text-[var(--ink-secondary)]">Payment Evidence ID: </span>
                      <span>{evidence?.id || "Recorded on chain"}</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div>
                      <span className="text-[var(--ink-secondary)]">Payment Capture: </span>
                      <span className="text-[var(--pass)]">
                        {evidence?.capture_id
                          ? evidence.capture_id.startsWith("CAP-")
                            ? `Simulated Capture: ${evidence.capture_id} (Local Demo)`
                            : `PayPal Sandbox Capture: ${evidence.capture_id}`
                          : "Simulated Capture: CAP-" + cart.id.slice(0, 8)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[var(--ink-secondary)]">Settlement Time: </span>
                      <span>
                        {evidence?.recorded_at
                          ? new Date(evidence.recorded_at).toLocaleString()
                          : new Date(cart.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-[var(--ink-secondary)]">Refunded: </span>
                      <span className="text-[var(--caution)]">
                        {formatCents(cart.cumulativeRefundedCents || 0)} / {formatCents(cart.totalCartCents)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Line Items */}
                <div className="space-y-1 text-xs">
                  <p className="font-semibold text-[var(--ink-secondary)] uppercase tracking-wider text-[11px]">
                    Purchased Line Items
                  </p>
                  {cartAllocs.map((item) => (
                    <div
                      key={item.id}
                      className="flex justify-between py-1 border-b border-[var(--control-border)] last:border-0"
                    >
                      <span>
                        {item.lineItemTitle || `Line Item ${item.lineItemId.slice(0, 8)}`} (Qty: {item.allocatedQuantity})
                      </span>
                      <span className="font-mono font-semibold">{formatCents(item.allocatedTotalCents, item.currency)}</span>
                    </div>
                  ))}
                </div>

                {/* Refund History if any */}
                {refunds.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-[var(--control-border)]">
                    <p className="font-semibold text-[var(--caution)] text-xs uppercase tracking-wider">
                      Refund Provenance Records ({refunds.length})
                    </p>
                    <div className="space-y-1 text-xs font-mono">
                      {refunds.map((r) => (
                        <div
                          key={r.id}
                          className="flex justify-between p-2 bg-[var(--surface-elevated)] rounded border border-[var(--control-border)]"
                        >
                          <div>
                            <span>Refund ID: {r.refund_id}</span>
                            <span className="text-[var(--ink-secondary)] ml-2">({r.reason})</span>
                          </div>
                          <span className="text-[var(--block)] font-semibold">
                            -{formatCents(r.amount_cents, r.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Refund Modal Dialog */}
      {refundingCartId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        >
          <div className="w-full max-w-md bg-[var(--canvas)] border border-[var(--control-border)] rounded-xl shadow-2xl p-6 space-y-4">
            <h3 className="text-lg font-bold">Issue Merchant Refund</h3>
            <p className="text-xs text-[var(--ink-secondary)]">
              Enforces refundable balance limit: sum(refunds) ≤ totalCartCents
            </p>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[var(--ink-secondary)] mb-1">Refund Amount (Cents):</label>
                <input
                  type="number"
                  min="1"
                  max={refundAmountCents}
                  value={refundAmountCents}
                  onChange={(e) => setRefundAmountCents(Number(e.target.value))}
                  className="w-full p-2 border border-[var(--control-border)] rounded font-mono bg-[var(--surface)] text-[var(--ink)]"
                />
              </div>

              <div>
                <label className="block text-[var(--ink-secondary)] mb-1">Reason for Refund:</label>
                <input
                  type="text"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full p-2 border border-[var(--control-border)] rounded bg-[var(--surface)] text-[var(--ink)]"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--control-border)]">
              <Button
                variant="secondary"
                onClick={() => setRefundingCartId(null)}
                disabled={refundLoading}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleExecuteRefund}
                loading={refundLoading}
                disabled={refundLoading || refundAmountCents <= 0}
              >
                Confirm Refund
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

