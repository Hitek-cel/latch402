import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
} from "@x402/extensions/payment-identifier";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { memoryJournal } from "../src/adapters/memory-journal.ts";
import { migrate, postgresJournal, type SqlClient, type SqlExecutor } from "../src/adapters/postgres-journal.ts";
import { ledgerFacilitator } from "../src/adapters/ledger-facilitator.ts";
import { Latch } from "../src/gate.ts";
import { auditChain, hmacSigner } from "../src/receipt.ts";
import type { Journal } from "../src/ports.ts";
import type { State } from "../src/states.ts";
import { eip3009Oracle, latchX402, type SettlementOracle, type X402Alarm } from "../src/x402/index.ts";

/**
 * The bridge, driven by the official x402 SDK on both sides: `@x402/fetch`
 * signs real EIP-3009 payments, `@x402/hono` serves them, and the only fake is
 * the chain. Nothing here calls a Latch hook directly — every assertion is
 * about what the SDK does once the hooks are installed, because that is the
 * only behaviour a seller ever gets.
 */

// Several tests break things on purpose, and the SDK and Hono log what broke.
// Those lines are expected; they are hidden unless LATCH_TEST_VERBOSE is set.
if (!process.env.LATCH_TEST_VERBOSE) {
  const { warn, error } = console;
  const expected = (args: unknown[]) =>
    (typeof args[0] === "string" && args[0].startsWith("[x402]")) ||
    (args[0] instanceof Error && args[0].message === "handler exploded");
  console.warn = (...args: unknown[]) => (expected(args) ? undefined : warn(...args));
  console.error = (...args: unknown[]) => (expected(args) ? undefined : error(...args));
}

const NETWORK = "eip155:84532";
const URL_ = "http://local.test/buy";
const SELLER = "0x000000000000000000000000000000000000dEaD";
const SECRET = "x402-bridge-test-secret-long-enough";
const STALE = 120_000;

type Fault =
  | "none"
  | "lands_then_reports_failure"
  | "lands_then_throws"
  | "fails_clean"
  | "lands_then_hangs"
  | "hangs_without_landing";

/** The one fake: a token contract that remembers which authorizations were used. */
function makeChain() {
  const used = new Set<string>();
  const key = (payer: string, nonce: string) => `${payer.toLowerCase()}:${nonce.toLowerCase()}`;
  return {
    use: (payer: string, nonce: string) => used.add(key(payer, nonce)),
    has: (payer: string, nonce: string) => used.has(key(payer, nonce)),
    get size() {
      return used.size;
    },
  };
}
type Chain = ReturnType<typeof makeChain>;

function makeClock() {
  return {
    t: Date.now(),
    now() {
      return this.t;
    },
    advance(ms: number) {
      this.t += ms;
    },
  };
}
type TestClock = ReturnType<typeof makeClock>;

type Auth = { from: string; nonce: string; validBefore: string };
const authOf = (payload: { payload: Record<string, unknown> }) => payload.payload.authorization as Auth;

/** One server process: its own SDK objects, handler and bridge, over a journal and chain that outlive it. */
function instance(shared: { journal: Journal; chain: Chain; clock: TestClock }, opts: { oracle?: boolean; flow?: string; pid?: boolean; token?: boolean; replayWindowMs?: number; schemes?: string[] } = {}) {
  const { journal, chain, clock } = shared;
  const calls = { verify: 0, settle: 0 };
  const control = { fault: "none" as Fault, handlerRuns: 0, hold: undefined as Promise<void> | undefined };
  const alarms: X402Alarm[] = [];

  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
    async verify(payload) {
      calls.verify++;
      const auth = authOf(payload);
      if (chain.has(auth.from, auth.nonce)) return { isValid: false, invalidReason: "nonce_already_used" };
      if (clock.now() >= Number(auth.validBefore) * 1000) return { isValid: false, invalidReason: "authorization_expired" };
      return { isValid: true, payer: auth.from };
    },
    async settle(payload, requirements) {
      calls.settle++;
      const auth = authOf(payload);
      const failed = (errorReason: string) => ({ success: false, errorReason, transaction: "", network: requirements.network });
      if (chain.has(auth.from, auth.nonce)) return failed("nonce_already_used");
      if (control.fault === "fails_clean") return failed("insufficient_funds");
      if (control.fault === "hangs_without_landing") return new Promise(() => {});
      chain.use(auth.from, auth.nonce);
      if (control.fault === "lands_then_reports_failure") return failed("unexpected_settle_error");
      if (control.fault === "lands_then_throws") throw new Error("facilitator timed out");
      if (control.fault === "lands_then_hangs") return new Promise(() => {});
      return { success: true, transaction: `0xtx${chain.size}`, network: requirements.network, payer: auth.from };
    },
  };

  const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  const oracle: SettlementOracle = async (probe) => (chain.has(probe.payer, probe.nonce) ? "settled" : "unsettled");
  const latch = latchX402(server, {
    journal,
    clock,
    signer: hmacSigner(SECRET),
    staleMs: STALE,
    onAlarm: (a) => alarms.push(a),
    ...(opts.oracle === false ? {} : { oracle }),
    ...(opts.replayWindowMs !== undefined ? { replayWindowMs: opts.replayWindowMs } : {}),
    ...(opts.schemes ? { schemes: opts.schemes } : {}),
  });

  const app = new Hono();
  app.use(
    paymentMiddleware(
      {
        "POST /buy": {
          accepts: {
            scheme: "exact",
            price: "$0.01",
            network: NETWORK,
            payTo: SELLER,
            ...(opts.flow ? { extra: { paymentFlow: opts.flow } } : {}),
          },
          description: "one answer",
          extensions: {
            ...(opts.token === false ? {} : latch.declare()),
            ...(opts.pid ? { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension() } : {}),
          },
        },
      },
      server,
    ),
  );
  app.post("/buy", async (c) => {
    control.handlerRuns++;
    const run = control.handlerRuns;
    const body = (await c.req.json().catch(() => ({}))) as { q?: string; fail?: boolean; boom?: boolean; plain?: boolean };
    if (control.hold) await control.hold;
    if (body.boom) throw new Error("handler exploded");
    if (body.fail) return c.json({ error: "could not produce" }, 500);
    if (body.plain) return c.text("just text");
    return c.json({ answer: `answer to ${body.q ?? "?"}`, run });
  });

  return { app, latch, calls, control, alarms };
}
type Instance = ReturnType<typeof instance>;

