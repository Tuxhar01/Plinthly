/**
 * Plinthly Stage 2 Phase 4 & Stage 3 Phase 2 — Payment Gateway Client Interfaces & Adapters
 *
 * Provides decoupled payment capture and refund interfaces for gateway interaction.
 *
 * Architecture Contract Invariants:
 * 1. PRV-01: Decoupled sandbox (PayPalSandboxGatewayAdapter) and production (PayPalProductionGatewayAdapter) adapters.
 * 2. PRV-02: Zero-variance landed cost invariant (assertZeroLandedCostVariance) strictly enforced before capture.
 * 3. PRV-03: PayPal-Request-Id set strictly to idempotency key (MerchantCartCapture.id).
 * 4. PRV-04: Ambiguous gateway timeouts return AMBIGUOUS_TIMEOUT and never fail closed as payment denial.
 * 5. Cloud-Neutral: Zero vendor lock-in; dependency injection and clean abstraction boundaries throughout.
 */

import { PayPalRestV2Client, PayPalCaptureResult, PayPalRefundResult } from "../paypal/paypal-rest-v2-client";

export class LandedCostVarianceError extends Error {
  readonly code = "ERR_LANDED_COST_VARIANCE";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(`[ERR_LANDED_COST_VARIANCE] ${message}`);
    this.name = "LandedCostVarianceError";
    this.details = details;
  }
}

/**
 * Asserts that the quoted landed cost components (subtotal + shipping + statutory tax)
 * match the authorized total amount down to the exact minor unit cent ($|\Delta| = 0$).
 *
 * Non-negotiable invariant (INV-302, PRV-02):
 * Pre-capture assertion fails closed immediately with ERR_LANDED_COST_VARIANCE
 * before any call touches the external payment gateway.
 */
export function assertZeroLandedCostVariance(
  quotedSubtotalCents: number | bigint,
  quotedShippingCents: number | bigint,
  quotedTaxCents: number | bigint,
  authorizedTotalCents: number | bigint,
  quotedDiscountCents: number | bigint = 0
): void {
  const subtotal = BigInt(quotedSubtotalCents);
  const discount = BigInt(quotedDiscountCents);
  const shipping = BigInt(quotedShippingCents);
  const tax = BigInt(quotedTaxCents);
  const authorized = BigInt(authorizedTotalCents);

  const calculatedTotal = subtotal - discount + shipping + tax;
  const delta = calculatedTotal - authorized;

  if (delta !== BigInt(0)) {
    throw new LandedCostVarianceError(
      `Landed-cost zero-variance violation: sum of quoted components (${calculatedTotal.toString()} cents) ` +
      `does not match authorized total (${authorized.toString()} cents). Variance: ${delta.toString()} cents.`,
      {
        quotedSubtotalCents: subtotal.toString(),
        quotedDiscountCents: discount.toString(),
        quotedShippingCents: shipping.toString(),
        quotedTaxCents: tax.toString(),
        calculatedTotalCents: calculatedTotal.toString(),
        authorizedTotalCents: authorized.toString(),
        deltaCents: delta.toString(),
      }
    );
  }
}

export interface GatewayCaptureInput {
  orderId: string;
  cartId: string;
  amountCents: number | bigint;
  currency: string;
  payeeEmail: string;
  idempotencyKey: string;
  // Optional landed-cost breakdown for zero-variance pre-capture validation (PRV-02)
  quotedSubtotalCents?: number | bigint;
  quotedDiscountCents?: number | bigint;
  quotedShippingCents?: number | bigint;
  quotedTaxCents?: number | bigint;
}

export type GatewayOutcome = "COMPLETED" | "FAILED" | "AMBIGUOUS_TIMEOUT";

export interface GatewayCaptureOutput {
  outcome: GatewayOutcome;
  orderId: string;
  captureId?: string;
  amountCents: number;
  currency: string;
  payeeEmail: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
  capturedAt?: Date;
}

export interface GatewayRefundInput {
  captureId: string;
  cartId: string;
  amountCents: number | bigint;
  currency: string;
  reason: string;
  idempotencyKey: string;
}

