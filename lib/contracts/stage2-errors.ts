/**
 * Plinthly Stage 2 Canonical Error and SQLSTATE Mappings.
 *
 * Implements Section 5.1 of Architecture Contract v2.0.11:
 * Enforces single-source-of-truth parity between TypeScript/Zod exceptions
 * and PostgreSQL ANSI SQLSTATE codes emitted by SECURITY DEFINER routines.
 */

export const SQLSTATE_CODES = {
  DATA_EXCEPTION_NULL: "22004",
  DATA_EXCEPTION_INVALID_VALUE: "22023",
  DATA_EXCEPTION_NUMERIC_RANGE: "22003",
  INTEGRITY_CONSTRAINT_VIOLATION: "23505",
  PLPGSQL_NO_DATA_FOUND: "P0002",
  OBJECT_NOT_IN_PREREQ_STATE: "55000",
  SECURITY_EXCEPTION_INSUFFICIENT_PRIVILEGE: "42501",
  TRANSACTION_DEADLOCK: "40P01",
  TRANSACTION_SERIALIZATION_FAILURE: "40001",
} as const;

export type Stage2SqlState = (typeof SQLSTATE_CODES)[keyof typeof SQLSTATE_CODES];

export const STAGE2_ERROR_CODES = {
  // 22004: Data Exception — Null value not allowed
  ERR_NULL_PARAMETER: "ERR_NULL_PARAMETER",
  ERR_REFUND_ID_REQUIRED: "ERR_REFUND_ID_REQUIRED",

  // 22023: Data Exception — Invalid parameter value
  ERR_INVALID_CURRENCY: "ERR_INVALID_CURRENCY",
  ERR_CAPTURE_ID_MISMATCH: "ERR_CAPTURE_ID_MISMATCH",
  ERR_ORDER_ID_MISMATCH: "ERR_ORDER_ID_MISMATCH",
  ERR_NONCE_PAYLOAD_MISMATCH: "ERR_NONCE_PAYLOAD_MISMATCH",
  ERR_PAYEE_MISMATCH: "ERR_PAYEE_MISMATCH",
  ERR_INVALID_DECIMAL_FORMAT: "ERR_INVALID_DECIMAL_FORMAT",
  ERR_PROVIDER_TAX_SUM_MISMATCH: "ERR_PROVIDER_TAX_SUM_MISMATCH",
  ERR_UNSUPPORTED_SIGNATURE_ALGORITHM: "ERR_UNSUPPORTED_SIGNATURE_ALGORITHM",
  ERR_INVALID_TIMESTAMP_SKEW: "ERR_INVALID_TIMESTAMP_SKEW",
  ERR_ATTESTATION_TIMESTAMP_SKEW: "ERR_ATTESTATION_TIMESTAMP_SKEW",
  ERR_UNSUPPORTED_ADJUSTMENT: "ERR_UNSUPPORTED_ADJUSTMENT",
  ERR_PAYLOAD_NORMALIZATION_MISMATCH: "ERR_PAYLOAD_NORMALIZATION_MISMATCH",
  ERR_UNEXPECTED_PAYLOAD_FIELD: "ERR_UNEXPECTED_PAYLOAD_FIELD",
  ERR_MISSING_PAYLOAD_FIELD: "ERR_MISSING_PAYLOAD_FIELD",
  ERR_LINE_ITEM_COUNT_MISMATCH: "ERR_LINE_ITEM_COUNT_MISMATCH",
  ERR_JURISDICTION_COUNT_MISMATCH: "ERR_JURISDICTION_COUNT_MISMATCH",
  ERR_CART_PROVIDER_INPUT_MISMATCH: "ERR_CART_PROVIDER_INPUT_MISMATCH",
  ERR_CART_TOTAL_RECONCILIATION_MISMATCH: "ERR_CART_TOTAL_RECONCILIATION_MISMATCH",
  ERR_MALFORMED_NESTED_STRUCTURE: "ERR_MALFORMED_NESTED_STRUCTURE",
  ERR_INVALID_PROPERTY_TYPE: "ERR_INVALID_PROPERTY_TYPE",
  ERR_AMOUNT_MISMATCH: "ERR_AMOUNT_MISMATCH",

  // 22003: Data Exception — Numeric value out of range
  ERR_AMOUNT_OUT_OF_BOUNDS: "ERR_AMOUNT_OUT_OF_BOUNDS",
  ERR_REFUND_EXCEEDS_CAPTURE: "ERR_REFUND_EXCEEDS_CAPTURE",

  // 23505: Integrity Constraint — Unique violation
  ERR_NONCE_REPLAY: "ERR_NONCE_REPLAY",
  ERR_TRANSMISSION_ALREADY_BOUND: "ERR_TRANSMISSION_ALREADY_BOUND",
  ERR_REFUND_ALREADY_RECORDED: "ERR_REFUND_ALREADY_RECORDED",
  ERR_CART_TAX_ALREADY_RECORDED: "ERR_CART_TAX_ALREADY_RECORDED",

  // P0002: PL/pgSQL Error — No data found
  ERR_TRANSMISSION_NOT_FOUND: "ERR_TRANSMISSION_NOT_FOUND",
  ERR_CAPTURE_NOT_FOUND: "ERR_CAPTURE_NOT_FOUND",
  ERR_KEY_NOT_FOUND: "ERR_KEY_NOT_FOUND",
  ERR_CART_NOT_FOUND: "ERR_CART_NOT_FOUND",
  ERR_CERTIFICATE_NOT_FOUND: "ERR_CERTIFICATE_NOT_FOUND",
  ERR_ATTESTATION_KEY_NOT_FOUND: "ERR_ATTESTATION_KEY_NOT_FOUND",

  // 55000: Object Not in Prereq State — Invalid state transition
  ERR_INVALID_TRANSITION: "ERR_INVALID_TRANSITION",
  ERR_SIGNING_KEY_REVOKED: "ERR_SIGNING_KEY_REVOKED",
  ERR_CERT_REVOKED: "ERR_CERT_REVOKED",
  ERR_RESOURCE_ALREADY_REVOKED: "ERR_RESOURCE_ALREADY_REVOKED",
  ERR_TRANSMISSION_NOT_PROCESSED: "ERR_TRANSMISSION_NOT_PROCESSED",
  ERR_TAX_QUOTE_EXPIRED: "ERR_TAX_QUOTE_EXPIRED",
  ERR_CERT_EXPIRED: "ERR_CERT_EXPIRED",
  ERR_ATTESTATION_KEY_REVOKED: "ERR_ATTESTATION_KEY_REVOKED",
  ERR_ATTESTATION_KEY_EXPIRED: "ERR_ATTESTATION_KEY_EXPIRED",

  // 42501: Security Exception — Insufficient privilege
  ERR_INSUFFICIENT_ROLE_PRIVILEGE: "ERR_INSUFFICIENT_ROLE_PRIVILEGE",
  ERR_VERIFIER_IDENTITY_MISMATCH: "ERR_VERIFIER_IDENTITY_MISMATCH",
  ERR_ATTESTATION_PRINCIPAL_MISMATCH: "ERR_ATTESTATION_PRINCIPAL_MISMATCH",
  ERR_INVALID_VERIFIER_ATTESTATION: "ERR_INVALID_VERIFIER_ATTESTATION",

  // 40P01: Transaction Rollback — Deadlock detected
  ERR_TRANSACTION_DEADLOCK_DETECTED: "ERR_TRANSACTION_DEADLOCK_DETECTED",

  // 40001: Transaction Rollback — Serialization failure
  ERR_TRANSACTION_SERIALIZATION_FAILURE: "ERR_TRANSACTION_SERIALIZATION_FAILURE",
} as const;

