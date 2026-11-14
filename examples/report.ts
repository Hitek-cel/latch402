/**
 * Turn the demo's journal into a page you can open in a browser.
 *
 *     npm run report            payments from `npm run example`
 *     npm run report:testnet    payments from `npm run example:testnet`
 *
 * Reads the database in `.latch-demo/`, writes one self-contained HTML file
 * next to it, and opens it. Read-only: it changes nothing, and the page
 * loads nothing from the network.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { journalReport } from "../src/report.ts";
import type { SqlExecutor } from "../src/adapters/postgres-journal.ts";

const LIVE = process.argv.includes("--testnet");
const dir = LIVE ? ".latch-demo/db-testnet" : ".latch-demo/db-offline";
const out = resolve(LIVE ? ".latch-demo/report-testnet.html" : ".latch-demo/report.html");

if (!existsSync(dir)) {
  console.log(`No payments recorded yet. Run \`npm run ${LIVE ? "example:testnet" : "example"}\` first.`);
  process.exit(0);
}

const db = await PGlite.create(dir);
const sql: SqlExecutor = {
  async query<R>(text: string, params: readonly unknown[] = []) {
    const r = await db.query(text, [...params]);
    return { rows: r.rows as R[], rowCount: r.affectedRows ?? r.rows.length };
  },
};
const html = await journalReport(sql, {
  title: LIVE ? "Latch payments — Base Sepolia (test USDC)" : "Latch payments — offline demo (simulated chain)",
});
await db.close();
writeFileSync(out, html);
console.log(`Report written to ${out}`);

if (!process.argv.includes("--no-open")) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", out]]
      : process.platform === "darwin"
        ? ["open", [out]]
        : ["xdg-open", [out]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}
