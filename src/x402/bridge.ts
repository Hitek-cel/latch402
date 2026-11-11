import { randomHex, sha256, sha256Hex, timingSafeEqualHex, toHex } from "../crypto.ts";
import { JournalConflictError } from "../errors.ts";
import { canonicalJson, hashRequest } from "../ids.ts";
import { isMicros } from "../money.ts";
import { systemClock, type Clock, type InvoiceSnapshot, type Journal, type Quote } from "../ports.ts";
import { GENESIS, issueReceipt, type SignedReceipt, type Signer } from "../receipt.ts";
import type { State } from "../states.ts";
import type {
  Abort,
  AfterVerifyDirective,
  BeforeVerifyDirective,
  SettlementOracle,
  TransferMethod,
  X402HookRegistry,
  X402Payload,
  X402Requirements,
  X402SettleResponse,
  X402VerifyContext,
} from "./types.ts";

/**
 * Latch for the official x402 SDK.
 *
 * The SDK's resource server keeps a payment's state in process memory. That is
 * enough until something goes wrong between "the money moved" and "the caller
 * has the good": a crash, a lost response, a settle that reports failure after
 * broadcasting, three copies of one payment arriving at once. This bridge makes
 * that state durable by journaling each step through the SDK's own lifecycle
 * hooks, so the same promise holds on real x402 traffic:
 *
 *     A caller is charged if and only if it received the good.
 *
 * It covers the `authorization` payment flow — verify, run the handler, settle,
 * release the response — which is what `exact` uses by default. There the
 * handler runs before any money moves and its response is held back until the
 * settle lands, so nothing ever needs refunding; what needs protecting is the
 * record of what happened:
 *
 *   quoted      claimed. A second copy of the same payment stops here.
 *   producing   verified; the handler is running. No money has moved.
 *   settling    the response is stored and a settle was requested. The one
 *               ambiguous state: only the chain knows if money moved.
 *   delivered   settled. The stored response is the caller's, and a retry of
 *               the same payment gets it back instead of a second charge.
 *   void        closed with nothing charged.
 *   stuck       outcome unknowable without a human. Alarmed, never guessed.
 */

const PREFIX = "x402_";
const MAX_PID_SLOTS = 8;
const PAYMENT_ID = /^[a-zA-Z0-9_-]{16,128}$/;

/**
 * The replay token.
 *
 * Giving a stored response back to "the same payment" needs care, because a
 * settled payment is not a secret: its payer, nonce and signature are all in
 * the settlement transaction's calldata, on a public chain. Anyone could
 * rebuild the header and ask for the response.
 *
 * So the 402 carries a fresh random token in a `latch` extension. The SDK's
 * client echoes server extensions back with its payment, the token travels
 * only inside the TLS session, and it never reaches the chain. Only its hash
 * is journaled. A retry gets the stored response back only by presenting it.
 */
