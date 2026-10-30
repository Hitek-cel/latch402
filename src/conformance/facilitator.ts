import type { Facilitator, Quote } from "../ports.ts";
import {
  eq,
  ok,
  runChecks,
  SkipCheck,
  type ConformanceCheck,
  type ConformanceReport,
  type Harness,
} from "./core.ts";

/**
 * The Facilitator contract, made executable.
 *
 * The facilitator is the payment network as the gate sees it. The gate is only
 * as safe as the facilitator's guarantees, and until now those guarantees were
 * prose in a doc comment that nothing checked.
 *
 * WHAT THIS CAN VERIFY: everything observable from outside — that verify
 * rejects what it should, that settle and refund are idempotent under replay
 * and under concurrency, that money moves exactly once and only on a valid
 * proof, and that statusOf agrees with what settle did.
 *
 * WHAT IT CANNOT: anything that needs a fault injected into the network. A kit
 * cannot force a dropped response, a settle that lands after reporting
 * failure, or a settlement still in flight when statusOf is asked. In
 * particular it cannot verify statusOf's strictest rule — that "unknown" is
 * only reported when nothing can still land later. That rule matters (recovery
 * voids on "unknown"), and it has to be established by reading the network's
 * own guarantees, not by a test. The gate-level crash and attack suites cover
 * those paths against the reference ledger.
 */

export type FacilitatorFixture = {
  facilitator: Facilitator;
  /**
   * Issue a fresh quote and a VALID proof that pays it. Each call must produce
   * a distinct invoice and nonce, and the payer must be funded for at least
   * `amountMicros`. For a real network this is where you sign an
   * authorisation with a funded test wallet.
   */
  issue(amountMicros?: number): Promise<{ quote: Quote; proof: string }>;
  /**
   * Optional. Read an account's balance in micros. Supplying it unlocks the
   * money-movement checks; without it those are reported as skipped, never as
   * passed.
   */
  balanceOf?(account: string): Promise<number>;
};

export type FacilitatorHarness = Harness<FacilitatorFixture>;

let keyCounter = 0;
const freshKey = (tag: string) => `idem_conf_${tag}_${Date.now()}_${++keyCounter}`;

function balances(fx: FacilitatorFixture): (account: string) => Promise<number> {
  const read = fx.balanceOf;
  if (!read) throw new SkipCheck("fixture has no balanceOf, so money movement cannot be observed");
  return (account) => read.call(fx, account);
}

async function snapshot(read: (a: string) => Promise<number>, quote: Quote) {
  return { payer: await read(quote.payer), payTo: await read(quote.payTo) };
}

