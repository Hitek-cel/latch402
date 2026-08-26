import { JournalConflictError, LatchError } from "./errors.ts";
import { deriveIdempotencyKey, hashRequest, newInvoiceId, newNonce } from "./ids.ts";
import { assertMicros } from "./money.ts";
import { assertTransition, isTerminal, type State } from "./states.ts";
import {
  GENESIS,
  hashReceipt,
  issueReceipt,
  type Receipt,
  type SignedReceipt,
  type Signer,
} from "./receipt.ts";
import {
  systemClock,
  type Clock,
  type Facilitator,
  type Journal,
  type JournalEntry,
  type Producer,
  type Quote,
  type SettleOutcome,
} from "./ports.ts";

export type GateConfig = {
  payTo: string;
  network?: string;
  asset?: string;
  /** How long a quote stays payable. Short by design: an unpaid quote is an open liability. */
  quoteTtlMs?: number;
  /** Hard ceiling on producer wall-clock time. Exceeding it refunds; it never hangs. */
  produceTimeoutMs?: number;
  /** How many times a recovered invoice may re-enter production before we refund instead. */
  maxProduceAttempts?: number;
};

export type GateDeps<TReq, TRes> = {
  journal: Journal;
  facilitator: Facilitator;
  producer: Producer<TReq, TRes>;
  signer: Signer;
  clock?: Clock;
};

export type PaymentRequired = {
  x402Version: 1;
  error: "Payment required";
  accepts: {
    scheme: "exact";
    network: string;
    asset: string;
    maxAmountRequired: string;
    resource: string;
    payTo: string;
    mimeType: "application/json";
    extra: {
      invoiceId: string;
      sku: string;
      nonce: string;
      expiresAt: number;
      requestHash: string;
    };
  }[];
};

export type RedeemResult<TRes> = {
  result: TRes;
  receipt: SignedReceipt;
  /** True when this came from the idempotency cache rather than fresh production. */
  replayed: boolean;
};

/**
 * The gate.
 *
 * Two entry points matter: `quote` opens a priced invoice, `redeem` takes a
 * payment proof and either delivers the good or leaves the caller un-charged.
 * Everything else is recovery.
 *
 * The ordering rule the whole thing exists to enforce:
 *
 *     settle -> journal the settlement -> THEN produce.
 *
 * Producing first is how a gate gives goods away for free. Producing without a
 * compensating refund path is how it quietly steals. Both are ruled out below.
 */
export class Latch<TReq, TRes> {
  private readonly cfg: Required<GateConfig>;
  private readonly d: GateDeps<TReq, TRes>;
  private readonly clock: Clock;

  constructor(config: GateConfig, deps: GateDeps<TReq, TRes>) {
    this.cfg = {
      payTo: config.payTo,
      network: config.network ?? "base",
      asset: config.asset ?? "USDC",
      quoteTtlMs: config.quoteTtlMs ?? 120_000,
      produceTimeoutMs: config.produceTimeoutMs ?? 12_000,
      // At least one attempt: a cap of zero would try to refund straight from
      // `settled`, which is not a legal transition.
      maxProduceAttempts: Math.max(1, config.maxProduceAttempts ?? 2),
    };
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
  }

  /** Open a priced invoice, bound to one payer and one exact request. */
  async quote(input: {
    payer: string;
    sku: string;
    amountMicros: number;
    request: TReq;
    resource?: string;
  }): Promise<{ quote: Quote; payment: PaymentRequired }> {
    if (!input.payer) throw new LatchError("bad_request", "Missing payer id");
    assertMicros(input.amountMicros);

    const quote: Quote = {
      invoiceId: newInvoiceId(),
      sku: input.sku,
      amountMicros: input.amountMicros,
      payTo: this.cfg.payTo,
      network: this.cfg.network,
      asset: this.cfg.asset,
      payer: input.payer,
      requestHash: hashRequest(input.request),
      nonce: newNonce(),
      expiresAt: this.clock.now() + this.cfg.quoteTtlMs,
    };
    await this.d.journal.open(quote);

    return {
      quote,
      payment: {
        x402Version: 1,
        error: "Payment required",
        accepts: [
          {
            scheme: "exact",
            network: quote.network,
            asset: quote.asset,
            maxAmountRequired: String(quote.amountMicros),
            resource: input.resource ?? "/",
            payTo: quote.payTo,
            mimeType: "application/json",
            extra: {
              invoiceId: quote.invoiceId,
              sku: quote.sku,
              nonce: quote.nonce,
              expiresAt: quote.expiresAt,
              requestHash: quote.requestHash,
            },
          },
        ],
      },
    };
  }

