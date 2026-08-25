/**
 * The console's driver.
 *
 * Everything here imports the real library from ../src. Nothing is
 * reimplemented for display: the tape shows actual journal entries, the books
 * show actual facilitator balances, and the verdict is computed from the same
 * rule the test suite asserts. If the gate broke, this page would show it.
 */

import { Latch } from "../src/gate.ts";
import { memoryJournal } from "../src/adapters/memory-journal.ts";
import { ledgerFacilitator, makeProof } from "../src/adapters/ledger-facilitator.ts";
import { auditChain, hmacSigner } from "../src/receipt.ts";
import { formatUsd } from "../src/money.ts";
import { isLatchError } from "../src/errors.ts";
import { STATES, isTerminal, type State } from "../src/states.ts";
import type { Journal, SignedReceipt } from "../src/index.ts";

const BUYER = "agt_scout7";
const SELLER = "0xtollgate";
const PRICE = 24_000;
const START = 1_000_000;
const SECRET = "console-secret-long-enough-to-be-accepted";

type Req = { prompt: string };
type Res = { answer: string };

type Event =
  | { kind: "journal"; state: State; evidence: Record<string, unknown> }
  | { kind: "call"; label: string; detail: string }
  | { kind: "note"; text: string; tone: "plain" | "alarm" | "good" }
  | { kind: "books"; buyer: number; seller: number }
  | { kind: "result"; text: string }
  | { kind: "error"; code: string; message: string };

type Env = {
  gate: Latch<Req, Res>;
  restart: (j?: Journal) => Latch<Req, Res>;
  journal: ReturnType<typeof memoryJournal>;
  /** The journal the gate actually writes through, wrapped so the tape can watch it. */
  observed: Journal;
  facilitator: ReturnType<typeof ledgerFacilitator>;
  events: Event[];
  produced: number;
  buy: (prompt?: string) => Promise<{ invoiceId: string; proof: string; request: Req }>;
  snapBooks: () => void;
};

function makeEnv(opts: { failProducer?: boolean } = {}): Env {
  const journal = memoryJournal();
  const facilitator = ledgerFacilitator({ [BUYER]: START });
  const events: Event[] = [];
  const env = { produced: 0 } as Env;

  // Observe the real journal rather than instrumenting the gate.
  const observed: Journal = {
    ...journal,
    async append(entry, expectedSeq) {
      const written = await journal.append(entry, expectedSeq);
      events.push({ kind: "journal", state: written.state, evidence: written.evidence });
      return written;
    },
  };

  const realSettle = facilitator.settle.bind(facilitator);
  facilitator.settle = async (intent) => {
    const out = await realSettle(intent).catch((err: unknown) => {
      events.push({ kind: "call", label: "settle()", detail: "threw — outcome unknown" });
      throw err;
    });
    events.push({
      kind: "call",
      label: "settle()",
      detail: out.ok ? `ok, ${formatUsd(out.amountMicros)}` : `reported "${out.reason}"`,
    });
    return out;
  };

  const realStatus = facilitator.statusOf.bind(facilitator);
  facilitator.statusOf = async (key) => {
    const out = await realStatus(key);
    events.push({ kind: "call", label: "statusOf()", detail: `network says "${out.state}"` });
    return out;
  };

  const realRefund = facilitator.refund.bind(facilitator);
  facilitator.refund = async (intent) => {
    const out = await realRefund(intent);
    events.push({
      kind: "call",
      label: "refund()",
      detail: out.ok ? "money returned" : `failed — ${out.reason}`,
    });
    return out;
  };

  const build = (j: Journal) =>
    new Latch<Req, Res>(
      { payTo: SELLER, produceTimeoutMs: 4_000, quoteTtlMs: 600_000 },
      {
        journal: j,
        facilitator,
        signer: hmacSigner(SECRET),
        producer: {
          async produce(req) {
            env.produced++;
            events.push({ kind: "call", label: "produce()", detail: "spending compute" });
            if (opts.failProducer) throw new Error("model returned garbage");
            return { answer: `Verdict: fade the open bounce. (re: "${req.prompt}")` };
          },
        },
      },
    );

  env.journal = journal;
  env.observed = observed;
  env.facilitator = facilitator;
  env.events = events;
  env.gate = build(observed);
  env.restart = (j) => build(j ?? observed);
  env.snapBooks = () =>
    events.push({
      kind: "books",
      buyer: facilitator.balanceOf(BUYER),
      seller: facilitator.balanceOf(SELLER),
    });
  env.buy = async (prompt = "overnight risk in APAC") => {
    const { quote } = await env.gate.quote({
      payer: BUYER,
      sku: "brief",
      amountMicros: PRICE,
      request: { prompt },
    });
    return { invoiceId: quote.invoiceId, proof: makeProof(quote), request: { prompt } };
  };
  return env;
}

