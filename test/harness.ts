import assert from "node:assert/strict";
import { Latch } from "../src/gate.ts";
import { memoryJournal } from "../src/adapters/memory-journal.ts";
import { ledgerFacilitator, makeProof, type LedgerFacilitator } from "../src/adapters/ledger-facilitator.ts";
import { hmacSigner } from "../src/receipt.ts";
import type { Clock, Journal, Producer, Quote } from "../src/ports.ts";
import { isCharged, type State } from "../src/states.ts";

export const PAYER = "agt_buyer";
export const PAY_TO = "0xseller";
export const START_BALANCE = 1_000_000;
export const PRICE = 24_000;
export const SECRET = "test-secret-that-is-long-enough-to-pass-32";

export type Req = { prompt: string };
export type Res = { answer: string };

export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  } satisfies Clock & { advance(ms: number): void };
}

export type ProducerControl = {
  producer: Producer<Req, Res>;
  calls: number;
  mode: "ok" | "throw" | "hang";
};

export function controllableProducer(): ProducerControl {
  const ctl: ProducerControl = {
    calls: 0,
    mode: "ok",
    producer: {
      async produce(request, ctx) {
        ctl.calls++;
        if (ctl.mode === "throw") throw new Error("model exploded");
        if (ctl.mode === "hang") {
          await new Promise((resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { answer: `brief for: ${request.prompt}` };
      },
    },
  };
  return ctl;
}

/** Thrown by the crash harness. Represents the process dying, not an app error. */
export class Crash extends Error {
  constructor() {
    super("PROCESS CRASHED");
    this.name = "Crash";
  }
}

/**
 * Wrap a journal so the process "dies" at a chosen append.
 *
 * `when: "after"` lets the entry become durable and then kills the process
 * before the side effect it authorises — the write-ahead case.
 * `when: "before"` kills it with the entry not yet durable.
 */
export function crashingJournal(
  inner: Journal,
  plan: { atAppend: number; when: "before" | "after" },
): Journal & { appendCount: number; armed: boolean } {
  const wrapper = {
    ...inner,
    appendCount: 0,
    armed: true,
    async append(entry: Parameters<Journal["append"]>[0], expectedSeq: number) {
      wrapper.appendCount++;
      const isTarget = wrapper.armed && wrapper.appendCount === plan.atAppend;
      if (isTarget && plan.when === "before") {
        wrapper.armed = false;
        throw new Crash();
      }
      const written = await inner.append(entry, expectedSeq);
      if (isTarget && plan.when === "after") {
        wrapper.armed = false;
        throw new Crash();
      }
      return written;
    },
  };
  return wrapper;
}

export type World = {
  journal: ReturnType<typeof memoryJournal>;
  facilitator: LedgerFacilitator;
  producer: ProducerControl;
  clock: ReturnType<typeof fakeClock>;
  gate: Latch<Req, Res>;
  /** Build a second gate over the same durable state — i.e. a process restart. */
  restart(journal?: Journal): Latch<Req, Res>;
  buy(prompt?: string): Promise<{ quote: Quote; proof: string }>;
};

export function makeWorld(
  config: {
    produceTimeoutMs?: number;
    quoteTtlMs?: number;
    maxProduceAttempts?: number;
    payerBalance?: number;
  } = {},
): World {
  const journal = memoryJournal();
  const facilitator = ledgerFacilitator({ [PAYER]: config.payerBalance ?? START_BALANCE });
  const producer = controllableProducer();
  const clock = fakeClock();
  const signer = hmacSigner(SECRET);

  const build = (j: Journal) =>
    new Latch<Req, Res>(
      {
        payTo: PAY_TO,
        quoteTtlMs: config.quoteTtlMs ?? 120_000,
        produceTimeoutMs: config.produceTimeoutMs ?? 50,
        maxProduceAttempts: config.maxProduceAttempts ?? 2,
      },
      { journal: j, facilitator, producer: producer.producer, signer, clock },
    );

  const gate = build(journal);

  return {
    journal,
    facilitator,
    producer,
    clock,
    gate,
    restart: (j) => build(j ?? journal),
    async buy(prompt = "what is the risk") {
      const { quote } = await gate.quote({
        payer: PAYER,
        sku: "brief",
        amountMicros: PRICE,
        request: { prompt },
      });
      return { quote, proof: makeProof(quote) };
    },
  };
}

/**
 * The invariant, checked as one function.
 *
 *   A caller is charged if and only if it received the good — or was refunded.
 *
 * Every test that ends an invoice runs this. It is the whole specification.
 */
export function assertMoneyIsSound(world: World, expect: { state: State; delivered: boolean }) {
  const payer = world.facilitator.balanceOf(PAYER);
  const seller = world.facilitator.balanceOf(PAY_TO);

  // Nothing is ever created or destroyed, whatever went wrong.
  assert.equal(payer + seller, START_BALANCE, "total supply changed");

  switch (expect.state) {
    case "delivered":
      assert.equal(payer, START_BALANCE - PRICE, "delivered but payer not charged exactly once");
      assert.equal(seller, PRICE, "delivered but seller not paid exactly once");
      assert.equal(expect.delivered, true, "delivered state without a delivered good");
      break;
    case "void":
    case "refunded":
      assert.equal(payer, START_BALANCE, `${expect.state} but payer is out of pocket`);
      assert.equal(seller, 0, `${expect.state} but seller kept money`);
      assert.equal(expect.delivered, false, "closed unpaid but the good was handed over");
      break;
    case "stuck":
      // Money is held, deliberately and visibly, awaiting an operator.
      assert.equal(payer, START_BALANCE - PRICE);
      assert.equal(seller, PRICE);
      break;
    default:
      assert.fail(`not a terminal state: ${expect.state}`);
  }

  assert.equal(
    isCharged(expect.state) && expect.state !== "stuck" ? expect.delivered : true,
    true,
    "charged without delivering",
  );
}

export async function stateOf(world: World, invoiceId: string): Promise<State> {
  const snap = await world.journal.get(invoiceId);
  assert.ok(snap, "invoice missing");
  return snap.state;
}
