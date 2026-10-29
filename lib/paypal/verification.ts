import { Actor, PayPalOrderStatus, PurchaseStatus } from "../state/types";
import { transition } from "../state/transitions";
import { getPayPalSandboxClient, PayPalSandboxClient, extractSafeApprovalLink } from "./client";
import {
  PayPalApiError,
  PayPalGetOrderResponse,
  PayPalNetworkError,
  PayPalTimeoutError,
} from "./types";
import {
  getPurchaseRepository,
  PurchaseRepository,
} from "../workflow/repository";
import { assertPurchaseAccess } from "../workflow/auth";
import {
  ApprovalIntegrityError,
  NotFoundError,
  WorkflowError,
} from "../workflow/errors";
import { MultiItemApprovalSnapshot } from "../discovery/cart/types";

import {
  aggregateToState,
} from "../workflow/service";

export type PaymentVerificationOutcome =
  | "PENDING_BUYER_ACTION"
  | "BUYER_APPROVED"
  | "REMOTELY_COMPLETED"
  | "VOIDED"
  | "MISMATCH_REJECTED"
  | "UNVERIFIED_TRANSIENT"
  | "UNVERIFIED_API_ERROR"
  | "REMOTE_NOT_FOUND"
  | "MALFORMED_RESPONSE";

export interface PaymentVerificationResult {
  readonly purchaseId: string;
  readonly paypalOrderId: string | null;
  readonly internalStatus: PurchaseStatus;
  readonly outcome: PaymentVerificationOutcome;
  readonly verified: boolean;
  readonly remoteStatus: PayPalOrderStatus | string | null;
  readonly referenceIdMatched: boolean;
  readonly amountMatched: boolean;
  readonly currencyMatched: boolean;
  readonly observedAmountCents: number | null;
  readonly observedCurrency: string | null;
  readonly verifiedAt: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly approvalUrl?: string | null;
}

export class PaymentVerificationService {
  constructor(
    private readonly repo: PurchaseRepository = getPurchaseRepository(),
    private readonly payPalClient: PayPalSandboxClient = getPayPalSandboxClient()
  ) {}