function world(opts: Parameters<typeof instance>[1] = {}, journal: Journal = memoryJournal()) {
  const shared = { journal, chain: makeChain(), clock: makeClock() };
  const a = instance(shared, opts);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  return { ...shared, ...a, a, client, boot: () => instance(shared, opts) };
}
type World = ReturnType<typeof world>;

const post = (app: Instance["app"], body: unknown, header?: string, url = URL_) =>
  Promise.resolve(
    app.request(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(header ? { "payment-signature": header } : {}) },
        body: JSON.stringify(body),
      }),
    ),
  );

/** Ask for the price, sign it with the official client, and return the header a retry would resend. */
async function sign(w: Pick<World, "app" | "client">, body: unknown, pid?: string): Promise<string> {
  const unpaid = await post(w.app, body);
  assert.equal(unpaid.status, 402);
  const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
  const payload = await w.client.createPaymentPayload(required);
  if (pid) {
    payload.extensions = appendPaymentIdentifierToExtensions(structuredClone(required.extensions ?? {}), pid);
  }
  return encodePaymentSignatureHeader(payload);
}

const reasonOf = (res: Response): string | undefined =>
  decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "").error;

async function states(journal: Journal, w: { latch: Instance["latch"] }): Promise<State[]> {
  void w;
  const all = (journal as ReturnType<typeof memoryJournal>).snapshotAll();
  return all.map((s) => s.state);
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// ── the done-test ─────────────────────────────────────────────────────────

test("x402: the official client pays an official server through Latch — 402, pay, 200", async () => {
  const w = world();
  const pay = wrapFetchWithPayment((input, init) => Promise.resolve(w.app.request(new Request(input as string, init))), w.client);

  const res = await pay(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "life" }) });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: "answer to life", run: 1 });
  const settled = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, "0xtx1");

  assert.deepEqual(await states(w.journal, w), ["delivered"]);
  assert.deepEqual(w.calls, { verify: 1, settle: 1 });
  assert.equal(w.chain.size, 1);

  const chain = await w.latch.chain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0]?.receipt.outcome, "delivered");
  assert.equal(chain[0]?.receipt.chargedMicros, 10_000);
  assert.equal(chain[0]?.receipt.settlementRef, "0xtx1");
  assert.equal(auditChain(chain, hmacSigner(SECRET)), -1);
});

// ── replay: the lost response ─────────────────────────────────────────────

test("x402: a retry of a settled payment gets the stored response back, not a second charge", async () => {
  const w = world();
  const header = await sign(w, { q: "a" });
  const first = await post(w.app, { q: "a" }, header);
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  // The response was lost on the way; the client sends the same payment again.
  const again = await post(w.app, { q: "a" }, header);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), firstBody);
  assert.equal(
    decodePaymentResponseHeader(again.headers.get("payment-response") ?? "").transaction,
    "0xtx1",
    "the replay carries the original settlement",
  );

  assert.equal(w.control.handlerRuns, 1, "the handler must not run twice");
  assert.deepEqual(w.calls, { verify: 1, settle: 1 }, "the facilitator must not be asked again");
  assert.equal(w.chain.size, 1);
});

test("x402: a settled payment cannot be replayed against a different request", async () => {
  const w = world();
  const header = await sign(w, { q: "a" });
  assert.equal((await post(w.app, { q: "a" }, header)).status, 200);

  const other = await post(w.app, { q: "a" }, header, `${URL_}?variant=2`);
  assert.equal(other.status, 402);
  assert.equal(reasonOf(other), "payment_already_used");
  assert.equal(w.control.handlerRuns, 1);
});

