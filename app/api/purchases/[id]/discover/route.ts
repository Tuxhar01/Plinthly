import { NextResponse } from "next/server";
import { purchaseDiscoverSchema } from "../../../../../lib/workflow/validation";
import { Channel3SourceAdapter } from "../../../../../lib/discovery/channel3-adapter";
import { getPurchaseRepository } from "../../../../../lib/workflow/repository";
import {
  handleApiError,
  parseJsonBody,
  resolveRouteParams,
  requireActor,
} from "../../../../../lib/workflow/api-helpers";

interface RouteParams {
  id: string;
}

/**
 * POST /api/purchases/[id]/discover
 * Authenticated product discovery endpoint using Channel3 behind SourceAdapter abstraction.
 *
 * Security & Integrity:
 * - Requires verified actor authentication.
 * - Enforces bounded search queries and constraints.
 * - Does not expose raw upstream tokens or unrestricted proxies.
 * - Does not silently fall back to synthetic fixtures.
 * - Does NOT create purchases, approvals, or PayPal orders.
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

    const validatedInput = purchaseDiscoverSchema.parse(jsonResult.data);

    let effectiveConstraints = validatedInput.constraints;
    try {
      const repo = getPurchaseRepository();
      const aggregate = await repo.getPurchaseById(id);
      if (aggregate) {
        const auditEvents = await repo.getAuditHistory(id);
        const proposed = auditEvents.find((e) => e.type === "proposed");
        const proposedPayload = proposed?.payload as
          | { destination?: import("../../../../../lib/discovery/shipping").DestinationContext; requestedQuantity?: number }
          | undefined;

        const dest = validatedInput.constraints?.destination ?? proposedPayload?.destination;
        const maxBudgetCents =
          validatedInput.constraints?.maxBudgetCents ?? aggregate.purchase.budgetCents;
        const minQuantity =
          validatedInput.constraints?.minQuantity ?? proposedPayload?.requestedQuantity ?? 1;

        let requiredAttributes = validatedInput.constraints?.requiredAttributes;
        if (!requiredAttributes && Array.isArray(aggregate.purchase.requirements)) {
          requiredAttributes = aggregate.purchase.requirements
            .map((r: unknown) => (typeof r === "string" ? r : (r as { key?: string })?.key))
            .filter((k: unknown): k is string => typeof k === "string" && k.length > 0);
        }

        effectiveConstraints = {
          ...validatedInput.constraints,
          destination: dest,
          maxBudgetCents,
          minQuantity,
          requiredAttributes,
        };
      }
    } catch {
      // Proceed gracefully with caller-supplied constraints if purchase lookup fails
    }

    const adapter = new Channel3SourceAdapter();
    const result = await adapter.search(
      {
        query: validatedInput.query,
        purchaseId: id,
        constraints: effectiveConstraints,
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
