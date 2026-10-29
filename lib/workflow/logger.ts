import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  readonly correlationId: string;
  readonly actorId?: string;
  readonly purchaseId?: string;
}

const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|api[-_]?key|cookie|session|payer[-_]?id|card|cvv)/i;

/**
 * Deeply redacts sensitive keys and patterns from an object or primitive before logging.
 */
export function redactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    // Redact Bearer tokens in headers or strings
    return data.replace(/(bearer\s+)([a-zA-Z0-9_\-\.]{8,})/gi, "$1[REDACTED]");
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  if (typeof data === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted;
  }

  return data;
}

export function extractCorrelationId(req?: Request): string {
  if (!req) return randomUUID();
  const headerId =
    req.headers.get("x-correlation-id") ||
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray");
  return headerId?.trim() || randomUUID();
}

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly correlationId: string;
  readonly actorId?: string;
  readonly purchaseId?: string;
  readonly durationMs?: number;
  readonly meta?: unknown;
}

export class StructuredLogger {
  constructor(private readonly context: LogContext) {}

  private write(level: LogLevel, event: string, meta?: Record<string, unknown>, durationMs?: number): StructuredLogEntry {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      correlationId: this.context.correlationId,
      ...(this.context.actorId ? { actorId: this.context.actorId } : {}),
      ...(this.context.purchaseId ? { purchaseId: this.context.purchaseId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(meta ? { meta: redactSensitiveData(meta) } : {}),
    };

    const serialized = JSON.stringify(entry);

    if (level === "error") {
      console.error(serialized);
    } else if (level === "warn") {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }

    return entry;
  }

  info(event: string, meta?: Record<string, unknown>, durationMs?: number): StructuredLogEntry {
    return this.write("info", event, meta, durationMs);
  }

  warn(event: string, meta?: Record<string, unknown>, durationMs?: number): StructuredLogEntry {
    return this.write("warn", event, meta, durationMs);
  }

  error(event: string, meta?: Record<string, unknown>, durationMs?: number): StructuredLogEntry {
    return this.write("error", event, meta, durationMs);
  }

  withContext(additional: Partial<LogContext>): StructuredLogger {
    return new StructuredLogger({
      ...this.context,
      ...additional,
    });
  }
}

export function getLogger(req?: Request, initialContext?: Partial<LogContext>): StructuredLogger {
  const correlationId = initialContext?.correlationId || extractCorrelationId(req);
  return new StructuredLogger({
    correlationId,
    ...initialContext,
  });
}
