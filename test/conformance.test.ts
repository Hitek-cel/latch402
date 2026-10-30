import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import {
  JOURNAL_CHECKS,
  runJournalConformance,
  formatReport,
  type JournalHarness,
} from "../src/conformance/journal.ts";
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
  assert.equal(report.results.find((r) => !r.passed)?.id, "J11", "wrong rule reported");

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