export type Stage2ErrorCode = (typeof STAGE2_ERROR_CODES)[keyof typeof STAGE2_ERROR_CODES];

/**
 * Direct bidirectional mapping between error codes and SQLSTATE codes.
 */
export const ERROR_CODE_TO_SQLSTATE: Record<Stage2ErrorCode, Stage2SqlState> = {
  // 22004
  ERR_NULL_PARAMETER: "22004",
  ERR_REFUND_ID_REQUIRED: "22004",

  // 22023
  ERR_INVALID_CURRENCY: "22023",
  ERR_CAPTURE_ID_MISMATCH: "22023",
  ERR_ORDER_ID_MISMATCH: "22023",
  ERR_NONCE_PAYLOAD_MISMATCH: "22023",
  ERR_PAYEE_MISMATCH: "22023",
  ERR_INVALID_DECIMAL_FORMAT: "22023",
  ERR_PROVIDER_TAX_SUM_MISMATCH: "22023",
  ERR_UNSUPPORTED_SIGNATURE_ALGORITHM: "22023",
  ERR_INVALID_TIMESTAMP_SKEW: "22023",
  ERR_ATTESTATION_TIMESTAMP_SKEW: "22023",
  ERR_UNSUPPORTED_ADJUSTMENT: "22023",
  ERR_PAYLOAD_NORMALIZATION_MISMATCH: "22023",
  ERR_UNEXPECTED_PAYLOAD_FIELD: "22023",
  ERR_MISSING_PAYLOAD_FIELD: "22023",
  ERR_LINE_ITEM_COUNT_MISMATCH: "22023",
  ERR_JURISDICTION_COUNT_MISMATCH: "22023",
  ERR_CART_PROVIDER_INPUT_MISMATCH: "22023",
  ERR_CART_TOTAL_RECONCILIATION_MISMATCH: "22023",
  ERR_MALFORMED_NESTED_STRUCTURE: "22023",
  ERR_INVALID_PROPERTY_TYPE: "22023",
  ERR_AMOUNT_MISMATCH: "22023",

  // 22003
  ERR_AMOUNT_OUT_OF_BOUNDS: "22003",
  ERR_REFUND_EXCEEDS_CAPTURE: "22003",

  // 23505
  ERR_NONCE_REPLAY: "23505",
  ERR_TRANSMISSION_ALREADY_BOUND: "23505",
  ERR_REFUND_ALREADY_RECORDED: "23505",
  ERR_CART_TAX_ALREADY_RECORDED: "23505",

  // P0002
  ERR_TRANSMISSION_NOT_FOUND: "P0002",
  ERR_CAPTURE_NOT_FOUND: "P0002",
  ERR_KEY_NOT_FOUND: "P0002",
  ERR_CART_NOT_FOUND: "P0002",
  ERR_CERTIFICATE_NOT_FOUND: "P0002",
  ERR_ATTESTATION_KEY_NOT_FOUND: "P0002",

  // 55000
  ERR_INVALID_TRANSITION: "55000",
  ERR_SIGNING_KEY_REVOKED: "55000",
  ERR_CERT_REVOKED: "55000",
  ERR_RESOURCE_ALREADY_REVOKED: "55000",
  ERR_TRANSMISSION_NOT_PROCESSED: "55000",
  ERR_TAX_QUOTE_EXPIRED: "55000",
  ERR_CERT_EXPIRED: "55000",
  ERR_ATTESTATION_KEY_REVOKED: "55000",
  ERR_ATTESTATION_KEY_EXPIRED: "55000",

  // 42501
  ERR_INSUFFICIENT_ROLE_PRIVILEGE: "42501",
  ERR_VERIFIER_IDENTITY_MISMATCH: "42501",
  ERR_ATTESTATION_PRINCIPAL_MISMATCH: "42501",
  ERR_INVALID_VERIFIER_ATTESTATION: "42501",

  // 40P01
  ERR_TRANSACTION_DEADLOCK_DETECTED: "40P01",

  // 40001
  ERR_TRANSACTION_SERIALIZATION_FAILURE: "40001",
};

