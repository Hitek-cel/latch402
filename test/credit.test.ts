import test from "node:test";
import assert from "node:assert/strict";
import type { LatchError } from "../src/errors.ts";
import {
  assertMoneyIsSound,
  crashingJournal,
  makeWorld,
  PAYER,
  PRICE,
  START_BALANCE,
  stateOf,
} from "./harness.ts";

/**
 * Batched settlement.
 *
 * A batched rail accepts a payment now and makes it final later. The gate
 * either waits for the batch (default, always safe) or, with a credit policy,
 * serves the caller now and carries the risk until the batch lands.
 *
 * The promise under credit, stated precisely: the CALLER is never charged
 * without the good or a refund — that half is never relaxed. The SELLER may
 * deliver without being paid, but only up to a limit it chose. Every test here
 * asserts the money, not just the state.
 */

const PROMPT = "what is the risk";
const req = { prompt: PROMPT };
const settled = async (w: ReturnType<typeof makeWorld>) => {
  w.clock.advance(60_000);
  return w.restart().sweep(30_000);
};

test("without a credit policy, a batched payment waits — no compute before money is final", async () => {
  const w = makeWorld();
  w.facilitator.faults.batched = true;
  const { quote, proof } = await w.buy(PROMPT);

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req }),
    (e: LatchError) => e.code === "settlement_failed" && e.retryable === true,
  );
  assert.equal(await stateOf(w, quote.invoiceId), "settling");
  assert.equal(w.producer.calls, 0, "compute was spent before the money was final");

  w.facilitator.finalizePending();
  const swept = await settled(w);
  assert.equal(swept[0]?.state, "delivered");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("with credit, the caller is served before the batch lands — then it settles normally", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  const { quote, proof } = await w.buy(PROMPT);
  const args = { invoiceId: quote.invoiceId, payer: PAYER, proof, request: req };

  const out = await w.gate.redeem(args);
  assert.equal(out.result.answer, `brief for: ${PROMPT}`, "the caller was not served");
  assert.equal(out.settlement, "pending");
  assert.equal(out.receipt, undefined, "no final receipt while the batch is pending");
  assert.equal(await stateOf(w, quote.invoiceId), "fronted");
  assert.equal(w.facilitator.balanceOf(PAYER), START_BALANCE, "nothing should have moved yet");
  assert.deepEqual(await w.gate.creditExposure(), { totalMicros: PRICE, invoices: 1 });

  w.facilitator.finalizePending();
  const swept = await settled(w);
  assert.equal(swept[0]?.state, "delivered");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
  assert.deepEqual(await w.gate.creditExposure(), { totalMicros: 0, invoices: 0 }, "credit not released");
  assert.equal(w.producer.calls, 1);

  // The caller's retry now carries the final, signed receipt.
  const again = await w.restart().redeem(args);
  assert.equal(again.settlement, "final");
  assert.ok(again.receipt);
  assert.equal(again.receipt.receipt.outcome, "delivered");
  assert.equal(again.receipt.receipt.chargedMicros, PRICE);
});

test("a batch that fails after delivery is written off — the caller is never charged", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  const { quote, proof } = await w.buy(PROMPT);
  const args = { invoiceId: quote.invoiceId, payer: PAYER, proof, request: req };
  await w.gate.redeem(args);

  w.facilitator.failPendingBatch();
  const swept = await settled(w);

  assert.equal(swept[0]?.state, "written_off");
  assertMoneyIsSound(w, { state: "written_off", delivered: true });
  assert.deepEqual(await w.gate.creditExposure(), { totalMicros: 0, invoices: 0 });

  const last = (await w.gate.chain()).at(-1);
  assert.equal(last?.receipt.outcome, "written_off", "a loss must leave a receipt, never be silent");
  assert.equal(last?.receipt.chargedMicros, 0);

  const again = await w.restart().redeem(args);
  assert.equal(again.settlement, "written_off", "the caller should be told it was never charged");
  assert.equal(again.result.answer, `brief for: ${PROMPT}`);
});

test("credit is bounded: past the limit the gate waits instead of fronting", async () => {
  // Room for exactly one 24,000 sale.
  const w = makeWorld({ credit: { maxOutstandingMicros: 30_000 } });
  w.facilitator.faults.batched = true;
  const one = await w.buy("one");
  const two = await w.buy("two");

  const first = await w.gate.redeem({ ...one, invoiceId: one.quote.invoiceId, payer: PAYER, request: { prompt: "one" } });
  assert.equal(first.settlement, "pending");

  await assert.rejects(
    w.gate.redeem({ invoiceId: two.quote.invoiceId, payer: PAYER, proof: two.proof, request: { prompt: "two" } }),
    (e: LatchError) => e.code === "settlement_failed" && e.retryable === true,
    "a sale past the limit must wait, not error terminally",
  );
  assert.equal(await stateOf(w, two.quote.invoiceId), "settling");
  assert.equal(w.producer.calls, 1, "compute was spent beyond the credit limit");
  assert.equal((await w.gate.creditExposure()).totalMicros, PRICE);

  // Both complete once the batch lands — the waiting one just later.
  w.facilitator.finalizePending();
  await settled(w);
  assert.equal(await stateOf(w, one.quote.invoiceId), "delivered");
  assert.equal(await stateOf(w, two.quote.invoiceId), "delivered");
  assert.equal(w.facilitator.balanceOf(PAYER), START_BALANCE - 2 * PRICE);
  assert.equal(w.facilitator.balanceOf("0xseller"), 2 * PRICE);
});

