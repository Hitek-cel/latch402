/**
 * A narrated walkthrough. Run it with:  node demo.ts
 *
 * No network, no database, no API keys. Everything below is the real gate;
 * only the payment network and the "model" are simulated, so you can watch
 * failures that would be expensive or impossible to stage for real.
 */

import { Latch } from "./src/gate.ts";
import { memoryJournal } from "./src/adapters/memory-journal.ts";
import { ledgerFacilitator, makeProof } from "./src/adapters/ledger-facilitator.ts";
import { auditChain, hmacSigner } from "./src/receipt.ts";
import { formatUsd } from "./src/money.ts";
import { isLatchError } from "./src/errors.ts";
import type { Journal } from "./src/ports.ts";

const BUYER = "agt_scout7";
const SELLER = "0xseller";
const PRICE = 24_000; // $0.024
const SECRET = "demo-secret-long-enough-to-be-accepted";

type Req = { prompt: string };
type Res = { answer: string };

const line = (s = "") => console.log(s);
const rule = (title: string) => {
  line();
  line("─".repeat(74));
  line(`  ${title}`);
  line("─".repeat(74));
};

function makeGate(opts: { journal?: Journal; failProducer?: boolean; onProduce?: () => void } = {}) {
  const journal = opts.journal ?? memoryJournal();
  const facilitator = ledgerFacilitator({ [BUYER]: 1_000_000 });
  let producerCalls = 0;

  const build = (j: Journal) =>
    new Latch<Req, Res>(
      { payTo: SELLER, produceTimeoutMs: 5_000 },
      {
        journal: j,
        facilitator,
        signer: hmacSigner(SECRET),
        producer: {
          async produce(req) {
            producerCalls++;
            opts.onProduce?.();
            if (opts.failProducer) throw new Error("model returned garbage");
            return { answer: `Verdict: fade the open. (re: "${req.prompt}")` };
          },
        },
      },
    );

  return {
    journal,
    facilitator,
    gate: build(journal),
    restart: (j?: Journal) => build(j ?? journal),
    calls: () => producerCalls,
  };
}

function books(f: ReturnType<typeof ledgerFacilitator>, note: string) {
  line(
    `    buyer ${formatUsd(f.balanceOf(BUYER)).padEnd(9)} seller ${formatUsd(
      f.balanceOf(SELLER),
    ).padEnd(9)} ${note}`,
  );
}

// ───────────────────────────────────────────────────────────── 1. happy path

rule("1. A normal paid call");