test("x402: replay closes with its window, and can be turned off", async () => {
  const w = world();
  const header = await sign(w, { q: "a" });
  assert.equal((await post(w.app, { q: "a" }, header)).status, 200);
  w.clock.advance(600_001);
  const late = await post(w.app, { q: "a" }, header);
  assert.equal(late.status, 402);
  assert.equal(reasonOf(late), "payment_already_used");

  const off = world({ replayWindowMs: 0 });
  const h2 = await sign(off, { q: "a" });
  assert.equal((await post(off.app, { q: "a" }, h2)).status, 200);
  assert.equal(reasonOf(await post(off.app, { q: "a" }, h2)), "payment_already_used");
  assert.equal(off.control.handlerRuns, 1);
});

test("x402: a response that cannot be replayed is still settled once and never re-run", async () => {
  const w = world();
  const header = await sign(w, { plain: true });
  const first = await post(w.app, { plain: true }, header);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "just text");

  const again = await post(w.app, { plain: true }, header);
  assert.equal(again.status, 402);
  assert.equal(reasonOf(again), "payment_already_used");
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.chain.size, 1);
});

// ── replay is not a free copy ─────────────────────────────────────────────

test("x402: a settled payment rebuilt from public chain data cannot collect the response", async () => {
  const w = world();
  const header = await sign(w, { q: "secret" });
  assert.equal((await post(w.app, { q: "secret" }, header)).status, 200);

  // Everything in a settled EIP-3009 payment is in the settlement transaction's
  // calldata. An observer can rebuild all of it — except the replay token.
  const rebuilt = decodePaymentSignatureHeader(header);
  const forgeries = [
    { ...rebuilt, extensions: {} },
    { ...rebuilt, extensions: { latch: { info: { version: 1, token: "0".repeat(32) } } } },
    { ...rebuilt, extensions: { latch: { info: { version: 1 } } } },
  ];
  for (const forged of forgeries) {
    const res = await post(w.app, { q: "secret" }, encodePaymentSignatureHeader(forged));
    assert.equal(res.status, 402);
    assert.equal(reasonOf(res), "payment_already_used");
    assert.doesNotMatch(await res.text(), /answer to secret/);
  }
  assert.equal(w.control.handlerRuns, 1);

  // The buyer, who holds the token, still can.
  assert.equal((await post(w.app, { q: "secret" }, header)).status, 200);
});

test("x402: on a route that does not declare the latch extension, a settled payment is simply spent", async () => {
  const w = world({ token: false });
  const header = await sign(w, { q: "a" });
  assert.equal((await post(w.app, { q: "a" }, header)).status, 200);
  const again = await post(w.app, { q: "a" }, header);
  assert.equal(again.status, 402);
  assert.equal(reasonOf(again), "payment_already_used");
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.chain.size, 1);
});

// ── concurrency ───────────────────────────────────────────────────────────

test("x402: three concurrent copies of one payment run the handler once and settle once", async () => {
  const w = world();
  const header = await sign(w, { q: "a" });

  let release!: () => void;
  w.control.hold = new Promise<void>((r) => (release = r));
  const copies = [post(w.app, { q: "a" }, header), post(w.app, { q: "a" }, header), post(w.app, { q: "a" }, header)];
  for (let i = 0; i < 20; i++) await tick();
  release();
  const results = await Promise.all(copies);

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 402, 402]);
  for (const r of results) if (r.status === 402) assert.equal(reasonOf(r), "payment_in_progress");
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.calls.settle, 1);
  assert.equal(w.chain.size, 1);
  assert.deepEqual(await states(w.journal, w), ["delivered"]);
});

// ── failure before any money moves ────────────────────────────────────────

test("x402: a handler that fails or throws charges nothing and closes the payment", async () => {
  for (const body of [{ fail: true }, { boom: true }]) {
    const w = world();
    const header = await sign(w, body);
    const res = await post(w.app, body, header);
    assert.equal(res.status, 500);
    assert.equal(w.chain.size, 0, "nothing may be charged");
    assert.equal(w.calls.settle, 0);
    assert.deepEqual(await states(w.journal, w), ["void"]);

    // The same signature is not a second chance to run the handler.
    const again = await post(w.app, body, header);
    assert.equal(again.status, 402);
    assert.equal(reasonOf(again), "payment_closed");
    assert.equal(w.control.handlerRuns, 1);
  }
});

test("x402: a payment the facilitator rejects never touches the journal", async () => {
  const w = world();
  const header = await sign(w, { q: "a" });
  w.clock.advance(400_000); // past validBefore
  const res = await post(w.app, { q: "a" }, header);
  assert.equal(res.status, 402);
  assert.equal(w.control.handlerRuns, 0);
  assert.deepEqual(await states(w.journal, w), [], "junk payments must not be able to fill the journal");
});

// ── never trust a failed settle ───────────────────────────────────────────

