/**
 * A typed failure taxonomy, because "throw new Error(string)" is how the
 * previous implementation ended up matching on err.message.includes("Insufficient")
 * to pick an HTTP status code.
 */

export type FailureCode =
  | "bad_request"
  | "unknown_invoice"
  | "invoice_expired"
  | "invoice_not_payable"
  | "payer_mismatch"
  | "amount_mismatch"
  | "proof_invalid"
  | "proof_replayed"
  | "settlement_failed"
  | "producer_failed"
  | "producer_timeout"
  | "budget_exceeded"
  | "concurrent_attempt"
  | "needs_operator";

export class LatchError extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: FailureCode,
    message: string,
    options: { retryable?: boolean; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "LatchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? {};
  }
}

/** HTTP status for each failure. Kept here so no route has to guess. */
export function httpStatusFor(code: FailureCode): number {
  switch (code) {
    case "bad_request":
    case "amount_mismatch":
      return 400;
    case "unknown_invoice":
      return 404;
    case "invoice_expired":
    case "invoice_not_payable":
    case "proof_invalid":
    case "proof_replayed":
    case "settlement_failed":
      // Still 402: the caller has not paid, and may try again properly.
      return 402;
    case "payer_mismatch":
      return 403;
    case "concurrent_attempt":
      return 409;
    case "budget_exceeded":
      return 413;
    case "producer_timeout":
      return 504;
    case "producer_failed":
    case "needs_operator":
      return 500;
  }
}

export function isLatchError(value: unknown): value is LatchError {
  return value instanceof LatchError;
}

/**
 * Raised only when an append loses the optimistic-concurrency race.
 *
 * Distinct from every other journal failure on purpose: a lost race is a
 * retryable 409, while a journal that is simply down must NOT be reported as
 * one. Collapsing the two would turn "our database is unreachable" into
 * "please try again", which is how an outage becomes a silent data loss.
 */
export class JournalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalConflictError";
  }
}
