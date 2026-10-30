import { NextResponse } from "next/server";
import { getPrismaClient } from "../../../../../../lib/workflow/repository";
import { requireActor, parseJsonBody, handleApiError } from "../../../../../../lib/workflow/api-helpers";
import {
  batchConfirmQuantitySchema,
  computeTokenHash,
  generateTokenJti,
  signQuantityConfirmation,
  QuantityConfirmationClaims,
} from "../../../../../../lib/workflow/quantity-confirmation";
import { ProcurementLineItem } from "../../../../../../lib/discovery/cart/types";

interface RouteParams {
  params: Promise<{ draftId: string }>;
}

export async function POST(request: Request, props: RouteParams) {
  try {
    const actorResult = await requireActor(request);
    if (!actorResult.ok) return actorResult.response;

    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) return jsonResult.response;

    const { draftId } = await props.params;
    const validated = batchConfirmQuantitySchema.parse({
      draftId,
      ...(jsonResult.data as Record<string, unknown>),
    });

    const prisma = getPrismaClient();
    const actorId = actorResult.actor.kind === "user" ? actorResult.actor.userId : actorResult.actor.component;
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const ttlSeconds = 3600; // 1 hour expiration window

    const result = await prisma.$transaction(async (tx) => {
      // 1. Acquire row lock on draft
      const rows = await tx.$queryRaw<Array<{
        id: string;
        actorId: string;
        version: number;
        budgetCents: number | null;
        currency: string;
        destination: unknown;
        lineItems: unknown;
        requirements: unknown;
        draftHash: string;
        status: string;
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
        throw new Error(`forbidden: Actor "${actorId}" is not authorized to confirm draft owned by "${draft.actorId}".`);
      }

      if (draft.status !== "ACTIVE" && draft.status !== "CONFIRMED") {
        throw new Error(`draft_conflict: Draft is in "${draft.status}" status and cannot be confirmed.`);
      }

      const lineItems = (draft.lineItems as ProcurementLineItem[]) || [];

      // Identify which line items need confirmation
      const unconfirmedItems = lineItems.filter(
        (li) =>
          li.quantityConfirmed === false ||
          li.quantitySource === "inferred" ||
          li.quantitySource === "unresolved" ||
          li.quantitySource === "manual_override"
      );

      const confirmationsMap = new Map(
        validated.confirmations.map((c) => [c.lineItemId, c.confirmedQuantity])
      );

      // Verify all unconfirmed items are covered
      for (const item of unconfirmedItems) {
        if (!confirmationsMap.has(item.id)) {
          throw new Error(
            `validation_error: Missing confirmation for unconfirmed line item "${item.id}" (${item.title}).`
          );
        }
      }

      // Invalidate existing confirmations for this draft version before writing new batch
      await tx.quantityConfirmation.deleteMany({
        where: { draftId: draft.id },
      });

      const issuedTokens: Array<{
        lineItemId: string;
        confirmedQuantity: number;
        tokenJti: string;
        token: string;
        expiresAt: string;
      }> = [];

      // Create new confirmation records
      for (const conf of validated.confirmations) {
        const item = lineItems.find((li) => li.id === conf.lineItemId);
        if (!item) {
          throw new Error(`validation_error: Line item "${conf.lineItemId}" does not exist in draft.`);
        }

        if (item.quantity !== conf.confirmedQuantity) {
          throw new Error(
            `validation_error: Confirmed quantity (${conf.confirmedQuantity}) for "${item.id}" does not match draft line item quantity (${item.quantity}). Update the draft first.`
          );
        }

        const tokenJti = generateTokenJti();
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

        const claims: QuantityConfirmationClaims = {
          jti: tokenJti,
          draftId: draft.id,
          draftVersion: draft.version,
          draftHash: draft.draftHash,
          lineItemId: item.id,
          confirmedQuantity: conf.confirmedQuantity,
          originalInferredQuantity: item.originalInferredQuantity ?? null,
          quantitySource: item.quantitySource || "inferred",
          actorId,
          iat: nowSec,
          exp: nowSec + ttlSeconds,
          confirmedAt: now.toISOString(),
        };

        const token = signQuantityConfirmation(claims);
        const tokenHash = computeTokenHash(token);

        await tx.quantityConfirmation.create({
          data: {
            draftId: draft.id,
            lineItemId: item.id,
            actorId,
            confirmedQuantity: conf.confirmedQuantity,
            originalInferredQuantity: item.originalInferredQuantity ?? null,
            quantitySource: item.quantitySource || "inferred",
            draftHash: draft.draftHash,
            draftVersion: draft.version,
            tokenJti,
            tokenHash,
            expiresAt,
          },
        });

        issuedTokens.push({
          lineItemId: item.id,
          confirmedQuantity: conf.confirmedQuantity,
          tokenJti,
          token,
          expiresAt: expiresAt.toISOString(),
        });
      }

      // Update draft status to CONFIRMED
      await tx.procurementDraft.update({
        where: { id: draft.id },
        data: {
          status: "CONFIRMED",
          updatedAt: now,
        },
      });

      return {
        draftId: draft.id,
        draftVersion: draft.version,
        draftHash: draft.draftHash,
        status: "CONFIRMED",
        confirmedAt: now.toISOString(),
        confirmations: issuedTokens,
      };
    });

    return NextResponse.json({ ok: true, data: result }, { status: 200 });
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
    if (msg.startsWith("validation_error:")) {
      return NextResponse.json({ ok: false, error: { code: "validation_error", message: msg } }, { status: 400 });
    }
    return handleApiError(err);
  }
}