{
  const w = makeGate();
  books(w.facilitator, "before");

  const { quote, payment } = await w.gate.quote({
    payer: BUYER,
    sku: "brief",
    amountMicros: PRICE,
    request: { prompt: "overnight risk in APAC" },
  });

  line();
  line("  The agent calls with no payment. It gets HTTP 402 and this body:");
  line();
  line(
    JSON.stringify(payment.accepts[0], null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );

  line();
  line("  It signs a payment and retries.");
  const out = await w.gate.redeem({
    invoiceId: quote.invoiceId,
    payer: BUYER,
    proof: makeProof(quote),
    request: { prompt: "overnight risk in APAC" },
  });

  line();
  line(`    -> ${out.result.answer}`);
  line();
  books(w.facilitator, "after");
  line(`    receipt: charged ${formatUsd(out.receipt.receipt.chargedMicros)}, outcome "${out.receipt.receipt.outcome}"`);
  line(`    producer ran ${w.calls()} time(s)`);
}

// ────────────────────────────────────────────────────── 2. the ordering rule

rule("2. The good is never made before the money settles");

{
  const order: string[] = [];
  const w = makeGate({ onProduce: () => order.push("produce") });
  const realSettle = w.facilitator.settle.bind(w.facilitator);
  w.facilitator.settle = async (i) => {
    order.push("settle");
    return realSettle(i);
  };

  const { quote } = await w.gate.quote({
    payer: BUYER,
    sku: "brief",
    amountMicros: PRICE,
    request: { prompt: "x" },
  });
  await w.gate.redeem({
    invoiceId: quote.invoiceId,
    payer: BUYER,
    proof: makeProof(quote),
    request: { prompt: "x" },
  });

  line(`    observed order: ${order.join(" -> ")}`);
  line("    The demo this replaced had it backwards: produce -> settle.");
}

// ───────────────────────────────────────────────────────── 3. the crash case

rule("3. The expensive one: settlement lands, then the process dies");

{
  const w = makeGate();
  books(w.facilitator, "before");

  // A journal that dies just before recording the settlement — i.e. the money
  // moved on the network and our own database never found out.
  let appends = 0;
  const crashy: Journal = {
    ...w.journal,
    async append(entry, expectedSeq) {
      appends++;
      if (appends === 3) throw new Error("PROCESS CRASHED");
      return w.journal.append(entry, expectedSeq);
    },
  };

  const { quote } = await w.gate.quote({
    payer: BUYER,
    sku: "brief",
    amountMicros: PRICE,
    request: { prompt: "who is exposed" },
  });

  await w
    .restart(crashy)
    .redeem({
      invoiceId: quote.invoiceId,
      payer: BUYER,
      proof: makeProof(quote),
      request: { prompt: "who is exposed" },
    })
    .catch(() => undefined);

  const stranded = await w.journal.get(quote.invoiceId);
  line();
  line(`    CRASH. Invoice state on disk: "${stranded?.state}"`);
  books(w.facilitator, "<- the buyer has paid and holds nothing");
  line();
  line("    A naive gate stops here. Its own records say no sale happened,");
  line("    so nothing will ever reconcile this. The money is simply gone.");
  line();
  line("    Restarting and running recovery:");

  const state = await w.restart().recover(quote.invoiceId);

  line();
  line(`    -> recovered to "${state}"`);
  books(w.facilitator, "<- charged once, and the good was produced");
}

// ──────────────────────────────────────────────────────── 4. the sneaky one

rule("4. The attack: money moved, but the network reported failure");

{
  const w = makeGate();
  w.facilitator.faults.settleReportsFailureButMoves = true;

  const { quote } = await w.gate.quote({
    payer: BUYER,
    sku: "brief",
    amountMicros: PRICE,
    request: { prompt: "is this safe" },
  });

  line("    settle() returns { ok: false } — but the funds really moved.");
  line("    A gate that believes the return value records 'nothing happened'");
  line("    on top of a real charge. Latch asks the network instead.");
  line();

  const out = await w.gate.redeem({
    invoiceId: quote.invoiceId,
    payer: BUYER,
    proof: makeProof(quote),
    request: { prompt: "is this safe" },
  });

  line(`    -> outcome "${out.receipt.receipt.outcome}" — the buyer got served.`);
  books(w.facilitator, "");
}

// ─────────────────────────────────────────────────────────── 5. refund path

rule("5. When delivery fails, the money goes back");

{
  const w = makeGate({ failProducer: true });
  books(w.facilitator, "before");

  const { quote } = await w.gate.quote({
    payer: BUYER,
    sku: "brief",
    amountMicros: PRICE,
    request: { prompt: "break it" },
  });

  try {
    await w.gate.redeem({
      invoiceId: quote.invoiceId,
      payer: BUYER,
      proof: makeProof(quote),
      request: { prompt: "break it" },
    });
  } catch (err) {
    if (isLatchError(err)) line(`    -> ${err.code}: ${err.message}`);
  }

  const snap = await w.journal.get(quote.invoiceId);
  line(`    invoice state: "${snap?.state}"`);
  books(w.facilitator, "after — the buyer is whole again");
}

// ──────────────────────────────────────────────────────── 6. paying twice

rule("6. Paying twice for the same thing is impossible");

{
  const w = makeGate();
  const { quote } = await w.gate.quote({
    payer: BUYER,
    sku: "brief",
    amountMicros: PRICE,
    request: { prompt: "again" },
  });
  const args = {
    invoiceId: quote.invoiceId,
    payer: BUYER,
    proof: makeProof(quote),
    request: { prompt: "again" },
  };

  const a = await w.gate.redeem(args);
  const b = await w.gate.redeem(args);
  const c = await w.gate.redeem(args);

  line(`    three identical calls, same answer: ${a.result.answer === c.result.answer}`);
  line(`    replayed from cache: ${[a.replayed, b.replayed, c.replayed].join(", ")}`);
  line(`    producer ran ${w.calls()} time(s), settlements: ${w.facilitator.settlementCount()}`);
  books(w.facilitator, "charged exactly once");
}

// ──────────────────────────────────────────────────────── 7. the paper trail

rule("7. The receipt chain");

{
  const w = makeGate();
  for (const p of ["one", "two", "three"]) {
    const { quote } = await w.gate.quote({ payer: BUYER, sku: "brief", amountMicros: PRICE, request: { prompt: p } });
    await w.gate.redeem({ invoiceId: quote.invoiceId, payer: BUYER, proof: makeProof(quote), request: { prompt: p } });
  }

  const chain = await w.gate.chain();
  const signer = hmacSigner(SECRET);
  line(`    ${chain.length} receipts, chain valid: ${auditChain(chain, signer) === -1}`);

  const tampered = structuredClone(chain);
  tampered[0]!.receipt.chargedMicros = 1;
  line(`    after editing receipt #1: first bad link at index ${auditChain(tampered, signer)}`);
  line("    Neither side can quietly rewrite what was sold.");
}

line();
line("Run the full proof with:  npm test");
line();
