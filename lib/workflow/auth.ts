import { Actor } from "../state/types";
import { WorkflowError, UnauthorizedError, ForbiddenError } from "./errors";
import { createHash, timingSafeEqual } from "node:crypto";

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

function verifySecretTimingSafe(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
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
 * Rejects untrusted client headers. If JUDGE_ACCESS_SECRET is configured,
 * verifies bearer/header credentials against the secret using timing-safe hashing
 * to assign an isolated judge tenant workspace (judge_<sessionId>).
 * Requests without valid credentials strictly fail closed.
 */
export class ServerActorResolver implements ActorResolver {
  constructor(private readonly authMode: AuthMode = getAuthMode()) {}

  async resolveActor(request: Request): Promise<ResolvedActorResult> {
    const headers = request.headers;

    // Production mode authentication
    if (this.authMode !== "local_demo") {
      const configuredSecret = process.env.JUDGE_ACCESS_SECRET?.trim();

      // Extract credentials from Authorization Bearer or x-judge-access-token
      const authHeader = headers.get("authorization")?.trim();
      let suppliedSecret: string | undefined;
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        suppliedSecret = authHeader.slice(7).trim();
      } else {
        suppliedSecret = headers.get("x-judge-access-token")?.trim();
      }

      if (configuredSecret && suppliedSecret && verifySecretTimingSafe(suppliedSecret, configuredSecret)) {
        // Deterministically partition evaluator workspace by session ID if provided
        const rawSession = headers.get("x-judge-session-id")?.trim() || "evaluator";
        const sanitizedSession = rawSession.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "evaluator";

        return {
          ok: true,
          authMode: "production",
          actor: {
            kind: "user",
            userId: `judge_${sanitizedSession}`,
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
