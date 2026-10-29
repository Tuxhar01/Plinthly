import { Currency, PayPalOrderStatus } from "../state/types";

export interface PayPalConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl: string;
  readonly appBaseUrl?: string;
  readonly timeoutMs?: number;
}

export interface PayPalOAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly app_id?: string;
  readonly scope?: string;
}

export interface PayPalLinkDescription {
  readonly href: string;
  readonly rel: string;
  readonly method: string;
}

export interface PayPalExperienceContext {
  readonly brand_name?: string;
  readonly locale?: string;
  readonly shipping_preference?: "GET_FROM_FILE" | "NO_SHIPPING" | "SET_PROVIDED_ADDRESS";
  readonly user_action?: "CONTINUE" | "PAY_NOW";
  readonly return_url: string;
  readonly cancel_url: string;
}

export interface PayPalPaymentSource {
  readonly paypal?: {
    readonly experience_context?: PayPalExperienceContext;
  };
}

export interface PayPalCreateOrderInput {
  readonly referenceId: string;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly idempotencyKey: string;
  readonly description?: string;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  readonly userAction?: "CONTINUE" | "PAY_NOW";
  readonly intent?: "AUTHORIZE";
}

export interface PayPalOrderResponse {
  readonly id: string;
  readonly status: string;
  readonly links: readonly PayPalLinkDescription[];
}

export interface PayPalOrderPurchaseUnit {
  readonly reference_id?: string;
  readonly custom_id?: string;
  readonly amount?: {
    readonly currency_code: string;
    readonly value: string;
  };
}

export interface PayPalGetOrderResponse {
  readonly id: string;
  readonly status: PayPalOrderStatus;
  readonly intent: string;
  readonly purchase_units: readonly PayPalOrderPurchaseUnit[];
  readonly create_time?: string;
  readonly update_time?: string;
  readonly links?: readonly PayPalLinkDescription[];
}

export class PayPalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalError";
  }
}

export class PayPalConfigError extends PayPalError {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigError";
  }
}

export class PayPalNetworkError extends PayPalError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PayPalNetworkError";
  }
}

export class PayPalTimeoutError extends PayPalError {
  public readonly isTimeout = true;
  constructor(message: string = "PayPal Sandbox request timed out") {
    super(message);
    this.name = "PayPalTimeoutError";
  }
}

export class PayPalApiError extends PayPalError {
  constructor(
    public readonly statusCode: number,
    public readonly errorName: string,
    message: string,
    public readonly debugId?: string
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export class PayPalUnknownOutcomeError extends PayPalError {
  constructor(
    message: string,
    public readonly context: {
      readonly purchaseId: string;
      readonly idempotencyKey: string;
    }
  ) {
    super(message);
    this.name = "PayPalUnknownOutcomeError";
  }
}