/** A journal that dies at a chosen append — the process, not the app, failing. */
function crashingJournal(inner: Journal, atAppend: number): Journal {
  let n = 0;
  return {
    ...inner,
    async append(entry, expectedSeq) {
      n++;
      if (n === atAppend) throw new Error("PROCESS CRASHED");
      return inner.append(entry, expectedSeq);
    },
  };
}

async function attempt(env: Env, fn: () => Promise<{ result: Res }>) {
  try {
    const out = await fn();
    env.events.push({ kind: "result", text: out.result.answer });
  } catch (err) {
    if (isLatchError(err)) {
      env.events.push({ kind: "error", code: err.code, message: err.message });
    } else {
      env.events.push({ kind: "error", code: "crash", message: String(err) });
    }
  }
}

// ─────────────────────────────────────────────────────────────── scenarios

type Scenario = {
  id: string;
  group: string;
  title: string;
  blurb: string;
  run: () => Promise<Env>;
};

const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    group: "Normal",
    title: "A paid call",
    blurb: "An agent gets 402, pays, and is served. The baseline everything else is measured against.",
    async run() {
      const env = makeEnv();
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      env.events.push({ kind: "note", text: "402 returned. The agent signs and retries.", tone: "plain" });
      await attempt(env, () => env.gate.redeem({ invoiceId, payer: BUYER, proof, request }));
      env.snapBooks();
      return env;
    },
  },
  {
    id: "twice",
    group: "Normal",
    title: "Paying twice over",
    blurb: "The same request sent three times. A retry must return the first answer, not buy a second one.",
    async run() {
      const env = makeEnv();
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      const args = { invoiceId, payer: BUYER, proof, request };
      await attempt(env, () => env.gate.redeem(args));
      env.events.push({ kind: "note", text: "The caller times out and retries, twice.", tone: "plain" });
      await attempt(env, () => env.gate.redeem(args));
      await attempt(env, () => env.gate.redeem(args));
      env.snapBooks();
      return env;
    },
  },
  {
    id: "crash-settled",
    group: "Interruption",
    title: "Crash after the money moves",
    blurb: "Settlement lands, then the process dies before recording it. The case that loses money for good in a naive gate.",
    async run() {
      const env = makeEnv();
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      const crashy = env.restart(crashingJournal(env.observed, 3));
      await crashy.redeem({ invoiceId, payer: BUYER, proof, request }).catch(() => undefined);
      env.events.push({ kind: "note", text: "PROCESS CRASHED. The buyer has paid and holds nothing.", tone: "alarm" });
      env.snapBooks();
      env.events.push({ kind: "note", text: "Restarting. Recovery asks the network what really happened.", tone: "plain" });
      await env.restart().recover(invoiceId);
      env.snapBooks();
      return env;
    },
  },
  {
    id: "crash-early",
    group: "Interruption",
    title: "Crash before paying",
    blurb: "The process dies mid-verification, before any money moves. Unwinding is free and always correct.",
    async run() {
      const env = makeEnv();
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      const crashy = env.restart(crashingJournal(env.observed, 2));
      await crashy.redeem({ invoiceId, payer: BUYER, proof, request }).catch(() => undefined);
      env.events.push({ kind: "note", text: "PROCESS CRASHED before settlement.", tone: "alarm" });
      env.events.push({ kind: "note", text: "Restarting and recovering.", tone: "plain" });
      await env.restart().recover(invoiceId);
      env.snapBooks();
      return env;
    },
  },
  {
    id: "divergence",
    group: "Attack",
    title: "Settlement divergence",
    blurb: "The rail moves the money and reports failure. Believing the return value would record a charge as though it never happened.",
    async run() {
      const env = makeEnv();
      env.facilitator.faults.settleReportsFailureButMoves = true;
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      await attempt(env, () => env.gate.redeem({ invoiceId, payer: BUYER, proof, request }));
      env.snapBooks();
      return env;
    },
  },
  {
    id: "free",
    group: "Attack",
    title: "Free shopping",
    blurb: "A caller with an empty wallet. Compute must never be spent before the money is real.",
    async run() {
      const env = makeEnv();
      env.facilitator.faults.settleFails = true;
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      await attempt(env, () => env.gate.redeem({ invoiceId, payer: BUYER, proof, request }));
      env.snapBooks();
      return env;
    },
  },
  {
    id: "replay",
    group: "Attack",
    title: "Replaying a used proof",
    blurb: "A rail that hands back the same nonce every time. The gate must not depend on the rail being correct.",
    async run() {
      const env = makeEnv();
      env.facilitator.verify = async (_p, expected) => ({
        ok: true,
        payer: expected.payer,
        amountMicros: expected.amountMicros,
        nonce: "reused-nonce",
      });
      env.snapBooks();
      const first = await env.buy("first question");
      await attempt(env, () => env.gate.redeem({ ...first, payer: BUYER }));
      env.events.push({ kind: "note", text: "The same proof is presented against a fresh invoice.", tone: "plain" });
      const second = await env.buy("second question");
      await attempt(env, () => env.gate.redeem({ ...second, payer: BUYER }));
      env.snapBooks();
      return env;
    },
  },
  {
    id: "refund",
    group: "Failure",
    title: "Delivery fails",
    blurb: "The money settled, then production broke. Every committed step needs a compensating one.",
    async run() {
      const env = makeEnv({ failProducer: true });
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      await attempt(env, () => env.gate.redeem({ invoiceId, payer: BUYER, proof, request }));
      env.snapBooks();
      return env;
    },
  },
  {
    id: "stuck",
    group: "Failure",
    title: "The refund fails too",
    blurb: "Undeliverable and un-refundable. The gate holds the money visibly and pages a human rather than keeping it quietly.",
    async run() {
      const env = makeEnv({ failProducer: true });
      env.facilitator.faults.refundFails = true;
      env.snapBooks();
      const { invoiceId, proof, request } = await env.buy();
      await attempt(env, () => env.gate.redeem({ invoiceId, payer: BUYER, proof, request }));
      env.snapBooks();
      return env;
    },
  },
];