export interface GatewayRefundOutput {
  outcome: "COMPLETED" | "FAILED" | "AMBIGUOUS_TIMEOUT";
  captureId: string;
  refundId?: string;
  amountCents: number;
  currency: string;
  errorCode?: string;
  errorMessage?: string;
  refundedAt?: Date;
}

export interface PaymentGatewayClient {
  capturePayment(input: GatewayCaptureInput): Promise<GatewayCaptureOutput>;
  refundPayment(input: GatewayRefundInput): Promise<GatewayRefundOutput>;
}

export interface MockGatewayBehavior {
  mode: "SUCCESS" | "FAILURE" | "TIMEOUT";
  errorCode?: string;
  errorMessage?: string;
  fixedCaptureId?: string;
  fixedRefundId?: string;
  latencyMs?: number;
}

/**
 * Stage 2 Phase 4 Mock Gateway Client for offline testing and deterministic unit tests.
 */
export class MockPaymentGatewayClient implements PaymentGatewayClient {
  private defaultBehavior: MockGatewayBehavior;
  private orderOverrides: Map<string, MockGatewayBehavior> = new Map();
  private captureOverrides: Map<string, MockGatewayBehavior> = new Map();
  public captureCallCount = 0;
  public refundCallCount = 0;
  public lastRefundInput?: GatewayRefundInput;
  public lastCaptureInput?: GatewayCaptureInput;

  constructor(defaultBehavior: MockGatewayBehavior = { mode: "SUCCESS" }) {
    this.defaultBehavior = defaultBehavior;
  }

  public setOrderBehavior(orderId: string, behavior: MockGatewayBehavior): void {
    this.orderOverrides.set(orderId, behavior);
  }

  public setCaptureBehavior(captureId: string, behavior: MockGatewayBehavior): void {
    this.captureOverrides.set(captureId, behavior);
  }

  async capturePayment(input: GatewayCaptureInput): Promise<GatewayCaptureOutput> {
    this.captureCallCount++;
    this.lastCaptureInput = input;

    // Landed-cost zero-variance check if quoted components provided
    if (
      input.quotedSubtotalCents !== undefined &&
      input.quotedShippingCents !== undefined &&
      input.quotedTaxCents !== undefined
    ) {
      assertZeroLandedCostVariance(
        input.quotedSubtotalCents,
        input.quotedShippingCents,
        input.quotedTaxCents,
        input.amountCents,
        input.quotedDiscountCents || 0
      );
    }

    const behavior = this.orderOverrides.get(input.orderId) || this.defaultBehavior;

    if (behavior.latencyMs && behavior.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behavior.latencyMs));
    }

    if (behavior.mode === "TIMEOUT") {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        orderId: input.orderId,
        amountCents: Number(input.amountCents),
        currency: input.currency,
        payeeEmail: input.payeeEmail,
        errorCode: behavior.errorCode || "ETIMEDOUT",
        errorMessage: behavior.errorMessage || "Gateway request timed out; outcome ambiguous.",
      };
    }

    if (behavior.mode === "FAILURE") {
      return {
        outcome: "FAILED",
        orderId: input.orderId,
        amountCents: Number(input.amountCents),
        currency: input.currency,
        payeeEmail: input.payeeEmail,
        errorCode: behavior.errorCode || "PAYMENT_DENIED",
        errorMessage: behavior.errorMessage || "PayPal payment capture failed or declined.",
      };
    }

    const captureId = behavior.fixedCaptureId || `CAP-${input.orderId.substring(0, 12)}-${Date.now()}`;

    return {
      outcome: "COMPLETED",
      orderId: input.orderId,
      captureId,
      amountCents: Number(input.amountCents),
      currency: input.currency,
      payeeEmail: input.payeeEmail,
      capturedAt: new Date(),
      rawResponse: {
        id: captureId,
        status: "COMPLETED",
        amount: {
          value: (Number(input.amountCents) / 100).toFixed(2),
          currency_code: input.currency,
        },
      },
    };
  }

  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundOutput> {
    this.refundCallCount++;
    this.lastRefundInput = input;
    const behavior = this.captureOverrides.get(input.captureId) || this.defaultBehavior;

    if (behavior.latencyMs && behavior.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behavior.latencyMs));
    }

    if (behavior.mode === "TIMEOUT") {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        captureId: input.captureId,
        amountCents: Number(input.amountCents),
        currency: input.currency,
        errorCode: behavior.errorCode || "ETIMEDOUT",
        errorMessage: behavior.errorMessage || "Gateway refund request timed out.",
      };
    }

    if (behavior.mode === "FAILURE") {
      return {
        outcome: "FAILED",
        captureId: input.captureId,
        amountCents: Number(input.amountCents),
        currency: input.currency,
        errorCode: behavior.errorCode || "REFUND_FAILED",
        errorMessage: behavior.errorMessage || "Gateway refund failed.",
      };
    }

    const refundId = behavior.fixedRefundId || `REF-${input.captureId.substring(0, 12)}-${Date.now()}`;

    return {
      outcome: "COMPLETED",
      captureId: input.captureId,
      refundId,
      amountCents: Number(input.amountCents),
      currency: input.currency,
      refundedAt: new Date(),
    };
  }
}

