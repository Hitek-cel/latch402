export { Latch } from "./gate.ts";
export type { GateConfig, GateDeps, PaymentRequired, RedeemResult } from "./gate.ts";

export { LatchError, httpStatusFor, isLatchError } from "./errors.ts";
export type { FailureCode } from "./errors.ts";

export {
  STATES,
  TERMINAL_STATES,
  IN_FLIGHT_STATES,
  canTransition,
  assertTransition,
  isTerminal,
  isInFlight,
  isCharged,
} from "./states.ts";
export type { State, TerminalState } from "./states.ts";

export {
  MICROS_PER_UNIT,
  addMicros,
  subMicros,
  assertMicros,
  isMicros,
  parseMicros,
  toWire,
  formatUsd,
} from "./money.ts";

export { canonicalJson, deriveIdempotencyKey, hashRequest, newId } from "./ids.ts";

export {
  GENESIS,
  auditChain,
  hashReceipt,
  hmacSigner,
  issueReceipt,
  verifyReceipt,
} from "./receipt.ts";
export type { Receipt, SignedReceipt, Signer } from "./receipt.ts";

export { systemClock } from "./ports.ts";
export type {
  Clock,
  Facilitator,
  Journal,
  JournalEntry,
  InvoiceSnapshot,
  ProduceContext,
  Producer,
  Quote,
  SettleOutcome,
  VerifyOutcome,
} from "./ports.ts";

export { memoryJournal } from "./adapters/memory-journal.ts";
export { ledgerFacilitator, makeProof, parseProof } from "./adapters/ledger-facilitator.ts";
export type { LedgerFacilitator, LedgerFaults } from "./adapters/ledger-facilitator.ts";
