import { NextResponse } from "next/server";
import { resolveRouteParams, handleApiError } from "../../../../../../lib/workflow/api-helpers";

/**
 * PayPal Return Callback Bridge:
 * Redirects the returning browser to the application dashboard with untrusted query parameters.
 * Does not mutate purchase state, guess actor identity, or accept query params for authentication.
 * Authoritative verification and state transition are triggered by the dashboard via its
 * established authenticated context.
 */
export async function GET(
  request: Request,
  context: { params?: Promise<{ id: string }> | { id: string } }
) {
  try {
    const { id } = await resolveRouteParams(context);
    if (!id || id.trim().length === 0) {
      return NextResponse.json(
        { error: { code: "invalid_input", message: "Purchase ID parameter is required." } },
        { status: 400 }
      );
    }

    const url = new URL(request.url);
    const token = url.searchParams.get("token")?.trim();

    const acceptHeader = request.headers.get("accept") || "";
    const isJsonClient = acceptHeader.includes("application/json");

    if (!token) {
      if (isJsonClient) {
        return NextResponse.json(
          { error: { code: "missing_token", message: "Missing required PayPal order token parameter in return URL." } },
          { status: 400 }
        );
      }
      const errorUrl = new URL(`/?purchaseId=${encodeURIComponent(id)}&paypal_error=missing_token`, request.url);
      return NextResponse.redirect(errorUrl);
    }

    if (isJsonClient) {
      return NextResponse.json(
        {
          ok: true,
          bridged: true,
          purchaseId: id,
          paypalOrderId: token,
        },
        { status: 200 }
      );
    }

    // Redirect bridge back to dashboard passing untrusted callback parameters.
    // The dashboard client invokes the existing confirmation API using its established actor context.
    const redirectUrl = new URL(
      `/?purchaseId=${encodeURIComponent(id)}&paypal_token=${encodeURIComponent(token)}&paypal_status=approved`,
      request.url
    );
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    return handleApiError(err);
  }
}