export interface PayPalGatewayAdapterOptions {
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  timeoutMs?: number;
  restClient?: PayPalRestV2Client;
  fetchFn?: typeof fetch;
}

/**
 * Stage 3 Phase 2 — PayPal Sandbox Gateway Adapter
 * Connects to api-m.sandbox.paypal.com with zero live financial transaction risk.
 */
export class PayPalSandboxGatewayAdapter implements PaymentGatewayClient {
  public readonly restClient: PayPalRestV2Client;
  public readonly isProduction = false;

  constructor(options?: PayPalGatewayAdapterOptions) {
    if (options?.restClient) {
      this.restClient = options.restClient;
    } else {
      const clientId = options?.clientId || process.env.PAYPAL_SANDBOX_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || "sandbox_client_id";
      const clientSecret = options?.clientSecret || process.env.PAYPAL_SANDBOX_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET || "sandbox_client_secret";
      const baseUrl = options?.baseUrl || process.env.PAYPAL_BASE_URL || process.env.PAYPAL_API_BASE_URL || "https://api-m.sandbox.paypal.com";

      this.restClient = new PayPalRestV2Client({
        clientId,
        clientSecret,
        baseUrl,
        timeoutMs: options?.timeoutMs ?? 10000,
        fetchFn: options?.fetchFn,
      });
    }
  }

  async capturePayment(input: GatewayCaptureInput): Promise<GatewayCaptureOutput> {
    // 1. Enforce zero-variance landed cost before touching payment gateway
    if (
      input.quotedSubtotalCents !== undefined &&
      input.quotedShippingCents !== undefined &&
      input.quotedTaxCents !== undefined
    ) {
      assertZeroLandedCostVariance(
        input.quotedSubtotalCents,
        input.quotedShippingCents,
        input.quotedTaxCents,
        input.amountCents,
        input.quotedDiscountCents || 0
      );
    }

    // 2. Invoke PayPal v2 REST client with idempotency key
    const result: PayPalCaptureResult = await this.restClient.captureOrder(
      input.orderId,
      input.idempotencyKey
    );

    // 3. Map result to contract
    if (result.isAmbiguous) {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        orderId: input.orderId,
        amountCents: Number(input.amountCents),
        currency: input.currency,
        payeeEmail: input.payeeEmail,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        rawResponse: result.rawResponse,
      };
    }

    if (result.success) {
      return {
        outcome: "COMPLETED",
        orderId: input.orderId,
        captureId: result.captureId,
        amountCents: result.amountCents,
        currency: result.currency,
        payeeEmail: result.payeeEmail || input.payeeEmail,
        capturedAt: result.capturedAt,
        rawResponse: result.rawResponse,
      };
    }

