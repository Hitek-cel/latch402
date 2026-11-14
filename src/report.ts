import type { SqlExecutor } from "./adapters/postgres-journal.ts";
import type { Quote } from "./ports.ts";

/**
 * A read-only report of a Postgres journal, as one self-contained HTML page.
 *
 * Every payment Latch handled is already in the journal: when it arrived, each
 * step it went through, whether money moved, how it ended. This turns that into
 * something a person can look at — headline numbers, where payments ended up,
 * activity over time, recoveries, and the payments themselves.
 *
 * The page loads nothing and sends nothing: a Content-Security-Policy forbids
 * every network request, and all data is escaped. It only reads the journal.
 */

export type JournalReportOptions = {
  /** Shown at the top of the page. */
  title?: string;
  /** How many of the most recent payments to include. Default 1000. */
  limit?: number;
  /** Decimals of the payment asset, for display. Default 6 (USDC). */
  assetDecimals?: number;
  /** Asset name for display. Default "USDC". */
  assetSymbol?: string;
  /** Overrides the generation time, for tests. */
  now?: number;
};

type Outcome = "delivered" | "void" | "refunded" | "written_off" | "stuck" | "in_flight";

type Row = {
  id: string;
  kind: "x402" | "gate";
  createdAt: number;
  amount: bigint;
  network: string;
  states: string[];
  outcome: Outcome;
  reference: string;
  recovered: boolean;
  settleAttempts: number;
};

const OUTCOMES: { key: Outcome; label: string; status: "good" | "neutral" | "warning" | "serious" | "critical"; note: string }[] = [
  { key: "delivered", label: "Delivered", status: "good", note: "Charged once, and the buyer got the result" },
  { key: "void", label: "Not charged", status: "neutral", note: "Closed with no money moved" },
  { key: "refunded", label: "Refunded", status: "neutral", note: "Charged, then the money was returned" },
  { key: "in_flight", label: "In progress", status: "warning", note: "Still being settled or resolved" },
  { key: "written_off", label: "Written off", status: "serious", note: "Delivered on credit, and the batch never paid" },
  { key: "stuck", label: "Needs a human", status: "critical", note: "Outcome could not be determined automatically" },
];

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

function outcomeOf(state: string): Outcome {
  if (state === "delivered" || state === "void" || state === "refunded" || state === "written_off" || state === "stuck") {
    return state;
  }
  return "in_flight";
}

function explorerTx(network: string, tx: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return undefined;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  return undefined;
}

