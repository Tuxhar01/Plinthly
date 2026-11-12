/**
 * Plinthly Stage 3 Phase 4 — Typed Stage 2 & 3 Workflow Client API
 *
 * Provides strongly-typed, schema-validated client methods for multi-retailer
 * cart operations:
 * 1. quoteTaxApi: Statutory tax quote ingress and cryptographic persistence.
 * 2. checkoutCartApi: Buyer approval aggregate validation and transition to BUYER_APPROVED.
 * 3. captureCartApi: Sequential multi-retailer capture execution.
 * 4. getApprovalAggregateApi: Aggregate query with merchant carts and line items.
 * 5. getCartStatusApi: Real-time cart status, payment evidence, and refund records.
 * 6. executeRefundApi: Gateway and webhook-provenance refunds with balance enforcement.
 */

import { z } from "zod";
import { MerchantCartStatus } from "./cart-state-machine";

export class ClientApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number = 500, code: string = "ERR_CLIENT_API", details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "ClientApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface ClientRequestOptions {
  baseUrl?: string;
  actorId?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

// -----------------------------------------------------------------------------
// 1. Quote Tax
// -----------------------------------------------------------------------------
export interface QuoteTaxRequest {
  cartId: string;
  authorityId: string;
  certificateNumber: string;
  providerLeafCertPem: string;
  expectedHost?: string;
  rawWirePayload: string | Record<string, unknown>;
  statutorySignature: string;
  statutorySignatureAlgorithm: "RSA-SHA256" | "ECDSA-P256";
  nonceOverride?: string;
  timestampOverride?: string;
}

export interface QuoteTaxResponse {
  success: boolean;
  cartId: string;
  authorityId: string;
  taxAmountCents: number;
  totalCartCents: number;
  certificateNumber: string;
  recordedAt: string;
}

// -----------------------------------------------------------------------------
// 2. Checkout Cart
// -----------------------------------------------------------------------------
export interface CheckoutCartRequest {
  approvalAggregateId: string;
  cartIds?: string[];
}

export interface CheckoutCartResponse {
  success: boolean;
  approvalAggregateId: string;
  aggregateStatus: string;
  totalAuthorizedCents: number;
  reconciliationDigest: string;
  carts: Array<{
    cartId: string;
    merchantName: string;
    totalCartCents: number;
    checkoutStatus: MerchantCartStatus;
    updatedAt: string;
  }>;
}

// -----------------------------------------------------------------------------
// 3. Capture Cart
// -----------------------------------------------------------------------------
export interface CaptureCartRequest {
  approvalAggregateId: string;
  cartId?: string;
  transmissionId?: string;
  idempotencyKey?: string;
}

export interface SingleCaptureResult {
  cartId: string;
  status: MerchantCartStatus;
  outcome: "COMPLETED" | "FAILED" | "AMBIGUOUS_TIMEOUT" | "PREPARED_AWAITING_WEBHOOK";
  captureId?: string;
  paymentEvidenceId?: string;
  idempotentRetry?: boolean;
  message?: string;
  error?: string;
}

export interface MultiCaptureResult {
  approvalAggregateId: string;
  totalCarts: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  cartResults: SingleCaptureResult[];
}

export type CaptureCartResponse = SingleCaptureResult | MultiCaptureResult;

// -----------------------------------------------------------------------------
// 4. Approval Aggregate Detail
// -----------------------------------------------------------------------------
export interface ApprovedMerchantCartRecord {
  id: string;
  approvalAggregateId: string;
  merchantName: string;
  merchantPayeeEmail: string;
  checkoutStatus: MerchantCartStatus;
  merchandiseSubtotalCents: number;
  discountCents: number;
  shippingTotalCents: number;
  taxAmountCents: number;
  totalCartCents: number;
  paypalOrderId?: string;
  cumulativeRefundedCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface CartAllocationRecord {
  id: string;
  cartId: string;
  lineItemId: string;
  allocatedQuantity: number;
  allocatedUnitCents: number;
  allocatedShippingCents: number;
  allocatedTaxCents: number;
  allocatedTotalCents: number;
  currency: string;
  lineItemTitle?: string;
}

export interface ApprovalAggregateDetailResponse {
  approvalAggregate: {
    id: string;
    buyerId: string;
    aggregateStatus: string;
    totalMerchandiseCents: number;
    totalDiscountCents: number;
    totalShippingCents: number;
    totalTaxCents: number;
    totalAuthorizedCents: number;
    currency: string;
    snapshotDigest: string;
    createdAt: string;
    updatedAt: string;
  };
  carts: ApprovedMerchantCartRecord[];
  allocations: CartAllocationRecord[];
}

// -----------------------------------------------------------------------------
// 5. Cart Status Detail
// -----------------------------------------------------------------------------
export interface CartPaymentEvidence {
  id: string;
  cart_id: string;
  transmission_id: string;
  capture_id: string;
  paypal_order_id: string;
  amount_cents: number;
  currency: string;
  payee_email: string;
  recorded_at: string;
}

export interface CartRefundRecord {
  id: string;
  cart_id: string;
  capture_id: string;
  transmission_id: string;
  refund_id: string;
  amount_cents: number;
  currency: string;
  reason: string;
  recorded_at: string;
}

export interface CartStatusDetailResponse {
  cart: ApprovedMerchantCartRecord;
  paymentEvidence: CartPaymentEvidence | null;
  refunds: CartRefundRecord[];
  allocations: CartAllocationRecord[];
}

// -----------------------------------------------------------------------------
// 6. Refund Request
// -----------------------------------------------------------------------------
export interface RefundCartRequest {
  cartId: string;
  amountCents: number;
  reason: string;
  currency?: string;
  transmissionId?: string;
  idempotencyKey?: string;
}

export interface RefundCartResponse {
  success: boolean;
  type: "WEBHOOK_RECORDED" | "GATEWAY_DISPATCHED";
  refundEvidenceId?: string;
  cartId: string;
  captureId: string;
  status?: MerchantCartStatus;
  cumulativeRefundedCents?: number;
  outcome?: "COMPLETED" | "FAILED" | "AMBIGUOUS_TIMEOUT";
  refundId?: string;
  amountCents?: number;
  currency?: string;
  idempotencyKey?: string;
  errorCode?: string;
  errorMessage?: string;
  recordedAt?: string;
  refundedAt?: string;
}

// -----------------------------------------------------------------------------
// Helper to build request headers
// -----------------------------------------------------------------------------
function buildHeaders(options?: ClientRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options?.headers || {}),
  };

  if (options?.actorId) {
    headers["x-plinthly-actor-id"] = options.actorId;
  }
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  return headers;
}

