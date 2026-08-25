import test from "node:test";
import assert from "node:assert/strict";
import type { LatchError } from "../src/errors.ts";
import { makeProof } from "../src/adapters/ledger-facilitator.ts";
import { assertMoneyIsSound, makeWorld, PAYER, PRICE, stateOf, START_BALANCE } from "./harness.ts";

/**
 * The attack classes published against x402 facilitators and reference SDKs,
 * run against this gate.
 *
 * Each one is a way of separating "the caller was charged" from "the caller was
 * served". The gate's only job is to keep those two facts welded together.
 */

const PROMPT = "what is the risk";
const req = { prompt: PROMPT };

test("FREE SHOPPING: a failed settlement yields no goods", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy(PROMPT);
  w.facilitator.faults.settleFails = true;

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req }),
    (err: LatchError) => err.code === "settlement_failed",
  );

  assert.equal(w.producer.calls, 0, "produced a good for an unpaid caller");
  assert.equal(await stateOf(w, quote.invoiceId), "void");
  assertMoneyIsSound(w, { state: "void", delivered: false });
});

test("FREE SHOPPING: an empty wallet buys nothing", async () => {
  const w = makeWorld({ payerBalance: 0 });
  const { quote, proof } = await w.buy(PROMPT);

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req }),
    (err: LatchError) => err.code === "settlement_failed",
  );

  assert.equal(w.producer.calls, 0, "served a caller who could not pay");
  assert.equal(await stateOf(w, quote.invoiceId), "void");
  assert.equal(w.facilitator.balanceOf(PAYER), 0);
  assert.equal(w.facilitator.balanceOf("0xseller"), 0);
});

test("SETTLEMENT DIVERGENCE: money moved but the call reported failure", async () => {
  // The nastiest published case. A gate that trusts the return value records
  // "nothing happened" over a real charge: the buyer pays and gets nothing,
  // and the seller's own books say the sale never occurred.
  const w = makeWorld();
  const { quote, proof } = await w.buy(PROMPT);
  w.facilitator.faults.settleReportsFailureButMoves = true;

  const out = await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req });

  assert.equal(out.result.answer, `brief for: ${PROMPT}`);
  assert.equal(await stateOf(w, quote.invoiceId), "delivered");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("SETTLEMENT DIVERGENCE: a thrown settle is treated as unknown, not as failure", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy(PROMPT);
  w.facilitator.faults.settlePending = true;

  // Pending is genuinely undecided: park the invoice, never guess.
  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req }),
    (err: LatchError) => err.code === "settlement_failed" && err.retryable === true,
  );
  assert.equal(await stateOf(w, quote.invoiceId), "settling");
  assert.equal(w.producer.calls, 0);

  // Once the network finalises it, the sweep completes the sale rather than
  // dropping it. The buyer paid, so the buyer gets served — just later.
  w.facilitator.faults.settlePending = false;
  assert.equal(w.facilitator.finalizePending(), 1);
  w.clock.advance(60_000);
  const swept = await w.restart().sweep(30_000);
  assert.equal(swept[0]?.state, "delivered");
});

test("REPLAY: a payment proof cannot be spent twice, even if the facilitator accepts it", async () => {
  const w = makeWorld();
  // A facilitator that hands back the same nonce for every proof — i.e. one
  // that does not bind nonces properly. The gate must not depend on it.
  w.facilitator.verify = async (_proof, expected) => ({
    ok: true,
    payer: expected.payer,
    amountMicros: expected.amountMicros,
    nonce: "reused-nonce",
  });

  const first = await w.buy("first");
  await w.gate.redeem({
    invoiceId: first.quote.invoiceId,
    payer: PAYER,
    proof: first.proof,
    request: { prompt: "first" },
  });

  const second = await w.buy("second");
  await assert.rejects(
    w.gate.redeem({
      invoiceId: second.quote.invoiceId,
      payer: PAYER,
      proof: second.proof,
      request: { prompt: "second" },
    }),
    (err: LatchError) => err.code === "proof_replayed",
  );

  assert.equal(w.producer.calls, 1, "a replayed proof bought a second good");
  assert.equal(w.facilitator.balanceOf(PAYER), START_BALANCE - PRICE);
});

test("DOUBLE SPEND: concurrent redeems of one invoice charge exactly once", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy(PROMPT);
  const args = { invoiceId: quote.invoiceId, payer: PAYER, proof, request: req };

  const results = await Promise.allSettled([
    w.gate.redeem(args),
    w.gate.redeem(args),
    w.gate.redeem(args),
  ]);

  const delivered = results.filter((r) => r.status === "fulfilled");
  assert.ok(delivered.length >= 1, "no request succeeded");
  assert.equal(w.facilitator.settlementCount(), 1, "settled more than once");
  assert.equal(w.producer.calls, 1, "produced more than once for one payment");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("DOUBLE SPEND: a stale proof for an already-finished invoice replays, never recharges", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy(PROMPT);
  const args = { invoiceId: quote.invoiceId, payer: PAYER, proof, request: req };
  await w.gate.redeem(args);

  const again = await w.gate.redeem(args);
  assert.equal(again.replayed, true);
  assert.equal(w.facilitator.settlementCount(), 1);
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("COST DRAIN: an unbounded producer cannot burn the seller indefinitely", async () => {
  const w = makeWorld({ produceTimeoutMs: 20, maxProduceAttempts: 2 });
  const { quote, proof } = await w.buy(PROMPT);
  w.producer.mode = "hang";

  await assert.rejects(w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req }));

  // Bounded attempts, then a refund. It never loops and never holds the money.
  assert.ok(w.producer.calls <= 2, `producer ran ${w.producer.calls} times`);
  assert.equal(await stateOf(w, quote.invoiceId), "refunded");
  assertMoneyIsSound(w, { state: "refunded", delivered: false });
});

test("COST DRAIN: repeated recovery sweeps do not re-run a finished invoice", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy(PROMPT);
  await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req });

  w.clock.advance(120_000);
  for (let i = 0; i < 5; i++) await w.restart().sweep(1000);

  assert.equal(w.producer.calls, 1);
  assert.equal(w.facilitator.settlementCount(), 1);
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("the producer is told its budget and its deadline", async () => {
  const w = makeWorld({ produceTimeoutMs: 5000 });
  let seen: { budgetMicros: number; hasDeadline: boolean } | undefined;
  w.producer.producer.produce = async (_req, ctx) => {
    seen = { budgetMicros: ctx.budgetMicros, hasDeadline: ctx.deadline > 0 };
    return { answer: "ok" };
  };

  const { quote, proof } = await w.buy(PROMPT);
  await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: req });

  assert.deepEqual(seen, { budgetMicros: PRICE, hasDeadline: true });
});

test("a proof for a different invoice is rejected", async () => {
  const w = makeWorld();
  const a = await w.buy("a");
  const b = await w.buy("b");

  await assert.rejects(
    w.gate.redeem({
      invoiceId: b.quote.invoiceId,
      payer: PAYER,
      proof: makeProof(a.quote),
      request: { prompt: "b" },
    }),
    (err: LatchError) => err.code === "proof_invalid",
  );
  assert.equal(w.producer.calls, 0);
});
