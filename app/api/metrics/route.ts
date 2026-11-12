/**
 * Plinthly Stage 3 Phase 5 — Prometheus Metrics Endpoint (OPS-03)
 *
 * GET /api/metrics
 * Exposes internal operational telemetry in Prometheus text exposition format.
 */

import { NextResponse } from "next/server";
import { metrics } from "../../../lib/telemetry/metrics";

export async function GET(): Promise<NextResponse> {
  const body = metrics.exportPrometheus();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
