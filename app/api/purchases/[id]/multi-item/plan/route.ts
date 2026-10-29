import { NextResponse } from "next/server";
import { createMultiItemPlanSchema } from "@/lib/workflow/validation";
import { getPurchaseWorkflowService } from "@/lib/workflow/service";
import { CreateMultiItemPlanRequest } from "@/lib/workflow/types";
import {
  handleApiError,
  parseJsonBody,
  resolveRouteParams,
  requireActor,
} from "@/lib/workflow/api-helpers";

interface RouteParams {
  id: string;
}

/**
 * POST /api/purchases/[id]/multi-item/plan
 * Generates and evaluates multi-item procurement strategies, cart groupings, split shipments, and defensible landed costs.
 */
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

    const validatedInput = createMultiItemPlanSchema.parse(jsonResult.data);
    const service = getPurchaseWorkflowService();

    const result = await service.createMultiItemPlan(
      id,
      validatedInput as unknown as CreateMultiItemPlanRequest,
      actorResult.actor
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