// ────────────────────────────────────────────────────────────────── render

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const tape = $("#tape");
const pipeline = $("#pipeline");
const buyerCell = $("#buyer");
const sellerCell = $("#seller");
const verdict = $("#verdict");
const verdictNote = $("#verdict-note");
const chainEl = $("#chain");
const blurbEl = $("#blurb");
const scenarioTitle = $("#scenario-title");

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));

function buildPipeline() {
  pipeline.innerHTML = "";
  for (const s of STATES) {
    const row = document.createElement("div");
    row.className = "node";
    row.dataset.state = s;
    row.innerHTML = `<span class="dot"></span><span class="name">${s}</span>`;
    if (isTerminal(s)) row.classList.add("terminal");
    pipeline.appendChild(row);
  }
}

function litState(s: State | null) {
  for (const node of pipeline.querySelectorAll<HTMLElement>(".node")) {
    node.classList.toggle("on", node.dataset.state === s);
  }
}

function money(el: HTMLElement, micros: number) {
  el.textContent = formatUsd(micros);
}

function printLine(html: string, cls = "") {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.innerHTML = html;
  tape.appendChild(div);
  tape.scrollTop = tape.scrollHeight;
  return div;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function evidenceOf(ev: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (k === "idempotencyKey" || k === "resultHash" || k === "requestHash") continue;
    if (typeof v === "object") continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.slice(0, 2).join("  ");
}

async function renderChain(env: Env) {
  const chain = await env.gate.chain();
  const ok = auditChain(chain, hmacSigner(SECRET)) === -1;
  chainEl.innerHTML = "";
  if (chain.length === 0) {
    chainEl.innerHTML = `<p class="muted">No receipts yet.</p>`;
    return;
  }
  for (const link of chain) {
    const r: SignedReceipt["receipt"] = link.receipt;
    const el = document.createElement("div");
    el.className = `receipt r-${r.outcome}`;
    el.innerHTML = `
      <div class="r-head"><span class="r-outcome">${r.outcome}</span>
      <span class="r-amount">${formatUsd(r.chargedMicros)}</span></div>
      <div class="r-hash">prev ${esc(r.prev.slice(0, 16))}…</div>`;
    chainEl.appendChild(el);
  }
  const foot = document.createElement("p");
  foot.className = ok ? "chain-ok" : "chain-bad";
  foot.textContent = ok ? `Chain intact — ${chain.length} signed receipt(s)` : "Chain broken";
  chainEl.appendChild(foot);
}

/** The invariant, computed the same way the test suite computes it. */
function renderVerdict(env: Env, finalState: State | null) {
  const buyer = env.facilitator.balanceOf(BUYER);
  const seller = env.facilitator.balanceOf(SELLER);
  const conserved = buyer + seller === START;
  const charged = START - buyer;

  let holds = conserved;
  let note = "";

  if (finalState === "delivered") {
    holds = holds && charged === PRICE && env.produced > 0;
    note = `Charged ${formatUsd(charged)} once, and the good was delivered.`;
  } else if (finalState === "void" || finalState === "refunded") {
    holds = holds && charged === 0;
    note =
      finalState === "void"
        ? "Nothing moved. The caller was never charged."
        : "Charged, then refunded. The caller is whole again.";
  } else if (finalState === "stuck") {
    holds = holds && charged === PRICE;
    note = "Money held and flagged for an operator. Never silently kept.";
  } else {
    note = "In flight — no terminal position yet.";
  }

  // "stuck" satisfies the invariant — the money is accounted for — but it is
  // not a clean outcome, and a green stamp would say the wrong thing.
  const tone = !holds ? "broken" : finalState === "stuck" ? "flagged" : "holds";
  verdict.className = `stamp ${tone}`;
  verdict.textContent =
    tone === "broken" ? "invariant broken" : tone === "flagged" ? "held for operator" : "invariant holds";
  verdictNote.textContent = note;
}

async function play(env: Env) {
  tape.innerHTML = "";
  litState(null);
  printLine(`<span class="t-seq">·</span><span class="t-body">opening invoice</span>`, "meta");

  let last: State | null = null;
  for (const ev of env.events) {
    await wait(230);
    if (ev.kind === "journal") {
      last = ev.state;
      litState(ev.state);
      const detail = evidenceOf(ev.evidence);
      printLine(
        `<span class="t-seq">▸</span><span class="t-state s-${ev.state}">${ev.state}</span>` +
          `<span class="t-detail">${esc(detail)}</span>`,
        "journal",
      );
    } else if (ev.kind === "call") {
      printLine(
        `<span class="t-seq">·</span><span class="t-call">${esc(ev.label)}</span>` +
          `<span class="t-detail">${esc(ev.detail)}</span>`,
        "call",
      );
    } else if (ev.kind === "books") {
      money(buyerCell, ev.buyer);
      money(sellerCell, ev.seller);
      buyerCell.parentElement?.classList.add("flash");
      sellerCell.parentElement?.classList.add("flash");
      setTimeout(() => {
        buyerCell.parentElement?.classList.remove("flash");
        sellerCell.parentElement?.classList.remove("flash");
      }, 420);
    } else if (ev.kind === "note") {
      printLine(`<span class="t-seq">·</span><span class="t-body">${esc(ev.text)}</span>`, `note ${ev.tone}`);
    } else if (ev.kind === "result") {
      printLine(`<span class="t-seq">✓</span><span class="t-body">${esc(ev.text)}</span>`, "served");
    } else if (ev.kind === "error") {
      printLine(
        `<span class="t-seq">✕</span><span class="t-code">${esc(ev.code)}</span>` +
          `<span class="t-detail">${esc(ev.message)}</span>`,
        "refused",
      );
    }
  }

  await renderChain(env);
  renderVerdict(env, last);
}

let running = false;

async function runScenario(s: Scenario, button: HTMLElement) {
  if (running) return;
  running = true;
  for (const b of document.querySelectorAll(".scenario")) b.classList.remove("active");
  button.classList.add("active");
  scenarioTitle.textContent = s.title;
  blurbEl.textContent = s.blurb;
  verdict.className = "stamp pending";
  verdict.textContent = "running";
  verdictNote.textContent = "";
  chainEl.innerHTML = "";

  const env = await s.run();
  await play(env);
  running = false;
}

function buildControls() {
  const host = $("#scenarios");
  const groups = [...new Set(SCENARIOS.map((s) => s.group))];
  for (const g of groups) {
    const h = document.createElement("h3");
    h.className = "group";
    h.textContent = g;
    host.appendChild(h);
    for (const s of SCENARIOS.filter((x) => x.group === g)) {
      const b = document.createElement("button");
      b.className = "scenario";
      b.type = "button";
      b.innerHTML = `<span class="s-title">${s.title}</span>`;
      b.addEventListener("click", () => void runScenario(s, b));
      host.appendChild(b);
    }
  }
}

buildPipeline();
buildControls();
money(buyerCell, START);
money(sellerCell, 0);
void runScenario(SCENARIOS[0]!, document.querySelector<HTMLElement>(".scenario")!);
