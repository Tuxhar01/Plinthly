/**
 * Plinthly Stage 2 Phase 4 — ApprovedMerchantCart Payment State Machine
 *
 * Implements canonical checkout states and transition validation:
 * READY -> CHECKOUT_INITIATED -> BUYER_APPROVED -> CAPTURING -> CAPTURED -> (PARTIALLY_REFUNDED -> REFUNDED)
 * Terminal failure: CAPTURING -> FAILED (isolated per merchant cart).
 */

export type MerchantCartStatus =
  | "READY"
  | "CHECKOUT_INITIATED"
  | "BUYER_APPROVED"
  | "CAPTURING"
  | "CAPTURED"
  | "FAILED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export const ALL_CART_STATUSES: readonly MerchantCartStatus[] = Object.freeze([
  "READY",
  "CHECKOUT_INITIATED",
  "BUYER_APPROVED",
  "CAPTURING",
  "CAPTURED",
  "FAILED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

const VALID_TRANSITIONS: Record<MerchantCartStatus, readonly MerchantCartStatus[]> = {
  READY: ["CHECKOUT_INITIATED", "BUYER_APPROVED", "FAILED"],
  CHECKOUT_INITIATED: ["BUYER_APPROVED", "FAILED"],
  BUYER_APPROVED: ["CAPTURING", "FAILED"],
  CAPTURING: ["CAPTURED", "FAILED"],
  CAPTURED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  FAILED: [],
  REFUNDED: [],
};

export class InvalidCartTransitionError extends Error {
  public readonly code = "ERR_INVALID_TRANSITION";
  public readonly currentStatus: string;
  public readonly targetStatus: string;
  public readonly sqlState = "55000";

  constructor(currentStatus: string, targetStatus: string) {
    super(
      `ERR_INVALID_TRANSITION: Cannot transition merchant cart from "${currentStatus}" to "${targetStatus}".`
    );
    this.name = "InvalidCartTransitionError";
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
  }
}

/**
 * Checks whether a transition between two merchant cart statuses is valid.
 */
export function canTransitionCart(
  current: MerchantCartStatus,
  target: MerchantCartStatus
): boolean {
  if (current === target) return false;
  const allowed = VALID_TRANSITIONS[current];
  return allowed ? allowed.includes(target) : false;
}

/**
 * Asserts that a transition between two merchant cart statuses is valid.
 * Throws InvalidCartTransitionError (matching SQLSTATE 55000) if invalid.
 */
export function assertCartTransition(
  current: string,
  target: string
): void {
  if (!isValidCartStatus(current)) {
    throw new Error(`ERR_UNKNOWN_STATUS: Unknown current status "${current}"`);
  }
  if (!isValidCartStatus(target)) {
    throw new Error(`ERR_UNKNOWN_STATUS: Unknown target status "${target}"`);
  }
  if (!canTransitionCart(current as MerchantCartStatus, target as MerchantCartStatus)) {
    throw new InvalidCartTransitionError(current, target);
  }
}

/**
 * Validates whether a status string is a recognized MerchantCartStatus.
 */
export function isValidCartStatus(status: string): status is MerchantCartStatus {
  return ALL_CART_STATUSES.includes(status as MerchantCartStatus);
}

