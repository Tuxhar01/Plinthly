"use client";

import * as React from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Banner } from "../ui/banner";
import { StatusChip } from "../ui/status-chip";
import {
  createPayPalOrderApi,
  confirmBuyerApprovalApi,
  verifyPayPalPaymentApi,
  CreatePayPalOrderResponse,
} from "../../lib/workflow/client-api";
import { PurchaseResponse } from "../../lib/workflow/types";
import { PaymentVerificationResult } from "../../lib/paypal/verification";

export interface PayPalCardProps {
  purchase: PurchaseResponse;
  actorId: string;
  onRefreshRequested: () => void;
}

function getSafeSandboxApprovalUrl(urlStr: string | null | undefined): string | null {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "sandbox.paypal.com" || hostname === "www.sandbox.paypal.com") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export function PayPalCard({
  purchase,
  actorId,
  onRefreshRequested,
}: PayPalCardProps) {
  const [loadingOrder, setLoadingOrder] = React.useState<boolean>(false);
  const [loadingConfirm, setLoadingConfirm] = React.useState<boolean>(false);
  const [loadingVerify, setLoadingVerify] = React.useState<boolean>(false);

  const [orderError, setOrderError] = React.useState<string | null>(null);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);

  const [orderResult, setOrderResult] = React.useState<CreatePayPalOrderResponse | null>(null);
  const [verificationResult, setVerificationResult] = React.useState<PaymentVerificationResult | null>(null);

  const multiCarts = purchase.multiItemSnapshot?.carts ?? [];
  const [chosenMerchantDomain, setChosenMerchantDomain] = React.useState<string>("");
  const effectiveMerchantDomain = chosenMerchantDomain || multiCarts[0]?.merchantDomain || "";

  const liveAttempt = purchase.livePaymentAttempt;
  const isApproved = purchase.status === "APPROVED";
  const hasLiveAttempt = Boolean(liveAttempt && liveAttempt.paypalOrderId);

  const rawApprovalUrl =
    orderResult?.approvalUrl ||
    orderResult?.approveUrl ||
    verificationResult?.approvalUrl;
  const safeApprovalUrl = getSafeSandboxApprovalUrl(rawApprovalUrl);

  // 1. Create PayPal Order
  const handleCreateOrder = async () => {
    setOrderError(null);
    setLoadingOrder(true);
    try {
      const result = await createPayPalOrderApi(purchase.id, {
        actorId,
        idempotencyKey: `paypal_order_${purchase.id}_${purchase.version}_${effectiveMerchantDomain || "primary"}`,
        targetCartMerchantDomain: effectiveMerchantDomain || undefined,
      });
      if (!result.ok) {
        setOrderError(`[${result.error.code}] ${result.error.message}`);
      } else {
        setOrderResult(result.data);
        onRefreshRequested();
      }
    } finally {
      setLoadingOrder(false);
    }
  };

  // 2. Confirm Buyer Approval
  const handleConfirmApproval = async () => {
    setConfirmError(null);
    setLoadingConfirm(true);
    try {
      const result = await confirmBuyerApprovalApi(purchase.id, { actorId });
      if (!result.ok) {
        setConfirmError(`[${result.error.code}] ${result.error.message}`);
      } else {
        onRefreshRequested();
      }
    } finally {
      setLoadingConfirm(false);
    }
  };

  // 3. Independently Verify PayPal Status
  const handleVerify = async () => {
    setVerifyError(null);
    setLoadingVerify(true);
    try {
      const result = await verifyPayPalPaymentApi(purchase.id, { actorId });
      if (!result.ok) {
        setVerifyError(`[${result.error.code}] ${result.error.message}`);
      } else {
        setVerificationResult(result.data);
        onRefreshRequested();
      }
    } finally {
      setLoadingVerify(false);
    }
  };

  const getVerificationChip = (res: PaymentVerificationResult) => {
    switch (res.outcome) {
      case "BUYER_APPROVED":
        return <StatusChip variant="pass" label="VERIFIED: BUYER_APPROVED" />;
      case "PENDING_BUYER_ACTION":
        return <StatusChip variant="info" label="PENDING BUYER ACTION" />;
      case "REMOTELY_COMPLETED":
        return <StatusChip variant="caution" label="REMOTELY COMPLETED (UNCAPTURED)" />;
      case "VOIDED":
        return <StatusChip variant="block" label="VOIDED IN SANDBOX" />;
      case "MISMATCH_REJECTED":
        return <StatusChip variant="block" label="MISMATCH REJECTED" />;
      case "UNVERIFIED_TRANSIENT":
        return <StatusChip variant="caution" label="TRANSIENT TIMEOUT" />;
      case "UNVERIFIED_API_ERROR":
        return <StatusChip variant="block" label="API ERROR" />;
      case "REMOTE_NOT_FOUND":
        return <StatusChip variant="caution" label="REMOTE ORDER NOT FOUND (404)" />;
      default:
        return <StatusChip variant="neutral" label={res.outcome} />;
    }
  };

  return (
    <Card heading="4. PayPal Sandbox Order & Independent Verification" className="mb-6">
      <p className="text-xs text-[var(--ink-muted)] mb-4">
        Orchestrate PayPal Sandbox payment lifecycle. Independent verification retrieves authoritative state directly from PayPal Sandbox without capturing funds.
      </p>

      {/* Safety Invariant Notice */}
      <div className="mb-4">
        <Banner variant="info">
          <strong>Non-Capture Architecture:</strong> Order creation sets up an authorized payment agreement in PayPal Sandbox; it is <em>not</em> payment authorization or capture. Funds are never moved during order creation. Buyer authorization occurs separately in PayPal Sandbox, and fund capture is strictly deferred until verified fulfillment.
        </Banner>
      </div>

      {/* Step 4A: Order Creation */}
      <div className="p-4 border border-[var(--line)] rounded-[var(--radius-control)] bg-[var(--surface-raised)] mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[var(--ink)]">Step 4A: Sandbox Order Creation</span>
          <StatusChip
            variant={hasLiveAttempt ? "pass" : isApproved ? "info" : "neutral"}
            label={hasLiveAttempt ? "ORDER CREATED" : isApproved ? "READY TO CREATE" : "REQUIRES APPROVAL"}
          />
        </div>

        {orderError && (
          <div className="my-2">
            <Banner variant="error">{orderError}</Banner>
          </div>
        )}

        {multiCarts.length > 0 && !hasLiveAttempt && (
          <div className="my-3 p-3 rounded border border-[var(--line)] bg-[var(--surface)] text-xs">
            <div className="font-semibold text-[var(--ink)] mb-1 flex items-center justify-between">
              <span>Target Retailer Cart</span>
              <span className="text-[10px] text-[var(--ink-muted)]">Multi-Merchant Isolation Active</span>
            </div>
            <p className="text-[11px] text-[var(--ink-muted)] mb-2">
              Plinthly strictly enforces retailer transaction boundaries. Separate retailer carts require separate checkout authorizations. Funds are never pooled across merchants.
            </p>
            {multiCarts.length > 1 ? (
              <div className="space-y-1.5 mt-2">
                {multiCarts.map((cart) => {
                  const cartTotal = (cart.merchandiseSubtotalCents + cart.shippingCents) / 100;
                  return (
                    <label
                      key={cart.merchantDomain}
                      className={`flex items-center justify-between p-2 rounded border cursor-pointer ${
                        effectiveMerchantDomain === cart.merchantDomain
                          ? "border-[var(--accent)] bg-[var(--surface-raised)]"
                          : "border-[var(--line)] hover:bg-[var(--surface-raised)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="targetMerchantDomain"
                          value={cart.merchantDomain}
                          checked={effectiveMerchantDomain === cart.merchantDomain}
                          onChange={(e) => setChosenMerchantDomain(e.target.value)}
                        />
                        <span className="font-medium text-[var(--ink)] font-mono">{cart.merchantDomain}</span>
                      </div>
                      <span className="font-mono font-bold text-[var(--ink)]">
                        ${cartTotal.toFixed(2)} USD
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-between p-2 rounded border border-[var(--line)] bg-[var(--surface-raised)]">
                <div>
                  <span className="font-medium text-[var(--ink)] font-mono">{multiCarts[0].merchantDomain}</span>
                </div>
                <span className="font-mono font-bold text-[var(--ink)]">
                  ${((multiCarts[0].merchandiseSubtotalCents + multiCarts[0].shippingCents) / 100).toFixed(2)} USD
                </span>
              </div>
            )}
          </div>
        )}

        {hasLiveAttempt ? (
          <div className="text-xs space-y-2 mt-2">
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
              <span className="text-[var(--ink-muted)]">PayPal Order ID:</span>
              <span className="font-mono font-medium text-[var(--ink)]">{liveAttempt?.paypalOrderId}</span>
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
              <span className="text-[var(--ink-muted)]">Attempt Status:</span>
              <span className="font-medium text-[var(--ink)]">{liveAttempt?.status}</span>
            </div>
            {liveAttempt?.requestedIntent && (
              <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                <span className="text-[var(--ink-muted)]">Requested Intent:</span>
                <span className="font-mono font-medium text-[var(--accent)]">{liveAttempt.requestedIntent}</span>
              </div>
            )}

            <div className="pt-2 border-t border-[var(--line)] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <span className="text-xs text-[var(--ink-muted)] block">Sandbox Buyer Checkout:</span>
                {safeApprovalUrl && (
                  <span className="text-[11px] text-[var(--ink-muted)] font-mono truncate max-w-xs block">
                    {safeApprovalUrl}
                  </span>
                )}
              </div>
              {safeApprovalUrl ? (
                <a
                  id="paypal-approve-btn"
                  href={safeApprovalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-control)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap"
                >
                  Approve in PayPal Sandbox ↗
                </a>
              ) : (
                <Button
                  id="retrieve-approval-link-btn"
                  variant="secondary"
                  onClick={handleVerify}
                  loading={loadingVerify}
                  disabled={loadingVerify}
                  className="text-xs py-1 px-2.5 whitespace-nowrap"
                >
                  Retrieve Sandbox Approval Link ↗
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-xs text-[var(--ink-muted)] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-2">
            <span>
              {isApproved
                ? "Purchase terms are approved. You may now create the PayPal Sandbox checkout order."
                : "Order creation is locked until purchase terms are evaluated and approved in Step 3."}
            </span>
            <Button
              id="create-paypal-order-btn"
              variant="primary"
              onClick={handleCreateOrder}
              loading={loadingOrder}
              disabled={!isApproved || loadingOrder}
              className="text-xs"
            >
              Create Sandbox Order
            </Button>
          </div>
        )}
      </div>

      {/* Step 4B: Buyer Approval & Independent Verification */}
      {hasLiveAttempt && (
        <div className="p-4 border border-[var(--line)] rounded-[var(--radius-control)] bg-[var(--surface-raised)]">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--line)]">
            <span className="text-xs font-semibold text-[var(--ink)]">
              Step 4B: Buyer Approval & Status Verification
            </span>
            <StatusChip
              variant={purchase.status === "BUYER_APPROVED" ? "pass" : "info"}
              label={purchase.status === "BUYER_APPROVED" ? "BUYER_APPROVED (UNCAPTURED)" : purchase.status}
            />
          </div>

          <p className="text-[11px] text-[var(--ink-muted)] mb-3">
            Independent Verification queries PayPal Sandbox remotely to assert authoritative order status, currency, and reference ID matching without advancing workflow state or capturing funds.
          </p>

          {confirmError && (
            <div className="mb-3 space-y-2">
              <Banner variant="error">{confirmError}</Banner>
              {(confirmError.includes("payment_not_yet_approved") ||
                confirmError.includes("CREATED") ||
                confirmError.includes("not been approved")) && (
                <div className="text-xs text-[var(--ink)] bg-[var(--surface)] p-2.5 border border-[var(--control-border)] rounded-[var(--radius-control)]">
                  <strong>Action Required:</strong> The buyer has not yet approved the transaction in PayPal Sandbox (status is <code>CREATED</code>).
                  {safeApprovalUrl ? (
                    <div className="mt-1">
                      Please click{" "}
                      <a
                        href={safeApprovalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--accent)] underline font-medium"
                      >
                        Approve in PayPal Sandbox ↗
                      </a>{" "}
                      to log into your PayPal Sandbox buyer account and approve the payment, then return here and click &quot;Confirm Buyer Approval&quot;.
                    </div>
                  ) : (
                    <div className="mt-1">
                      Please click &quot;Independently Verify PayPal Status&quot; to fetch the latest Sandbox checkout URL, complete approval at PayPal, and then confirm approval.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {verifyError && (
            <div className="mb-3">
              <Banner variant="error">{verifyError}</Banner>
            </div>
          )}

          {/* Workflow Status Guard */}
          {purchase.status === "BUYER_APPROVED" && (
            <div className="mb-3">
              <Banner variant="success">
                <strong>Buyer Approval Verified:</strong> The buyer approved the order in PayPal Sandbox. Terms, reference ID, and amount match server records.
                <div className="mt-1 text-[11px] font-semibold text-[var(--pass)]">
                  Notice: This state does NOT mean payment is complete. Workflow is held before funds capture.
                </div>
              </Banner>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {purchase.status === "ORDER_CREATED" && (
              <Button
                id="confirm-buyer-approval-btn"
                variant="primary"
                onClick={handleConfirmApproval}
                loading={loadingConfirm}
                disabled={loadingConfirm || loadingVerify}
                className="text-xs"
              >
                Confirm Buyer Approval
              </Button>
            )}

            <Button
              id="verify-paypal-status-btn"
              variant="secondary"
              onClick={handleVerify}
              loading={loadingVerify}
              disabled={loadingConfirm || loadingVerify}
              className="text-xs"
            >
              Independently Verify PayPal Status
            </Button>
          </div>

          {/* Verification Result Display */}
          {verificationResult && (
            <div className="border border-[var(--line)] rounded-[var(--radius-control)] p-3 bg-[var(--surface)] text-xs mt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-[var(--ink)]">Authoritative Sandbox Verification Result</span>
                {getVerificationChip(verificationResult)}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-[var(--ink-muted)]">
                <div>Remote Status: <span className="font-mono text-[var(--ink)]">{verificationResult.remoteStatus ?? "none"}</span></div>
                <div>Internal Status: <span className="font-mono text-[var(--ink)]">{verificationResult.internalStatus}</span></div>
                <div>Reference ID Matched: <span className="font-medium text-[var(--ink)]">{verificationResult.referenceIdMatched ? "Yes" : "No"}</span></div>
                <div>Amount Matched: <span className="font-medium text-[var(--ink)]">{verificationResult.amountMatched ? "Yes" : "No"}</span></div>
                {verificationResult.observedAmountCents !== null && (
                  <div>Observed Amount: <span className="font-mono text-[var(--ink)]">${(verificationResult.observedAmountCents / 100).toFixed(2)} {verificationResult.observedCurrency}</span></div>
                )}
                <div>Verified At: <span className="font-mono text-[var(--ink)]">{verificationResult.verifiedAt}</span></div>
              </div>

              <div className="mt-2 pt-2 border-t border-[var(--line)] text-xs text-[var(--ink)]">
                {verificationResult.message}
              </div>

              {verificationResult.outcome === "REMOTELY_COMPLETED" && (
                <div className="mt-2 text-[11px] text-[var(--caution)] bg-[var(--caution-tint)] p-2 rounded-[var(--radius-control)]">
                  Caution: Remote status is COMPLETED in PayPal Sandbox, but no internal capture was orchestrated. Internal state is uncaptured.
                </div>
              )}

              {verificationResult.outcome === "REMOTE_NOT_FOUND" && (
                <div className="mt-2 text-[11px] text-[var(--caution)] bg-[var(--caution-tint)] p-2 rounded-[var(--radius-control)]">
                  <strong>Sandbox Order Not Found (HTTP 404):</strong> The remote order does not exist or has expired in PayPal Sandbox. Local purchase and audit history remain immutable, but remote state cannot be verified.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