  /**
   * Pay and collect. Safe to call twice with the same arguments: the second
   * call returns the first call's result and does not charge again.
   */
  async redeem(input: {
    invoiceId: string;
    payer: string;
    proof: string;
    request: TReq;
  }): Promise<RedeemResult<TRes>> {
    const snap = await this.d.journal.get(input.invoiceId);
    if (!snap) throw new LatchError("unknown_invoice", "Unknown invoice");
    const { quote } = snap;

    if (quote.payer !== input.payer) {
      throw new LatchError("payer_mismatch", "Invoice belongs to a different payer");
    }
    if (hashRequest(input.request) !== quote.requestHash) {
      throw new LatchError("bad_request", "Request does not match the quoted request", {
        detail: { expected: quote.requestHash },
      });
    }

    const idempotencyKey = this.keyFor(quote);

    // Already finished: replay the stored outcome rather than charging twice.
    if (isTerminal(snap.state)) {
      await this.backfillReceipt(quote, snap.state, idempotencyKey);
      return this.replay(snap.state, idempotencyKey, quote);
    }
    // Crashed mid-flight: finish or compensate before starting anything new.
    if (snap.state !== "quoted") {
      await this.recover(input.invoiceId);
      const after = await this.d.journal.get(input.invoiceId);
      if (after && isTerminal(after.state)) {
        return this.replay(after.state, idempotencyKey, quote);
      }
      throw new LatchError("concurrent_attempt", "Invoice is already being processed", {
        retryable: true,
      });
    }

    if (this.clock.now() > quote.expiresAt) {
      await this.advance(snap.seq, quote, "void", { reason: "quote_expired" });
      await this.writeReceipt(quote, "void", { chargedMicros: 0 });
      throw new LatchError("invoice_expired", "Quote expired; request a new one");
    }

    // Persist the request before anything can charge for it. Recovery runs long
    // after the caller has gone, so if this is not durable the gate cannot
    // reproduce what was bought and is forced to refund a perfectly good sale.
    //
    // Privacy note for real deployments: this is caller-supplied content at
    // rest. Encrypt it, and purge it once the invoice reaches a terminal state.
    await this.d.journal.putResult(`req_${idempotencyKey}`, input.request);

    // Write-ahead: claim the invoice before touching the payment network. The
    // seq guard means a second concurrent redeem loses the race here and gets a
    // 409, instead of producing a second charge.
    let seq = await this.advance(snap.seq, quote, "verifying", {});

    const verdict = await this.d.facilitator.verify(input.proof, quote);
    if (!verdict.ok) {
      await this.advance(seq, quote, "void", { reason: verdict.reason });
      await this.writeReceipt(quote, "void", { chargedMicros: 0 });
      throw new LatchError("proof_invalid", `Payment proof rejected: ${verdict.reason}`);
    }
    if (verdict.amountMicros !== quote.amountMicros) {
      await this.advance(seq, quote, "void", {
        reason: "amount_mismatch",
        offered: verdict.amountMicros,
        required: quote.amountMicros,
      });
      await this.writeReceipt(quote, "void", { chargedMicros: 0 });
      throw new LatchError("amount_mismatch", "Payment does not cover the quoted amount", {
        detail: { offered: verdict.amountMicros, required: quote.amountMicros },
      });
    }

    // Exactly-once: a proof burns its nonce. Replaying a valid old proof dies here.
    const fresh = await this.d.journal.consumeNonce(verdict.nonce, quote.invoiceId);
    if (!fresh) {
      await this.advance(seq, quote, "void", { reason: "nonce_replayed", nonce: verdict.nonce });
      await this.writeReceipt(quote, "void", { chargedMicros: 0 });
      throw new LatchError("proof_replayed", "This payment proof has already been used");
    }

    // Record the idempotency key BEFORE settling. If the process dies during
    // settlement, recovery uses this key to ask the facilitator what actually
    // happened. Without it, a crash here is indistinguishable from a failure,
    // and that ambiguity is exactly where money goes missing.
    seq = await this.advance(seq, quote, "settling", { idempotencyKey });

    let outcome: SettleOutcome | undefined;
    let failure = "settlement_error";
    try {
      outcome = await this.d.facilitator.settle({ idempotencyKey, quote, proof: input.proof });
      if (!outcome.ok) failure = outcome.reason;
    } catch (err) {
      // A thrown settle is not a failed settle. It is an unknown one.
      outcome = undefined;
      failure = err instanceof Error ? err.message : String(err);
    }

    // Never take "it failed" at face value. A settle can move the money and
    // still report failure — a dropped response, a timeout after broadcast.
    // Trusting the return value here is precisely how a gate ends up recording
    // "nothing moved" over a charge that really happened.
    let reference: string;
    if (outcome && outcome.ok) {
      reference = outcome.reference;
    } else {
      const status = await this.confirmSettlement(idempotencyKey, seq, quote, failure);
      if (status === undefined) {
        throw new LatchError("settlement_failed", `Settlement failed: ${failure}`);
      }
      reference = status;
    }

    seq = await this.advance(seq, quote, "settled", { reference, amountMicros: quote.amountMicros });

    // The money is durably ours. Only now is it safe to spend compute.
    return this.deliver(seq, quote, input.request, idempotencyKey, reference);
  }

