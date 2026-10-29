import { NextResponse } from "next/server";
import { evaluatePurchaseSchema } from "../../../../../lib/workflow/validation";
import { getPurchaseWorkflowService } from "../../../../../lib/workflow/service";
import {
  handleApiError,
  parseJsonBody,
  resolveRouteParams,
  requireActor,
} from "../../../../../lib/workflow/api-helpers";

interface RouteParams {
  id: string;
}

export async function POST(
  request: Request,
  context: { params: Promise<RouteParams> | RouteParams }
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

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    const validatedInput = evaluatePurchaseSchema.parse(jsonResult.data);
    const service = getPurchaseWorkflowService();

    const result = await service.evaluatePurchaseCandidate(id, validatedInput, actorResult.actor);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
