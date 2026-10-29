import {
  PayPalConfig,
  PayPalConfigError,
  PayPalCreateOrderInput,
  PayPalGetOrderResponse,
  PayPalNetworkError,
  PayPalOAuthTokenResponse,
  PayPalOrderResponse,
  PayPalTimeoutError,
  PayPalApiError,
} from "./types";

const DEFAULT_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_APP_BASE_URL = "http://127.0.0.1:3001";

/**
 * Validates the application base URL for PayPal return and cancel callbacks.
 * In local development, loopback URLs (127.0.0.1 or localhost) with HTTP or HTTPS are permitted.
 * In all other environments (or non-loopback hosts), HTTPS is strictly required.
 * Fails closed on invalid URLs, empty strings, or insecure non-loopback protocols.
 */
export function validateAppBaseUrl(urlStr?: string): string {
  if (urlStr === undefined || urlStr === null || urlStr.trim().length === 0) {
    throw new PayPalConfigError(
      "Missing required application base URL. Configure APP_BASE_URL or supply a valid base URL."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    throw new PayPalConfigError(`Invalid application base URL: "${urlStr}". Must be a valid URL.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost";

  if (!isLoopback && parsed.protocol !== "https:") {
    throw new PayPalConfigError(
      `Insecure application base URL: "${urlStr}". Non-loopback application base URLs must use HTTPS.`
    );
  }

  if (isLoopback && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PayPalConfigError(
      `Invalid protocol for application base URL: "${parsed.protocol}". Only HTTP and HTTPS are supported.`
    );
  }

  return parsed.origin;
}

export const ALLOWED_SANDBOX_CHECKOUT_HOSTS = Object.freeze([
  "sandbox.paypal.com",
  "www.sandbox.paypal.com",
]);

/**
 * Validates that a buyer checkout URL targets an explicitly allowlisted PayPal Sandbox host with HTTPS.
 * Strictly rejects non-HTTPS schemes, deceptive lookalike hostnames, userinfo/credentials, and malformed URLs.
 */
export function validateSandboxApprovalUrl(
  urlStr?: string | null,
  allowedHosts: readonly string[] = ALLOWED_SANDBOX_CHECKOUT_HOSTS
): string | null {
  if (!urlStr || typeof urlStr !== "string" || urlStr.trim().length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const hostSet = new Set(allowedHosts.map((h) => h.toLowerCase()));
  if (!hostSet.has(hostname)) {
    return null;
  }

  return parsed.toString();
}

/**
 * Extracts and validates a safe PayPal Sandbox approval URL from an array of link descriptions.
 * Recognizes both `rel === "approve"` and `rel === "payer-action"`.
 */
export function extractSafeApprovalLink(
  links?: readonly { readonly rel?: string; readonly href?: string }[] | null,
  allowedHosts?: readonly string[]
): string | null {
  if (!Array.isArray(links)) {
    return null;
  }

  const approveLink = links.find(
    (l) => l.rel === "approve" || l.rel === "payer-action"
  );

  return validateSandboxApprovalUrl(approveLink?.href, allowedHosts);
}

/**
 * Validates and sanitizes a PayPal Sandbox base URL.
 * Strictly prevents accidental or intentional configuration of production endpoints.
 */
export function validateSandboxBaseUrl(urlStr: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    throw new PayPalConfigError(`Invalid PAYPAL_API_BASE_URL: "${urlStr}". Must be a valid URL.`);
  }

  if (parsed.protocol !== "https:") {
    throw new PayPalConfigError(`Insecure PAYPAL_API_BASE_URL: "${urlStr}". HTTPS protocol is required.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  // Must contain sandbox.paypal.com (or localhost/mock domain in test environments)
  const isSandboxDomain =
    hostname.includes("sandbox.paypal.com") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1";

  if (!isSandboxDomain) {
    throw new PayPalConfigError(
      `Disallowed PayPal endpoint: "${hostname}". Production PayPal endpoints are prohibited in Phase 5. Only PayPal Sandbox endpoints are permitted.`
    );
  }

  return parsed.origin;
}

/**
 * Loads PayPal Sandbox configuration from environment variables.
 * Fails closed if required credentials are missing or invalid.
 */
export function loadPayPalConfigFromEnv(): PayPalConfig {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const rawBaseUrl = process.env.PAYPAL_API_BASE_URL?.trim() || DEFAULT_SANDBOX_BASE_URL;

  if (!clientId || clientId.length === 0) {
    throw new PayPalConfigError(
      "Missing required PAYPAL_CLIENT_ID environment variable. Configure PAYPAL_CLIENT_ID with Sandbox credentials."
    );
  }

  if (!clientSecret || clientSecret.length === 0) {
    throw new PayPalConfigError(
      "Missing required PAYPAL_CLIENT_SECRET environment variable. Configure PAYPAL_CLIENT_SECRET with Sandbox credentials."
    );
  }

  const baseUrl = validateSandboxBaseUrl(rawBaseUrl);

  if (process.env.APP_BASE_URL !== undefined && process.env.APP_BASE_URL.trim().length === 0) {
    throw new PayPalConfigError(
      "Missing required APP_BASE_URL environment variable. Configure APP_BASE_URL with a valid application base URL."
    );
  }

  const rawAppBaseUrl = process.env.APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL;
  const appBaseUrl = validateAppBaseUrl(rawAppBaseUrl);

  const timeoutMs = process.env.PAYPAL_TIMEOUT_MS
    ? parseInt(process.env.PAYPAL_TIMEOUT_MS, 10)
    : DEFAULT_TIMEOUT_MS;

  return {
    clientId,
    clientSecret,
    baseUrl,
    appBaseUrl,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Server-only PayPal Sandbox client.
 * Handles OAuth2 client credentials authentication, token caching, order creation,
 * and independent server-side order retrieval.
 */
export class PayPalSandboxClient {
  private config: PayPalConfig | null = null;
  private cachedToken: CachedToken | null = null;
  private customFetch: typeof fetch;

  constructor(config?: PayPalConfig, injectedFetch?: typeof fetch) {
    if (config) {
      this.config = {
        ...config,
        baseUrl: validateSandboxBaseUrl(config.baseUrl),
        appBaseUrl: validateAppBaseUrl(config.appBaseUrl ?? DEFAULT_APP_BASE_URL),
      };
    }
    this.customFetch = injectedFetch ?? fetch;
  }

  private getConfig(): PayPalConfig {
    if (!this.config) {
      this.config = loadPayPalConfigFromEnv();
    }
    return this.config;
  }

  /**
   * Resets cached authentication token.
   */
  clearCachedToken(): void {
    this.cachedToken = null;
  }

  /**
   * Obtains a valid OAuth 2.0 Bearer access token using client credentials.
   * Caches token in memory until 60 seconds before expiration.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }

    const config = this.getConfig();
    const tokenUrl = `${config.baseUrl}/v1/oauth2/token`;
    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

    const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;

    try {
      res = await this.customFetch(tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new PayPalTimeoutError(`PayPal Sandbox OAuth token request timed out after ${timeout}ms`);
      }
      throw new PayPalNetworkError(
        `Failed to reach PayPal Sandbox OAuth endpoint: ${(err as Error)?.message ?? "network error"}`,
        err
      );
    }

    if (!res.ok) {
      this.clearCachedToken();
      let errorBody: unknown = null;
      try {
        errorBody = await res.json();
      } catch {
        // non-JSON error
      }
      const errObj = errorBody as { error?: string; error_description?: string } | null;
      const errorName = errObj?.error ?? "oauth_error";
      const errorMsg = errObj?.error_description ?? `Failed to authenticate with PayPal Sandbox (HTTP ${res.status})`;
      throw new PayPalApiError(res.status, errorName, errorMsg);
    }

    const data = (await res.json()) as PayPalOAuthTokenResponse;
    if (!data.access_token) {
      throw new PayPalApiError(500, "malformed_token_response", "PayPal OAuth response did not contain access_token");
    }

    // Cache with 60-second buffer
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.cachedToken = {
      token: data.access_token,
      expiresAt: now + Math.max(expiresIn - 60, 10) * 1000,
    };

    return this.cachedToken.token;
  }

  /**
   * Creates an order in PayPal Sandbox with explicit server-calculated terms and idempotency header.
   */
  async createOrder(input: PayPalCreateOrderInput): Promise<PayPalOrderResponse> {
    // Plinthly operates strictly under non-custodial purchase assurance:
    // All checkout orders MUST use intent: "AUTHORIZE".
    // Immediate capture ("CAPTURE") is strictly prohibited to prevent automatic or unapproved fund capture.
    const requestedIntent = (input as unknown as { intent?: string }).intent;
    if (requestedIntent && requestedIntent !== "AUTHORIZE") {
      throw new PayPalApiError(
        400,
        "invalid_intent",
        `Only intent "AUTHORIZE" is permitted for Purchase Assurance orders; received "${requestedIntent}".`
      );
    }
    const intent = "AUTHORIZE" as const;

    const config = this.getConfig();
    const token = await this.getAccessToken();

    const url = `${config.baseUrl}/v2/checkout/orders`;
    const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const formattedAmount = (input.amountCents / 100).toFixed(2);
    const appBase = config.appBaseUrl ?? DEFAULT_APP_BASE_URL;
    const returnUrl = input.returnUrl ?? `${appBase}/api/purchases/${encodeURIComponent(input.referenceId)}/paypal/return`;
    const cancelUrl = input.cancelUrl ?? `${appBase}/api/purchases/${encodeURIComponent(input.referenceId)}/paypal/cancel`;

    // In this approval-only, no-capture workflow:
    // user_action is explicitly set to "CONTINUE" (not "PAY_NOW").
    // "CONTINUE" presents a "Continue" / "Continue to Review Order" action to the buyer,
    // accurately communicating that authorization is being granted under assurance rules,
    // without misrepresenting the flow as an immediate funds capture.
    const userAction = input.userAction ?? "CONTINUE";

    const payload = {
      intent,
      purchase_units: [
        {
          reference_id: input.referenceId,
          description: input.description ?? `Purchase Assurance: ${input.referenceId}`,
          custom_id: input.referenceId,
          amount: {
            currency_code: input.currency,
            value: formattedAmount,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Plinthly Purchase Assurance",
            shipping_preference: "NO_SHIPPING",
            user_action: userAction,
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    };

    let res: Response;
    try {
      res = await this.customFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": input.idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new PayPalTimeoutError(`PayPal Sandbox order creation timed out after ${timeout}ms`);
      }
      throw new PayPalNetworkError(
        `Failed to connect to PayPal Sandbox order endpoint: ${(err as Error)?.message ?? "network error"}`,
        err
      );
    }

    if (res.status === 401) {
      this.clearCachedToken();
    }

    if (!res.ok) {
      let errorBody: unknown = null;
      try {
        errorBody = await res.json();
      } catch {
        // non-JSON
      }
      const errObj = errorBody as { name?: string; message?: string; debug_id?: string } | null;
      const errorName = errObj?.name ?? "order_create_error";
      const errorMsg = errObj?.message ?? `PayPal Sandbox order creation failed with HTTP ${res.status}`;
      throw new PayPalApiError(res.status, errorName, errorMsg, errObj?.debug_id);
    }

    const data = (await res.json()) as PayPalOrderResponse;
    if (!data.id) {
      throw new PayPalApiError(500, "malformed_order_response", "PayPal Sandbox returned an order response with missing ID");
    }

    return data;
  }

  /**
   * Independently retrieves an order from PayPal Sandbox to verify authoritative external status.
   */
  async getOrder(orderId: string): Promise<PayPalGetOrderResponse> {
    const trimmedId = orderId.trim();
    if (!trimmedId) {
      throw new PayPalApiError(400, "invalid_order_id", "orderId must be a non-empty string");
    }

    const config = this.getConfig();
    const token = await this.getAccessToken();

    const url = `${config.baseUrl}/v2/checkout/orders/${encodeURIComponent(trimmedId)}`;
    const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let res: Response;
    try {
      res = await this.customFetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new PayPalTimeoutError(`PayPal Sandbox getOrder timed out after ${timeout}ms`);
      }
      throw new PayPalNetworkError(
        `Failed to reach PayPal Sandbox getOrder endpoint: ${(err as Error)?.message ?? "network error"}`,
        err
      );
    }

    if (res.status === 401) {
      this.clearCachedToken();
    }

    if (!res.ok) {
      let errorBody: unknown = null;
      try {
        errorBody = await res.json();
      } catch {
        // non-JSON
      }
      const errObj = errorBody as { name?: string; message?: string; debug_id?: string } | null;
      const errorName = errObj?.name ?? "order_get_error";
      const errorMsg = errObj?.message ?? `PayPal Sandbox getOrder failed with HTTP ${res.status}`;
      throw new PayPalApiError(res.status, errorName, errorMsg, errObj?.debug_id);
    }

    const data = (await res.json()) as PayPalGetOrderResponse;
    if (!data.id || !data.status) {
      throw new PayPalApiError(500, "malformed_order_response", "PayPal getOrder response missing id or status");
    }

    return data;
  }
}

let globalPayPalClient: PayPalSandboxClient | null = null;

export function getPayPalSandboxClient(): PayPalSandboxClient {
  if (!globalPayPalClient) {
    globalPayPalClient = new PayPalSandboxClient();
  }
  return globalPayPalClient;
}

export function setPayPalSandboxClient(client: PayPalSandboxClient | null): void {
  globalPayPalClient = client;
}
