import type { SqlExecutor } from "./adapters/postgres-journal.ts";
import type { Quote } from "./ports.ts";

/**
 * A read-only dashboard of a Postgres journal, as one self-contained HTML page.
 *
 * Every payment Latch handled is already in the journal: when it arrived, each
 * step it went through, whether money moved, how it ended. This turns that into
 * something a person can look at and work with — headline numbers, where
 * payments ended, activity over time, what sold, who bought, the recoveries
 * Latch made, and every payment with its step-by-step timeline. Filters scope
 * the whole page, the table sorts and exports to CSV, and the theme follows
 * the system or the viewer's choice.
 *
 * The page loads nothing and sends nothing: a Content-Security-Policy forbids
 * every network request, the data travels as inert JSON, and everything shown
 * is inserted as text. It only reads the journal.
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
  /** Reload the page every N seconds, for a page served live from a route. Off by default. */
  refreshSeconds?: number;
  /** Overrides the generation time, for tests. */
  now?: number;
};

export type ReportOutcome = "delivered" | "void" | "refunded" | "written_off" | "stuck" | "in_flight";

export type ReportStep = {
  state: string;
  at: number;
  reason?: string;
  reference?: string;
  attempt?: number;
  recovered?: boolean;
  responseStatus?: number;
};

export type ReportPayment = {
  id: string;
  kind: "x402" | "gate";
  createdAt: number;
  /** Atomic units of the asset, as a decimal string. */
  amount: string;
  network: string;
  payer: string;
  route: string;
  outcome: ReportOutcome;
  reference: string;
  recovered: boolean;
  settleAttempts: number;
  steps: ReportStep[];
};

export type JournalReportData = {
  title: string;
  generatedAt: number;
  assetSymbol: string;
  assetDecimals: number;
  /** Signed receipts in the chain, across the whole journal. */
  receipts: number;
  /** True when the journal holds more payments than were loaded. */
  truncated: boolean;
  payments: ReportPayment[];
};

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

function outcomeOf(state: string): ReportOutcome {
  if (state === "delivered" || state === "void" || state === "refunded" || state === "written_off" || state === "stuck") {
    return state;
  }
  return "in_flight";
}

/**
 * The journal as plain data: what the page shows, for anything else that wants
 * to build on it. Read-only.
 */
export async function journalReportData(sql: SqlExecutor, options: JournalReportOptions = {}): Promise<JournalReportData> {
  const limit = options.limit ?? 1000;
  const invoices = await sql.query<{ invoice_id: string; quote: unknown; created_at: string | number }>(
    `select invoice_id, quote, created_at from latch_invoice order by created_at desc limit $1`,
    [limit + 1],
  );
  const truncated = invoices.rows.length > limit;
  const kept = invoices.rows.slice(0, limit);
  const ids = kept.map((r) => r.invoice_id);
  const entries = ids.length
    ? await sql.query<{ invoice_id: string; seq: number; state: string; at: string | number; evidence: unknown }>(
        `select invoice_id, seq, state, at, evidence from latch_entry where invoice_id = any($1) order by invoice_id, seq`,
        [ids],
      )
    : { rows: [] };
  const receipts = await sql.query<{ n: string | number }>(`select count(*) as n from latch_receipt`);

  const byInvoice = new Map<string, ReportStep[]>();
  for (const e of entries.rows) {
    const evidence = parse<Record<string, unknown>>(e.evidence) ?? {};
    const step: ReportStep = { state: e.state, at: Number(e.at) };
    if (typeof evidence.reason === "string") step.reason = evidence.reason;
    if (typeof evidence.reference === "string" && evidence.reference) step.reference = evidence.reference;
    if (typeof evidence.attempt === "number") step.attempt = evidence.attempt;
    if (evidence.recovered === true) step.recovered = true;
    if (typeof evidence.responseStatus === "number") step.responseStatus = evidence.responseStatus;
    const list = byInvoice.get(e.invoice_id) ?? [];
    list.push(step);
    byInvoice.set(e.invoice_id, list);
  }

  const payments: ReportPayment[] = kept.map((inv) => {
    const quote = parse<Quote>(inv.quote);
    const steps = byInvoice.get(inv.invoice_id) ?? [];
    const last = steps[steps.length - 1]?.state ?? "quoted";
    let reference = "";
    for (const s of steps) if (s.reference) reference = s.reference;
    return {
      id: inv.invoice_id,
      kind: inv.invoice_id.startsWith("x402_") ? "x402" : "gate",
      createdAt: Number(inv.created_at),
      amount: String(Math.round(Number(quote.amountMicros) || 0)),
      network: String(quote.network ?? ""),
      payer: String(quote.payer ?? ""),
      route: String(quote.sku ?? ""),
      outcome: outcomeOf(last),
      reference,
      recovered: steps.some((s) => s.recovered === true),
      settleAttempts: steps.filter((s) => s.state === "settling").length,
      steps,
    };
  });

  return {
    title: options.title ?? "Latch payments",
    generatedAt: options.now ?? Date.now(),
    assetSymbol: options.assetSymbol ?? "USDC",
    assetDecimals: options.assetDecimals ?? 6,
    receipts: Number(receipts.rows[0]?.n ?? 0),
    truncated,
    payments,
  };
}

