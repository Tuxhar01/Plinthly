/**
 * Plinthly Stage 3 Phase 4 — Relational Cart Allocation & Strategy Adaptation Service (P4-01)
 *
 * Implements deterministic relational allocation of a multi-retailer procurement plan
 * across approved merchant carts under Stage 3 architecture specifications.
 *
 * Guarantees:
 * 1. Preserves relational integrity between ProcurementPlan, ProcurementLineItem,
 *    ApprovalAggregate, ApprovedMerchantCart, CartAllocation, and PlannedShipmentRecord.
 * 2. Enforces exact monetary arithmetic using integer cents and BigInt (zero floating point).
 * 3. Prevents duplicate, missing, or over-allocated line items:
 *    - sum(allocatedQuantity across all carts) === targetQuantity for every line item.
 *    - CartAllocation unique constraint [cartId, lineItemId] strictly preserved.
 *    - allocatedUnitCents cannot exceed lineItem.maxUnitCents.
 * 4. Model A Landed Cost zero-variance enforced on every merchant cart prior to persistence.
 * 5. Deterministic and auditable: produces reproducible cryptographic snapshot digests.
 * 6. Fails closed on any inconsistency, missing input, or constraint violation.
 */

import { Client } from "pg";
import crypto from "crypto";
import { reconcileLandedCostZeroVariance, LandedCostVarianceError } from "./landed-cost-reconciler";

export interface LineItemInput {
  itemDescription: string;
  targetQuantity: number;
  maxUnitCents: number | bigint;
}

export interface CartAllocationItemInput {
  lineItemIndex: number; // 0-based index pointing to LineItemInput
  allocatedQuantity: number;
  allocatedUnitCents: number | bigint;
}

export interface ShipmentInput {
  shippingCarrier: string;
  shippingTrackingNumber?: string;
  shippingStatus?: string;
}

export interface MerchantCartInput {
  merchantId: string;
  merchantPayeeEmail: string;
  merchandiseSubtotalCents: number | bigint;
  discountCents: number | bigint;
  shippingTotalCents: number | bigint;
  taxAmountCents: number | bigint;
  totalCartCents: number | bigint;
  currency?: string;
  paypalOrderId?: string;
  allocations: CartAllocationItemInput[];
  shipments?: ShipmentInput[];
}

export interface PersistAllocationInput {
  userId: string;
  strategy: string;
  lineItems: LineItemInput[];
  carts: MerchantCartInput[];
  snapshotPayload?: Record<string, unknown>;
  planLifecycleStatus?: string;
}

export interface PersistAllocationResult {
  planId: string;
  approvalAggregateId: string;
  cartIds: string[];
  allocationCount: number;
  snapshotDigestHex: string;
}

export class AllocationIntegrityError extends Error {
  readonly code: string;
  constructor(message: string, code: string = "ERR_ALLOCATION_INTEGRITY") {
    super(message);
    this.name = "AllocationIntegrityError";
    this.code = code;
  }
}

