import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import {
  JOURNAL_CHECKS,
  runJournalConformance,
  formatReport,
  type JournalHarness,
} from "../src/conformance/index.ts";
import { memoryJournal } from "../src/adapters/memory-journal.ts";
import { postgresJournal, migrate, type SqlClient, type SqlExecutor } from "../src/adapters/postgres-journal.ts";
import type { Journal } from "../src/ports.ts";

/**
 * Every journal adapter is held to one shared contract.
 *
 * This is the file that would have caught the `putResult` drift found in
 * audit: the memory adapter was last-write-wins while Postgres was
 * first-write-wins, and nothing failed because each had its own bespoke tests.
 * One contract, run against both, makes that impossible to repeat.
 */

function pgClient(db: PGlite): SqlClient {
  const exec = (runner: {
    query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  }): SqlExecutor => ({
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

const ADAPTERS: { name: string; harness: JournalHarness }[] = [
  {
    name: "memoryJournal",
    harness: { create: async () => memoryJournal() },
  },
  {
    name: "postgresJournal",
    harness: {
      async create(): Promise<Journal> {
        const db = await PGlite.create();
        const sql = pgClient(db);
        await migrate(sql);
        const journal = postgresJournal(sql);
        // Keep the database alive for the lifetime of the journal.
        (journal as Journal & { __db?: PGlite }).__db = db;
        return journal;
      },
      async dispose(journal) {
        await (journal as Journal & { __db?: PGlite }).__db?.close();
      },
    },
  },
];

for (const { name, harness } of ADAPTERS) {
  test(`${name} upholds the journal contract`, async () => {
    const report = await runJournalConformance(harness);
    if (!report.passed) {
      // Print every violation at once rather than one per run.
      assert.fail(`\n${formatReport(report, name)}`);
    }
    assert.equal(report.total, JOURNAL_CHECKS.length);
  });
}

test("the conformance kit actually detects a broken adapter", async () => {
  // A suite that cannot fail proves nothing. This adapter breaks exactly one
  // rule — the one that drifted in production — and the kit must catch it and
  // leave every other rule passing.
  const broken: JournalHarness = {
    async create() {
      const inner = memoryJournal();
      const results = new Map<string, unknown>();
      return {
        ...inner,
        async putResult(key, payload) {
          results.set(key, payload); // last-write-wins: the original bug
        },
        async getResult(key) {
          return results.has(key) ? { payload: results.get(key) } : undefined;
        },
      };
    },
  };

  const report = await runJournalConformance(broken);

  assert.equal(report.passed, false, "the kit failed to detect a known-broken adapter");
  assert.equal(report.failed, 1, "exactly one rule should have been violated");
  assert.equal(report.results.find((r) => r.status === "fail")?.id, "J11", "wrong rule reported");

  const text = formatReport(report, "broken");
  assert.match(text, /FAIL {2}J11/, "report should name the failing rule");
  assert.match(text, /why it matters/, "report should explain the cost");
});

test("every check has an id, a title, and a stated cost", async () => {
  const ids = new Set<string>();
  for (const c of JOURNAL_CHECKS) {
    assert.match(c.id, /^J\d+$/, `bad id: ${c.id}`);
    assert.equal(ids.has(c.id), false, `duplicate id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.title.length > 10, `check ${c.id} needs a real title`);
    assert.ok(
      c.why.length > 40,
      `check ${c.id} must say what breaks in production if an adapter fails it`,
    );
  }
});

// ── facilitator ─────────────────────────────────────────────────────────────

import {
  FACILITATOR_CHECKS,
  runFacilitatorConformance,
  type FacilitatorFixture,
  type FacilitatorHarness,
} from "../src/conformance/index.ts";
import { ledgerFacilitator, makeProof } from "../src/adapters/ledger-facilitator.ts";
import type { Facilitator, Quote } from "../src/ports.ts";

let issued = 0;
function ledgerHarness(opts: { balances?: boolean; wrap?: (f: Facilitator) => Facilitator } = {}): FacilitatorHarness {
  return {
    async create(): Promise<FacilitatorFixture> {
      const ledger = ledgerFacilitator({ agt_payer: 100_000_000 });
      const fixture: FacilitatorFixture = {
        facilitator: opts.wrap ? opts.wrap(ledger) : ledger,
        async issue(amountMicros = 24_000) {
          issued++;
          const quote: Quote = {
            invoiceId: `inv_fc_${issued}`,
            sku: "test",
            amountMicros,
            payTo: "0xseller",
            network: "base",
            asset: "USDC",
            payer: "agt_payer",
            requestHash: "h",
            nonce: `nonce_fc_${issued}`,
            expiresAt: 1_900_000_000_000,
          };
          return { quote, proof: makeProof(quote) };
        },
      };
      if (opts.balances !== false) fixture.balanceOf = async (a) => ledger.balanceOf(a);
      return fixture;
    },
  };
}

test("ledgerFacilitator upholds the facilitator contract", async () => {
  // This adapter failed five of these rules when the kit was first run against
  // it: settle ignored the proof, refund ignored the reference, and a
  // settlement could be refunded twice under different keys.
  const report = await runFacilitatorConformance(ledgerHarness());
  if (!report.passed) assert.fail(`\n${formatReport(report, "ledgerFacilitator")}`);
  assert.equal(report.skipped, 0, "every check should run when balances are observable");
  assert.equal(report.total, FACILITATOR_CHECKS.length);
});

test("money checks are skipped — never passed — when balances are unobservable", async () => {
  // A real network may not expose balances. The kit must say what it could not
  // verify rather than reporting a clean bill of health it did not earn.
  const report = await runFacilitatorConformance(ledgerHarness({ balances: false }));
  assert.equal(report.passed, true, "skips must not fail the report");
  assert.ok(report.skipped > 0, "money-movement checks should have been skipped");
  for (const r of report.results.filter((x) => x.status === "skip")) {
    assert.match(r.detail ?? "", /balanceOf/, `${r.id} should say why it was skipped`);
  }
  assert.match(formatReport(report, "no balances"), /skipped/);
});

test("the facilitator kit detects a lying status oracle", async () => {
  // statusOf is what recovery believes after a crash. One that always says
  // "unknown" makes the gate void real charges. The kit must catch exactly that.
  const report = await runFacilitatorConformance(
    ledgerHarness({
      wrap: (f) => ({ ...f, statusOf: async () => ({ state: "unknown" as const }) }),
    }),
  );
  const failed = report.results.filter((r) => r.status === "fail").map((r) => r.id);
  assert.deepEqual(failed, ["F14"], "should flag exactly the status-oracle rule");
});

test("every facilitator check has an id, a title, and a stated cost", () => {
  const ids = new Set<string>();
  for (const c of FACILITATOR_CHECKS) {
    assert.match(c.id, /^F\d+$/, `bad id: ${c.id}`);
    assert.equal(ids.has(c.id), false, `duplicate id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.why.length > 40, `check ${c.id} must say what breaks in production`);
  }
});