const EXTENSION = "latch";
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * This flow's own transition table. It differs from the strict gate's on
 * purpose: here compute runs before settlement (the SDK's order), and what
 * keeps the caller whole is that the response is withheld until money moves.
 */
const LEGAL: Partial<Record<State, readonly State[]>> = {
  quoted: ["producing", "void"],
  producing: ["settling", "void"],
  // settling -> settling: a resumed settle appends a fresh entry so the
  // attempt cap counts something.
  settling: ["settling", "delivered", "void", "stuck"],
};

export type X402Alarm = {
  /**
   * settled_unrecorded     money moved and the good went out, but the journal
   *                        write failed. The sweep reconciles it.
   * settlement_unresolved  a settle failed or timed out and the chain cannot
   *                        yet say whether it landed. The sweep keeps asking.
   * stuck                  the payment expired with its outcome unknowable
   *                        (no oracle). A human must check the chain.
   * journal_error          the journal failed; the payment was refused.
   */
  kind: "settled_unrecorded" | "settlement_unresolved" | "stuck" | "journal_error";
  invoiceId?: string;
  error?: unknown;
};

export type X402LatchOptions = {
  journal: Journal;
  /**
   * Says whether a payment moved money, independent of the facilitator. Without
   * one, a settle with an unclear outcome can only be resumed by a retry of the
   * same payment or end `stuck`. See `eip3009Oracle`.
   */
  oracle?: SettlementOracle;
  /** Signs a hash-chained receipt for every delivered payment. */
  signer?: Signer;
  clock?: Clock;
  /**
   * How long a claim may sit idle before another request or the sweep may treat
   * its worker as dead. Must exceed your slowest handler plus the facilitator
   * timeout. Default 120s.
   */
  staleMs?: number;
  /**
   * How long after delivery a retry of the same payment gets the stored
   * response back. The payment header is a bearer credential for that response
   * for this long. 0 disables replay. Default 10 minutes.
   */
  replayWindowMs?: number;
  /** Responses larger than this are settled but not stored for replay. Default 256 KiB. */
  maxResponseBytes?: number;
  /** How many times one payment may be sent to settle. Default 3. */
  maxSettleAttempts?: number;
  /** Slack after a payment's expiry before concluding it can no longer land. Default 60s. */
  expiryGraceMs?: number;
  /**
   * Payment schemes this bridge journals. Payments under any other scheme pass
   * through untouched, to whatever protects them (`auth-capture` has its own
   * escrow and its own store — see `postgresAuthorizedPaymentStorage`).
   * Default `["exact"]`.
   */
  schemes?: readonly string[];
  onAlarm?: (alarm: X402Alarm) => void;
};

export type X402Latch = {
  /**
   * Spread into a route's `extensions` to let callers of that route collect a
   * paid response again after a lost reply or a crash. Without it everything
   * else still holds, but a settled payment cannot be replayed.
   */
  declare(): Record<string, unknown>;
  /** Finish or close every x402 payment left in flight longer than `olderThanMs`. Run on a timer. */
  sweep(olderThanMs?: number, limit?: number): Promise<{ invoiceId: string; state: State }[]>;
  /** Finish or close one payment. Leaves a claim alone until it is stale. */
  recover(invoiceId: string): Promise<State>;
  chain(): Promise<SignedReceipt[]>;
};

type Facts = {
  invoiceId: string;
  payer: string;
  nonce: string;
  method: TransferMethod;
  expiresAt: number;
  amountMicros: number;
  requestHash: string;
  sku: string;
  /** Hash of the replay token this request presented, if it presented one. */
  tokenHash?: string;
};

type Seen = { facts: Facts; pid?: { id: string; base: string; slot: number } };

type Claim = {
  /**
   * fresh       a new payment; this request owns the claim.
   * replay      the same settled payment again, holding its replay token.
   * replay_pid  a new signature for a purchase that already settled; it is
   *             verified, then answered from the store and never settled.
   * resume      the same payment again, finishing a settle that never landed.
   */
  mode: "fresh" | "replay" | "replay_pid" | "resume";
  invoiceId: string;
  quote: Quote;
  seq: number;
  state: State;
};

type StoredResponse = {
  /** False when the body was too large or not JSON/HTML: settled, but a retry cannot get it back. */
  replayable: boolean;
  contentType: string;
  body?: unknown;
  /** SHA-256 of the response bytes as sent. */
  hash: string;
  bytes: number;
};

class UnsupportedPayment extends Error {}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const abort = (reason: string, message: string): Abort => ({ abort: true, reason, message });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * How the chain itself tells one payment from another.
 *
 * An EIP-3009 authorization or a Permit2 permit can move money exactly once,
 * and (payer, nonce) is what the contract checks to enforce that. Keying the
 * journal the same way means "the same payment" here is the same thing it is
 * on chain, however the header was re-encoded or re-sent.
 */
function identify(
  payload: X402Payload,
  requirements: X402Requirements,
): { key: string; payer: string; nonce: string; method: TransferMethod; expirySeconds: unknown } {
  const body = payload.payload ?? {};
  const auth = record(body.authorization);
  const permit = record(body.permit2Authorization);
  const evm = (payer: string, nonce: string, method: TransferMethod) =>
    [method, requirements.network, requirements.asset.toLowerCase(), payer.toLowerCase(), nonce.toLowerCase()].join(
      "\u0000",
    );

  const authFrom = text(auth?.from);
  const authNonce = text(auth?.nonce);
  if (authFrom && authNonce) {
    return {
      key: evm(authFrom, authNonce, "eip3009"),
      payer: authFrom,
      nonce: authNonce,
      method: "eip3009",
      expirySeconds: auth?.validBefore,
    };
  }
  const permitFrom = text(permit?.from);
  const permitNonce = permit?.nonce === undefined ? undefined : String(permit.nonce);
  if (permitFrom && permitNonce) {
    return {
      key: evm(permitFrom, permitNonce, "permit2"),
      payer: permitFrom,
      nonce: permitNonce,
      method: "permit2",
      expirySeconds: permit?.deadline,
    };
  }
  // A scheme this bridge does not know. The signed payload is still a stable
  // identity: the same bytes are the same payment.
  const digest = sha256Hex(canonicalJson(body));
  return {
    key: ["opaque", requirements.network, requirements.asset, digest].join("\u0000"),
    payer: "",
    nonce: digest,
    method: "opaque",
    expirySeconds: undefined,
  };
}

/** The journal id of an x402 payment. Stable across retries of the same signed payment. */
export function x402InvoiceId(payload: X402Payload, requirements: X402Requirements): string {
  return PREFIX + sha256Hex(identify(payload, requirements).key).slice(0, 40);
}

/** What the request was, so a stored response is only ever replayed to the request that bought it. */
function describeRequest(payload: X402Payload, transportContext: unknown): { hash: string; sku: string } {
  const request = record(record(transportContext)?.request);
  if (!request) {
    const url = payload.resource?.url ?? "";
    return { hash: hashRequest({ url }), sku: url };
  }
  const adapter = record(request.adapter);
  const path = text(request.decodedPath) ?? text(request.path) ?? "";
  const method = (text(request.method) ?? "").toUpperCase();
  let query: unknown = {};
  try {
    if (typeof adapter?.getQueryParams === "function") {
      query = (adapter.getQueryParams as () => unknown).call(adapter) ?? {};
    }
  } catch {
    query = {};
  }
  return { hash: hashRequest({ method, path, query }), sku: text(request.routePattern) ?? path };
}

function tokenHashOf(payload: X402Payload): string | undefined {
  const token = record(record(payload.extensions?.[EXTENSION])?.info)?.token;
  return typeof token === "string" && TOKEN.test(token) ? sha256Hex(token) : undefined;
}

function paymentIdOf(payload: X402Payload): string | undefined {
  const id = record(record(payload.extensions?.["payment-identifier"])?.info)?.id;
  return typeof id === "string" && PAYMENT_ID.test(id) ? id : undefined;
}

export function latchX402(server: X402HookRegistry, options: X402LatchOptions): X402Latch {
  const journal = options.journal;
  const clock = options.clock ?? systemClock;
  const staleMs = options.staleMs ?? 120_000;
  const replayWindowMs = options.replayWindowMs ?? 600_000;
  const maxResponseBytes = options.maxResponseBytes ?? 262_144;
  const maxSettleAttempts = Math.max(1, options.maxSettleAttempts ?? 3);
  const expiryGraceMs = options.expiryGraceMs ?? 60_000;
  const schemes = new Set(options.schemes ?? ["exact"]);
  const covers = (ctx: X402VerifyContext): boolean => schemes.has(ctx.requirements.scheme);

  // Per-request memory, keyed by the payload object the SDK threads through
  // every hook of one request. It records which request holds the claim, so a
  // duplicate that lost the race can never advance or void the winner's
  // invoice. It is a cache of intent, not of truth: every write it leads to is
  // still a compare-and-set against the journal.
  const seen = new WeakMap<object, Seen>();
  const claims = new WeakMap<object, Claim>();

  const alarm = (a: X402Alarm): void => {
    try {
      options.onAlarm?.(a);
    } catch {
      // An alarm handler that throws must not take a payment down with it.
    }
  };

  const resKey = (invoiceId: string) => `x402res_${invoiceId}`;
  const setKey = (invoiceId: string) => `x402set_${invoiceId}`;

  function factsOf(ctx: X402VerifyContext): Facts {
    const { paymentPayload: payload, requirements } = ctx;
    const id = identify(payload, requirements);

    const raw = requirements.amount ?? requirements.maxAmountRequired ?? "";
    const amountMicros = /^\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!isMicros(amountMicros)) {
      // Integer-only money, as everywhere in Latch. An amount that does not fit
      // is refused before verification rather than recorded wrongly.
      throw new UnsupportedPayment(`Amount "${raw}" is outside the range Latch can account for`);
    }

    const seconds = Number(id.expirySeconds);
    const expiresAt =
      Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : clock.now() + (requirements.maxTimeoutSeconds ?? 300) * 1000;

    const request = describeRequest(payload, ctx.transportContext);
    const tokenHash = tokenHashOf(payload);
    return {
      ...(tokenHash ? { tokenHash } : {}),
      invoiceId: PREFIX + sha256Hex(id.key).slice(0, 40),
      payer: id.payer,
      nonce: id.nonce,
      method: id.method,
      expiresAt,
      amountMicros,
      requestHash: request.hash,
      sku: request.sku,
    };
  }

  async function advance(
    invoiceId: string,
    from: State,
    fromSeq: number,
    to: State,
    evidence: Record<string, unknown>,
  ): Promise<number> {
    if (!(LEGAL[from] ?? []).includes(to)) throw new Error(`Illegal x402 transition: ${from} -> ${to}`);
    const entry = await journal.append({ invoiceId, state: to, at: clock.now(), evidence }, fromSeq);
    return entry.seq;
  }

  const lastAt = (snap: InvoiceSnapshot): number => snap.entries[snap.entries.length - 1]?.at ?? 0;
  const isStale = (snap: InvoiceSnapshot): boolean => clock.now() - lastAt(snap) > staleMs;

  function methodOf(snap: InvoiceSnapshot): TransferMethod {
    for (const e of snap.entries) {
      const m = e.evidence.method;
      if (m === "eip3009" || m === "permit2" || m === "opaque") return m;
    }
    return "opaque";
  }

  /**
   * Did this payment move money? "cannot_land" is only ever concluded from an
   * oracle that answered AFTER the payment expired: an authorization that is
   * unused past its own deadline can no longer be used.
   */
  async function statusOf(snap: InvoiceSnapshot): Promise<"settled" | "cannot_land" | "pending" | "unknown"> {
    if (!options.oracle) return "unknown";
    const { quote } = snap;
    const expired = clock.now() > quote.expiresAt + expiryGraceMs;
    let answer: "settled" | "unsettled";
    try {
      answer = await options.oracle({
        network: quote.network,
        asset: quote.asset,
        payer: quote.payer,
        nonce: quote.nonce,
        method: methodOf(snap),
        expiresAt: quote.expiresAt,
      });
    } catch {
      return "unknown";
    }
    if (answer === "settled") return "settled";
    return expired ? "cannot_land" : "pending";
  }

  async function writeReceipt(
    quote: Quote,
    fields: { resultHash: string | null; settlementRef: string | null },
  ): Promise<void> {
    const signer = options.signer;
    if (!signer) return;
    try {
      await journal.appendReceipt((prev) =>
        issueReceipt(
          {
            version: 1,
            invoiceId: quote.invoiceId,
            outcome: "delivered",
            payer: quote.payer,
            payTo: quote.payTo,
            chargedMicros: quote.amountMicros,
            asset: quote.asset,
            network: quote.network,
            requestHash: quote.requestHash,
            resultHash: fields.resultHash,
            settlementRef: fields.settlementRef,
            refundRef: null,
            issuedAt: clock.now(),
            prev: prev || GENESIS,
          },
          signer,
        ),
      );
    } catch (error) {
      // The receipt is evidence, not the sale. A payment that settled stays
      // settled; the missing receipt is reported.
      alarm({ kind: "journal_error", invoiceId: quote.invoiceId, error });
    }
  }

  /**
   * A crash between the `delivered` entry and its receipt leaves a finished
   * payment with no evidence attached. The money is already right; this
   * repairs the paper trail the next time the payment is seen.
   */
  async function backfillReceipt(snap: InvoiceSnapshot): Promise<void> {
    if (!options.signer) return;
    const chain = await journal.readChain();
    if (chain.some((link) => link.receipt.invoiceId === snap.quote.invoiceId)) return;
    let reference: string | null = null;
    for (const e of snap.entries) {
      if (typeof e.evidence.reference === "string" && e.evidence.reference) reference = e.evidence.reference;
    }
    const response = await storedResponse(snap.quote.invoiceId);
    await writeReceipt(snap.quote, { resultHash: response?.hash || null, settlementRef: reference });
  }

  async function storedResponse(invoiceId: string): Promise<StoredResponse | undefined> {
    return (await journal.getResult(resKey(invoiceId)))?.payload as StoredResponse | undefined;
  }

  /** Close the books on a payment whose settle the chain confirms. */
  async function markDelivered(
    snap: InvoiceSnapshot,
    settle: X402SettleResponse,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    const id = snap.quote.invoiceId;
    await journal.putResult(setKey(id), clone(settle));
    await advance(id, "settling", snap.seq, "delivered", { reference: settle.transaction, ...evidence });
    const response = await storedResponse(id);
    await writeReceipt(snap.quote, {
      resultHash: response?.hash || null,
      settlementRef: settle.transaction || null,
    });
  }

  /**
   * Settle the one ambiguous state against the chain. Never initiates a
   * charge: it only learns what already happened, or that nothing still can.
   */
  async function resolveSettling(snap: InvoiceSnapshot): Promise<State> {
    const id = snap.quote.invoiceId;
    try {
      const status = await statusOf(snap);
      if (status === "settled") {
        await markDelivered(
          snap,
          {
            success: true,
            transaction: "",
            network: snap.quote.network as X402SettleResponse["network"],
            payer: snap.quote.payer,
          },
          { recovered: true },
        );
        return "delivered";
      }
      if (status === "cannot_land") {
        await advance(id, "settling", snap.seq, "void", { reason: "settlement_never_landed", confirmed: true });
        return "void";
      }
      if (status === "unknown" && clock.now() > snap.quote.expiresAt + expiryGraceMs) {
        // Expired, and nothing can say whether it landed first. Guessing
        // "void" could hide a charge; guessing "delivered" could invent one.
        await advance(id, "settling", snap.seq, "stuck", { reason: "settlement_outcome_unknown" });
        alarm({ kind: "stuck", invoiceId: id });
        return "stuck";
      }
      return "settling";
    } catch (error) {
      if (error instanceof JournalConflictError) {
        // Another worker resolved it first. Theirs is the answer.
        return (await journal.get(id))?.state ?? "settling";
      }
      throw error;
    }
  }

  /** Void a claim whose worker is gone. Losing the race to do so is fine. */
  async function abandon(snap: InvoiceSnapshot): Promise<void> {
    try {
      await advance(snap.quote.invoiceId, snap.state, snap.seq, "void", { reason: "abandoned" });
    } catch (error) {
      if (!(error instanceof JournalConflictError)) throw error;
    }
  }

  function tokenHashFrom(snap: InvoiceSnapshot): string | undefined {
    for (const e of snap.entries) {
      if (typeof e.evidence.tokenHash === "string") return e.evidence.tokenHash;
    }
    return undefined;
  }

  /** Does this request hold the replay token the purchase was made with? */
  function holdsToken(snap: InvoiceSnapshot, facts: Facts): boolean {
    const expected = tokenHashFrom(snap);
    return !!expected && !!facts.tokenHash && timingSafeEqualHex(expected, facts.tokenHash);
  }

  const used = (why: string) => abort("payment_already_used", `This payment has already settled; ${why}`);

  /** Why a delivered payment's response may not be given out again, if it may not. */
  function notReplayable(snap: InvoiceSnapshot, facts: Facts, response: StoredResponse | undefined): Abort | undefined {
    if (replayWindowMs <= 0) return used("replay is disabled");
    if (snap.quote.requestHash !== facts.requestHash) return used("it paid for a different request");
    if (clock.now() - lastAt(snap) > replayWindowMs) return used("its replay window has closed");
    if (!response?.replayable) return used("its response was not stored for replay");
    return undefined;
  }

  function replay(payload: object, snap: InvoiceSnapshot, facts: Facts, response: StoredResponse | undefined) {
    const refusal = notReplayable(snap, facts, response);
    if (refusal) return refusal;
    // The payment itself proves nothing by now: everything in it is public.
    if (!holdsToken(snap, facts)) return used("the request does not hold this purchase's replay token");
    claims.set(payload, {
      mode: "replay",
      invoiceId: snap.quote.invoiceId,
      quote: snap.quote,
      seq: snap.seq,
      state: "delivered",
    });
    // Skips the facilitator: a settled authorization would fail verification,
    // and this request moves no money.
    return { skip: true as const, result: { isValid: true, payer: snap.quote.payer } };
  }

  const pidBase = (payTo: string, id: string) =>
    `x402pid_${sha256Hex(`${payTo.toLowerCase()}\u0000${id}`).slice(0, 40)}`;

  /**
   * Who owns a client-chosen payment identifier. A purchase that ended `void`
   * gives the identifier up, so a failed attempt never blocks an honest retry.
   */
  async function pidOwner(
    payTo: string,
    id: string,
  ): Promise<{ kind: "owned"; snap: InvoiceSnapshot } | { kind: "free"; base: string; slot: number } | { kind: "exhausted" }> {
    const base = pidBase(payTo, id);
    for (let slot = 0; slot < MAX_PID_SLOTS; slot++) {
      const held = await journal.getResult(`${base}_${slot}`);
      if (!held) return { kind: "free", base, slot };
      const owner = text(record(held.payload)?.invoiceId);
      const snap = owner ? await journal.get(owner) : undefined;
      if (snap && snap.state !== "void") return { kind: "owned", snap };
    }
    return { kind: "exhausted" };
  }

  /** Decide what a request may do about a payment the journal already knows. */
  async function decide(
    payload: object,
    facts: Facts,
    snap: InvoiceSnapshot,
    own: boolean,
  ): Promise<BeforeVerifyDirective | "retry"> {
    const busy = abort("payment_in_progress", "This payment is already being processed");
    switch (snap.state) {
      case "delivered": {
        await backfillReceipt(snap);
        const response = await storedResponse(snap.quote.invoiceId);
        if (own) return replay(payload, snap, facts, response);
        // A new signature for a purchase that already settled. Let the
        // facilitator verify it: only a valid payment from the same payer may
        // collect, and it is answered from the store without being settled.
        const refusal = notReplayable(snap, facts, response);
        if (refusal) return refusal;
        claims.set(payload, {
          mode: "replay_pid",
          invoiceId: snap.quote.invoiceId,
          quote: snap.quote,
          seq: snap.seq,
          state: "delivered",
        });
        return undefined;
      }

      case "quoted":
      case "producing": {
        if (!isStale(snap)) return busy;
        // The worker died before any money moved. Close the claim.
        await abandon(snap);
        if (!own) return "retry";
        return abort("payment_abandoned", "This payment attempt was abandoned; nothing was charged. Sign a new payment");
      }

      case "settling": {
        if (!isStale(snap)) return busy;
        const state = await resolveSettling(snap);
        if (state !== "settling") return "retry";
        // Not landed, and still able to. Only the payment's own signature may
        // finish it, and only for the request it was made for.
        if (!own || snap.quote.requestHash !== facts.requestHash) return busy;
        if (tokenHashFrom(snap) && !holdsToken(snap, facts)) return busy;
        claims.set(payload, {
          mode: "resume",
          invoiceId: snap.quote.invoiceId,
          quote: snap.quote,
          seq: snap.seq,
          state: "settling",
        });
        // Fall through to the facilitator: a payment it still verifies is one
        // that has not landed, so finishing the settle cannot charge twice.
        return undefined;
      }

      default:
        return own
          ? abort("payment_closed", `This payment is closed (${snap.state})`)
          : abort("payment_identifier_reused", `This purchase is closed (${snap.state})`);
    }
  }

  // A fresh token on every 402. `dynamicInfoFields` tells the SDK the value
  // changes per response, so the client's echo of an earlier one still matches.
  server.registerExtension?.({
    key: EXTENSION,
    dynamicInfoFields: ["token"],
    enrichDeclaration: (declaration) => {
      const d = record(declaration) ?? {};
      return { ...d, info: { ...(record(d.info) ?? {}), token: randomHex(16) } };
    },
  });

  server.onBeforeVerify(async (ctx) => {
    if (!covers(ctx)) return;
    const payload = ctx.paymentPayload;
    try {
      const facts = factsOf(ctx);
      const mine: Seen = { facts };
      seen.set(payload, mine);
      const pid = paymentIdOf(payload);

      // A decision can change the journal (closing a dead claim, learning a
      // settle landed), after which the question is asked once more.
      for (let pass = 0; pass < 3; pass++) {
        delete mine.pid;
        if (pid) {
          const owner = await pidOwner(ctx.requirements.payTo, pid);
          if (owner.kind === "exhausted") {
            return abort("payment_identifier_exhausted", "Too many failed attempts under this payment identifier");
          }
          if (owner.kind === "free") {
            mine.pid = { id: pid, base: owner.base, slot: owner.slot };
          } else if (owner.snap.quote.invoiceId !== facts.invoiceId) {
            // The same purchase, signed again. The first signature is the one
            // that counts; this one must never be charged.
            const verdict = await decide(payload, facts, owner.snap, false);
            if (verdict === "retry") continue;
            return verdict;
          }
        }
        const snap = await journal.get(facts.invoiceId);
        if (!snap) return; // New payment. It is claimed once the facilitator verifies it.
        const verdict = await decide(payload, facts, snap, true);
        if (verdict === "retry") continue;
        return verdict;
      }
      return abort("payment_in_progress", "This payment is already being processed");
    } catch (error) {
      if (error instanceof UnsupportedPayment) return abort("latch_unsupported_payment", error.message);
      alarm({ kind: "journal_error", error });
      return abort("latch_unavailable", "Payment journal unavailable; nothing was charged");
    }
  });

  server.onAfterVerify(async (ctx): Promise<AfterVerifyDirective> => {
    if (!covers(ctx)) return;
    const payload = ctx.paymentPayload;
    // The SDK only logs a throw from this hook and carries on, which would run
    // the handler for an unclaimed payment. Every failure here must therefore
    // come back as an explicit abort.
    try {
      const held = claims.get(payload);
      if (held && held.mode !== "fresh") {
        if (!ctx.result.isValid) {
          // A resumed payment the facilitator no longer accepts. Whether that
          // is because it landed is the sweep's question, not this request's.
          claims.delete(payload);
          return;
        }
        if (held.mode === "replay_pid") {
          const payer = (identify(payload, ctx.requirements).payer || ctx.result.payer || "").toLowerCase();
          if (!payer || payer !== held.quote.payer.toLowerCase()) {
            claims.delete(payload);
            return abort("payment_identifier_reused", "This payment identifier belongs to another payer's purchase");
          }
        }
        const response = await storedResponse(held.invoiceId);
        if (!response?.replayable) {
          claims.delete(payload);
          return abort("payment_in_progress", "This payment's response was not stored; it cannot be finished here");
        }
        return { skipHandler: true, response: { contentType: response.contentType, body: clone(response.body) } };
      }

      if (!ctx.result.isValid) return; // Never claimed, so nothing to undo.

      const mine = seen.get(payload);
      if (!mine) return abort("latch_unavailable", "Payment was verified without being seen first");
      const { facts } = mine;
      const { requirements } = ctx;
      const quote: Quote = {
        invoiceId: facts.invoiceId,
        sku: facts.sku,
        amountMicros: facts.amountMicros,
        payTo: requirements.payTo,
        network: requirements.network,
        asset: requirements.asset,
        payer: facts.payer || ctx.result.payer || "",
        requestHash: facts.requestHash,
        nonce: facts.nonce,
        expiresAt: facts.expiresAt,
      };

      // The claim. `open` is atomic, so of any number of concurrent copies of
      // this payment exactly one gets past this line and runs the handler.
      try {
        await journal.open(quote);
      } catch (error) {
        if (await journal.get(quote.invoiceId)) {
          return abort("payment_in_progress", "This payment is already being processed");
        }
        throw error;
      }
      const seq = await advance(quote.invoiceId, "quoted", 0, "producing", {
        flow: "authorization",
        method: facts.method,
        ...(facts.tokenHash ? { tokenHash: facts.tokenHash } : {}),
        ...(mine.pid ? { paymentId: mine.pid.id } : {}),
      });

      if (mine.pid) {
        // First write wins. Two different signatures racing for one purchase
        // both reach here; the one that does not own the slot stands down
        // before its handler runs.
        const slot = `${mine.pid.base}_${mine.pid.slot}`;
        await journal.putResult(slot, { invoiceId: quote.invoiceId });
        const owner = text(record((await journal.getResult(slot))?.payload)?.invoiceId);
        if (owner !== quote.invoiceId) {
          await advance(quote.invoiceId, "producing", seq, "void", { reason: "payment_identifier_race" });
          return abort("payment_in_progress", "Another payment for this purchase is being processed");
        }
      }

      claims.set(payload, { mode: "fresh", invoiceId: quote.invoiceId, quote, seq, state: "producing" });
      return;
    } catch (error) {
      alarm({ kind: "journal_error", error });
      return abort("latch_unavailable", "Payment journal unavailable; nothing was charged");
    }
  });

  function capture(transportContext: unknown): StoredResponse {
    const t = record(transportContext);
    const raw = t?.responseBody;
    const bytes =
      raw instanceof Uint8Array ? raw : typeof raw === "string" ? new TextEncoder().encode(raw) : undefined;
    if (!bytes) return { replayable: false, contentType: "", hash: "", bytes: 0 };

    const headers = record(t?.responseHeaders) ?? {};
    const name = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
    const contentType = (name && text(headers[name])) || "application/json";
    const base = { contentType, hash: toHex(sha256(bytes)), bytes: bytes.length };
    if (bytes.length > maxResponseBytes) return { replayable: false, ...base };

    // The SDK's replay path can return a JSON value or an HTML string, so those
    // are what can be given back faithfully. Anything else is settled and
    // hashed, but not replayable.
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { replayable: false, ...base };
    }
    if (/json/i.test(contentType)) {
      try {
        return { replayable: true, body: JSON.parse(decoded), ...base };
      } catch {
        return { replayable: false, ...base };
      }
    }
    if (/^text\/html/i.test(contentType)) return { replayable: true, body: decoded, ...base };
    return { replayable: false, ...base };
  }

  // A throw from this hook fails the settle closed before the facilitator is
  // called, which is exactly what a failed write-ahead must do.
  server.onBeforeSettle(async (ctx) => {
    if (!covers(ctx)) return;
    if (ctx.phase !== "after-handler") {
      throw new Error(
        "latch402 supports the x402 `authorization` payment flow only; this route settles before its handler",
      );
    }
    const held = claims.get(ctx.paymentPayload);
    if (!held) throw new Error("latch402: payment reached settlement without a journal claim");

    if (held.mode === "replay" || held.mode === "replay_pid") {
      const settled = await journal.getResult(setKey(held.invoiceId));
      if (!settled) throw new Error("latch402: delivered payment has no stored settlement");
      // Already settled once. Hand back that settlement; the facilitator is not called.
      return { skip: true, result: clone(settled.payload as X402SettleResponse) };
    }

    if (held.mode === "fresh") {
      // Store the good BEFORE asking for the money, so that whatever happens
      // to this process next, a payment that lands has something to deliver.
      const response = capture(ctx.transportContext);
      await journal.putResult(resKey(held.invoiceId), response);
      held.seq = await advance(held.invoiceId, "producing", held.seq, "settling", {
        attempt: 1,
        resultHash: response.hash,
        replayable: response.replayable,
      });
      held.state = "settling";
      return;
    }

    const snap = await journal.get(held.invoiceId);
    const attempts = snap ? snap.entries.filter((e) => e.state === "settling").length : 0;
    if (attempts >= maxSettleAttempts) throw new Error("latch402: settle attempts exhausted for this payment");
    held.seq = await advance(held.invoiceId, "settling", held.seq, "settling", {
      attempt: attempts + 1,
      reentry: true,
    });
    return;
  });

  server.onAfterSettle(async (ctx) => {
    if (!covers(ctx)) return;
    const payload = ctx.paymentPayload;
    const held = claims.get(payload);
    if (!held || held.mode === "replay" || held.mode === "replay_pid") return;
    claims.delete(payload);
    const id = held.invoiceId;
    try {
      await journal.putResult(setKey(id), clone(ctx.result));
      await advance(id, "settling", held.seq, "delivered", {
        reference: ctx.result.transaction,
        ...(ctx.result.payer ? { payer: ctx.result.payer } : {}),
      });
      const response = await storedResponse(id);
      await writeReceipt(held.quote, {
        resultHash: response?.hash || null,
        settlementRef: ctx.result.transaction || null,
      });
    } catch (error) {
      // The sweep may have already recorded this settle from the chain.
      if (error instanceof JournalConflictError && (await journal.get(id))?.state === "delivered") return;
      // The money has moved, so the good goes out regardless: failing the
      // response now would be charging for nothing. The journal still says
      // `settling`, and the sweep reconciles it against the chain.
      alarm({ kind: "settled_unrecorded", invoiceId: id, error });
    }
  });

  // Never take "it failed" at face value. A settle can broadcast and then time
  // out, or land and lose its response. The chain is asked before anything is
  // concluded, and an unclear answer leaves the payment in `settling`.
  server.onSettleFailure(async (ctx) => {
    if (!covers(ctx)) return;
    const payload = ctx.paymentPayload;
    const held = claims.get(payload);
    if (!held || held.mode === "replay" || held.mode === "replay_pid" || held.state !== "settling") return;
    const id = held.invoiceId;
    try {
      const snap = await journal.get(id);
      if (!snap || snap.state !== "settling") return;
      const status = await statusOf(snap);

      if (status === "settled") {
        const settled: X402SettleResponse = {
          success: true,
          transaction: text(record(ctx.error)?.transaction) ?? "",
          network: ctx.requirements.network as X402SettleResponse["network"],
          payer: held.quote.payer,
        };
        await markDelivered(snap, settled, { recovered: true, reported: ctx.error.message });
        claims.delete(payload);
        // The money moved, so the caller gets what it paid for.
        return { recovered: true, result: settled };
      }
      if (status === "cannot_land") {
        await advance(id, "settling", snap.seq, "void", { reason: ctx.error.message, confirmed: true });
        claims.delete(payload);
        return;
      }
      alarm({ kind: "settlement_unresolved", invoiceId: id, error: ctx.error });
    } catch (error) {
      alarm({ kind: "journal_error", invoiceId: id, error });
    }
    return;
  });

  // The handler failed, threw, or the settle never reached the facilitator.
  // On this flow nothing has been charged, so the claim simply closes.
  server.onVerifiedPaymentCanceled(async (ctx) => {
    if (!covers(ctx)) return;
    const payload = ctx.paymentPayload;
    const held = claims.get(payload);
    // Only a first attempt may be voided here: a resumed payment's earlier
    // settle may still land, and that is for the chain to say.
    if (!held || held.mode !== "fresh") return;
    claims.delete(payload);
    try {
      await advance(held.invoiceId, held.state, held.seq, "void", {
        reason: ctx.reason,
        ...(ctx.responseStatus !== undefined ? { responseStatus: ctx.responseStatus } : {}),
      });
    } catch (error) {
      if (!(error instanceof JournalConflictError)) alarm({ kind: "journal_error", invoiceId: held.invoiceId, error });
    }
  });

  async function recover(invoiceId: string): Promise<State> {
    if (!invoiceId.startsWith(PREFIX)) throw new Error("Not an x402 payment");
    const snap = await journal.get(invoiceId);
    if (!snap) throw new Error("Unknown invoice");
    switch (snap.state) {
      case "quoted":
      case "producing":
        // A claim with no worker. No money moved; close it. A worker that is
        // merely slow loses its compare-and-set at settle time and fails
        // closed, uncharged.
        if (!isStale(snap)) return snap.state;
        await abandon(snap);
        return (await journal.get(invoiceId))?.state ?? "void";
      case "settling":
        if (!isStale(snap)) return snap.state;
        return resolveSettling(snap);
      default:
        return snap.state;
    }
  }

  return {
    recover,

    declare() {
      return {
        [EXTENSION]: {
          info: { version: 1 },
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { version: { type: "number" }, token: { type: "string", pattern: "^[0-9a-f]{32}$" } },
            required: ["version"],
          },
        },
      };
    },

    async sweep(olderThanMs = staleMs, limit = 100) {
      const ids = await journal.findInFlight(clock.now() - olderThanMs, limit);
      const out: { invoiceId: string; state: State }[] = [];
      for (const id of ids) {
        if (!id.startsWith(PREFIX)) continue;
        try {
          out.push({ invoiceId: id, state: await recover(id) });
        } catch {
          // One poisoned payment must not stop the sweep.
        }
      }
      return out;
    },

    chain() {
      return journal.readChain();
    },
  };
}
