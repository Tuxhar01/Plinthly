/**
 * Plinthly Stage 3 Phase 2 — Dedicated PayPal REST v2 HTTP Client
 *
 * Implements Stage 3 Architecture Contract v3.0.0 Section 3.1, 3.2.
 *
 * Cloud-Neutral & Decoupled:
 * - Operates over standard fetch with configurable base URL, credentials, and timeout.
 * - Handles OAuth 2.0 token caching and automatic proactive refresh before expiration.
 * - Injects `PayPal-Request-Id` idempotency header (PRV-03).
 * - Distinguishes between successful capture, terminal failure, and ambiguous timeout (PRV-04).
 * - Never treats a gateway timeout, socket drop, or 504 as proof of payment failure.
 */

export interface PayPalRestV2Config {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl?: string; // Default: https://api-m.sandbox.paypal.com
  readonly timeoutMs?: number; // Default: 10000ms
  readonly fetchFn?: typeof fetch;
}

export interface PayPalOAuthToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number; // epoch ms
}

export interface PayPalCaptureSuccess {
  readonly success: true;
  readonly isAmbiguous: false;
  readonly orderId: string;
  readonly captureId: string;
  readonly status: "COMPLETED" | "PENDING";
  readonly amountCents: number;
  readonly currency: string;
  readonly payeeEmail?: string;
  readonly rawResponse: Record<string, unknown>;
  readonly capturedAt: Date;
}

export interface PayPalCaptureFailure {
  readonly success: false;
  readonly isAmbiguous: boolean; // true for 504 or network drops
  readonly orderId: string;
  readonly captureId?: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly rawResponse?: Record<string, unknown>;
}

export type PayPalCaptureResult = PayPalCaptureSuccess | PayPalCaptureFailure;

export interface PayPalAuthorizeSuccess {
  readonly success: true;
  readonly isAmbiguous: false;
  readonly orderId: string;
  readonly authorizationId: string;
  readonly status: "CREATED" | "PENDING";
  readonly amountCents: number;
  readonly currency: string;
  readonly payeeEmail?: string;
  readonly rawResponse: Record<string, unknown>;
  readonly authorizedAt: Date;
}

export interface PayPalAuthorizeFailure {
  readonly success: false;
  readonly isAmbiguous: boolean;
  readonly orderId: string;
  readonly authorizationId?: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly rawResponse?: Record<string, unknown>;
}

export type PayPalAuthorizeResult = PayPalAuthorizeSuccess | PayPalAuthorizeFailure;

export interface PayPalRefundSuccess {
  readonly success: true;
  readonly isAmbiguous: false;
  readonly captureId: string;
  readonly refundId: string;
  readonly status: "COMPLETED" | "PENDING";
  readonly amountCents: number;
  readonly currency: string;
  readonly rawResponse: Record<string, unknown>;
  readonly refundedAt: Date;
}

export interface PayPalRefundFailure {
  readonly success: false;
  readonly isAmbiguous: boolean;
  readonly captureId: string;
  readonly refundId?: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly rawResponse?: Record<string, unknown>;
}

export type PayPalRefundResult = PayPalRefundSuccess | PayPalRefundFailure;

export interface PayPalOrderDetails {
  readonly id: string;
  readonly status: string;
  readonly intent: string;
  readonly purchaseUnits: Array<{
    readonly referenceId?: string;
    readonly amount?: {
      readonly currencyCode: string;
      readonly value: string;
    };
    readonly payee?: {
      readonly emailAddress?: string;
    };
  }>;
  readonly rawResponse: Record<string, unknown>;
}

export class PayPalClientError extends Error {
  readonly code: string;
  readonly isAmbiguous: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string = "ERR_PAYPAL_CLIENT", isAmbiguous: boolean = false, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "PayPalClientError";
    this.code = code;
    this.isAmbiguous = isAmbiguous;
    this.details = details;
  }
}

