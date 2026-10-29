export class WorkflowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export class NotFoundError extends WorkflowError {
  constructor(message: string = "Resource not found") {
    super("not_found", message, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends WorkflowError {
  constructor(message: string, details?: unknown) {
    super("invalid_input", message, 400, details);
    this.name = "ValidationError";
  }
}

export class IllegalTransitionError extends WorkflowError {
  constructor(code: string, message: string) {
    super(code, message, 422);
    this.name = "IllegalTransitionError";
  }
}

export class ApprovalIntegrityError extends WorkflowError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422, details);
    this.name = "ApprovalIntegrityError";
  }
}

export class ConcurrencyConflictError extends WorkflowError {
  constructor(message: string = "Concurrent modification conflict") {
    super("concurrency_conflict", message, 409);
    this.name = "ConcurrencyConflictError";
  }
}

export class UnauthorizedError extends WorkflowError {
  constructor(message: string = "Authentication required.") {
    super("unauthorized", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends WorkflowError {
  constructor(message: string = "Access forbidden.") {
    super("forbidden", message, 403);
    this.name = "ForbiddenError";
  }
}

export class IdempotencyConflictError extends WorkflowError {
  constructor(message: string = "Idempotency key reused with different request payload.") {
    super("idempotency_conflict", message, 409);
    this.name = "IdempotencyConflictError";
  }
}

export class DatabaseUnavailableError extends Error {
  constructor(
    message: string = "PostgreSQL database is not configured or unavailable. Configure DATABASE_URL in .env to connect to a PostgreSQL database. Falling back to in-memory persistence is prohibited."
  ) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}
