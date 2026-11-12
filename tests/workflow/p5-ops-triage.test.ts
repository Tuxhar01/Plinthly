import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { createStage2Client, ensureRolesExist } from "../database/helpers/routine-test-helper";
import { triageGatewayOrder } from "../../scripts/ops/reconcile-gateway-order";

describe("Stage 3 Phase 5: Capture Triage CLI Tool (OPS-05)", () => {
  let masterClient: Client;
  let testCartId: string;
  let aggregateId: string;

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);

    aggregateId = crypto.randomUUID();
    testCartId = crypto.randomUUID();
    const planId = crypto.randomUUID();

    // Insert dummy plan, aggregate and cart
    await masterClient.query(
      `INSERT INTO public."ProcurementPlan" (
         id, "userId", strategy, "lifecycleStatus"
       ) VALUES ($1, $2, 'triage_strategy', 'ACTIVE')`,
      [planId, crypto.randomUUID()]
    );

    await masterClient.query(
      `INSERT INTO public."ApprovalAggregate" (
         id, "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt"
       ) VALUES ($1, $2, 'APPROVED', 'test_digest', '{}', clock_timestamp())`,
      [aggregateId, planId]
    );

    await masterClient.query(
      `INSERT INTO public."ApprovedMerchantCart" (
         id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
         "merchandiseSubtotalCents", "discountCents", "shippingTotalCents", "taxAmountCents", "totalCartCents",
         "paypalOrderId", "cumulativeRefundedCents"
       ) VALUES ($1, $2, 'bestbuy_us', 'payee-bb@plinthly.test', 'BUYER_APPROVED',
                 10000, 0, 0, 0, 10000, 'ord_test_triage', 0)`,
      [testCartId, aggregateId]
    );
  });

  afterAll(async () => {
    await masterClient.end();
  });

  it("inspects authoritative cart and payment evidence state safely", async () => {
    const res = await triageGatewayOrder({
      cartId: testCartId,
      action: "inspect",
    });

    expect(res.cartId).toBe(testCartId);
    expect(res.currentStatus).toBe("BUYER_APPROVED");
    expect(res.totalCartCents).toBe(10000);
    expect(res.merchantName).toBe("bestbuy_us");
    expect(res.paymentEvidence).toBeNull();
  });

  it("safely reconciles capture confirmation via canonical routine R2-05", async () => {
    const res = await triageGatewayOrder({
      cartId: testCartId,
      action: "confirm",
      captureId: `cap_ops_${crypto.randomUUID()}`,
    });

    expect(res.cartId).toBe(testCartId);
    expect(res.currentStatus).toBe("CAPTURED");
    expect(res.reconciliationOutcome).toContain("CONFIRMED via R2-05");
  });
});
