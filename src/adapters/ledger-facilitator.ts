import type { Facilitator, Quote, SettleOutcome, VerifyOutcome } from "../ports.ts";
import { addMicros, subMicros } from "../money.ts";

/**
 * A double-entry facilitator for local development and tests.
 *
 * Double-entry on purpose: every movement debits one account and credits
 * another, so the sum across all accounts is invariant. That lets the test
 * suite assert the thing that actually matters — no money was created and none
 * was destroyed — instead of merely asserting that a function returned "ok".
 *
 * `faults` is the fault-injection surface. The interesting one is
 * `settleReportsFailureButMoves`: the verification-pass / settlement-divergence
 * case that the published x402 attack research describes. A gate that trusts
 * the return value alone will get this wrong.
 */

export type LedgerFaults = {
  verifyThrows?: boolean;
  settleThrows?: boolean;
  settleFails?: boolean;
  /** Money moves, but the call reports failure (or the response is lost). */
  settleReportsFailureButMoves?: boolean;
  /** Settlement is accepted but not yet final. */
  settlePending?: boolean;
  refundFails?: boolean;
};

export type LedgerFacilitator = Facilitator & {
  credit(account: string, micros: number): void;
  balanceOf(account: string): number;
  totalSupply(): number;
  faults: LedgerFaults;
  settlementCount(): number;
  /** Complete any settlement left pending, as the real network eventually would. */
  finalizePending(): number;
};

type Proof = { invoiceId: string; payer: string; amountMicros: number; nonce: string };

export function parseProof(raw: string): Proof | undefined {
  try {
    const p = JSON.parse(raw) as Partial<Proof>;
    if (
      typeof p.invoiceId !== "string" ||
      typeof p.payer !== "string" ||
      typeof p.nonce !== "string" ||
      typeof p.amountMicros !== "number" ||
      !Number.isInteger(p.amountMicros)
    ) {
      return undefined;
    }
    return p as Proof;
  } catch {
    return undefined;
  }
}

export function makeProof(quote: Quote, overrides: Partial<Proof> = {}): string {
  return JSON.stringify({
    invoiceId: quote.invoiceId,
    payer: quote.payer,
    amountMicros: quote.amountMicros,
    nonce: quote.nonce,
    ...overrides,
  });
}