const STYLE = String.raw`
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--raise:#f3f2ee;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--series:#2a78d6;--rest:#898781;--good:#0ca30c;--neutral:#898781;--warning:#fab219;--warning-ink:#8a5a00;--serious:#ec835a;--critical:#d03b3b;--track:#eceae4;--link:#256abf;--focus:#2a78d6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--raise:#232321;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--series:#3987e5;--rest:#898781;--warning-ink:#fab219;--track:#2c2c2a;--link:#86b6ef;--focus:#86b6ef}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--raise:#232321;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--series:#3987e5;--rest:#898781;--warning-ink:#fab219;--track:#2c2c2a;--link:#86b6ef;--focus:#86b6ef}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1160px;margin:0 auto;padding:24px 16px 64px}
button,select,input{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.top{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.top h1{font-size:22px;font-weight:600;margin:0;line-height:1.3}
.top p{margin:4px 0 0;color:var(--ink2);font-size:14px}
.seg{display:inline-flex;border:1px solid var(--ring);border-radius:8px;background:var(--surface);padding:2px}
.seg button{border:0;background:none;padding:5px 12px;border-radius:6px;cursor:pointer;color:var(--ink2);font-size:13px}
.seg button[aria-pressed="true"]{background:var(--raise);color:var(--ink);font-weight:600}
.filters{position:sticky;top:0;z-index:5;display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:16px -16px 0;padding:10px 16px;background:var(--page);border-bottom:1px solid var(--ring)}
.filters label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--ink2)}
.filters select,.filters input{height:34px;border:1px solid var(--axis);border-radius:8px;background:var(--surface);padding:0 10px;min-width:150px}
.filters input{min-width:220px}
.filters .count{margin-left:auto;color:var(--ink2);font-size:13px;align-self:flex-end;padding-bottom:6px}
.btn{height:34px;border:1px solid var(--axis);border-radius:8px;background:var(--surface);padding:0 12px;cursor:pointer;font-size:13px;align-self:flex-end}
.btn:hover{background:var(--raise)}
.alert{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--critical);border-radius:12px;background:var(--surface);padding:12px 16px;margin-top:16px}
.alert strong{display:block}.alert span{color:var(--ink2);font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-top:16px}
.kpi{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px;min-width:0}
.kpi .l{display:block;color:var(--ink2);font-size:13px}
.kpi .v{display:block;font-size:26px;font-weight:600;line-height:1.25;margin-top:2px;overflow-wrap:anywhere}
.kpi .s{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.kpi.hero{grid-column:span 2}.kpi.hero .v{font-size:48px;line-height:1.1}.kpi.hero .v small{font-size:18px;font-weight:500;color:var(--ink2);margin-left:6px}
.kpi.flag{border-color:var(--critical)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.cols>section{margin-top:0}
section{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:20px;margin-top:16px;min-width:0}
.head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
h2{font-size:16px;font-weight:600;margin:0 0 2px}
.sub{margin:0 0 16px;color:var(--ink2);font-size:14px}
.outcomes,.rank{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.outcomes li{display:grid;grid-template-columns:minmax(0,1fr) 72px;gap:6px 16px;align-items:center}
.o-name{display:flex;gap:10px;align-items:flex-start;min-width:0}
.o-name strong{display:block;font-weight:600}.o-name small{display:block;color:var(--ink2);font-size:13px}
.o-num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.o-num small{display:block;color:var(--ink2);font-weight:400;font-size:12px}
.track{grid-column:1/-1;height:8px;background:var(--track);border-radius:4px;overflow:hidden}
.fill{height:100%;border-radius:4px}
.fill.good{background:var(--good)}.fill.neutral{background:var(--neutral)}.fill.warning{background:var(--warning)}.fill.serious{background:var(--serious)}.fill.critical{background:var(--critical)}.fill.series{background:var(--series)}
.ico{width:16px;height:16px;flex:none;margin-top:3px;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ico.good{stroke:var(--good)}.ico.neutral{stroke:var(--neutral)}.ico.warning{stroke:var(--warning-ink)}.ico.serious{stroke:var(--serious)}.ico.critical{stroke:var(--critical)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--ink2);margin-bottom:8px}
.legend span{display:inline-flex;gap:6px;align-items:center}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}.sw.a{background:var(--series)}.sw.b{background:var(--rest)}
.chart{position:relative}.chart svg{width:100%;height:auto;display:block}
.gridl{stroke:var(--grid);stroke-width:1}.axisl{stroke:var(--axis);stroke-width:1}.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.bar-a{fill:var(--series)}.bar-b{fill:var(--rest)}.hit{fill:transparent}
.col:hover .bar-a,.col:hover .bar-b,.col:focus .bar-a,.col:focus .bar-b{opacity:.78}.col:focus{outline:none}.col:focus-visible .hit{stroke:var(--focus);stroke-width:1.5}
.tip{position:absolute;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--axis);box-shadow:0 4px 14px rgba(0,0,0,.14);font-size:12px;padding:8px 10px;border-radius:8px;white-space:nowrap;transform:translate(-50%,-100%);margin-top:-8px}
.tip .t{color:var(--ink2);margin-bottom:4px}.tip .r{display:flex;gap:6px;align-items:center}.tip .r strong{font-variant-numeric:tabular-nums}
.key{width:10px;height:2px;border-radius:1px;display:inline-block}.key.a{background:var(--series)}.key.b{background:var(--rest)}
.caption{color:var(--muted);font-size:12px;margin:8px 0 0}
.rank li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:baseline}
.rank .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rank .val{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.rank .val small{font-weight:400;color:var(--ink2);margin-left:6px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{border-left:2px solid var(--axis);padding:2px 0 2px 12px}.stat strong{font-size:22px;font-weight:600;display:block}.stat span{color:var(--ink2);font-size:13px}
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--axis);padding:8px 10px;white-space:nowrap}
th button{border:0;background:none;padding:0;font-weight:600;color:inherit;cursor:pointer}
td{border-bottom:1px solid var(--grid);padding:8px 10px;vertical-align:top}
td.num,th.num{font-variant-numeric:tabular-nums;white-space:nowrap}th.amt,td.amt{text-align:right}
tr.row{cursor:pointer}tr.row:hover td{background:var(--raise)}
.exp{border:0;background:none;cursor:pointer;padding:0 6px 0 0;color:var(--ink2);font-size:12px}
.badge{display:inline-flex;gap:6px;align-items:center;white-space:nowrap}.badge .ico{margin-top:0}
tr.detail td{background:var(--raise);padding:14px 16px 16px 34px}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0 0 14px;font-size:13px}
.facts dt{color:var(--ink2)}.facts dd{margin:0;overflow-wrap:anywhere}
.steps{list-style:none;margin:0;padding:0;border-left:2px solid var(--axis)}
.steps li{position:relative;padding:0 0 12px 16px}.steps li:last-child{padding-bottom:0}
.steps li::before{content:"";position:absolute;left:-6px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--surface);border:2px solid var(--muted)}
.steps li.end::before{border-color:var(--ink)}
.steps strong{font-weight:600}.steps .when{color:var(--ink2);font-size:12px;margin-left:8px;font-variant-numeric:tabular-nums}.steps .why{display:block;color:var(--ink2);font-size:12px}
code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
a{color:var(--link)}.muted{color:var(--muted)}.empty{color:var(--ink2);margin:0}
.more{display:flex;justify-content:center;margin-top:14px}
footer{color:var(--muted);font-size:12px;margin-top:24px}
[hidden]{display:none!important}
@media (max-width:960px){.kpis{grid-template-columns:repeat(3,1fr)}.kpi.hero{grid-column:1/-1}.cols{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}
@media (max-width:560px){.filters{position:static}.kpis{grid-template-columns:repeat(2,1fr)}.filters .count{margin-left:0;width:100%}.filters input{min-width:0;width:100%}.filters label{flex:1 1 140px}.filters select{min-width:0;width:100%}}
@media print{.filters,.seg,.btn,.more,.exp{display:none!important}body{background:#fff}section,.kpi{break-inside:avoid}}
`;

