/**
 * See Latch work on a real x402 server, in about a minute.
 *
 *     npm run example            offline: a simulated chain, no network at all
 *     npm run example:testnet    live: Base Sepolia, the public x402 facilitator
 *
 * Both start a real HTTP server on 127.0.0.1, protect it with Latch over an
 * in-process PostgreSQL, and pay it with the official x402 client. Then they
 * break things on purpose: a lost reply, three copies of one payment, and a
 * buyer told "failed" who signs again for the same order, and a server that
 * dies after the money moved.
 *
 * Testnet mode moves free test USDC only. It refuses any network but Base
 * Sepolia, contacts only the facilitator and the Base Sepolia RPC (every
 * request is printed), and keeps its throwaway wallet in `.latch-demo/`,
 * which git ignores. It never prints a private key.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/fetch";
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
} from "@x402/extensions/payment-identifier";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { migrate, postgresJournal, type SqlClient, type SqlExecutor } from "../src/adapters/postgres-journal.ts";
import type { Journal } from "../src/ports.ts";
import { eip3009Oracle, latchX402, purchasePaymentId, type SettlementOracle } from "../src/x402/index.ts";

const LIVE = process.argv.includes("--testnet");

// ── fixed on purpose: this demo cannot be pointed at real money ────────────
const NETWORK = "eip155:84532"; // Base Sepolia
const CHAIN_ID_HEX = "0x14a34";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // test USDC on Base Sepolia
const FACILITATOR = "https://x402.org/facilitator";
const RPC = "https://sepolia.base.org";
const PRICE = "$0.01";
const PRICE_UNITS = 10_000n; // 0.01 USDC, 6 decimals
const WALLET_DIR = ".latch-demo";
const WALLET_FILE = `${WALLET_DIR}/wallet.json`;
const STALE_MS = LIVE ? 20_000 : 1_500;

// ── output ─────────────────────────────────────────────────────────────────
const say = (s = "") => console.log(s);
const step = (n: number, title: string) => say(`\n${n}. ${title}`);
const ok = (s: string) => say(`   ✓ ${s}`);
const bad = (s: string) => say(`   ✗ ${s}`);
const note = (s: string) => say(`     ${s}`);
let failures = 0;
const check = (cond: boolean, pass: string, fail: string) => (cond ? ok(pass) : (failures++, bad(fail)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The SDK logs hook warnings; the demo explains what happens instead.
console.warn = () => {};

// ── outbound allowlist: the only places this process may talk to ───────────
const allowed = new Set(LIVE ? ["127.0.0.1", "x402.org", "sepolia.base.org"] : ["127.0.0.1"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowed.has(url.hostname)) throw new Error(`blocked: this demo may not contact ${url.hostname}`);
  if (url.hostname !== "127.0.0.1") note(`→ ${init?.method ?? "GET"} ${url.host}${url.pathname}`);
  return realFetch(input, init);
}) as typeof fetch;

// ── the chain: simulated offline, real on testnet ──────────────────────────
type Auth = { from: string; nonce: string; validBefore: string };
const authOf = (p: { payload: Record<string, unknown> }) => p.payload.authorization as Auth;

function simulatedChain() {
  const used = new Set<string>();
  const key = (a: { from: string; nonce: string }) => `${a.from}:${a.nonce}`.toLowerCase();
  let tx = 0;
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
    async verify(payload) {
      const a = authOf(payload);
      if (used.has(key(a))) return { isValid: false, invalidReason: "nonce_already_used" };
      return { isValid: true, payer: a.from };
    },
    async settle(payload, requirements) {
      const a = authOf(payload);
      if (used.has(key(a))) {
        return { success: false, errorReason: "nonce_already_used", transaction: "", network: requirements.network };
      }
      used.add(key(a));
      return { success: true, transaction: `0xsimulated${++tx}`, network: requirements.network, payer: a.from };
    },
  };
  const oracle: SettlementOracle = async (probe) => (used.has(key({ from: probe.payer, nonce: probe.nonce })) ? "settled" : "unsettled");
  return { facilitator, oracle, charges: () => used.size };
}

async function rpc(method: string, params: unknown[]): Promise<string> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error || typeof body.result !== "string") throw new Error(`RPC ${method} failed: ${body.error?.message ?? "no result"}`);
  return body.result;
}

async function usdcBalance(address: string): Promise<bigint> {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(await rpc("eth_call", [{ to: USDC, data }, "latest"]));
}

const usd = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")} USDC`;

/**
 * A facilitator that can be told to fail without moving anything (the buyer is
 * told "failed"), or to "kill the server" right after the money moves.
 */
