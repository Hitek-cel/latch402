import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { Latch } from "../src/gate.ts";
import { postgresJournal, migrate, listStuck, type SqlClient, type SqlExecutor } from "../src/adapters/postgres-journal.ts";
import { ledgerFacilitator, makeProof } from "../src/adapters/ledger-facilitator.ts";
import { auditChain, hmacSigner } from "../src/receipt.ts";
import { JournalConflictError } from "../src/errors.ts";
import type { Journal, Quote } from "../src/ports.ts";

/**
 * The adapter is exercised against a real PostgreSQL (PGlite runs Postgres 18
 * in-process), so unique constraints, transactions and row locks behave exactly
 * as they would in production. A hand-written fake would prove nothing here —
 * the guarantees being tested are the database's, not the code's.
 *
 * The last block is the point of the whole file: the complete gate, including
 * crash recovery, driven over Postgres instead of the in-memory journal. If the
 * `Journal` port were a comfortable fiction rather than a real abstraction,
 * these would fail.
 */

const SECRET = "postgres-test-secret-long-enough-ok";
const BUYER = "agt_buyer";
const SELLER = "0xseller";
const PRICE = 24_000;
const START = 1_000_000;

/** Wrap PGlite in the tiny SqlClient shape the adapter asks for. */
function client(db: PGlite): SqlClient {
  const exec = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({
    async query<R>(text: string, params: readonly unknown[] = []) {
      const r = await runner.query(text, [...params]);
      return {
        rows: r.rows as R[],
        rowCount: r.affectedRows ?? r.rows.length,
      };
    },
  });
  return {
    ...exec(db),
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return (await db.transaction(async (tx) => fn(exec(tx)))) as T;
    },
  };
}

async function freshDb(): Promise<{ db: PGlite; journal: Journal; sql: SqlClient }> {
  const db = await PGlite.create();
  const sql = client(db);
  await migrate(sql);
  return { db, journal: postgresJournal(sql), sql };
}

