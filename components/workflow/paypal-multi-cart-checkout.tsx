"use client";

import * as React from "react";
import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { Banner } from "../ui/banner";
import {
  captureCartApi,
  ApprovedMerchantCartRecord,
  SingleCaptureResult,
} from "../../lib/workflow/stage2-client-api";
import { MerchantCartStatus } from "../../lib/workflow/cart-state-machine";

export interface CartExecutionState {
  cart: ApprovedMerchantCartRecord;
  status: MerchantCartStatus | "AMBIGUOUS_TIMEOUT" | "PREPARED_AWAITING_WEBHOOK";
  captureId?: string;
  error?: string;
  idempotentRetry?: boolean;
}

export interface PayPalMultiCartCheckoutProps {
  readonly approvalAggregateId: string;
  readonly carts: ApprovedMerchantCartRecord[];
  readonly actorId?: string;
  readonly onCaptureComplete?: (results: SingleCaptureResult[]) => void;
  readonly onFinish?: () => void;
}

export function PayPalMultiCartCheckout({
  approvalAggregateId,
  carts,
  actorId,
  onCaptureComplete,
  onFinish,
}: PayPalMultiCartCheckoutProps) {
  const [cartStates, setCartStates] = React.useState<CartExecutionState[]>(() =>
    carts.map((cart) => ({
      cart,
      status: cart.checkoutStatus,
    }))
  );

  const [isProcessing, setIsProcessing] = React.useState(false);
  const [currentCartIndex, setCurrentCartIndex] = React.useState<number | null>(null);
  const [globalError, setGlobalError] = React.useState<string | null>(null);

  const completedCount = cartStates.filter((s) => s.status === "CAPTURED").length;
  const timeoutCount = cartStates.filter((s) => s.status === "AMBIGUOUS_TIMEOUT" || s.status === "CAPTURING").length;
  const failedCount = cartStates.filter((s) => s.status === "FAILED").length;
  const isAllComplete = completedCount + failedCount + timeoutCount === cartStates.length && isProcessing === false;

  const formatCents = (cents: number, currency: string = "USD") => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  };

  const getStatusVariant = (status: CartExecutionState["status"]) => {
    switch (status) {
      case "CAPTURED":
        return "pass";
      case "CAPTURING":
      case "PREPARED_AWAITING_WEBHOOK":
        return "caution";
      case "AMBIGUOUS_TIMEOUT":
        return "caution";
      case "FAILED":
        return "block";
      case "BUYER_APPROVED":
      default:
        return "neutral";
    }
  };

  const executeSequentialCapture = async () => {
    setIsProcessing(true);
    setGlobalError(null);
    const results: SingleCaptureResult[] = [];

    for (let i = 0; i < cartStates.length; i++) {
      const state = cartStates[i];
      if (state.status === "CAPTURED") {
        // Skip already captured carts
        continue;
      }

      setCurrentCartIndex(i);

      // Set in flight
      setCartStates((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "CAPTURING" };
        return next;
      });

      try {
        const res = await captureCartApi(
          {
            approvalAggregateId,
            cartId: state.cart.id,
          },
          { actorId }
        );

        const singleRes = res as SingleCaptureResult;
        results.push(singleRes);

        setCartStates((prev) => {
          const next = [...prev];
          const resolvedStatus: CartExecutionState["status"] =
            singleRes.status === "CAPTURED" || singleRes.outcome === "COMPLETED"
              ? "CAPTURED"
              : singleRes.outcome;
          next[i] = {
            ...next[i],
            status: resolvedStatus,
            captureId: singleRes.captureId,
            idempotentRetry: singleRes.idempotentRetry,
            error: singleRes.error,
          };
          return next;
        });
      } catch (err: any) {
        // Multi-merchant isolation: terminal failure of this cart does not crash execution loop
        const errMsg = err.message || "Capture error";
        results.push({
          cartId: state.cart.id,
          status: "FAILED",
          outcome: "FAILED",
          error: errMsg,
        });

        setCartStates((prev) => {
          const next = [...prev];
          next[i] = {
            ...next[i],
            status: "FAILED",
            error: errMsg,
          };
          return next;
        });
      }
    }

    setIsProcessing(false);
    setCurrentCartIndex(null);

    if (onCaptureComplete) {
      onCaptureComplete(results);
    }
  };

  return (
    <div className="space-y-6 p-6 bg-[var(--canvas)] border border-[var(--control-border)] rounded-xl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--control-border)] pb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight">PayPal Multi-Merchant Sequential Checkout</h2>
          <p className="text-sm text-[var(--ink-secondary)]">
            Sequential capture with multi-merchant failure isolation &amp; ambiguous timeout preservation
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[var(--surface-raised)] border border-[var(--control-border)] text-[var(--ink-secondary)]">
            Local Demo Mode (Simulated Payment — No External PayPal Call)
          </span>
          <StatusChip
            variant={completedCount === cartStates.length ? "pass" : "info"}
            label={`${completedCount}/${cartStates.length} Carts Captured`}
          />
        </div>
      </div>

      {globalError && (
        <Banner variant="error" title="Checkout Warning">
          {globalError}
        </Banner>
      )}

      {/* Progress Bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-[var(--ink-secondary)]">
          <span>Capture Progress</span>
          <span>{Math.round((completedCount / cartStates.length) * 100)}%</span>
        </div>
        <div className="w-full h-2 bg-[var(--neutral-tint)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--accent)] transition-all duration-300 ease-out"
            style={{ width: `${(completedCount / cartStates.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Carts List */}
      <div className="space-y-3">
        {cartStates.map((item, idx) => {
          const isCurrent = currentCartIndex === idx;
          return (
            <div
              key={item.cart.id}
              className={`p-4 border rounded-lg transition-all duration-200 ${
                isCurrent
                  ? "border-[var(--accent)] bg-[var(--surface-elevated)] ring-1 ring-[var(--accent)] shadow-xs animate-pulse-subtle"
                  : "border-[var(--control-border)] bg-[var(--surface)] hover:border-[var(--line)]"
              }`}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--neutral-tint)]">
                      Merchant #{idx + 1}
                    </span>
                    <h3 className="font-semibold text-sm">{item.cart.merchantName}</h3>
                  </div>
                  <p className="text-xs text-[var(--ink-secondary)]">{item.cart.merchantPayeeEmail}</p>
                  {item.captureId && (
                    <p className="text-xs font-mono text-[var(--pass)]">
                      {item.captureId.startsWith("CAP-")
                        ? `Simulated Capture: ${item.captureId} (Local Demo)`
                        : `PayPal Sandbox Capture: ${item.captureId}`}
                      {item.idempotentRetry && " (Idempotent Retry)"}
                    </p>
                  )}
                  {item.error && (
                    <p className="text-xs text-[var(--block)] font-mono">{item.error}</p>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xs text-[var(--ink-secondary)]">Landed Total</p>
                    <p className="font-mono font-bold text-sm">{formatCents(item.cart.totalCartCents)}</p>
                  </div>
                  <StatusChip variant={getStatusVariant(item.status)} label={item.status} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Execution Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-[var(--control-border)]">
        <div className="text-xs text-[var(--ink-secondary)]">
          {timeoutCount > 0 && "Notice: Timeouts are preserved in CAPTURING for background webhook reconciliation."}
        </div>
        <div className="flex items-center gap-3">
          {onFinish && (
            <Button variant="secondary" onClick={onFinish} disabled={isProcessing}>
              View Receipts
            </Button>
          )}
          <Button
            variant="primary"
            onClick={executeSequentialCapture}
            loading={isProcessing}
            disabled={isProcessing || completedCount === cartStates.length}
          >
            {completedCount === cartStates.length
              ? "All Carts Captured"
              : isProcessing
              ? "Capturing..."
              : "Execute Sequential Multi-Cart Capture"}
          </Button>
        </div>
      </div>
    </div>
  );
}