function crashable(inner: FacilitatorClient) {
  const crash = { armed: false, settledTx: "", failNext: false };
  const facilitator: FacilitatorClient = {
    getSupported: () => inner.getSupported(),
    verify: (p, r) => inner.verify(p, r),
    async settle(p, r) {
      if (crash.failNext) {
        crash.failNext = false;
        return { success: false, errorReason: "facilitator_unavailable", transaction: "", network: r.network };
      }
      const result = await inner.settle(p, r);
      if (crash.armed && result.success) {
        crash.armed = false;
        crash.settledTx = result.transaction;
        return new Promise<never>(() => {}); // the process dies here; the reply never comes
      }
      return result;
    },
  };
  return { facilitator, crash };
}

// ── a real HTTP server on loopback only ────────────────────────────────────
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startServer(journal: Journal, facilitator: FacilitatorClient, oracle: SettlementOracle, payTo: string) {
  const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  const latch = latchX402(server, { journal, oracle, staleMs: STALE_MS });
  const runs = { count: 0 };

  const app = new Hono();
  app.use(
    paymentMiddleware(
      {
        "POST /answer": {
          accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo },
          description: "Latch demo: one paid answer",
          extensions: { ...latch.declare(), [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension() },
        },
      },
      server,
    ),
  );
  app.post("/answer", async (c) => {
    runs.count++;
    const { question } = (await c.req.json().catch(() => ({}))) as { question?: string };
    await sleep(300); // long enough for concurrent copies to overlap
    return c.json({ answer: `42 is the answer to "${question ?? "?"}"`, servedAt: new Date().toISOString() });
  });

  const http: Server = createServer(async (req, res) => {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const response = await app.fetch(
        new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const stop = () => {
    http.closeAllConnections();
    http.close();
  };
  return { url: `http://127.0.0.1:${port}/answer`, latch, runs, stop };
}

// ── the buyer: the official x402 client ────────────────────────────────────
function buyer(privateKey: `0x${string}`) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(privateKey) });
  const post = (url: string, body: unknown, header?: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(header ? { "payment-signature": header } : {}) },
      body: JSON.stringify(body),
    });
  /**
   * Ask for the price and sign it. The header is what a retry would resend.
   * With an order id, the payment carries an identifier derived from it, so
   * signing again for the same order is recognisably the same purchase.
   */
  const sign = async (url: string, body: unknown, orderId?: string) => {
    const unpaid = await post(url, body);
    const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    const payload = await client.createPaymentPayload(required);
    if (orderId) {
      payload.extensions = appendPaymentIdentifierToExtensions(payload.extensions ?? {}, purchasePaymentId(orderId));
    }
    return encodePaymentSignatureHeader(payload);
  };
  return { post, sign };
}

const settlementOf = (res: Response) => {
  const header = res.headers.get("payment-response");
  return header ? decodePaymentResponseHeader(header) : undefined;
};
const reasonOf = (res: Response) => {
  const header = res.headers.get("payment-required");
  return header ? decodePaymentRequiredHeader(header).error : undefined;
};
const txLink = (tx: string) => (LIVE ? `https://sepolia.basescan.org/tx/${tx}` : tx);

// ── testnet wallet ─────────────────────────────────────────────────────────
type Wallet = { buyerKey: `0x${string}`; sellerKey: `0x${string}`; network: string; createdAt: string };

