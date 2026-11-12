/**
 * Plinthly Stage 2 Phase 5 — Statutory Tax Quote Ingress API Route
 *
 * POST /api/cart/quote-tax
 *
 * Ingresses, cryptographically verifies, and relationally persists external
 * statutory tax quotes for ApprovedMerchantCart entities under Model A.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody, requireActor, handleApiError } from "../../../../lib/workflow/api-helpers";
import { createStage2ApiClient } from "../../../../lib/database/stage2-connection";
import { TaxProviderIngressWorker } from "../../../../lib/workers/tax-ingress-worker";
import { TEST_ROOT_CA_PEM } from "../../../../tests/fixtures/test-certificates";

const quoteTaxRequestSchema = z.object({
  cartId: z.string().uuid("cartId must be a valid UUID"),
  authorityId: z.string().min(1, "authorityId cannot be empty"),
  certificateNumber: z.string().min(1, "certificateNumber cannot be empty"),
  providerLeafCertPem: z.string().min(1, "providerLeafCertPem cannot be empty"),
  expectedHost: z.string().optional(),
  rawWirePayload: z.union([z.string(), z.record(z.string(), z.unknown())]),
  statutorySignature: z.string().min(1, "statutorySignature cannot be empty"),
  statutorySignatureAlgorithm: z.enum(["RSA-SHA256", "ECDSA-P256"]),
  nonceOverride: z.string().optional(),
  timestampOverride: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let dbClient: any = null;
  try {
    // 1. Enforce Authentication
    const actorResult = await requireActor(request);
    if (!actorResult.ok) {
      return actorResult.response;
    }

    // 2. Parse JSON Request Body
    const jsonResult = await parseJsonBody(request);
    if (!jsonResult.ok) {
      return jsonResult.response;
    }

    // 3. Validate Request Schema
    const input = quoteTaxRequestSchema.parse(jsonResult.data);

    // 4. Normalize Raw Wire Payload and Signature Buffers
    let rawWireBuffer: Buffer;
    if (typeof input.rawWirePayload === "string") {
      // Check if base64 encoded or raw JSON string
      if (input.rawWirePayload.trim().startsWith("{")) {
        rawWireBuffer = Buffer.from(input.rawWirePayload, "utf8");
      } else {
        rawWireBuffer = Buffer.from(input.rawWirePayload, "base64");
      }
    } else {
      rawWireBuffer = Buffer.from(JSON.stringify(input.rawWirePayload), "utf8");
    }

    let signatureBuffer: Buffer;
    if (/^[0-9a-fA-F]+$/.test(input.statutorySignature) && input.statutorySignature.length % 2 === 0) {
      signatureBuffer = Buffer.from(input.statutorySignature, "hex");
    } else {
      signatureBuffer = Buffer.from(input.statutorySignature, "base64");
    }

    // 5. Connect as tax_worker_01 (tax_verifier_role)
    dbClient = await createStage2ApiClient("tax_worker_01");

    // 6. Initialize Ingress Worker
    const worker = new TaxProviderIngressWorker({
      workerInstanceId: "worker_api_tax01",
      workerPrincipal: "tax_worker_01",
      attestationKeyId: "vak_tax_worker_p3_01",
      workerPublicKeyDer: Buffer.alloc(64, 1),
      workerSigningAlgorithm: "ECDSA-P256-SHA256",
      pinnedTrustAnchors: [
        {
          authorityId: input.authorityId,
          rootCertPem: TEST_ROOT_CA_PEM,
        },
      ],
      internalHmacKeyId: "audit_hmac_key_p3",
    });

    // 7. Process Statutory Quote
    const result = await worker.processStatutoryQuote({
      cartId: input.cartId,
      authorityId: input.authorityId,
      certificateNumber: input.certificateNumber,
      providerLeafCertPem: input.providerLeafCertPem,
      expectedHost: input.expectedHost,
      rawWirePayload: rawWireBuffer,
      statutorySignature: signatureBuffer,
      statutorySignatureAlgorithm: input.statutorySignatureAlgorithm,
      client: dbClient,
      nonceOverride: input.nonceOverride,
      timestampOverride: input.timestampOverride ? new Date(input.timestampOverride) : undefined,
    });

    return NextResponse.json(
      {
        evidenceId: result.evidenceId,
        cartId: result.cartId,
        taxQuoteId: result.taxQuoteId,
        totalTaxCents: result.totalTaxCents,
        status: result.status,
        recordedAt: result.recordedAt.toISOString(),
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err.code === "23505") {
      return NextResponse.json(
        { error: { code: "ERR_REPLAY_ATTACK_DETECTED", message: err.message } },
        { status: 409 }
      );
    }
    if (err.code === "P0002" || err.message?.includes("ERR_CART_NOT_FOUND")) {
      return NextResponse.json(
        { error: { code: "ERR_CART_NOT_FOUND", message: err.message } },
        { status: 404 }
      );
    }
    if (
      err.message?.includes("ERR_INVALID_PROVIDER_SIGNATURE") ||
      err.message?.includes("ERR_UNTRUSTED_ROOT_CA") ||
      err.message?.includes("ERR_UNSUPPORTED_ADJUSTMENT") ||
      err.message?.includes("ERR_PAYLOAD_NORMALIZATION_MISMATCH") ||
      err.code === "22023" ||
      err.code === "22004"
    ) {
      return NextResponse.json(
        { error: { code: "ERR_TAX_VALIDATION_FAILED", message: err.message } },
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

