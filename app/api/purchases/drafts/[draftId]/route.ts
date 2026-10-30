import { NextResponse } from "next/server";
import { getPrismaClient } from "../../../../../lib/workflow/repository";
import { requireActor, parseJsonBody, handleApiError } from "../../../../../lib/workflow/api-helpers";
import { computeCanonicalDraftHash } from "../../../../../lib/workflow/quantity-confirmation";
import { ProcurementLineItem } from "../../../../../lib/discovery/cart/types";

interface RouteParams {
  params: Promise<{ draftId: string }>;
}

export async function GET(request: Request, props: RouteParams) {
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) return actorResult.response;

    const { draftId } = await props.params;
    const prisma = getPrismaClient();

    const draft = await prisma.procurementDraft.findUnique({
      where: { id: draftId },
      include: {
        confirmations: true,
      },
    });

    if (!draft) {
      return NextResponse.json(
        { ok: false, error: { code: "draft_not_found", message: `Procurement draft "${draftId}" not found.` } },
        { status: 404 }
      );
    }

    const actorId = actorResult.actor.kind === "user" ? actorResult.actor.userId : actorResult.actor.component;
    if (draft.actorId !== actorId) {
      return NextResponse.json(
        { ok: false, error: { code: "forbidden", message: "Actor does not own this procurement draft." } },
        { status: 403 }
      );
    }

    return NextResponse.json({ ok: true, data: draft }, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request, props: RouteParams) {
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) return actorResult.response;

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) return jsonResult.response;

    const { draftId } = await props.params;
    const prisma = getPrismaClient();
    const actorId = actorResult.actor.kind === "user" ? actorResult.actor.userId : actorResult.actor.component;
    const body = jsonResult.data as Record<string, unknown>;

    const updated = await prisma.$transaction(async (tx) => {
      // 1. Acquire row-level lock on ProcurementDraft
      const rows = await tx.$queryRaw<Array<{
        id: string;
        actorId: string;
        version: number;
        budgetCents: number | null;
        currency: string;
        destination: unknown;
        lineItems: unknown;
        requirements: unknown;
        originalPrompt: string | null;
        draftHash: string;
        status: string;
        createdAt: Date;
        updatedAt: Date;
      }>>`
        SELECT * FROM "ProcurementDraft"
        WHERE "id" = ${draftId}
        FOR UPDATE
      `;

      const draft = rows[0];
      if (!draft) {
        throw new Error(`draft_not_found: Procurement draft "${draftId}" not found.`);
      }

      if (draft.actorId !== actorId) {
        throw new Error(`forbidden: Actor "${actorId}" is not authorized to modify draft owned by "${draft.actorId}".`);
      }

      if (draft.status === "CONVERTED" || draft.status === "EXPIRED") {
        throw new Error(`draft_conflict: Draft is in "${draft.status}" status and cannot be modified.`);
      }

      const existingItems = (draft.lineItems as ProcurementLineItem[]) || [];
      let nextItems = existingItems;

      if (Array.isArray(body.lineItems)) {
        const incoming = body.lineItems as Array<Record<string, unknown>>;
        nextItems = incoming.map((item) => {
          const id = String(item.id || "");
          const prev = existingItems.find((p) => p.id === id);
          const newQty = typeof item.quantity === "number" ? item.quantity : (prev?.quantity ?? 1);
          const isQtyChanged = prev && prev.quantity !== newQty;

          let source = prev?.quantitySource || "explicit";
          let confirmed = prev?.quantityConfirmed ?? true;
          let origInferred = prev?.originalInferredQuantity ?? null;

          if (isQtyChanged) {
            source = "manual_override";
            confirmed = false;
            origInferred = prev?.quantity ?? origInferred;
          } else if (item.quantitySource && typeof item.quantitySource === "string") {
            source = item.quantitySource as typeof source;
          }

          return {
            ...prev,
            ...item,
            id,
            title: String(item.title || prev?.title || ""),
            quantity: newQty,
            quantitySource: source,
            quantityConfirmed: confirmed,
            originalInferredQuantity: origInferred,
            currency: String(item.currency || prev?.currency || draft.currency || "USD"),
          } as ProcurementLineItem;
        });
      }

      const nextBudgetCents = typeof body.budgetCents === "number" ? body.budgetCents : draft.budgetCents;
      const nextDestination = body.destination !== undefined ? body.destination : draft.destination;
      const nextVersion = draft.version + 1;

      // Invalidate existing confirmations for this draft
      await tx.quantityConfirmation.deleteMany({
        where: { draftId },
      });

      const nextHash = computeCanonicalDraftHash({
        draftId,
        version: nextVersion,
        budgetCents: nextBudgetCents,
        currency: draft.currency,
        destination: nextDestination,
        lineItems: nextItems,
        requirements: draft.requirements,
      });

      const result = await tx.procurementDraft.update({
        where: { id: draftId },
        data: {
          version: nextVersion,
          budgetCents: nextBudgetCents,
          destination: nextDestination as object,
          lineItems: nextItems as object,
          draftHash: nextHash,
          status: "ACTIVE", // Reset to ACTIVE upon any modification
          updatedAt: new Date(),
        },
      });

      return result;
    });

    return NextResponse.json({ ok: true, data: updated }, { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("draft_not_found:")) {
      return NextResponse.json({ ok: false, error: { code: "draft_not_found", message: msg } }, { status: 404 });
    }
    if (msg.startsWith("forbidden:")) {
      return NextResponse.json({ ok: false, error: { code: "forbidden", message: msg } }, { status: 403 });
    }
    if (msg.startsWith("draft_conflict:")) {
      return NextResponse.json({ ok: false, error: { code: "draft_conflict", message: msg } }, { status: 409 });
    }
    return handleApiError(err);
  }
}