export const FACILITATOR_CHECKS: ConformanceCheck<FacilitatorFixture>[] = [
  // ── verify ───────────────────────────────────────────────────────────────
  {
    id: "F1",
    title: "verify accepts a valid proof and reports its amount and nonce",
    why: "The gate burns the reported nonce for replay protection and compares the reported amount to the quote to catch underpayment. A missing nonce disables exactly-once; a wrong amount lets a short payment through.",
    async run(fx) {
      const { quote, proof } = await fx.issue();
      const v = await fx.facilitator.verify(proof, quote);
      ok(v.ok, `a valid proof was rejected${v.ok ? "" : `: ${v.reason}`}`);
      eq(v.amountMicros, quote.amountMicros, "reported amount");
      ok(typeof v.nonce === "string" && v.nonce.length > 0, "verify must report the proof's nonce");
    },
  },
  {
    id: "F2",
    title: "verify rejects a proof issued for a different quote",
    why: "Otherwise one payment authorisation unlocks any invoice: pay for the cheap request, redeem against the expensive one.",
    async run(fx) {
      const a = await fx.issue();
      const b = await fx.issue();
      const v = await fx.facilitator.verify(a.proof, b.quote);
      eq(v.ok, false, "a proof for invoice A must not verify against invoice B");
    },
  },
  {
    id: "F3",
    title: "verify moves no money",
    why: "Recovery unwinds a `verifying` invoice to void on the assumption nothing moved. A verify with side effects turns that unwind into silent theft.",
    async run(fx) {
      const read = balances(fx);
      const { quote, proof } = await fx.issue();
      const before = await snapshot(read, quote);
      await fx.facilitator.verify(proof, quote);
      const after = await snapshot(read, quote);
      eq(after.payer, before.payer, "payer balance after verify");
      eq(after.payTo, before.payTo, "payee balance after verify");
    },
  },

  // ── settle ───────────────────────────────────────────────────────────────
  {
    id: "F4",
    title: "settle succeeds on a valid proof, with a reference and the quoted amount",
    why: "The reference is what refunds and receipts cite. A settlement with no reference cannot be reversed or proven.",
    async run(fx) {
      const { quote, proof } = await fx.issue();
      const s = await fx.facilitator.settle({ idempotencyKey: freshKey("f4"), quote, proof });
      ok(s.ok, `settle failed on a valid proof${s.ok ? "" : `: ${s.reason}`}`);
      ok(s.reference.length > 0, "settle must return a non-empty reference");
      eq(s.amountMicros, quote.amountMicros, "settled amount");
    },
  },
  {
    id: "F5",
    title: "settle moves exactly the quoted amount, payer to payee",
    why: "This is the charge itself. Any other amount, or the wrong direction, breaks 'charged exactly once' at the source.",
    async run(fx) {
      const read = balances(fx);
      const { quote, proof } = await fx.issue();
      const before = await snapshot(read, quote);
      const s = await fx.facilitator.settle({ idempotencyKey: freshKey("f5"), quote, proof });
      ok(s.ok, "settle failed on a valid proof");
      const after = await snapshot(read, quote);
      eq(before.payer - after.payer, quote.amountMicros, "debited from payer");
      eq(after.payTo - before.payTo, quote.amountMicros, "credited to payee");
    },
  },
  {
    id: "F6",
    title: "settle replayed with the same key returns the same reference",
    why: "After a crash the gate re-settles with the same key to learn what happened. A new reference on replay looks like a second, distinct charge.",
    async run(fx) {
      const { quote, proof } = await fx.issue();
      const key = freshKey("f6");
      const first = await fx.facilitator.settle({ idempotencyKey: key, quote, proof });
      const second = await fx.facilitator.settle({ idempotencyKey: key, quote, proof });
      ok(first.ok && second.ok, "settle failed on a valid proof");
      eq(second.reference, first.reference, "reference on replay");
    },
  },
  {
    id: "F7",
    title: "settle replayed with the same key moves money once",
    why: "The core idempotency guarantee. Without it, every retry after a timeout charges the caller again.",
    async run(fx) {
      const read = balances(fx);
      const { quote, proof } = await fx.issue();
      const key = freshKey("f7");
      const before = await snapshot(read, quote);
      await fx.facilitator.settle({ idempotencyKey: key, quote, proof });
      await fx.facilitator.settle({ idempotencyKey: key, quote, proof });
      await fx.facilitator.settle({ idempotencyKey: key, quote, proof });
      const after = await snapshot(read, quote);
      eq(before.payer - after.payer, quote.amountMicros, "total debited across three replays");
    },
  },
  {
    id: "F8",
    title: "concurrent settles with the same key agree on one reference",
    why: "Two gate workers can settle the same invoice at once after a crash. They must converge on one settlement, not each believe they created their own.",
    async run(fx) {
      const { quote, proof } = await fx.issue();
      const key = freshKey("f8");
      const results = await Promise.all([
        fx.facilitator.settle({ idempotencyKey: key, quote, proof }),
        fx.facilitator.settle({ idempotencyKey: key, quote, proof }),
        fx.facilitator.settle({ idempotencyKey: key, quote, proof }),
      ]);
      const refs = new Set<string>();
      for (const r of results) if (r.ok) refs.add(r.reference);
      ok(refs.size >= 1, "no concurrent settle succeeded");
      eq(refs.size, 1, "distinct references returned for one key");
    },
  },
  {
    id: "F9",
    title: "concurrent settles with the same key move money once",
    why: "The race version of F7, where check-then-write implementations fail: both callers see 'not settled yet' and both charge.",
    async run(fx) {
      const read = balances(fx);
      const { quote, proof } = await fx.issue();
      const key = freshKey("f9");
      const before = await snapshot(read, quote);
      await Promise.all([
        fx.facilitator.settle({ idempotencyKey: key, quote, proof }),
        fx.facilitator.settle({ idempotencyKey: key, quote, proof }),
        fx.facilitator.settle({ idempotencyKey: key, quote, proof }),
      ]);
      const after = await snapshot(read, quote);
      eq(before.payer - after.payer, quote.amountMicros, "total debited across a concurrent race");
    },
  },
  {
    id: "F10",
    title: "settle refuses a proof that does not authorise this quote",
    why: "Defence in depth. The gate verifies before settling, but if a gate bug ever skips verify, the network itself must still refuse to move money on an authorisation that was never given for this invoice.",
    async run(fx) {
      const a = await fx.issue();
      const b = await fx.issue();
      const s = await fx.facilitator.settle({
        idempotencyKey: freshKey("f10"),
        quote: b.quote,
        proof: a.proof,
      });
      eq(s.ok, false, "settle accepted a proof issued for a different invoice");
    },
  },
  {
    id: "F11",
    title: "a settle on an unauthorised proof moves no money, whatever it reports",
    why: "Covers both failure modes at once. Reporting failure while moving money is the divergence case — the gate voids the invoice over a real charge. Reporting success on a bad proof is worse. Either way the money is the ground truth, not the return value.",
    async run(fx) {
      const read = balances(fx);
      const a = await fx.issue();
      const b = await fx.issue();
      const before = await snapshot(read, b.quote);
      await fx.facilitator.settle({ idempotencyKey: freshKey("f11"), quote: b.quote, proof: a.proof });
      const after = await snapshot(read, b.quote);
      eq(after.payer, before.payer, "payer balance after an unauthorised settle");
      eq(after.payTo, before.payTo, "payee balance after an unauthorised settle");
    },
  },
  {
    id: "F12",
    title: "distinct keys are distinct settlements",
    why: "A network that deduplicates too eagerly — by payer, say — answers a second purchase with the first one's receipt. The gate then delivers a second good that was never paid for.",
    async run(fx) {
      const a = await fx.issue();
      const b = await fx.issue();
      const sa = await fx.facilitator.settle({ idempotencyKey: freshKey("f12a"), quote: a.quote, proof: a.proof });
      const sb = await fx.facilitator.settle({ idempotencyKey: freshKey("f12b"), quote: b.quote, proof: b.proof });
      ok(sa.ok && sb.ok, "settle failed on a valid proof");
      ok(sa.reference !== sb.reference, "two different purchases returned the same reference");
    },
  },

  // ── statusOf ─────────────────────────────────────────────────────────────
  {
    id: "F13",
    title: "statusOf reports an unseen key as unknown, without throwing",
    why: "Recovery asks statusOf after a crash before settle ever ran. Throwing here strands the invoice in `settling`; reporting it as settled delivers a good nobody paid for.",
    async run(fx) {
      const s = await fx.facilitator.statusOf(freshKey("f13_never_used"));
      eq(s.state, "unknown", "status of a key that was never settled");
    },
  },
  {
    id: "F14",
    title: "statusOf agrees with a completed settle",
    why: "This is the crash-recovery oracle. After a crash mid-settle, the gate believes statusOf over its own records. If they disagree, recovery voids a real charge or delivers against a missing one.",
    async run(fx) {
      const { quote, proof } = await fx.issue();
      const key = freshKey("f14");
      const s = await fx.facilitator.settle({ idempotencyKey: key, quote, proof });
      ok(s.ok, "settle failed on a valid proof");
      const st = await fx.facilitator.statusOf(key);
      eq(st.state, "settled", "status after a successful settle");
      if (st.state === "settled") {
        eq(st.reference, s.reference, "statusOf reference");
        eq(st.amountMicros, quote.amountMicros, "statusOf amount");
      }
    },
  },

  // ── refund ───────────────────────────────────────────────────────────────
  {
    id: "F15",
    title: "refund of a real settlement succeeds with a reference",
    why: "Refund is the compensating step for every settlement the gate cannot honour. Without it, a failed delivery leaves the caller charged for nothing.",
    async run(fx) {
      const { quote, proof } = await fx.issue();
      const s = await fx.facilitator.settle({ idempotencyKey: freshKey("f15"), quote, proof });
      ok(s.ok, "settle failed on a valid proof");
      const r = await fx.facilitator.refund({ idempotencyKey: freshKey("f15r"), quote, reference: s.reference });
      ok(r.ok, `refund of a real settlement failed${r.ok ? "" : `: ${r.reason}`}`);
      ok(r.reference.length > 0, "refund must return a non-empty reference");
    },
  },
  {
    id: "F16",
    title: "refund returns exactly the settled amount",
    why: "Refunding less leaves the caller out of pocket; refunding more pays them to fail. Either way the books stop balancing.",
    async run(fx) {
      const read = balances(fx);
      const { quote, proof } = await fx.issue();
      const before = await snapshot(read, quote);
      const s = await fx.facilitator.settle({ idempotencyKey: freshKey("f16"), quote, proof });
      ok(s.ok, "settle failed on a valid proof");
      await fx.facilitator.refund({ idempotencyKey: freshKey("f16r"), quote, reference: s.reference });
      const after = await snapshot(read, quote);
      eq(after.payer, before.payer, "payer balance after settle + refund");
      eq(after.payTo, before.payTo, "payee balance after settle + refund");
    },
  },
  {
    id: "F17",
    title: "refund replayed with the same key returns money once",
    why: "Recovery retries refunds after a crash. A non-idempotent refund pays the caller back twice — the seller funds a free good on every crash.",
    async run(fx) {
      const read = balances(fx);
      const { quote, proof } = await fx.issue();
      const s = await fx.facilitator.settle({ idempotencyKey: freshKey("f17"), quote, proof });
      ok(s.ok, "settle failed on a valid proof");
      const afterSettle = await snapshot(read, quote);
      const rkey = freshKey("f17r");
      const r1 = await fx.facilitator.refund({ idempotencyKey: rkey, quote, reference: s.reference });
      const r2 = await fx.facilitator.refund({ idempotencyKey: rkey, quote, reference: s.reference });
      ok(r1.ok && r2.ok, "refund failed on a real settlement");
      eq(r2.reference, r1.reference, "refund reference on replay");
      const after = await snapshot(read, quote);
      eq(after.payer - afterSettle.payer, quote.amountMicros, "total refunded across replays");
    },
  },
  {
    id: "F18",
    title: "refund of a settlement that never happened is refused",
    why: "A refund must reverse a specific settlement. One that pays out against any reference lets a caller who never paid be 'refunded' out of the seller's balance — money from nothing.",
    async run(fx) {
      // Give the payee real funds first, so a careless refund has something to
      // take. Testing against an empty account would pass by accident.
      const funded = await fx.issue();
      const s = await fx.facilitator.settle({
        idempotencyKey: freshKey("f18fund"),
        quote: funded.quote,
        proof: funded.proof,
      });
      ok(s.ok, "could not fund the payee for this check");

      const { quote } = await fx.issue(); // issued, never settled
      const r = await fx.facilitator.refund({
        idempotencyKey: freshKey("f18r"),
        quote,
        reference: "stl_that_never_existed",
      });
      eq(r.ok, false, "refunded a settlement that never happened");
    },
  },
  {
    id: "F19",
    title: "a refund against an unknown reference moves no money, whatever it reports",
    why: "The money half of F18, and the one that matters: a refund that pays out against a settlement that never happened is theft from the seller, however it reports the outcome.",
    async run(fx) {
      const read = balances(fx);
      const funded = await fx.issue();
      const s = await fx.facilitator.settle({
        idempotencyKey: freshKey("f19fund"),
        quote: funded.quote,
        proof: funded.proof,
      });
      ok(s.ok, "could not fund the payee for this check");

      const { quote } = await fx.issue();
      const before = await snapshot(read, quote);
      await fx.facilitator.refund({
        idempotencyKey: freshKey("f19r"),
        quote,
        reference: "stl_that_never_existed",
      });
      const after = await snapshot(read, quote);
      eq(after.payer, before.payer, "payer balance after a refund against an unknown reference");
      eq(after.payTo, before.payTo, "payee balance after a refund against an unknown reference");
    },
  },
  {
    id: "F20",
    title: "a settlement is refunded at most once, whatever the key",
    why: "Refund idempotency keyed only on the refund key lets two different keys refund the same settlement twice. The caller is paid back double and the seller funds the difference. A refund must be bound to the settlement it reverses.",
    async run(fx) {
      const read = balances(fx);
      // Fund the payee beyond this one sale, so a double refund has money to
      // take. Against an exactly-funded payee, the second refund would fail for
      // lack of balance and the check would pass by accident.
      const funded = await fx.issue();
      const f = await fx.facilitator.settle({
        idempotencyKey: freshKey("f20fund"),
        quote: funded.quote,
        proof: funded.proof,
      });
      ok(f.ok, "could not fund the payee for this check");

      const { quote, proof } = await fx.issue();
      const s = await fx.facilitator.settle({ idempotencyKey: freshKey("f20"), quote, proof });
      ok(s.ok, "settle failed on a valid proof");
      const afterSettle = await snapshot(read, quote);

      await fx.facilitator.refund({ idempotencyKey: freshKey("f20r1"), quote, reference: s.reference });
      await fx.facilitator.refund({ idempotencyKey: freshKey("f20r2"), quote, reference: s.reference });

      const after = await snapshot(read, quote);
      eq(
        after.payer - afterSettle.payer,
        quote.amountMicros,
        "total refunded to the payer under two different refund keys",
      );
    },
  },
];

/** Run the whole facilitator contract. Returns a report; never throws for a failed check. */
export function runFacilitatorConformance(
  harness: FacilitatorHarness,
  only?: readonly string[],
): Promise<ConformanceReport> {
  return runChecks(FACILITATOR_CHECKS, harness, only);
}
