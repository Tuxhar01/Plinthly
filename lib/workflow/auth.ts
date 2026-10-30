import { Actor } from "../state/types";
import { WorkflowError, UnauthorizedError, ForbiddenError } from "./errors";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export { UnauthorizedError, ForbiddenError };

export type AuthMode = "local_demo" | "production";

export interface ResolvedActorResult {
  readonly ok: boolean;
  readonly actor?: Actor;
  readonly authMode: AuthMode;
  readonly error?: WorkflowError;
}

export interface ActorResolver {
  resolveActor(request: Request): Promise<ResolvedActorResult>;
}

export interface JudgeSessionClaims {
  readonly sub: string;
  readonly sessionId: string;
  readonly role: "judge_evaluator";
  readonly iat: number;
  readonly exp: number;
}

export function getJudgeSessionSecret(): string {
  const secret =
    process.env.JUDGE_SESSION_SECRET?.trim() ||
    process.env.CONFIRMATION_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "JUDGE_SESSION_SECRET or CONFIRMATION_SIGNING_SECRET must be at least 32 characters."
    );
  }
  return secret;
}

export function createJudgeSessionToken(sessionId: string, ttlSeconds = 86400): string {
  const secret = getJudgeSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const claims: JudgeSessionClaims = {
    sub: `judge_${sessionId}`,
    sessionId,
    role: "judge_evaluator",
    iat: now,
    exp: now + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function verifyJudgeSessionToken(token: string): JudgeSessionClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadB64, signature] = parts;
    if (!payloadB64 || !signature) return null;

    const secret = getJudgeSessionSecret();
    const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const sigBuf = Buffer.from(signature, "base64url");
    const expBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as JudgeSessionClaims;
    if (!claims.sub || !claims.sessionId || !claims.exp) return null;
    if (Math.floor(Date.now() / 1000) >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

function verifySecretTimingSafe(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Returns the currently active auth mode from validated environment configuration.
 * Default is strictly "production" (fail-closed).
 */
export function getAuthMode(): AuthMode {
  // Production fail-closed guarantee: NODE_ENV=production must never activate local_demo
  if (process.env.NODE_ENV === "production") {
    return "production";
  }

  const envMode = process.env.AUTH_MODE?.trim().toLowerCase();
  const demoFlag = process.env.ENABLE_LOCAL_DEMO_AUTH?.trim().toLowerCase();

  if (envMode === "local_demo" || demoFlag === "true") {
    return "local_demo";
  }

  return "production";
}

/**
 * Server-side actor resolution.
 *
 * In local_demo mode:
 * Resolves actor from client headers with fallback to "local_dev_user".
 * Strictly labeled for local demonstration only.
 *
 * In production mode (default):
 * Rejects untrusted client headers. Checks signed judge session token in cookie or header.
 * Requests without valid credentials strictly fail closed.
 */
export class ServerActorResolver implements ActorResolver {
  constructor(private readonly authMode: AuthMode = getAuthMode()) {}

  async resolveActor(request: Request): Promise<ResolvedActorResult> {
    const headers = request.headers;

    // Production mode authentication
    if (this.authMode !== "local_demo") {
      // 1. Check for cryptographically signed judge session token in cookie or header
      const cookieHeader = headers.get("cookie");
      const sessionFromCookie = extractCookie(cookieHeader, "plinthly_judge_session");
      const sessionFromHeader = headers.get("x-judge-session-token")?.trim();

      const candidateSessionToken = sessionFromCookie || sessionFromHeader;
      if (candidateSessionToken) {
        const claims = verifyJudgeSessionToken(candidateSessionToken);
        if (claims) {
          return {
            ok: true,
            authMode: "production",
            actor: {
              kind: "user",
              userId: claims.sub,
            },
          };
        }
      }

      // 2. Check for root judge credential in Authorization Bearer or x-judge-access-token
      const configuredSecret = process.env.JUDGE_ACCESS_SECRET?.trim();
      const authHeader = headers.get("authorization")?.trim();
      let suppliedSecret: string | undefined;
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        suppliedSecret = authHeader.slice(7).trim();
      } else {
        suppliedSecret = headers.get("x-judge-access-token")?.trim();
      }

      // If bearer token is itself a signed session token, verify it
      if (suppliedSecret) {
        const sessionClaims = verifyJudgeSessionToken(suppliedSecret);
        if (sessionClaims) {
          return {
            ok: true,
            authMode: "production",
            actor: {
              kind: "user",
              userId: sessionClaims.sub,
            },
          };
        }
      }

      // Direct judge access secret presented (e.g. CLI or integration test runner)
      if (configuredSecret && suppliedSecret && verifySecretTimingSafe(suppliedSecret, configuredSecret)) {
        const rawSession = headers.get("x-judge-session-id")?.trim();
        const sessionSuffix = rawSession ? rawSession.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) : "evaluator";
        return {
          ok: true,
          authMode: "production",
          actor: {
            kind: "user",
            userId: `judge_${sessionSuffix}`,
          },
        };
      }

      return {
        ok: false,
        authMode: "production",
        error: new UnauthorizedError(
          "Authentication required. Untrusted actor headers are rejected in deployment mode. Please provide valid judge or evaluator credentials."
        ),
      };
    }

    // In local_demo mode:
    // If a valid judge session token is provided, respect it
    const cookieHeader = headers.get("cookie");
    const sessionFromCookie = extractCookie(cookieHeader, "plinthly_judge_session");
    const sessionFromHeader = headers.get("x-judge-session-token")?.trim();
    const candidateSessionToken = sessionFromCookie || sessionFromHeader;
    if (candidateSessionToken) {
      const claims = verifyJudgeSessionToken(candidateSessionToken);
      if (claims) {
        return {
          ok: true,
          authMode: "local_demo",
          actor: {
            kind: "user",
            userId: claims.sub,
          },
        };
      }
    }

    const actorId = headers.get("x-actor-id")?.trim();
    const actorKind = headers.get("x-actor-kind")?.trim().toLowerCase();
    const component = headers.get("x-actor-component")?.trim();

    if (actorKind === "system") {
      return {
        ok: true,
        authMode: "local_demo",
        actor: {
          kind: "system",
          component: component || actorId || "system_workflow_engine",
        },
      };
    }

    return {
      ok: true,
      authMode: "local_demo",
      actor: {
        kind: "user",
        userId: actorId || "local_dev_user",
      },
    };
  }
}

let globalActorResolver: ActorResolver = new ServerActorResolver();

export function getActorResolver(): ActorResolver {
  return globalActorResolver;
}

export function setActorResolver(resolver: ActorResolver): void {
  globalActorResolver = resolver;
}

/**
 * Enforces server-side authorization: verifies that the resolved actor is permitted
 * to view or mutate the target purchase.
 */
export function assertPurchaseAccess(
  actor: Actor,
  purchaseOwnerUserId: string,
  operation: "read" | "approve" | "evaluate" | "audit" | "create_order" | "confirm_approval" | "verify_payment"
): void {
  if (actor.kind === "user") {
    if (actor.userId !== purchaseOwnerUserId) {
      throw new ForbiddenError(
        `User "${actor.userId}" is not authorized to ${operation} purchase owned by "${purchaseOwnerUserId}".`
      );
    }
  } else if (actor.kind === "system") {
    if (operation === "approve") {
      throw new ForbiddenError("System actors cannot approve purchases; user approval is strictly required.");
    }
  }
}

export type { Actor };
