"use client";

import * as React from "react";
import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { Banner } from "../ui/banner";
import {
  ApprovalAggregateDetailResponse,
  ApprovedMerchantCartRecord,
  CartAllocationRecord,
} from "../../lib/workflow/stage2-client-api";

export interface Stage2ApprovalModalProps {
  readonly isOpen: boolean;
  readonly aggregateData: ApprovalAggregateDetailResponse;
  readonly onApprove: () => Promise<void>;
  readonly onClose: () => void;
  readonly loading?: boolean;
}

export function Stage2ApprovalModal({
  isOpen,
  aggregateData,
  onApprove,
  onClose,
  loading = false,
}: Stage2ApprovalModalProps) {
  const [error, setError] = React.useState<string | null>(null);

  if (!isOpen) return null;

  const { approvalAggregate, carts, allocations } = aggregateData;

  // Zero-variance validation
  const merchandise = BigInt(approvalAggregate.totalMerchandiseCents);
  const discount = BigInt(approvalAggregate.totalDiscountCents);
  const shipping = BigInt(approvalAggregate.totalShippingCents);
  const tax = BigInt(approvalAggregate.totalTaxCents);
  const authorized = BigInt(approvalAggregate.totalAuthorizedCents);

  const calculatedTotal = merchandise - discount + shipping + tax;
  const varianceCents = calculatedTotal - authorized;
  const isZeroVariance = varianceCents === BigInt(0);

  const formatCents = (cents: number | bigint, currency: string = "USD") => {
    const num = typeof cents === "bigint" ? Number(cents) : cents;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(num / 100);
  };

  const handleConfirm = async () => {
    if (!isZeroVariance) {
      setError(`Cannot approve: Landed-cost variance violation (${varianceCents.toString()} cents).`);
      return;
    }
    setError(null);
    try {
      await onApprove();
    } catch (err: any) {
      setError(err.message || "Failed to approve multi-cart procurement plan.");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto animate-fade-in duration-200"
    >
      <div
        className="w-full max-w-4xl bg-[var(--canvas)] border border-[var(--control-border)] rounded-xl shadow-2xl p-6 space-y-6 max-h-[90vh] overflow-y-auto animate-scale-in duration-250"
        style={{ backgroundColor: "var(--canvas)", color: "var(--ink)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--control-border)] pb-4">
          <div>
            <h2 id="approval-modal-title" className="text-xl font-bold tracking-tight">
              Multi-Retailer Procurement Approval
            </h2>
            <p className="text-sm text-[var(--ink-secondary)]">
              Model A Landed Cost zero-variance approval aggregate
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusChip
              variant={isZeroVariance ? "pass" : "block"}
              label={isZeroVariance ? "Zero Variance Verified" : `Variance: ${varianceCents.toString()}¢`}
            />
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="text-[var(--ink-secondary)] hover:text-[var(--ink)] text-lg px-2 py-1 rounded"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {error && (
          <Banner variant="error" title="Approval Error">
            {error}
          </Banner>
        )}

        {/* Cryptographic Digest & Snapshot Info */}
        <div className="p-3 bg-[var(--neutral-tint)] rounded-lg text-xs font-mono space-y-1">
          <div className="flex justify-between">
            <span className="text-[var(--ink-secondary)]">Aggregate ID:</span>
            <span>{approvalAggregate.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--ink-secondary)]">Snapshot Digest:</span>
            <span className="truncate max-w-md">{approvalAggregate.snapshotDigest}</span>
          </div>
        </div>

        {/* Merchant Carts Breakdown */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
            Approved Merchant Carts ({carts.length})
          </h3>

          <div className="grid gap-4 md:grid-cols-2">
            {carts.map((cart: ApprovedMerchantCartRecord) => {
              const cartAllocs = allocations.filter((a: CartAllocationRecord) => a.cartId === cart.id);
              const cartMerch = BigInt(cart.merchandiseSubtotalCents);
              const cartDisc = BigInt(cart.discountCents);
              const cartShip = BigInt(cart.shippingTotalCents);
              const cartTax = BigInt(cart.taxAmountCents);
              const cartTotal = BigInt(cart.totalCartCents);
              const cartVariance = cartMerch - cartDisc + cartShip + cartTax - cartTotal;

              return (
                <div
                  key={cart.id}
                  className="p-4 border border-[var(--control-border)] rounded-lg bg-[var(--surface)] space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-sm">{cart.merchantName}</h4>
                      <p className="text-xs text-[var(--ink-secondary)]">{cart.merchantPayeeEmail}</p>
                    </div>
                    <StatusChip
                      variant={cartVariance === BigInt(0) ? "pass" : "block"}
                      label={cartVariance === BigInt(0) ? "Exact Cents" : "Variance Error"}
                    />
                  </div>

                  {/* Items in cart */}
                  <div className="text-xs space-y-1 border-t border-[var(--control-border)] pt-2">
                    {cartAllocs.map((item: CartAllocationRecord) => (
                      <div key={item.id} className="flex justify-between text-[var(--ink)]">
                        <span>
                          {item.lineItemTitle || `Item ${item.lineItemId.slice(0, 8)}`} (×{item.allocatedQuantity})
                        </span>
                        <span className="font-mono">{formatCents(item.allocatedTotalCents, item.currency)}</span>
                      </div>
                    ))}
                  </div>

                  {/* Financial breakdown */}
                  <div className="text-xs space-y-0.5 border-t border-[var(--control-border)] pt-2 text-[var(--ink-secondary)]">
                    <div className="flex justify-between">
                      <span>Merchandise:</span>
                      <span className="font-mono text-[var(--ink)]">{formatCents(cart.merchandiseSubtotalCents)}</span>
                    </div>
                    {cart.discountCents > 0 && (
                      <div className="flex justify-between">
                        <span>Discount:</span>
                        <span className="font-mono text-[var(--pass)]">-{formatCents(cart.discountCents)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>Shipping:</span>
                      <span className="font-mono text-[var(--ink)]">{formatCents(cart.shippingTotalCents)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Statutory Tax:</span>
                      <span className="font-mono text-[var(--ink)]">{formatCents(cart.taxAmountCents)}</span>
                    </div>
                    <div className="flex justify-between font-bold text-sm text-[var(--ink)] pt-1 border-t border-[var(--control-border)]">
                      <span>Cart Total:</span>
                      <span className="font-mono">{formatCents(cart.totalCartCents)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Aggregate Financial Summary */}
        <div className="p-4 bg-[var(--surface-elevated)] border border-[var(--control-border)] rounded-lg space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
            Aggregate Financial Total (Model A)
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
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
              <p className="text-[var(--ink-secondary)]">Authorized Total</p>
              <p className="font-mono font-bold text-base text-[var(--accent)]">
                {formatCents(approvalAggregate.totalAuthorizedCents, approvalAggregate.currency)}
              </p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-[var(--control-border)]">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            loading={loading}
            disabled={!isZeroVariance || loading}
          >
            Approve & Proceed to Checkout
          </Button>
        </div>
      </div>
    </div>
  );
}