test("x402: a settle that moved money but reported failure still delivers", async () => {
  for (const fault of ["lands_then_reports_failure", "lands_then_throws"] as const) {
    const w = world();
    w.control.fault = fault;
    const header = await sign(w, { q: "a" });
    const res = await post(w.app, { q: "a" }, header);

    assert.equal(w.chain.size, 1, "the money really moved");
    assert.equal(res.status, 200, `${fault}: a charged caller must get the good`);
    assert.deepEqual(await res.json(), { answer: "answer to a", run: 1 });
    assert.deepEqual(await states(w.journal, w), ["delivered"]);
    assert.equal((await w.latch.chain()).length, 1);
  }
});

test("x402: a settle that failed with the payment still live waits, then voids once it cannot land", async () => {
  const w = world();
  w.control.fault = "fails_clean";
  const header = await sign(w, { q: "a" });
  const res = await post(w.app, { q: "a" }, header);

  assert.equal(res.status, 402);
  assert.equal(w.chain.size, 0);
  // Not void yet: the authorization is still valid, so a settle could still land.
  assert.deepEqual(await states(w.journal, w), ["settling"]);
  assert.equal(w.alarms.at(-1)?.kind, "settlement_unresolved");

  w.clock.advance(STALE + 1);
  assert.deepEqual((await w.latch.sweep()).map((r) => r.state), ["settling"], "still live, so still waiting");

  w.clock.advance(400_000);
  assert.deepEqual((await w.latch.sweep()).map((r) => r.state), ["void"]);
  assert.equal(w.chain.size, 0);
});

test("x402: a retry of the same payment finishes an unresolved settle without re-running the handler", async () => {
  const w = world();
  w.control.fault = "fails_clean";
  const header = await sign(w, { q: "a" });
  assert.equal((await post(w.app, { q: "a" }, header)).status, 402);

  // Too soon: the first attempt may still be in flight.
  const early = await post(w.app, { q: "a" }, header);
  assert.equal(reasonOf(early), "payment_in_progress");

  w.control.fault = "none";
  w.clock.advance(STALE + 1);
  const retry = await post(w.app, { q: "a" }, header);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { answer: "answer to a", run: 1 });
  assert.equal(w.control.handlerRuns, 1, "the stored response is delivered; the handler does not run again");
  assert.equal(w.chain.size, 1);
  assert.deepEqual(await states(w.journal, w), ["delivered"]);
});

test("x402: with no oracle, an unresolved settle that expires is stuck and alarmed, never guessed", async () => {
  const w = world({ oracle: false });
  w.control.fault = "lands_then_throws";
  const header = await sign(w, { q: "a" });
  const res = await post(w.app, { q: "a" }, header);
  assert.equal(res.status, 402, "without an oracle the bridge cannot contradict the facilitator");
  assert.deepEqual(await states(w.journal, w), ["settling"]);

  w.clock.advance(500_000);
  assert.deepEqual((await w.latch.sweep()).map((r) => r.state), ["stuck"]);
  assert.equal(w.alarms.at(-1)?.kind, "stuck");
});

// ── crashes ───────────────────────────────────────────────────────────────

test("x402: a crash after the money moved is recovered by the next process on retry", async () => {
  const w = world();
  w.control.fault = "lands_then_hangs"; // the process dies waiting for the facilitator
  const header = await sign(w, { q: "a" });
  void post(w.app, { q: "a" }, header); // never returns
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(w.chain.size, 1, "the caller has been charged");
  assert.deepEqual(await states(w.journal, w), ["settling"]);

  const b = w.boot(); // a new process over the same journal
  w.clock.advance(STALE + 1);
  const retry = await post(b.app, { q: "a" }, header);

  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { answer: "answer to a", run: 1 });
  assert.equal(b.control.handlerRuns, 0, "the new process delivers what the dead one produced");
  assert.deepEqual(b.calls, { verify: 0, settle: 0 });
  assert.equal(w.chain.size, 1, "charged exactly once");
  assert.deepEqual(await states(w.journal, w), ["delivered"]);
});

test("x402: a crash after the money moved is recovered by the sweep with no retry at all", async () => {
  const w = world();
  w.control.fault = "lands_then_hangs";
  const header = await sign(w, { q: "a" });
  void post(w.app, { q: "a" }, header);
  for (let i = 0; i < 20; i++) await tick();

  const b = w.boot();
  assert.deepEqual(await b.latch.sweep(), [], "a fresh claim is left alone");
  w.clock.advance(STALE + 1);
  assert.deepEqual((await b.latch.sweep()).map((r) => r.state), ["delivered"]);
  assert.equal((await b.latch.chain()).length, 1, "and it is receipted");

  // The good is still there for the caller to collect.
  const collect = await post(b.app, { q: "a" }, header);
  assert.equal(collect.status, 200);
  assert.deepEqual(await collect.json(), { answer: "answer to a", run: 1 });
});

