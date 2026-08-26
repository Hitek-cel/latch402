import test from "node:test";
import assert from "node:assert/strict";
import { auditChain, hmacSigner } from "../src/receipt.ts";
import type { State } from "../src/states.ts";
import { assertMoneyIsSound, crashingJournal, makeWorld, PAYER, SECRET, stateOf } from "./harness.ts";

/**
 * Crash injection.
 *
 * A payment gate is only as good as its worst interruption. These tests kill
 * the process at every single journal write on the happy path — both after the
 * write became durable and before it did — restart, run recovery, and then
 * check the money.
 *
 * The one that matters most is "before write 3": settlement succeeded on the
 * network and the process died before recording it. Naive gates lose that
 * money permanently, because on restart nothing in their own database says a
 * charge ever happened.
 */

const PROMPT = "what is the risk";

async function crashAt(point: number, when: "before" | "after") {
  const w = makeWorld();
  const crashy = w.restart(crashingJournal(w.journal, { atAppend: point, when }));
  const { quote, proof } = await w.buy(PROMPT);

  // The process dies somewhere in here. What it threw is irrelevant.
  await crashy
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } })
    .catch(() => undefined);

  return { w, invoiceId: quote.invoiceId };
}

const CASES: { point: number; when: "before" | "after"; expect: State; label: string }[] = [
  { point: 1, when: "after", expect: "void", label: "claimed the invoice, never verified" },
  { point: 2, when: "after", expect: "void", label: "logged intent to settle, never settled" },
  { point: 3, when: "after", expect: "delivered", label: "settled and logged it, never produced" },
  { point: 4, when: "after", expect: "delivered", label: "began producing, never finished" },
  { point: 5, when: "after", expect: "delivered", label: "produced, died before the receipt" },
  { point: 2, when: "before", expect: "void", label: "verified, never logged the settle intent" },
  { point: 3, when: "before", expect: "delivered", label: "MONEY MOVED but was never logged" },
  { point: 4, when: "before", expect: "delivered", label: "settled, died before producing" },
  { point: 5, when: "before", expect: "delivered", label: "produced, died before recording it" },
];

for (const c of CASES) {
  test(`crash ${c.when} journal write ${c.point}: ${c.label}`, async () => {
    const { w, invoiceId } = await crashAt(c.point, c.when);

    const recovered = await w.restart().recover(invoiceId);

    assert.equal(recovered, c.expect, `recovered to ${recovered}, expected ${c.expect}`);
    assert.equal(await stateOf(w, invoiceId), c.expect);
    assertMoneyIsSound(w, { state: c.expect, delivered: c.expect === "delivered" });

    // Every finished invoice leaves exactly one receipt, and the chain holds.
    const chain = await w.restart().chain();
    const mine = chain.filter((l) => l.receipt.invoiceId === invoiceId);
    assert.equal(mine.length, 1, `expected one receipt, found ${mine.length}`);
    assert.equal(auditChain(chain, hmacSigner(SECRET)), -1);
  });
}

test("crash before the first write leaves an untouched quote, which later expires cleanly", async () => {
  const w = makeWorld({ quoteTtlMs: 1000 });
  const crashy = w.restart(crashingJournal(w.journal, { atAppend: 1, when: "before" }));
  const { quote, proof } = await w.buy(PROMPT);

  await crashy
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } })
    .catch(() => undefined);

  // Nothing happened at all, so the invoice is still payable.
  assert.equal(await stateOf(w, quote.invoiceId), "quoted");
  assert.equal(w.producer.calls, 0);

  w.clock.advance(1001);
  assert.equal(await w.restart().recover(quote.invoiceId), "void");
  assertMoneyIsSound(w, { state: "void", delivered: false });
});

