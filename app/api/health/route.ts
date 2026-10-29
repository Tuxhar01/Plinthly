import { NextResponse } from "next/server";
import { pingDatabase } from "../../../lib/workflow/repository";

/**
 * Platform health and readiness probe endpoint.
 *
 * Requirements:
 * - Unauthenticated (required for Docker, Render, Kubernetes readiness/liveness probes)
 * - Probes database responsiveness without mutating state
 * - Strictly redacts any internal error details, connection strings, hostnames, or diagnostics
 * - Returns 200 when healthy, 503 when degraded or disconnected
 */
export async function GET(): Promise<NextResponse> {
  const isDbReady = await pingDatabase();
  const timestamp = new Date().toISOString();

  if (!isDbReady) {
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp,
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  }

  return NextResponse.json(
    {
      status: "healthy",
      timestamp,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    }
  );
}
