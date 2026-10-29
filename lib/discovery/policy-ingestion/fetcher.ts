/**
 * Plinthly Phase 13C — Authoritative Policy Source Fetcher.
 *
 * Implements safe, bounded, allowlisted HTTPS ingestion for official retailer shipping policy pages.
 *
 * Enforces:
 * 1. Strict HTTPS-only allowlist of official retailer policy URLs.
 * 2. Response size bounds (max 2 MB) to prevent unbounded memory growth.
 * 3. Request timeout bounds via AbortController.
 * 4. Conditional HTTP requests (If-None-Match, If-Modified-Since) and 304 handling.
 * 5. Safe redirect handling: redirects must remain on allowlisted domains.
 * 6. Cryptographic SHA-256 hashing of raw page contents.
 */

import { createHash } from "node:crypto";
import { PolicySourceRecord } from "./types";

export const ALLOWLISTED_POLICY_URLS: readonly string[] = [
  "https://www.bestbuy.com/site/help-topics/shipping-delivery-and-store-pickup/pcmcat1504113264003.c",
  "https://www.walmart.com/help/article/shipping-rates-and-delivery/4113264426aa41aa9d00da81691a5e1e",
  "https://help.target.com/help/subcategoryarticle?childcat=Free+shipping",
  "https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp",
];

export const ALLOWLISTED_POLICY_HOSTS: readonly string[] = [
  "www.bestbuy.com",
  "bestbuy.com",
  "www.walmart.com",
  "walmart.com",
  "help.target.com",
  "www.target.com",
  "target.com",
  "www.bhphotovideo.com",
  "bhphotovideo.com",
];

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const MAX_POLICY_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

export class PolicyFetchError extends Error {
  constructor(
    public readonly code:
      | "disallowed_url"
      | "insecure_scheme"
      | "disallowed_redirect"
      | "response_too_large"
      | "fetch_timeout"
      | "fetch_error"
      | "source_not_found"
      | "http_error",
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "PolicyFetchError";
  }
}

export interface FetchSourceOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly previousRawContentHash?: string;
  readonly customAllowlist?: readonly string[];
  readonly fetchFn?: typeof fetch;
}

export class PolicySourceFetcher {
  private readonly allowedUrls: ReadonlySet<string>;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly fetchFn: typeof fetch;

  constructor(options?: {
    readonly additionalUrls?: readonly string[];
    readonly fetchFn?: typeof fetch;
  }) {
    const urls = new Set<string>(ALLOWLISTED_POLICY_URLS);
    if (options?.additionalUrls) {
      for (const u of options.additionalUrls) {
        urls.add(u);
      }
    }
    this.allowedUrls = urls;
    this.allowedHosts = new Set<string>(ALLOWLISTED_POLICY_HOSTS);
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  /**
   * Validates that a candidate URL is HTTPS and present on the allowlist.
   */
  validateUrl(candidateUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(candidateUrl);
    } catch {
      throw new PolicyFetchError(
        "disallowed_url",
        `Policy source URL "${candidateUrl}" is not a valid URL.`
      );
    }

    if (parsed.protocol !== "https:") {
      throw new PolicyFetchError(
        "insecure_scheme",
        `Policy source URL "${candidateUrl}" must use HTTPS protocol. Refused: "${parsed.protocol}"`
      );
    }

    if (!this.allowedUrls.has(candidateUrl) && !this.allowedHosts.has(parsed.hostname)) {
      throw new PolicyFetchError(
        "disallowed_url",
        `Policy source URL "${candidateUrl}" is not in the approved retailer allowlist.`
      );
    }

    return parsed;
  }

  /**
   * Fetches an authoritative policy page over HTTPS with bounds checking and conditional headers.
   */
  async fetchSource(
    url: string,
    options?: FetchSourceOptions
  ): Promise<PolicySourceRecord> {
    const parsed = this.validateUrl(url);

    const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxBytes = options?.maxBytes ?? MAX_POLICY_RESPONSE_BYTES;
    const fetchImplementation = options?.fetchFn ?? this.fetchFn;

    const headers: Record<string, string> = {
      "User-Agent": "PlinthlyPolicyMonitor/2.0 (+https://plinthly.com/compliance)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    if (options?.etag) {
      headers["If-None-Match"] = options.etag;
    }
    if (options?.lastModified) {
      headers["If-Modified-Since"] = options.lastModified;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImplementation(parsed.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new PolicyFetchError(
          "fetch_timeout",
          `Request to "${url}" timed out after ${timeoutMs}ms.`
        );
      }
      throw new PolicyFetchError(
        "fetch_error",
        `Failed to fetch policy source at "${url}": ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }

    // Validate final redirected URL to ensure it did not redirect outside allowed hosts
    if (response.url) {
      try {
        const finalUrl = new URL(response.url);
        if (!this.allowedHosts.has(finalUrl.hostname)) {
          throw new PolicyFetchError(
            "disallowed_redirect",
            `Policy fetch redirected from "${url}" to disallowed host "${finalUrl.hostname}".`
          );
        }
      } catch (e) {
        if (e instanceof PolicyFetchError) throw e;
        throw new PolicyFetchError(
          "disallowed_redirect",
          `Invalid redirect URL received: "${response.url}"`
        );
      }
    }

    const retrievedAt = new Date().toISOString();
    const etag = response.headers.get("etag") ?? null;
    const lastModified = response.headers.get("last-modified") ?? null;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    // Handle HTTP 304 Not Modified
    if (response.status === 304) {
      return {
        sourceUrl: url,
        retrievedAt,
        httpStatus: 304,
        etag,
        lastModified,
        rawContentHash: options?.previousRawContentHash ?? "",
        contentLength: 0,
        isNotModified: true,
        responseHeaders,
      };
    }

    // Handle HTTP 404 or 410 (Source Removed)
    if (response.status === 404 || response.status === 410) {
      return {
        sourceUrl: url,
        retrievedAt,
        httpStatus: response.status,
        etag,
        lastModified,
        rawContentHash: "",
        contentLength: 0,
        isNotModified: false,
        responseHeaders,
      };
    }

    // Check Content-Length header against max allowed bytes
    const reportedLength = response.headers.get("content-length");
    if (reportedLength) {
      const parsedLength = parseInt(reportedLength, 10);
      if (!Number.isNaN(parsedLength) && parsedLength > maxBytes) {
        throw new PolicyFetchError(
          "response_too_large",
          `Content-Length ${parsedLength} exceeds maximum allowed size of ${maxBytes} bytes.`
        );
      }
    }

    // Read response text with length bounding
    const bodyText = await response.text();
    const bodyBytes = Buffer.byteLength(bodyText, "utf8");

    if (bodyBytes > maxBytes) {
      throw new PolicyFetchError(
        "response_too_large",
        `Received body size ${bodyBytes} exceeds maximum allowed size of ${maxBytes} bytes.`
      );
    }

    const rawContentHash = createHash("sha256")
      .update(bodyText, "utf8")
      .digest("hex")
      .toLowerCase();

    const isNotModified =
      options?.previousRawContentHash !== undefined &&
      options.previousRawContentHash === rawContentHash;

    return {
      sourceUrl: url,
      retrievedAt,
      httpStatus: response.status,
      etag,
      lastModified,
      rawContentHash,
      contentLength: bodyBytes,
      isNotModified,
      responseHeaders,
    };
  }
}