/**
 * Base domain exception representing Stage 2 relational routine and contract errors.
 */
export class Stage2DomainError extends Error {
  readonly code: Stage2ErrorCode;
  readonly sqlState: Stage2SqlState;
  readonly details?: Record<string, unknown>;

  constructor(code: Stage2ErrorCode, message: string, details?: Record<string, unknown>) {
    const sqlState = ERROR_CODE_TO_SQLSTATE[code] ?? "22023";
    super(`[${sqlState}:${code}] ${message}`);
    this.name = "Stage2DomainError";
    this.code = code;
    this.sqlState = sqlState;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Specialized domain error classes for critical verification invariants.
 */
export class InvalidDecimalFormatError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_INVALID_DECIMAL_FORMAT, message, details);
    this.name = "InvalidDecimalFormatError";
  }
}

export class AmountOutOfBoundsError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_AMOUNT_OUT_OF_BOUNDS, message, details);
    this.name = "AmountOutOfBoundsError";
  }
}

export class MissingPayloadFieldError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_MISSING_PAYLOAD_FIELD, message, details);
    this.name = "MissingPayloadFieldError";
  }
}

export class UnexpectedPayloadFieldError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_UNEXPECTED_PAYLOAD_FIELD, message, details);
    this.name = "UnexpectedPayloadFieldError";
  }
}

export class MalformedNestedStructureError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_MALFORMED_NESTED_STRUCTURE, message, details);
    this.name = "MalformedNestedStructureError";
  }
}

export class InvalidPropertyTypeError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_INVALID_PROPERTY_TYPE, message, details);
    this.name = "InvalidPropertyTypeError";
  }
}

export class NullParameterError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_NULL_PARAMETER, message, details);
    this.name = "NullParameterError";
  }
}

export class ProviderTaxSumMismatchError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_PROVIDER_TAX_SUM_MISMATCH, message, details);
    this.name = "ProviderTaxSumMismatchError";
  }
}

export class UnsupportedAdjustmentError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_UNSUPPORTED_ADJUSTMENT, message, details);
    this.name = "UnsupportedAdjustmentError";
  }
}

export class NonceReplayError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_NONCE_REPLAY, message, details);
    this.name = "NonceReplayError";
  }
}

export class InvalidTransitionError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_INVALID_TRANSITION, message, details);
    this.name = "InvalidTransitionError";
  }
}

export class InsufficientRolePrivilegeError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_INSUFFICIENT_ROLE_PRIVILEGE, message, details);
    this.name = "InsufficientRolePrivilegeError";
  }
}

export class VerifierIdentityMismatchError extends Stage2DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(STAGE2_ERROR_CODES.ERR_VERIFIER_IDENTITY_MISMATCH, message, details);
    this.name = "VerifierIdentityMismatchError";
  }
}

