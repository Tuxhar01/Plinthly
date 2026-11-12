/**
 * Plinthly Stage 3 Phase 4 — Cart Status & Evidence Query API Route
 *
 * GET /api/cart/status/[cartId]
 *
 * Retrieves real-time merchant cart status, financial totals, payment evidence,
 * refund history, and allocated line items.
 */

import { NextResponse } from "next/server";
import { requireActor, handleApiError } from "../../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../../lib/database/stage2-connection";

export async function GET(
  request: Request,
  context: { params: Promise<{ cartId: string }> }
): Promise<NextResponse> {
  let dbClient: any = null;
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const { cartId } = await context.params;
    if (!cartId) {
      return NextResponse.json(
        { error: { code: "ERR_INVALID_CART_ID", message: "cartId parameter is required." } },
        { status: 400 }
      );
    }

    dbClient = await createStage2ApiClient();

    // Query Cart
    const cartRes = await dbClient.query(
      `SELECT id, "approvalAggregateId", "merchantId", "merchantId" AS "merchantName", "merchantPayeeEmail",
              "checkoutStatus", "merchandiseSubtotalCents", "discountCents",
              "shippingTotalCents", "taxAmountCents", "totalCartCents",
              "paypalOrderId", "cumulativeRefundedCents", "createdAt", "updatedAt"
         FROM public."ApprovedMerchantCart"
        WHERE id = $1`,
      [cartId]
    );

    if (cartRes.rows.length === 0) {
      return NextResponse.json(
        { error: { code: "ERR_CART_NOT_FOUND", message: `Merchant cart "${cartId}" not found.` } },
        { status: 404 }
      );
    }

    const cart = cartRes.rows[0];

    // Query PaymentEvidenceRecord
    const peRes = await dbClient.query(
      `SELECT id, cart_id, transmission_id, capture_id, paypal_order_id,
              amount_cents, currency, payee_email, recorded_at
         FROM public."PaymentEvidenceRecord"
        WHERE cart_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [cartId]
    );

    const paymentEvidence = peRes.rows.length > 0 ? peRes.rows[0] : null;

    // Query RefundEvidenceRecords
    const refRes = await dbClient.query(
      `SELECT id, cart_id, capture_id, transmission_id, authenticated_refund_id AS refund_id,
              refund_amount_cents AS amount_cents, currency, reason, recorded_at
         FROM public."RefundEvidenceRecord"
        WHERE cart_id = $1
        ORDER BY recorded_at ASC, id ASC`,
      [cartId]
    );

    // Query Allocations
    const allocRes = await dbClient.query(
      `SELECT a.id, a."cartId", a."lineItemId", a."allocatedQuantity",
              a."allocatedUnitCents",
              (a."allocatedQuantity" * a."allocatedUnitCents") AS "allocatedTotalCents",
              l."itemDescription" AS "lineItemTitle"
         FROM public."CartAllocation" a
         LEFT JOIN public."ProcurementLineItem" l ON l.id = a."lineItemId"
        WHERE a."cartId" = $1
        ORDER BY a."createdAt" ASC, a.id ASC`,
      [cartId]
    );

    return NextResponse.json(
      {
        cart,
        paymentEvidence,
        refunds: refRes.rows,
        allocations: allocRes.rows,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return handleApiError(err);
  } finally {
    if (dbClient) {
      await dbClient.end().catch(() => {});
    }
  }
}