const SCRIPT = String.raw`
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("latch-data").textContent);
  var root = document.documentElement;
  var SVG = "http://www.w3.org/2000/svg";
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === undefined || c === null || c === false) continue;
      n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) n.appendChild(arguments[i]);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

  // ---- theme: follows the system until the viewer picks one ----------------
  var THEME_KEY = "latch-report-theme";
  function setTheme(t, save) {
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t); else { t = "auto"; root.removeAttribute("data-theme"); }
    var buttons = document.querySelectorAll("[data-theme-set]");
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-theme-set") === t));
    if (save) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} }
  }
  var savedTheme = "auto";
  try { savedTheme = localStorage.getItem(THEME_KEY) || "auto"; } catch (e) {}
  setTheme(savedTheme, false);
  var themeButtons = document.querySelectorAll("[data-theme-set]");
  for (var tb = 0; tb < themeButtons.length; tb++) {
    themeButtons[tb].addEventListener("click", function () { setTheme(this.getAttribute("data-theme-set"), true); });
  }

  // ---- formatting ---------------------------------------------------------
  var DEC = DATA.assetDecimals, SYM = DATA.assetSymbol;
  function int(n) { return Number(n).toLocaleString("en-US"); }
  function money(units) {
    var u = BigInt(units), neg = u < 0n; if (neg) u = -u;
    var base = 10n ** BigInt(DEC), whole = u / base;
    var frac = (u % base).toString().padStart(DEC, "0").replace(/0+$/, "");
    while (frac.length < 2) frac += "0";
    return (neg ? "-" : "") + whole.toLocaleString("en-US") + "." + frac;
  }
  function iso(ms) { return new Date(ms).toISOString(); }
  function when(ms) { return iso(ms).replace("T", " ").slice(0, 19); }
  function dur(ms) {
    if (ms < 0) ms = 0;
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
    if (ms < 3600000) return (ms / 60000).toFixed(ms < 600000 ? 1 : 0) + " min";
    return (ms / 3600000).toFixed(1) + " h";
  }
  function short(s, head, tail) { s = String(s || ""); return s.length > head + tail + 1 ? s.slice(0, head) + "…" + (tail ? s.slice(-tail) : "") : s; }
  function explorer(network, tx) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return null;
    if (network === "eip155:84532") return "https://sepolia.basescan.org/tx/" + tx;
    if (network === "eip155:8453") return "https://basescan.org/tx/" + tx;
    return null;
  }

  var OUTCOMES = [
    { key: "delivered", label: "Delivered", status: "good", note: "Charged once, and the buyer got the result" },
    { key: "void", label: "Not charged", status: "neutral", note: "Closed with no money moved" },
    { key: "refunded", label: "Refunded", status: "neutral", note: "Charged, then the money was returned" },
    { key: "in_flight", label: "In progress", status: "warning", note: "Still being settled or resolved" },
    { key: "written_off", label: "Written off", status: "serious", note: "Delivered on credit, and the batch never paid" },
    { key: "stuck", label: "Needs a human", status: "critical", note: "Outcome could not be determined automatically" }
  ];
  var OUTCOME = {}; OUTCOMES.forEach(function (o) { OUTCOME[o.key] = o; });
  var STEP = {
    quoted: "Opened", verifying: "Proof being verified", producing: "Verified, work started",
    settling: "Response stored, settle requested", settled: "Money moved", delivered: "Settled and delivered",
    void: "Closed, nothing charged", refunding: "Refund started", refunded: "Money returned",
    stuck: "Needs a human", credited: "Accepted on credit", fronted: "Delivered on credit",
    abandoning: "Failed on credit, waiting for the batch", written_off: "Written off"
  };
  var ICON = {
    good: ["M3.5 8.5l3 3 6-7"], neutral: ["M3 8a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"],
    warning: ["M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0", "M8 5v3.2l2 1.3"],
    serious: ["M8 2.5l6 11H2z", "M8 7v3", "M8 11.8v.2"], critical: ["M8 2.5l6 11H2z", "M8 7v3", "M8 11.8v.2"]
  };
  function icon(status) {
    var s = svg("svg", { "class": "ico " + status, viewBox: "0 0 16 16", "aria-hidden": "true" });
    (ICON[status] || []).forEach(function (d) { s.appendChild(svg("path", { d: d })); });
    return s;
  }

  // ---- filters scope everything below them --------------------------------
  var state = { range: "all", outcome: "all", q: "", sort: "time", dir: -1, shown: 50, open: {}, chartTable: false };
  var RANGES = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
  function filtered() {
    var since = state.range === "all" ? -Infinity : DATA.generatedAt - RANGES[state.range];
    var q = state.q.trim().toLowerCase();
    return DATA.payments.filter(function (p) {
      if (p.createdAt < since) return false;
      if (state.outcome !== "all" && p.outcome !== state.outcome) return false;
      if (q && (p.id + " " + p.payer + " " + p.route + " " + p.reference).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function sum(rows) { return rows.reduce(function (s, p) { return s + BigInt(p.amount); }, 0n); }
  function count(rows, key) { return rows.filter(function (p) { return p.outcome === key; }).length; }

  // ---- headline numbers ---------------------------------------------------
  function tile(label, value, sub, cls, unit) {
    var v = el("span", { "class": "v" }, value);
    if (unit) v.appendChild(el("small", { text: unit }));
    return el("div", { "class": "kpi" + (cls ? " " + cls : "") }, el("span", { "class": "l", text: label }), v, sub ? el("span", { "class": "s", text: sub }) : null);
  }
  function deliveryTimes(rows) {
    var out = [];
    rows.forEach(function (p) {
      if (p.outcome !== "delivered") return;
      var start = null, end = null;
      p.steps.forEach(function (s) { if (s.state === "producing" && start === null) start = s.at; if (s.state === "delivered") end = s.at; });
      if (start !== null && end !== null && end >= start) out.push(end - start);
    });
    return out.sort(function (a, b) { return a - b; });
  }
  function renderKpis(rows) {
    var host = clear($("kpis"));
    var delivered = rows.filter(function (p) { return p.outcome === "delivered"; });
    var buyers = {}; delivered.forEach(function (p) { if (p.payer) buyers[p.payer.toLowerCase()] = 1; });
    var times = deliveryTimes(rows);
    var median = times.length ? times[Math.floor((times.length - 1) / 2)] : null;
    var stuck = count(rows, "stuck");
    host.appendChild(tile("Collected", money(sum(delivered)), "from " + int(delivered.length) + " delivered payment" + (delivered.length === 1 ? "" : "s"), "hero", SYM));
    host.appendChild(tile("Payments", int(rows.length), rows.length ? Math.round((delivered.length / rows.length) * 100) + "% delivered" : ""));
    host.appendChild(tile("Buyers", int(Object.keys(buyers).length), "distinct paying wallets"));
    host.appendChild(tile("Median time to deliver", median === null ? "—" : dur(median), times.length ? "slowest " + dur(times[times.length - 1]) : "no deliveries yet"));
    host.appendChild(tile("Needs a human", int(stuck), stuck ? "see the list below" : "nothing waiting", stuck ? "flag" : ""));
  }

  function renderAttention(rows) {
    var host = $("attention");
    var stuck = count(rows, "stuck");
    var old = rows.filter(function (p) { return p.outcome === "in_flight" && DATA.generatedAt - p.createdAt > 600000; }).length;
    clear(host);
    if (!stuck && !old) { host.hidden = true; return; }
    host.hidden = false;
    var parts = [];
    if (stuck) parts.push(int(stuck) + " payment" + (stuck === 1 ? "" : "s") + " could not be resolved automatically");
    if (old) parts.push(int(old) + " ha" + (old === 1 ? "s" : "ve") + " been in progress for more than 10 minutes");
    host.appendChild(icon("critical"));
    host.appendChild(el("div", null, el("strong", { text: "Needs attention" }), el("span", { text: parts.join("; ") + ". Filter by outcome to see them." })));
  }

  // ---- where every payment ended -----------------------------------------
  function renderOutcomes(rows) {
    var host = clear($("outcomes"));
    var total = Math.max(1, rows.length);
    OUTCOMES.forEach(function (o) {
      var n = count(rows, o.key);
      if (!n && ["delivered", "void", "in_flight", "stuck"].indexOf(o.key) === -1) return;
      var pct = (n / total) * 100;
      var fill = el("div", { "class": "fill " + o.status }); fill.style.width = pct.toFixed(2) + "%";
      host.appendChild(el("li", null,
        el("div", { "class": "o-name" }, icon(o.status), el("span", null, el("strong", { text: o.label }), el("small", { text: o.note }))),
        el("div", { "class": "o-num" }, int(n), el("small", { text: rows.length ? Math.round(pct) + "%" : "—" })),
        el("div", { "class": "track", "aria-hidden": "true" }, fill)));
    });
  }

  // ---- activity -----------------------------------------------------------
  function niceStep(max) {
    if (max <= 0) return 1;
    var raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw))), m = [1, 2, 5, 10];
    for (var i = 0; i < m.length; i++) if (m[i] * pow >= raw) return Math.max(1, m[i] * pow);
    return Math.max(1, 10 * pow);
  }
  function buckets(rows) {
    var times = rows.map(function (p) { return p.createdAt; });
    var min = Math.min.apply(null, times), max = Math.max.apply(null, times), span = max - min, unit;
    if (span <= 600000) unit = { ms: 10000, name: "10 seconds", fmt: function (t) { return iso(t).slice(11, 19); } };
    else if (span <= 7200000) unit = { ms: 60000, name: "minute", fmt: function (t) { return iso(t).slice(11, 16); } };
    else if (span <= 259200000) unit = { ms: 3600000, name: "hour", fmt: function (t) { return iso(t).slice(5, 13).replace("T", " ") + "h"; } };
    else unit = { ms: 86400000, name: "day", fmt: function (t) { return iso(t).slice(5, 10); } };
    var start = Math.floor(min / unit.ms) * unit.ms;
    var all = Math.floor((max - start) / unit.ms) + 1, n = Math.min(60, all);
    var first = start + (all - n) * unit.ms, list = [];
    for (var i = 0; i < n; i++) list.push({ t: first + i * unit.ms, a: 0, b: 0 });
    rows.forEach(function (p) {
      var i = Math.floor((p.createdAt - first) / unit.ms);
      if (i >= 0 && i < n) { if (p.outcome === "delivered") list[i].a++; else list[i].b++; }
    });
    return { unit: unit, list: list };
  }
  function topRound(x, yTop, w, h, r) {
    r = Math.max(0, Math.min(r, h, w / 2));
    var b = yTop + h;
    return "M" + x + "," + b + " V" + (yTop + r) + " Q" + x + "," + yTop + " " + (x + r) + "," + yTop + " H" + (x + w - r) + " Q" + (x + w) + "," + yTop + " " + (x + w) + "," + (yTop + r) + " V" + b + " Z";
  }
  function renderChart(rows) {
    var host = clear($("chart")), tableHost = clear($("chart-table")), cap = $("chart-cap");
    $("chart-toggle").textContent = state.chartTable ? "Show chart" : "Show as table";
    $("chart-toggle").setAttribute("aria-pressed", String(state.chartTable));
    if (!rows.length) { host.hidden = false; tableHost.hidden = true; host.appendChild(el("p", { "class": "empty", text: "No payments match these filters." })); cap.textContent = ""; return; }
    var b = buckets(rows), list = b.list, unit = b.unit;
    cap.textContent = "Payments per " + unit.name + " (UTC), by the time each arrived.";
    host.hidden = state.chartTable; tableHost.hidden = !state.chartTable;

    var tbody = el("tbody");
    list.forEach(function (k) { tbody.appendChild(el("tr", null, el("td", { "class": "num", text: unit.fmt(k.t) }), el("td", { "class": "num amt", text: int(k.a) }), el("td", { "class": "num amt", text: int(k.b) }))); });
    tableHost.appendChild(el("div", { "class": "wrap" }, el("table", null,
      el("thead", null, el("tr", null, el("th", { text: "Time (UTC)" }), el("th", { "class": "num amt", text: "Delivered" }), el("th", { "class": "num amt", text: "Not delivered" }))), tbody)));

    var W = 680, H = 230, pad = { l: 40, r: 12, t: 10, b: 28 }, plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var top = Math.max.apply(null, list.map(function (k) { return k.a + k.b; }));
    var step = niceStep(top), yMax = Math.max(step, Math.ceil(top / step) * step);
    var y = function (v) { return pad.t + plotH - (v / yMax) * plotH; };
    var slot = plotW / list.length, barW = Math.min(24, Math.max(2, slot - 2)), base = pad.t + plotH;
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Payments per " + unit.name + ": " + rows.length + " in total, " + count(rows, "delivered") + " delivered" });
    for (var v = 0; v <= yMax; v += step) {
      s.appendChild(svg("line", { "class": "gridl", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
      var t = svg("text", { "class": "tick", x: pad.l - 8, y: y(v), "text-anchor": "end", "dominant-baseline": "middle" }); t.textContent = int(v); s.appendChild(t);
    }
    s.appendChild(svg("line", { "class": "axisl", x1: pad.l, x2: W - pad.r, y1: base, y2: base }));
    var every = Math.max(1, Math.ceil(list.length / 8));
    var tip = el("div", { "class": "tip", role: "status" }); tip.hidden = true;
    list.forEach(function (k, i) {
      var x = pad.l + i * slot + (slot - barW) / 2;
      var ha = (k.a / yMax) * plotH, hb = (k.b / yMax) * plotH, gap = k.a && k.b ? 2 : 0;
      var g = svg("g", { "class": "col", tabindex: "0", "aria-label": unit.fmt(k.t) + " UTC: " + k.a + " delivered, " + k.b + " not delivered" });
      if (k.a) g.appendChild(svg("path", { "class": "bar-a", d: topRound(x, base - ha, barW, ha, k.b ? 0 : 4) }));
      if (k.b) g.appendChild(svg("path", { "class": "bar-b", d: topRound(x, base - ha - gap - hb, barW, Math.max(1, hb - (k.a ? 0 : 0)), 4) }));
      g.appendChild(svg("rect", { "class": "hit", x: pad.l + i * slot, y: pad.t, width: slot, height: plotH }));
      var show = function () {
        clear(tip);
        tip.appendChild(el("div", { "class": "t", text: unit.fmt(k.t) + " UTC" }));
        tip.appendChild(el("div", { "class": "r" }, el("span", { "class": "key a" }), el("strong", { text: int(k.a) }), "delivered"));
        tip.appendChild(el("div", { "class": "r" }, el("span", { "class": "key b" }), el("strong", { text: int(k.b) }), "not delivered"));
        var hostBox = host.getBoundingClientRect(), box = g.querySelector(".hit").getBoundingClientRect();
        var scale = hostBox.width / W, topPx = (base - ha - gap - hb) * scale;
        tip.hidden = false;
        var half = tip.offsetWidth / 2, left = box.left - hostBox.left + box.width / 2;
        tip.style.left = Math.max(half, Math.min(hostBox.width - half, left)) + "px";
        tip.style.top = Math.max(tip.offsetHeight + 8, topPx) + "px";
      };
      var hide = function () { tip.hidden = true; };
      g.addEventListener("pointerenter", show); g.addEventListener("focus", show);
      g.addEventListener("pointerleave", hide); g.addEventListener("blur", hide);
      s.appendChild(g);
      if (i % every === 0) { var lab = svg("text", { "class": "tick", x: x + barW / 2, y: H - 8, "text-anchor": "middle" }); lab.textContent = unit.fmt(k.t); s.appendChild(lab); }
    });
    host.appendChild(s); host.appendChild(tip);
  }

  // ---- ranked lists -------------------------------------------------------
  function ranked(hostId, rows, keyOf, nameOf, emptyText) {
    var host = clear($(hostId)), groups = {};
    rows.forEach(function (p) {
      if (p.outcome !== "delivered") return;
      var k = keyOf(p); if (!groups[k]) groups[k] = { key: k, n: 0, total: 0n };
      groups[k].n++; groups[k].total += BigInt(p.amount);
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return a.total === b.total ? b.n - a.n : (a.total < b.total ? 1 : -1); });
    if (!list.length) { host.appendChild(el("li", null, el("p", { "class": "empty", text: emptyText }))); return; }
    if (list.length > 6) {
      var rest = list.slice(5), other = { key: "Other (" + rest.length + ")", n: 0, total: 0n, other: true };
      rest.forEach(function (g) { other.n += g.n; other.total += g.total; });
      list = list.slice(0, 5).concat([other]);
    }
    var max = list.reduce(function (m, g) { return g.total > m ? g.total : m; }, 1n);
    list.forEach(function (g) {
      var fill = el("div", { "class": "fill series" }); fill.style.width = Math.max(1, Number((g.total * 10000n) / max) / 100) + "%";
      var name = g.other ? g.key : nameOf(g.key);
      host.appendChild(el("li", null,
        el("span", { "class": "n", title: g.other ? "" : g.key, text: name }),
        el("span", { "class": "val" }, money(g.total), el("small", { text: int(g.n) + (g.n === 1 ? " payment" : " payments") })),
        el("div", { "class": "track", "aria-hidden": "true" }, fill)));
    });
  }

  function renderRecoveries(rows) {
    var host = clear($("stats"));
    var add = function (n, label) { host.appendChild(el("div", { "class": "stat" }, el("strong", { text: int(n) }), el("span", { text: label }))); };
    add(rows.filter(function (p) { return p.recovered; }).length, "finished after a crash or a lost reply");
    add(rows.filter(function (p) { return p.settleAttempts > 1; }).length, "settled on a later attempt");
    add(count(rows, "in_flight"), "still being resolved now");
    add(DATA.receipts, "signed receipts, whole journal");
  }

  // ---- payments -----------------------------------------------------------
  function detail(p) {
    var facts = el("dl", { "class": "facts" });
    var fact = function (k, v) { if (v) { facts.appendChild(el("dt", { text: k })); facts.appendChild(el("dd", null, v)); } };
    fact("Payment", el("code", { text: p.id }));
    fact("Buyer", p.payer ? el("code", { text: p.payer }) : null);
    fact("Route", p.route || null);
    fact("Network", p.network || null);
    var link = explorer(p.network, p.reference);
    fact("Settlement", p.reference ? (link ? el("a", { href: link, target: "_blank", rel: "noreferrer noopener", text: p.reference }) : el("code", { text: p.reference })) : null);
    var steps = el("ol", { "class": "steps" }), shown = p.steps.filter(function (s) { return s.state !== "quoted"; }), prev = null;
    shown.forEach(function (s, i) {
      var notes = [];
      if (s.attempt && s.attempt > 1) notes.push("attempt " + s.attempt);
      if (s.recovered) notes.push("recovered from the chain");
      if (s.reason) notes.push(s.reason);
      if (s.responseStatus) notes.push("handler answered " + s.responseStatus);
      steps.appendChild(el("li", { "class": i === shown.length - 1 ? "end" : "" },
        el("strong", { text: STEP[s.state] || s.state }),
        el("span", { "class": "when", text: when(s.at) + " UTC" + (prev === null ? "" : "  +" + dur(s.at - prev)) }),
        notes.length ? el("span", { "class": "why", text: notes.join(" · ") }) : null));
      prev = s.at;
    });
    if (!shown.length) steps.appendChild(el("li", { "class": "end" }, el("strong", { text: "Opened" })));
    return el("div", null, facts, steps);
  }
  function renderTable(rows) {
    var body = clear($("rows")), sorted = rows.slice().sort(function (a, b) {
      var d = state.sort === "amount" ? (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0) : a.createdAt - b.createdAt;
      return (d || a.createdAt - b.createdAt) * state.dir;
    });
    ["time", "amount"].forEach(function (k) {
      var th = $("th-" + k); th.setAttribute("aria-sort", state.sort === k ? (state.dir === 1 ? "ascending" : "descending") : "none");
      $("sort-" + k).textContent = (k === "time" ? "Time (UTC)" : "Amount") + (state.sort === k ? (state.dir === 1 ? " ↑" : " ↓") : "");
    });
    if (!sorted.length) body.appendChild(el("tr", null, el("td", { colspan: "7" }, el("p", { "class": "empty", text: DATA.payments.length ? "No payments match these filters." : "No payments yet." }))));
    sorted.slice(0, state.shown).forEach(function (p) {
      var o = OUTCOME[p.outcome] || OUTCOMES[0], open = !!state.open[p.id], link = explorer(p.network, p.reference);
      var btn = el("button", { "class": "exp", type: "button", "aria-expanded": String(open), "aria-label": (open ? "Hide" : "Show") + " the steps of payment " + short(p.id, 13, 0), text: open ? "▾" : "▸" });
      var ref = p.reference ? (link ? el("a", { href: link, target: "_blank", rel: "noreferrer noopener", text: short(p.reference, 10, 0) }) : el("code", { text: short(p.reference, 12, 0) })) : el("span", { "class": "muted", text: "—" });
      var tr = el("tr", { "class": "row" },
        el("td", { "class": "num" }, btn, when(p.createdAt)),
        el("td", null, el("code", { title: p.id, text: short(p.id, 13, 0) })),
        el("td", null, p.payer ? el("code", { title: p.payer, text: short(p.payer, 6, 4) }) : el("span", { "class": "muted", text: "—" })),
        el("td", { text: p.route || "—" }),
        el("td", { "class": "num amt", text: money(p.amount) }),
        el("td", null, el("span", { "class": "badge" }, icon(o.status), o.label + (p.recovered ? " · recovered" : ""))),
        el("td", null, ref));
      tr.addEventListener("click", function (e) { if (e.target.closest("a")) return; state.open[p.id] = !state.open[p.id]; renderTable(filtered()); });
      body.appendChild(tr);
      if (open) body.appendChild(el("tr", { "class": "detail" }, el("td", { colspan: "7" }, detail(p))));
    });
    var more = $("more"); more.hidden = sorted.length <= state.shown;
    $("more-btn").textContent = "Show " + Math.min(50, sorted.length - state.shown) + " more";
    $("table-sub").textContent = (sorted.length > state.shown ? "Showing " + int(state.shown) + " of " + int(sorted.length) : int(sorted.length) + " payment" + (sorted.length === 1 ? "" : "s")) + ". Click a row for its steps. Amounts in " + SYM + ".";
  }

  function csv(rows) {
    var cell = function (v) { v = String(v === undefined || v === null ? "" : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    var lines = [["time_utc", "payment", "kind", "buyer", "route", "amount", "asset", "outcome", "steps", "settlement", "recovered", "settle_attempts"].join(",")];
    rows.forEach(function (p) {
      lines.push([iso(p.createdAt), p.id, p.kind, p.payer, p.route, money(p.amount).replace(/,/g, ""), SYM, p.outcome,
        p.steps.map(function (s) { return s.state; }).filter(function (s) { return s !== "quoted"; }).join(" > "), p.reference, p.recovered ? "yes" : "no", p.settleAttempts].map(cell).join(","));
    });
    var a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" })), download: "latch-payments-" + iso(DATA.generatedAt).slice(0, 10) + ".csv" });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function render() {
    var rows = filtered();
    $("count").textContent = "Showing " + int(rows.length) + " of " + int(DATA.payments.length) + " payments" + (DATA.truncated ? " (most recent only)" : "");
    $("reset").hidden = state.range === "all" && state.outcome === "all" && !state.q;
    renderKpis(rows); renderAttention(rows); renderOutcomes(rows); renderChart(rows);
    ranked("sold", rows, function (p) { return p.route || "(no route)"; }, function (k) { return k; }, "Nothing delivered in this view.");
    ranked("buyers", rows, function (p) { return p.payer || "(unknown)"; }, function (k) { return short(k, 8, 6); }, "No buyers in this view.");
    renderRecoveries(rows); renderTable(rows);
  }

  $("f-range").addEventListener("change", function () { state.range = this.value; state.shown = 50; render(); });
  $("f-outcome").addEventListener("change", function () { state.outcome = this.value; state.shown = 50; render(); });
  $("f-q").addEventListener("input", function () { state.q = this.value; state.shown = 50; render(); });
  $("reset").addEventListener("click", function () { state.range = "all"; state.outcome = "all"; state.q = ""; $("f-range").value = "all"; $("f-outcome").value = "all"; $("f-q").value = ""; render(); });
  $("chart-toggle").addEventListener("click", function () { state.chartTable = !state.chartTable; renderChart(filtered()); });
  $("more-btn").addEventListener("click", function () { state.shown += 50; renderTable(filtered()); });
  $("export").addEventListener("click", function () { csv(filtered()); });
  ["time", "amount"].forEach(function (k) {
    $("sort-" + k).addEventListener("click", function () { if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = -1; } renderTable(filtered()); });
  });
  render();
})();
`;