  /**
   * Finish an invoice that was interrupted. Idempotent, and safe to run from a
   * background sweep. This is what turns a crash from a loss into a delay.
   */
  async recover(invoiceId: string): Promise<State> {
    const snap = await this.d.journal.get(invoiceId);
    if (!snap) throw new LatchError("unknown_invoice", "Unknown invoice");
    const { quote, state } = snap;
    const idempotencyKey = this.keyFor(quote);

    if (isTerminal(state)) {
      // A crash between the terminal transition and the receipt would otherwise
      // leave a finished invoice with no evidence attached to it. The money is
      // already correct here; this repairs the paper trail.
      await this.backfillReceipt(quote, state, idempotencyKey);
      return state;
    }

    switch (state) {
      case "quoted": {
        if (this.clock.now() <= quote.expiresAt) return state;
        await this.advance(snap.seq, quote, "void", { reason: "quote_expired" });
        await this.writeReceipt(quote, "void", { chargedMicros: 0 });
        return "void";
      }

      case "verifying": {
        // Verification moves no money, so unwinding is free and always correct.
        await this.advance(snap.seq, quote, "void", { reason: "recovered_before_settlement" });
        await this.writeReceipt(quote, "void", { chargedMicros: 0 });
        return "void";
      }

      case "settling": {
        // The ambiguous case, and the entire reason statusOf exists.
        const status = await this.d.facilitator.statusOf(idempotencyKey);
        if (status.state === "pending") return state; // retry on the next sweep
        if (status.state === "unknown") {
          await this.advance(snap.seq, quote, "void", { reason: "settlement_never_landed" });
          await this.writeReceipt(quote, "void", { chargedMicros: 0 });
          return "void";
        }
        const seq = await this.advance(snap.seq, quote, "settled", {
          reference: status.reference,
          amountMicros: status.amountMicros,
          recovered: true,
        });
        return this.runProducer(seq, quote, idempotencyKey, status.reference);
      }

      case "settled":
      case "producing":
        return this.runProducer(snap.seq, quote, idempotencyKey, this.referenceFrom(snap.entries));

      case "refunding":
        return this.finishRefund(snap.seq, quote, idempotencyKey, this.referenceFrom(snap.entries));

      default:
        return state;
    }
  }

