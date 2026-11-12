/**
 * Plinthly Stage 2 Phase 5 — Multi-Cart Checkout Initiation API Route
 *
 * POST /api/cart/checkout
 *
 * Validates buyer approval and Model A Landed Cost zero-variance invariants
 * across all merchant carts in an ApprovalAggregate, transitioning them to BUYER_APPROVED.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody, requireActor, handleApiError } from "../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../lib/database/stage2-connection";
import { reconcileLandedCostZeroVariance } from "../../../../lib/workflow/landed-cost-reconciler";
import { assertCartTransition } from "../../../../lib/workflow/cart-state-machine";

const checkoutRequestSchema = z.object({
  approvalAggregateId: z.string().uuid("approvalAggregateId must be a valid UUID"),
  cartIds: z.array(z.string().uuid()).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let dbClient: any = null;
  try {
    // 1. Enforce Authentication
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    // 2. Parse JSON Request Body
    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    // 3. Validate Request Schema
    const input = checkoutRequestSchema.parse(jsonResult.data);

    // 4. Connect to Stage 2 database
    dbClient = await createStage2ApiClient();

    // 5. Query ApprovalAggregate
    const aggRes = await dbClient.query(
      `SELECT id, "aggregateStatus" FROM public."ApprovalAggregate" WHERE id = $1`,
      [input.approvalAggregateId]
    );

    if (aggRes.rows.length === 0) {
      return NextResponse.json(
        { error: { code: "ERR_AGGREGATE_NOT_FOUND", message: `Approval aggregate "${input.approvalAggregateId}" not found.` } },
        { status: 404 }
      );
    }

    const agg = aggRes.rows[0];
    if (agg.aggregateStatus !== "APPROVED" && agg.aggregateStatus !== "ACTIVE") {
      return NextResponse.json(
        { error: { code: "ERR_INVALID_TRANSITION", message: `Aggregate status "${agg.aggregateStatus}" is not approved.` } },
        { status: 400 }
      );
    }

    // 6. Query Carts
    let cartQuery = `
      SELECT id, "merchantId", "merchantPayeeEmail", "checkoutStatus",
             "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
             "taxAmountCents", "totalCartCents", "paypalOrderId"
        FROM public."ApprovedMerchantCart"
       WHERE "approvalAggregateId" = $1
    `;
    const params: any[] = [input.approvalAggregateId];

    if (input.cartIds && input.cartIds.length > 0) {
      cartQuery += ` AND id = ANY($2::uuid[])`;
      params.push(input.cartIds);
    }

    cartQuery += ` ORDER BY "createdAt" ASC`;
    const cartsRes = await dbClient.query(cartQuery, params);

    if (cartsRes.rows.length === 0) {
      return NextResponse.json(
        { error: { code: "ERR_NO_CARTS_FOUND", message: "No merchant carts found for checkout initiation." } },
        { status: 404 }
      );
    }

    const approvedCarts: any[] = [];

    // 7. Validate Landed Cost and State Transition for each cart
    for (const cart of cartsRes.rows) {
      // Assert Model A zero-variance
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: cart.merchandiseSubtotalCents,
        discountCents: cart.discountCents,
        shippingTotalCents: cart.shippingTotalCents,
        taxAmountCents: cart.taxAmountCents,
        totalCartCents: cart.totalCartCents,
      });

      // Assert Transition
      if (cart.checkoutStatus !== "BUYER_APPROVED") {
        assertCartTransition(cart.checkoutStatus, "BUYER_APPROVED");

        await dbClient.query(
          `UPDATE public."ApprovedMerchantCart"
              SET "checkoutStatus" = 'BUYER_APPROVED', "updatedAt" = clock_timestamp()
            WHERE id = $1`,
          [cart.id]
        );
      }

      approvedCarts.push({
        cartId: cart.id,
        merchantId: cart.merchantId,
        checkoutStatus: "BUYER_APPROVED",
        totalCartCents: Number(cart.totalCartCents),
        paypalOrderId: cart.paypalOrderId,
      });
    }

    return NextResponse.json(
      {
        approvalAggregateId: input.approvalAggregateId,
        status: "BUYER_APPROVED",
        totalCarts: approvedCarts.length,
        carts: approvedCarts,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err.name === "LandedCostVarianceError" || err.code === "ERR_LANDED_COST_VARIANCE") {
      return NextResponse.json(
        { error: { code: "ERR_LANDED_COST_MISMATCH", message: err.message } },
        { status: 400 }
      );
    }
    if (err.name === "InvalidCartTransitionError" || err.code === "ERR_INVALID_TRANSITION") {
      return NextResponse.json(
        { error: { code: "ERR_INVALID_TRANSITION", message: err.message } },
        { status: 400 }
      );
    }
    return handleApiError(err);
  } finally {
    if (dbClient) {
      await dbClient.end().catch(() => {});
    }
  }
}
