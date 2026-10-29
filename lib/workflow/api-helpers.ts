import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { WorkflowError } from "./service";
import { DatabaseUnavailableError } from "./repository";
import { getActorResolver } from "./auth";
import { Actor } from "../state/types";
import { AiError } from "../ai/intent-parser";

export async function parseJsonBody<T>(req: Request): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  try {
    const body = await req.json();
    return { ok: true, data: body as T };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: "invalid_json",
            message: "Malformed JSON request body.",
          },
        },
        { status: 400 }
      ),
    };
  }
}

/**
 * Resolves the authenticated actor or returns an explicit error response.
 * Enforces fail-closed behavior when in production mode or if unauthenticated.
 */
export async function requireActor(req: Request): Promise<{ ok: true; actor: Actor } | { ok: false; response: NextResponse }> {
  const resolver = getActorResolver();
  const result = await resolver.resolveActor(req);

  if (!result.ok || !result.actor) {
    const err = result.error;
    const statusCode = err?.statusCode ?? 401;
    const code = err?.code ?? "unauthorized";
    const message = err?.message ?? "Authentication required.";

    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code,
            message,
          },
        },
        { status: statusCode }
      ),
    };
  }

  return { ok: true, actor: result.actor };
}

export function extractIdempotencyKeyHeader(req: Request): string | undefined {
  const key = req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key");
  const trimmed = key?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    console.error("[API_ERROR]", err);
  return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: "Request validation failed.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 }
    );
  }

  if (err instanceof WorkflowError) {
    console.error("[API_ERROR]", err);
  return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
      { status: err.statusCode }
    );
  }

  if (err instanceof AiError) {
    console.error("[API_ERROR]", err);
  return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
        },
      },
      { status: err.statusCode }
    );
  }

  if (err instanceof DatabaseUnavailableError) {
    console.error("[API_ERROR]", err);
  return NextResponse.json(
      {
        error: {
          code: "database_unavailable",
          message: err.message,
        },
      },
      { status: 503 }
    );
  }

  console.error("[API_ERROR]", err);
  return NextResponse.json(
    {
      error: {
        code: "internal_error",
        message: "An internal server error occurred.",
      },
    },
    { status: 500 }
  );
}

export async function resolveRouteParams<T>(
  context: { params?: Promise<T> | T } | undefined
): Promise<T> {
  if (!context?.params) {
    return {} as T;
  }
  return context.params instanceof Promise ? await context.params : context.params;
}
