import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";
import { POST as allocateRoute } from "../../app/api/cart/allocate/route";
import { allocateCartsApi } from "../../lib/workflow/stage2-client-api";
import { createStage2Client, ensureRolesExist } from "../database/helpers/routine-test-helper";

describe("Stage 3 Phase 5: Cart Allocation API Route Suite", () => {
  let masterClient: Client;

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
  });

  beforeEach(() => {
    process.env.AUTH_MODE = "local_demo";
    process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
    setActorResolver(new ServerActorResolver("local_demo"));
  });

  afterAll(async () => {
    await masterClient.end();
  });

  it("POST /api/cart/allocate successfully persists multi-retailer allocation with atomic transaction", async () => {
    const payload = {
      strategy: "least_cost_hybrid",
      planLifecycleStatus: "ACTIVE",
      lineItems: [
        {
          itemDescription: "Ultra-Fast NVMe SSD 2TB",
          targetQuantity: 2,
          maxUnitCents: 15000,
        },
        {
          itemDescription: "DDR5 32GB RAM Kit",
          targetQuantity: 1,
          maxUnitCents: 12000,
        },
      ],
      carts: [
        {
          merchantId: "bestbuy_us",
          merchantPayeeEmail: "payee-bb@plinthly.test",
          merchandiseSubtotalCents: 30000,
          discountCents: 0,
          shippingTotalCents: 500,
          taxAmountCents: 2400,
          totalCartCents: 32900,
          currency: "USD",
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 2,
              allocatedUnitCents: 15000,
            },
          ],
        },
        {
          merchantId: "bhphoto_us",
          merchantPayeeEmail: "payee-bh@plinthly.test",
          merchandiseSubtotalCents: 12000,
          discountCents: 0,
          shippingTotalCents: 0,
          taxAmountCents: 960,
          totalCartCents: 12960,
          currency: "USD",
          allocations: [
            {
              lineItemIndex: 1,
              allocatedQuantity: 1,
              allocatedUnitCents: 12000,
            },
          ],
        },
      ],
      snapshotPayload: { reason: "Phase 5 end-to-end integration test" },
    };

    const req = new Request("http://localhost:3000/api/cart/allocate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
      },
      body: JSON.stringify(payload),
    });

    const res = await allocateRoute(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.planId).toBeDefined();
    expect(json.approvalAggregateId).toBeDefined();
    expect(json.cartIds).toHaveLength(2);
    expect(json.allocationCount).toBe(2);
    expect(json.snapshotDigestHex).toHaveLength(64);

    // Verify records in PostgreSQL
    const aggRes = await masterClient.query(
      `SELECT id, "planId", "aggregateStatus", "snapshotDigest" FROM public."ApprovalAggregate" WHERE id = $1`,
      [json.approvalAggregateId]
    );
    expect(aggRes.rows).toHaveLength(1);
    expect(aggRes.rows[0].aggregateStatus).toBe("ACTIVE");
  });

  it("POST /api/cart/allocate fails closed when line item quantities are unallocated", async () => {
    const payload = {
      strategy: "incomplete_strategy",
      lineItems: [
        {
          itemDescription: "Monitor Stand",
          targetQuantity: 5,
          maxUnitCents: 5000,
        },
      ],
      carts: [
        {
          merchantId: "amazon_us",
          merchantPayeeEmail: "payee-amz@plinthly.test",
          merchandiseSubtotalCents: 10000,
          totalCartCents: 10000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 2, // 2 allocated vs 5 target -> violates conservation
              allocatedUnitCents: 5000,
            },
          ],
        },
      ],
    };

    const req = new Request("http://localhost:3000/api/cart/allocate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
      },
      body: JSON.stringify(payload),
    });

    const res = await allocateRoute(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error.code).toBe("ERR_LINE_ITEM_COVERAGE_MISMATCH");
  });

  it("POST /api/cart/allocate fails closed when unit price cap is exceeded", async () => {
    const payload = {
      strategy: "overpriced_strategy",
      lineItems: [
        {
          itemDescription: "Budget Keyboard",
          targetQuantity: 1,
          maxUnitCents: 2000, // max $20
        },
      ],
      carts: [
        {
          merchantId: "keyboards_direct",
          merchantPayeeEmail: "payee-kb@plinthly.test",
          merchandiseSubtotalCents: 5000,
          totalCartCents: 5000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 1,
              allocatedUnitCents: 5000, // allocated $50 > max $20
            },
          ],
        },
      ],
    };

    const req = new Request("http://localhost:3000/api/cart/allocate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
      },
      body: JSON.stringify(payload),
    });

    const res = await allocateRoute(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error.code).toBe("ERR_UNIT_PRICE_CAP_EXCEEDED");
  });

  it("allocateCartsApi client SDK helper sends request and unwraps response", async () => {
    const payload = {
      strategy: "sdk_test_strategy",
      lineItems: [
        {
          itemDescription: "Ergonomic Mouse",
          targetQuantity: 1,
          maxUnitCents: 8000,
        },
      ],
      carts: [
        {
          merchantId: "logitech_us",
          merchantPayeeEmail: "payee-logi@plinthly.test",
          merchandiseSubtotalCents: 8000,
          totalCartCents: 8000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 1,
              allocatedUnitCents: 8000,
            },
          ],
        },
      ],
    };

    // Use fetchFn that routes to allocateRoute
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const nextReq = new Request("http://localhost:3000/api/cart/allocate", init);
      return allocateRoute(nextReq);
    };

    const res = await allocateCartsApi(payload, {
      actorId: "usr_buyer_1",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.approvalAggregateId).toBeDefined();
    expect(res.cartIds).toHaveLength(1);
    expect(res.allocationCount).toBe(1);
  });
});
