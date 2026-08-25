import type { State } from "./states.ts";
import type { SignedReceipt } from "./receipt.ts";

/**
 * Ports. Everything the gate touches is an interface, so the gate itself stays
 * pure and testable — including testable under crash injection, which is the
 * only way to know a recovery path works.
 */

export type Quote = {
  invoiceId: string;
  sku: string;
  amountMicros: number;
  payTo: string;
  network: string;
  asset: string;
  payer: string;
  /** Hash of the request this quote is bound to. A quote buys ONE request. */
  requestHash: string;
  nonce: string;
  expiresAt: number;
};

export type JournalEntry = {
  invoiceId: string;
  seq: number;
  state: State;
  at: number;
  /** Free-form evidence for this transition: facilitator ids, tx hashes, errors. */
  evidence: Record<string, unknown>;
};

export type InvoiceSnapshot = {
  quote: Quote;
  state: State;
  seq: number;
  entries: JournalEntry[];
};

/**
 * Durable, append-only, ordered per invoice.
 *
 * `append` MUST be write-ahead: it returns only once the entry survives a crash.
 * `expectedSeq` gives optimistic concurrency — two workers racing the same
 * invoice cannot both advance it.
 */
export type Journal = {
  open(quote: Quote): Promise<void>;
  get(invoiceId: string): Promise<InvoiceSnapshot | undefined>;
  append(entry: Omit<JournalEntry, "seq">, expectedSeq: number): Promise<JournalEntry>;
  /** Invoices left in-flight, oldest first. Drives the recovery sweep. */
  findInFlight(olderThan: number, limit: number): Promise<string[]>;
  /** Consume a nonce exactly once. Returns false if it was already used. */
  consumeNonce(nonce: string, invoiceId: string): Promise<boolean>;
  /** Cache the delivered result so an idempotent retry returns it without recharging. */
  putResult(idempotencyKey: string, payload: unknown): Promise<void>;
  getResult(idempotencyKey: string): Promise<{ payload: unknown } | undefined>;
  /**
   * Append to the receipt chain. The journal supplies the current chain head
   * inside its own critical section and the caller signs over it, so two
   * invoices finishing at once cannot fork the chain.
   */
  appendReceipt(build: (prev: string) => SignedReceipt): Promise<SignedReceipt>;
  readChain(): Promise<SignedReceipt[]>;
};

export type VerifyOutcome =
  | { ok: true; payer: string; amountMicros: number; nonce: string }
  | { ok: false; reason: string };

export type SettleOutcome =
  | { ok: true; reference: string; amountMicros: number }
  | { ok: false; reason: string; moved: false };

/**
 * The payment network.
 *
 * `settle` and `refund` MUST be idempotent on idempotencyKey.
 * `statusOf` is the crash-recovery oracle: after an unclean shutdown mid-settle,
 * this is the only honest way to learn whether the money actually moved. The
 * reference SDKs that lack it are the ones that lose money.
 */
export type Facilitator = {
  verify(proof: string, expected: Quote): Promise<VerifyOutcome>;
  settle(intent: {
    idempotencyKey: string;
    quote: Quote;
    proof: string;
  }): Promise<SettleOutcome>;
  statusOf(idempotencyKey: string): Promise<
    | { state: "unknown" }
    | { state: "pending" }
    | { state: "settled"; reference: string; amountMicros: number }
  >;
  refund(intent: {
    idempotencyKey: string;
    quote: Quote;
    reference: string;
  }): Promise<{ ok: true; reference: string } | { ok: false; reason: string }>;
};

export type ProduceContext = {
  invoiceId: string;
  idempotencyKey: string;
  /** Hard wall-clock deadline. The gate aborts at this point regardless. */
  deadline: number;
  signal: AbortSignal;
  /** What the caller paid, in micros. Producers should refuse to spend more. */
  budgetMicros: number;
};

/**
 * The thing being sold. Runs only after money is durably settled.
 * Throwing here is safe: it triggers the refund path, not a silent loss.
 */
export type Producer<TReq, TRes> = {
  produce(request: TReq, ctx: ProduceContext): Promise<TRes>;
};

export type Clock = { now(): number };

export const systemClock: Clock = { now: () => Date.now() };
