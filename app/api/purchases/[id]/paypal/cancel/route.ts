import { NextResponse } from "next/server";
import { getPurchaseWorkflowService } from "../../../../../../lib/workflow/service";
import { requireActor, handleApiError, resolveRouteParams } from "../../../../../../lib/workflow/api-helpers";

export async function GET(
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
    const purchase = await service.getPurchase(id, actorResult.actor);

    // Cancellation from PayPal checkout leaves approved terms, candidate snapshot, and purchase status intact.
    // It does not advance state to BUYER_APPROVED, does not attempt capture, and does not mark purchase as paid.
    const acceptHeader = request.headers.get("accept") || "";
    if (acceptHeader.includes("application/json")) {
      return NextResponse.json(
        {
          ok: true,
          cancelled: true,
          purchaseId: id,
          status: purchase.status,
          version: purchase.version,
        },
        { status: 200 }
      );
    }

    const redirectUrl = new URL(`/?purchaseId=${encodeURIComponent(id)}&paypal_status=cancelled`, request.url);
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    return handleApiError(err);
  }
}
