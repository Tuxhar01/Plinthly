/**
 * Plinthly Phase 15 — Independent Split-Shipment Planning Engine.
 *
 * Enforces:
 * 1. Physical shipments are modeled independently from carts and line items.
 * 2. Carts are partitioned into discrete shipments when items have:
 *    - Different fulfillment methods (e.g. freight / scheduled delivery vs parcel ground).
 *    - Different 3rd-party marketplace sellers (each marketplace seller dispatches separately).
 *    - Direct retailer fulfillment versus marketplace seller dispatch.
 * 3. Never claims consolidated shipments or delivery dates without verified evidence.
 * 4. Tracks shipment-level shipping charges and verification status.
 */

import { CartItem, PlannedShipment, SplitShipmentReason } from "./types";

export interface ShipmentPartitionInput {
  readonly merchantDomain: string;
  readonly merchantName: string;
  readonly items: readonly CartItem[];
  readonly cartLevelFreeShippingEarned: boolean;
  readonly destinationPostalCode?: string;
}

/**
 * Deterministically partitions cart items into physical shipments based on fulfillment methods,
 * seller identity, and marketplace dispatch boundaries.
 */
export function planCartShipments(input: ShipmentPartitionInput): readonly PlannedShipment[] {
  const { merchantDomain, items, cartLevelFreeShippingEarned } = input;

  if (items.length === 0) {
    return [];
  }

  // Group items by partition key:
  // Key = `${fulfillmentMethod}:::${sellerName}:::${isMarketplace}`
  const partitions = new Map<string, {
    sellerName: string;
    fulfillmentMethod: string;
    isMarketplace: boolean;
    isDirectRetailerSeller: boolean;
    requiresSpecialDelivery: boolean;
    items: CartItem[];
  }>();

  for (const item of items) {
    const key = `${item.fulfillmentMethod}:::${item.sellerName.toLowerCase().trim()}:::${item.isMarketplace ? 'marketplace' : 'direct'}`;
    const existing = partitions.get(key);

    if (existing) {
      existing.items.push(item);
    } else {
      partitions.set(key, {
        sellerName: item.sellerName,
        fulfillmentMethod: item.fulfillmentMethod,
        isMarketplace: item.isMarketplace,
        isDirectRetailerSeller: item.isDirectRetailerSeller,
        requiresSpecialDelivery: item.requiresSpecialDelivery,
        items: [item],
      });
    }
  }

  const plannedShipments: PlannedShipment[] = [];
  let shipmentIndex = 1;
  const isMultiPartition = partitions.size > 1;

  for (const [, partition] of partitions) {
    const shipmentId = `ship_${merchantDomain.replace(/[^a-z0-9]/gi, "_")}_${shipmentIndex++}`;

    // Calculate merchandise subtotal for this shipment
    const merchandiseSubtotalCents = partition.items.reduce(
      (sum, item) => sum + item.lineItemTotalCents,
      0
    );

    // Determine split reason
    let splitReason: SplitShipmentReason = "single_consolidated_package";
    if (isMultiPartition) {
      if (partition.requiresSpecialDelivery || partition.fulfillmentMethod === "freight" || partition.fulfillmentMethod === "scheduled_delivery") {
        splitReason = "special_delivery_required";
      } else if (partition.isMarketplace) {
        splitReason = "third_party_marketplace_seller";
      } else if (partition.fulfillmentMethod !== "standard_ground") {
        splitReason = "distinct_fulfillment_method";
      } else {
        splitReason = "warehouse_partition";
      }
    }

    // Determine shipping charge and evidence type for this shipment:
    // If it is direct retailer seller and cart free shipping was earned:
    let shippingChargeCents: number | null = null;
    let isShippingVerified = false;
    let isQuoteBound = false;
    let shippingEvidenceType: import("./types").ShipmentShippingEvidenceType = "missing";
    let explanation = "";

    if (partition.isDirectRetailerSeller && !partition.requiresSpecialDelivery) {
      if (cartLevelFreeShippingEarned) {
        shippingChargeCents = 0;
        isShippingVerified = true;
        isQuoteBound = false;
        shippingEvidenceType = "policy_derived";
        explanation = `Policy-derived free shipping applied (cart qualified for standard ground shipping threshold). Carrier shipping quote is not bound.`;
      } else {
        // Individual item charges or standard fee
        const explicitSum = partition.items.reduce<number | null>((acc, it) => {
          if (acc === null || it.itemShippingCents === null) return null;
          return acc + it.itemShippingCents;
        }, 0);

        if (explicitSum !== null) {
          shippingChargeCents = explicitSum;
          isShippingVerified = true;
          isQuoteBound = true;
          shippingEvidenceType = "quoted";
          explanation = `Standard retailer shipping fee applied ($${(explicitSum / 100).toFixed(2)}).`;
        } else {
          shippingChargeCents = null;
          isShippingVerified = false;
          isQuoteBound = false;
          shippingEvidenceType = "missing";
          explanation = `Shipping charge unquoted from retailer upstream. Cannot assume free shipping.`;
        }
      }
    } else if (partition.isMarketplace) {
      // Third-party marketplace seller:
      // Does NOT inherit retailer-funded free shipping!
      const explicitSum = partition.items.reduce<number | null>((acc, it) => {
        if (acc === null || it.itemShippingCents === null) return null;
        return acc + it.itemShippingCents;
      }, 0);

      if (explicitSum !== null) {
        shippingChargeCents = explicitSum;
        isShippingVerified = true;
        isQuoteBound = true;
        shippingEvidenceType = "quoted";
        explanation = `Dispatched directly by third-party marketplace seller "${partition.sellerName}". Seller shipping charge: $${(explicitSum / 100).toFixed(2)}.`;
      } else {
        shippingChargeCents = null;
        isShippingVerified = false;
        isQuoteBound = false;
        shippingEvidenceType = "missing";
        explanation = `Third-party marketplace seller "${partition.sellerName}" ships independently. Specific shipping charge is missing from upstream; cannot assume free shipping.`;
      }
    } else if (partition.requiresSpecialDelivery) {
      explanation = `Requires special fulfillment (${partition.fulfillmentMethod}). Standard parcel policies do not apply. Shipping must be quoted directly.`;
      shippingChargeCents = null;
      isShippingVerified = false;
      isQuoteBound = false;
      shippingEvidenceType = "missing";
    } else {
      explanation = `Shipment partitioned by fulfillment method (${partition.fulfillmentMethod}).`;
      shippingChargeCents = null;
      isShippingVerified = false;
      isQuoteBound = false;
      shippingEvidenceType = "missing";
    }

    plannedShipments.push({
      shipmentId,
      merchantDomain,
      sellerName: partition.sellerName,
      fulfillmentMethod: partition.fulfillmentMethod,
      splitReason,
      items: partition.items.map((i) => ({
        lineItemId: i.lineItemId,
        candidateId: i.candidateId,
        title: i.title,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
      merchandiseSubtotalCents,
      shippingChargeCents,
      isShippingVerified,
      isQuoteBound,
      shippingEvidenceType,
      deliveryDate: null, // Critical: never claim delivery dates without verified timestamped carrier evidence
      trackingAvailable: false,
      explanation,
    });
  }

  return plannedShipments;
}
