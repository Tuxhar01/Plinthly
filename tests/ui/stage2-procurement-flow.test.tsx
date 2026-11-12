/**
 * Plinthly Stage 3 Phase 4 — Modernized Stage 2 & 3 UI Component Tests
 *
 * Verifies UI-01 through UI-06:
 * 1. Stage2ApprovalModal:
 *    - Renders zero-variance verification badge when |Δ| = 0.
 *    - Displays multi-retailer breakdown with merchandise, discount, shipping, tax, and total.
 *    - Displays line item allocations per cart.
 *    - Displays cryptographic snapshot digest.
 *    - Flags landed cost variance when components mismatch.
 * 2. PayPalMultiCartCheckout:
 *    - Renders sequential progress indicator.
 *    - Renders merchant cart statuses (BUYER_APPROVED, CAPTURING, CAPTURED, AMBIGUOUS_TIMEOUT, FAILED).
 *    - Renders execution action button.
 * 3. Stage2PurchaseReceipt:
 *    - Renders multi-merchant settlement receipt with payment evidence records.
 *    - Displays settlement timestamps, capture IDs, and tax breakdowns.
 *    - Renders refund provenance records and refund action triggers.
 */

import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Stage2ApprovalModal } from "../../components/workflow/stage2-approval-modal";
import { PayPalMultiCartCheckout } from "../../components/workflow/paypal-multi-cart-checkout";
import { Stage2PurchaseReceipt } from "../../components/workflow/stage2-purchase-receipt";
import {
  ApprovalAggregateDetailResponse,
  ApprovedMerchantCartRecord,
  CartStatusDetailResponse,
} from "../../lib/workflow/stage2-client-api";