export class PayPalRestV2Client {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private cachedToken: PayPalOAuthToken | null = null;
  private tokenRefreshPromise: Promise<string> | null = null;

  constructor(config: PayPalRestV2Config) {
    if (!config.clientId || typeof config.clientId !== "string" || config.clientId.trim().length === 0) {
      throw new PayPalClientError("clientId must be a non-empty string.", "ERR_PAYPAL_CONFIG");
    }
    if (!config.clientSecret || typeof config.clientSecret !== "string" || config.clientSecret.trim().length === 0) {
      throw new PayPalClientError("clientSecret must be a non-empty string.", "ERR_PAYPAL_CONFIG");
    }

    this.clientId = config.clientId.trim();
    this.clientSecret = config.clientSecret.trim();
    this.baseUrl = (config.baseUrl || "https://api-m.sandbox.paypal.com").replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchImpl = config.fetchFn ?? globalThis.fetch;

    if (!this.fetchImpl) {
      throw new PayPalClientError("No fetch implementation available.", "ERR_PAYPAL_CONFIG");
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Retrieves an OAuth 2.0 access token using client credentials flow.
   * Reuses unexpired tokens with a 60-second safety window before expiry.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60000) {
      return this.cachedToken.accessToken;
    }

    // Deduplicate concurrent token requests
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.fetchNewToken();
    try {
      const token = await this.tokenRefreshPromise;
      return token;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  private async fetchNewToken(): Promise<string> {
    const url = `${this.baseUrl}/v1/oauth2/token`;
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch {
          errorBody = response.statusText;
        }
        throw new PayPalClientError(
          `OAuth2 token request failed with status ${response.status}: ${errorBody}`,
          "ERR_PAYPAL_OAUTH_FAILED",
          false,
          { status: response.status, body: errorBody }
        );
      }

      const data = (await response.json()) as { access_token: string; token_type: string; expires_in: number };
      const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
      this.cachedToken = {
        accessToken: data.access_token,
        tokenType: data.token_type || "Bearer",
        expiresAt: Date.now() + expiresInSec * 1000,
      };

      return data.access_token;
    } catch (err: unknown) {
      if (err instanceof PayPalClientError) throw err;
      const isAbort = (err as Error)?.name === "AbortError";
      throw new PayPalClientError(
        isAbort ? "OAuth token request timed out." : `OAuth token network error: ${(err as Error)?.message || String(err)}`,
        isAbort ? "ERR_PAYPAL_TIMEOUT" : "ERR_PAYPAL_NETWORK",
        isAbort
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Captures an authorized PayPal v2 Order with strict idempotency (PRV-03).
   *
   * @param orderId PayPal Order ID (e.g. 5O190127TN364715T)
   * @param idempotencyKey Plinthly MerchantCartCapture.id (UUIDv4) passed as PayPal-Request-Id
   */
  async captureOrder(orderId: string, idempotencyKey: string): Promise<PayPalCaptureResult> {
    if (!orderId || typeof orderId !== "string" || orderId.trim().length === 0) {
      return {
        success: false,
        isAmbiguous: false,
        orderId,
        errorCode: "ERR_INVALID_ORDER_ID",
        errorMessage: "orderId must be a non-empty string.",
      };
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      return {
        success: false,
        isAmbiguous: false,
        orderId,
        errorCode: "ERR_INVALID_IDEMPOTENCY_KEY",
        errorMessage: "idempotencyKey (PayPal-Request-Id) must be a non-empty string.",
      };
    }

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: unknown) {
      const isAmbiguous = (err as PayPalClientError)?.isAmbiguous || false;
      return {
        success: false,
        isAmbiguous,
        orderId,
        errorCode: (err as PayPalClientError)?.code || "ERR_OAUTH_FAILED",
        errorMessage: (err as Error)?.message || "Failed to obtain OAuth2 token for capture.",
      };
    }

    const url = `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": idempotencyKey,
          Prefer: "return=representation",
        },
        signal: controller.signal,
      });

      // Handle Ambiguous Gateway Timeouts (504, 502, 503)
      if (response.status === 504 || response.status === 502 || response.status === 503) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        return {
          success: false,
          isAmbiguous: true,
          orderId,
          errorCode: `GATEWAY_HTTP_${response.status}`,
          errorMessage: `PayPal gateway returned HTTP ${response.status}. Capture outcome is ambiguous.`,
          rawResponse: { status: response.status, body: bodyText },
        };
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        // Non-JSON response on non-200
        if (!response.ok) {
          return {
            success: false,
            isAmbiguous: false,
            orderId,
            errorCode: `HTTP_${response.status}`,
            errorMessage: `PayPal capture request failed with HTTP status ${response.status}.`,
          };
        }
      }

      if (response.ok && (response.status === 200 || response.status === 201)) {
        // Inspect purchase units and capture details
        const purchaseUnits = data.purchase_units || [];
        const firstUnit = purchaseUnits[0] || {};
        const payments = firstUnit.payments || {};
        const captures = payments.captures || [];
        const primaryCapture = captures[0] || {};

        const captureId = primaryCapture.id || data.id;
        const captureStatus = primaryCapture.status || data.status;
        const amountValue = primaryCapture.amount?.value || firstUnit.amount?.value || "0.00";
        const currency = primaryCapture.amount?.currency_code || firstUnit.amount?.currency_code || "USD";
        const payeeEmail = primaryCapture.payee?.email_address || firstUnit.payee?.email_address;

        const amountCents = Math.round(parseFloat(amountValue) * 100);

        if (captureStatus === "COMPLETED" || captureStatus === "PENDING") {
          return {
            success: true,
            isAmbiguous: false,
            orderId,
            captureId: captureId || `CAP-${orderId}`,
            status: captureStatus,
            amountCents,
            currency,
            payeeEmail,
            rawResponse: data,
            capturedAt: new Date(),
          };
        }

        // Terminal non-completed status (e.g. DECLINED, FAILED)
        return {
          success: false,
          isAmbiguous: false,
          orderId,
          captureId,
          errorCode: captureStatus || "CAPTURE_NOT_COMPLETED",
          errorMessage: `PayPal order capture status is ${captureStatus}.`,
          rawResponse: data,
        };
      }

      // 4xx client errors (e.g., 422 UNPROCESSABLE_ENTITY, 404, 400)
      const errorName = data?.name || `HTTP_${response.status}`;
      const detailMsg = data?.details?.[0]?.description;
      const errorMsg = detailMsg
        ? `${data?.message ? data.message + ": " : ""}${detailMsg}`
        : (data?.message || "PayPal payment capture failed.");

      // If intent mismatch indicates order requires authorization first, execute authorize & capture
      if (
        data?.details?.[0]?.issue === "ACTION_DOES_NOT_MATCH_INTENT" &&
        data?.details?.[0]?.description?.includes("authorize")
      ) {
        const authResult = await this.authorizeOrder(orderId, idempotencyKey);
        if (authResult.success) {
          return await this.captureAuthorization(
            authResult.authorizationId,
            { valueCents: authResult.amountCents, currency: authResult.currency },
            idempotencyKey
          );
        } else {
          return {
            success: false,
            isAmbiguous: authResult.isAmbiguous,
            orderId,
            errorCode: authResult.errorCode,
            errorMessage: authResult.errorMessage,
            rawResponse: authResult.rawResponse,
          };
        }
      }

      return {
        success: false,
        isAmbiguous: false,
        orderId,
        errorCode: errorName,
        errorMessage: errorMsg,
        rawResponse: data,
      };
    } catch (err: unknown) {
      const isAbort = (err as Error)?.name === "AbortError";
      return {
        success: false,
        isAmbiguous: isAbort || true, // Network drops during capture in flight are ambiguous
        orderId,
        errorCode: isAbort ? "GATEWAY_TIMEOUT" : "NETWORK_ERROR",
        errorMessage: isAbort
          ? "PayPal capture request timed out; outcome ambiguous."
          : `Network drop during capture: ${(err as Error)?.message || String(err)}. Outcome ambiguous.`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Authorizes an approved PayPal v2 Order with idempotency.
   *
   * @param orderId PayPal Order ID (e.g. 4MT765021L9327907)
   * @param idempotencyKey Optional idempotency token passed as PayPal-Request-Id
   */
  async authorizeOrder(orderId: string, idempotencyKey?: string): Promise<PayPalAuthorizeResult> {
    if (!orderId || typeof orderId !== "string" || orderId.trim().length === 0) {
      return {
        success: false,
        isAmbiguous: false,
        orderId,
        errorCode: "ERR_INVALID_ORDER_ID",
        errorMessage: "orderId must be a non-empty string.",
      };
    }

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: unknown) {
      return {
        success: false,
        isAmbiguous: false,
        orderId,
        errorCode: (err as PayPalClientError)?.code || "ERR_OAUTH_FAILED",
        errorMessage: (err as Error)?.message || "Failed to obtain OAuth2 token for authorization.",
      };
    }

    const url = `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (idempotencyKey) {
      headers["PayPal-Request-Id"] = idempotencyKey;
    }

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        signal: controller.signal,
      });

      if (response.status === 504 || response.status === 502 || response.status === 503) {
        return {
          success: false,
          isAmbiguous: true,
          orderId,
          errorCode: `GATEWAY_HTTP_${response.status}`,
          errorMessage: `PayPal gateway returned HTTP ${response.status}. Authorization outcome is ambiguous.`,
        };
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          return {
            success: false,
            isAmbiguous: false,
            orderId,
            errorCode: `HTTP_${response.status}`,
            errorMessage: `PayPal authorization failed with HTTP ${response.status}.`,
          };
        }
      }