function money(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** Clean axis steps: 1, 2 or 5 times a power of ten. */
function niceStep(max: number, ticks = 4): number {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return Math.max(1, m * pow);
  return Math.max(1, 10 * pow);
}

async function load(sql: SqlExecutor, limit: number): Promise<{ rows: Row[]; receipts: number }> {
  const invoices = await sql.query<{ invoice_id: string; quote: unknown; created_at: string | number }>(
    `select invoice_id, quote, created_at from latch_invoice order by created_at desc limit $1`,
    [limit],
  );
  const ids = invoices.rows.map((r) => r.invoice_id);
  const entries = ids.length
    ? await sql.query<{ invoice_id: string; seq: number; state: string; evidence: unknown }>(
        `select invoice_id, seq, state, evidence from latch_entry where invoice_id = any($1) order by invoice_id, seq`,
        [ids],
      )
    : { rows: [] };
  const receipts = await sql.query<{ n: string | number }>(`select count(*) as n from latch_receipt`);

  const byInvoice = new Map<string, { state: string; evidence: Record<string, unknown> }[]>();
  for (const e of entries.rows) {
    const list = byInvoice.get(e.invoice_id) ?? [];
    list.push({ state: e.state, evidence: parse<Record<string, unknown>>(e.evidence) ?? {} });
    byInvoice.set(e.invoice_id, list);
  }

  const rows: Row[] = invoices.rows.map((inv) => {
    const quote = parse<Quote>(inv.quote);
    const list = byInvoice.get(inv.invoice_id) ?? [];
    const last = list[list.length - 1]?.state ?? "quoted";
    let reference = "";
    for (const e of list) if (typeof e.evidence.reference === "string" && e.evidence.reference) reference = e.evidence.reference;
    return {
      id: inv.invoice_id,
      kind: inv.invoice_id.startsWith("x402_") ? "x402" : "gate",
      createdAt: Number(inv.created_at),
      amount: BigInt(Math.round(Number(quote.amountMicros) || 0)),
      network: String(quote.network ?? ""),
      states: list.map((e) => e.state),
      outcome: outcomeOf(last),
      reference,
      recovered: list.some((e) => e.evidence.recovered === true),
      settleAttempts: list.filter((e) => e.state === "settling").length,
    };
  });
  return { rows, receipts: Number(receipts.rows[0]?.n ?? 0) };
}

function activityChart(rows: Row[]): string {
  if (rows.length === 0) return `<p class="empty">No payments yet.</p>`;
  const times = rows.map((r) => r.createdAt);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = max - min;
  const unit =
    span <= 10 * 60_000
      ? { ms: 10_000, name: "10 seconds", fmt: (t: number) => new Date(t).toISOString().slice(11, 19) }
      : span <= 2 * 3_600_000
      ? { ms: 60_000, name: "minute", fmt: (t: number) => new Date(t).toISOString().slice(11, 16) }
      : span <= 3 * 86_400_000
        ? { ms: 3_600_000, name: "hour", fmt: (t: number) => new Date(t).toISOString().slice(5, 13).replace("T", " ") + "h" }
        : { ms: 86_400_000, name: "day", fmt: (t: number) => new Date(t).toISOString().slice(5, 10) };
  const start = Math.floor(min / unit.ms) * unit.ms;
  const count = Math.min(60, Math.floor((max - start) / unit.ms) + 1);
  const firstShown = start + Math.max(0, Math.floor((max - start) / unit.ms) + 1 - count) * unit.ms;
  const buckets = Array.from({ length: count }, (_, i) => ({ t: firstShown + i * unit.ms, n: 0 }));
  for (const t of times) {
    const i = Math.floor((t - firstShown) / unit.ms);
    if (i >= 0 && i < buckets.length) {
      const b = buckets[i];
      if (b) b.n++;
    }
  }

  const W = 680;
  const H = 220;
  const pad = { l: 40, r: 12, t: 12, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const top = Math.max(...buckets.map((b) => b.n));
  const step = niceStep(top);
  const yMax = Math.max(step, Math.ceil(top / step) * step);
  const y = (v: number) => pad.t + plotH - (v / yMax) * plotH;
  const slot = plotW / buckets.length;
  const barW = Math.min(24, Math.max(2, slot - 2));

  const grid: string[] = [];
  for (let v = 0; v <= yMax; v += step) {
    grid.push(
      `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="tick" x="${pad.l - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${v.toLocaleString("en-US")}</text>`,
    );
  }
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const bars = buckets
    .map((b, i) => {
      const x = pad.l + i * slot + (slot - barW) / 2;
      const h = (b.n / yMax) * plotH;
      const r = Math.min(4, h, barW / 2);
      const base = pad.t + plotH;
      const bar =
        b.n > 0
          ? `<path class="bar" d="M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + barW - r} Q${x + barW},${base - h} ${x + barW},${base - h + r} V${base} Z"/>`
          : "";
      const tip = `${unit.fmt(b.t)} UTC · ${b.n} payment${b.n === 1 ? "" : "s"}`;
      const label =
        i % labelEvery === 0
          ? `<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(unit.fmt(b.t))}</text>`
          : "";
      return `<g class="col" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(tip)}">${bar}<rect class="hit" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${plotH}"/></g>${label}`;
    })
    .join("");

  return (
    `<div class="chart" data-chart>` +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Payments per ${unit.name}, ${rows.length} in total">` +
    `${grid.join("")}<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>${bars}</svg>` +
    `<div class="tip" role="status" hidden></div></div>` +
    `<p class="caption">Payments per ${unit.name} (UTC), by the time each arrived.</p>`
  );
}

const ICONS: Record<string, string> = {
  good: `<path d="M3.5 8.5l3 3 6-7" />`,
  neutral: `<circle cx="8" cy="8" r="5" />`,
  warning: `<circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" />`,
  serious: `<path d="M8 2.5l6 11H2z" /><path d="M8 7v3" /><path d="M8 11.8v.2" />`,
  critical: `<path d="M8 2.5l6 11H2z" /><path d="M8 7v3" /><path d="M8 11.8v.2" />`,
};
const icon = (status: string) =>
  `<svg class="ico ${status}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[status] ?? ""}</svg>`;

/** Build the report page from a Postgres journal. Read-only. */
export async function journalReport(sql: SqlExecutor, options: JournalReportOptions = {}): Promise<string> {
  const limit = options.limit ?? 1000;
  const decimals = options.assetDecimals ?? 6;
  const symbol = options.assetSymbol ?? "USDC";
  const now = options.now ?? Date.now();
  const title = options.title ?? "Latch payments";
  const { rows, receipts } = await load(sql, limit);

  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  const delivered = rows.filter((r) => r.outcome === "delivered");
  const revenue = delivered.reduce((s, r) => s + r.amount, 0n);
  const recovered = rows.filter((r) => r.recovered).length;
  const retried = rows.filter((r) => r.settleAttempts > 1).length;
  const attention = count("stuck");

  const tiles = [
    { label: "Payments recorded", value: rows.length.toLocaleString("en-US") },
    { label: `Collected (${symbol})`, value: money(revenue, decimals) },
    { label: "Delivered", value: count("delivered").toLocaleString("en-US") },
    { label: "Not charged", value: count("void").toLocaleString("en-US") },
    { label: "Needs a human", value: attention.toLocaleString("en-US"), flag: attention > 0 },
  ];

  const present = OUTCOMES.filter((o) => count(o.key) > 0 || ["delivered", "void", "in_flight", "stuck"].includes(o.key));
  const total = Math.max(1, rows.length);
  const outcomes = present
    .map((o) => {
      const n = count(o.key);
      const pct = (n / total) * 100;
      return (
        `<li><div class="o-name">${icon(o.status)}<span><strong>${esc(o.label)}</strong><small>${esc(o.note)}</small></span></div>` +
        `<div class="o-track" aria-hidden="true"><div class="o-fill ${o.status}" style="width:${pct.toFixed(2)}%"></div></div>` +
        `<div class="o-num">${n.toLocaleString("en-US")}<small>${rows.length ? `${Math.round(pct)}%` : "—"}</small></div></li>`
      );
    })
    .join("");

  const table = rows
    .slice(0, 200)
    .map((r) => {
      const o = OUTCOMES.find((x) => x.key === r.outcome) ?? OUTCOMES[0]!;
      const link = explorerTx(r.network, r.reference);
      const ref = r.reference
        ? link
          ? `<a href="${esc(link)}" rel="noreferrer noopener" target="_blank">${esc(r.reference.slice(0, 10))}…</a>`
          : `<code>${esc(r.reference.length > 14 ? r.reference.slice(0, 12) + "…" : r.reference)}</code>`
        : `<span class="muted">—</span>`;
      const path = r.states.filter((s) => s !== "quoted").join(" → ") || "quoted";
      const notes = [r.recovered ? "recovered" : "", r.settleAttempts > 1 ? `${r.settleAttempts} settle attempts` : ""]
        .filter(Boolean)
        .join(", ");
      return (
        `<tr><td class="num">${esc(utc(r.createdAt))}</td>` +
        `<td><code title="${esc(r.id)}">${esc(r.id.slice(0, 13))}…</code><small class="muted"> ${esc(r.kind)}</small></td>` +
        `<td class="num">${esc(money(r.amount, decimals))}</td>` +
        `<td><span class="badge">${icon(o.status)}${esc(o.label)}</span></td>` +
        `<td class="path">${esc(path)}${notes ? `<small class="muted"> · ${esc(notes)}</small>` : ""}</td>` +
        `<td>${ref}</td></tr>`
      );
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--series:#2a78d6;--good:#0ca30c;--neutral:#898781;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--track:#f0efec;--link:#256abf}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--series:#3987e5;--track:#2c2c2a;--link:#86b6ef}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--series:#3987e5;--track:#2c2c2a;--link:#86b6ef}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}
header h1{font-size:22px;font-weight:600;margin:0}header p{margin:4px 0 0;color:var(--ink2)}
section{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:20px;margin-top:16px}
h2{font-size:16px;font-weight:600;margin:0 0 4px}.sub{margin:0 0 16px;color:var(--ink2);font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px}
.kpi span{display:block;color:var(--ink2);font-size:13px}.kpi strong{display:block;font-size:28px;font-weight:600;margin-top:2px}
.kpi.flag{border-color:var(--critical)}.kpi.flag strong{color:var(--critical)}
.outcomes{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.outcomes li{display:grid;grid-template-columns:minmax(200px,1.2fr) 2fr 64px;gap:16px;align-items:center}
.o-name{display:flex;gap:10px;align-items:flex-start}.o-name strong{display:block;font-weight:600}.o-name small{display:block;color:var(--ink2);font-size:13px}
.o-track{height:8px;background:var(--track);border-radius:4px;overflow:hidden}.o-fill{height:100%;border-radius:4px;min-width:0}
.o-fill.good{background:var(--good)}.o-fill.neutral{background:var(--neutral)}.o-fill.warning{background:var(--warning)}.o-fill.serious{background:var(--serious)}.o-fill.critical{background:var(--critical)}
.o-num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.o-num small{display:block;color:var(--ink2);font-weight:400;font-size:12px}
.ico{width:16px;height:16px;flex:none;margin-top:3px;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ico.good{stroke:var(--good)}.ico.neutral{stroke:var(--neutral)}.ico.warning{stroke:#c98500}.ico.serious{stroke:var(--serious)}.ico.critical{stroke:var(--critical)}
.chart{position:relative}.chart svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.bar{fill:var(--series)}.hit{fill:transparent}.col:hover .bar,.col:focus .bar{opacity:.8}.col:focus{outline:none}
.tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--surface);font-size:12px;padding:6px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%)}
.caption{color:var(--muted);font-size:12px;margin:8px 0 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat{border-left:2px solid var(--axis);padding:2px 0 2px 12px}.stat strong{font-size:22px;font-weight:600;display:block}.stat span{color:var(--ink2);font-size:13px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--axis);padding:8px 10px;white-space:nowrap}
td{border-bottom:1px solid var(--grid);padding:8px 10px;vertical-align:top}td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td.path{color:var(--ink2);min-width:220px}.badge{display:inline-flex;gap:6px;align-items:center;white-space:nowrap}.badge .ico{margin-top:0}
code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}a{color:var(--link)}.muted{color:var(--muted)}.empty{color:var(--ink2)}
footer{color:var(--muted);font-size:12px;margin-top:24px}
@media (max-width:640px){.outcomes li{grid-template-columns:1fr 64px}.o-track{grid-column:1/-1;grid-row:2}}
</style>
</head>
<body>
<main>
<header>
<h1>${esc(title)}</h1>
<p>${rows.length.toLocaleString("en-US")} most recent payment${rows.length === 1 ? "" : "s"} from the Latch journal · generated ${esc(utc(now))}</p>
</header>

<div class="kpis">${tiles
    .map((t) => `<div class="kpi${t.flag ? " flag" : ""}"><span>${esc(t.label)}</span><strong>${esc(t.value)}</strong></div>`)
    .join("")}</div>

<section aria-labelledby="h-out">
<h2 id="h-out">Where every payment ended</h2>
<p class="sub">Each payment ends in exactly one of these. A charge without a result never appears here.</p>
<ul class="outcomes">${outcomes}</ul>
</section>

<section aria-labelledby="h-act">
<h2 id="h-act">Activity</h2>
<p class="sub">Hover a bar for the count.</p>
${activityChart(rows)}
</section>

<section aria-labelledby="h-rec">
<h2 id="h-rec">Recoveries</h2>
<p class="sub">Work Latch did that a server without it would have lost or done twice.</p>
<div class="stats">
<div class="stat"><strong>${recovered.toLocaleString("en-US")}</strong><span>finished after a crash or a lost reply</span></div>
<div class="stat"><strong>${retried.toLocaleString("en-US")}</strong><span>settled on a later attempt</span></div>
<div class="stat"><strong>${count("in_flight").toLocaleString("en-US")}</strong><span>still being resolved now</span></div>
<div class="stat"><strong>${receipts.toLocaleString("en-US")}</strong><span>signed receipts in the chain</span></div>
</div>
</section>

<section aria-labelledby="h-pay">
<h2 id="h-pay">Payments</h2>
<p class="sub">Newest first${rows.length > 200 ? ", the latest 200" : ""}. Amounts in ${esc(symbol)}.</p>
<div class="wrap"><table>
<thead><tr><th>Time</th><th>Payment</th><th>Amount</th><th>Outcome</th><th>Path</th><th>Settlement</th></tr></thead>
<tbody>${table || `<tr><td colspan="6" class="empty">No payments yet.</td></tr>`}</tbody>
</table></div>
</section>

<footer>Read-only. This page loads nothing from the network; links open the block explorer only when you click them.</footer>
</main>
<script>
for (const chart of document.querySelectorAll("[data-chart]")) {
  const tip = chart.querySelector(".tip");
  const show = (g) => {
    const box = g.querySelector(".hit").getBoundingClientRect();
    const host = chart.getBoundingClientRect();
    tip.textContent = g.dataset.tip;
    tip.style.left = (box.left - host.left + box.width / 2) + "px";
    tip.style.top = Math.max(24, (g.querySelector(".bar")?.getBoundingClientRect().top ?? box.bottom) - host.top) + "px";
    tip.hidden = false;
  };
  for (const g of chart.querySelectorAll(".col")) {
    g.addEventListener("mouseenter", () => show(g));
    g.addEventListener("focus", () => show(g));
    g.addEventListener("mouseleave", () => { tip.hidden = true; });
    g.addEventListener("blur", () => { tip.hidden = true; });
  }
}
</script>
</body>
</html>
`;
}