/** Build the dashboard page from a Postgres journal. Read-only. */
export async function journalReport(sql: SqlExecutor, options: JournalReportOptions = {}): Promise<string> {
  const data = await journalReportData(sql, options);
  // Inert JSON: "<" is escaped so nothing in the data can close the script
  // element, and the page inserts every value as text.
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .split(String.fromCharCode(0x2028))
    .join("\\u2028")
    .split(String.fromCharCode(0x2029))
    .join("\\u2029");
  const refresh =
    options.refreshSeconds && options.refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${Math.round(options.refreshSeconds)}">`
      : "";
  const generated = new Date(data.generatedAt).toISOString().replace("T", " ").slice(0, 19);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
${refresh}
<title>${esc(data.title)}</title>
<style>${STYLE}</style>
<script>try{var t=localStorage.getItem("latch-report-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
</head>
<body>
<main>
<div class="top">
<div>
<h1>${esc(data.title)}</h1>
<p>From the Latch journal · generated ${esc(generated)} UTC${data.truncated ? ` · the ${data.payments.length.toLocaleString("en-US")} most recent payments` : ""}</p>
</div>
<div class="seg" role="group" aria-label="Theme">
<button type="button" data-theme-set="auto" aria-pressed="true">Auto</button>
<button type="button" data-theme-set="light" aria-pressed="false">Light</button>
<button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
</div>
</div>

<noscript><section><p class="empty">This page needs JavaScript to draw the report. It runs only code inside this file and loads nothing from the network.</p></section></noscript>

<div class="filters" role="search" aria-label="Filters">
<label>Time range
<select id="f-range">
<option value="all">All time</option>
<option value="hour">Last hour</option>
<option value="day">Last 24 hours</option>
<option value="week">Last 7 days</option>
<option value="month">Last 30 days</option>
</select></label>
<label>Outcome
<select id="f-outcome">
<option value="all">All outcomes</option>
<option value="delivered">Delivered</option>
<option value="void">Not charged</option>
<option value="in_flight">In progress</option>
<option value="stuck">Needs a human</option>
<option value="refunded">Refunded</option>
<option value="written_off">Written off</option>
</select></label>
<label>Search
<input id="f-q" type="search" placeholder="Payment, buyer, route or transaction" autocomplete="off"></label>
<button class="btn" id="reset" type="button" hidden>Clear filters</button>
<span class="count" id="count" aria-live="polite"></span>
</div>

<div class="alert" id="attention" role="status" hidden></div>
<div class="kpis" id="kpis"></div>

<div class="cols">
<section aria-labelledby="h-out">
<h2 id="h-out">Where every payment ended</h2>
<p class="sub">Each payment ends in exactly one of these. A charge without a result never appears here.</p>
<ul class="outcomes" id="outcomes"></ul>
</section>
<section aria-labelledby="h-act">
<div class="head">
<div><h2 id="h-act">Activity</h2><p class="sub">Hover or focus a bar for its numbers.</p></div>
<button class="btn" id="chart-toggle" type="button" aria-pressed="false">Show as table</button>
</div>
<div class="legend"><span><i class="sw a"></i>Delivered</span><span><i class="sw b"></i>Not delivered</span></div>
<div class="chart" id="chart"></div>
<div id="chart-table" hidden></div>
<p class="caption" id="chart-cap"></p>
</section>
</div>

<div class="cols">
<section aria-labelledby="h-sold">
<h2 id="h-sold">What sold</h2>
<p class="sub">Delivered payments by route, largest first.</p>
<ul class="rank" id="sold"></ul>
</section>
<section aria-labelledby="h-buy">
<h2 id="h-buy">Top buyers</h2>
<p class="sub">Delivered payments by paying wallet, largest first.</p>
<ul class="rank" id="buyers"></ul>
</section>
</div>

<section aria-labelledby="h-rec">
<h2 id="h-rec">Recoveries</h2>
<p class="sub">Work Latch did that a server without it would have lost or done twice.</p>
<div class="stats" id="stats"></div>
</section>

<section aria-labelledby="h-pay">
<div class="head">
<div><h2 id="h-pay">Payments</h2><p class="sub" id="table-sub"></p></div>
<button class="btn" id="export" type="button">Export CSV</button>
</div>
<div class="wrap"><table>
<thead><tr>
<th id="th-time" class="num" aria-sort="descending"><button type="button" id="sort-time">Time (UTC)</button></th>
<th>Payment</th><th>Buyer</th><th>Route</th>
<th id="th-amount" class="num amt" aria-sort="none"><button type="button" id="sort-amount">Amount</button></th>
<th>Outcome</th><th>Settlement</th>
</tr></thead>
<tbody id="rows"></tbody>
</table></div>
<div class="more" id="more" hidden><button class="btn" id="more-btn" type="button">Show more</button></div>
</section>

<footer>Read-only. This page loads nothing from the network; links open the block explorer only when you click them.</footer>
</main>
<script id="latch-data" type="application/json">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