async function handleFetchResponse<T>(res: Response): Promise<T> {
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const errorObj = typeof data === "object" && data !== null && "error" in data ? (data as any).error : null;
    const code = errorObj?.code || `HTTP_${res.status}`;
    const message = errorObj?.message || (typeof data === "string" ? data : res.statusText);
    const details = errorObj?.details || undefined;
    throw new ClientApiError(message, res.status, code, details);
  }

  return data as T;
}

// -----------------------------------------------------------------------------
// API Client Functions
// -----------------------------------------------------------------------------

export async function quoteTaxApi(
  req: QuoteTaxRequest,
  options?: ClientRequestOptions
): Promise<QuoteTaxResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/quote-tax`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  return handleFetchResponse<QuoteTaxResponse>(res);
}

export async function checkoutCartApi(
  req: CheckoutCartRequest,
  options?: ClientRequestOptions
): Promise<CheckoutCartResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  return handleFetchResponse<CheckoutCartResponse>(res);
}

export async function captureCartApi(
  req: CaptureCartRequest,
  options?: ClientRequestOptions
): Promise<CaptureCartResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/capture`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  return handleFetchResponse<CaptureCartResponse>(res);
}

export async function getApprovalAggregateApi(
  aggregateId: string,
  options?: ClientRequestOptions
): Promise<ApprovalAggregateDetailResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/aggregate/${encodeURIComponent(aggregateId)}`, {
    method: "GET",
    headers,
  });

  return handleFetchResponse<ApprovalAggregateDetailResponse>(res);
}

export async function getCartStatusApi(
  cartId: string,
  options?: ClientRequestOptions
): Promise<CartStatusDetailResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/status/${encodeURIComponent(cartId)}`, {
    method: "GET",
    headers,
  });

  return handleFetchResponse<CartStatusDetailResponse>(res);
}

export async function executeRefundApi(
  req: RefundCartRequest,
  options?: ClientRequestOptions
): Promise<RefundCartResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/refund`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  return handleFetchResponse<RefundCartResponse>(res);
}

// -----------------------------------------------------------------------------
// 7. Cart Allocation
// -----------------------------------------------------------------------------
export interface CartAllocationItemInputDto {
  lineItemIndex: number;
  allocatedQuantity: number;
  allocatedUnitCents: number;
}

export interface ShipmentInputDto {
  shippingCarrier: string;
  shippingTrackingNumber?: string;
  shippingStatus?: string;
}

export interface MerchantCartInputDto {
  merchantId: string;
  merchantPayeeEmail: string;
  merchandiseSubtotalCents: number;
  discountCents?: number;
  shippingTotalCents?: number;
  taxAmountCents?: number;
  totalCartCents: number;
  currency?: string;
  paypalOrderId?: string;
  allocations: CartAllocationItemInputDto[];
  shipments?: ShipmentInputDto[];
}

export interface LineItemInputDto {
  itemDescription: string;
  targetQuantity: number;
  maxUnitCents: number;
}

export interface AllocateCartsRequest {
  userId?: string;
  strategy: string;
  planLifecycleStatus?: string;
  lineItems: LineItemInputDto[];
  carts: MerchantCartInputDto[];
  snapshotPayload?: Record<string, unknown>;
}

export interface AllocateCartsResponse {
  success: boolean;
  planId: string;
  approvalAggregateId: string;
  cartIds: string[];
  allocationCount: number;
  snapshotDigestHex: string;
}

export async function allocateCartsApi(
  req: AllocateCartsRequest,
  options?: ClientRequestOptions
): Promise<AllocateCartsResponse> {
  const baseUrl = options?.baseUrl || "";
  const fetchFn = options?.fetchFn || globalThis.fetch;
  const headers = buildHeaders(options);

  const res = await fetchFn(`${baseUrl}/api/cart/allocate`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  return handleFetchResponse<AllocateCartsResponse>(res);
}