test("the per-caller limit is enforced independently of the total", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000, maxPerPayerMicros: 30_000 } });
  w.facilitator.faults.batched = true;
  const one = await w.buy("one");
  const two = await w.buy("two");

  await w.gate.redeem({ invoiceId: one.quote.invoiceId, payer: PAYER, proof: one.proof, request: { prompt: "one" } });
  await assert.rejects(
    w.gate.redeem({ invoiceId: two.quote.invoiceId, payer: PAYER, proof: two.proof, request: { prompt: "two" } }),
    (e: LatchError) => e.retryable === true,
  );
  assert.equal(w.producer.calls, 1, "one caller exceeded its own credit limit");
});

test("concurrent sales can never jointly exceed the limit", async () => {
  // The check-then-act race: each sale alone fits, any two together do not.
  const w = makeWorld({ credit: { maxOutstandingMicros: 30_000 } });
  w.facilitator.faults.batched = true;
  const buys = await Promise.all(["a", "b", "c"].map((p) => w.buy(p)));

  const results = await Promise.allSettled(
    buys.map((b, i) =>
      w.gate.redeem({ invoiceId: b.quote.invoiceId, payer: PAYER, proof: b.proof, request: { prompt: ["a", "b", "c"][i]! } }),
    ),
  );

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "more than one sale fronted");
  assert.equal((await w.gate.creditExposure()).totalMicros, PRICE, "exposure exceeded the limit");
  assert.equal(w.producer.calls, 1);
});

test("production failing on credit, batch lands: the payment comes back", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  w.producer.mode = "throw";
  const { quote, proof } = await w.buy(PROMPT);

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req }),
    (e: LatchError) => e.code === "producer_failed",
  );
  assert.equal(await stateOf(w, quote.invoiceId), "abandoning");
  assert.equal(w.facilitator.balanceOf(PAYER), START_BALANCE, "nothing has moved yet");

  // The batch lands after all, so there is now real money to give back.
  w.facilitator.finalizePending();
  const swept = await settled(w);
  assert.equal(swept[0]?.state, "refunded");
  assertMoneyIsSound(w, { state: "refunded", delivered: false });
  assert.equal((await w.gate.creditExposure()).totalMicros, 0);
});

test("production failing on credit, batch fails: void — nothing moved, nothing owed", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  w.producer.mode = "throw";
  const { quote, proof } = await w.buy(PROMPT);

  await w.gate
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req })
    .catch(() => undefined);

  w.facilitator.failPendingBatch();
  const swept = await settled(w);
  assert.equal(swept[0]?.state, "void");
  assertMoneyIsSound(w, { state: "void", delivered: false });
  assert.equal((await w.gate.creditExposure()).totalMicros, 0);
});

test("replaying a fronted sale returns the same good — no second production, no second charge", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  const { quote, proof } = await w.buy(PROMPT);
  const args = { invoiceId: quote.invoiceId, payer: PAYER, proof, request: req };

  const first = await w.gate.redeem(args);
  const second = await w.gate.redeem(args);

  assert.deepEqual(second.result, first.result);
  assert.equal(second.replayed, true);
  assert.equal(second.settlement, "pending");
  assert.equal(w.producer.calls, 1, "the good was produced twice");
  assert.equal(w.facilitator.settlementCount(), 1, "the payment was submitted twice");
});

test("a crash after credit is reserved: recovery waits, never produces against credit", async () => {
  // Appends: verifying(1), settling(2), credited(3). Die right after credit.
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  const { quote, proof } = await w.buy(PROMPT);

  await w
    .restart(crashingJournal(w.journal, { atAppend: 3, when: "after" }))
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req })
    .catch(() => undefined);
  assert.equal(await stateOf(w, quote.invoiceId), "credited");

  // Credit exists to serve a caller who is waiting. After a crash nobody is,
  // so recovery takes no new risk.
  assert.equal(await w.restart().recover(quote.invoiceId), "credited");
  assert.equal(w.producer.calls, 0, "recovery produced against unsettled money");

  w.facilitator.finalizePending();
  assert.equal(await w.restart().recover(quote.invoiceId), "delivered");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
  assert.equal((await w.gate.creditExposure()).totalMicros, 0);
});

test("a reservation stranded by a crash fails safe, and the sweep heals it", async () => {
  // Die after credit is reserved but before `credited` is journaled. The
  // reservation is stranded — which can only make the gate extend LESS credit.
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  w.facilitator.faults.batched = true;
  const { quote, proof } = await w.buy(PROMPT);

  await w
    .restart(crashingJournal(w.journal, { atAppend: 3, when: "before" }))
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req })
    .catch(() => undefined);
  assert.equal(await stateOf(w, quote.invoiceId), "settling");
  assert.equal((await w.gate.creditExposure()).totalMicros, PRICE, "reservation should be held");

  w.facilitator.finalizePending();
  await settled(w);

  assert.equal(await stateOf(w, quote.invoiceId), "delivered");
  assert.equal((await w.gate.creditExposure()).totalMicros, 0, "the sweep did not heal the stray reservation");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("credit changes nothing on a rail that settles immediately", async () => {
  const w = makeWorld({ credit: { maxOutstandingMicros: 1_000_000 } });
  const { quote, proof } = await w.buy(PROMPT);

  const out = await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req });

  assert.equal(out.settlement, "final");
  assert.ok(out.receipt);
  assert.equal((await w.gate.creditExposure()).totalMicros, 0);
  const states = (await w.journal.get(quote.invoiceId))?.entries.map((e) => e.state);
  assert.ok(!states?.includes("credited"), "credit was used on a final settlement");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});
