/**
 * Plinthly Stage 3 Phase 5 — Landed Cost Variance P0 Alerting Engine (OPS-04)
 *
 * Implements emergency alerting whenever landed-cost reconciliation variance is non-zero.
 * Model A Invariant: (Merchandise - Discount + Shipping + Statutory Tax) - Total == 0.
 * Any non-zero deviation constitutes a critical financial integrity violation and triggers a P0 alert.
 */

import crypto from "crypto";
import { telemetryLogger } from "./logger";
import { metrics } from "./metrics";

export interface LandedCostAlertInput {
  traceId?: string;
  cartId?: string;
  approvalAggregateId?: string;
  merchandiseSubtotalCents: number | bigint;
  discountCents: number | bigint;
  shippingTotalCents: number | bigint;
  taxAmountCents: number | bigint;
  totalCartCents: number | bigint;
}

export interface P0AlertPayload {
  alertId: string;
  severity: "P0";
  alertName: "LANDED_COST_VARIANCE_VIOLATION";
  timestamp: string;
  varianceCents: number;
  traceId: string;
  cartId?: string;
  approvalAggregateId?: string;
  breakdown: {
    merchandiseCents: number;
    discountCents: number;
    shippingCents: number;
    taxCents: number;
    totalCartCents: number;
    calculatedTotalCents: number;
  };
  dispatchedTo: string[];
}

export interface LandedCostAlertResult {
  fired: boolean;
  varianceCents: number;
  alert?: P0AlertPayload;
}

// In-memory alert audit log for inspection and tests
export const activeAlertHistory: P0AlertPayload[] = [];

export function evaluateLandedCostVarianceAlert(input: LandedCostAlertInput): LandedCostAlertResult {
  const merch = BigInt(input.merchandiseSubtotalCents);
  const disc = BigInt(input.discountCents);
  const ship = BigInt(input.shippingTotalCents);
  const tax = BigInt(input.taxAmountCents);
  const total = BigInt(input.totalCartCents);

  const calculated = merch - disc + ship + tax;
  const varianceBigInt = calculated - total;
  const varianceCents = Number(varianceBigInt);

  // Update Prometheus gauge
  metrics.landedCostVarianceCents.set(varianceCents);

  if (varianceBigInt === BigInt(0)) {
    return { fired: false, varianceCents: 0 };
  }

  // Non-zero variance detected -> Fire immediate P0 emergency alert
  const alertId = `alert_p0_${crypto.randomUUID()}`;
  const traceId = input.traceId || crypto.randomUUID();

  const payload: P0AlertPayload = {
    alertId,
    severity: "P0",
    alertName: "LANDED_COST_VARIANCE_VIOLATION",
    timestamp: new Date().toISOString(),
    varianceCents,
    traceId,
    cartId: input.cartId,
    approvalAggregateId: input.approvalAggregateId,
    breakdown: {
      merchandiseCents: Number(merch),
      discountCents: Number(disc),
      shippingCents: Number(ship),
      taxCents: Number(tax),
      totalCartCents: Number(total),
      calculatedTotalCents: Number(calculated),
    },
    dispatchedTo: ["PAGERDUTY_ONCALL", "OPERATIONAL_TELEMETRY_STREAM"],
  };

  activeAlertHistory.push(payload);

  telemetryLogger.fatal(
    `[P0_ALERT] Critical Landed Cost Variance Violation: variance of ${varianceCents} cents detected!`,
    {
      traceId,
      cartId: input.cartId,
      varianceCents,
      approvalAggregateId: input.approvalAggregateId,
      breakdown: payload.breakdown,
    }
  );

  return {
    fired: true,
    varianceCents,
    alert: payload,
  };
}