  /** Sweep every invoice left in-flight longer than `staleMs`. Run this on a timer. */
  async sweep(staleMs = 30_000, limit = 100): Promise<{ invoiceId: string; state: State }[]> {
    const ids = await this.d.journal.findInFlight(this.clock.now() - staleMs, limit);
    const out: { invoiceId: string; state: State }[] = [];
    for (const id of ids) {
      try {
        out.push({ invoiceId: id, state: await this.recover(id) });
      } catch {
        // One poisoned invoice must not stop the sweep.
      }
    }
    return out;
  }

  async chain(): Promise<SignedReceipt[]> {
    return this.d.journal.readChain();
  }

  // ---------------------------------------------------------------- internals

  private keyFor(quote: Quote): string {
    return deriveIdempotencyKey({
      invoiceId: quote.invoiceId,
      payer: quote.payer,
      amountMicros: quote.amountMicros,
      requestHash: quote.requestHash,
    });
  }

  private async advance(
    fromSeq: number,
    quote: Quote,
    to: State,
    evidence: Record<string, unknown>,
  ): Promise<number> {
    const snap = await this.d.journal.get(quote.invoiceId);
    if (!snap) throw new LatchError("unknown_invoice", "Invoice vanished mid-flight");
    assertTransition(snap.state, to);
    try {
      const entry = await this.d.journal.append(
        { invoiceId: quote.invoiceId, state: to, at: this.clock.now(), evidence },
        fromSeq,
      );
      return entry.seq;
    } catch (err) {
      if (err instanceof JournalConflictError) {
        throw new LatchError("concurrent_attempt", "Another worker is advancing this invoice", {
          retryable: true,
        });
      }
      // The journal itself is failing. Surface that loudly; a gate whose
      // write-ahead log is down must stop, not improvise.
      throw err;
    }
  }

  /**
   * Ask the payment network what actually happened after an unclear settle.
   *
   * Returns the settlement reference if the money moved, or undefined if it
   * provably did not. Anything genuinely undecided leaves the invoice in
   * `settling` and throws retryable, so the sweep resolves it later — an
   * invoice parked in-flight is recoverable, a wrongly-voided one is not.
   */
  private async confirmSettlement(
    idempotencyKey: string,
    seq: number,
    quote: Quote,
    failure: string,
  ): Promise<string | undefined> {
    let status: Awaited<ReturnType<Facilitator["statusOf"]>>;
    try {
      status = await this.d.facilitator.statusOf(idempotencyKey);
    } catch {
      throw new LatchError("settlement_failed", "Settlement status unknown; will be resolved", {
        retryable: true,
        detail: { invoiceId: quote.invoiceId },
      });
    }

    if (status.state === "settled") return status.reference;
    if (status.state === "pending") {
      throw new LatchError("settlement_failed", "Settlement pending; retry shortly", {
        retryable: true,
        detail: { invoiceId: quote.invoiceId },
      });
    }

    // Confirmed: no money moved. Safe to close with nothing charged.
    await this.advance(seq, quote, "void", { reason: failure, confirmed: true });
    await this.writeReceipt(quote, "void", { chargedMicros: 0 });
    return undefined;
  }

