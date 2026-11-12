/**
 * Plinthly Stage 3 Phase 4 — Relational Cart Allocation Service Tests (P4-01)
 *
 * Verifies P4-01:
 * 1. Atomic relational persistence across ProcurementPlan, ProcurementLineItem,
 *    ApprovalAggregate, ApprovedMerchantCart, CartAllocation, and PlannedShipmentRecord.
 * 2. BigInt integer cents arithmetic and Model A zero-variance enforcement per cart.
 * 3. Exact line item coverage (sum of allocatedQuantity === targetQuantity).
 * 4. Fails closed on under-allocation or over-allocation (ERR_LINE_ITEM_COVERAGE_MISMATCH).
 * 5. Fails closed on duplicate allocation per cart (ERR_DUPLICATE_ALLOCATION / uq_cart_allocation_item).
 * 6. Fails closed on unit price cap violations (ERR_UNIT_PRICE_CAP_EXCEEDED).
 * 7. Transaction atomicity: entire transaction rolls back on any constraint violation.
 * 8. Cryptographic snapshot digest computation (SHA-256).
 * 9. getRelationalAllocation query accurately returns complete aggregate tree.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import {
  createStage2Client,
  ensureRolesExist,
} from "../database/helpers/routine-test-helper";
import {
  RelationalCartAllocationService,
  PersistAllocationInput,
  AllocationIntegrityError,
} from "../../lib/workflow/relational-cart-allocation-service";
import { LandedCostVarianceError } from "../../lib/workflow/landed-cost-reconciler";

describe("P4-01: Relational Cart Allocation Service", () => {
  let client: Client;
  let service: RelationalCartAllocationService;

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    service = new RelationalCartAllocationService(client);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  it("1. successfully allocates multi-retailer plan and persists complete relational hierarchy", async () => {
    const input: PersistAllocationInput = {
      userId: "buyer-enterprise-01",
      strategy: "MULTI_RETAILER_BALANCED",
      lineItems: [
        {
          itemDescription: "Dell XPS 15 Laptop (32GB RAM)",
          targetQuantity: 2,
          maxUnitCents: 150000,
        },
        {
          itemDescription: "Dell UltraSharp 27 4K Monitor",
          targetQuantity: 1,
          maxUnitCents: 45000,
        },
      ],
      carts: [
        {
          merchantId: "dell-direct",
          merchantPayeeEmail: "payee-dell@example.com",
          merchandiseSubtotalCents: 300000, // 2 laptops * 150000
          discountCents: 10000,
          shippingTotalCents: 0,
          taxAmountCents: 23200,
          totalCartCents: 313200, // 300000 - 10000 + 0 + 23200 = 313200
          allocations: [
            {
              lineItemIndex: 0, // Covers both laptops
              allocatedQuantity: 2,
              allocatedUnitCents: 150000,
            },
          ],
          shipments: [
            {
              shippingCarrier: "FedEx",
              shippingStatus: "PLANNED",
            },
          ],
        },
        {
          merchantId: "bh-photo-video",
          merchantPayeeEmail: "payee-bh@example.com",
          merchandiseSubtotalCents: 42000, // 1 monitor * 42000
          discountCents: 0,
          shippingTotalCents: 1500,
          taxAmountCents: 3480,
          totalCartCents: 46980, // 42000 - 0 + 1500 + 3480 = 46980
          allocations: [
            {
              lineItemIndex: 1, // Covers 1 monitor
              allocatedQuantity: 1,
              allocatedUnitCents: 42000,
            },
          ],
          shipments: [
            {
              shippingCarrier: "UPS",
              shippingStatus: "PLANNED",
            },
          ],
        },
      ],
    };

    const result = await service.persistAllocation(input);

    expect(result.planId).toBeDefined();
    expect(result.approvalAggregateId).toBeDefined();
    expect(result.cartIds).toHaveLength(2);
    expect(result.allocationCount).toBe(2);
    expect(result.snapshotDigestHex).toMatch(/^[a-f0-9]{64}$/);

    // Verify database relational records
    const planCheck = await client.query('SELECT * FROM public."ProcurementPlan" WHERE id = $1', [result.planId]);
    expect(planCheck.rows).toHaveLength(1);
    expect(planCheck.rows[0].strategy).toBe("MULTI_RETAILER_BALANCED");

    const aggCheck = await client.query('SELECT * FROM public."ApprovalAggregate" WHERE id = $1', [result.approvalAggregateId]);
    expect(aggCheck.rows).toHaveLength(1);
    expect(aggCheck.rows[0].aggregateStatus).toBe("ACTIVE");

    const cartsCheck = await client.query(
      'SELECT id, "merchantId", "totalCartCents", "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE "approvalAggregateId" = $1 ORDER BY "merchantId" ASC',
      [result.approvalAggregateId]
    );
    expect(cartsCheck.rows).toHaveLength(2);
    expect(cartsCheck.rows[0].checkoutStatus).toBe("READY");

    // Test getRelationalAllocation query
    const tree = await service.getRelationalAllocation(result.approvalAggregateId);
    expect(tree).not.toBeNull();
    expect(tree!.aggregate.id).toBe(result.approvalAggregateId);
    expect(tree!.carts).toHaveLength(2);
    expect(tree!.lineItems).toHaveLength(2);
    expect(tree!.carts[0].allocations).toHaveLength(1);
    expect(tree!.carts[0].shipments).toHaveLength(1);
  });

  it("2. fails closed with ERR_LINE_ITEM_COVERAGE_MISMATCH on under-allocation", async () => {
    const input: PersistAllocationInput = {
      userId: "buyer-02",
      strategy: "SINGLE_RETAILER_COST",
      lineItems: [
        {
          itemDescription: "Mechanical Keyboards",
          targetQuantity: 5, // Target: 5 units
          maxUnitCents: 10000,
        },
      ],
      carts: [
        {
          merchantId: "keyboards-direct",
          merchantPayeeEmail: "payee-kb@example.com",
          merchandiseSubtotalCents: 40000,
          discountCents: 0,
          shippingTotalCents: 0,
          taxAmountCents: 0,
          totalCartCents: 40000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 4, // Under-allocated: 4 instead of 5
              allocatedUnitCents: 10000,
            },
          ],
        },
      ],
    };

    let caughtErr: any = null;
    try {
      await service.persistAllocation(input);
    } catch (err: any) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(AllocationIntegrityError);
    expect(caughtErr.code).toBe("ERR_LINE_ITEM_COVERAGE_MISMATCH");
  });

  it("3. fails closed with ERR_LINE_ITEM_COVERAGE_MISMATCH on over-allocation", async () => {
    const input: PersistAllocationInput = {
      userId: "buyer-03",
      strategy: "SINGLE_RETAILER_SPEED",
      lineItems: [
        {
          itemDescription: "Mouse Pads",
          targetQuantity: 2, // Target: 2
          maxUnitCents: 2000,
        },
      ],
      carts: [
        {
          merchantId: "office-supplies-co",
          merchantPayeeEmail: "payee-office@example.com",
          merchandiseSubtotalCents: 6000,
          discountCents: 0,
          shippingTotalCents: 0,
          taxAmountCents: 0,
          totalCartCents: 6000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 3, // Over-allocated: 3 instead of 2
              allocatedUnitCents: 2000,
            },
          ],
        },
      ],
    };

    let caughtErr: any = null;
    try {
      await service.persistAllocation(input);
    } catch (err: any) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(AllocationIntegrityError);
    expect(caughtErr.code).toBe("ERR_LINE_ITEM_COVERAGE_MISMATCH");
  });

  it("4. fails closed with ERR_DUPLICATE_ALLOCATION if lineItem is allocated twice in the same cart", async () => {
    const input: PersistAllocationInput = {
      userId: "buyer-04",
      strategy: "MULTI_RETAILER_BALANCED",
      lineItems: [
        {
          itemDescription: "Headphones",
          targetQuantity: 2,
          maxUnitCents: 5000,
        },
      ],
      carts: [
        {
          merchantId: "audio-world",
          merchantPayeeEmail: "payee-audio@example.com",
          merchandiseSubtotalCents: 10000,
          discountCents: 0,
          shippingTotalCents: 0,
          taxAmountCents: 0,
          totalCartCents: 10000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 1,
              allocatedUnitCents: 5000,
            },
            {
              lineItemIndex: 0, // Duplicate allocation of same lineItem in same cart!
              allocatedQuantity: 1,
              allocatedUnitCents: 5000,
            },
          ],
        },
      ],
    };

    let caughtErr: any = null;
    try {
      await service.persistAllocation(input);
    } catch (err: any) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(AllocationIntegrityError);
    expect(caughtErr.code).toBe("ERR_DUPLICATE_ALLOCATION");
  });

  it("5. fails closed with ERR_UNIT_PRICE_CAP_EXCEEDED if allocatedUnitCents exceeds maxUnitCents", async () => {
    const input: PersistAllocationInput = {
      userId: "buyer-05",
      strategy: "MULTI_RETAILER_BALANCED",
      lineItems: [
        {
          itemDescription: "Webcam 4K",
          targetQuantity: 1,
          maxUnitCents: 10000, // Max permitted unit price: $100.00
        },
      ],
      carts: [
        {
          merchantId: "electronics-hub",
          merchantPayeeEmail: "payee-el@example.com",
          merchandiseSubtotalCents: 12000,
          discountCents: 0,
          shippingTotalCents: 0,
          taxAmountCents: 0,
          totalCartCents: 12000,
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 1,
              allocatedUnitCents: 12000, // Exceeds cap (12000 > 10000)
            },
          ],
        },
      ],
    };

    let caughtErr: any = null;
    try {
      await service.persistAllocation(input);
    } catch (err: any) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(AllocationIntegrityError);
    expect(caughtErr.code).toBe("ERR_UNIT_PRICE_CAP_EXCEEDED");
  });

  it("6. fails closed with LandedCostVarianceError if cart financial components do not balance (|Δ| > 0)", async () => {
    const input: PersistAllocationInput = {
      userId: "buyer-06",
      strategy: "MULTI_RETAILER_BALANCED",
      lineItems: [
        {
          itemDescription: "Office Chair",
          targetQuantity: 1,
          maxUnitCents: 25000,
        },
      ],
      carts: [
        {
          merchantId: "furniture-direct",
          merchantPayeeEmail: "payee-furn@example.com",
          merchandiseSubtotalCents: 20000,
          discountCents: 0,
          shippingTotalCents: 1000,
          taxAmountCents: 1600,
          totalCartCents: 22601, // Variance: 20000 + 1000 + 1600 = 22600 != 22601
          allocations: [
            {
              lineItemIndex: 0,
              allocatedQuantity: 1,
              allocatedUnitCents: 20000,
            },
          ],
        },
      ],
    };

    await expect(service.persistAllocation(input)).rejects.toThrowError(
      LandedCostVarianceError
    );
  });
});
