import { NextResponse } from "next/server";
import { getPurchaseWorkflowService } from "../../../../../../lib/workflow/service";
import { requireActor, handleApiError, resolveRouteParams, extractIdempotencyKeyHeader } from "../../../../../../lib/workflow/api-helpers";
import { createPayPalOrderSchema } from "../../../../../../lib/workflow/validation";

export async function POST(
  request: Request,
  context: { params?: Promise<{ id: string }> | { id: string } }
) {
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const { id } = await resolveRouteParams(context);
    if (!id || id.trim().length === 0) {
      return NextResponse.json(
        { error: { code: "invalid_input", message: "Purchase ID parameter is required." } },
        { status: 400 }
      );
    }

    let bodyData: unknown = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) {
        bodyData = JSON.parse(text);
      }
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_json", message: "Malformed JSON request body." } },
        { status: 400 }
      );
    }

    const validated = createPayPalOrderSchema.parse(bodyData);
    const headerIdempotencyKey = extractIdempotencyKeyHeader(request);
    const idempotencyKey = headerIdempotencyKey || validated.idempotencyKey;

    const service = getPurchaseWorkflowService();
    const result = await service.createPayPalOrder(id, actorResult.actor, {
      idempotencyKey,
      targetCartMerchantDomain: validated.targetCartMerchantDomain,
      destination: validated.destination,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
