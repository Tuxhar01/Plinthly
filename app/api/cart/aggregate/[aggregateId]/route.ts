/**
 * Plinthly Stage 3 Phase 4 — Approval Aggregate Query API Route
 *
 * GET /api/cart/aggregate/[aggregateId]
 *
 * Retrieves approval aggregate details, associated merchant carts, line item allocations,
 * and Model A Landed Cost totals.
 */

import { NextResponse } from "next/server";
import { requireActor, handleApiError } from "../../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../../lib/database/stage2-connection";

export async function GET(
  request: Request,
  context: { params: Promise<{ aggregateId: string }> }
): Promise<NextResponse> {
  let dbClient: any = null;
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const { aggregateId } = await context.params;
    if (!aggregateId) {
      return NextResponse.json(
        { error: { code: "ERR_INVALID_AGGREGATE_ID", message: "aggregateId parameter is required." } },
        { status: 400 }
      );
    }

    dbClient = await createStage2ApiClient();

    // Query ApprovalAggregate joined with ProcurementPlan (frozen Stage 2 schema)
    const aggRes = await dbClient.query(
      `SELECT a.id, a."planId", a."aggregateStatus",
              encode(a."snapshotDigest", 'hex') AS "snapshotDigest",
              a."snapshotPayload", a."approvedAt", a."createdAt",
              p."userId"::text AS "buyerId",
              p."updatedAt"
         FROM public."ApprovalAggregate" a
         LEFT JOIN public."ProcurementPlan" p ON p.id = a."planId"
        WHERE a.id = $1`,
      [aggregateId]
    );

    if (aggRes.rows.length === 0) {
      return NextResponse.json(
        { error: { code: "ERR_AGGREGATE_NOT_FOUND", message: `Approval aggregate "${aggregateId}" not found.` } },
        { status: 404 }
      );
    }

    const aggRow = aggRes.rows[0];

    // Query Carts
    const cartsRes = await dbClient.query(
      `SELECT id, "approvalAggregateId", "merchantId", "merchantId" AS "merchantName", "merchantPayeeEmail",
              "checkoutStatus", "merchandiseSubtotalCents", "discountCents",
              "shippingTotalCents", "taxAmountCents", "totalCartCents",
              "paypalOrderId", "cumulativeRefundedCents", "createdAt", "updatedAt"
         FROM public."ApprovedMerchantCart"
        WHERE "approvalAggregateId" = $1
        ORDER BY "createdAt" ASC, id ASC`,
      [aggregateId]
    );

    const totalMerchandiseCents = cartsRes.rows.reduce(
      (sum: number, c: any) => sum + Number(c.merchandiseSubtotalCents || 0),
      0
    );
    const totalDiscountCents = cartsRes.rows.reduce(
      (sum: number, c: any) => sum + Number(c.discountCents || 0),
      0
    );
    const totalShippingCents = cartsRes.rows.reduce(
      (sum: number, c: any) => sum + Number(c.shippingTotalCents || 0),
      0
    );
    const totalTaxCents = cartsRes.rows.reduce(
      (sum: number, c: any) => sum + Number(c.taxAmountCents || 0),
      0
    );
    const totalAuthorizedCents = cartsRes.rows.reduce(
      (sum: number, c: any) => sum + Number(c.totalCartCents || 0),
      0
    );

    const aggregate = {
      id: aggRow.id,
      planId: aggRow.planId,
      buyerId: aggRow.buyerId || "usr_buyer_1",
      aggregateStatus: aggRow.aggregateStatus,
      totalMerchandiseCents,
      totalDiscountCents,
      totalShippingCents,
      totalTaxCents,
      totalAuthorizedCents,
      currency: "USD",
      snapshotDigest: aggRow.snapshotDigest || "",
      createdAt: aggRow.createdAt,
      updatedAt: aggRow.updatedAt || aggRow.createdAt,
    };

    const cartIds = cartsRes.rows.map((c: any) => c.id);

    // Query Allocations if any carts exist
    let allocations: any[] = [];
    if (cartIds.length > 0) {
      const allocRes = await dbClient.query(
        `SELECT a.id, a."cartId", a."lineItemId", a."allocatedQuantity",
                a."allocatedUnitCents",
                (a."allocatedQuantity" * a."allocatedUnitCents") AS "allocatedTotalCents",
                l."itemDescription" AS "lineItemTitle"
           FROM public."CartAllocation" a
           LEFT JOIN public."ProcurementLineItem" l ON l.id = a."lineItemId"
          WHERE a."cartId" = ANY($1::uuid[])
          ORDER BY a."createdAt" ASC, a.id ASC`,
        [cartIds]
      );
      allocations = allocRes.rows;
    }

    return NextResponse.json(
      {
        approvalAggregate: aggregate,
        carts: cartsRes.rows,
        allocations,
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

