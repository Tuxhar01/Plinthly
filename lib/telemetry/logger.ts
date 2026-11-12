/**
 * Plinthly Stage 3 Phase 5 — Structured JSON Telemetry Logger (OPS-02)
 *
 * Emits uniform single-line JSON log events to stdout adhering to the Stage 3 telemetry schema:
 * - timestamp (ISO-8601 UTC)
 * - level (DEBUG | INFO | WARN | ERROR | FATAL)
 * - traceId (UUIDv4 distributed trace identifier)
 * - actorId (optional authenticated principal)
 * - cartId (optional associated merchant cart)
 * - durationMs (optional execution duration)
 * - message (human-readable event description)
 * - sqlState (optional PostgreSQL SQLSTATE code)
 * - context (sanitized contextual metadata)
 */

import crypto from "crypto";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export interface LogEventContext {
  traceId?: string;
  actorId?: string;
  cartId?: string;
  durationMs?: number;
  sqlState?: string;
  [key: string]: unknown;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: LogLevel;
  traceId: string;
  actorId?: string;
  cartId?: string;
  durationMs?: number;
  message: string;
  sqlState?: string;
  context?: Record<string, unknown>;
}

// Sensitive key patterns to redact automatically
const SENSITIVE_KEY_REGEX = /(password|secret|token|authorization|privatekey|creditcard|cvv|api[-_]?key)/i;

function sanitizeContext(data: unknown, depth = 0): unknown {
  if (depth > 5) return "[DEPTH_LIMIT]";
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeContext(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeContext(val, depth + 1);
    }
  }
  return sanitized;
}

export class TelemetryLogger {
  private defaultContext: LogEventContext;

  constructor(defaultContext: LogEventContext = {}) {
    this.defaultContext = {
      traceId: defaultContext.traceId || crypto.randomUUID(),
      ...defaultContext,
    };
  }

  child(additionalContext: LogEventContext): TelemetryLogger {
    return new TelemetryLogger({
      ...this.defaultContext,
      ...additionalContext,
    });
  }

  getTraceId(): string {
    return this.defaultContext.traceId || "";
  }

  private emit(level: LogLevel, message: string, ctx?: LogEventContext): StructuredLogRecord {
    const merged = { ...this.defaultContext, ...(ctx || {}) };
    const traceId = merged.traceId || crypto.randomUUID();
    const actorId = merged.actorId;
    const cartId = merged.cartId;
    const durationMs = merged.durationMs;
    const sqlState = merged.sqlState;

    // Filter out top-level known fields from arbitrary context
    const {
      traceId: _t,
      actorId: _a,
      cartId: _c,
      durationMs: _d,
      sqlState: _s,
      ...extraContext
    } = merged;

    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      traceId,
      message,
    };

    if (actorId) record.actorId = actorId;
    if (cartId) record.cartId = cartId;
    if (typeof durationMs === "number") record.durationMs = durationMs;
    if (sqlState) record.sqlState = sqlState;

    if (Object.keys(extraContext).length > 0) {
      record.context = sanitizeContext(extraContext) as Record<string, unknown>;
    }

    const output = JSON.stringify(record);
    if (level === "ERROR" || level === "FATAL") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }

    return record;
  }

  debug(message: string, context?: LogEventContext): StructuredLogRecord {
    return this.emit("DEBUG", message, context);
  }

  info(message: string, context?: LogEventContext): StructuredLogRecord {
    return this.emit("INFO", message, context);
  }

  warn(message: string, context?: LogEventContext): StructuredLogRecord {
    return this.emit("WARN", message, context);
  }

  error(message: string, context?: LogEventContext): StructuredLogRecord {
    return this.emit("ERROR", message, context);
  }

  fatal(message: string, context?: LogEventContext): StructuredLogRecord {
    return this.emit("FATAL", message, context);
  }
}

// Global root logger instance
export const telemetryLogger = new TelemetryLogger({
  service: "plinthly-procurement-core",
  environment: process.env.NODE_ENV || "development",
});