  /**
   * Independently queries PayPal Sandbox to verify authoritative order state,
   * purchase reference, amount, currency, and buyer approval integrity.
   */
  async verifyPayment(
    purchaseId: string,
    actor: Actor
  ): Promise<PaymentVerificationResult> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" was not found.`);
    }

    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "verify_payment");

    const liveAttempt =
      aggregate.paymentAttempts.find((a) => a.status === "OPEN") ||
      aggregate.paymentAttempts[aggregate.paymentAttempts.length - 1];

    if (!liveAttempt || !liveAttempt.paypalOrderId) {
      throw new WorkflowError(
        "no_payment_attempt",
        `Purchase "${purchaseId}" has no payment attempt or PayPal order ID to verify.`
      );
    }

    const eff = aggregate.approvals.find((a) => a.invalidatedAt === null);
    if (!eff) {
      throw new ApprovalIntegrityError(
        "no_effective_approval",
        `No active approved terms found for purchase "${purchaseId}".`
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();

    let remoteOrder: PayPalGetOrderResponse;
    try {
      remoteOrder = await this.payPalClient.getOrder(liveAttempt.paypalOrderId);
    } catch (err) {
      if (err instanceof PayPalTimeoutError) {
        return {
          purchaseId,
          paypalOrderId: liveAttempt.paypalOrderId,
          internalStatus: aggregate.purchase.status,
          outcome: "UNVERIFIED_TRANSIENT",
          verified: false,
          remoteStatus: null,
          referenceIdMatched: false,
          amountMatched: false,
          currencyMatched: false,
          observedAmountCents: null,
          observedCurrency: null,
          verifiedAt: nowIso,
          message: "PayPal Sandbox verification request timed out. Internal state retained.",
          details: { errorType: "PayPalTimeoutError" },
        };
      }
      if (err instanceof PayPalNetworkError) {
        return {
          purchaseId,
          paypalOrderId: liveAttempt.paypalOrderId,
          internalStatus: aggregate.purchase.status,
          outcome: "UNVERIFIED_TRANSIENT",
          verified: false,
          remoteStatus: null,
          referenceIdMatched: false,
          amountMatched: false,
          currencyMatched: false,
          observedAmountCents: null,
          observedCurrency: null,
          verifiedAt: nowIso,
          message: "Failed to connect to PayPal Sandbox endpoint. Internal state retained.",
          details: { errorType: "PayPalNetworkError" },
        };
      }
      if (err instanceof PayPalApiError) {
        if (err.statusCode === 404) {
          await this.repo.recordPaymentVerification({
            purchaseId,
            paymentAttemptId: liveAttempt.id,
            verifiedStatus: "NOT_FOUND",
            verifiedAt: now,
            failureReason: "remote_order_not_found",
          });

          return {
            purchaseId,
            paypalOrderId: liveAttempt.paypalOrderId,
            internalStatus: aggregate.purchase.status,
            outcome: "REMOTE_NOT_FOUND",
            verified: false,
            remoteStatus: "NOT_FOUND",
            referenceIdMatched: false,
            amountMatched: false,
            currencyMatched: false,
            observedAmountCents: null,
            observedCurrency: null,
            verifiedAt: nowIso,
            message: `PayPal Sandbox returned HTTP 404 (Resource Not Found). The order "${liveAttempt.paypalOrderId}" does not exist or has expired in the Sandbox environment. Historical local audit record remains intact.`,
            details: {
              statusCode: 404,
              errorName: err.errorName,
              debugId: err.debugId,
              historicalAuditPreserved: true,
            },
          };
        }

        await this.repo.recordPaymentVerification({
          purchaseId,
          paymentAttemptId: liveAttempt.id,
          verifiedStatus: "API_ERROR",
          verifiedAt: now,
          failureReason: err.errorName || `http_${err.statusCode}`,
        });

        return {
          purchaseId,
          paypalOrderId: liveAttempt.paypalOrderId,
          internalStatus: aggregate.purchase.status,
          outcome: "UNVERIFIED_API_ERROR",
          verified: false,
          remoteStatus: null,
          referenceIdMatched: false,
          amountMatched: false,
          currencyMatched: false,
          observedAmountCents: null,
          observedCurrency: null,
          verifiedAt: nowIso,
          message: `PayPal Sandbox returned API error: ${err.message}`,
          details: {
            statusCode: err.statusCode,
            errorName: err.errorName,
            debugId: err.debugId,
          },
        };
      }
      throw err;
    }

    const approvalUrl = extractSafeApprovalLink(remoteOrder.links);

    // 1. Order ID verification
    if (!remoteOrder.id || remoteOrder.id !== liveAttempt.paypalOrderId) {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status ?? "UNKNOWN",
        verifiedAt: now,
        failureReason: "order_id_mismatch",
      });
      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MISMATCH_REJECTED",
        verified: false,
        remoteStatus: remoteOrder.status ?? null,
        referenceIdMatched: false,
        amountMatched: false,
        currencyMatched: false,
        observedAmountCents: null,
        observedCurrency: null,
        verifiedAt: nowIso,
        message: `PayPal order ID "${remoteOrder.id}" does not match expected order ID "${liveAttempt.paypalOrderId}".`,
      };
    }

    // 2. Validate purchase units structure (Purchase Assurance orders require exactly 1 unit)
    if (!Array.isArray(remoteOrder.purchase_units) || remoteOrder.purchase_units.length === 0) {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status,
        verifiedAt: now,
        failureReason: "missing_purchase_units",
      });
      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MALFORMED_RESPONSE",
        verified: false,
        remoteStatus: remoteOrder.status,
        referenceIdMatched: false,
        amountMatched: false,
        currencyMatched: false,
        observedAmountCents: null,
        observedCurrency: null,
        verifiedAt: nowIso,
        message: "PayPal order response does not contain any purchase units.",
      };
    }

    if (remoteOrder.purchase_units.length !== 1) {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status,
        verifiedAt: now,
        failureReason: "multiple_purchase_units",
      });
      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MALFORMED_RESPONSE",
        verified: false,
        remoteStatus: remoteOrder.status,
        referenceIdMatched: false,
        amountMatched: false,
        currencyMatched: false,
        observedAmountCents: null,
        observedCurrency: null,
        verifiedAt: nowIso,
        message: `PayPal order contains ${remoteOrder.purchase_units.length} units; Purchase Assurance requires exactly 1 unit.`,
      };
    }

    const unit = remoteOrder.purchase_units[0];

    // 3. Reference ID check
    const referenceIdMatched = Boolean(unit.reference_id && unit.reference_id === purchaseId);
    if (!referenceIdMatched) {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status,
        verifiedAt: now,
        failureReason: "reference_id_mismatch",
      });
      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MISMATCH_REJECTED",
        verified: false,
        remoteStatus: remoteOrder.status,
        referenceIdMatched: false,
        amountMatched: false,
        currencyMatched: false,
        observedAmountCents: null,
        observedCurrency: null,
        verifiedAt: nowIso,
        message: `PayPal purchase unit reference_id "${unit.reference_id ?? "missing"}" does not match internal purchase ID "${purchaseId}".`,
      };
    }

    // 4. Amount and currency check
    if (!unit.amount || !unit.amount.value || !unit.amount.currency_code) {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status,
        verifiedAt: now,
        failureReason: "malformed_amount",
      });
      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MALFORMED_RESPONSE",
        verified: false,
        remoteStatus: remoteOrder.status,
        referenceIdMatched: true,
        amountMatched: false,
        currencyMatched: false,
        observedAmountCents: null,
        observedCurrency: null,
        verifiedAt: nowIso,
        message: "PayPal purchase unit amount structure is missing or malformed.",
      };
    }

    const observedCurrency = unit.amount.currency_code;
    const currencyMatched = observedCurrency === eff.currency;
    const parsedCents = Math.round(parseFloat(unit.amount.value) * 100);
    const observedAmountCents = Number.isFinite(parsedCents) && !isNaN(parsedCents) ? parsedCents : null;
    let amountMatched = observedAmountCents === eff.totalCents;

    const multiItemSnapshot = (
      aggregate.purchase.requirements &&
      typeof aggregate.purchase.requirements === "object" &&
      "approvedStrategy" in (aggregate.purchase.requirements as Record<string, unknown>)
    )
      ? ((aggregate.purchase.requirements as { approvedStrategy: MultiItemApprovalSnapshot }).approvedStrategy)
      : null;

    if (!amountMatched && multiItemSnapshot && observedAmountCents !== null) {
      const matchingCart = multiItemSnapshot.carts.find(
        (c) => c.merchandiseSubtotalCents + c.shippingCents === observedAmountCents
      );
      if (matchingCart) {
        amountMatched = true;
      }
    }

    if (!currencyMatched || !amountMatched) {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status,
        verifiedAt: now,
        failureReason: "terms_mismatch",
      });
      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MISMATCH_REJECTED",
        verified: false,
        remoteStatus: remoteOrder.status,
        referenceIdMatched: true,
        amountMatched,
        currencyMatched,
        observedAmountCents,
        observedCurrency,
        verifiedAt: nowIso,
        message: `PayPal order terms (${observedCurrency} ${observedAmountCents} cents) do not match approved terms (${eff.currency} ${eff.totalCents} cents).`,
      };
    }

    // 5. Intent verification: Plinthly strictly enforces an authorization-only lifecycle.
    // Legacy orders created with intent "CAPTURE" are incompatible and isolated.
    if (remoteOrder.intent && remoteOrder.intent !== "AUTHORIZE") {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: "INTENT_INCOMPATIBLE",
        verifiedAt: now,
        failureReason: "legacy_capture_intent_incompatible",
      });

      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "MISMATCH_REJECTED",
        verified: false,
        remoteStatus: remoteOrder.status ?? null,
        referenceIdMatched: true,
        amountMatched: true,
        currencyMatched: true,
        observedAmountCents,
        observedCurrency,
        verifiedAt: nowIso,
        message: `PayPal order "${liveAttempt.paypalOrderId}" was created with intent "${remoteOrder.intent}", which is incompatible with Plinthly's authorization-only lifecycle. This legacy order is isolated and cannot be authorized or advanced.`,
        approvalUrl: null,
        details: {
          observedIntent: remoteOrder.intent,
          requiredIntent: "AUTHORIZE",
          legacyOrderIncompatible: true,
        },
      };
    }

    // 6. Evaluate Remote Status vs Internal Workflow
    if (remoteOrder.status === "CREATED" || remoteOrder.status === "PAYER_ACTION_REQUIRED") {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: remoteOrder.status,
        verifiedAt: now,
      });

      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "PENDING_BUYER_ACTION",
        verified: false,
        remoteStatus: remoteOrder.status,
        referenceIdMatched: true,
        amountMatched: true,
        currencyMatched: true,
        observedAmountCents,
        observedCurrency,
        verifiedAt: nowIso,
        message: `PayPal order is in status "${remoteOrder.status}". Pending buyer approval in PayPal Sandbox.`,
        approvalUrl,
      };
    }

    if (remoteOrder.status === "APPROVED") {
      if (aggregate.purchase.status === "ORDER_CREATED") {
        // Advance state machine via legal transition T11
        const purchaseState = aggregateToState(aggregate);
        const transResult = transition(
          purchaseState,
          {
            kind: "observe_paypal_order",
            observation: {
              orderId: liveAttempt.paypalOrderId,
              status: "APPROVED",
              source: "paypal_order_get",
              observedAt: now,
            },
          },
          { actor, now }
        );

        if (!transResult.ok) {
          throw new WorkflowError(transResult.error.code, transResult.error.message);
        }

        const updated = await this.repo.recordBuyerApproval({
          purchaseId,
          expectedStatus: "ORDER_CREATED",
          expectedVersion: aggregate.purchase.version,
          nextStatus: "BUYER_APPROVED",
          paymentAttemptId: liveAttempt.id,
          verifiedStatus: "APPROVED",
          verifiedAt: now,
          auditEvents: transResult.events,
        });

        return {
          purchaseId,
          paypalOrderId: liveAttempt.paypalOrderId,
          internalStatus: updated.purchase.status,
          outcome: "BUYER_APPROVED",
          verified: true,
          remoteStatus: "APPROVED",
          referenceIdMatched: true,
          amountMatched: true,
          currencyMatched: true,
          observedAmountCents,
          observedCurrency,
          verifiedAt: nowIso,
          message: "Buyer approval independently verified; purchase advanced to BUYER_APPROVED.",
          approvalUrl,
        };
      }

      // If already in BUYER_APPROVED, idempotent verification
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: "APPROVED",
        verifiedAt: now,
      });

      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "BUYER_APPROVED",
        verified: true,
        remoteStatus: "APPROVED",
        referenceIdMatched: true,
        amountMatched: true,
        currencyMatched: true,
        observedAmountCents,
        observedCurrency,
        verifiedAt: nowIso,
        message: "Buyer approval re-verified idempotently in PayPal Sandbox.",
        approvalUrl,
      };
    }

    if (remoteOrder.status === "COMPLETED") {
      // Record remote status observation without advancing internal workflow to COMPLETED
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: "COMPLETED",
        verifiedAt: now,
      });

      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "REMOTELY_COMPLETED",
        verified: true,
        remoteStatus: "COMPLETED",
        referenceIdMatched: true,
        amountMatched: true,
        currencyMatched: true,
        observedAmountCents,
        observedCurrency,
        verifiedAt: nowIso,
        message: "Order observed as COMPLETED in PayPal Sandbox. Internal workflow remains uncaptured.",
      };
    }

    if (remoteOrder.status === "VOIDED") {
      await this.repo.recordPaymentVerification({
        purchaseId,
        paymentAttemptId: liveAttempt.id,
        verifiedStatus: "VOIDED",
        verifiedAt: now,
        failureReason: "remote_order_voided",
      });

      return {
        purchaseId,
        paypalOrderId: liveAttempt.paypalOrderId,
        internalStatus: aggregate.purchase.status,
        outcome: "VOIDED",
        verified: false,
        remoteStatus: "VOIDED",
        referenceIdMatched: true,
        amountMatched: true,
        currencyMatched: true,
        observedAmountCents,
        observedCurrency,
        verifiedAt: nowIso,
        message: "PayPal Sandbox order has been voided.",
      };
    }

    // Default unexpected status
    await this.repo.recordPaymentVerification({
      purchaseId,
      paymentAttemptId: liveAttempt.id,
      verifiedStatus: remoteOrder.status,
      verifiedAt: now,
      failureReason: `unexpected_status_${remoteOrder.status}`,
    });

    return {
      purchaseId,
      paypalOrderId: liveAttempt.paypalOrderId,
      internalStatus: aggregate.purchase.status,
      outcome: "MISMATCH_REJECTED",
      verified: false,
      remoteStatus: remoteOrder.status,
      referenceIdMatched: true,
      amountMatched: true,
      currencyMatched: true,
      observedAmountCents,
      observedCurrency,
      verifiedAt: nowIso,
      message: `Unexpected PayPal Sandbox status "${remoteOrder.status}".`,
    };
  }
}

let globalVerificationService: PaymentVerificationService | null = null;

export function getPaymentVerificationService(): PaymentVerificationService {
  if (!globalVerificationService) {
    globalVerificationService = new PaymentVerificationService();
  }
  return globalVerificationService;
}

export function setPaymentVerificationService(
  service: PaymentVerificationService | null
): void {
  globalVerificationService = service;
}
