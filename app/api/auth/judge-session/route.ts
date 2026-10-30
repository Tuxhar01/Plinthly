import { NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createJudgeSessionToken } from "../../../../lib/workflow/auth";
import {
  enforceRateLimit,
  judgeSessionLimiter,
} from "../../../../lib/workflow/rate-limiter";

function verifySecretTimingSafe(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

export async function POST(request: Request) {
  try {
    const rateCheck = enforceRateLimit(judgeSessionLimiter, request, "judge_session");
    if (!rateCheck.ok) {
      return rateCheck.response;
    }

    const configuredSecret = process.env.JUDGE_ACCESS_SECRET?.trim();
    if (!configuredSecret) {
      return NextResponse.json(
        { ok: false, error: { code: "not_configured", message: "JUDGE_ACCESS_SECRET is not configured on the server." } },
        { status: 500 }
      );
    }

    const authHeader = request.headers.get("authorization")?.trim();
    let suppliedSecret: string | undefined;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      suppliedSecret = authHeader.slice(7).trim();
    } else {
      suppliedSecret = request.headers.get("x-judge-access-token")?.trim();
    }

    if (!suppliedSecret || !verifySecretTimingSafe(suppliedSecret, configuredSecret)) {
      return NextResponse.json(
        { ok: false, error: { code: "unauthorized", message: "Invalid judge access credentials." } },
        { status: 401 }
      );
    }

    // Generate random server-controlled session ID
    const sessionId = "sess_" + randomBytes(16).toString("hex");
    const sessionToken = createJudgeSessionToken(sessionId);
    const actorId = `judge_${sessionId}`;

    // Return session metadata only; keep the raw cryptographic token inside the HTTP-only cookie
    const response = NextResponse.json(
      {
        ok: true,
        data: {
          sessionId,
          actorId,
        },
      },
      { status: 200 }
    );

    // Set HTTP-only secure session cookie inaccessible to browser JavaScript
    response.cookies.set("plinthly_judge_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 86400, // 24 hours
    });

    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal authentication error";
    return NextResponse.json({ ok: false, error: { code: "internal_error", message } }, { status: 500 });
  }
}