test("x402: a crash mid-handler charges nothing and the sweep closes the claim", async () => {
  const w = world();
  w.control.hold = new Promise(() => {}); // the process dies inside the handler
  const header = await sign(w, { q: "a" });
  void post(w.app, { q: "a" }, header);
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(await states(w.journal, w), ["producing"]);

  const b = w.boot();
  w.clock.advance(STALE + 1);
  assert.deepEqual((await b.latch.sweep()).map((r) => r.state), ["void"]);
  assert.equal(w.chain.size, 0);
  assert.equal(reasonOf(await post(b.app, { q: "a" }, header)), "payment_closed");
});

test("x402: a worker the sweep gave up on fails closed when it finally tries to settle", async () => {
  const w = world();
  let release!: () => void;
  w.control.hold = new Promise<void>((r) => (release = r));
  const header = await sign(w, { q: "a" });
  const slow = post(w.app, { q: "a" }, header);
  for (let i = 0; i < 20; i++) await tick();

  w.clock.advance(STALE + 1);
  assert.deepEqual((await w.latch.sweep()).map((r) => r.state), ["void"]);

  release();
  const res = await slow;
  assert.equal(res.status, 402, "the late worker must not settle a payment that was closed under it");
  assert.equal(w.calls.settle, 0);
  assert.equal(w.chain.size, 0);
});

// ── crash injection at every journal write ────────────────────────────────

/**
 * A process that dies at its Nth journal write. `after` means the write
 * reached the disk and the process died before it could act on it; `before`
 * means it died first. Either way that process never does anything again.
 */
function dying(inner: Journal, at: number, when: "before" | "after"): Journal {
  let writes = 0;
  let dead = false;
  const never = <R>() => new Promise<R>(() => {});
  const write = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (dead) return never<R>();
      writes++;
      if (writes === at) {
        dead = true;
        if (when === "after") await fn(...a);
        return never<R>();
      }
      return fn(...a);
    };
  const read = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => (dead ? never<R>() : fn(...a));
  return {
    ...inner,
    open: write(inner.open),
    append: write(inner.append),
    putResult: write(inner.putResult),
    appendReceipt: write(inner.appendReceipt),
    get: read(inner.get),
    getResult: read(inner.getResult),
    readChain: read(inner.readChain),
  };
}

test("x402 crash matrix: die at every journal write — charged if and only if the good is collectable", async () => {
  const body = { q: "a" };
  const WRITES = 7; // open, producing, response, settling, settlement, delivered, receipt
  const faults: Fault[] = ["none", "hangs_without_landing", "lands_then_hangs"];
  let cases = 0;
  const outcomes = { charged: 0, uncharged: 0 };
  const rows: Record<string, unknown>[] = [];

  for (const fault of faults) {
    for (let at = 1; at <= WRITES + 1; at++) {
      for (const when of ["before", "after"] as const) {
        const label = `fault=${fault} write=${at} ${when}`;
        const inner = memoryJournal();
        const chain = makeChain();
        const clock = makeClock();
        const a = instance({ journal: dying(inner, at, when), chain, clock });
        const b = instance({ journal: inner, chain, clock });
        const client = new x402Client();
        registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
        const header = await sign({ app: b.app, client }, body);

        a.control.fault = fault;
        const first = await Promise.race([
          post(a.app, body, header),
          (async () => {
            for (let i = 0; i < 40; i++) await tick();
            return undefined;
          })(),
        ]);

        // The next process: a sweep, the client's retry, then time passes and both happen again.
        const seenGood: boolean[] = [first?.status === 200];
        for (const wait of [STALE + 1, 400_000]) {
          clock.advance(wait);
          await b.latch.sweep();
          const retry = await post(b.app, body, header);
          if (retry.status === 200) assert.deepEqual(await retry.json(), { answer: "answer to a", run: 1 }, label);
          seenGood.push(retry.status === 200);
        }

        const charged = chain.size === 1;
        assert.ok(chain.size <= 1, `${label}: charged twice`);
        assert.ok(a.control.handlerRuns + b.control.handlerRuns <= 1, `${label}: handler ran twice`);
        assert.equal(seenGood.includes(true), charged, `${label}: charged=${charged} but good collected=${seenGood}`);

        const final = inner.snapshotAll().map((s) => s.state);
        for (const state of final) {
          assert.ok(["delivered", "void"].includes(state), `${label}: left in ${state}`);
        }
        if (charged) {
          const receipts = await b.latch.chain();
          assert.equal(receipts.length, 1, `${label}: a charged payment must end with exactly one receipt`);
          assert.equal(auditChain(receipts, hmacSigner(SECRET)), -1, label);
        }
        outcomes[charged ? "charged" : "uncharged"]++;
        rows.push({ fault, write: at, when, firstStatus: first?.status ?? "no response", collectedOn: seenGood.indexOf(true), charged, final: final.join(",") });
        cases++;
      }
    }
  }
  assert.equal(cases, faults.length * (WRITES + 1) * 2);
  // Both sides of the "if and only if" must actually have been exercised.
  assert.ok(outcomes.charged >= 10 && outcomes.uncharged >= 10, JSON.stringify(outcomes));
  if (process.env.LATCH_TEST_VERBOSE) {
    console.log("crash matrix outcomes", outcomes);
    for (const r of rows) console.log("CRASHROW " + JSON.stringify(r));
  }
});

