/**
 * Plinthly Stage 3 Phase 5 — OpenTelemetry & Prometheus Metrics Registry (OPS-03)
 *
 * Implements high-cardinality safe operational metrics for:
 * - Multi-cart capture throughput and status rates
 * - Landed-cost zero-variance guarantee verification
 * - Persisted refund-intent provenance rates
 * - Connection pool utilization gauges
 */

export interface MetricLabels {
  [key: string]: string;
}

class Counter {
  readonly name: string;
  readonly help: string;
  private counts: Map<string, number> = new Map();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  private serializeLabels(labels: MetricLabels): string {
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return sorted.map(([k, v]) => `${k}="${v}"`).join(",");
  }

  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.serializeLabels(labels);
    const curr = this.counts.get(key) || 0;
    this.counts.set(key, curr + value);
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.counts.get(key) || 0;
  }

  toPrometheus(): string {
    let output = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    if (this.counts.size === 0) {
      output += `${this.name} 0\n`;
      return output;
    }
    for (const [labels, val] of this.counts.entries()) {
      if (labels) {
        output += `${this.name}{${labels}} ${val}\n`;
      } else {
        output += `${this.name} ${val}\n`;
      }
    }
    return output;
  }
}

class Gauge {
  readonly name: string;
  readonly help: string;
  private values: Map<string, number> = new Map();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  private serializeLabels(labels: MetricLabels): string {
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return sorted.map(([k, v]) => `${k}="${v}"`).join(",");
  }

  set(labels: MetricLabels | number, value?: number): void {
    if (typeof labels === "number") {
      this.values.set("", labels);
    } else {
      const key = this.serializeLabels(labels);
      this.values.set(key, value !== undefined ? value : 0);
    }
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key) || 0;
  }

  toPrometheus(): string {
    let output = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    if (this.values.size === 0) {
      output += `${this.name} 0\n`;
      return output;
    }
    for (const [labels, val] of this.values.entries()) {
      if (labels) {
        output += `${this.name}{${labels}} ${val}\n`;
      } else {
        output += `${this.name} ${val}\n`;
      }
    }
    return output;
  }
}

export class TelemetryMetricsRegistry {
  readonly cartCaptureTotal = new Counter(
    "plinthly_cart_capture_total",
    "Total count of multi-retailer cart capture attempts partitioned by outcome status."
  );

  readonly landedCostVarianceCents = new Gauge(
    "plinthly_landed_cost_variance_cents",
    "Landed cost reconciliation variance in integer minor units (cents). Invariant: must equal 0."
  );

  readonly refundTotal = new Counter(
    "plinthly_refund_total",
    "Total count of cart refund transactions partitioned by provider outcome."
  );

  readonly poolActiveConnections = new Gauge(
    "plinthly_db_pool_active_connections",
    "Current active database client connections across role pools."
  );

  readonly poolIdleConnections = new Gauge(
    "plinthly_db_pool_idle_connections",
    "Current idle database client connections available in pool."
  );

  exportPrometheus(): string {
    return [
      this.cartCaptureTotal.toPrometheus(),
      this.landedCostVarianceCents.toPrometheus(),
      this.refundTotal.toPrometheus(),
      this.poolActiveConnections.toPrometheus(),
      this.poolIdleConnections.toPrometheus(),
    ].join("\n");
  }
}

export const metrics = new TelemetryMetricsRegistry();

