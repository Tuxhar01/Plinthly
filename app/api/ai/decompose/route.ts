import { NextResponse } from "next/server";
import { decomposeRequestSchema } from "../../../../lib/ai/types";
import { decomposePurchaseIntent } from "../../../../lib/ai/intent-parser";
import {
  handleApiError,
  parseJsonBody,
  requireActor,
} from "../../../../lib/workflow/api-helpers";
import {
  aiDecompositionLimiter,
  enforceRateLimit,
} from "../../../../lib/workflow/rate-limiter";

export async function POST(request: Request) {
  try {
    const rateCheck = enforceRateLimit(aiDecompositionLimiter, request, "ai_decomposition");
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

    const validatedInput = decomposeRequestSchema.parse(jsonResult.data);
    const intent = await decomposePurchaseIntent(validatedInput.prompt);

    return NextResponse.json(
      {
        ok: true,
        data: intent,
      },
      {
        status: 200,
        headers: rateCheck.headers,
      }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
