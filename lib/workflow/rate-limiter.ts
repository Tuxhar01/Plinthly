import { NextResponse } from "next/server";

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
}

interface WindowBucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory sliding window rate limiter.
 *
 * Multi-Instance Architecture Note:
 * - In a single-instance container (e.g. Render Starter web service), this provides
 *   zero-latency, in-process rate limiting without external dependencies (e.g. Redis).
 * - Across multiple horizontally autoscaled instances, each instance maintains its own
 *   independent window bucket. A client routed across N instances receives a cluster limit
 *   of N * maxRequests. This cleanly prevents single-instance CPU/memory starvation while
 *   avoiding a hard failure mode if an external cache becomes temporarily unreachable.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
  }

  check(key: string, now: number = Date.now()): {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: number;
  } {
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.buckets.set(key, bucket);
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - 1),
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += 1;
    const allowed = bucket.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - bucket.count);

    return {
      allowed,
      limit: this.maxRequests,
      remaining,
      resetAt: bucket.resetAt,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

// Configured singleton rate limiters for expensive external API endpoints
export const aiDecompositionLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 15,     // 15 requests/min for Gemini LLM decomposition
});

export const discoverySearchLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,     // 30 requests/min for Channel3 catalog discovery
});

export const shippingQuoteLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,     // 30 requests/min for Retailer shipping quotes
});

export const judgeSessionLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10,     // 10 requests/min for judge session authentication
});

export function extractClientIdentifier(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "anonymous_client";
}

export function enforceRateLimit(
  limiter: RateLimiter,
  req: Request,
  endpointName: string
): { ok: true; headers: Record<string, string> } | { ok: false; response: NextResponse } {
  const clientId = extractClientIdentifier(req);
  const key = `${endpointName}:${clientId}`;
  const result = limiter.check(key);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };

  if (!result.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: "rate_limited",
            message: `Rate limit exceeded for ${endpointName}. Please wait before retrying.`,
            retryAfterSeconds: retryAfterSec,
          },
        },
        {
          status: 429,
          headers: {
            ...headers,
            "Retry-After": String(retryAfterSec),
          },
        }
      ),
    };
  }

  return { ok: true, headers };
}