// ── a journal that is down ────────────────────────────────────────────────

function flaky(inner: Journal, down: () => boolean): Journal {
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (down()) throw new Error("journal is down");
      return fn(...a);
    };
  return {
    ...inner,
    open: guard(inner.open),
    get: guard(inner.get),
    append: guard(inner.append),
    putResult: guard(inner.putResult),
    getResult: guard(inner.getResult),
  };
}

test("x402: a journal that is down before the claim refuses the sale; nothing runs, nothing is charged", async () => {
  let down = false;
  const w = world({}, flaky(memoryJournal(), () => down));
  const header = await sign(w, { q: "a" });
  down = true;
  const res = await post(w.app, { q: "a" }, header);
  assert.equal(res.status, 402);
  assert.equal(reasonOf(res), "latch_unavailable");
  assert.equal(w.control.handlerRuns, 0);
  assert.equal(w.chain.size, 0);
  assert.equal(w.alarms.at(-1)?.kind, "journal_error");
});

test("x402: a journal that goes down before the settle fails closed — no write-ahead, no charge", async () => {
  let down = false;
  const inner = memoryJournal();
  const w = world({}, flaky(inner, () => down));
  const header = await sign(w, { q: "a" });
  let release!: () => void;
  w.control.hold = new Promise<void>((r) => (release = r));
  const pending = post(w.app, { q: "a" }, header);
  for (let i = 0; i < 20; i++) await tick();
  down = true; // dies while the handler is running
  release();
  const res = await pending;

  assert.equal(res.status, 402);
  assert.equal(w.calls.settle, 0, "the facilitator must not be called without a durable record");
  assert.equal(w.chain.size, 0);
});

test("x402: a journal that goes down after the settle still delivers, and the sweep repairs the record", async () => {
  // Fail exactly the write that records a successful settle.
  const inner = memoryJournal();
  const append = inner.append;
  let down = true;
  inner.append = async (entry, seq) => {
    if (down && entry.state === "delivered") throw new Error("journal is down");
    return append(entry, seq);
  };
  const w = world({}, inner);
  const header = await sign(w, { q: "a" });
  const res = await post(w.app, { q: "a" }, header);
  assert.equal(res.status, 200, "the caller paid, so the caller gets the good");
  assert.equal(w.chain.size, 1);
  assert.equal(w.alarms.at(-1)?.kind, "settled_unrecorded");
  assert.deepEqual(await states(w.journal, w), ["settling"]);

  down = false;
  w.clock.advance(STALE + 1);
  assert.deepEqual((await w.latch.sweep()).map((r) => r.state), ["delivered"]);
});

// ── payment-identifier: the retry that signs again ────────────────────────

test("x402: a second signature under the same payment identifier is never charged", async () => {
  const w = world({ pid: true });
  const id = "pay_0123456789abcdef0123";
  const first = await sign(w, { q: "a" }, id);
  const second = await sign(w, { q: "a" }, id); // a fresh nonce, the same purchase
  assert.notEqual(first, second);

  const r1 = await post(w.app, { q: "a" }, first);
  assert.equal(r1.status, 200);
  const body = await r1.json();

  const r2 = await post(w.app, { q: "a" }, second);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), body, "the retry gets the first purchase's result");
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.calls.settle, 1);
  assert.equal(w.chain.size, 1, "the second signature must never reach the chain");
  assert.deepEqual(await states(w.journal, w), ["delivered"]);
});

test("x402: another payer cannot collect under someone else's payment identifier", async () => {
  const w = world({ pid: true });
  const id = "pay_0123456789abcdef0123";
  assert.equal((await post(w.app, { q: "a" }, await sign(w, { q: "a" }, id))).status, 200);

  const thief = new x402Client();
  registerExactEvmScheme(thief, { signer: privateKeyToAccount(generatePrivateKey()) });
  const res = await post(w.app, { q: "a" }, await sign({ app: w.app, client: thief }, { q: "a" }, id));
  assert.equal(res.status, 402);
  assert.equal(reasonOf(res), "payment_identifier_reused");
  assert.doesNotMatch(await res.text(), /answer to a/);
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.chain.size, 1, "and the thief's own payment is not settled either");
});

test("x402: a payment identifier cannot be reused for a different request", async () => {
  const w = world({ pid: true });
  const id = "pay_0123456789abcdef0123";
  assert.equal((await post(w.app, { q: "a" }, await sign(w, { q: "a" }, id))).status, 200);

  const other = await post(w.app, { q: "a" }, await sign(w, { q: "a" }, id), `${URL_}?variant=2`);
  assert.equal(other.status, 402);
  assert.equal(reasonOf(other), "payment_already_used");
  assert.equal(w.chain.size, 1);
});

