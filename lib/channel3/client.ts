import {
  Channel3ApiError,
  Channel3ConfigError,
  Channel3NetworkError,
  Channel3SearchOptions,
  Channel3SearchResponse,
  channel3SearchResponseSchema,
  Channel3TimeoutError,
} from "./types";

export const DEFAULT_CHANNEL3_BASE_URL = "https://api.trychannel3.com";
export const DEFAULT_CHANNEL3_TIMEOUT_MS = 8000;

/**
 * Executes a product search against the Channel3 REST API.
 * Server-only execution. Reads CHANNEL3_API_KEY from environment or explicit option.
 *
 * Safety & Privacy:
 * - Never prints or logs the API key or authorization headers.
 * - Enforces bounded timeouts via AbortSignal.
 * - Performs strict runtime schema validation of upstream data.
 * - Does not invent mock products when the provider fails.
 */
export async function searchChannel3(options: Channel3SearchOptions): Promise<Channel3SearchResponse> {
  const apiKey = (options.apiKey ?? process.env.CHANNEL3_API_KEY ?? "").trim();
  if (apiKey.length === 0) {
    throw new Channel3ConfigError(
      "Channel3 API key is not configured. Server environment variable CHANNEL3_API_KEY must be provided."
    );
  }

  const baseUrl = (options.baseUrl ?? process.env.CHANNEL3_BASE_URL ?? DEFAULT_CHANNEL3_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHANNEL3_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 1;
  const fetchFn = options.fetchFn ?? fetch;

  const endpoint = `${baseUrl}/v1/search`;

  const requestBody: Record<string, unknown> = {
    query: options.query,
    limit: options.limit ?? 20,
  };

  if (options.filters && Object.keys(options.filters).length > 0) {
    requestBody.filters = options.filters;
  }

  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === "AbortError") {
        throw new Channel3TimeoutError(timeoutMs);
      }

      // If aborted by controller
      if (controller.signal.aborted) {
        throw new Channel3TimeoutError(timeoutMs);
      }

      throw new Channel3NetworkError(
        `Channel3 connection failed: ${err instanceof Error ? err.message : "Unknown network error."}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      let rawJson: unknown;
      try {
        rawJson = await response.json();
      } catch (err: unknown) {
        throw new Channel3NetworkError(
          `Failed to parse Channel3 JSON response: ${err instanceof Error ? err.message : "Invalid JSON."}`
        );
      }

      const parseResult = channel3SearchResponseSchema.safeParse(rawJson);
      if (!parseResult.success) {
        throw new Channel3ApiError(
          `Channel3 response schema validation failed: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
          "CHANNEL3_SCHEMA_MISMATCH",
          response.status
        );
      }

      return parseResult.data;
    }

    // Upstream returned an error status
    const status = response.status;

    // Retry transient 429 or 503 up to maxRetries
    if ((status === 429 || status === 503) && attempt <= maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      continue;
    }

    let errorDetail = "";
    try {
      const errJson = (await response.json()) as Record<string, unknown>;
      if (typeof errJson?.detail === "string") {
        errorDetail = errJson.detail;
      } else if (Array.isArray(errJson?.detail)) {
        errorDetail = errJson.detail
          .map((d: { msg?: string; loc?: string[] }) => d.msg ?? JSON.stringify(d))
          .join("; ");
      }
    } catch {
      // Body may not be JSON
    }

    if (status === 401) {
      throw new Channel3ApiError(
        `Channel3 authentication failed (HTTP 401). ${errorDetail || "Invalid or unauthorized API key."}`,
        "CHANNEL3_UNAUTHORIZED",
        401
      );
    }

    if (status === 402) {
      throw new Channel3ApiError(
        `Channel3 payment required (HTTP 402). ${errorDetail || "Credits exhausted or payment method required."}`,
        "CHANNEL3_PAYMENT_REQUIRED",
        402
      );
    }

    if (status === 422) {
      throw new Channel3ApiError(
        `Channel3 search request validation error (HTTP 422): ${errorDetail || "Invalid search parameters."}`,
        "CHANNEL3_VALIDATION_ERROR",
        422
      );
    }

    if (status === 429) {
      throw new Channel3ApiError(
        `Channel3 rate limit exceeded (HTTP 429). ${errorDetail || "Please retry later."}`,
        "CHANNEL3_RATE_LIMITED",
        429
      );
    }

    if (status >= 500) {
      throw new Channel3ApiError(
        `Channel3 upstream server error (HTTP ${status}). ${errorDetail || "Service temporarily unavailable."}`,
        "CHANNEL3_UPSTREAM_ERROR",
        status
      );
    }

    throw new Channel3ApiError(
      `Channel3 search failed with HTTP status ${status}. ${errorDetail || ""}`.trim(),
      "CHANNEL3_UPSTREAM_ERROR",
      status
    );
  }
}