function loadOrCreateWallet(): { wallet: Wallet; created: boolean } {
  if (existsSync(WALLET_FILE)) {
    const wallet = JSON.parse(readFileSync(WALLET_FILE, "utf8")) as Wallet;
    if (wallet.network !== NETWORK) throw new Error(`${WALLET_FILE} is not a Base Sepolia test wallet; refusing to use it`);
    return { wallet, created: false };
  }
  mkdirSync(WALLET_DIR, { recursive: true });
  const wallet: Wallet = {
    buyerKey: generatePrivateKey(),
    sellerKey: generatePrivateKey(),
    network: NETWORK,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(WALLET_FILE, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  writeFileSync(`${WALLET_DIR}/README.txt`, "Throwaway Base Sepolia test wallets for `npm run example:testnet`.\nTest money only. Delete this folder to forget them.\n");
  return { wallet, created: true };
}

// ── run ────────────────────────────────────────────────────────────────────
async function main() {
  say(LIVE ? "Latch live demo — Base Sepolia testnet (free test USDC only)" : "Latch demo — offline, simulated chain (no network)");

  let facilitatorBase: FacilitatorClient;
  let oracle: SettlementOracle;
  let charges: () => Promise<bigint>;
  let buyerKey: `0x${string}`;
  let payTo: string;

  if (LIVE) {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== CHAIN_ID_HEX) throw new Error(`RPC reports chain ${chainId}, not Base Sepolia; refusing to continue`);
    const { wallet, created } = loadOrCreateWallet();
    const buyerAddress = privateKeyToAccount(wallet.buyerKey).address;
    payTo = privateKeyToAccount(wallet.sellerKey).address;
    buyerKey = wallet.buyerKey;
    say(`\nBuyer test wallet:  ${buyerAddress}${created ? "  (just created)" : ""}`);
    say(`Seller test wallet: ${payTo}`);

    const funds = await usdcBalance(buyerAddress);
    if (funds < 5n * PRICE_UNITS) {
      say(`\nThe buyer wallet holds ${usd(funds)}. It needs a little test USDC first:`);
      say("  1. Type faucet.circle.com into your browser yourself.");
      say("  2. Choose Base Sepolia, paste the buyer address above, and request USDC.");
      say("  3. Wait a minute, then run `npm run example:testnet` again.");
      say("It is free test money. No ETH is needed: the facilitator pays the fees.");
      return;
    }
    const sellerStart = await usdcBalance(payTo);
    charges = async () => ((await usdcBalance(payTo)) - sellerStart) / PRICE_UNITS;
    facilitatorBase = new HTTPFacilitatorClient({ url: FACILITATOR });
    const supported = await facilitatorBase.getSupported();
    if (!supported.kinds.some((k) => k.network === NETWORK && k.scheme === "exact" && k.x402Version === 2)) {
      throw new Error("The facilitator does not offer exact on Base Sepolia; refusing to continue");
    }
    oracle = eip3009Oracle({ rpcUrls: { [NETWORK]: RPC } });
    say(`Buyer balance: ${usd(funds)}. Each purchase costs ${PRICE}.`);
  } else {
    const sim = simulatedChain();
    facilitatorBase = sim.facilitator;
    oracle = sim.oracle;
    charges = async () => BigInt(sim.charges());
    buyerKey = generatePrivateKey();
    payTo = privateKeyToAccount(generatePrivateKey()).address;
  }

  // One database for the whole run, so a "restarted" server finds what the dead one wrote.
  const db = await PGlite.create();
  const exec = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({
    async query<R>(text: string, params: readonly unknown[] = []) {
      const r = await runner.query(text, [...params]);
      return { rows: r.rows as R[], rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  const sql: SqlClient = {
    ...exec(db),
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>) => (await db.transaction(async (tx) => fn(exec(tx)))) as T,
  };
  await migrate(sql);
  const journal = postgresJournal(sql);

  const { facilitator, crash } = crashable(facilitatorBase);
  let srv = await startServer(journal, facilitator, oracle, payTo);
  const b = buyer(buyerKey);
  say(`\nServer listening on ${srv.url.replace("/answer", "")} (this machine only), journal in PostgreSQL.`);

  // 1 — a normal paid request
  step(1, "Pay once with the official x402 client");
  const h1 = await b.sign(srv.url, { question: "life" });
  const r1 = await b.post(srv.url, { question: "life" }, h1);
  const body1 = await r1.json();
  const s1 = settlementOf(r1);
  check(r1.status === 200 && !!s1?.success, `200, paid and served: ${JSON.stringify(body1)}`, `expected 200, got ${r1.status}`);
  if (s1?.transaction) note(`settlement: ${txLink(s1.transaction)}`);

  // 2 — the reply was lost; the client resends the same payment
  step(2, "The reply was lost, so the client sends the same payment again");
  const r2 = await b.post(srv.url, { question: "life" }, h1);
  const body2 = await r2.json();
  check(r2.status === 200 && JSON.stringify(body2) === JSON.stringify(body1), "the stored answer came back, identical", `expected the stored answer, got ${r2.status}`);
  check(srv.runs.count === 1, "the paid work did not run again", `the paid work ran ${srv.runs.count} times`);
  note("Without Latch the SDK answers 402: the payment is spent and the answer is gone.");

  // 3 — three copies of one payment at once
  step(3, "Three copies of one new payment arrive at the same moment");
  const before3 = srv.runs.count;
  const h3 = await b.sign(srv.url, { question: "copies" });
  const r3 = await Promise.all([1, 2, 3].map(() => b.post(srv.url, { question: "copies" }, h3)));
  const statuses = r3.map((r) => r.status);
  check(srv.runs.count - before3 === 1, "the paid work ran once", `the paid work ran ${srv.runs.count - before3} times`);
  check(statuses.filter((s) => s === 200).length === 1, `one caller served; the others told: ${r3.map(reasonOf).filter(Boolean).join(", ")}`, `statuses ${statuses.join(", ")}`);
  note("Without Latch the SDK runs the paid work three times for one payment.");

  // 4 — told "failed", the buyer signs again for the same order
  step(4, 'The buyer is told the payment failed, and signs a new one for the same order');
  const before4 = srv.runs.count;
  crash.failNext = true; // nothing moves; the first payment stays valid and could still land
  const h4a = await b.sign(srv.url, { question: "order" }, "order-1001");
  const r4a = await b.post(srv.url, { question: "order" }, h4a);
  check(r4a.status === 402, "the first attempt was answered 402, as a real failure would be", `expected 402, got ${r4a.status}`);
  const h4b = await b.sign(srv.url, { question: "order" }, "order-1001");
  const r4b = await b.post(srv.url, { question: "order" }, h4b);
  check(r4b.status === 402 && reasonOf(r4b) === "payment_in_progress", "the new signature for the same order was refused, so it can never be charged", `expected a refusal, got ${r4b.status} ${reasonOf(r4b) ?? ""}`);
  note("Both payments carry an identifier derived from the order id (purchasePaymentId).");
  note("Without Latch, or with a fresh random identifier per attempt, the second signature is a second charge.");
  note(`Waiting ${STALE_MS / 1000}s, then the buyer retries the original payment…`);
  await sleep(STALE_MS + 500);
  const r4c = await b.post(srv.url, { question: "order" }, h4a);
  check(r4c.status === 200, `the retry finished the purchase: ${JSON.stringify(await r4c.json())}`, `the retry got ${r4c.status}`);
  check(srv.runs.count - before4 === 1, "the paid work ran once for the whole order", `the paid work ran ${srv.runs.count - before4} times`);
  const s4 = settlementOf(r4c);
  if (s4?.transaction) note(`settlement: ${txLink(s4.transaction)}`);

  // 5 — the server dies after the money moved
  step(5, "The server dies right after the money moves, before it can reply");
  crash.armed = true;
  const h5 = await b.sign(srv.url, { question: "crash" });
  void b.post(srv.url, { question: "crash" }, h5).catch(() => {});
  for (let i = 0; i < 300 && !crash.settledTx; i++) await sleep(100);
  srv.stop();
  check(!!crash.settledTx, "the buyer has been charged, and the server is gone", "the settlement never happened");
  if (crash.settledTx) note(`settlement: ${txLink(crash.settledTx)}`);

  note(`Starting a fresh server over the same database, then waiting ${STALE_MS / 1000}s for the claim to go stale…`);
  srv = await startServer(journal, facilitator, oracle, payTo);
  await sleep(STALE_MS + 500);
  let recovered = "";
  for (let i = 0; i < 6 && recovered !== "delivered"; i++) {
    const swept = await srv.latch.sweep();
    recovered = swept[0]?.state ?? recovered;
    if (recovered !== "delivered") await sleep(2_000); // the RPC can trail the chain by a block or two
  }
  check(recovered === "delivered", "the sweep asked the chain, found the payment, and marked it delivered", `the sweep left it as "${recovered || "unchanged"}"`);
  const r5 = await b.post(srv.url, { question: "crash" }, h5);
  check(r5.status === 200, `the buyer's retry collected the answer: ${JSON.stringify(await r5.json())}`, `the retry got ${r5.status}`);
  check(srv.runs.count === 0, "the new server did not redo the work", `the new server ran the work ${srv.runs.count} times`);
  srv.stop();

  // the books
  step(6, "Check the books");
  await sleep(LIVE ? 3_000 : 0);
  const n = await charges();
  check(n === 4n, `the buyer was charged exactly 4 times for 4 purchases${LIVE ? " (read from the chain)" : ""}`, `charges counted: ${n}, expected 4`);
  await db.close();

  say(failures === 0 ? "\nEverything held." : `\n${failures} check(s) failed.`);
  if (LIVE) {
    say("\nThe test wallets stay in .latch-demo/ (ignored by git) for the next run.");
    say("To forget them:  Remove-Item -Recurse .latch-demo   (PowerShell)   or   rm -rf .latch-demo");
  } else {
    say("\nTo run the same thing on Base Sepolia with free test USDC:  npm run example:testnet");
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