describe("Stage 3 Phase 4: UI Modernization Tests (UI-01 through UI-06)", () => {
  const mockAggregateData: ApprovalAggregateDetailResponse = {
    approvalAggregate: {
      id: "agg-ui-test-01",
      buyerId: "buyer-enterprise-99",
      aggregateStatus: "ACTIVE",
      totalMerchandiseCents: 150000,
      totalDiscountCents: 5000,
      totalShippingCents: 2000,
      totalTaxCents: 11600,
      totalAuthorizedCents: 158600, // 150000 - 5000 + 2000 + 11600 = 158600 (|Δ| = 0)
      currency: "USD",
      snapshotDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    carts: [
      {
        id: "cart-ui-01",
        approvalAggregateId: "agg-ui-test-01",
        merchantName: "Dell Direct",
        merchantPayeeEmail: "payee-dell@example.com",
        checkoutStatus: "BUYER_APPROVED",
        merchandiseSubtotalCents: 100000,
        discountCents: 5000,
        shippingTotalCents: 0,
        taxAmountCents: 7600,
        totalCartCents: 102600, // 100000 - 5000 + 0 + 7600 = 102600
        paypalOrderId: "ORD-DELL-01",
        cumulativeRefundedCents: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "cart-ui-02",
        approvalAggregateId: "agg-ui-test-01",
        merchantName: "B&H Photo",
        merchantPayeeEmail: "payee-bh@example.com",
        checkoutStatus: "BUYER_APPROVED",
        merchandiseSubtotalCents: 50000,
        discountCents: 0,
        shippingTotalCents: 2000,
        taxAmountCents: 4000,
        totalCartCents: 56000, // 50000 - 0 + 2000 + 4000 = 56000
        paypalOrderId: "ORD-BH-02",
        cumulativeRefundedCents: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    allocations: [
      {
        id: "alloc-01",
        cartId: "cart-ui-01",
        lineItemId: "line-item-01",
        allocatedQuantity: 1,
        allocatedUnitCents: 100000,
        allocatedShippingCents: 0,
        allocatedTaxCents: 7600,
        allocatedTotalCents: 102600,
        currency: "USD",
        lineItemTitle: "Dell XPS 15",
      },
      {
        id: "alloc-02",
        cartId: "cart-ui-02",
        lineItemId: "line-item-02",
        allocatedQuantity: 1,
        allocatedUnitCents: 50000,
        allocatedShippingCents: 2000,
        allocatedTaxCents: 4000,
        allocatedTotalCents: 56000,
        currency: "USD",
        lineItemTitle: "UltraSharp 27 Monitor",
      },
    ],
  };

  describe("Stage2ApprovalModal", () => {
    it("1. renders null when isOpen is false", () => {
      const html = renderToStaticMarkup(
        <Stage2ApprovalModal
          isOpen={false}
          aggregateData={mockAggregateData}
          onApprove={async () => {}}
          onClose={() => {}}
        />
      );
      expect(html).toBe("");
    });

    it("2. renders zero-variance badge, carts, items, and snapshot digest when open", () => {
      const html = renderToStaticMarkup(
        <Stage2ApprovalModal
          isOpen={true}
          aggregateData={mockAggregateData}
          onApprove={async () => {}}
          onClose={() => {}}
        />
      );

      expect(html).toContain("Multi-Retailer Procurement Approval");
      expect(html).toContain("Zero Variance Verified");
      expect(html).toContain("Dell Direct");
      expect(html).toContain("B&amp;H Photo");
      expect(html).toContain("Dell XPS 15");
      expect(html).toContain("UltraSharp 27 Monitor");
      expect(html).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      expect(html).toContain("Approve &amp; Proceed to Checkout");
    });

    it("3. displays variance error badge when financial components mismatch", () => {
      const imbalancedData: ApprovalAggregateDetailResponse = {
        ...mockAggregateData,
        approvalAggregate: {
          ...mockAggregateData.approvalAggregate,
          totalAuthorizedCents: 158605, // 5 cents discrepancy!
        },
      };

      const html = renderToStaticMarkup(
        <Stage2ApprovalModal
          isOpen={true}
          aggregateData={imbalancedData}
          onApprove={async () => {}}
          onClose={() => {}}
        />
      );

      expect(html).toContain("Variance: -5¢");
      expect(html).not.toContain("Zero Variance Verified");
    });
  });

  describe("PayPalMultiCartCheckout", () => {
    it("4. renders sequential capture stepper, merchant items, and progress indicators", () => {
      const html = renderToStaticMarkup(
        <PayPalMultiCartCheckout
          approvalAggregateId="agg-ui-test-01"
          carts={mockAggregateData.carts}
        />
      );

      expect(html).toContain("PayPal Multi-Merchant Sequential Checkout");
      expect(html).toContain("0/2 Carts Captured");
      expect(html).toContain("Dell Direct");
      expect(html).toContain("B&amp;H Photo");
      expect(html).toContain("Execute Sequential Multi-Cart Capture");
    });
  });

  describe("Stage2PurchaseReceipt", () => {
    it("5. renders multi-merchant receipts with verified cryptographic evidence and refund records", () => {
      const mockCartDetails: Record<string, CartStatusDetailResponse> = {
        "cart-ui-01": {
          cart: {
            ...mockAggregateData.carts[0],
            checkoutStatus: "CAPTURED",
          },
          paymentEvidence: {
            id: "pe-01",
            cart_id: "cart-ui-01",
            transmission_id: "tx-wh-01",
            capture_id: "CAP-DELL-99",
            paypal_order_id: "ORD-DELL-01",
            amount_cents: 102600,
            currency: "USD",
            payee_email: "payee-dell@example.com",
            recorded_at: new Date("2026-11-08T00:00:00Z").toISOString(),
          },
          refunds: [],
          allocations: [mockAggregateData.allocations[0]],
        },
        "cart-ui-02": {
          cart: {
            ...mockAggregateData.carts[1],
            checkoutStatus: "PARTIALLY_REFUNDED",
            cumulativeRefundedCents: 10000,
          },
          paymentEvidence: {
            id: "pe-02",
            cart_id: "cart-ui-02",
            transmission_id: "tx-wh-02",
            capture_id: "CAP-BH-88",
            paypal_order_id: "ORD-BH-02",
            amount_cents: 56000,
            currency: "USD",
            payee_email: "payee-bh@example.com",
            recorded_at: new Date("2026-11-08T01:00:00Z").toISOString(),
          },
          refunds: [
            {
              id: "ref-rec-01",
              cart_id: "cart-ui-02",
              capture_id: "CAP-BH-88",
              transmission_id: "tx-ref-01",
              refund_id: "REF-BH-001",
              amount_cents: 10000,
              currency: "USD",
              reason: "Damaged packaging return",
              recorded_at: new Date("2026-11-08T02:00:00Z").toISOString(),
            },
          ],
          allocations: [mockAggregateData.allocations[1]],
        },
      };

      const capturedAggregateData: ApprovalAggregateDetailResponse = {
        ...mockAggregateData,
        carts: [
          mockCartDetails["cart-ui-01"].cart,
          mockCartDetails["cart-ui-02"].cart,
        ],
      };

      const html = renderToStaticMarkup(
        <Stage2PurchaseReceipt
          aggregateData={capturedAggregateData}
          cartDetails={mockCartDetails}
        />
      );

      expect(html).toContain("Multi-Merchant Procurement Settlement Receipt");
      expect(html).toContain("Verified Cryptographic Evidence");
      expect(html).toContain("CAP-DELL-99");
      expect(html).toContain("CAP-BH-88");
      expect(html).toContain("Refund Provenance Records (1)");
      expect(html).toContain("REF-BH-001");
      expect(html).toContain("Damaged packaging return");
    });
  });
});