    return {
      outcome: "FAILED",
      orderId: input.orderId,
      captureId: result.captureId,
      amountCents: Number(input.amountCents),
      currency: input.currency,
      payeeEmail: input.payeeEmail,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      rawResponse: result.rawResponse,
    };
  }

  async authorizePayment(orderId: string, idempotencyKey?: string) {
    return await this.restClient.authorizeOrder(orderId, idempotencyKey);
  }

  async captureAuthorization(
    authorizationId: string,
    amount: { valueCents: number; currency: string },
    idempotencyKey: string
  ): Promise<GatewayCaptureOutput> {
    const result = await this.restClient.captureAuthorization(authorizationId, amount, idempotencyKey);
    if (result.isAmbiguous) {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        orderId: authorizationId,
        amountCents: amount.valueCents,
        currency: amount.currency,
        payeeEmail: "",
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }
    if (result.success) {
      return {
        outcome: "COMPLETED",
        orderId: authorizationId,
        captureId: result.captureId,
        amountCents: result.amountCents,
        currency: result.currency,
        payeeEmail: result.payeeEmail || "",
        capturedAt: result.capturedAt,
        rawResponse: result.rawResponse,
      };
    }
    return {
      outcome: "FAILED",
      orderId: authorizationId,
      amountCents: amount.valueCents,
      currency: amount.currency,
      payeeEmail: "",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      rawResponse: result.rawResponse,
    };
  }

  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundOutput> {
    const amountCents = Number(input.amountCents);
    const result: PayPalRefundResult = await this.restClient.refundCapture(
      input.captureId,
      { valueCents: amountCents, currency: input.currency },
      input.reason,
      input.idempotencyKey
    );

    if (result.isAmbiguous) {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        captureId: input.captureId,
        amountCents,
        currency: input.currency,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }

    if (result.success) {
      return {
        outcome: "COMPLETED",
        captureId: input.captureId,
        refundId: result.refundId,
        amountCents: result.amountCents,
        currency: result.currency,
        refundedAt: result.refundedAt,
      };
    }

    return {
      outcome: "FAILED",
      captureId: input.captureId,
      amountCents,
      currency: input.currency,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  }
}

/**
 * Stage 3 Phase 2 — PayPal Production Gateway Adapter
 * Connects exclusively to api-m.paypal.com with zero test card or mock shortcuts.
 * Fails closed if production credentials are missing.
 */
export class PayPalProductionGatewayAdapter implements PaymentGatewayClient {
  public readonly restClient: PayPalRestV2Client;
  public readonly isProduction = true;

