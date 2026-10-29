import { NextResponse } from "next/server";
import { getPurchaseWorkflowService } from "../../../../lib/workflow/service";
import { handleApiError, resolveRouteParams, requireActor } from "../../../../lib/workflow/api-helpers";

interface RouteParams {
  id: string;
}

export async function GET(
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

    const service = getPurchaseWorkflowService();
    const purchase = await service.getPurchase(id, actorResult.actor);
    return NextResponse.json(purchase, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
