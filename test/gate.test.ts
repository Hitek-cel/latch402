import test from "node:test";
import assert from "node:assert/strict";
import { LatchError } from "../src/errors.ts";
import { auditChain, hmacSigner, verifyReceipt } from "../src/receipt.ts";
import { makeProof } from "../src/adapters/ledger-facilitator.ts";
import { assertMoneyIsSound, makeWorld, PAYER, PRICE, SECRET, stateOf, START_BALANCE } from "./harness.ts";

test("happy path: pay once, get the good once, receipt says so", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy("overnight risk in APAC");

  const out = await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "overnight risk in APAC" } });

  assert.equal(out.result.answer, "brief for: overnight risk in APAC");
  assert.equal(out.replayed, false);
  assert.equal(await stateOf(w, quote.invoiceId), "delivered");
  assert.equal(out.settlement, "final", "a strict-path sale settles finally");
  assert.ok(out.receipt, "a final settlement always carries a receipt");
  assert.equal(out.receipt.receipt.chargedMicros, PRICE);
  assert.ok(verifyReceipt(out.receipt, hmacSigner(SECRET)));
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("the good is never produced before the money settles", async () => {
  const w = makeWorld();
  const seen: string[] = [];
  const realSettle = w.facilitator.settle.bind(w.facilitator);
  w.facilitator.settle = async (intent) => {
    seen.push("settle");
    return realSettle(intent);
  };
  const inner = w.producer.producer.produce.bind(w.producer.producer);
  w.producer.producer.produce = async (req, ctx) => {
    seen.push("produce");
    return inner(req, ctx);
  };

  const { quote, proof } = await w.buy();
  await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "what is the risk" } });

  // This ordering is the entire product. The implementation it replaces had it backwards.
  assert.deepEqual(seen, ["settle", "produce"]);
});

test("retrying the same request returns the same good and does not charge twice", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy();
  const args = { invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "what is the risk" } };

  const first = await w.gate.redeem(args);
  const second = await w.gate.redeem(args);
  const third = await w.gate.redeem(args);

  assert.deepEqual(second.result, first.result);
  assert.deepEqual(third.result, first.result);
  assert.equal(second.replayed, true);
  assert.equal(w.producer.calls, 1, "producer ran more than once for one payment");
  assert.equal(w.facilitator.settlementCount(), 1, "settled more than once");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("a quote buys exactly one request, not any request", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy("cheap question");

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "expensive question" } }),
    (err: LatchError) => err.code === "bad_request",
  );
  assert.equal(w.producer.calls, 0);
  assertMoneyIsSound(w, { state: "void", delivered: false });
});

test("another agent cannot spend someone else's invoice", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy();

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: "agt_thief", proof, request: { prompt: "what is the risk" } }),
    (err: LatchError) => err.code === "payer_mismatch",
  );
  assert.equal(w.facilitator.balanceOf(PAYER), START_BALANCE);
});

test("an expired quote is closed, not honoured", async () => {
  const w = makeWorld({ quoteTtlMs: 1000 });
  const { quote, proof } = await w.buy();
  w.clock.advance(1001);

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "what is the risk" } }),
    (err: LatchError) => err.code === "invoice_expired",
  );
  assert.equal(await stateOf(w, quote.invoiceId), "void");
  assertMoneyIsSound(w, { state: "void", delivered: false });
});

test("underpaying is refused and moves nothing", async () => {
  const w = makeWorld();
  const { quote } = await w.buy();
  const short = makeProof(quote, { amountMicros: 1 });

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof: short, request: { prompt: "what is the risk" } }),
    (err: LatchError) => err.code === "amount_mismatch",
  );
  assert.equal(w.producer.calls, 0);
  assertMoneyIsSound(w, { state: "void", delivered: false });
});

test("when the producer fails, the payment comes back", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy();
  w.producer.mode = "throw";

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "what is the risk" } }),
    (err: LatchError) => err.code === "producer_failed",
  );

  assert.equal(await stateOf(w, quote.invoiceId), "refunded");
  assertMoneyIsSound(w, { state: "refunded", delivered: false });
});

test("a hanging producer is cut off at the deadline and refunded", async () => {
  const w = makeWorld({ produceTimeoutMs: 20 });
  const { quote, proof } = await w.buy();
  w.producer.mode = "hang";

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "what is the risk" } }),
    (err: LatchError) => err.code === "producer_failed",
  );
  assert.equal(await stateOf(w, quote.invoiceId), "refunded");
  assertMoneyIsSound(w, { state: "refunded", delivered: false });
});

test("if delivery fails AND the refund fails, the invoice is flagged, never silently kept", async () => {
  const w = makeWorld();
  const { quote, proof } = await w.buy();
  w.producer.mode = "throw";
  w.facilitator.faults.refundFails = true;

  await assert.rejects(
    w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: "what is the risk" } }),
    (err: LatchError) => err.code === "needs_operator",
  );

  assert.equal(await stateOf(w, quote.invoiceId), "stuck");
  assertMoneyIsSound(w, { state: "stuck", delivered: false });

  const chain = await w.gate.chain();
  const last = chain[chain.length - 1];
  assert.equal(last?.receipt.outcome, "stuck", "a stuck invoice must leave a stuck receipt");
});

test("receipts form an unbroken, signed chain", async () => {
  const w = makeWorld();
  const signer = hmacSigner(SECRET);

  for (const prompt of ["one", "two", "three"]) {
    const { quote, proof } = await w.buy(prompt);
    await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt } });
  }

  const chain = await w.gate.chain();
  assert.equal(chain.length, 3);
  assert.equal(auditChain(chain, signer), -1, "chain did not verify");
});

test("editing a past receipt is detectable", async () => {
  const w = makeWorld();
  const signer = hmacSigner(SECRET);
  for (const prompt of ["one", "two", "three"]) {
    const { quote, proof } = await w.buy(prompt);
    await w.gate.redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt } });
  }

  const chain = await w.gate.chain();
  const tampered = structuredClone(chain);
  tampered[0]!.receipt.chargedMicros = 999_999;

  assert.equal(auditChain(tampered, signer), 0, "tampering with the first receipt went undetected");
});