  private referenceFrom(entries: readonly JournalEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.state === "settled" && typeof e.evidence.reference === "string") {
        return e.evidence.reference;
      }
    }
    return "";
  }

  private async deliver(
    seq: number,
    quote: Quote,
    request: TReq,
    idempotencyKey: string,
    reference: string,
  ): Promise<RedeemResult<TRes>> {
    const state = await this.runProducer(seq, quote, idempotencyKey, reference, request);
    if (state === "delivered") {
      const cached = await this.d.journal.getResult(idempotencyKey);
      if (!cached) throw new LatchError("needs_operator", "Delivered invoice has no stored result");
      return {
        result: cached.payload as TRes,
        receipt: await this.receiptFor(quote.invoiceId),
        replayed: false,
      };
    }
    if (state === "refunded") {
      throw new LatchError("producer_failed", "Could not deliver; your payment was refunded", {
        detail: { invoiceId: quote.invoiceId },
      });
    }
    throw new LatchError("needs_operator", "Delivery failed and the refund did not go through", {
      detail: { invoiceId: quote.invoiceId },
    });
  }

  private async runProducer(
    seq: number,
    quote: Quote,
    idempotencyKey: string,
    reference: string,
    request?: TReq,
  ): Promise<State> {
    const snap = await this.d.journal.get(quote.invoiceId);
    if (!snap) throw new LatchError("unknown_invoice", "Invoice vanished mid-flight");

    const attempts = snap.entries.filter((e) => e.state === "producing").length;
    if (attempts >= this.cfg.maxProduceAttempts) {
      // Refusing to retry forever is a safety feature. A producer that crashes
      // on every attempt would otherwise hold the caller's money indefinitely.
      const from = snap.state === "producing" ? snap.seq : seq;
      const next = await this.advance(from, quote, "refunding", { reason: "max_produce_attempts" });
      return this.finishRefund(next, quote, idempotencyKey, reference);
    }

    // Every attempt appends an entry, including recovery re-entering an
    // invoice that died mid-produce. That entry is what makes the attempt
    // counter above real; reusing the old seq would retry forever.
    const from = snap.state === "producing" ? snap.seq : seq;
    const currentSeq = await this.advance(from, quote, "producing", {
      attempt: attempts + 1,
      ...(snap.state === "producing" ? { reentry: true } : {}),
    });

    // On the live path we have the request in hand. On the recovery path we
    // replay it from the journal, because the caller is long gone.
    const stored = await this.d.journal.getResult(`req_${idempotencyKey}`);
    const payload = (request ?? stored?.payload) as TReq | undefined;
    if (payload === undefined) {
      // Nothing to re-run from. The honest move is to give the money back.
      const next = await this.advance(currentSeq, quote, "refunding", {
        reason: "request_not_replayable",
      });
      return this.finishRefund(next, quote, idempotencyKey, reference);
    }

    const controller = new AbortController();
    const deadline = this.clock.now() + this.cfg.produceTimeoutMs;
    const timer = setTimeout(() => controller.abort(), this.cfg.produceTimeoutMs);

    let result: TRes;
    try {
      result = await this.d.producer.produce(payload, {
        invoiceId: quote.invoiceId,
        idempotencyKey,
        deadline,
        signal: controller.signal,
        budgetMicros: quote.amountMicros,
      });
    } catch (err) {
      const next = await this.advance(currentSeq, quote, "refunding", {
        reason: controller.signal.aborted ? "producer_timeout" : "producer_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return this.finishRefund(next, quote, idempotencyKey, reference);
    } finally {
      clearTimeout(timer);
    }

    // Store the good BEFORE marking delivered, so a crash between the two ends
    // up replaying a cached result rather than losing it. putResult is
    // first-write-wins, so if a crashed earlier attempt already stored a
    // result, THAT one is the good. Hash and deliver what is durably stored,
    // never the local value, or the signed receipt could attest a result the
    // caller does not receive.
    await this.d.journal.putResult(idempotencyKey, result);
    const durable = await this.d.journal.getResult(idempotencyKey);
    const good = (durable?.payload ?? result) as TRes;
    await this.advance(currentSeq, quote, "delivered", {
      resultHash: hashRequest(good),
      reference,
    });
    await this.writeReceipt(quote, "delivered", {
      chargedMicros: quote.amountMicros,
      resultHash: hashRequest(good),
      settlementRef: reference,
    });
    return "delivered";
  }

  private async finishRefund(
    seq: number,
    quote: Quote,
    idempotencyKey: string,
    reference: string,
  ): Promise<State> {
    const refund = await this.d.facilitator.refund({
      idempotencyKey: `refund_${idempotencyKey}`,
      quote,
      reference,
    });
    if (refund.ok) {
      await this.advance(seq, quote, "refunded", { refundRef: refund.reference });
      await this.writeReceipt(quote, "refunded", {
        chargedMicros: 0,
        settlementRef: reference,
        refundRef: refund.reference,
      });
      return "refunded";
    }
    // We are holding money we cannot honour and cannot return. Never silent.
    await this.advance(seq, quote, "stuck", { reason: refund.reason, settlementRef: reference });
    await this.writeReceipt(quote, "stuck", {
      chargedMicros: quote.amountMicros,
      settlementRef: reference,
    });
    return "stuck";
  }

  private async writeReceipt(
    quote: Quote,
    outcome: Receipt["outcome"],
    fields: {
      chargedMicros: number;
      resultHash?: string;
      settlementRef?: string;
      refundRef?: string;
    },
  ): Promise<SignedReceipt> {
    return this.d.journal.appendReceipt((prev) =>
      issueReceipt(
        {
          version: 1,
          invoiceId: quote.invoiceId,
          outcome,
          payer: quote.payer,
          payTo: quote.payTo,
          chargedMicros: fields.chargedMicros,
          asset: quote.asset,
          network: quote.network,
          requestHash: quote.requestHash,
          resultHash: fields.resultHash ?? null,
          settlementRef: fields.settlementRef ?? null,
          refundRef: fields.refundRef ?? null,
          issuedAt: this.clock.now(),
          prev: prev || GENESIS,
        },
        this.d.signer,
      ),
    );
  }

  /** Write the missing receipt for an invoice that reached a terminal state without one. */
  private async backfillReceipt(
    quote: Quote,
    state: State,
    idempotencyKey: string,
  ): Promise<void> {
    const chain = await this.d.journal.readChain();
    if (chain.some((link) => link.receipt.invoiceId === quote.invoiceId)) return;

    const snap = await this.d.journal.get(quote.invoiceId);
    const reference = snap ? this.referenceFrom(snap.entries) : "";

    if (state === "delivered") {
      const cached = await this.d.journal.getResult(idempotencyKey);
      await this.writeReceipt(quote, "delivered", {
        chargedMicros: quote.amountMicros,
        resultHash: cached ? hashRequest(cached.payload) : undefined,
        settlementRef: reference,
      });
      return;
    }
    if (state === "refunded") {
      await this.writeReceipt(quote, "refunded", { chargedMicros: 0, settlementRef: reference });
      return;
    }
    if (state === "stuck") {
      await this.writeReceipt(quote, "stuck", {
        chargedMicros: quote.amountMicros,
        settlementRef: reference,
      });
      return;
    }
    await this.writeReceipt(quote, "void", { chargedMicros: 0 });
  }

  private async receiptFor(invoiceId: string): Promise<SignedReceipt> {
    const chain = await this.d.journal.readChain();
    for (let i = chain.length - 1; i >= 0; i--) {
      const link = chain[i];
      if (link && link.receipt.invoiceId === invoiceId) return link;
    }
    throw new LatchError("needs_operator", "Receipt missing for a delivered invoice");
  }

  private async replay(
    state: State,
    idempotencyKey: string,
    quote: Quote,
  ): Promise<RedeemResult<TRes>> {
    if (state === "delivered") {
      const cached = await this.d.journal.getResult(idempotencyKey);
      if (!cached) throw new LatchError("needs_operator", "Delivered invoice has no stored result");
      return {
        result: cached.payload as TRes,
        receipt: await this.receiptFor(quote.invoiceId),
        replayed: true,
      };
    }
    if (state === "refunded") {
      throw new LatchError("producer_failed", "This invoice was refunded; request a new quote");
    }
    if (state === "stuck") {
      throw new LatchError("needs_operator", "This invoice needs operator review");
    }
    throw new LatchError("invoice_not_payable", "This invoice is closed");
  }
}

export { hashReceipt };