test("x402: a failed attempt releases its payment identifier for an honest retry", async () => {
  const w = world({ pid: true });
  const id = "pay_0123456789abcdef0123";
  assert.equal((await post(w.app, { fail: true }, await sign(w, { fail: true }, id))).status, 500);
  assert.equal(w.chain.size, 0);

  const retry = await post(w.app, { fail: true, q: "x" }, await sign(w, { fail: true }, id));
  assert.equal(retry.status, 500, "the retry runs the handler again; it is a new attempt at the same purchase");
  assert.equal(w.control.handlerRuns, 2);
});

test("x402: two signatures racing for one payment identifier run the handler once", async () => {
  const w = world({ pid: true });
  const id = "pay_0123456789abcdef0123";
  const one = await sign(w, { q: "a" }, id);
  const two = await sign(w, { q: "a" }, id);

  let release!: () => void;
  w.control.hold = new Promise<void>((r) => (release = r));
  const both = [post(w.app, { q: "a" }, one), post(w.app, { q: "a" }, two)];
  for (let i = 0; i < 20; i++) await tick();
  release();
  const results = await Promise.all(both);

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 402]);
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.chain.size, 1);
});

// ── scope ─────────────────────────────────────────────────────────────────

test("x402: a route that settles before its handler is refused, uncharged", async () => {
  const w = world({ flow: "upfront" });
  const header = await sign(w, { q: "a" });
  const res = await post(w.app, { q: "a" }, header);
  assert.notEqual(res.status, 200);
  assert.equal(w.control.handlerRuns, 0);
  assert.equal(w.calls.settle, 0);
  assert.equal(w.chain.size, 0);
});

test("x402: a scheme the bridge is not configured for passes through untouched", async () => {
  const w = world({ schemes: ["auth-capture"] });
  const header = await sign(w, { q: "a" });
  const res = await post(w.app, { q: "a" }, header);
  assert.equal(res.status, 200, "the SDK serves it exactly as it would without Latch");
  assert.equal(w.chain.size, 1);
  assert.deepEqual(await states(w.journal, w), [], "and Latch records nothing about it");
});

test("x402: the strict gate's sweep leaves x402 payments to the bridge", async () => {
  const w = world();
  w.control.hold = new Promise(() => {});
  void post(w.app, { q: "a" }, await sign(w, { q: "a" }));
  for (let i = 0; i < 20; i++) await tick();

  const gate = new Latch(
    { payTo: SELLER },
    { journal: w.journal, facilitator: ledgerFacilitator(), producer: { produce: async () => "x" }, signer: hmacSigner(SECRET), clock: w.clock },
  );
  w.clock.advance(STALE + 1);
  assert.deepEqual(await gate.sweep(0), [], "the gate must not try to recover a payment it did not open");
  assert.deepEqual(await states(w.journal, w), ["producing"]);
});

// ── over a real database ──────────────────────────────────────────────────

function pgClient(db: PGlite): SqlClient {
  const exec = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({
    async query<R>(text: string, params: readonly unknown[] = []) {
      const r = await runner.query(text, [...params]);
      return { rows: r.rows as R[], rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return {
    ...exec(db),
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return (await db.transaction(async (tx) => fn(exec(tx)))) as T;
    },
  };
}

test("x402 over postgres: pay, replay, and three concurrent copies", async () => {
  const db = await PGlite.create();
  const sql = pgClient(db);
  await migrate(sql);
  const journal = postgresJournal(sql);
  const w = world({}, journal);

  const header = await sign(w, { q: "a" });
  let release!: () => void;
  w.control.hold = new Promise<void>((r) => (release = r));
  const copies = [post(w.app, { q: "a" }, header), post(w.app, { q: "a" }, header), post(w.app, { q: "a" }, header)];
  for (let i = 0; i < 50; i++) await tick();
  release();
  const results = await Promise.all(copies);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 402, 402]);
  assert.equal(w.control.handlerRuns, 1);
  assert.equal(w.chain.size, 1);

  w.control.hold = undefined;
  const again = await post(w.app, { q: "a" }, header);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { answer: "answer to a", run: 1 });
  assert.equal(w.control.handlerRuns, 1);

  const rows = await sql.query<{ state: string }>(
    `select e.state from latch_entry e
       join (select invoice_id, max(seq) as seq from latch_entry group by invoice_id) m
         on m.invoice_id = e.invoice_id and m.seq = e.seq`,
  );
  assert.deepEqual(rows.rows.map((r) => r.state), ["delivered"]);
  await db.close();
});

