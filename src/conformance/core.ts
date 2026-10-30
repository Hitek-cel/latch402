/**
 * Shared machinery for the conformance kits.
 *
 * Deliberately framework-free: no test runner, no assertion library. The kits
 * are meant to be pointed at someone else's adapter from whatever environment
 * they already have, so they cannot assume node:test or anything else.
 */

/** Thrown by a check whose fixture lacks a capability it needs. Not a failure. */
export class SkipCheck extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipCheck";
  }
}

export type CheckStatus = "pass" | "fail" | "skip";

export type ConformanceCheck<S> = {
  /** Stable id, so a failure can be cited. */
  id: string;
  title: string;
  /** What goes wrong in production if an implementation fails this. */
  why: string;
  run(subject: S): Promise<void>;
};

export type CheckResult = {
  id: string;
  title: string;
  why: string;
  status: CheckStatus;
  /** Failure message, or the reason a check was skipped. */
  detail?: string;
};

export type ConformanceReport = {
  /** True when nothing failed. Skips do not fail a report — they are listed. */
  passed: boolean;
  total: number;
  failed: number;
  skipped: number;
  results: CheckResult[];
};

export type Harness<S> = {
  /** Must return a FRESH subject. Called once per check, for isolation. */
  create(): Promise<S>;
  /** Optional teardown, called after each check even if it failed. */
  dispose?(subject: S): Promise<void>;
};

// ── assertions ──────────────────────────────────────────────────────────────

export function fail(message: string): never {
  throw new Error(message);
}

export function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    fail(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

/** An assertion signature, so a passing check also narrows the type. */
export function ok(value: unknown, message: string): asserts value {
  if (!value) fail(message);
}

export async function throws(
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
  message: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (predicate(err)) return;
    fail(`${message} — threw the wrong error: ${String(err)}`);
  }
  fail(`${message} — nothing was thrown`);
}

// ── runner ──────────────────────────────────────────────────────────────────

/**
 * Run checks against fresh subjects. Never throws for a failed check: it
 * returns a report, so every violation surfaces at once rather than one per run.
 */
export async function runChecks<S>(
  checks: readonly ConformanceCheck<S>[],
  harness: Harness<S>,
  only?: readonly string[],
): Promise<ConformanceReport> {
  const selected = only ? checks.filter((c) => only.includes(c.id)) : checks;
  const results: CheckResult[] = [];

  for (const check of selected) {
    const base = { id: check.id, title: check.title, why: check.why };
    let subject: S | undefined;
    try {
      subject = await harness.create();
      await check.run(subject);
      results.push({ ...base, status: "pass" });
    } catch (err) {
      if (err instanceof SkipCheck) {
        results.push({ ...base, status: "skip", detail: err.message });
      } else {
        results.push({
          ...base,
          status: "fail",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (subject !== undefined && harness.dispose) {
        try {
          await harness.dispose(subject);
        } catch {
          // Teardown failure must not mask the check's own result.
        }
      }
    }
  }

  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  return { passed: failed === 0, total: results.length, failed, skipped, results };
}

/** Human-readable report. Failures say what they would cost in production. */
export function formatReport(report: ConformanceReport, heading: string): string {
  const label: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
  const lines = [`Latch conformance — ${heading}`, ""];

  for (const r of report.results) {
    lines.push(`  ${label[r.status]}  ${r.id.padEnd(4)} ${r.title}`);
    if (r.status === "fail") {
      lines.push(`          ${r.detail}`);
      lines.push(`          why it matters: ${r.why}`);
    } else if (r.status === "skip") {
      lines.push(`          skipped: ${r.detail}`);
    }
  }

  const upheld = report.total - report.failed - report.skipped;
  lines.push("");
  if (report.passed) {
    lines.push(
      report.skipped > 0
        ? `  ${upheld}/${report.total} rules upheld, ${report.skipped} skipped — supply the missing capabilities to verify them.`
        : `  ${report.total}/${report.total} rules upheld.`,
    );
  } else {
    lines.push(`  ${report.failed} of ${report.total} rules violated.`);
  }
  return lines.join("\n");
}