function quoteFor(invoiceId: string, overrides: Partial<Quote> = {}): Quote {
  return {
    invoiceId,
    sku: "brief",
    amountMicros: PRICE,
    payTo: SELLER,
    network: "base",
    asset: "USDC",
    payer: BUYER,
    requestHash: "hash",
    nonce: `nonce-${invoiceId}`,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

// ── schema ────────────────────────────────────────────────────────────────

test("postgres: migration is idempotent", async () => {
  const db = await PGlite.create();
  const sql = client(db);
  await migrate(sql);
  await migrate(sql); // must not throw
  const r = await sql.query<{ count: string }>(
    `select count(*)::text as count from latch_chain_head`,
  );
  assert.equal(r.rows[0]?.count, "1", "chain head seeded exactly once");
});

// ── compare-and-set ───────────────────────────────────────────────────────

test("postgres: two workers racing one invoice — exactly one advances it", async () => {
  const { journal } = await freshDb();
  const q = quoteFor("inv_race");
  await journal.open(q);

  const entry = { invoiceId: q.invoiceId, state: "verifying" as const, at: Date.now(), evidence: {} };
  const results = await Promise.allSettled([
    journal.append(entry, 0),
    journal.append(entry, 0),
    journal.append(entry, 0),
  ]);

  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "more than one worker advanced the invoice");
  assert.equal(lost.length, 2);
  for (const l of lost) {
    assert.ok(
      (l as PromiseRejectedResult).reason instanceof JournalConflictError,
      "a lost race must be a JournalConflictError, not a generic failure",
    );
  }

  const snap = await journal.get(q.invoiceId);
  assert.equal(snap?.seq, 1, "sequence jumped");
});

test("postgres: an append that would leave a gap is refused", async () => {
  const { journal } = await freshDb();
  const q = quoteFor("inv_gap");
  await journal.open(q);

  await assert.rejects(
    journal.append(
      { invoiceId: q.invoiceId, state: "settled", at: Date.now(), evidence: {} },
      5, // tip is 0, so this would write seq 6 and skip 1-5
    ),
    (e: unknown) => e instanceof JournalConflictError,
  );
  const snap = await journal.get(q.invoiceId);
  assert.equal(snap?.seq, 0, "a gapped write got through");
});

test("postgres: history is append-only and survives a round trip", async () => {
  const { journal } = await freshDb();
  const q = quoteFor("inv_hist");
  await journal.open(q);
  await journal.append({ invoiceId: q.invoiceId, state: "verifying", at: 111, evidence: { a: 1 } }, 0);
  await journal.append({ invoiceId: q.invoiceId, state: "settling", at: 222, evidence: { b: "x" } }, 1);

  const snap = await journal.get(q.invoiceId);
  assert.equal(snap?.entries.length, 3);
  assert.deepEqual(snap?.entries.map((e) => e.state), ["quoted", "verifying", "settling"]);
  assert.deepEqual(snap?.entries[1]?.evidence, { a: 1 });
  assert.equal(snap?.entries[2]?.at, 222, "timestamps must survive the bigint round trip");
  assert.equal(snap?.quote.amountMicros, PRICE, "the quote must round trip through jsonb");
});

// ── exactly-once nonces ───────────────────────────────────────────────────

test("postgres: a nonce can be consumed exactly once, even concurrently", async () => {
  const { journal } = await freshDb();
  const outcomes = await Promise.all([
    journal.consumeNonce("shared-nonce", "inv_a"),
    journal.consumeNonce("shared-nonce", "inv_b"),
    journal.consumeNonce("shared-nonce", "inv_c"),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1, "a proof was spent more than once");
});

// ── results ───────────────────────────────────────────────────────────────

test("postgres: a stored result is never overwritten", async () => {
  const { journal } = await freshDb();
  await journal.putResult("k", { answer: "first" });
  await journal.putResult("k", { answer: "second" });
  const got = await journal.getResult("k");
  assert.deepEqual(got?.payload, { answer: "first" }, "the delivered good was overwritten");
  assert.equal(await journal.getResult("missing"), undefined);
});

// ── sweep ─────────────────────────────────────────────────────────────────

test("postgres: the sweep finds only in-flight invoices, oldest first", async () => {
  const { journal } = await freshDb();

  await journal.open(quoteFor("inv_done"));
  await journal.append({ invoiceId: "inv_done", state: "verifying", at: 100, evidence: {} }, 0);
  await journal.append({ invoiceId: "inv_done", state: "void", at: 150, evidence: {} }, 1);

  await journal.open(quoteFor("inv_old"));
  await journal.append({ invoiceId: "inv_old", state: "verifying", at: 200, evidence: {} }, 0);
  await journal.append({ invoiceId: "inv_old", state: "settling", at: 300, evidence: {} }, 1);

  await journal.open(quoteFor("inv_new"));
  await journal.append({ invoiceId: "inv_new", state: "settling", at: 250, evidence: {} }, 0);

  const found = await journal.findInFlight(400, 10);
  assert.deepEqual(found, ["inv_new", "inv_old"], "wrong set or wrong order");

  const none = await journal.findInFlight(240, 10);
  assert.deepEqual(none, [], "picked up invoices newer than the cutoff");
});

// ── receipt chain ─────────────────────────────────────────────────────────

test("postgres: concurrent receipts extend one chain instead of forking it", async () => {
  const { journal } = await freshDb();
  const signer = hmacSigner(SECRET);

  const write = (invoiceId: string) =>
    journal.appendReceipt((prev) => {
      const receipt = {
        version: 1 as const,
        invoiceId,
        outcome: "delivered" as const,
        payer: BUYER,
        payTo: SELLER,
        chargedMicros: PRICE,
        asset: "USDC",
        network: "base",
        requestHash: "h",
        resultHash: "r",
        settlementRef: "stl",
        refundRef: null,
        issuedAt: 1,
        prev: prev || "0".repeat(64),
      };
      return { receipt, signature: signer.sign(JSON.stringify(receipt)) };
    });

  await Promise.all([write("inv_1"), write("inv_2"), write("inv_3"), write("inv_4")]);

  const chain = await journal.readChain();
  assert.equal(chain.length, 4);
  const prevs = new Set(chain.map((l) => l.receipt.prev));
  assert.equal(prevs.size, 4, "two receipts shared a predecessor — the chain forked");
});

// ── the real test: the whole gate, over Postgres ──────────────────────────

function gateOver(journal: Journal, facilitator: ReturnType<typeof ledgerFacilitator>, opts: { fail?: boolean } = {}) {
  let produced = 0;
  const gate = new Latch<{ prompt: string }, { answer: string }>(
    { payTo: SELLER, produceTimeoutMs: 2_000 },
    {
      journal,
      facilitator,
      signer: hmacSigner(SECRET),
      producer: {
        async produce(req) {
          produced++;
          if (opts.fail) throw new Error("model failed");
          return { answer: `brief: ${req.prompt}` };
        },
      },
    },
  );
  return { gate, calls: () => produced };
}

test("postgres end-to-end: a paid call settles, delivers, and receipts", async () => {
  const { journal } = await freshDb();
  const facilitator = ledgerFacilitator({ [BUYER]: START });
  const { gate, calls } = gateOver(journal, facilitator);

  const { quote } = await gate.quote({
    payer: BUYER, sku: "brief", amountMicros: PRICE, request: { prompt: "risk" },
  });
  const out = await gate.redeem({
    invoiceId: quote.invoiceId, payer: BUYER, proof: makeProof(quote), request: { prompt: "risk" },
  });

  assert.equal(out.result.answer, "brief: risk");
  assert.equal(calls(), 1);
  assert.equal(facilitator.balanceOf(BUYER), START - PRICE);
  assert.equal(facilitator.balanceOf(SELLER), PRICE);
  assert.equal(auditChain(await gate.chain(), hmacSigner(SECRET)), -1);
});

test("postgres end-to-end: a retry replays the good and never charges twice", async () => {
  const { journal } = await freshDb();
  const facilitator = ledgerFacilitator({ [BUYER]: START });
  const { gate, calls } = gateOver(journal, facilitator);

  const { quote } = await gate.quote({
    payer: BUYER, sku: "brief", amountMicros: PRICE, request: { prompt: "risk" },
  });
  const args = { invoiceId: quote.invoiceId, payer: BUYER, proof: makeProof(quote), request: { prompt: "risk" } };

  const first = await gate.redeem(args);
  const second = await gate.redeem(args);

  assert.deepEqual(second.result, first.result);
  assert.equal(second.replayed, true);
  assert.equal(calls(), 1, "produced twice for one payment");
  assert.equal(facilitator.settlementCount(), 1);
  assert.equal(facilitator.balanceOf(BUYER), START - PRICE);
});

test("postgres end-to-end: money moves, the process dies, recovery finishes the sale", async () => {
  const { journal } = await freshDb();
  const facilitator = ledgerFacilitator({ [BUYER]: START });

  // A journal that dies just before recording the settlement — the case that
  // permanently loses money without a durable write-ahead log.
  let appends = 0;
  const crashy: Journal = {
    ...journal,
    async append(entry, expectedSeq) {
      appends++;
      if (appends === 3) throw new Error("PROCESS CRASHED");
      return journal.append(entry, expectedSeq);
    },
  };

  const { gate } = gateOver(journal, facilitator);
  const { quote } = await gate.quote({
    payer: BUYER, sku: "brief", amountMicros: PRICE, request: { prompt: "risk" },
  });

  const crashed = gateOver(crashy, facilitator).gate;
  await crashed
    .redeem({ invoiceId: quote.invoiceId, payer: BUYER, proof: makeProof(quote), request: { prompt: "risk" } })
    .catch(() => undefined);

  // Buyer has paid and holds nothing; the journal is stranded mid-flight.
  assert.equal(facilitator.balanceOf(BUYER), START - PRICE);
  assert.equal((await journal.get(quote.invoiceId))?.state, "settling");

  // A fresh process reads the durable journal and completes it.
  const recovered = await gateOver(journal, facilitator).gate.recover(quote.invoiceId);

  assert.equal(recovered, "delivered");
  assert.equal(facilitator.balanceOf(BUYER), START - PRICE, "charged more than once");
  assert.equal(facilitator.balanceOf(SELLER), PRICE);
  assert.equal(facilitator.balanceOf(BUYER) + facilitator.balanceOf(SELLER), START);
});

test("postgres end-to-end: a failed delivery refunds", async () => {
  const { journal } = await freshDb();
  const facilitator = ledgerFacilitator({ [BUYER]: START });
  const { gate } = gateOver(journal, facilitator, { fail: true });

  const { quote } = await gate.quote({
    payer: BUYER, sku: "brief", amountMicros: PRICE, request: { prompt: "risk" },
  });
  await gate
    .redeem({ invoiceId: quote.invoiceId, payer: BUYER, proof: makeProof(quote), request: { prompt: "risk" } })
    .catch(() => undefined);

  assert.equal((await journal.get(quote.invoiceId))?.state, "refunded");
  assert.equal(facilitator.balanceOf(BUYER), START, "buyer left out of pocket");
  assert.equal(facilitator.balanceOf(SELLER), 0);
});

test("postgres: operators can list invoices stuck holding money", async () => {
  const { journal, sql } = await freshDb();
  const facilitator = ledgerFacilitator({ [BUYER]: START });
  facilitator.faults.refundFails = true;
  const { gate } = gateOver(journal, facilitator, { fail: true });

  const { quote } = await gate.quote({
    payer: BUYER, sku: "brief", amountMicros: PRICE, request: { prompt: "risk" },
  });
  await gate
    .redeem({ invoiceId: quote.invoiceId, payer: BUYER, proof: makeProof(quote), request: { prompt: "risk" } })
    .catch(() => undefined);

  assert.equal((await journal.get(quote.invoiceId))?.state, "stuck");
  assert.deepEqual(await listStuck(sql), [quote.invoiceId], "a stuck invoice must be findable");
});
