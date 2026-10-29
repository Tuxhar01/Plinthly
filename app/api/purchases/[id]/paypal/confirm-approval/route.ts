import { NextResponse } from "next/server";
import { getPurchaseWorkflowService } from "../../../../../../lib/workflow/service";
import { requireActor, handleApiError, resolveRouteParams, parseJsonBody } from "../../../../../../lib/workflow/api-helpers";
import { confirmBuyerApprovalSchema } from "../../../../../../lib/workflow/validation";

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

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    const validated = confirmBuyerApprovalSchema.parse(jsonResult.data);
    const service = getPurchaseWorkflowService();
    const result = await service.confirmBuyerApproval(id, actorResult.actor, validated);

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
