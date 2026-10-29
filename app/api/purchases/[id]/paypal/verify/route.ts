import { NextResponse } from "next/server";
import { getPurchaseWorkflowService } from "../../../../../../lib/workflow/service";
import { requireActor, handleApiError, resolveRouteParams } from "../../../../../../lib/workflow/api-helpers";

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

    const service = getPurchaseWorkflowService();
    const result = await service.verifyPayPalPayment(id, actorResult.actor);

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