export function ledgerFacilitator(initial: Record<string, number> = {}): LedgerFacilitator {
  const balances = new Map<string, number>(Object.entries(initial));
  type Settlement = {
    reference: string;
    invoiceId: string;
    amountMicros: number;
    final: boolean;
    payer: string;
    payTo: string;
    /** Set once refunded, so a settlement can never be reversed twice. */
    refundedBy?: string;
  };
  const settlements = new Map<string, Settlement>();
  const refunds = new Map<string, string>();
  const faults: LedgerFaults = {};
  let counter = 0;

  const get = (a: string) => balances.get(a) ?? 0;

  /** Why a proof does not authorise a quote, or null if it does. */
  const mismatch = (proof: ReturnType<typeof parseProof>, q: Quote): string | null => {
    if (!proof) return "malformed_proof";
    if (proof.invoiceId !== q.invoiceId) return "invoice_mismatch";
    if (proof.payer !== q.payer) return "payer_mismatch";
    if (proof.nonce !== q.nonce) return "nonce_mismatch";
    return null;
  };
  const move = (from: string, to: string, micros: number) => {
    balances.set(from, subMicros(get(from), micros));
    balances.set(to, addMicros(get(to), micros));
  };

  return {
    faults,

    credit(account, micros) {
      balances.set(account, addMicros(get(account), micros));
    },
    balanceOf: get,
    totalSupply() {
      let sum = 0;
      for (const v of balances.values()) sum += v;
      return sum;
    },
    settlementCount() {
      return settlements.size;
    },
    finalizePending() {
      let n = 0;
      for (const s of settlements.values()) {
        if (s.final) continue;
        move(s.payer, s.payTo, s.amountMicros);
        s.final = true;
        n++;
      }
      return n;
    },

    async verify(proof, expected): Promise<VerifyOutcome> {
      if (faults.verifyThrows) throw new Error("facilitator unreachable");
      const p = parseProof(proof);
      const bad = mismatch(p, expected);
      if (bad || !p) return { ok: false, reason: bad ?? "malformed_proof" };
      // Amount is reported, not enforced, here: the gate compares it to the
      // quote and reports underpayment itself. settle() enforces it.
      return { ok: true, payer: p.payer, amountMicros: p.amountMicros, nonce: p.nonce };
    },

    async settle({ idempotencyKey, quote, proof }): Promise<SettleOutcome> {
      // A real network can only move funds the signed authorisation covers, so
      // the reference ledger must refuse anything else — including when a gate
      // bug skips verify. Exact amount: an authorisation for less never pays
      // for more.
      const p = parseProof(proof);
      const bad = mismatch(p, quote);
      if (bad || !p) return { ok: false, reason: bad ?? "malformed_proof", moved: false };
      if (p.amountMicros !== quote.amountMicros) {
        return { ok: false, reason: "amount_not_authorised", moved: false };
      }

      const existing = settlements.get(idempotencyKey);
      if (existing) {
        // Idempotent: replaying the same key never moves money twice.
        return { ok: true, reference: existing.reference, amountMicros: existing.amountMicros };
      }
      if (faults.settleThrows) throw new Error("settlement network error");
      if (faults.settleFails) return { ok: false, reason: "declined", moved: false };
      if (get(quote.payer) < quote.amountMicros) {
        return { ok: false, reason: "insufficient_funds", moved: false };
      }

      const reference = `stl_${++counter}`;
      if (faults.settlePending) {
        settlements.set(idempotencyKey, {
          reference,
          invoiceId: quote.invoiceId,
          amountMicros: quote.amountMicros,
          final: false,
          payer: quote.payer,
          payTo: quote.payTo,
        });
        throw new Error("settlement timed out awaiting finality");
      }

      move(quote.payer, quote.payTo, quote.amountMicros);
      settlements.set(idempotencyKey, {
        reference,
        invoiceId: quote.invoiceId,
        amountMicros: quote.amountMicros,
        final: true,
        payer: quote.payer,
        payTo: quote.payTo,
      });

      if (faults.settleReportsFailureButMoves) {
        // The divergence case: the money really moved, the caller is told it did not.
        return { ok: false, reason: "timeout_after_broadcast", moved: false };
      }
      return { ok: true, reference, amountMicros: quote.amountMicros };
    },

    async statusOf(idempotencyKey) {
      const s = settlements.get(idempotencyKey);
      if (!s) return { state: "unknown" };
      if (!s.final) return { state: "pending" };
      return { state: "settled", reference: s.reference, amountMicros: s.amountMicros };
    },

    async refund({ idempotencyKey, quote, reference: settlementRef }) {
      const already = refunds.get(idempotencyKey);
      if (already) return { ok: true, reference: already };

      // A refund reverses one specific settlement. Without this lookup the
      // ledger paid out against any reference string at all.
      let target: Settlement | undefined;
      for (const s of settlements.values()) {
        if (s.reference === settlementRef) {
          target = s;
          break;
        }
      }
      if (!target || !target.final) return { ok: false, reason: "unknown_settlement" };
      if (target.invoiceId !== quote.invoiceId) {
        return { ok: false, reason: "settlement_not_for_this_quote" };
      }

      // Bound to the settlement, not the refund key: a second key against an
      // already-reversed settlement gets the original refund back and moves
      // nothing. Keying only on the refund key allowed a double refund.
      if (target.refundedBy) {
        refunds.set(idempotencyKey, target.refundedBy);
        return { ok: true, reference: target.refundedBy };
      }

      if (faults.refundFails) return { ok: false, reason: "refund_rail_down" };
      // Reverse what the settlement actually moved, between its own parties.
      if (get(target.payTo) < target.amountMicros) {
        return { ok: false, reason: "operator_balance_too_low" };
      }
      move(target.payTo, target.payer, target.amountMicros);
      const reference = `rfd_${++counter}`;
      target.refundedBy = reference;
      refunds.set(idempotencyKey, reference);
      return { ok: true, reference };
    },
  };
}
