import { JournalConflictError } from "../errors.ts";
import { hashReceipt, type SignedReceipt } from "../receipt.ts";
import type { Journal, Quote } from "../ports.ts";
import {
  eq,
  ok,
  runChecks,
  throws,
  type ConformanceCheck,
  type ConformanceReport,
  type Harness,
} from "./core.ts";

/**
 * The Journal contract, made executable.
 *
 * Until this existed the port's rules lived in prose doc comments, which meant
 * nobody could check an adapter against them — and two adapters in this very
 * repo drifted apart on `putResult` without anything failing. That drift let a
 * signed receipt attest a result the caller never received.
 *
 * Every rule below is here because breaking it loses money or corrupts
 * evidence, and each check says which. Run it against any Journal you write:
 *
 *   import { runJournalConformance } from "latch402/conformance";
 *   const report = await runJournalConformance({ create: () => myJournal() });
 *
 * The suite deliberately uses no test framework and no assertion library, so
 * it runs anywhere the library does.
 */

/** A fresh, empty journal per check. */
export type JournalHarness = Harness<Journal>;

let counter = 0;
function quote(overrides: Partial<Quote> = {}): Quote {
  counter++;
  return {
    invoiceId: `inv_conf_${counter}`,
    sku: "test",
    amountMicros: 24_000,
    payTo: "0xseller",
    network: "base",
    asset: "USDC",
    payer: "agt_payer",
    requestHash: "requesthash",
    nonce: `nonce_${counter}`,
    expiresAt: 1_800_000_000_000,
    ...overrides,
  };
}

const isConflict = (err: unknown) => err instanceof JournalConflictError;

function receipt(invoiceId: string, prev: string): SignedReceipt {
  return {
    receipt: {
      version: 1,
      invoiceId,
      outcome: "delivered",
      payer: "agt_payer",
      payTo: "0xseller",
      chargedMicros: 24_000,
      asset: "USDC",
      network: "base",
      requestHash: "requesthash",
      resultHash: "resulthash",
      settlementRef: "stl_1",
      refundRef: null,
      issuedAt: 1,
      prev: prev || "0".repeat(64),
    },
    signature: "unsigned-for-conformance",
  };
}

// ── the contract ───────────────────────────────────────────────────────────