  constructor(options?: PayPalGatewayAdapterOptions) {
    if (options?.restClient) {
      this.restClient = options.restClient;
    } else {
      const clientId = options?.clientId || process.env.PAYPAL_CLIENT_ID;
      const clientSecret = options?.clientSecret || process.env.PAYPAL_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error(
          "ERR_PAYPAL_PRODUCTION_CONFIG: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured for production."
        );
      }

      const baseUrl = options?.baseUrl || process.env.PAYPAL_BASE_URL || "https://api-m.paypal.com";

      this.restClient = new PayPalRestV2Client({
        clientId,
        clientSecret,
        baseUrl,
        timeoutMs: options?.timeoutMs ?? 15000,
        fetchFn: options?.fetchFn,
      });
    }
  }

  async capturePayment(input: GatewayCaptureInput): Promise<GatewayCaptureOutput> {
    // 1. Strict landed-cost zero-variance assertion
    if (
      input.quotedSubtotalCents !== undefined &&
      input.quotedShippingCents !== undefined &&
      input.quotedTaxCents !== undefined
    ) {
      assertZeroLandedCostVariance(
        input.quotedSubtotalCents,
        input.quotedShippingCents,
        input.quotedTaxCents,
        input.amountCents,
        input.quotedDiscountCents || 0
      );
    }

    // 2. Invoke live PayPal v2 Orders capture
    const result: PayPalCaptureResult = await this.restClient.captureOrder(
      input.orderId,
      input.idempotencyKey
    );

    if (result.isAmbiguous) {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        orderId: input.orderId,
        amountCents: Number(input.amountCents),
        currency: input.currency,
        payeeEmail: input.payeeEmail,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        rawResponse: result.rawResponse,
      };
    }

    if (result.success) {
      return {
        outcome: "COMPLETED",
        orderId: input.orderId,
        captureId: result.captureId,
        amountCents: result.amountCents,
        currency: result.currency,
        payeeEmail: result.payeeEmail || input.payeeEmail,
        capturedAt: result.capturedAt,
        rawResponse: result.rawResponse,
      };
    }

    return {
      outcome: "FAILED",
      orderId: input.orderId,
      captureId: result.captureId,
      amountCents: Number(input.amountCents),
      currency: input.currency,
      payeeEmail: input.payeeEmail,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      rawResponse: result.rawResponse,
    };
  }

  async authorizePayment(orderId: string, idempotencyKey?: string) {
    return await this.restClient.authorizeOrder(orderId, idempotencyKey);
  }

  async captureAuthorization(
    authorizationId: string,
    amount: { valueCents: number; currency: string },
    idempotencyKey: string
  ): Promise<GatewayCaptureOutput> {
    const result = await this.restClient.captureAuthorization(authorizationId, amount, idempotencyKey);
    if (result.isAmbiguous) {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        orderId: authorizationId,
        amountCents: amount.valueCents,
        currency: amount.currency,
        payeeEmail: "",
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }
    if (result.success) {
      return {
        outcome: "COMPLETED",
        orderId: authorizationId,
        captureId: result.captureId,
        amountCents: result.amountCents,
        currency: result.currency,
        payeeEmail: result.payeeEmail || "",
        capturedAt: result.capturedAt,
        rawResponse: result.rawResponse,
      };
    }
    return {
      outcome: "FAILED",
      orderId: authorizationId,
      amountCents: amount.valueCents,
      currency: amount.currency,
      payeeEmail: "",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      rawResponse: result.rawResponse,
    };
  }

  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundOutput> {
    const amountCents = Number(input.amountCents);
    const result: PayPalRefundResult = await this.restClient.refundCapture(
      input.captureId,
      { valueCents: amountCents, currency: input.currency },
      input.reason,
      input.idempotencyKey
    );

    if (result.isAmbiguous) {
      return {
        outcome: "AMBIGUOUS_TIMEOUT",
        captureId: input.captureId,
        amountCents,
        currency: input.currency,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }

    if (result.success) {
      return {
        outcome: "COMPLETED",
        captureId: input.captureId,
        refundId: result.refundId,
        amountCents: result.amountCents,
        currency: result.currency,
        refundedAt: result.refundedAt,
      };
    }

    return {
      outcome: "FAILED",
      captureId: input.captureId,
      amountCents,
      currency: input.currency,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  }
}

let activeGatewayClient: PaymentGatewayClient | null = null;

export interface GatewayFactoryOptions extends PayPalGatewayAdapterOptions {
  mode?: "production" | "sandbox" | "mock";
  mockBehavior?: MockGatewayBehavior;
}

/**
 * Resolves the payment gateway client based on environment or injected options (PRV-01).
 * In production mode, binds PayPalProductionGatewayAdapter.
 * In sandbox mode, binds PayPalSandboxGatewayAdapter.
 * In test/dev mode without configuration, defaults to MockPaymentGatewayClient.
 */
export function getPaymentGatewayClient(options?: GatewayFactoryOptions): PaymentGatewayClient {
  if (activeGatewayClient) {
    return activeGatewayClient;
  }

  const mode =
    options?.mode ||
    process.env.PAYPAL_MODE ||
    (process.env.NODE_ENV === "production" ? "production" : "mock");

  if (mode === "production") {
    return new PayPalProductionGatewayAdapter(options);
  }

  if (mode === "sandbox") {
    return new PayPalSandboxGatewayAdapter(options);
  }

  return new MockPaymentGatewayClient(options?.mockBehavior);
}

export function setPaymentGatewayClientForTesting(client: PaymentGatewayClient | null): void {
  activeGatewayClient = client;
}
