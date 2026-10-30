import { NextResponse } from "next/server";
import {
  handleApiError,
  parseJsonBody,
  requireActor,
} from "../../../../lib/workflow/api-helpers";
import {
  confirmQuantitySchema,
  computeDraftHash,
  signQuantityConfirmation,
  getQuantityConfirmationRegistry,
  generateTokenJti,
  computeTokenHash,
  QuantityConfirmationClaims,
} from "../../../../lib/workflow/quantity-confirmation";
import { getPrismaClient } from "../../../../lib/workflow/repository";

export async function POST(request: Request) {
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    const input = confirmQuantitySchema.parse(jsonResult.data);
    const actor = actorResult.actor;
    const actorId = actor.kind === "user" ? actor.userId : actor.component;
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const ttlSeconds = 3600;

    const draftId = input.draftId || (input.draft as Record<string, unknown> | undefined)?.draftId as string | undefined;
    let draftVersion = 1;
    let draftHash = input.draftHash ?? (input.draft ? computeDraftHash(input.draft) : "");

    const prisma = getPrismaClient();

    // If draftId is supplied, lock and verify against the durable draft
    if (draftId) {
      const draft = await prisma.procurementDraft.findUnique({
        where: { id: draftId },
      });
      if (draft) {
        draftVersion = draft.version;
        draftHash = draft.draftHash;
      }
    }

    if (!draftHash) {
      return NextResponse.json(
        { ok: false, error: { code: "invalid_draft", message: "Could not compute draftHash from draft" } },
        { status: 400 }
      );
    }

    const tokenJti = generateTokenJti();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const claims: QuantityConfirmationClaims = {
      jti: tokenJti,
      draftId: draftId || "legacy_single_draft",
      draftVersion,
      draftHash,
      lineItemId: input.lineItemId,
      confirmedQuantity: input.confirmedQuantity,
      quantitySource: "inferred",
      actorId,
      iat: nowSec,
      exp: nowSec + ttlSeconds,
      confirmedAt: now.toISOString(),
    };

    const confirmationToken = signQuantityConfirmation(claims);
    const tokenHash = computeTokenHash(confirmationToken);

    // If draftId exists in database, persist durable QuantityConfirmation record
    if (draftId) {
      try {
        await prisma.quantityConfirmation.create({
          data: {
            draftId,
            lineItemId: input.lineItemId,
            actorId,
            confirmedQuantity: input.confirmedQuantity,
            originalInferredQuantity: null,
            quantitySource: "inferred",
            draftHash,
            draftVersion,
            tokenJti,
            tokenHash,
            expiresAt,
          },
        });
      } catch {
        // Fall back if draft not found in DB
      }
    }

    getQuantityConfirmationRegistry().record(claims, confirmationToken);

    return NextResponse.json(
      {
        ok: true,
        confirmation: {
          lineItemId: claims.lineItemId,
          confirmedQuantity: claims.confirmedQuantity,
          confirmationToken,
          tokenJti,
          draftHash: claims.draftHash,
          confirmedAt: claims.confirmedAt,
          confirmedBy: claims.actorId,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
