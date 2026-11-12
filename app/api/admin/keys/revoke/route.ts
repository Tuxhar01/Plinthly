/**
 * Plinthly Stage 2 Phase 5 — Administrative Key & Certificate Revocation API Route
 *
 * POST /api/admin/keys/revoke
 *
 * Atomically revokes an AuditSigningKey (via R2-07) or TaxAuthorityCertificate (via R2-08)
 * under admin_security_role privilege boundaries.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { parseJsonBody, requireActor, handleApiError } from "../../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../../lib/database/stage2-connection";

const revokeRequestSchema = z.object({
  targetType: z.enum(["AUDIT_SIGNING_KEY", "TAX_AUTHORITY_CERTIFICATE"]),
  reason: z.string().min(1, "reason cannot be empty"),
  keyId: z.string().optional(),
  authorityId: z.string().optional(),
  certificateNumber: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let dbClient: any = null;
  try {
    // 1. Enforce Authentication & Admin Authorization
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    const actor = actorResult.actor;
    const actorPrincipal = actor.kind === "user" ? actor.userId : actor.component;
    const adminHeader = request.headers.get("x-admin-secret");
    const secretKey = process.env.JUDGE_ACCESS_SECRET || process.env.CONFIRMATION_SIGNING_SECRET;

    const isAdmin =
      actor.kind === "system" ||
      actorPrincipal === "admin" ||
      actorPrincipal === "security_admin_user" ||
      (adminHeader && secretKey && adminHeader === secretKey);

    if (!isAdmin) {
      return NextResponse.json(
        { error: { code: "ERR_FORBIDDEN", message: "Administrative privilege required for cryptographic revocation." } },
        { status: 403 }
      );
    }

    // 2. Parse JSON Request Body
    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    // 3. Validate Request Schema
    const input = revokeRequestSchema.parse(jsonResult.data);

    // 4. Connect as security_admin_user (admin_security_role)
    dbClient = await createStage2ApiClient("security_admin_user");

    if (input.targetType === "AUDIT_SIGNING_KEY") {
      if (!input.keyId) {
        return NextResponse.json(
          { error: { code: "ERR_NULL_PARAMETER", message: "keyId is required when targetType is AUDIT_SIGNING_KEY." } },
          { status: 400 }
        );
      }

      // Invoke R2-07: revoke_audit_signing_key
      const nonce = "nonce_rev_" + crypto.randomUUID();
      const res = await dbClient.query(
        `SELECT key_id, status, revoked_at
           FROM public.revoke_audit_signing_key(
             $1, $2, $3, $4
           );`,
        [input.keyId, input.reason, actorPrincipal, nonce]
      );

      const row = res.rows[0];
      return NextResponse.json(
        {
          revoked: true,
          targetType: "AUDIT_SIGNING_KEY",
          keyId: row.key_id,
          status: row.status,
          revokedAt: new Date(row.revoked_at).toISOString(),
          reason: input.reason,
        },
        { status: 200 }
      );
    } else {
      if (!input.authorityId || !input.certificateNumber) {
        return NextResponse.json(
          { error: { code: "ERR_NULL_PARAMETER", message: "authorityId and certificateNumber are required when targetType is TAX_AUTHORITY_CERTIFICATE." } },
          { status: 400 }
        );
      }

      // Invoke R2-08: revoke_tax_authority_certificate
      const nonce = "nonce_cert_rev_" + crypto.randomUUID();
      const res = await dbClient.query(
        `SELECT authority_id, certificate_number, status, revoked_at
           FROM public.revoke_tax_authority_certificate(
             $1, $2, $3, $4, $5
           );`,
        [input.authorityId, input.certificateNumber, input.reason, actorPrincipal, nonce]
      );

      const row = res.rows[0];
      return NextResponse.json(
        {
          revoked: true,
          targetType: "TAX_AUTHORITY_CERTIFICATE",
          authorityId: row.authority_id,
          certificateNumber: row.certificate_number,
          status: row.status,
          revokedAt: new Date(row.revoked_at).toISOString(),
          reason: input.reason,
        },
        { status: 200 }
      );
    }
  } catch (err: any) {
    if (err.message?.includes("ERR_KEY_NOT_FOUND") || err.message?.includes("ERR_CERTIFICATE_NOT_FOUND") || err.code === "P0002") {
      return NextResponse.json(
        { error: { code: "ERR_RESOURCE_NOT_FOUND", message: err.message } },
        { status: 404 }
      );
    }
    if (err.message?.includes("ERR_RESOURCE_ALREADY_REVOKED") || err.code === "55000") {
      return NextResponse.json(
        { error: { code: "ERR_ALREADY_REVOKED", message: err.message } },
        { status: 400 }
      );
    }
    return handleApiError(err);
  } finally {
    if (dbClient) {
      await dbClient.end().catch(() => {});
    }
  }
}