function toUuid(id: string): string {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  if (isUuid) return id;
  const hash = crypto.createHash("md5").update(id).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class RelationalCartAllocationService {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Persists a deterministic multi-retailer procurement allocation atomically.
   */
  async persistAllocation(input: PersistAllocationInput): Promise<PersistAllocationResult> {
    const { userId, strategy, lineItems, carts, snapshotPayload = {} } = input;
    const userUuid = toUuid(userId);

    // 1. Structural Validations (Fail Closed)
    if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
      throw new AllocationIntegrityError("userId must be a valid non-empty string.", "ERR_INVALID_USER_ID");
    }
    if (!strategy || typeof strategy !== "string" || strategy.trim().length === 0) {
      throw new AllocationIntegrityError("strategy must be a valid non-empty string.", "ERR_INVALID_STRATEGY");
    }
    if (!lineItems || lineItems.length === 0) {
      throw new AllocationIntegrityError("lineItems array cannot be empty.", "ERR_EMPTY_LINE_ITEMS");
    }
    if (!carts || carts.length === 0) {
      throw new AllocationIntegrityError("carts array cannot be empty.", "ERR_EMPTY_CARTS");
    }

    // 2. Validate Line Items
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      if (!li.itemDescription || li.itemDescription.trim().length === 0) {
        throw new AllocationIntegrityError(`Line item at index ${i} has empty itemDescription.`, "ERR_INVALID_LINE_ITEM");
      }
      if (!Number.isInteger(li.targetQuantity) || li.targetQuantity <= 0) {
        throw new AllocationIntegrityError(`Line item at index ${i} targetQuantity must be a positive integer.`, "ERR_INVALID_QUANTITY");
      }
      if (BigInt(li.maxUnitCents) <= BigInt(0)) {
        throw new AllocationIntegrityError(`Line item at index ${i} maxUnitCents must be positive.`, "ERR_INVALID_MAX_UNIT_CENTS");
      }
    }

    // 3. Track Allocated Quantities per Line Item to enforce EXACT completeness
    const allocatedQuantities = new Array<number>(lineItems.length).fill(0);

    for (let cIdx = 0; cIdx < carts.length; cIdx++) {
      const cart = carts[cIdx];

      if (!cart.merchantId || cart.merchantId.trim().length === 0) {
        throw new AllocationIntegrityError(`Cart ${cIdx} has missing merchantId.`, "ERR_INVALID_MERCHANT");
      }
      if (!cart.merchantPayeeEmail || cart.merchantPayeeEmail.trim().length === 0) {
        throw new AllocationIntegrityError(`Cart ${cIdx} has missing merchantPayeeEmail.`, "ERR_INVALID_PAYEE_EMAIL");
      }

      // Model A Zero-Variance check on cart totals
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: cart.merchandiseSubtotalCents,
        discountCents: cart.discountCents,
        shippingTotalCents: cart.shippingTotalCents,
        taxAmountCents: cart.taxAmountCents,
        totalCartCents: cart.totalCartCents,
        currency: cart.currency || "USD",
      });

      if (!cart.allocations || cart.allocations.length === 0) {
        throw new AllocationIntegrityError(`Cart ${cIdx} (${cart.merchantId}) has no line item allocations.`, "ERR_EMPTY_CART_ALLOCATIONS");
      }

      // Check for duplicate line item allocations within this single cart
      const seenLineItemIndices = new Set<number>();
      let computedMerchSubtotal = BigInt(0);

      for (let aIdx = 0; aIdx < cart.allocations.length; aIdx++) {
        const alloc = cart.allocations[aIdx];

        if (alloc.lineItemIndex < 0 || alloc.lineItemIndex >= lineItems.length) {
          throw new AllocationIntegrityError(
            `Cart ${cIdx} allocation ${aIdx} references invalid lineItemIndex ${alloc.lineItemIndex}.`,
            "ERR_INVALID_LINE_ITEM_INDEX"
          );
        }

        if (seenLineItemIndices.has(alloc.lineItemIndex)) {
          throw new AllocationIntegrityError(
            `Cart ${cIdx} has duplicate allocation for line item index ${alloc.lineItemIndex}. Unique constraint violation.`,
            "ERR_DUPLICATE_ALLOCATION"
          );
        }
        seenLineItemIndices.add(alloc.lineItemIndex);

        if (!Number.isInteger(alloc.allocatedQuantity) || alloc.allocatedQuantity <= 0) {
          throw new AllocationIntegrityError(
            `Cart ${cIdx} allocation ${aIdx} allocatedQuantity must be a positive integer.`,
            "ERR_INVALID_ALLOCATED_QUANTITY"
          );
        }

        const unitCents = BigInt(alloc.allocatedUnitCents);
        const maxUnit = BigInt(lineItems[alloc.lineItemIndex].maxUnitCents);
        if (unitCents <= BigInt(0)) {
          throw new AllocationIntegrityError(
            `Cart ${cIdx} allocation ${aIdx} allocatedUnitCents must be positive.`,
            "ERR_INVALID_ALLOCATED_UNIT_CENTS"
          );
        }
        if (unitCents > maxUnit) {
          throw new AllocationIntegrityError(
            `Cart ${cIdx} allocation ${aIdx} unit price (${unitCents}) exceeds maximum permitted price (${maxUnit}) for "${lineItems[alloc.lineItemIndex].itemDescription}".`,
            "ERR_UNIT_PRICE_CAP_EXCEEDED"
          );
        }

        allocatedQuantities[alloc.lineItemIndex] += alloc.allocatedQuantity;
        computedMerchSubtotal += BigInt(alloc.allocatedQuantity) * unitCents;
      }

      // Verify that sum(allocatedQuantity * allocatedUnitCents) === cart.merchandiseSubtotalCents
      if (computedMerchSubtotal !== BigInt(cart.merchandiseSubtotalCents)) {
        throw new AllocationIntegrityError(
          `Cart ${cIdx} allocated items sum (${computedMerchSubtotal} cents) does not match declared merchandiseSubtotalCents (${cart.merchandiseSubtotalCents} cents).`,
          "ERR_MERCHANDISE_SUM_MISMATCH"
        );
      }
    }

    // 4. Exact Line Item Allocation Completeness Invariant
    for (let i = 0; i < lineItems.length; i++) {
      const target = lineItems[i].targetQuantity;
      const allocated = allocatedQuantities[i];
      if (allocated < target) {
        throw new AllocationIntegrityError(
          `Line item "${lineItems[i].itemDescription}" is under-allocated: allocated ${allocated} of ${target} required items.`,
          "ERR_LINE_ITEM_COVERAGE_MISMATCH"
        );
      }
      if (allocated > target) {
        throw new AllocationIntegrityError(
          `Line item "${lineItems[i].itemDescription}" is over-allocated: allocated ${allocated} exceeds target ${target}.`,
          "ERR_LINE_ITEM_COVERAGE_MISMATCH"
        );
      }
    }

    // 5. Compute Deterministic Snapshot Digest
    const canonicalSnapshotPayload = {
      userId,
      strategy,
      lineItems: lineItems.map((li) => ({
        itemDescription: li.itemDescription,
        targetQuantity: li.targetQuantity,
        maxUnitCents: li.maxUnitCents.toString(),
      })),
      carts: carts.map((c) => ({
        merchantId: c.merchantId,
        merchantPayeeEmail: c.merchantPayeeEmail,
        merchandiseSubtotalCents: c.merchandiseSubtotalCents.toString(),
        discountCents: c.discountCents.toString(),
        shippingTotalCents: c.shippingTotalCents.toString(),
        taxAmountCents: c.taxAmountCents.toString(),
        totalCartCents: c.totalCartCents.toString(),
        allocations: c.allocations.map((a) => ({
          lineItemIndex: a.lineItemIndex,
          allocatedQuantity: a.allocatedQuantity,
          allocatedUnitCents: a.allocatedUnitCents.toString(),
        })),
      })),
      meta: snapshotPayload,
    };

    const snapshotJson = JSON.stringify(canonicalSnapshotPayload);
    const snapshotDigest = crypto.createHash("sha256").update(snapshotJson, "utf8").digest();
    const snapshotDigestHex = snapshotDigest.toString("hex");

    // 6. Execute Atomic PostgreSQL Transaction
    await this.client.query("BEGIN;");
    try {
      // 6.1 Insert ProcurementPlan
      const planRes = await this.client.query(
        `INSERT INTO public."ProcurementPlan" (
           "userId", strategy, "lifecycleStatus", "createdAt", "updatedAt"
         ) VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())
         RETURNING id;`,
        [userUuid, strategy, input.planLifecycleStatus || "ACTIVE"]
      );
      const planId = planRes.rows[0].id;

      // 6.2 Insert ProcurementLineItems
      const lineItemIds: string[] = [];
      for (const li of lineItems) {
        const liRes = await this.client.query(
          `INSERT INTO public."ProcurementLineItem" (
             "planId", "itemDescription", "targetQuantity", "maxUnitCents", "createdAt"
           ) VALUES ($1, $2, $3, $4, clock_timestamp())
           RETURNING id;`,
          [planId, li.itemDescription, li.targetQuantity, li.maxUnitCents.toString()]
        );
        lineItemIds.push(liRes.rows[0].id);
      }

      // 6.3 Insert ApprovalAggregate
      const aggRes = await this.client.query(
        `INSERT INTO public."ApprovalAggregate" (
           "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt", "createdAt"
         ) VALUES ($1, 'ACTIVE', $2, $3, clock_timestamp(), clock_timestamp())
         RETURNING id;`,
        [planId, snapshotDigest, canonicalSnapshotPayload]
      );
      const approvalAggregateId = aggRes.rows[0].id;

      // 6.4 Insert ApprovedMerchantCarts, CartAllocations, and PlannedShipmentRecords
      const cartIds: string[] = [];
      let totalAllocations = 0;

      for (const cart of carts) {
        const cartRes = await this.client.query(
          `INSERT INTO public."ApprovedMerchantCart" (
             "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
             "paypalOrderId", "merchandiseSubtotalCents", "discountCents",
             "shippingTotalCents", "taxAmountCents", "totalCartCents",
             "cumulativeRefundedCents", "createdAt", "updatedAt"
           ) VALUES (
             $1, $2, $3, 'READY', $4, $5, $6, $7, $8, $9, 0,
             clock_timestamp(), clock_timestamp()
           )
           RETURNING id;`,
          [
            approvalAggregateId,
            cart.merchantId,
            cart.merchantPayeeEmail,
            cart.paypalOrderId || null,
            cart.merchandiseSubtotalCents.toString(),
            cart.discountCents.toString(),
            cart.shippingTotalCents.toString(),
            cart.taxAmountCents.toString(),
            cart.totalCartCents.toString(),
          ]
        );
        const cartId = cartRes.rows[0].id;
        cartIds.push(cartId);

        // Insert allocations for this cart
        for (const alloc of cart.allocations) {
          const lineItemId = lineItemIds[alloc.lineItemIndex];
          await this.client.query(
            `INSERT INTO public."CartAllocation" (
               "cartId", "lineItemId", "allocatedQuantity", "allocatedUnitCents", "createdAt"
             ) VALUES ($1, $2, $3, $4, clock_timestamp());`,
            [cartId, lineItemId, alloc.allocatedQuantity, alloc.allocatedUnitCents.toString()]
          );
          totalAllocations++;
        }

        // Insert planned shipments if provided
        if (cart.shipments && cart.shipments.length > 0) {
          for (const ship of cart.shipments) {
            await this.client.query(
              `INSERT INTO public."PlannedShipmentRecord" (
                 "cartId", "shippingCarrier", "shippingTrackingNumber", "shippingStatus", "createdAt"
               ) VALUES ($1, $2, $3, $4, clock_timestamp());`,
              [cartId, ship.shippingCarrier, ship.shippingTrackingNumber || null, ship.shippingStatus || "PLANNED"]
            );
          }
        }
      }

      await this.client.query("COMMIT;");

      return {
        planId,
        approvalAggregateId,
        cartIds,
        allocationCount: totalAllocations,
        snapshotDigestHex,
      };
    } catch (err) {
      await this.client.query("ROLLBACK;");
      throw err;
    }
  }

  /**
   * Retrieves an entire relational allocation structure by its approvalAggregateId.
   */
  async getRelationalAllocation(approvalAggregateId: string): Promise<any> {
    const aggRes = await this.client.query(
      `SELECT a.id, a."planId", a."aggregateStatus", a."snapshotDigest", a."snapshotPayload", a."approvedAt",
              p."userId", p.strategy, p."lifecycleStatus"
         FROM public."ApprovalAggregate" a
         JOIN public."ProcurementPlan" p ON p.id = a."planId"
        WHERE a.id = $1`,
      [approvalAggregateId]
    );

    if (aggRes.rows.length === 0) {
      return null;
    }

    const agg = aggRes.rows[0];

    // Query line items
    const liRes = await this.client.query(
      `SELECT id, "itemDescription", "targetQuantity", "maxUnitCents"
         FROM public."ProcurementLineItem"
        WHERE "planId" = $1
        ORDER BY "createdAt" ASC`,
      [agg.planId]
    );

    // Query carts
    const cartsRes = await this.client.query(
      `SELECT id, "merchantId", "merchantPayeeEmail", "checkoutStatus", "paypalOrderId",
              "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
              "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "lockedAt"
         FROM public."ApprovedMerchantCart"
        WHERE "approvalAggregateId" = $1
        ORDER BY "createdAt" ASC`,
      [approvalAggregateId]
    );

    const carts: any[] = [];
    for (const c of cartsRes.rows) {
      const allocsRes = await this.client.query(
        `SELECT a.id, a."lineItemId", a."allocatedQuantity", a."allocatedUnitCents",
                l."itemDescription"
           FROM public."CartAllocation" a
           JOIN public."ProcurementLineItem" l ON l.id = a."lineItemId"
          WHERE a."cartId" = $1
          ORDER BY a."createdAt" ASC`,
        [c.id]
      );

      const shipsRes = await this.client.query(
        `SELECT id, "shippingCarrier", "shippingTrackingNumber", "shippingStatus"
           FROM public."PlannedShipmentRecord"
          WHERE "cartId" = $1`,
        [c.id]
      );

      const peRes = await this.client.query(
        `SELECT id, capture_id, amount_cents, currency, recorded_at
           FROM public."PaymentEvidenceRecord"
          WHERE cart_id = $1`,
        [c.id]
      );

      const refundRes = await this.client.query(
        `SELECT id, cart_id, capture_id, transmission_id, authenticated_refund_id AS refund_id,
                refund_amount_cents AS amount_cents, currency, reason, recorded_at
           FROM public."RefundEvidenceRecord"
          WHERE cart_id = $1
          ORDER BY recorded_at ASC`,
        [c.id]
      );

      carts.push({
        ...c,
        allocations: allocsRes.rows,
        shipments: shipsRes.rows,
        paymentEvidence: peRes.rows[0] || null,
        refundEvidenceRecords: refundRes.rows,
      });
    }

    return {
      aggregate: {
        id: agg.id,
        planId: agg.planId,
        aggregateStatus: agg.aggregateStatus,
        snapshotDigest: agg.snapshotDigest.toString("hex"),
        snapshotPayload: agg.snapshotPayload,
        approvedAt: agg.approvedAt,
      },
      plan: {
        id: agg.planId,
        userId: agg.user_id,
        strategy: agg.strategy,
        lifecycleStatus: agg.lifecycle_status,
      },
      lineItems: liRes.rows,
      carts,
    };
  }
}
