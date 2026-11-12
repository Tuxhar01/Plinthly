import { describe, it, expect, vi } from "vitest";
import { TelemetryLogger } from "../../lib/telemetry/logger";
import { metrics } from "../../lib/telemetry/metrics";
import { evaluateLandedCostVarianceAlert } from "../../lib/telemetry/alerts";

describe("Stage 3 Phase 5: Telemetry, Metrics & Alerting Engine", () => {
  it("TelemetryLogger formats single-line JSON adhering strictly to OPS-02 schema", () => {
    const logger = new TelemetryLogger({ traceId: "test-trace-123", actorId: "usr_buyer_1" });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const record = logger.info("Order capture initiated", {
      cartId: "cart-abc-001",
      durationMs: 42,
    });

    expect(record.timestamp).toBeDefined();
    expect(record.level).toBe("INFO");
    expect(record.traceId).toBe("test-trace-123");
    expect(record.actorId).toBe("usr_buyer_1");
    expect(record.cartId).toBe("cart-abc-001");
    expect(record.durationMs).toBe(42);
    expect(record.message).toBe("Order capture initiated");

    expect(stdoutSpy).toHaveBeenCalled();
    const emittedJson = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(emittedJson.level).toBe("INFO");
    expect(emittedJson.traceId).toBe("test-trace-123");
    stdoutSpy.mockRestore();
  });

  it("TelemetryLogger automatically redacts sensitive fields from context", () => {
    const logger = new TelemetryLogger();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const record = logger.warn("Credentials processed", {
      token: "secret-token-123",
      apiKey: "super-secret-key",
      nested: {
        password: "my-password",
        publicData: "visible",
      },
    });

    expect(record.context?.token).toBe("[REDACTED]");
    expect(record.context?.apiKey).toBe("[REDACTED]");
    expect((record.context?.nested as any)?.password).toBe("[REDACTED]");
    expect((record.context?.nested as any)?.publicData).toBe("visible");

    stdoutSpy.mockRestore();
  });

  it("TelemetryMetricsRegistry tracks counters and gauges, exporting Prometheus text format (OPS-03)", () => {
    metrics.cartCaptureTotal.inc({ status: "COMPLETED" }, 5);
    metrics.cartCaptureTotal.inc({ status: "FAILED" }, 1);
    metrics.landedCostVarianceCents.set(0);

    const output = metrics.exportPrometheus();
    expect(output).toContain("# TYPE plinthly_cart_capture_total counter");
    expect(output).toContain('plinthly_cart_capture_total{status="COMPLETED"} 5');
    expect(output).toContain('plinthly_cart_capture_total{status="FAILED"} 1');
    expect(output).toContain("# TYPE plinthly_landed_cost_variance_cents gauge");
    expect(output).toContain("plinthly_landed_cost_variance_cents 0");
  });

  it("evaluateLandedCostVarianceAlert verifies zero-variance Model A without firing alerts", () => {
    const result = evaluateLandedCostVarianceAlert({
      merchandiseSubtotalCents: 10000,
      discountCents: 1000,
      shippingTotalCents: 500,
      taxAmountCents: 800,
      totalCartCents: 10300, // 10000 - 1000 + 500 + 800 = 10300
    });

    expect(result.fired).toBe(false);
    expect(result.varianceCents).toBe(0);
  });

  it("evaluateLandedCostVarianceAlert triggers P0 emergency alert on non-zero variance (OPS-04)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = evaluateLandedCostVarianceAlert({
      traceId: "trace-p0-violation",
      cartId: "cart-violation-001",
      approvalAggregateId: "agg-violation-001",
      merchandiseSubtotalCents: 10000,
      discountCents: 0,
      shippingTotalCents: 500,
      taxAmountCents: 800,
      totalCartCents: 12000, // Actual sum is 11300, total is 12000 -> variance = -700 cents
    });

    expect(result.fired).toBe(true);
    expect(result.varianceCents).toBe(-700);
    expect(result.alert?.severity).toBe("P0");
    expect(result.alert?.alertName).toBe("LANDED_COST_VARIANCE_VIOLATION");
    expect(result.alert?.traceId).toBe("trace-p0-violation");
    expect(result.alert?.breakdown.calculatedTotalCents).toBe(11300);
    expect(result.alert?.breakdown.totalCartCents).toBe(12000);
    expect(result.alert?.dispatchedTo).toContain("PAGERDUTY_ONCALL");

    stderrSpy.mockRestore();
  });
});

