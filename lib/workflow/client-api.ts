import {
  CreatePurchaseRequest,
  PurchaseResponse,
  EvaluatePurchaseRequest,
  EvaluatePurchaseResponse,
  ApprovePurchaseRequest,
  ApprovePurchaseResponse,
  AuditEventEntry,
} from "./types";
import { PaymentVerificationResult } from "../paypal/verification";
import { DecomposedIntent } from "../ai/types";
import { DiscoveryResult, SearchConstraints } from "../discovery/types";

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly status: number;
  readonly data: T;
}

export interface ApiFailure {
  readonly ok: false;
  readonly status: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ClientApiOptions {
  readonly actorId?: string;
  readonly actorKind?: "user" | "system";
  readonly actorComponent?: string;
  readonly idempotencyKey?: string;
}

function buildHeaders(options?: ClientApiOptions): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");

  if (options?.actorId) {
    headers.set("x-actor-id", options.actorId);
  }
  if (options?.actorKind) {
    headers.set("x-actor-kind", options.actorKind);
  }
  if (options?.actorComponent) {
    headers.set("x-actor-component", options.actorComponent);
  }
  if (options?.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }

  return headers;
}

async function handleFetchResponse<T>(res: Response): Promise<ApiResponse<T>> {
  let body: unknown = null;
  const text = await res.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: res.status,
        error: {
          code: "invalid_response",
          message: `Server returned non-JSON response with HTTP ${res.status}.`,
        },
      };
    }
  }

  if (!res.ok) {
    const errorObj = (body as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    return {
      ok: false,
      status: res.status,
      error: {
        code: errorObj?.code || `http_${res.status}`,
        message: errorObj?.message || `Request failed with HTTP ${res.status}`,
        details: errorObj?.details,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    data: body as T,
  };
}

export async function createPurchaseApi(
  req: CreatePurchaseRequest,
  options?: ClientApiOptions
): Promise<ApiResponse<PurchaseResponse>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch("/api/purchases", {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    return await handleFetchResponse<PurchaseResponse>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function getPurchaseApi(
  id: string,
  options?: ClientApiOptions
): Promise<ApiResponse<PurchaseResponse>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}`, {
      method: "GET",
      headers,
    });
    return await handleFetchResponse<PurchaseResponse>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function evaluatePurchaseApi(
  id: string,
  req: EvaluatePurchaseRequest,
  options?: ClientApiOptions
): Promise<ApiResponse<EvaluatePurchaseResponse>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}/evaluate`, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    return await handleFetchResponse<EvaluatePurchaseResponse>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function approvePurchaseApi(
  id: string,
  req: ApprovePurchaseRequest,
  options?: ClientApiOptions
): Promise<ApiResponse<ApprovePurchaseResponse>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    return await handleFetchResponse<ApprovePurchaseResponse>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function getAuditHistoryApi(
  id: string,
  options?: ClientApiOptions
): Promise<ApiResponse<{ purchaseId: string; events: AuditEventEntry[] }>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}/audit`, {
      method: "GET",
      headers,
    });
    return await handleFetchResponse<{ purchaseId: string; events: AuditEventEntry[] }>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export interface CreatePayPalOrderResponse {
  readonly purchaseId: string;
  readonly paypalOrderId: string;
  readonly approvalUrl?: string | null;
  readonly approveUrl?: string | null;
  readonly status: string;
}

export async function createPayPalOrderApi(
  id: string,
  options?: ClientApiOptions & { targetCartMerchantDomain?: string }
): Promise<ApiResponse<CreatePayPalOrderResponse>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}/paypal/create-order`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: options?.idempotencyKey,
        targetCartMerchantDomain: options?.targetCartMerchantDomain,
      }),
    });
    return await handleFetchResponse<CreatePayPalOrderResponse>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function confirmBuyerApprovalApi(
  id: string,
  options?: ClientApiOptions & { paypalOrderId?: string }
): Promise<ApiResponse<PurchaseResponse>> {
  try {
    const headers = buildHeaders(options);
    const body = options?.paypalOrderId ? { paypalOrderId: options.paypalOrderId } : {};
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}/paypal/confirm-approval`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return await handleFetchResponse<PurchaseResponse>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function verifyPayPalPaymentApi(
  id: string,
  options?: ClientApiOptions
): Promise<ApiResponse<PaymentVerificationResult>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(id)}/paypal/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    return await handleFetchResponse<PaymentVerificationResult>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function decomposePurchaseIntentApi(
  prompt: string,
  options?: ClientApiOptions
): Promise<ApiResponse<DecomposedIntent>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch("/api/ai/decompose", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt }),
    });
    const parsed = await handleFetchResponse<{ ok: true; data: DecomposedIntent }>(res);
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      status: parsed.status,
      data: parsed.data.data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

export async function discoverCandidatesApi(
  purchaseId: string,
  params: {
    query: string;
    constraints?: SearchConstraints;
  },
  options?: ClientApiOptions
): Promise<ApiResponse<DiscoveryResult>> {
  try {
    const headers = buildHeaders(options);
    const res = await fetch(`/api/purchases/${encodeURIComponent(purchaseId)}/discover`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
    return await handleFetchResponse<DiscoveryResult>(res);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error contacting server.",
      },
    };
  }
}