      if (response.ok && (response.status === 200 || response.status === 201)) {
        const purchaseUnits = data.purchase_units || [];
        const firstUnit = purchaseUnits[0] || {};
        const payments = firstUnit.payments || {};
        const authorizations = payments.authorizations || [];
        const primaryAuth = authorizations[0] || {};

        const authId = primaryAuth.id || data.id;
        const authStatus = primaryAuth.status || data.status;
        const amountValue = primaryAuth.amount?.value || firstUnit.amount?.value || "0.00";
        const currency = primaryAuth.amount?.currency_code || firstUnit.amount?.currency_code || "USD";
        const payeeEmail = primaryAuth.payee?.email_address || firstUnit.payee?.email_address;
        const amountCents = Math.round(parseFloat(amountValue) * 100);

        return {
          success: true,
          isAmbiguous: false,
          orderId,
          authorizationId: authId,
          status: authStatus,
          amountCents,
          currency,
          payeeEmail,
          rawResponse: data,
          authorizedAt: new Date(),
        };
      }

      const errorName = data?.name || `HTTP_${response.status}`;
      const detailMsg = data?.details?.[0]?.description;
      const errorMsg = detailMsg
        ? `${data?.message ? data.message + ": " : ""}${detailMsg}`
        : (data?.message || "PayPal authorization failed.");