test("x402 over postgres: a crash after the money moved is recovered from the database", async () => {
  const db = await PGlite.create();
  const sql = pgClient(db);
  await migrate(sql);
  const w = world({}, postgresJournal(sql));
  w.control.fault = "lands_then_hangs";
  const header = await sign(w, { q: "a" });
  void post(w.app, { q: "a" }, header);
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(w.chain.size, 1);

  const b = instance({ journal: postgresJournal(sql), chain: w.chain, clock: w.clock });
  w.clock.advance(STALE + 1);
  const retry = await post(b.app, { q: "a" }, header);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { answer: "answer to a", run: 1 });
  assert.equal(b.control.handlerRuns, 0);
  assert.equal(w.chain.size, 1);
  await db.close();
});

// ── the oracle ────────────────────────────────────────────────────────────

const PROBE = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payer: "0x3cc0F8ada36C32F605d1764E03279Cc33A476a0A",
  nonce: "0xa7a2ccad325d7e79515c36d917b4e7505e7b0f7d4dd7af21569febfe76e9188b",
  method: "eip3009" as const,
  expiresAt: 0,
};
const WORD = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function rpc(reply: unknown, status = 200) {
  const seen: { url: string; body: { method: string; params: [{ to: string; data: string }, string] } }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return { fake, seen };
}

test("oracle: asks the token contract authorizationState(payer, nonce) and believes only a clean word", async () => {
  const yes = rpc({ jsonrpc: "2.0", id: 1, result: WORD(1) });
  const oracle = eip3009Oracle({ rpcUrls: { "eip155:8453": "https://rpc.test" }, fetch: yes.fake });
  assert.equal(await oracle(PROBE), "settled");

  const call = yes.seen[0]?.body;
  assert.equal(call?.method, "eth_call");
  assert.equal(call?.params[0].to, PROBE.asset);
  assert.equal(
    call?.params[0].data,
    "0xe94a0102" + "0".repeat(24) + PROBE.payer.slice(2).toLowerCase() + PROBE.nonce.slice(2),
  );

  const no = rpc({ jsonrpc: "2.0", id: 1, result: WORD(0) });
  assert.equal(await eip3009Oracle({ rpcUrls: { "eip155:8453": "u" }, fetch: no.fake })(PROBE), "unsettled");
});

test("oracle: anything short of an answer throws, so the bridge waits instead of guessing", async () => {
  const cases: [string, unknown, number][] = [
    ["empty result from a non-contract", { result: "0x" }, 200],
    ["rpc error", { error: { message: "execution reverted" } }, 200],
    ["http failure", {}, 503],
    ["garbage", { result: "yes" }, 200],
  ];
  for (const [name, reply, status] of cases) {
    const { fake } = rpc(reply, status);
    const oracle = eip3009Oracle({ rpcUrls: { "eip155:8453": "u" }, fetch: fake });
    await assert.rejects(oracle(PROBE), Error, name);
  }
  const { fake } = rpc({ result: WORD(1) });
  const oracle = eip3009Oracle({ rpcUrls: { "eip155:8453": "u" }, fetch: fake });
  await assert.rejects(oracle({ ...PROBE, network: "eip155:1" }), /no RPC URL/);
  await assert.rejects(oracle({ ...PROBE, method: "permit2" }), /cannot answer/);
  await assert.rejects(oracle({ ...PROBE, nonce: "0x01" }), /32 bytes/);
});

// ── a caller that signs again while a settle is unresolved ────────────────

test("x402: while a settle is unresolved, a new signature for the same purchase is refused if it carries the payment identifier", async () => {
  const w = world({ pid: true });
  const id = "pay_0123456789abcdef0123";
  w.control.fault = "fails_clean";
  const first = await sign(w, { q: "a" }, id);
  assert.equal((await post(w.app, { q: "a" }, first)).status, 402);
  assert.deepEqual(await states(w.journal, w), ["settling"], "the first payment may still land");

  // The SDK answered 402, so an obedient client signs again.
  w.control.fault = "none";
  const second = await post(w.app, { q: "a" }, await sign(w, { q: "a" }, id));
  assert.equal(second.status, 402);
  assert.equal(reasonOf(second), "payment_in_progress");
  assert.equal(w.chain.size, 0, "the second signature is never settled");
  assert.equal(w.control.handlerRuns, 1);
});

test("x402: limit — without a payment identifier, a re-signed payment is a new purchase and both can be charged", async () => {
  const w = world();
  w.control.fault = "fails_clean";
  const first = await sign(w, { q: "a" });
  assert.equal((await post(w.app, { q: "a" }, first)).status, 402);

  w.control.fault = "none";
  assert.equal((await post(w.app, { q: "a" }, await sign(w, { q: "a" }))).status, 200);

  // The first authorization lands after all (a delayed broadcast).
  const auth = decodePaymentSignatureHeader(first).payload.authorization as { from: string; nonce: string };
  w.chain.use(auth.from, auth.nonce);
  w.clock.advance(STALE + 1);
  await w.latch.sweep();

  assert.equal(w.chain.size, 2, "two charges for one purchase: what payment-identifier exists to prevent");
  // Each charge is still matched by a good the caller can collect; nothing is charged for nothing.
  assert.deepEqual((await states(w.journal, w)).sort(), ["delivered", "delivered"]);
});
