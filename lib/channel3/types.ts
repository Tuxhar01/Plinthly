import { z } from "zod";

/**
 * Upstream Channel3 Price Schema
 * Official: https://api.trychannel3.com/openapi.json
 */
export const channel3PriceSchema = z.object({
  price: z.number().describe("The current price of the product"),
  compare_at_price: z.number().nullable().optional().describe("The original price before discounts"),
  currency: z.string().describe("ISO 4217 currency code e.g. USD"),
});

export type Channel3Price = z.infer<typeof channel3PriceSchema>;

/**
 * Upstream Channel3 ProductOffer Schema
 * Official: https://api.trychannel3.com/openapi.json
 */
export const channel3OfferSchema = z.object({
  url: z.string().describe("Merchant destination or attributed buy link"),
  domain: z.string().describe("Merchant domain e.g. dell.com"),
  price: channel3PriceSchema,
  availability: z.string().describe("Offer availability status e.g. InStock, OutOfStock"),
  condition: z.string().nullable().optional(),
  max_commission_rate: z.number().optional(),
  dimensions: z.unknown().nullable().optional(),
});

export type Channel3Offer = z.infer<typeof channel3OfferSchema>;

/**
 * Upstream Channel3 Product Schema
 * Official: https://api.trychannel3.com/openapi.json
 */
export const channel3ProductSchema = z.object({
  id: z.string().describe("Channel3 product ID"),
  title: z.string().describe("Product title"),
  description: z.string().nullable().optional(),
  brands: z
    .array(
      z.object({
        name: z.string().optional(),
      })
    )
    .optional(),
  images: z
    .array(
      z.object({
        url: z.string().optional(),
      })
    )
    .optional(),
  category: z.unknown().nullable().optional(),
  materials: z.array(z.string()).nullable().optional(),
  key_features: z.array(z.string()).nullable().optional(),
  offers: z.array(channel3OfferSchema).optional(),
  structured_attributes: z.record(z.string(), z.array(z.string())).nullable().optional(),
});

export type Channel3Product = z.infer<typeof channel3ProductSchema>;

/**
 * Upstream Channel3 SearchResponse Schema
 * Official: https://api.trychannel3.com/openapi.json
 */
export const channel3SearchResponseSchema = z.object({
  products: z.array(channel3ProductSchema),
  next_page_token: z.string().nullable().optional(),
});

export type Channel3SearchResponse = z.infer<typeof channel3SearchResponseSchema>;

/**
 * Search options passed to the Channel3 client.
 */
export interface Channel3SearchOptions {
  query: string;
  limit?: number;
  filters?: {
    price?: {
      min_price?: number;
      max_price?: number;
    };
    availability?: readonly string[];
    website_ids?: readonly string[];
    brand_ids?: readonly string[];
    [key: string]: unknown;
  };
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

/**
 * Specific error classes for Channel3 interactions.
 */
export class Channel3Error extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "Channel3Error";
    this.code = code;
    this.status = status;
  }
}

export class Channel3ConfigError extends Channel3Error {
  constructor(message: string = "Channel3 API key is not configured.") {
    super(message, "CHANNEL3_NOT_CONFIGURED");
    this.name = "Channel3ConfigError";
  }
}

export class Channel3TimeoutError extends Channel3Error {
  constructor(timeoutMs: number) {
    super(`Channel3 request timed out after ${timeoutMs}ms.`, "CHANNEL3_TIMEOUT", 504);
    this.name = "Channel3TimeoutError";
  }
}

export class Channel3NetworkError extends Channel3Error {
  constructor(message: string) {
    super(message, "CHANNEL3_NETWORK_ERROR", 502);
    this.name = "Channel3NetworkError";
  }
}

export class Channel3ApiError extends Channel3Error {
  constructor(message: string, code: string, status: number) {
    super(message, code, status);
    this.name = "Channel3ApiError";
  }
}
