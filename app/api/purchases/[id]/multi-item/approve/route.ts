import { NextResponse } from "next/server";
import { approveMultiItemPlanSchema } from "@/lib/workflow/validation";
import { getPurchaseWorkflowService } from "@/lib/workflow/service";
import { ApproveMultiItemPlanRequest } from "@/lib/workflow/types";
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
 * POST /api/purchases/[id]/multi-item/approve
 * Approves a specific multi-item procurement strategy with cryptographic snapshot binding.
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

    const validatedInput = approveMultiItemPlanSchema.parse(jsonResult.data);
    const service = getPurchaseWorkflowService();

    const result = await service.approveMultiItemPlan(
      id,
      validatedInput as unknown as ApproveMultiItemPlanRequest,
      actorResult.actor
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