      return {
        success: false,
        isAmbiguous: false,
        orderId,
        errorCode: errorName,
        errorMessage: errorMsg,
        rawResponse: data,
      };
    } catch (err: unknown) {
      const isAbort = (err as Error)?.name === "AbortError";
      return {
        success: false,
        isAmbiguous: isAbort || true,
        orderId,
        errorCode: isAbort ? "GATEWAY_TIMEOUT" : "NETWORK_ERROR",
        errorMessage: isAbort ? "Authorization timed out." : `Authorization network error: ${(err as Error)?.message || String(err)}`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Captures an authorized payment via PayPal Payments v2 API.
   *
   * @param authorizationId PayPal Authorization ID
   * @param amount Minor unit cent amount and currency
   * @param idempotencyKey Plinthly idempotency key passed as PayPal-Request-Id
   * @param isFinalCapture Whether this is the final capture for the authorization (default: true)
   */
  async captureAuthorization(
    authorizationId: string,
    amount: { valueCents: number; currency: string },
    idempotencyKey: string,
    isFinalCapture: boolean = true
  ): Promise<PayPalCaptureResult> {
    if (!authorizationId || typeof authorizationId !== "string" || authorizationId.trim().length === 0) {
      return {
        success: false,
        isAmbiguous: false,
        orderId: authorizationId,
        errorCode: "ERR_INVALID_AUTH_ID",
        errorMessage: "authorizationId must be a non-empty string.",
      };
    }

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: unknown) {
      return {
        success: false,
        isAmbiguous: false,
        orderId: authorizationId,
        errorCode: (err as PayPalClientError)?.code || "ERR_OAUTH_FAILED",
        errorMessage: (err as Error)?.message || "Failed to obtain OAuth2 token for capture.",
      };
    }

    const url = `${this.baseUrl}/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    const payload = {
      amount: {
        value: (amount.valueCents / 100).toFixed(2),
        currency_code: amount.currency,
      },
      final_capture: isFinalCapture,
    };

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": idempotencyKey,
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 504 || response.status === 502 || response.status === 503) {
        return {
          success: false,
          isAmbiguous: true,
          orderId: authorizationId,
          errorCode: `GATEWAY_HTTP_${response.status}`,
          errorMessage: `PayPal gateway returned HTTP ${response.status}. Capture outcome is ambiguous.`,
        };
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          return {
            success: false,
            isAmbiguous: false,
            orderId: authorizationId,
            errorCode: `HTTP_${response.status}`,
            errorMessage: `PayPal capture request failed with HTTP ${response.status}.`,
          };
        }
      }

      if (response.ok && (response.status === 200 || response.status === 201)) {
        const captureId = data.id;
        const captureStatus = data.status;
        const amountValue = data.amount?.value || (amount.valueCents / 100).toFixed(2);
        const currency = data.amount?.currency_code || amount.currency;
        const amountCents = Math.round(parseFloat(amountValue) * 100);

        return {
          success: true,
          isAmbiguous: false,
          orderId: authorizationId,
          captureId: captureId || `CAP-${authorizationId}`,
          status: captureStatus === "PENDING" ? "PENDING" : "COMPLETED",
          amountCents,
          currency,
          rawResponse: data,
          capturedAt: new Date(),
        };
      }

      return {
        success: false,
        isAmbiguous: false,
        orderId: authorizationId,
        errorCode: data?.name || `HTTP_${response.status}`,
        errorMessage: data?.message || data?.details?.[0]?.description || "PayPal payment capture failed.",
        rawResponse: data,
      };
    } catch (err: unknown) {
      const isAbort = (err as Error)?.name === "AbortError";
      return {
        success: false,
        isAmbiguous: true,
        orderId: authorizationId,
        errorCode: isAbort ? "GATEWAY_TIMEOUT" : "NETWORK_ERROR",
        errorMessage: isAbort ? "Capture timed out." : `Capture network error: ${(err as Error)?.message || String(err)}`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Refunds a captured payment with idempotency (PRV-03).
   *
   * @param captureId PayPal Capture ID
   * @param amount Minor unit cent amount and currency
   * @param reason Refund note / reason
   * @param idempotencyKey Plinthly CartRefundRecord.id (UUIDv4) passed as PayPal-Request-Id
   */
  async refundCapture(
    captureId: string,
    amount: { valueCents: number; currency: string },
    reason: string,
    idempotencyKey: string
  ): Promise<PayPalRefundResult> {
    if (!captureId || typeof captureId !== "string" || captureId.trim().length === 0) {
      return {
        success: false,
        isAmbiguous: false,
        captureId,
        errorCode: "ERR_INVALID_CAPTURE_ID",
        errorMessage: "captureId must be a non-empty string.",
      };
    }
    if (amount.valueCents <= 0) {
      return {
        success: false,
        isAmbiguous: false,
        captureId,
        errorCode: "ERR_INVALID_REFUND_AMOUNT",
        errorMessage: "Refund amount must be strictly greater than zero.",
      };
    }

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: unknown) {
      return {
        success: false,
        isAmbiguous: false,
        captureId,
        errorCode: "ERR_OAUTH_FAILED",
        errorMessage: (err as Error)?.message || "Failed to obtain OAuth2 token for refund.",
      };
    }

    const url = `${this.baseUrl}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    const payload = {
      amount: {
        value: (amount.valueCents / 100).toFixed(2),
        currency_code: amount.currency,
      },
      note_to_payer: reason,
    };

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": idempotencyKey,
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 504 || response.status === 502 || response.status === 503) {
        return {
          success: false,
          isAmbiguous: true,
          captureId,
          errorCode: `REFUND_HTTP_${response.status}`,
          errorMessage: `PayPal refund returned HTTP ${response.status}. Outcome is ambiguous.`,
        };
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          return {
            success: false,
            isAmbiguous: false,
            captureId,
            errorCode: `HTTP_${response.status}`,
            errorMessage: `PayPal refund request failed with HTTP ${response.status}.`,
          };
        }
      }

      if (response.ok && (response.status === 200 || response.status === 201)) {
        const refundId = data.id || `REF-${captureId}`;
        const refundStatus = data.status || "COMPLETED";
        const refundedValue = data.amount?.value ? Math.round(parseFloat(data.amount.value) * 100) : amount.valueCents;

        return {
          success: true,
          isAmbiguous: false,
          captureId,
          refundId,
          status: refundStatus === "PENDING" ? "PENDING" : "COMPLETED",
          amountCents: refundedValue,
          currency: data.amount?.currency_code || amount.currency,
          rawResponse: data,
          refundedAt: new Date(),
        };
      }

      return {
        success: false,
        isAmbiguous: false,
        captureId,
        errorCode: data?.name || `HTTP_${response.status}`,
        errorMessage: data?.message || data?.details?.[0]?.description || "PayPal refund failed.",
        rawResponse: data,
      };
    } catch (err: unknown) {
      const isAbort = (err as Error)?.name === "AbortError";
      return {
        success: false,
        isAmbiguous: true,
        captureId,
        errorCode: isAbort ? "GATEWAY_TIMEOUT" : "NETWORK_ERROR",
        errorMessage: isAbort ? "Refund request timed out." : `Refund network error: ${(err as Error)?.message || String(err)}`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Retrieves order details from PayPal Orders v2 API.
   */
  async getOrder(orderId: string): Promise<PayPalOrderDetails> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PayPalClientError(
          `Failed to get order "${orderId}": HTTP ${response.status}`,
          `HTTP_${response.status}`
        );
      }

      const data = (await response.json()) as any;
      return {
        id: data.id,
        status: data.status,
        intent: data.intent,
        purchaseUnits: (data.purchase_units || []).map((pu: any) => ({
          referenceId: pu.reference_id,
          amount: pu.amount ? { currencyCode: pu.amount.currency_code, value: pu.amount.value } : undefined,
          payee: pu.payee ? { emailAddress: pu.payee.email_address } : undefined,
        })),
        rawResponse: data,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Retrieves capture details from PayPal Payments v2 API.
   */
  async getCapture(captureId: string): Promise<{
    readonly id: string;
    readonly status: string;
    readonly amount?: { readonly value: string; readonly currencyCode: string };
    readonly rawResponse: Record<string, unknown>;
  }> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}/v2/payments/captures/${encodeURIComponent(captureId)}`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PayPalClientError(
          `Failed to get capture "${captureId}": HTTP ${response.status}`,
          `HTTP_${response.status}`
        );
      }

      const data = (await response.json()) as any;
      return {
        id: data.id,
        status: data.status,
        amount: data.amount
          ? { value: data.amount.value, currencyCode: data.amount.currency_code }
          : undefined,
        rawResponse: data,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
