import { JournalConflictError } from "../errors.ts";
import { isInFlight, IN_FLIGHT_STATES, type State } from "../states.ts";
import { hashReceipt, type SignedReceipt } from "../receipt.ts";
import type { InvoiceSnapshot, Journal, JournalEntry, Quote } from "../ports.ts";

/**
 * A durable journal on Postgres.
 *
 * The library stays dependency-free: rather than importing a driver, this takes
 * the small `SqlClient` shape below. `pg`, `postgres.js` and PGlite all wrap to
 * it in a few lines, and it keeps the adapter testable against a real database.
 *
 * Three properties carry the whole design, and each is enforced by the schema
 * rather than by application code:
 *
 *   1. Append-only. Nothing here ever UPDATEs or DELETEs a journal entry. The
 *      moment history can be rewritten it stops being evidence.
 *   2. Compare-and-set on `seq`. Two workers racing one invoice must not both
 *      advance it; the primary key plus the guarded INSERT make that impossible.
 *   3. Exactly-once nonces. A payment proof burns its nonce in a single
 *      statement, so a replay cannot slip between a check and a write.
 */

export type SqlExecutor = {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
};

export type SqlClient = SqlExecutor & {
  /** Must run `fn` inside a real transaction and roll back if it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
};

/** Run once at deploy. Safe to re-run. */
export const SCHEMA = `
create table if not exists latch_invoice (
  invoice_id  text primary key,
  quote       jsonb  not null,
  created_at  bigint not null
);

create table if not exists latch_entry (
  invoice_id  text   not null references latch_invoice(invoice_id),
  seq         int    not null,
  state       text   not null,
  at          bigint not null,
  evidence    jsonb  not null,
  primary key (invoice_id, seq)
);

-- Drives the recovery sweep: find the newest entry per invoice, oldest first.
create index if not exists latch_entry_at_idx on latch_entry (at);

create table if not exists latch_nonce (
  nonce       text primary key,
  invoice_id  text   not null,
  consumed_at bigint not null
);

create table if not exists latch_result (
  key         text primary key,
  payload     jsonb  not null,
  created_at  bigint not null
);

create table if not exists latch_receipt (
  ord         bigserial primary key,
  invoice_id  text  not null,
  hash        text  not null,
  prev        text  not null,
  receipt     jsonb not null,
  signature   text  not null
);

create index if not exists latch_receipt_invoice_idx on latch_receipt (invoice_id);

-- Single row holding the tip of the receipt chain, locked while extending it.
create table if not exists latch_chain_head (
  id   int  primary key,
  head text not null
);

insert into latch_chain_head (id, head) values (1, '')
  on conflict (id) do nothing;
`;

export async function migrate(sql: SqlExecutor): Promise<void> {
  for (const stmt of SCHEMA.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) await sql.query(trimmed);
  }
}

type EntryRow = { seq: number; state: string; at: string | number; evidence: Record<string, unknown> };

const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));

