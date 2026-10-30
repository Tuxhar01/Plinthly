import { NextResponse } from "next/server";
import { createPurchaseSchema } from "../../../lib/workflow/validation";
import { getPurchaseWorkflowService } from "../../../lib/workflow/service";
import {
  handleApiError,
  parseJsonBody,
  requireActor,
  extractIdempotencyKeyHeader,
} from "../../../lib/workflow/api-helpers";

export async function POST(request: Request) {
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    const validatedInput = createPurchaseSchema.parse(jsonResult.data);
    const headerKey = extractIdempotencyKeyHeader(request);
    const idempotencyKey = headerKey || validatedInput.idempotencyKey;

    const service = getPurchaseWorkflowService();
    const result = await service.createPurchase(
      { ...validatedInput, idempotencyKey },
      actorResult.actor,
      { workflowContext: "ai_decomposed" }
    );

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
