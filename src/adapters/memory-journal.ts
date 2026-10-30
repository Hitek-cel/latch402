import type { InvoiceSnapshot, Journal, JournalEntry, Quote } from "../ports.ts";
import { isInFlight } from "../states.ts";
import { JournalConflictError } from "../errors.ts";
import { hashReceipt, type SignedReceipt } from "../receipt.ts";

/**
 * Reference journal, in memory.
 *
 * Not for production — but it is the exact contract a real one must meet, and
 * it is what the crash tests run against. Note what it does NOT do: no entry is
 * ever mutated or removed. The journal is append-only, because the moment you
 * can overwrite history you can no longer prove what happened.
 *
 * A SQL implementation is a direct translation:
 *   append()       -> INSERT ... WHERE seq = expectedSeq + 1, unique(invoice_id, seq)
 *   consumeNonce() -> INSERT INTO nonces(nonce) ON CONFLICT DO NOTHING, check rowcount
 *   appendReceipt()-> SELECT head FOR UPDATE, insert, update head, in one transaction
 */
export function memoryJournal(): Journal & { snapshotAll(): InvoiceSnapshot[] } {
  const invoices = new Map<string, { quote: Quote; entries: JournalEntry[] }>();
  const nonces = new Map<string, string>();
  const results = new Map<string, unknown>();
  const chain: SignedReceipt[] = [];
  let head = "";
  const credit = new Map<string, { payer: string; amountMicros: number }>();

  function snapshotOf(rec: { quote: Quote; entries: JournalEntry[] }): InvoiceSnapshot {
    const last = rec.entries[rec.entries.length - 1];
    if (!last) throw new Error("Corrupt journal: invoice with no entries");
    return { quote: rec.quote, state: last.state, seq: last.seq, entries: [...rec.entries] };
  }

  return {
    async open(quote) {
      if (invoices.has(quote.invoiceId)) throw new Error("Invoice already open");
      invoices.set(quote.invoiceId, {
        quote,
        entries: [
          {
            invoiceId: quote.invoiceId,
            seq: 0,
            state: "quoted",
            at: quote.expiresAt,
            evidence: { amountMicros: quote.amountMicros, sku: quote.sku },
          },
        ],
      });
    },

    async get(invoiceId) {
      const rec = invoices.get(invoiceId);
      return rec ? snapshotOf(rec) : undefined;
    },

    async append(entry, expectedSeq) {
      const rec = invoices.get(entry.invoiceId);
      if (!rec) throw new Error("Unknown invoice");
      const last = rec.entries[rec.entries.length - 1];
      if (!last) throw new Error("Corrupt journal");
      // Optimistic concurrency. Two workers reading the same seq means exactly
      // one of them gets to write; the loser throws and the gate turns that
      // into a 409 rather than a duplicate charge.
      if (last.seq !== expectedSeq) {
        throw new JournalConflictError(
          `Journal conflict: expected seq ${expectedSeq}, found ${last.seq}`,
        );
      }
      const written: JournalEntry = { ...entry, seq: last.seq + 1 };
      rec.entries.push(written);
      return written;
    },

    async findInFlight(olderThan, limit) {
      const out: { id: string; at: number }[] = [];
      for (const [id, rec] of invoices) {
        const last = rec.entries[rec.entries.length - 1];
        if (!last) continue;
        if (!isInFlight(last.state)) continue;
        if (last.at > olderThan) continue;
        out.push({ id, at: last.at });
      }
      out.sort((a, b) => a.at - b.at);
      return out.slice(0, limit).map((r) => r.id);
    },

    async consumeNonce(nonce, invoiceId) {
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, invoiceId);
      return true;
    },

    async putResult(idempotencyKey, payload) {
      // First write wins, exactly like the Postgres adapter's ON CONFLICT DO
      // NOTHING. A recovered attempt must never overwrite a good that an
      // earlier attempt already stored.
      if (!results.has(idempotencyKey)) results.set(idempotencyKey, payload);
    },

    async getResult(idempotencyKey) {
      if (!results.has(idempotencyKey)) return undefined;
      return { payload: results.get(idempotencyKey) };
    },

    async appendReceipt(build) {
      // Critical section: prev is read and the chain extended atomically, so
      // concurrent invoices cannot fork it.
      const signed = build(head);
      chain.push(signed);
      head = hashReceipt(signed.receipt);
      return signed;
    },

    async readChain() {
      return [...chain];
    },

    async reserveCredit({ invoiceId, payer, amountMicros, totalLimitMicros, perPayerLimitMicros }) {
      // No await between the check and the write, so the whole reservation is
      // one uninterruptible step — the atomicity the port demands.
      if (credit.has(invoiceId)) return true;
      let total = 0;
      let mine = 0;
      for (const c of credit.values()) {
        total += c.amountMicros;
        if (c.payer === payer) mine += c.amountMicros;
      }
      if (total + amountMicros > totalLimitMicros) return false;
      if (perPayerLimitMicros !== undefined && mine + amountMicros > perPayerLimitMicros) {
        return false;
      }
      credit.set(invoiceId, { payer, amountMicros });
      return true;
    },

    async releaseCredit(invoiceId) {
      credit.delete(invoiceId);
    },

    async listCredit() {
      return [...credit].map(([invoiceId, c]) => ({ invoiceId, ...c }));
    },

    snapshotAll() {
      return [...invoices.values()].map(snapshotOf);
    },
  };
}
