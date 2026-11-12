/**
 * Plinthly Stage 3 Phase 4 — Cart Refund API Route
 *
 * POST /api/cart/refund
 *
 * Executes gateway refund or webhook-provenance refund via R2-06 with
 * remaining balance validation and UUIDv4 idempotency key (PayPal-Request-Id).
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
import { RefundService } from "../../../../lib/workflow/refund-service";
import { getPaymentGatewayClient } from "../../../../lib/workflow/payment-gateway-adapter";

const refundRequestSchema = z.object({
  cartId: z.string().uuid("cartId must be a valid UUID"),
  amountCents: z.number().int().positive("amountCents must be a positive integer"),
  reason: z.string().min(1, "reason cannot be empty"),
  currency: z.string().length(3).optional().default("USD"),
  transmissionId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let dbClient: any = null;
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    const input = refundRequestSchema.parse(jsonResult.data);
    const headerKey = extractIdempotencyKeyHeader(request);
    const idempotencyKey = headerKey || input.idempotencyKey;

    if (!idempotencyKey && !input.transmissionId) {
      return NextResponse.json(
        {
          error: {
            code: "ERR_MISSING_IDEMPOTENCY_KEY",
            message: "Idempotency-Key header or idempotencyKey in body is required for gateway refunds.",
          },
        },
        { status: 400 }
      );
    }

    dbClient = await createStage2ApiClient("orchestrator_worker_user");

    const gateway = getPaymentGatewayClient();
    const service = new RefundService(dbClient, gateway, "audit_hmac_key_2026");

    if (input.transmissionId) {
      // Direct R2-06 execution with verified webhook transmission
      const result = await service.executeCartRefund({
        cartId: input.cartId,
        amountCents: input.amountCents,
        reason: input.reason,
        transmissionId: input.transmissionId,
      });

      return NextResponse.json(
        {
          success: true,
          type: "WEBHOOK_RECORDED",
          refundEvidenceId: result.refundEvidenceId,
          cartId: result.cartId,
          captureId: result.captureId,
          status: result.status,
          cumulativeRefundedCents: Number(result.cumulativeRefundedCents),
          recordedAt: result.recordedAt,
        },
        { status: 200 }
      );
    } else {
      // Gateway refund execution
      const result = await service.executeGatewayRefund({
        cartId: input.cartId,
        amountCents: input.amountCents,
        reason: input.reason,
        currency: input.currency,
        idempotencyKey,
      });

      return NextResponse.json(
        {
          success: result.outcome === "COMPLETED",
          type: "GATEWAY_DISPATCHED",
          ...result,
        },
        { status: result.outcome === "COMPLETED" ? 200 : 400 }
      );
    }
  } catch (err: any) {
    if (err.message?.includes("ERR_CART_NOT_FOUND")) {
      return NextResponse.json(
        { error: { code: "ERR_CART_NOT_FOUND", message: err.message } },
        { status: 404 }
      );
    }
    if (
      err.message?.includes("ERR_REFUND_EXCEEDS_BALANCE") ||
      err.message?.includes("ERR_INVALID_TRANSITION") ||
      err.message?.includes("ERR_INVALID_REFUND_AMOUNT") ||
      err.message?.includes("ERR_CURRENCY_MISMATCH") ||
      err.message?.includes("ERR_MISSING_IDEMPOTENCY_KEY") ||
      err.message?.includes("ERR_IDEMPOTENCY_MISMATCH")
    ) {
      return NextResponse.json(
        { error: { code: "ERR_REFUND_REJECTED", message: err.message } },
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

