import { NextResponse } from "next/server";
import { discoverProductsSchema } from "../../../../lib/workflow/validation";
import { Channel3SourceAdapter } from "../../../../lib/discovery/channel3-adapter";
import {
  handleApiError,
  parseJsonBody,
  requireActor,
} from "../../../../lib/workflow/api-helpers";
import {
  discoverySearchLimiter,
  enforceRateLimit,
} from "../../../../lib/workflow/rate-limiter";

/**
 * POST /api/discovery/search
 * Authenticated product discovery endpoint using Channel3.
 */
export async function POST(request: Request) {
  try {
    const rateCheck = enforceRateLimit(discoverySearchLimiter, request, "product_discovery");
    if (!rateCheck.ok) {
      return rateCheck.response;
    }

    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    const validatedInput = discoverProductsSchema.parse(jsonResult.data);

    const adapter = new Channel3SourceAdapter();
    const result = await adapter.search(
      {
        query: validatedInput.query,
        purchaseId: validatedInput.purchaseId,
        constraints: validatedInput.constraints,
      },
      { now: new Date() }
    );

    if (result.status === "source_error") {
      const httpStatus =
        result.errorCode === "CHANNEL3_NOT_CONFIGURED"
          ? 503
          : result.errorCode === "CHANNEL3_RATE_LIMITED"
          ? 429
          : result.errorCode === "CHANNEL3_VALIDATION_ERROR"
          ? 400
          : 502;

      return NextResponse.json(
        {
          error: {
            code: result.errorCode,
            message: result.errorMessage,
          },
          result,
        },
        { status: httpStatus }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
