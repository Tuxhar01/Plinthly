/**
 * Plinthly Stage 3 Phase 5 — Relational Cart Allocation API Route
 *
 * POST /api/cart/allocate
 *
 * Persists deterministic multi-retailer cart allocation across merchant carts,
 * creating ProcurementPlan, ProcurementLineItems, ApprovalAggregate,
 * ApprovedMerchantCarts, and CartAllocations in an atomic PostgreSQL transaction.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody, requireActor, handleApiError } from "../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../lib/database/stage2-connection";
import {
  RelationalCartAllocationService,
  PersistAllocationInput,
} from "../../../../lib/workflow/relational-cart-allocation-service";

const cartAllocationItemSchema = z.object({
  lineItemIndex: z.number().int().min(0),
  allocatedQuantity: z.number().int().positive(),
  allocatedUnitCents: z.union([z.number().int().nonnegative(), z.string()]),
});

const shipmentSchema = z.object({
  shippingCarrier: z.string().min(1),
  shippingTrackingNumber: z.string().optional(),
  shippingStatus: z.string().optional(),
});

const merchantCartSchema = z.object({
  merchantId: z.string().min(1),
  merchantPayeeEmail: z.string().email(),
  merchandiseSubtotalCents: z.union([z.number().int().nonnegative(), z.string()]),
  discountCents: z.union([z.number().int().nonnegative(), z.string()]).default(0),
  shippingTotalCents: z.union([z.number().int().nonnegative(), z.string()]).default(0),
  taxAmountCents: z.union([z.number().int().nonnegative(), z.string()]).default(0),
  totalCartCents: z.union([z.number().int().nonnegative(), z.string()]),
  currency: z.string().default("USD"),
  paypalOrderId: z.string().optional(),
  allocations: z.array(cartAllocationItemSchema).min(1),
  shipments: z.array(shipmentSchema).optional(),
});

const lineItemSchema = z.object({
  itemDescription: z.string().min(1),
  targetQuantity: z.number().int().positive(),
  maxUnitCents: z.union([z.number().int().positive(), z.string()]),
});

const allocateCartRequestSchema = z.object({
  userId: z.string().optional(),
  strategy: z.string().min(1),
  planLifecycleStatus: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1),
  carts: z.array(merchantCartSchema).min(1),
  snapshotPayload: z.record(z.string(), z.unknown()).optional(),
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
    const input = allocateCartRequestSchema.parse(jsonResult.data);

    // 4. Connect to Stage 2 database
    dbClient = await createStage2ApiClient();

    // 5. Execute Relational Cart Allocation Service
    const service = new RelationalCartAllocationService(dbClient);
    const userId =
      input.userId ||
      (actorResult.actor.kind === "user" ? actorResult.actor.userId : "usr_buyer_1");

    const payload: PersistAllocationInput = {
      userId,
      strategy: input.strategy,
      planLifecycleStatus: input.planLifecycleStatus || "ACTIVE",
      lineItems: input.lineItems.map((li) => ({
        itemDescription: li.itemDescription,
        targetQuantity: li.targetQuantity,
        maxUnitCents: BigInt(li.maxUnitCents),
      })),
      carts: input.carts.map((c) => ({
        merchantId: c.merchantId,
        merchantPayeeEmail: c.merchantPayeeEmail,
        merchandiseSubtotalCents: BigInt(c.merchandiseSubtotalCents),
        discountCents: BigInt(c.discountCents),
        shippingTotalCents: BigInt(c.shippingTotalCents),
        taxAmountCents: BigInt(c.taxAmountCents),
        totalCartCents: BigInt(c.totalCartCents),
        currency: c.currency,
        paypalOrderId: c.paypalOrderId,
        allocations: c.allocations.map((a) => ({
          lineItemIndex: a.lineItemIndex,
          allocatedQuantity: a.allocatedQuantity,
          allocatedUnitCents: BigInt(a.allocatedUnitCents),
        })),
        shipments: c.shipments,
      })),
      snapshotPayload: input.snapshotPayload,
    };

    const result = await service.persistAllocation(payload);

    return NextResponse.json(
      {
        success: true,
        planId: result.planId,
        approvalAggregateId: result.approvalAggregateId,
        cartIds: result.cartIds,
        allocationCount: result.allocationCount,
        snapshotDigestHex: result.snapshotDigestHex,
      },
      { status: 201 }
    );
  } catch (err: any) {
    if (
      err.name === "AllocationIntegrityError" ||
      err.code === "ERR_UNALLOCATED_QUANTITY" ||
      err.code === "ERR_LINE_ITEM_COVERAGE_MISMATCH" ||
      err.code === "ERR_UNIT_PRICE_CAP_EXCEEDED" ||
      err.code === "ERR_DUPLICATE_ALLOCATION"
    ) {
      return NextResponse.json(
        { error: { code: err.code || "ERR_ALLOCATION_INTEGRITY", message: err.message } },
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
