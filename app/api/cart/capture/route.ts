/**
 * Plinthly Stage 2 Phase 5 — Cart Capture API Route
 *
 * POST /api/cart/capture
 *
 * Orchestrates sequential multi-retailer cart capture via R2-02, Payment Gateway,
 * and R2-05 under strict monotonic locking and idempotency protection.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireActor,
  extractIdempotencyKeyHeader,
  handleApiError,
} from "../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../lib/database/stage2-connection";
import { CartCaptureService } from "../../../../lib/workflow/cart-capture-service";
import { getPaymentGatewayClient } from "../../../../lib/workflow/payment-gateway-adapter";

const captureRequestSchema = z.object({
  approvalAggregateId: z.string().uuid("approvalAggregateId must be a valid UUID"),
  cartId: z.string().uuid("cartId must be a valid UUID").optional(),
  transmissionId: z.string().optional(),
  idempotencyKey: z.string().optional(),
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
    const input = captureRequestSchema.parse(jsonResult.data);
    const headerKey = extractIdempotencyKeyHeader(request);
    const idempotencyKey = headerKey || input.idempotencyKey;

    // 4. Connect as orchestrator_worker_user (app_orchestrator_role)
    dbClient = await createStage2ApiClient("orchestrator_worker_user");

    // 5. Initialize Gateway & Capture Service
    const gateway = getPaymentGatewayClient();
    const service = new CartCaptureService(dbClient, gateway, "audit_hmac_key_2026");

    // 6. Execute Single Cart or Multi-Cart Capture
    if (input.cartId) {
      const singleResult = await service.executeSingleCartCapture(
        input.cartId,
        input.approvalAggregateId,
        {
          transmissionId: input.transmissionId,
          idempotencyKey,
        }
      );

      return NextResponse.json(singleResult, { status: 200 });
    } else {
      const multiResult = await service.executeMultiCartCapture(input.approvalAggregateId);
      return NextResponse.json(multiResult, { status: 200 });
    }
  } catch (err: any) {
    if (err.message?.includes("ERR_CART_NOT_FOUND") || err.code === "P0002") {
      return NextResponse.json(
        { error: { code: "ERR_CART_NOT_FOUND", message: err.message } },
        { status: 404 }
      );
    }
    if (
      err.message?.includes("ERR_INVALID_TRANSITION") ||
      err.code === "55000" ||
      err.code === "22023" ||
      err.name === "LandedCostVarianceError"
    ) {
      return NextResponse.json(
        { error: { code: "ERR_INVALID_CAPTURE_STATE", message: err.message } },
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