export const JOURNAL_CHECKS: ConformanceCheck<Journal>[] = [
  {
    id: "J1",
    title: "An opened invoice starts at seq 0 in state `quoted`",
    why: "The gate reads the current state before every transition. An invoice with no entries has no state, and recovery cannot classify it.",
    async run(j) {
      const q = quote();
      await j.open(q);
      const snap = await j.get(q.invoiceId);
      ok(snap, "get() returned nothing for an opened invoice");
      eq(snap.state, "quoted", "opening state");
      eq(snap.seq, 0, "opening seq");
      eq(snap.entries.length, 1, "entry count after open");
    },
  },
  {
    id: "J2",
    title: "An unknown invoice reads as undefined, not an error",
    why: "The gate distinguishes `unknown_invoice` (404) from a journal fault (500). Throwing here turns a bad request into an outage.",
    async run(j) {
      eq(await j.get("inv_does_not_exist"), undefined, "get() of a missing invoice");
    },
  },
  {
    id: "J3",
    title: "append advances the sequence by exactly one",
    why: "The sequence is the gate's optimistic-concurrency token. Gaps or repeats break every later compare-and-set.",
    async run(j) {
      const q = quote();
      await j.open(q);
      const e = await j.append(
        { invoiceId: q.invoiceId, state: "verifying", at: 1, evidence: {} },
        0,
      );
      eq(e.seq, 1, "seq after first append");
      const snap = await j.get(q.invoiceId);
      eq(snap?.seq, 1, "snapshot seq");
      eq(snap?.state, "verifying", "snapshot state");
    },
  },
  {
    id: "J4",
    title: "append with a stale expectedSeq is refused with JournalConflictError",
    why: "This is the compare-and-set. Without it two workers both advance one invoice and the caller is charged twice. The error TYPE matters: the gate maps a conflict to a retryable 409, and anything else to a hard failure.",
    async run(j) {
      const q = quote();
      await j.open(q);
      await j.append({ invoiceId: q.invoiceId, state: "verifying", at: 1, evidence: {} }, 0);
      await throws(
        () => j.append({ invoiceId: q.invoiceId, state: "settling", at: 2, evidence: {} }, 0),
        isConflict,
        "a stale append must raise JournalConflictError",
      );
    },
  },
  {
    id: "J5",
    title: "append refuses a write that would leave a gap",
    why: "A gap means an entry the journal never saw. Recovery replays the sequence to decide what happened; a hole in it is unrecoverable ambiguity.",
    async run(j) {
      const q = quote();
      await j.open(q);
      await throws(
        () => j.append({ invoiceId: q.invoiceId, state: "settled", at: 1, evidence: {} }, 7),
        isConflict,
        "an append past the tip must be refused",
      );
      eq((await j.get(q.invoiceId))?.seq, 0, "seq must be unchanged after a refused append");
    },
  },
  {
    id: "J6",
    title: "Concurrent appends at the same seq: exactly one succeeds",
    why: "The real race. If two win, the caller pays twice; if both fail, the invoice stalls. Exactly one must land.",
    async run(j) {
      const q = quote();
      await j.open(q);
      const entry = { invoiceId: q.invoiceId, state: "verifying" as const, at: 1, evidence: {} };
      const settled = await Promise.allSettled([
        j.append(entry, 0),
        j.append(entry, 0),
        j.append(entry, 0),
      ]);
      const won = settled.filter((r) => r.status === "fulfilled");
      eq(won.length, 1, "number of writers that advanced the invoice");
      for (const r of settled) {
        if (r.status === "rejected") {
          ok(isConflict(r.reason), "a lost race must reject with JournalConflictError");
        }
      }
      eq((await j.get(q.invoiceId))?.seq, 1, "seq after the race");
    },
  },
  {
    id: "J7",
    title: "History is append-only, ordered, and preserves evidence",
    why: "The journal is the evidence of what happened. If entries reorder, mutate, or lose their evidence, recovery reaches the wrong conclusion and receipts become unprovable.",
    async run(j) {
      const q = quote();
      await j.open(q);
      await j.append({ invoiceId: q.invoiceId, state: "verifying", at: 111, evidence: { a: 1 } }, 0);
      await j.append(
        { invoiceId: q.invoiceId, state: "settling", at: 222, evidence: { ref: "stl_9" } },
        1,
      );
      const snap = await j.get(q.invoiceId);
      ok(snap, "snapshot missing");
      eq(snap.entries.length, 3, "entry count");
      eq(snap.entries.map((e) => e.state).join(","), "quoted,verifying,settling", "entry order");
      eq(snap.entries[1]?.evidence.a, 1, "numeric evidence must survive");
      eq(snap.entries[2]?.evidence.ref, "stl_9", "string evidence must survive");
      eq(snap.entries[2]?.at, 222, "timestamps must survive (watch bigint round-trips)");
    },
  },
  {
    id: "J8",
    title: "The quote survives a round trip intact",
    why: "Recovery runs in a fresh process with only the journal. A mangled amount or payer means refunding the wrong sum to the wrong party.",
    async run(j) {
      const q = quote({ amountMicros: 120_000, payer: "agt_specific", sku: "deep" });
      await j.open(q);
      const got = (await j.get(q.invoiceId))?.quote;
      ok(got, "quote missing");
      eq(got.amountMicros, 120_000, "amountMicros");
      eq(got.payer, "agt_specific", "payer");
      eq(got.sku, "deep", "sku");
      eq(got.nonce, q.nonce, "nonce");
      eq(got.expiresAt, q.expiresAt, "expiresAt");
    },
  },
  {
    id: "J9",
    title: "A nonce can be consumed exactly once",
    why: "This is replay protection. A nonce that can burn twice lets one payment proof buy two goods.",
    async run(j) {
      eq(await j.consumeNonce("n_once", "inv_a"), true, "first consume");
      eq(await j.consumeNonce("n_once", "inv_b"), false, "second consume");
    },
  },
  {
    id: "J10",
    title: "Concurrent nonce consumption: exactly one caller wins",
    why: "Checking then writing is not enough — a replay can land between the two. The burn must be atomic.",
    async run(j) {
      const results = await Promise.all([
        j.consumeNonce("n_race", "inv_a"),
        j.consumeNonce("n_race", "inv_b"),
        j.consumeNonce("n_race", "inv_c"),
      ]);
      eq(results.filter(Boolean).length, 1, "winners of the nonce race");
    },
  },
  {
    id: "J11",
    title: "putResult is FIRST-write-wins",
    why: "The audited bug. The gate hashes the durably stored result into the signed receipt. If a later attempt can overwrite an earlier one, the receipt attests a result the caller never received — and two adapters in this repo really did disagree on this.",
    async run(j) {
      await j.putResult("k", { answer: "first" });
      await j.putResult("k", { answer: "second" });
      const got = await j.getResult("k");
      ok(got, "stored result missing");
      eq(
        (got.payload as { answer: string }).answer,
        "first",
        "a stored result must never be overwritten",
      );
    },
  },
  {
    id: "J12",
    title: "getResult distinguishes 'absent' from 'stored'",
    why: "The gate treats a missing request payload as un-replayable and refunds. A falsy-but-present payload that reads as absent refunds a sale that should have been delivered.",
    async run(j) {
      eq(await j.getResult("never_written"), undefined, "missing key");
      await j.putResult("falsy", 0);
      const got = await j.getResult("falsy");
      ok(got, "a stored falsy payload must still read as present");
      eq(got.payload, 0, "falsy payload value");
    },
  },
  {
    id: "J13",
    title: "findInFlight returns only in-flight invoices, oldest first",
    why: "This drives the recovery sweep. Returning terminal invoices re-runs finished work; missing in-flight ones strands money forever.",
    async run(j) {
      const done = quote();
      await j.open(done);
      await j.append({ invoiceId: done.invoiceId, state: "verifying", at: 100, evidence: {} }, 0);
      await j.append({ invoiceId: done.invoiceId, state: "void", at: 150, evidence: {} }, 1);

      const old = quote();
      await j.open(old);
      await j.append({ invoiceId: old.invoiceId, state: "verifying", at: 200, evidence: {} }, 0);
      await j.append({ invoiceId: old.invoiceId, state: "settling", at: 300, evidence: {} }, 1);

      const recent = quote();
      await j.open(recent);
      await j.append({ invoiceId: recent.invoiceId, state: "settling", at: 250, evidence: {} }, 0);

      const found = await j.findInFlight(400, 10);
      eq(found.join(","), `${recent.invoiceId},${old.invoiceId}`, "set and order (oldest first)");

      eq((await j.findInFlight(240, 10)).length, 0, "must respect the cutoff");
      eq((await j.findInFlight(400, 1)).length, 1, "must respect the limit");
    },
  },
  {
    id: "J14",
    title: "The receipt chain does not fork under concurrency",
    why: "Each receipt commits to the hash of the previous one. If two receipts share a predecessor the chain forks, and tamper-evidence is gone — the seller can no longer prove what was sold.",
    async run(j) {
      const ids = ["inv_r1", "inv_r2", "inv_r3", "inv_r4"];
      await Promise.all(ids.map((id) => j.appendReceipt((prev) => receipt(id, prev))));

      const chain = await j.readChain();
      eq(chain.length, 4, "receipts written");
      const prevs = new Set(chain.map((l) => l.receipt.prev));
      eq(prevs.size, 4, "every receipt must have a distinct predecessor");

      // And the chain must actually link, in the order returned.
      let expected = "0".repeat(64);
      for (let i = 0; i < chain.length; i++) {
        const link = chain[i];
        ok(link, `chain link ${i} missing`);
        eq(link.receipt.prev, expected, `link ${i} does not point at its predecessor`);
        expected = hashReceipt(link.receipt);
      }
    },
  },
  {
    id: "J16",
    title: "append to an unknown invoice fails, and NOT as a conflict",
    why: "Found by this kit: Postgres reported it as JournalConflictError while memory raised a plain error. The gate maps a conflict to a retryable 409, so one adapter was telling callers to retry an invoice that does not exist and never will — an infinite retry on a request that cannot succeed.",
    async run(j) {
      await throws(
        () => j.append({ invoiceId: "inv_nonexistent", state: "verifying", at: 1, evidence: {} }, 0),
        (err) => err instanceof Error && !isConflict(err),
        "appending to an unknown invoice must throw a non-retryable error",
      );
    },
  },
  {
    id: "J17",
    title: "Opening the same invoice twice is refused",
    why: "An invoice that can be re-opened loses its history, and with it the record of any money already moved. Re-opening must never silently reset an invoice.",
    async run(j) {
      const q = quote();
      await j.open(q);
      await throws(
        () => j.open(q),
        (err) => err instanceof Error,
        "re-opening an invoice must throw",
      );
      const snap = await j.get(q.invoiceId);
      eq(snap?.seq, 0, "a refused re-open must not disturb the existing invoice");
      eq(snap?.entries.length, 1, "entry count after a refused re-open");
    },
  },
  {
    id: "J15",
    title: "readChain returns receipts in insertion order",
    why: "The gate finds an invoice's receipt by scanning backwards for the most recent match. Out-of-order reads return a stale receipt for a re-finalised invoice.",
    async run(j) {
      for (const id of ["inv_o1", "inv_o2", "inv_o3"]) {
        await j.appendReceipt((prev) => receipt(id, prev));
      }
      const chain = await j.readChain();
      eq(
        chain.map((l) => l.receipt.invoiceId).join(","),
        "inv_o1,inv_o2,inv_o3",
        "receipt order",
      );
    },
  },
  // ── credit register, for batched settlement ──────────────────────────────
  {
    id: "J18",
    title: "reserveCredit refuses a reservation that would exceed the total limit",
    why: "The limit is the most the seller can lose if every pending batch fails. A reservation that slips past it is unbounded exposure the seller never agreed to.",
    async run(j) {
      const limits = { payer: "p", totalLimitMicros: 50_000 };
      eq(await j.reserveCredit({ ...limits, invoiceId: "c1", amountMicros: 30_000 }), true, "first reservation");
      eq(await j.reserveCredit({ ...limits, invoiceId: "c2", amountMicros: 30_000 }), false, "reservation past the limit");
      eq(await j.reserveCredit({ ...limits, invoiceId: "c3", amountMicros: 20_000 }), true, "reservation exactly at the limit");
      const held = await j.listCredit();
      eq(held.reduce((n, r) => n + r.amountMicros, 0), 50_000, "total reserved");
      ok(!held.some((r) => r.invoiceId === "c2"), "a refused reservation must reserve nothing");
    },
  },
  {
    id: "J19",
    title: "reserveCredit enforces the per-payer limit independently",
    why: "Without it one caller can absorb the seller's entire credit, and one bad batch from that caller is the whole loss.",
    async run(j) {
      const base = { totalLimitMicros: 1_000_000, perPayerLimitMicros: 40_000, amountMicros: 30_000 };
      eq(await j.reserveCredit({ ...base, invoiceId: "a1", payer: "alice" }), true, "alice's first");
      eq(await j.reserveCredit({ ...base, invoiceId: "a2", payer: "alice" }), false, "alice past her own limit");
      eq(await j.reserveCredit({ ...base, invoiceId: "b1", payer: "bob" }), true, "bob is unaffected by alice");
    },
  },
  {
    id: "J20",
    title: "reserveCredit is idempotent per invoice",
    why: "Recovery may reserve again for an invoice that already holds credit. Counting it twice shrinks the seller's real limit; refusing it would strand a sale that is already covered.",
    async run(j) {
      const r = { invoiceId: "dup", payer: "p", amountMicros: 30_000, totalLimitMicros: 40_000 };
      eq(await j.reserveCredit(r), true, "first reservation");
      eq(await j.reserveCredit(r), true, "repeat reservation for the same invoice");
      const held = await j.listCredit();
      eq(held.length, 1, "reservations held");
      eq(held[0]?.amountMicros, 30_000, "amount held — must not be doubled");
    },
  },
  {
    id: "J21",
    title: "Concurrent reservations never jointly exceed the limit",
    why: "The check-then-act race. Each sale alone fits; checked separately, all of them see room and together blow through the limit. The check and the reservation must be one step.",
    async run(j) {
      const results = await Promise.all(
        ["r1", "r2", "r3", "r4"].map((invoiceId) =>
          j.reserveCredit({ invoiceId, payer: "p", amountMicros: 30_000, totalLimitMicros: 70_000 }),
        ),
      );
      eq(results.filter(Boolean).length, 2, "reservations granted (70,000 fits two of 30,000)");
      const total = (await j.listCredit()).reduce((n, r) => n + r.amountMicros, 0);
      ok(total <= 70_000, `concurrent reservations exceeded the limit: ${total}`);
    },
  },
  {
    id: "J22",
    title: "releaseCredit frees exactly one reservation, and is idempotent",
    why: "Releasing the wrong reservation, or too much, silently raises the seller's exposure. Releasing must also be safe to repeat, because recovery and the sweep both release.",
    async run(j) {
      const base = { payer: "p", amountMicros: 30_000, totalLimitMicros: 60_000 };
      await j.reserveCredit({ ...base, invoiceId: "keep" });
      await j.reserveCredit({ ...base, invoiceId: "drop" });
      await j.releaseCredit("drop");
      await j.releaseCredit("drop");
      await j.releaseCredit("never_reserved");
      const held = await j.listCredit();
      eq(held.map((r) => r.invoiceId).join(","), "keep", "reservations after release");
      eq(await j.reserveCredit({ ...base, invoiceId: "again" }), true, "released credit must be reusable");
    },
  },
];

/** Run the whole journal contract. Returns a report; never throws for a failed check. */
export function runJournalConformance(
  harness: JournalHarness,
  only?: readonly string[],
): Promise<ConformanceReport> {
  return runChecks(JOURNAL_CHECKS, harness, only);
}