test("after a crash the caller retries and gets the good exactly once", async () => {
  // Crash right after settlement lands: the buyer has paid but holds nothing.
  const { w, invoiceId } = await crashAt(3, "after");
  const { quote } = await w.buy(PROMPT); // unrelated second quote, ignored
  void quote;

  const gate = w.restart();
  const proof = JSON.stringify({
    invoiceId,
    payer: PAYER,
    amountMicros: 24_000,
    nonce: "irrelevant-already-consumed",
  });

  const out = await gate.redeem({ invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } });

  assert.equal(out.result.answer, `brief for: ${PROMPT}`);
  assert.equal(w.facilitator.settlementCount(), 1, "the retry settled a second time");
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("the background sweep finishes abandoned invoices without anyone retrying", async () => {
  const w = makeWorld();
  const crashy = w.restart(crashingJournal(w.journal, { atAppend: 3, when: "before" }));
  const { quote, proof } = await w.buy(PROMPT);

  await crashy
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } })
    .catch(() => undefined);

  // Money left the buyer; the invoice is stranded mid-flight.
  assert.equal(await stateOf(w, quote.invoiceId), "settling");

  w.clock.advance(60_000);
  const swept = await w.restart().sweep(30_000);

  assert.deepEqual(swept, [{ invoiceId: quote.invoiceId, state: "delivered" }]);
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});

test("a producer that fails on every recovery attempt ends in a refund, not a held balance", async () => {
  const w = makeWorld({ maxProduceAttempts: 2 });
  const { quote, proof } = await w.buy(PROMPT);
  w.producer.mode = "throw";

  await w.gate
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } })
    .catch(() => undefined);

  assert.equal(await stateOf(w, quote.invoiceId), "refunded");
  assertMoneyIsSound(w, { state: "refunded", delivered: false });
});

test("a producer that crashes the process on every attempt is bounded, then refunded", async () => {
  // The liveness case: not a producer that throws (that refunds immediately),
  // but one that takes the whole process down mid-produce, leaving the journal
  // in `producing`. Each recovery must burn an attempt; the cap must
  // eventually refund rather than retry forever while holding the money.
  const w = makeWorld({ maxProduceAttempts: 2 });
  const { quote, proof } = await w.buy(PROMPT);

  // Attempt 1: dies after producing is journaled, before delivered lands.
  const crash1 = w.restart(crashingJournal(w.journal, { atAppend: 5, when: "before" }));
  await crash1
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } })
    .catch(() => undefined);
  assert.equal(await stateOf(w, quote.invoiceId), "producing");

  // Attempt 2 via recovery: re-enters producing (append 1), dies before
  // delivered (append 2). The re-entry entry is what makes this attempt count.
  const crash2 = w.restart(crashingJournal(w.journal, { atAppend: 2, when: "before" }));
  await crash2.recover(quote.invoiceId).catch(() => undefined);
  assert.equal(await stateOf(w, quote.invoiceId), "producing");

  // Third recovery: both attempts are on the record, so the cap fires.
  const final = await w.restart().recover(quote.invoiceId);

  assert.equal(final, "refunded", "the attempt cap never fired across crashes");
  assertMoneyIsSound(w, { state: "refunded", delivered: false });
});

test("the receipt attests the result the caller actually gets, across a re-produce", async () => {
  // Crash after the good is durably stored but before `delivered` is
  // journaled. Recovery re-runs the producer, which returns something
  // different this time. First-write-wins means the caller gets the FIRST
  // result — so the receipt's resultHash must commit to that one, not to the
  // second attempt's output.
  const w = makeWorld();
  let call = 0;
  w.producer.producer.produce = async () => ({ answer: `result-of-attempt-${++call}` });

  const { quote, proof } = await w.buy(PROMPT);
  const crashy = w.restart(crashingJournal(w.journal, { atAppend: 5, when: "before" }));
  await crashy
    .redeem({ invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT } })
    .catch(() => undefined);

  assert.equal(await w.restart().recover(quote.invoiceId), "delivered");
  assert.equal(call, 2, "recovery should have re-run the producer");

  const gate = w.restart();
  const out = await gate.redeem({
    invoiceId: quote.invoiceId, payer: PAYER, proof, request: { prompt: PROMPT },
  });
  assert.equal(out.result.answer, "result-of-attempt-1", "first durable write must win");

  const { hashRequest } = await import("../src/ids.ts");
  assert.equal(
    out.receipt.receipt.resultHash,
    hashRequest(out.result),
    "receipt attests a different result than the one delivered",
  );
  assertMoneyIsSound(w, { state: "delivered", delivered: true });
});
