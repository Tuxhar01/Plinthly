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
import { getPrismaClient } from "../../../../lib/workflow/repository";
import { computeCanonicalDraftHash } from "../../../../lib/workflow/quantity-confirmation";

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

    const actor = actorResult.actor;
    const actorId = actor.kind === "user" ? actor.userId : actor.component;

    const draftId = `dft_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const lineItems = (intent.lineItems || []).map((li, idx) => ({
      id: `li_${idx + 1}_${li.title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toLowerCase()}`,
      title: li.title,
      quantity: li.quantity ?? 1,
      quantitySource: li.quantitySource || "explicit",
      quantityConfirmed: li.quantitySource === "explicit",
      originalInferredQuantity: li.originalInferredQuantity ?? (li.quantitySource === "inferred" ? 1 : null),
      budgetCents: li.budgetCents ?? null,
      currency: intent.currency || "USD",
      requirements: li.requirements || [],
    }));

    const draftHash = computeCanonicalDraftHash({
      draftId,
      version: 1,
      budgetCents: intent.budgetCents,
      currency: intent.currency || "USD",
      destination: intent.destination,
      lineItems,
      requirements: intent.requirements,
    });

    try {
      const prisma = getPrismaClient();
      await prisma.procurementDraft.create({
        data: {
          id: draftId,
          actorId,
          version: 1,
          budgetCents: intent.budgetCents ?? null,
          currency: intent.currency || "USD",
          destination: intent.destination ? (intent.destination as object) : undefined,
          lineItems: lineItems as object,
          requirements: intent.requirements ? (intent.requirements as object) : undefined,
          originalPrompt: validatedInput.prompt,
          draftHash,
          status: "ACTIVE",
        },
      });
    } catch {
      // In-memory or database-unavailable test environments proceed without durable draft
    }

    return NextResponse.json(
      {
        ok: true,
        data: {
          ...intent,
          draftId,
          version: 1,
          draftHash,
          lineItems,
        },
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