export function postgresJournal(sql: SqlClient): Journal {
  return {
    async open(quote: Quote) {
      await sql.transaction(async (tx) => {
        await tx.query(
          `insert into latch_invoice (invoice_id, quote, created_at) values ($1, $2, $3)`,
          [quote.invoiceId, JSON.stringify(quote), Date.now()],
        );
        // Seq 0 is the opened quote, so an invoice always has a current state.
        await tx.query(
          `insert into latch_entry (invoice_id, seq, state, at, evidence)
           values ($1, 0, 'quoted', $2, $3)`,
          [
            quote.invoiceId,
            quote.expiresAt,
            JSON.stringify({ amountMicros: quote.amountMicros, sku: quote.sku }),
          ],
        );
      });
    },

    async get(invoiceId: string): Promise<InvoiceSnapshot | undefined> {
      const inv = await sql.query<{ quote: Quote | string }>(
        `select quote from latch_invoice where invoice_id = $1`,
        [invoiceId],
      );
      const row = inv.rows[0];
      if (!row) return undefined;

      const entries = await sql.query<EntryRow>(
        `select seq, state, at, evidence from latch_entry
         where invoice_id = $1 order by seq asc`,
        [invoiceId],
      );
      const parsed: JournalEntry[] = entries.rows.map((e) => ({
        invoiceId,
        seq: e.seq,
        state: e.state as State,
        at: num(e.at),
        evidence: typeof e.evidence === "string" ? JSON.parse(e.evidence) : e.evidence,
      }));
      const last = parsed[parsed.length - 1];
      if (!last) throw new Error(`Corrupt journal: ${invoiceId} has no entries`);

      return {
        quote: typeof row.quote === "string" ? (JSON.parse(row.quote) as Quote) : row.quote,
        state: last.state,
        seq: last.seq,
        entries: parsed,
      };
    },

    async append(entry, expectedSeq) {
      // The WHERE clause is the compare-and-set: the row only lands if the
      // current tip is still exactly where the caller thought it was. One
      // statement, so nothing can interleave between the check and the write.
      const next = expectedSeq + 1;
      let res;
      try {
        res = await sql.query(
          `insert into latch_entry (invoice_id, seq, state, at, evidence)
           select $1, $2, $3, $4, $5
           where (select coalesce(max(seq), -1) from latch_entry where invoice_id = $1) = $6`,
          [entry.invoiceId, next, entry.state, entry.at, JSON.stringify(entry.evidence), expectedSeq],
        );
      } catch (err) {
        // Two writers cleared the guard simultaneously; the primary key caught
        // the loser. Same meaning as a zero-row insert.
        if ((err as { code?: string }).code === "23505") {
          throw new JournalConflictError(
            `Journal conflict on ${entry.invoiceId}: seq ${next} already written`,
          );
        }
        throw err;
      }
      if (res.rowCount === 0) {
        // Zero rows means the guard failed, but for two very different reasons.
        // A lost race is retryable; an invoice that does not exist never will
        // be, and reporting it as a conflict tells the caller to retry forever.
        // rows.length, not rowCount: for a SELECT, drivers vary on what
        // rowCount means (several report 0 affected rows), and a wrong answer
        // here would misreport a live invoice as missing.
        const exists = await sql.query(
          `select 1 from latch_invoice where invoice_id = $1`,
          [entry.invoiceId],
        );
        if (exists.rows.length === 0) {
          throw new Error(`Unknown invoice: ${entry.invoiceId}`);
        }
        throw new JournalConflictError(
          `Journal conflict on ${entry.invoiceId}: expected seq ${expectedSeq}`,
        );
      }
      return { ...entry, seq: next };
    },

    async findInFlight(olderThan, limit) {
      const res = await sql.query<{ invoice_id: string }>(
        `select e.invoice_id
           from latch_entry e
           join (select invoice_id, max(seq) as seq from latch_entry group by invoice_id) m
             on m.invoice_id = e.invoice_id and m.seq = e.seq
          where e.state = any($1) and e.at <= $2
          order by e.at asc
          limit $3`,
        [[...IN_FLIGHT_STATES], olderThan, limit],
      );
      return res.rows.map((r) => r.invoice_id);
    },

    async consumeNonce(nonce, invoiceId) {
      // Exactly-once in one statement. A second caller inserts zero rows.
      const res = await sql.query(
        `insert into latch_nonce (nonce, invoice_id, consumed_at) values ($1, $2, $3)
         on conflict (nonce) do nothing`,
        [nonce, invoiceId, Date.now()],
      );
      return res.rowCount === 1;
    },

    async putResult(key, payload) {
      // First write wins. A recovered production must never overwrite the good
      // that was already handed to the caller.
      await sql.query(
        `insert into latch_result (key, payload, created_at) values ($1, $2, $3)
         on conflict (key) do nothing`,
        [key, JSON.stringify(payload), Date.now()],
      );
    },

    async getResult(key) {
      const res = await sql.query<{ payload: unknown }>(
        `select payload from latch_result where key = $1`,
        [key],
      );
      const row = res.rows[0];
      if (!row) return undefined;
      return {
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      };
    },

    async appendReceipt(build) {
      // The chain must not fork, so the head row is locked for the whole
      // read-build-write cycle. Concurrent invoices queue here rather than
      // both extending from the same predecessor.
      return sql.transaction(async (tx) => {
        const head = await tx.query<{ head: string }>(
          `select head from latch_chain_head where id = 1 for update`,
        );
        const prev = head.rows[0]?.head ?? "";
        const signed = build(prev);
        const hash = hashReceipt(signed.receipt);

        await tx.query(
          `insert into latch_receipt (invoice_id, hash, prev, receipt, signature)
           values ($1, $2, $3, $4, $5)`,
          [
            signed.receipt.invoiceId,
            hash,
            signed.receipt.prev,
            JSON.stringify(signed.receipt),
            signed.signature,
          ],
        );
        await tx.query(`update latch_chain_head set head = $1 where id = 1`, [hash]);
        return signed;
      });
    },

    async readChain() {
      const res = await sql.query<{ receipt: unknown; signature: string }>(
        `select receipt, signature from latch_receipt order by ord asc`,
      );
      return res.rows.map((r) => ({
        receipt: typeof r.receipt === "string" ? JSON.parse(r.receipt) : r.receipt,
        signature: r.signature,
      })) as SignedReceipt[];
    },
  };
}

/** Exposed for operators: invoices that ended `stuck` and need a human. */
export async function listStuck(sql: SqlExecutor, limit = 100): Promise<string[]> {
  const res = await sql.query<{ invoice_id: string }>(
    `select e.invoice_id
       from latch_entry e
       join (select invoice_id, max(seq) as seq from latch_entry group by invoice_id) m
         on m.invoice_id = e.invoice_id and m.seq = e.seq
      where e.state = 'stuck'
      order by e.at desc
      limit $1`,
    [limit],
  );
  return res.rows.map((r) => r.invoice_id);
}

export { isInFlight };
