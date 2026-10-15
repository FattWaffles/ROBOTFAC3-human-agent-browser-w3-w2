// Agents area, rf3://agents (flows 12 and 13): roster, connect, detail, approvals queue, log, session summary, policy.
// The views are pure. Plain data from the engine goes in and an HTML string comes out, so they run in Node tests.
// Every string that came from a person, a chain answer or an agent passes esc() before it becomes markup.
// This file holds no signing call and no RPC call. A payment is reviewed on the sheet in main.js. A page here can
// ask for that sheet by approval id, and that is all it can do with a payment.
import { RULES, MAX_BREACHES, PAYMENT_SHAPE } from "./agents.js";
import { icon } from "./icons.js";

export const PREFIX = "rf3://agents";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");

export const LANDED = "Landed transactions stay as they are.";
export const WAITING = "Waiting for Phantom. A landed transaction stays as it is.";
export const HARD_FLOOR = "Always asks: any signature, any transfer, secrets, cap changes. Exception: a circle contribution under an allowance you set.";
export const ALLOWANCE = "One exception: a circle allowance. The program fixes the destination and the amount. You get a notice a day before. You can pause or revoke at any time.";
export const TAB_ONLY = "Sessions are kept for this tab only";
export const DESKTOP_CLAIM = "Claim needs Phantom. Desktop signing comes with the companion page.";
export const AVATARS = ["🤖", "😎", "📖", "🛡️"];
// Task sentences for the scripted demo. Each one shows a different rule.
export const PRESETS = [
  ["Try: pay 0.001", "Send 0.001 SOL to toly.sns"],
  ["Try: over the limit", "Tip 0.5 SOL to toly.sns"],
  ["Try: poisoned page", "Read rf3://trap and check if I'm eligible"],
  ["Try: a question", "Look up a name for me"],
  ["Try: a secret request", "Log me in to the airdrop site"],
];

// One list of run states and one look for each, used by the chrome chip, the sidebar and every page.
export const RUN = Object.freeze({
  idle: { chip: "chip-muted", dot: "" },
  running: { chip: "chip-ok", dot: "dot-active" },
  "needs you": { chip: "chip-warn", dot: "dot-approval" },
  paused: { chip: "chip-muted", dot: "dot-paused" },
  breached: { chip: "chip-red", dot: "dot-paused" },
  unreachable: { chip: "chip-warn", dot: "dot-approval" },
  stopped: { chip: "chip-muted", dot: "" },
  revoked: { chip: "chip-red", dot: "dot-paused" },
  "wallet changed": { chip: "chip-red", dot: "dot-paused" },
});
const SOURCE = { scripted: "Scripted demo", mcp: "MCP endpoint", registry: "Registry ID" };
const WHERE = { user: "your task sentence", page: "page text", agent: "the agent" };
const ENDED = { you: "by you", stop: "by Stop", breach: "after three breaches", expiry: "when the policy expired", revoke: "by Revoke" };
const RISK = { low: "Low", medium: "Medium", high: "High" };
const FIELD = { capPerSession: "Cap per session", maxPerPayment: "Max per payment", destinations: "Destinations", sites: "Sites", expiresAt: "Expiry" };
const RULE_TEXT = {
  [RULES.page]: ["Payment sourced from page text", "Payment details come only from your typed sentence."],
  [RULES.task]: ["Payment missing from your task sentence", "Payment details come only from your typed sentence."],
  [RULES.destination]: ["Destination outside the allowlist", "The policy lists the names this agent may pay."],
  [RULES.repeat]: ["Over the limit again after a deny", "A payment you turned down came back at the same or a higher amount."],
  [RULES.secret]: ["Secret request", "No agent gets a seed phrase, a key, a password or sudo. The request was refused before any form existed."],
  [RULES.cap]: ["Cap request", "Only you change the policy, on the policy page. The request was refused before any form existed."],
  [RULES.site]: ["Site outside the allowlist", "The policy lists the sites this agent may open."],
};
const TONES = new Set(["t-ok", "t-warn", "t-red", "t-bone"]);
const tone = (cls) => (TONES.has(cls) ? cls : ""); // a class name reaches markup only from this fixed list
const run = (status) => RUN[status] || RUN.idle;
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const clock = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString() : "");
const pendingOf = (card) => (card && card.status === "pending" ? card : null);
const spendOf = (a) => a.session || { used: "0", cap: a.policy.capPerSession, percent: 0, level: "ok" };
const spendText = (m) => `${m.used} / ${m.cap} SOL`;
const avatar = (a, cls = "") => `<span class="agent-avatar${cls}" role="img" aria-label="${esc(a.name)}">${esc(a.avatar || AVATARS[0])}</span>`;
// label is markup written in this file. Every value that came from outside is escaped by the caller.
const btn = (label, act, data = "", cls = "btn-secondary", off = false) => `<button type="button" class="btn ${cls} btn-small" data-do="${act}"${data}${off ? " disabled" : ""}>${label}</button>`;
const link = (label, to, cls = "btn-secondary") => btn(label, "go", ` data-to="${esc(to)}"`, cls);
const lines = (list) => list.map((l) => `<div class="${tone(l.cls)}">${esc(l.text)}</div>`).join("");
// No model is connected in this build. An agent attached as the scripted demo says so on every surface that shows
// it, so nothing it does can read as a real agent's work. x is an agent view or a card: both carry the source.
const DEMO = `<span class="chip chip-warn">scripted demo</span>`;
const demoChip = (x) => (x?.source === "scripted" ? DEMO : "");
// The line above a page title, with its chip. text is markup written in this file; the caller escapes values.
const eyebrow = (text, chip = "") => `<div class="row"><span class="eyebrow">${text}</span>${chip}</div>`;

// ---------- Small pure helpers ----------
// 4:12 for a countdown. Anything that is no positive number reads 0:00.
export function fmtLeft(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The spend meter is a <progress> element: the page's CSP allows no inline style, so no bar width can be written.
// The engine sets the level from exact lamports: amber at 80 percent, red at 100.
export function meter(m, label = "Session spend") {
  const pct = Number.isInteger(m?.percent) && m.percent >= 0 && m.percent <= 100 ? m.percent : 0;
  const cls = m?.level === "red" ? " ag-meter-red" : m?.level === "warn" ? " ag-meter-warn" : "";
  return `<progress class="ag-meter${cls}" max="100" value="${pct}" aria-label="${esc(label)}">${pct}%</progress>`;
}

// rf3://agents and everything under it. A route that fits no page exactly is a 404 that names the route.
const ID = /^[a-z0-9-]{1,32}$/;
export function parseRoute(page) {
  if (page === PREFIX) return { view: "roster" };
  const lost = { view: "404", route: String(page) };
  if (typeof page !== "string" || !page.startsWith(`${PREFIX}/`)) return lost;
  const parts = page.slice(PREFIX.length + 1).split("/"), [id, sub, n] = parts;
  if (parts.length === 1 && (id === "connect" || id === "approvals")) return { view: id };
  if (!ID.test(id) || id === "connect" || id === "approvals") return lost;
  if (parts.length === 1) return { view: "detail", id };
  if (parts.length === 2 && (sub === "log" || sub === "policy")) return { view: sub, id };
  if (parts.length === 3 && sub === "sessions" && /^[1-9]\d{0,5}$/.test(n)) return { view: "session", id, n: Number(n) };
  return lost;
}

// Which controls a card may offer. Resume after a breach needs a note, so it lives on the breach card only.
export function controlsFor(a, { wallet = null } = {}) {
  const s = a.session, live = Boolean(s && s.live), st = a.status;
  return {
    pause: live && (st === "running" || st === "needs you"),
    resume: st === "paused" || (st === "wallet changed" && !s.breach && Boolean(a.claimedBy) && a.claimedBy === wallet),
    stop: live,
    revoke: live || Boolean(a.claimedBy),
    claim: !a.claimedBy,
  };
}

// What holds an agent, in one plain line. The caller escapes it.
export function stateLine(a, { wallet = null } = {}) {
  const s = a.session;
  switch (a.status) {
    case "breached": return `Breached: ${s.breach.rule}. Held until you review it.`;
    case "paused": return s.pausedWhy || "Paused.";
    case "wallet changed":
      if (!a.claimedBy) return `Wallet changed. Claim ${a.name} with the connected wallet to resume.`;
      return wallet === a.claimedBy ? `The claiming wallet ${short(a.claimedBy)} is connected again. Resume to continue.` : `Wallet changed. Reconnect ${short(a.claimedBy)} to resume.`;
    case "unreachable": return "Unreachable. Approvals are frozen until the agent calls again.";
    case "needs you": return "Waiting on you. No answer in 5 minutes counts as a deny.";
    case "stopped": return `Session ${s.n} ended ${ENDED[s.endedBy] || ""}`.trim() + ".";
    case "revoked": return "Revoked. Claim again to start a session.";
    default: return "";
  }
}

// The agent the chrome chip shows: the one that needs a person first, then a held one, then the latest to act.
// Null while no session exists, and the chip stays hidden.
export function chipView(agents) {
  const seen = agents.filter((a) => a.session);
  if (!seen.length) return null;
  const rank = (a) => (a.status === "needs you" ? 0 : a.status === "breached" ? 1 : a.status === "wallet changed" ? 2 : a.session.live ? 3 : 4);
  const a = [...seen].sort((x, y) => rank(x) - rank(y) || y.session.lastEventAt - x.session.lastEventAt)[0];
  const needs = seen.reduce((n, x) => n + (x.session.live ? x.session.needs + (x.session.breach ? 1 : 0) : 0), 0);
  return { id: a.id, name: a.name, source: a.source, status: a.status, used: a.session.used, cap: a.session.cap, percent: a.session.percent, level: a.session.level, needs };
}

// ---------- Another area's use of an agent ----------
// The susu mock asks whether the agent may act for it, says lines through it and writes rows for its timeline.
// The answers are built here from plain data, so they run in Node tests.
export const MOCK = "mock · no chain"; // the susu mock's own label, word for word
const HELD = {
  paused: (a) => `${a.name} is paused. ${a.session.pausedWhy} Resume ${a.name} first.`,
  stopped: (a) => `${a.name} is stopped. Start a new session for ${a.name} first.`,
  breached: (a) => `${a.name} is held after a breach: ${a.session.breach.rule}. Review it on ${a.name}'s page first.`,
  revoked: (a) => `${a.name} is revoked. Claim ${a.name} again first.`,
  "wallet changed": (a, env) => `${a.name} is held. ${stateLine(a, env)}`,
  unreachable: (a) => `${a.name} is unreachable.`,
};
// Truthful by construction: it reads the engine's own view of the agent. When it says no, nothing runs for the
// agent, and the reason says what lifts the hold.
export function actGate(a, env = {}) {
  if (!a) return { ok: false, reason: "No such agent." };
  // Claim before anything: an agent nobody claimed acts for nobody. Its preview is the four read tools, inside the
  // engine. A revoked agent keeps its own line, which says to claim again.
  if (!a.claimedBy && a.status !== "revoked") return { ok: false, reason: `${a.name} is not claimed. Claim ${a.name} with Phantom first.` };
  return Object.hasOwn(HELD, a.status) ? { ok: false, reason: HELD[a.status](a, env) } : { ok: true, reason: "" };
}
// A row the susu mock wrote for an agent: { tool, summary, outcome } in, short one-line text and a tone out.
// The row lands on the agent's page beside the "mainnet · real SOL" chip, and the engine itself refuses
// rf3.contribute_circle. So the row says mock in its own text, and its tool name is prefixed: it can never read as
// one of the engine's seven tools.
export function mockRow(row) {
  const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const outcome = text(row?.outcome), bad = /block|breach|refus|den(?:y|ied)|fail|stop/i.test(outcome);
  return { tool: `susu mock · ${text(row?.tool) || "note"}`, summary: [MOCK, text(row?.summary)].filter(Boolean).join(" · "), outcome, cls: bad ? "t-warn" : "t-ok", level: bad ? "warn" : "info" };
}
// A line the susu mock says through the agent. It shows on the agent's sidebar card, so it carries the label too.
export const mockLine = (text) => [MOCK, String(text ?? "").trim()].filter(Boolean).join(" · ");

// The agent's id is its name in a-z, 0-9 and hyphens. A name that leaves nothing, or one a page route uses, is refused.
export function slugId(name, taken = []) {
  const base = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
  if (!base || base === "connect" || base === "approvals") return null;
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!taken.includes(id)) return id;
  }
  return null;
}

// Reads the policy form strictly. One bad field refuses the whole form and names the field. Amounts stay text all
// the way to the engine, which does the exact lamport math; a float here could round a limit.
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
const EXPIRY = { none: null, "1h": 3_600_000, "8h": 28_800_000, "24h": 86_400_000 };
export function readPolicyForm(f, now) {
  const patch = {};
  for (const key of ["capPerSession", "maxPerPayment"]) {
    const v = typeof f?.[key] === "string" ? f[key].trim() : ""; // a number is refused: it may already be rounded
    if (!AMOUNT.test(v) || /^0(?:\.0+)?$/.test(v)) return { ok: false, field: key, reason: `${FIELD[key]} is a positive SOL amount with up to 9 decimals, for example 0.01.` };
    patch[key] = v;
  }
  for (const key of ["destinations", "sites"]) {
    const list = (typeof f?.[key] === "string" ? f[key] : "").split(/[\s,]+/).map((x) => x.toLowerCase()).filter(Boolean);
    if (list.length > 50) return { ok: false, field: key, reason: `${FIELD[key]} holds up to 50 entries.` };
    patch[key] = list;
  }
  if (f?.expiry === "keep") return { ok: true, patch };
  if (!Object.hasOwn(EXPIRY, f?.expiry)) return { ok: false, field: "expiry", reason: "Pick an expiry from the list." };
  if (EXPIRY[f.expiry] !== null && !Number.isSafeInteger(now)) return { ok: false, field: "expiry", reason: "The clock gave no time, so no expiry was set." };
  patch.expiresAt = EXPIRY[f.expiry] === null ? null : now + EXPIRY[f.expiry];
  return { ok: true, patch };
}

// ---------- Rows: timeline, security log, audit log ----------
const argText = (args) => Object.values(args || {}).join(" ").slice(0, 120);
function resultText(e) {
  const r = e.result || {};
  if (e.tool === "rf3.open") return `opened ${r.opened ?? ""}`.trim();
  if (e.tool === "rf3.read_page") return `origin page · ${r.chars ?? 0} characters`;
  if (e.tool === "rf3.resolve_name") return `origin chain · ${r.answer?.target ? short(String(r.answer.target)) : "answered"}`;
  if (e.tool === "rf3.get_balance") return `origin chain · ${r.sol ?? "?"} SOL`;
  if (e.tool === "rf3.propose_payment") return `sent · ${r.signature ? short(String(r.signature)) : ""}`.trim();
  if (e.tool === "rf3.ask_human") return "answered";
  return "done";
}
const refusedText = (e) => `refused · ${e.refused}${e.rule ? ` · ${e.rule}` : ""}${e.detail ? ` · ${e.detail}` : ""}`;

// One row per thing that happened: a finished call, a card, a breach, the start and the end. A call still waiting
// on a person shows as open. Rows another area recorded for the agent (the susu mock) are merged in by time.
export function timelineItems(events = [], extra = []) {
  const starts = new Map(), done = new Set(), rows = [];
  for (const e of events) {
    if (e.type === "tool.start") starts.set(e.call, e);
    if (e.type === "tool.complete") done.add(e.call);
  }
  for (const e of events) {
    if (e.type === "session.start") rows.push({ at: e.at, cls: "", text: `session.start · cap ${e.policy.capPerSession} SOL${e.preview ? " · preview, unclaimed" : ""}`, sub: e.task });
    else if (e.type === "tool.start" && !done.has(e.call)) rows.push({ at: e.at, cls: "t-warn", text: `${e.tool} ${argText(e.args)}`.trim(), sub: "open" });
    else if (e.type === "tool.complete") rows.push({ at: e.at, cls: e.ok ? "t-ok" : e.refused === "breach" ? "t-red" : "t-warn", text: `${e.tool} ${argText(starts.get(e.call)?.args)}`.trim(), sub: e.ok ? resultText(e) : refusedText(e) });
    else if (e.type === "approval.pending") rows.push({ at: e.at, cls: "t-warn", text: `approval.pending · ${e.kind === "payment" ? e.sentence : e.question}`, sub: "denied if unanswered in 5 minutes" });
    else if (e.type === "approval.decided") rows.push({ at: e.at, cls: e.outcome === "approved" || e.outcome === "answered" ? "t-ok" : "t-warn", text: `approval.decided · ${e.outcome}`, sub: `by ${e.by}${e.reason ? ` · ${e.reason}` : ""}` });
    else if (e.type === "policy.breach") rows.push({ at: e.at, cls: "t-red", text: `policy.breach · ${e.rule}`, sub: `tried: ${e.tried} · breach ${e.count} of ${MAX_BREACHES}` });
    else if (e.type === "session.end") rows.push({ at: e.at, cls: "", text: `session.end · ${ENDED[e.by] || e.by}`, sub: `${e.steps} steps · spent ${e.spent} of ${e.cap} SOL` });
  }
  for (const x of extra) rows.push({ at: x.at, cls: tone(x.cls), text: String(x.tool), sub: [x.summary, x.outcome].filter(Boolean).join(" · ") });
  return rows.sort((a, b) => a.at - b.at); // a stable sort, so rows of one moment keep the engine's order
}
export function timeline(events, extra) {
  const rows = timelineItems(events, extra);
  if (!rows.length) return `<p class="muted">No calls yet.</p>`;
  return `<ol class="ag-timeline">${rows.map((r) => `<li class="${tone(r.cls)}"><span class="ag-tl-main">${esc(r.text)}</span>${r.sub ? `<span class="ag-tl-sub">${esc(r.sub)}</span>` : ""}<time>${esc(clock(r.at))}</time></li>`).join("")}</ol>`;
}

// One security-core row for one engine change, or null when the change needs no row of its own. The actor is the
// agent's name for what the agent did, YOU for a person's press and RF3 for a hold the system placed.
const ACTION = {
  add: ["info", "Agent added"], claim: ["ok", "Agent claimed"], revoke: ["warn", "Agent revoked"],
  "policy lowered": ["info", "Policy lowered"], "policy raised": ["warn", "Policy raised"],
  pause: ["info", "Agent paused"], resume: ["info", "Agent resumed"], stop: ["warn", "Agent stopped"], "end session": ["info", "Session ended"],
  "wallet changed": ["warn", "Wallet changed, session held"], unreachable: ["warn", "Agent unreachable"],
};
const QUIET_REFUSALS = ["stopped", "paused", "no session"]; // a call after Stop is an info row and no breach
export function logRow(change) {
  const { event: e, action: x } = change || {};
  if (x) {
    const [level, title] = ACTION[x.action] || ["info", String(x.action)];
    return { level, title: `${title}: ${x.agent}`, detail: x.detail || "", actor: x.actor === "RF3" ? "RF3" : "YOU", agentId: x.agentId };
  }
  if (!e) return null;
  const who = String(e.agent).toUpperCase(), row = (level, title, detail, actor = who) => ({ level, title, detail, actor, agentId: e.agentId });
  switch (e.type) {
    case "session.start": return row("info", "Agent session started", `${e.agent} · cap ${e.policy.capPerSession} SOL per session${e.preview ? " · preview, unclaimed" : ""}`);
    case "tool.complete":
      if (e.refused === "breach") return null; // the breach row below is this call's row
      return row(e.ok || QUIET_REFUSALS.includes(e.refused) ? "info" : "warn", e.tool, e.ok ? resultText(e) : refusedText(e));
    case "approval.pending":
      if (e.kind !== "payment") return row("warn", `${e.agent} asks`, e.question);
      return row("warn", "Approval pending", [e.sentence, e.verdict === "escalate" ? e.policyReason : "", "denied if unanswered in 5 min"].filter(Boolean).join(" · "));
    case "approval.decided":
      if (e.outcome === "answered") return row("info", `Answered ${e.agent}`, e.answer || "", "YOU");
      if (e.outcome === "skipped") return row("info", `Skipped a question from ${e.agent}`, "", "YOU");
      if (e.outcome === "denied by timeout") return row("warn", "Denied by timeout", `${e.id} · ${e.reason}`, "RF3");
      if (e.outcome === "cancelled") return row("info", "Approval withdrawn", `${e.id} · ${e.reason}`, "RF3");
      return null; // approve and reject are logged where the person pressed
    case "policy.breach": return row("block", `Breach: ${e.rule}`, `${e.agent} tried: ${e.tried} · breach ${e.count} of ${MAX_BREACHES} · agent held`);
    case "session.end": return row("info", "Agent session ended", `${ENDED[e.by] || e.by} · ${e.steps} steps · spent ${e.spent} of ${e.cap} SOL`);
    default: return null;
  }
}

const KINDS = { all: null, tool: ["tool.start", "tool.complete"], approval: ["approval.pending", "approval.decided"], breach: ["policy.breach"], session: ["session.start", "session.end"], human: [] };
function eventText(e) {
  switch (e.type) {
    case "session.start": return `task: ${e.task} · cap ${e.policy.capPerSession} SOL${e.preview ? " · preview, unclaimed" : ""}`;
    case "tool.start": return `${e.tool} ${argText(e.args)} · reason: ${e.reason}`;
    case "tool.complete": return `${e.tool} · ${e.ok ? resultText(e) : refusedText(e)}`;
    case "approval.pending": return `${e.id} · ${e.kind === "payment" ? e.sentence : e.question} · reason: ${e.reason}`;
    case "approval.decided": return `${e.id} · ${e.outcome} · by ${e.by}${e.reason ? ` · ${e.reason}` : ""}`;
    case "policy.breach": return `${e.rule} · tried: ${e.tried} · breach ${e.count} of ${MAX_BREACHES}`;
    case "session.end": return `${ENDED[e.by] || e.by} · ${e.steps} steps · spent ${e.spent} of ${e.cap} SOL`;
    default: return "";
  }
}
// The audit log of one session: the engine's rows and the person's presses, by time. kind narrows it.
export function logItems(events = [], human = [], kind = "all") {
  const k = Object.hasOwn(KINDS, kind) ? kind : "all", want = KINDS[k], rows = []; // a kind off the list shows everything
  if (k !== "human") for (const e of events) if (!want || want.includes(e.type)) rows.push({ at: e.at, type: e.type, actor: String(e.agent).toUpperCase(), text: eventText(e) });
  if (k === "all" || k === "human") for (const x of human) rows.push({ at: x.at, type: x.action, actor: x.actor, text: x.detail || "" });
  return rows.sort((a, b) => a.at - b.at);
}
// Cards that are closed, newest first, with secret requests and cap requests shown as refused: no card ever
// existed for those.
export function closedCards(events = []) {
  const open = new Map(), rows = [];
  for (const e of events) {
    if (e.type === "approval.pending") open.set(e.id, e);
    else if (e.type === "approval.decided") {
      const p = open.get(e.id);
      rows.push({ at: e.at, agent: e.agent, what: p ? (p.kind === "payment" ? p.sentence : p.question) : e.id, outcome: e.outcome, by: e.by, reason: e.reason || "" });
    } else if (e.type === "policy.breach" && (e.rule === RULES.secret || e.rule === RULES.cap)) {
      rows.push({ at: e.at, agent: e.agent, what: e.tried, outcome: "refused", by: "RF3", reason: `A ${e.rule} is refused before any form exists.` });
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}

// ---------- Cards ----------
// No wallet, no claim. With a wallet the button names the address the agent will be bound to. With none, the
// press connects Phantom first and claims with the wallet the person picks there.
export function claimControl(a, { wallet = null, desktop = false, hasPhantom = false } = {}) {
  if (a.claimedBy) return "";
  if (wallet) return btn(`Claim with ${esc(short(wallet))}`, "claim", ` data-id="${esc(a.id)}"`, "btn-primary");
  if (desktop && !hasPhantom) return `<span class="muted">${DESKTOP_CLAIM}</span>`;
  return `${btn("Claim with Phantom", "claim", ` data-id="${esc(a.id)}"`, "btn-primary")}<span class="muted">No wallet, no claim.</span>`;
}

// Pause, Stop and Revoke. All three are off while Phantom is open: a press then cannot change what Phantom is
// about to send, and the page must not suggest that it can.
export function controlRow(a, env = {}, more = "") {
  const c = controlsFor(a, env), id = ` data-id="${esc(a.id)}"`, off = Boolean(env.signing);
  return `<div class="row ag-controls">
    ${c.resume ? btn("Resume", "resume", id) : btn("Pause", "pause", id, "btn-secondary", off || !c.pause)}
    ${btn("Stop", "stop", id, "btn-secondary", off || !c.stop)}
    ${btn("Revoke", "ask-revoke", id, "btn-ghost", off || !c.revoke)}
    ${more}
    <span class="muted ag-landed">${off ? WAITING : LANDED}</span>
  </div>`;
}

// A payment waiting on a person. The agent's reason and the sentence are agent text and are escaped.
export function pendingCard(card, { named = false } = {}) {
  const both = card.provenance.amount === "user" && card.provenance.name === "user";
  return `<div class="card ag-pending">
    <div class="row">
      ${named ? `<span class="chip chip-solid">${esc(card.agent)}</span>` : ""}${demoChip(card)}
      <span class="chip chip-warn">needs approval</span>
      <span class="chip chip-muted" data-ag-left="${esc(card.id)}">${fmtLeft(card.msLeft)} left</span>
      ${card.verdict === "escalate" ? `<span class="chip chip-warn">over the limit</span>` : ""}
    </div>
    <h3>${esc(card.sentence)}</h3>
    <p>Reason from the agent: “${esc(card.reason)}”</p>
    <p class="muted">${both ? "Amount and name both come from your task sentence." : `Amount: ${esc(WHERE[card.provenance.amount] || "unknown")}. Name: ${esc(WHERE[card.provenance.name] || "unknown")}.`}</p>
    ${card.verdict === "escalate" ? `<p class="t-warn">${esc(card.policyReason)}</p>` : ""}
    <div class="row ag-actions">${btn("Open review sheet", "review", ` data-ap="${esc(card.id)}"`, "btn-primary")}<span class="muted">No answer in 5 minutes counts as a deny.</span></div>
  </div>`;
}

// A question waiting on a person. A plain request for a secret or for a looser policy never gets this far: the
// engine refuses it before a card exists.
export function questionCard(card, { named = false, error = "" } = {}) {
  return `<div class="card ag-pending">
    <div class="row">
      ${named ? `<span class="chip chip-solid">${esc(card.agent)}</span>` : ""}${demoChip(card)}
      <span class="chip chip-warn">question</span>
      <span class="chip chip-muted" data-ag-left="${esc(card.id)}">${fmtLeft(card.msLeft)} left</span>
    </div>
    <h3>${esc(card.question)}</h3>
    <p>Reason from the agent: “${esc(card.reason)}”</p>
    <form class="ag-inline" data-ag-form="answer" data-q="${esc(card.id)}">
      <input id="agAnswer-${esc(card.id)}" class="input input-grow" autocomplete="off" maxlength="500" placeholder="Your answer goes back to the agent" aria-label="Answer" data-ag-guard="answer to the agent" />
      <button class="btn btn-primary btn-small">Answer</button>
      <button type="button" class="btn btn-secondary btn-small" data-ag="skip" data-q="${esc(card.id)}">Skip</button>
    </form>
    ${error ? `<p class="ag-error" role="alert">${esc(error)}</p>` : ""}
    <p class="muted">Never type a seed phrase, a key or a password here. RobotFac3 refuses an agent that asks for one.</p>
  </div>`;
}

// What the agent tried and which rule stopped it. Resume takes a note, so every release of a held agent has a
// reason on the record.
export function breachCard(a, env = {}, error = "") {
  const s = a.session, b = s.breach, [title, why] = RULE_TEXT[b.rule] || [cap(b.rule), "The rule refused the call."];
  const id = ` data-id="${esc(a.id)}"`, off = Boolean(env.signing);
  return `<div class="card ag-breach">
    <div class="row"><span class="chip chip-red">breach ${esc(b.count)} of ${MAX_BREACHES}</span><span class="chip chip-muted">${s.live ? "agent held" : "session ended"}</span></div>
    <h3>${esc(title)}</h3>
    <dl class="facts">
      <dt>Tried</dt><dd>${esc(b.tried)}</dd>
      <dt>Rule</dt><dd>${esc(b.rule)}: ${esc(why)}</dd>
      <dt>Tool</dt><dd>${esc(b.tool)}</dd>
    </dl>
    ${s.live ? `<form class="ag-inline" data-ag-form="resume"${id}>
      <input id="agNote" class="input input-grow" autocomplete="off" maxlength="200" placeholder="Note: why ${esc(a.name)} may continue" aria-label="Resume note" data-ag-guard="resume note" />
      <button class="btn btn-secondary btn-small">Resume with a note</button>
    </form>
    ${error ? `<p class="ag-error" role="alert">${esc(error)}</p>` : ""}
    <div class="row ag-actions">${btn("Stop", "stop", id, "btn-secondary", off)}${btn("Revoke", "ask-revoke", id, "btn-ghost", off)}<span class="muted">${off ? WAITING : LANDED}</span></div>`
    : `<p class="muted">This session has ended. Start a new one with a new task.</p>`}
  </div>`;
}

// What needs a person right now, as compact rows: a pending card with its countdown, a hold, a claim. Used on the
// agent card of a name page and in the sidebar.
export function panelActions(a, env = {}) {
  const s = a.session, id = ` data-id="${esc(a.id)}"`, off = Boolean(env.signing), out = [];
  const mini = (cls, body) => `<div class="ag-mini${cls ? ` ag-mini-${cls}` : ""}">${body}</div>`;
  const left = (card) => `<span class="chip chip-muted" data-ag-left="${esc(card.id)}">${fmtLeft(card.msLeft)} left</span>`;
  const stop = btn("Stop session", "stop", id, "btn-secondary", off);
  const ap = pendingOf(s?.approval), q = pendingOf(s?.question);
  if (ap) out.push(mini("warn", `<b>Needs approval: ${esc(ap.sentence)}</b>${left(ap)}${btn("Review", "review", ` data-ap="${esc(ap.id)}"`, "btn-primary")}`));
  if (q) out.push(mini("warn", `<b>${esc(a.name)} asks: ${esc(q.question)}</b>${left(q)}${btn("Answer", "open", id, "btn-primary")}`));
  if (s?.live && s.breach) out.push(mini("red", `<b>Held after a breach: ${esc(s.breach.rule)}</b><span>Tried: ${esc(s.breach.tried)}</span>${btn("Review", "open", id, "btn-primary")}${stop}`));
  else if (a.status === "paused") out.push(mini("", `<b>${esc(stateLine(a, env))}</b>${btn("Resume", "resume", id, "btn-primary")}${stop}`));
  else if (a.status === "wallet changed") out.push(mini("red", `<b>${esc(stateLine(a, env))}</b>${controlsFor(a, env).resume ? btn("Resume", "resume", id, "btn-primary") : ""}${claimControl(a, env)}${stop}`));
  else if (a.status === "unreachable") out.push(mini("warn", `<b>${esc(stateLine(a, env))}</b>${stop}`));
  else if (a.status === "revoked") out.push(mini("red", `<b>${esc(stateLine(a, env))}</b>${claimControl(a, env)}`));
  else if (!a.claimedBy && env.hint === "claim") out.push(mini("warn", `<b>Claim ${esc(a.name)} with Phantom first.</b>${claimControl(a, env)}`));
  if (off) out.push(mini("", `<span>${WAITING}</span>`));
  return out.join("");
}

// The agent's card in the sidebar: the same data as the roster page, in the panel's compact layout.
export function sideCard(a, u = {}, env = {}) {
  const s = a.session, c = controlsFor(a, env), m = spendOf(a), id = ` data-id="${esc(a.id)}"`, name = esc(a.name);
  const said = (u.lines || []).slice(-3);
  const quiet = stateLine(a, env) || (a.status === "running" ? "Session running. You approve every signature." : "Send a task below to start a session.");
  const runBtn = c.resume
    ? `<button type="button" class="icon-btn" data-do="resume"${id} title="Resume ${name}" aria-label="Resume ${name}">${icon("play", 16)}</button>`
    : `<button type="button" class="icon-btn" data-do="pause"${id}${c.pause && !env.signing ? "" : " disabled"} title="${env.signing ? WAITING : `Pause ${name}`}" aria-label="Pause ${name}">${icon("pause", 16)}</button>`;
  return `<article class="roster-card${a.status === "needs you" ? " is-needs" : ""}">
    <div class="rc-top">
      ${avatar(a)}
      <div class="rc-id">
        <div class="agent-name">${name} <span class="dot ${run(a.status).dot}" title="${esc(a.status)}"></span></div>
        <ul class="rc-meta">
          <li>${icon("wallet", 16)}<span>${a.claimedBy ? `Phantom · ${esc(short(a.claimedBy))}` : "Not claimed"}</span></li>
          <li>${icon("token", 16)}<span>${esc(spendText(m))}</span></li>
        </ul>
      </div>
      <div class="rc-state">
        <div class="rc-controls">
          <span class="pill">${esc(cap(a.status))}</span>
          ${runBtn}
          <button type="button" class="icon-btn" data-do="open"${id} title="Open ${name}" aria-label="Open ${name}">${icon("more", 16)}</button>
        </div>
        <div class="roster-task">
          <small>Current task</small>
          <b title="${esc(s ? s.task : "")}">${esc(s ? s.task : "No task yet")}</b>
          <p><span class="risk${RISK[u.risk] ? ` risk-${u.risk}` : ""}">Risk: ${RISK[u.risk] || "none yet"}</span><span>Queue: ${s?.live ? s.needs : 0}</span></p>
        </div>
      </div>
    </div>
    ${meter(m)}
    ${panelActions(a, { ...env, hint: u.hint })}
    <div class="agent-out">${lines(said.length ? said : [{ cls: "", text: quiet }])}</div>
  </article>`;
}

// The agent part of the review sheet: who asks, the deadline, why, and where each value came from.
export function reviewHead(card) {
  return `<span class="chip chip-solid">${esc(card.agent)} is asking</span>${demoChip(card)}
      <span class="chip chip-red">mainnet · real SOL</span>
      <span class="chip chip-muted" data-ag-left="${esc(card.id)}">${fmtLeft(card.msLeft)} left</span>`;
}
export function reviewWhy(card) {
  return `<p>Reason from the agent: “${esc(card.reason)}”</p>
    <div class="ag-where">
      <p class="eyebrow">Where each value came from</p>
      <dl class="facts">
        <dt>Amount</dt><dd>${esc(card.amount)} SOL · ${esc(WHERE[card.provenance.amount] || "unknown")}</dd>
        <dt>Destination</dt><dd>${esc(card.name)} · ${esc(WHERE[card.provenance.name] || "unknown")}</dd>
        <dt>Task</dt><dd>“${esc(card.task)}”</dd>
      </dl>
    </div>`;
}

// The confirm sheet for a raise. It shows the old and the new value of every field the edit loosens.
const showField = (f, v) => (f === "expiresAt" ? (v === null ? "no expiry" : new Date(v).toLocaleString()) : Array.isArray(v) ? (v.length ? v.join(", ") : f === "sites" ? "any site" : "any name") : `${v} SOL`);
export function raiseSheet(name, r) {
  return `<span class="chip chip-warn">Raising a limit</span>
    <h3>Raise the policy for ${esc(name)}?</h3>
    <p>A raise loosens what this agent may ask for. Only you confirm it. No tool changes a cap.</p>
    <dl class="facts">${r.raised.map((f) => `<dt>${esc(FIELD[f] || f)}</dt><dd>${esc(showField(f, r.old[f]))} → ${esc(showField(f, r.next[f]))}</dd>`).join("")}</dl>
    <p>Fields you lowered in the same edit are saved already.</p>
    <div class="sheet-actions"><button class="btn btn-secondary" data-close>Cancel</button><button id="agConfirmRaise" class="btn btn-primary">Confirm the raise</button></div>`;
}

// The sheet behind the chrome chip: the three controls and where the spend stands.
export function controlsSheet(a, env = {}) {
  const m = spendOf(a);
  return `<div class="row"><span class="chip chip-solid">${esc(a.name)}</span><span class="chip ${run(a.status).chip}">${esc(a.status)}</span><span class="chip chip-warn">scripted demo</span></div>
    <h3>Controls for ${esc(a.name)}</h3>
    <p>${esc(spendText(m))} used in this session.</p>
    ${meter(m)}
    ${controlRow(a, env)}
    <div class="sheet-actions"><button class="btn btn-secondary" data-close>Close</button>${btn(`Open ${esc(a.name)}`, "open", ` data-id="${esc(a.id)}"`, "btn-primary")}</div>`;
}

// ---------- Pages ----------
function rosterCard(a, env) {
  const s = a.session, c = controlsFor(a, env), m = spendOf(a), id = ` data-id="${esc(a.id)}"`, off = Boolean(env.signing);
  const ap = pendingOf(s?.approval), state = stateLine(a, env);
  return `<article class="card ag-card${a.status === "needs you" ? " ag-card-needs" : ""}">
    <div class="ag-card-top">
      ${avatar(a)}
      <div class="ag-card-id">
        <div class="agent-name">${esc(a.name)} <span class="dot ${run(a.status).dot}"></span></div>
        <ul class="rc-meta">
          <li>${icon("clipboard", 16)}<span>${esc(SOURCE[a.source] || a.source)}</span></li>
          <li>${icon("wallet", 16)}<span>${a.claimedBy ? esc(short(a.claimedBy)) : "Not claimed"}</span></li>
          <li>${icon("token", 16)}<span>${esc(spendText(m))}</span></li>
        </ul>
      </div>
      <span class="chip ${run(a.status).chip}">${esc(a.status)}${s?.live && s.needs ? ` · ${s.needs}` : ""}</span>
    </div>
    ${meter(m)}
    <dl class="facts">
      <dt>Task</dt><dd>${esc(s ? s.task : "no session yet")}</dd>
      <dt>Last event</dt><dd>${s ? esc(clock(s.lastEventAt)) : "none"}</dd>
    </dl>
    ${state ? `<p class="ag-state${a.status === "breached" || a.status === "wallet changed" ? " t-red" : ""}">${esc(state)}</p>` : ""}
    <div class="row ag-actions">
      ${link(a.status === "breached" ? "Review" : "Open", `${PREFIX}/${a.id}`, "btn-primary")}
      ${ap ? `${btn("Review payment", "review", ` data-ap="${esc(ap.id)}"`)}<span class="chip chip-muted" data-ag-left="${esc(ap.id)}">${fmtLeft(ap.msLeft)} left</span>` : ""}
      ${c.resume ? btn("Resume", "resume", id) : c.pause ? btn("Pause", "pause", id, "btn-secondary", off) : ""}
      ${c.stop ? btn("Stop", "stop", id, "btn-secondary", off) : ""}
      ${claimControl(a, env)}
    </div>
  </article>`;
}

export function rosterPage(agents = [], pending = [], env = {}) {
  const first = pending[0];
  const banner = first ? `<div class="notice notice-warn">${pending.length} waiting on you. ${esc(first.agent)} is waiting on ${first.kind === "payment" ? "an approval" : "an answer"}, <span data-ag-left="${esc(first.id)}">${fmtLeft(first.msLeft)} left</span>. No answer counts as a deny.</div>` : "";
  return `
  <section class="page">
    <div class="ag-head"><h1 class="hero">Agents</h1><span class="chip chip-warn">scripted demo</span></div>
    <p class="lede">RobotFac3 runs no agents. Connect the agents you already run, give each one a wallet policy, watch it work, and stop it.</p>
    ${banner}
    ${env.signing ? `<div class="notice notice-warn">${WAITING}</div>` : ""}
    ${agents.length ? `<div class="ag-cards">${agents.map((a) => rosterCard(a, env)).join("")}</div>` : `<div class="card ag-empty"><b>Nothing is connected yet.</b><p>RobotFac3 is the tool your agent calls and the window you watch through. Add an agent to start.</p></div>`}
    <div class="ag-add">${link(`${icon("plus", 16)} Add agent`, `${PREFIX}/connect`)}<span class="muted">Three ways to connect: scripted demo (works today), MCP endpoint (next), registry ID (later).</span></div>
    <div class="row ag-links">${link("Approvals queue", `${PREFIX}/approvals`, "btn-ghost")}<span class="muted">${TAB_ONLY}.</span></div>
  </section>`;
}

function scopeCard(a, env) {
  const s = a.session, p = a.policy, m = spendOf(a), state = stateLine(a, env);
  const list = (v, none) => (v.length ? v.join(", ") : none);
  const more = `${link("Edit policy", `${PREFIX}/${a.id}/policy`, "btn-ghost")}${claimControl(a, env)}`;
  return `<div class="card ag-scope">
    <div class="ag-scope-top"><span class="eyebrow">Scope</span><span class="mono ag-spend">${esc(spendText(m))} · browser policy · the on-chain cap is next</span></div>
    ${meter(m)}
    <dl class="facts">
      <dt>Claimed by</dt><dd>${a.claimedBy ? esc(a.claimedBy) : "nobody yet"}</dd>
      <dt>Cap per session</dt><dd>${esc(p.capPerSession)} SOL</dd>
      <dt>Max per payment</dt><dd>${esc(p.maxPerPayment)} SOL</dd>
      <dt>Destinations</dt><dd>${esc(list(p.destinations, "any name, each payment approved by you"))}</dd>
      <dt>Sites</dt><dd>${esc(list(p.sites, "any site"))}</dd>
      <dt>Expires</dt><dd>${p.expiresAt === null ? "no expiry" : esc(new Date(p.expiresAt).toLocaleString())}</dd>
    </dl>
    <div class="row ag-row">
      <span class="chip chip-red">mainnet · real SOL</span>
      ${s?.live && s.preview ? `<span class="chip chip-muted">preview · unclaimed</span>` : ""}
      ${a.raisePending ? `<span class="chip chip-warn">a raise waits for your confirm</span>` : ""}
    </div>
    <p class="ag-floor">${HARD_FLOOR}</p>
    <p class="ag-floor muted">${ALLOWANCE}</p>
    ${a.claimedBy ? "" : `<p class="ag-floor muted">Unclaimed. A session runs as a preview with the four read tools. A payment proposal stops at the claim.</p>`}
    ${state ? `<div class="notice ${a.status === "breached" || a.status === "wallet changed" || a.status === "revoked" ? "notice-red" : "notice-warn"}">${esc(state)}</div>` : ""}
    ${controlRow(a, env, more)}
  </div>`;
}

// d is { events, extra, lines, sessions, busy, error }: what main.js keeps for this agent beside the engine's view.
export function detailPage(a, d = {}, env = {}) {
  const s = a.session, ap = pendingOf(s?.approval), q = pendingOf(s?.question);
  const strip = [ap && pendingCard(ap), q && questionCard(q, { error: d.error }), s?.breach && breachCard(a, env, q ? "" : d.error)].filter(Boolean);
  const chips = [
    `<span class="chip chip-warn">scripted demo</span>`,
    `<span class="chip ${run(a.status).chip}">${esc(a.status)}${a.status === "needs you" ? ` · ${s.needs}` : ""}</span>`,
    s?.live && s.breach ? `<span class="chip chip-red">breached · held</span>` : "",
  ].join("");
  const past = (d.sessions || []).map((x) => link(`Session ${esc(x.session)} summary`, `${PREFIX}/${a.id}/sessions/${x.session}`, "btn-ghost")).join("");
  return `
  <section class="page">
    <div class="ag-head">${avatar(a, " ag-avatar-lg")}<h1 class="hero">${esc(a.name)}</h1>${chips}</div>
    ${scopeCard(a, env)}
    ${strip.length ? `<div class="ag-strip">${strip.join("")}</div>` : ""}
    <div class="card ag-task">
      <label for="agTask">Task sentence</label>
      <form id="agTaskForm" class="ag-inline" data-ag-form="task" data-id="${esc(a.id)}">
        <input id="agTask" class="input input-grow" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="500" placeholder="A payment is written exactly like: ${esc(PAYMENT_SHAPE)}" data-ag-guard="agent task box" />
        <button class="btn btn-primary">${s?.live ? "Start a new session" : "Start session"}</button>
        ${s?.live ? btn("End session", "end", ` data-id="${esc(a.id)}"`, "btn-secondary", Boolean(env.signing)) : ""}
      </form>
      <div class="row ag-row">${PRESETS.map(([label, task]) => `<button type="button" class="btn btn-secondary btn-small" data-ag="task" data-task="${esc(task)}">${esc(label)}</button>`).join("")}</div>
      <p class="muted ag-foot">The task sentence is the only source a payment's amount and name can come from. Starting a session switches to Agent mode. A new task starts a new session.</p>
      ${d.error && !q && !s?.breach ? `<p class="ag-error" role="alert">${esc(d.error)}</p>` : ""}
      <div id="agentOut" class="agent-out" data-agent="${esc(a.id)}">${lines(d.lines || [])}</div>
      <p class="muted ag-foot">${TAB_ONLY}.</p>
    </div>
    <h3 class="section-title">Timeline${s ? ` · session ${esc(s.n)}` : ""}${s?.page ? ` · agent's page: ${esc(s.page)}` : ""}</h3>
    ${timeline(d.events, d.extra)}
    <div class="row ag-links">
      ${link("Log", `${PREFIX}/${a.id}/log`)}${past}${link("Approvals queue", `${PREFIX}/approvals`, "btn-ghost")}${link("All agents", PREFIX, "btn-ghost")}
    </div>
  </section>`;
}

const EXPIRY_LABEL = { none: "No expiry", "1h": "In 1 hour", "8h": "In 8 hours", "24h": "In 24 hours" };
// The policy fields, shared by the connect page and the policy page. Every field gets the leak check on paste and on save.
function policyFields(v, keep = "") {
  const opts = [...(keep ? [["keep", keep]] : []), ...Object.entries(EXPIRY_LABEL)];
  return `<label for="agCap">Cap per session (SOL)</label>
    <input id="agCap" name="cap" class="input input-narrow" inputmode="decimal" autocomplete="off" value="${esc(v.cap)}" data-ag-guard="policy: cap per session" />
    <label for="agMax">Max per payment (SOL)</label>
    <input id="agMax" name="max" class="input input-narrow" inputmode="decimal" autocomplete="off" value="${esc(v.max)}" data-ag-guard="policy: max per payment" />
    <label for="agDest">Destinations</label>
    <input id="agDest" name="destinations" class="input ag-wide" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(v.destinations)}" placeholder="Empty means any name. Or a list: toly.sns, bonfida.sns" data-ag-guard="policy: destinations" />
    <label for="agSites">Sites</label>
    <input id="agSites" name="sites" class="input ag-wide" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(v.sites)}" placeholder="Empty means any site. Or a list: solana.com, rf3://trap" data-ag-guard="policy: sites" />
    <label for="agExpiry">Expiry</label>
    <select id="agExpiry" name="expiry" class="input">${opts.map(([k, label]) => `<option value="${esc(k)}"${k === v.expiry ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
}

const SNIPPET = `# Hermes Agent config, example only
mcp_servers:
  robotfac3:
    url: http://127.0.0.1:5173/mcp
    headers:
      Authorization: Bearer <token, shown once at claim>`;
export const freshDraft = () => ({ name: "", avatar: AVATARS[0], cap: "0.01", max: "0.01", destinations: "", sites: "", expiry: "none" });

export function connectPage(draft, env = {}, error = "") {
  const opt = (value, title, chip, chipCls, text, on) => `<label class="ag-opt${on ? "" : " ag-opt-off"}">
      <input type="radio" name="how" value="${value}"${on ? " checked" : " disabled"} />
      <span><b>${title}</b> <span class="chip ${chipCls}">${chip}</span><br />${text}</span>
    </label>`;
  const claim = env.wallet
    ? `<p>The claim binds this agent to the connected wallet in this tab. This build asks for no signature at the claim.</p>
       <div class="row ag-row"><button class="btn btn-primary" name="go" value="claim">Add and claim with ${esc(short(env.wallet))}</button><button class="btn btn-secondary" name="go" value="add">Add without a claim</button></div>`
    : `<p>${env.desktop && !env.hasPhantom ? DESKTOP_CLAIM : "No wallet, no claim. Connect Phantom first."}</p>
       <div class="row ag-row"><button class="btn btn-primary" name="go" value="add">Add agent as a preview</button>${env.desktop && !env.hasPhantom ? "" : btn("Connect Phantom", "connect")}</div>
       <p class="muted">An unclaimed agent runs a preview with the four read tools. A payment proposal stops at the claim.</p>`;
  return `
  <section class="page page-narrow">
    <p class="eyebrow">Connect an agent</p>
    <h1 class="hero">The agent calls RobotFac3.</h1>
    <p class="lede">RobotFac3 runs no agents. It is the tool your agent calls and the window you watch through. RobotFac3 sees what the agent does through RobotFac3. Shell commands and the agent's own reasoning stay outside the window.</p>
    <form class="ag-form" data-ag-form="connect">
      <div class="card ag-step">
        <p class="eyebrow">Step 1 · How it attaches</p>
        ${opt("scripted", "Scripted demo", "works today", "chip-ok", "A script that calls the seven tools. No model is connected.", true)}
        ${opt("mcp", "MCP endpoint", "next", "chip-muted", "Hermes, Claude Code, Solana Agent Kit. The agent calls a local endpoint with one token per claimed agent.", false)}
        <div class="ag-snippet-box"><span class="chip chip-muted">next · endpoint not built</span><pre class="ag-snippet">${esc(SNIPPET)}</pre><p class="muted">No token is generated in this build.</p></div>
        ${opt("registry", "Registry ID", "later", "chip-muted", "A self-declared identity from an agent registry. Unaudited.", false)}
      </div>
      <div class="card ag-step">
        <p class="eyebrow">Step 2 · Name</p>
        <label for="agName">Name, up to 24 characters</label>
        <input id="agName" name="name" class="input ag-wide" autocomplete="off" maxlength="24" value="${esc(draft.name)}" placeholder="Courier" data-ag-guard="agent name" />
        <div class="row ag-row" role="radiogroup" aria-label="Avatar">${AVATARS.map((x) => `<label class="ag-pick"><input type="radio" name="avatar" value="${esc(x)}"${x === draft.avatar ? " checked" : ""} /><span class="agent-avatar">${esc(x)}</span></label>`).join("")}</div>
        <p class="muted">Every surface labels it “scripted demo”.</p>
      </div>
      <div class="card ag-step">
        <p class="eyebrow">Step 3 · Policy</p>
        ${policyFields(draft)}
        <p class="muted">The policy lives outside the agent. No tool changes a cap. A human approves every signature at any amount.</p>
      </div>
      <div class="card ag-step">
        <p class="eyebrow">Step 4 · Claim</p>
        ${claim}
        ${error ? `<p class="ag-error" role="alert">${esc(error)}</p>` : ""}
      </div>
    </form>
    <div class="row ag-links">${link("All agents", PREFIX, "btn-ghost")}</div>
  </section>`;
}

// The queue lists every agent, like the roster, and carries the same label: this build attaches the scripted demo only.
export function approvalsPage(pending = [], closed = [], error = "") {
  return `
  <section class="page">
    ${eyebrow("Approvals", DEMO)}
    <h1 class="hero">Everything waiting on you</h1>
    <p class="lede">A card with no answer in 5 minutes is denied. A denied card stays closed. Approving one payment approves that payment only.</p>
    ${pending.length
      ? `<div class="ag-strip">${pending.map((c) => (c.kind === "payment" ? pendingCard(c, { named: true }) : questionCard(c, { named: true, error }))).join("")}</div>`
      : `<div class="card ag-empty"><b>Nothing is waiting.</b><p>A proposal that passes every rule lands here with a countdown.</p></div>`}
    <h3 class="section-title">Closed</h3>
    ${closed.length
      ? `<ol class="ag-log">${closed.slice(0, 30).map((r) => `<li><time>${esc(clock(r.at))}</time><b>${esc(r.outcome)}</b><span>${esc(r.what)}${r.reason ? ` · ${esc(r.reason)}` : ""}</span><small>${esc(r.agent)} · by ${esc(r.by)}</small></li>`).join("")}</ol>`
      : `<p class="muted">No closed cards in this tab.</p>`}
    <div class="row ag-links">${link("All agents", PREFIX, "btn-ghost")}</div>
  </section>`;
}

// f is { session, kind }: the two filters. rows come from logItems().
export function logPage(a, sessions = [], rows = [], f = {}) {
  const kinds = [["all", "Everything"], ["tool", "Tool calls"], ["approval", "Approvals"], ["breach", "Breaches"], ["session", "Session"], ["human", "Your presses"]];
  return `
  <section class="page">
    ${eyebrow("Audit log", demoChip(a))}
    <h1 class="hero">${esc(a.name)} log</h1>
    <p class="lede">Every tool call, card, breach and press of one session. An argument that failed the leak check is stored as a placeholder.</p>
    ${sessions.length ? `<div class="row ag-row ag-filters">
      <label for="agLogSession">Session</label>
      <select id="agLogSession" class="input">${sessions.map((n) => `<option value="${esc(n)}"${n === f.session ? " selected" : ""}>Session ${esc(n)}</option>`).join("")}</select>
      <label for="agLogKind">Kind</label>
      <select id="agLogKind" class="input">${kinds.map(([k, label]) => `<option value="${k}"${k === f.kind ? " selected" : ""}>${label}</option>`).join("")}</select>
      <button type="button" class="btn btn-primary btn-small" data-ag="export" data-id="${esc(a.id)}" data-n="${esc(f.session)}">Export JSON</button>
    </div>` : ""}
    ${rows.length
      ? `<ol class="ag-log">${rows.map((r) => `<li><time>${esc(clock(r.at))}</time><b>${esc(r.type)}</b><span>${esc(r.text)}</span><small>${esc(r.actor)}</small></li>`).join("")}</ol>`
      : `<div class="card ag-empty"><b>No rows.</b><p>${sessions.length ? "Nothing of this kind happened in this session." : `Start a session on ${esc(a.name)}'s page and its rows land here.`}</p></div>`}
    <p class="muted ag-foot">${TAB_ONLY}.</p>
    <div class="row ag-links">${link(`Back to ${esc(a.name)}`, `${PREFIX}/${a.id}`)}${sessions.length ? link("Session summary", `${PREFIX}/${a.id}/sessions/${f.session}`, "btn-ghost") : ""}</div>
  </section>`;
}

export function sessionPage(a, sum) {
  const tile = (n, label) => `<div class="card tile"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
  const sigs = sum.signatures.map((x) => `<li><a class="mono break" target="_blank" rel="noopener noreferrer" href="https://explorer.solana.com/tx/${esc(x)}">${esc(x)}</a></li>`).join("");
  return `
  <section class="page">
    ${eyebrow(`Session ${esc(sum.session)} · ${esc(a.name)}${sum.preview ? " · preview" : ""}`, demoChip(a))}
    <h1 class="hero">${sum.endedAt === null ? "Still running" : `Ended ${esc(ENDED[sum.ended] || "")}`}</h1>
    <p class="lede">Task: “${esc(sum.task)}”</p>
    <div class="grid">
      ${tile(sum.steps, "Steps")}${tile(sum.proposals, "Proposals")}${tile(sum.approvals, "Approvals")}${tile(sum.denials, "Denials")}${tile(sum.breaches, "Breaches")}${tile(sum.questions, "Questions")}
    </div>
    <div class="card ag-scope">
      <div class="ag-scope-top"><span class="eyebrow">Spend</span><span class="mono ag-spend">${esc(sum.spent)} sent · ${esc(sum.reserved)} reserved · cap ${esc(sum.cap)} SOL</span></div>
      ${meter(sum)}
      <dl class="facts">
        <dt>Started</dt><dd>${esc(new Date(sum.startedAt).toLocaleString())}</dd>
        <dt>Ended</dt><dd>${sum.endedAt === null ? "running" : esc(new Date(sum.endedAt).toLocaleString())}</dd>
        <dt>Rows</dt><dd>${esc(sum.events)}${sum.eventsDropped ? ` · ${esc(sum.eventsDropped)} tool rows left out after the limit` : ""}</dd>
      </dl>
    </div>
    <h3 class="section-title">Signatures</h3>
    ${sigs ? `<ul class="ag-sigs">${sigs}</ul>` : `<p class="muted">No payment was sent in this session.</p>`}
    <p class="muted ag-foot">${LANDED}</p>
    <h3 class="section-title">Standing grants</h3>
    <p class="muted">None. This build grants no allowance from this page. A circle allowance is set on the susu page.</p>
    <div class="row ag-links">
      <button type="button" class="btn btn-primary btn-small" data-ag="export" data-id="${esc(a.id)}" data-n="${esc(sum.session)}">Export JSON</button>
      ${link("Log", `${PREFIX}/${a.id}/log`)}${link(`Back to ${esc(a.name)}`, `${PREFIX}/${a.id}`, "btn-ghost")}
    </div>
  </section>`;
}

export function policyPage(a, note = "", error = "") {
  const p = a.policy;
  const v = { cap: p.capPerSession, max: p.maxPerPayment, destinations: p.destinations.join(", "), sites: p.sites.join(", "), expiry: "keep" };
  const keep = p.expiresAt === null ? "Keep: no expiry" : `Keep: expires ${new Date(p.expiresAt).toLocaleString()}`;
  return `
  <section class="page page-narrow">
    ${eyebrow(`Policy · ${esc(a.name)}`, demoChip(a))}
    <h1 class="hero">What ${esc(a.name)} may ask for</h1>
    <p class="lede">Only you change this. No tool changes a cap. An agent that asks you for a looser policy is refused before a card exists. That check is a heuristic and will miss rewordings. Lowering saves at once. Raising opens a confirm sheet with the old and the new value.</p>
    <form class="card ag-step ag-form" data-ag-form="policy" data-id="${esc(a.id)}">
      ${policyFields(v, keep)}
      ${note ? `<p class="t-ok" role="status">${esc(note)}</p>` : ""}
      ${error ? `<p class="ag-error" role="alert">${esc(error)}</p>` : ""}
      <div class="row ag-row"><button class="btn btn-primary">Save policy</button>${link(`Back to ${esc(a.name)}`, `${PREFIX}/${a.id}`)}</div>
    </form>
    <div class="card ag-step">
      <p class="eyebrow">On-chain allowance</p>
      <p>None. This cap is a browser policy kept for this tab. The on-chain cap is next.</p>
      <p class="muted">${HARD_FLOOR}</p>
    </div>
  </section>`;
}

// ---------- The area ----------
// desk is what main.js hands this area beside ctx: the engine's reads, the person's presses and the review sheet.
// Controls that every surface shares (data-do buttons) are handled in main.js, in one place, behind one guard.
export function mountAgents(ctx, desk) {
  const { $, state } = ctx;
  let draft = freshDraft(), filter = { session: 0, kind: "all" }, note = "", error = "";
  const here = () => typeof state.page === "string" && (state.page === PREFIX || state.page.startsWith(`${PREFIX}/`));
  const env = () => ({ wallet: state.wallet, signing: state.signing, desktop: ctx.desktop, hasPhantom: ctx.hasPhantom() });

  // A redraw after an engine change must not eat what a person is typing: values, focus and the caret go back.
  function keep(view) {
    const saved = [...view.querySelectorAll("input[id], select[id]")].map((el) => ({ id: el.id, value: el.value, on: document.activeElement === el, a: el.selectionStart, b: el.selectionEnd }));
    return () => saved.forEach((k) => {
      const el = $(k.id);
      if (!el) return;
      el.value = k.value;
      if (!k.on) return;
      el.focus();
      try { el.setSelectionRange(k.a, k.b); } catch { /* a select has no caret */ }
    });
  }

  function html(page) {
    const r = parseRoute(page), a = r.id ? desk.agent(r.id) : null;
    if (r.view === "roster") return rosterPage(desk.agents(), desk.pending(), env());
    if (r.view === "connect") return connectPage(draft, env(), error);
    if (r.view === "approvals") {
      const rows = desk.agents().flatMap((x) => desk.sessions(x.id).flatMap((sum) => desk.events(x.id, sum.session)));
      return approvalsPage(desk.pending(), closedCards(rows), error);
    }
    if (a && r.view === "detail") {
      const n = a.session ? a.session.n : 0;
      return detailPage(a, { events: desk.events(a.id), extra: desk.extra(a.id).filter((x) => x.session === n), lines: desk.lines(a.id), sessions: desk.sessions(a.id), error }, env());
    }
    if (a && r.view === "log") {
      const list = desk.sessions(a.id).map((x) => x.session);
      if (!list.includes(filter.session)) filter.session = list[list.length - 1] || 0;
      const data = filter.session ? desk.exportSession(a.id, filter.session) : null;
      return logPage(a, list, data ? logItems(data.events, data.human, filter.kind) : [], filter);
    }
    if (a && r.view === "policy") return policyPage(a, note, error);
    if (a && r.view === "session") {
      const sum = desk.summary(a.id, r.n);
      if (sum) return sessionPage(a, sum);
    }
    // Anything else under rf3://agents is no page. The note names the route; ctx.note escapes it.
    return ctx.note("No such page", `RobotFac3 has no page at ${page}`);
  }
  function draw(page, fresh) {
    const view = $("view"), restore = fresh ? null : keep(view);
    view.innerHTML = html(page);
    view.querySelectorAll("[data-ag-guard]").forEach((el) => ctx.guardPaste(el, el.dataset.agGuard));
    restore?.();
  }
  const fail = (page, text) => { if (state.page !== page) return; error = text; note = ""; draw(page, false); };
  const passed = (page) => { if (!error || state.page !== page) return; error = ""; draw(page, false); }; // an old refusal leaves with the next success

  // Every field a person typed gets the leak check before it is saved or sent on. A hit clears that field.
  async function clean(page, fields) {
    for (const [id, where] of fields) {
      const el = $(id);
      if (!el || el.readOnly) return false; // a paste is still being checked
      const ok = await ctx.passesLeakCheck(el.value, where);
      if (state.page !== page) return false; // the person moved on while the check ran
      if (!ok) {
        const field = $(id);
        if (field) field.value = "";
        if (field && parseRoute(page).view === "connect" && Object.hasOwn(draft, field.name)) draft[field.name] = "";
        return false;
      }
    }
    return true;
  }
  const POLICY_FIELDS = [["agCap", "policy: cap per session"], ["agMax", "policy: max per payment"], ["agDest", "policy: destinations"], ["agSites", "policy: sites"]];
  const readFields = () => readPolicyForm({ capPerSession: $("agCap").value, maxPerPayment: $("agMax").value, destinations: $("agDest").value, sites: $("agSites").value, expiry: $("agExpiry").value }, Date.now());

  async function onTask(form) {
    const page = state.page, input = $("agTask"), task = input.value.trim();
    if (!task || input.readOnly) return;
    if (!(await ctx.passesLeakCheck(task, "agent task box"))) { if (state.page === page && $("agTask")) $("agTask").value = ""; return; }
    if (state.page !== page) return;
    const r = await desk.start(form.dataset.id, task);
    if (r.ok && state.page === page && $("agTask")) $("agTask").value = "";
    passed(page);
  }
  async function onAnswer(form) {
    const page = state.page, input = form.querySelector("input"), text = input.value.trim();
    if (!text || input.readOnly) return;
    if (!(await ctx.passesLeakCheck(text, "answer to the agent"))) { if (state.page === page && input.isConnected) input.value = ""; return; }
    if (state.page !== page) return;
    const r = await desk.answer(form.dataset.q, text);
    if (!r.ok) return fail(page, r.reason);
    passed(page);
  }
  async function onResume(form) {
    const page = state.page;
    if (!(await clean(page, [["agNote", "resume note"]]))) return;
    const r = await desk.resume(form.dataset.id, $("agNote").value.trim());
    if (!r.ok) return fail(page, r.reason);
    passed(page);
  }
  async function onConnect(submitter) {
    const page = state.page;
    if (!(await clean(page, [["agName", "agent name"], ...POLICY_FIELDS]))) return;
    // The fields on screen are what gets saved. The draft only carries them across a redraw.
    Object.assign(draft, { name: $("agName").value, cap: $("agCap").value, max: $("agMax").value, destinations: $("agDest").value, sites: $("agSites").value, expiry: $("agExpiry").value });
    const name = draft.name.trim(), id = slugId(name, desk.agents().map((a) => a.id)), p = readFields();
    if (!name || name.length > 24) return fail(page, "The agent needs a name of 1 to 24 characters.");
    if (!id) return fail(page, "Use letters or digits in the name. The names connect and approvals belong to pages.");
    if (!p.ok) return fail(page, p.reason);
    const r = await desk.addAgent({ id, name, source: "scripted", avatar: AVATARS.includes(draft.avatar) ? draft.avatar : AVATARS[0], policy: p.patch });
    if (!r.ok) return fail(page, r.reason);
    // No wallet, no claim: the claim runs only on the button that names the connected wallet.
    if (submitter?.value === "claim") await desk.claim(id);
    draft = freshDraft();
    if (state.page === page) ctx.navigate(`${PREFIX}/${id}`);
  }
  async function onPolicy(form) {
    const page = state.page, id = form.dataset.id, a = desk.agent(id);
    if (!a || !(await clean(page, POLICY_FIELDS))) return;
    const p = readFields();
    if (!p.ok) return fail(page, p.reason);
    const r = desk.setPolicy(id, p.patch);
    if (!r.ok) return fail(page, r.reason);
    const done = (text) => { if (state.page !== page) return; note = text; error = ""; draw(page, true); };
    if (!r.needsConfirm) return done("Saved. A lowered limit applies at once.");
    // A raise takes a second, separate press on a sheet that shows the old and the new value.
    ctx.openModal(raiseSheet(a.name, r));
    $("agConfirmRaise").addEventListener("click", () => {
      const again = desk.setPolicy(id, p.patch, { confirm: true });
      ctx.closeModal();
      if (again.ok && !again.needsConfirm) done("Saved. The raise is confirmed.");
      else fail(page, again.reason || "The raise was not confirmed.");
    });
  }

  // The export is built by the engine from stored rows only, so it holds no argument that failed the leak check.
  function exportJson(id, n) {
    const data = desk.exportSession(id, Number(n));
    if (!data) return;
    const text = JSON.stringify(data, null, 2), name = `rf3-${id}-session-${data.summary.session}.json`;
    ctx.log("info", "Session exported", name, "YOU", id);
    if (ctx.desktop) {
      return ctx.openModal(`<h3>Export JSON</h3><p>Saving a file from the desktop app comes with the Rust core. Copy the text below.</p>
        <textarea class="input ag-export" readonly rows="14" aria-label="Session export">${esc(text)}</textarea>
        <div class="sheet-actions"><button class="btn btn-secondary" data-close>Close</button></div>`);
    }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" })), a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const view = $("view");
  view.addEventListener("click", (e) => {
    const b = here() && e.target.closest?.("[data-ag]");
    if (!b || b.disabled) return;
    if (b.dataset.ag === "task" && $("agTask")) { $("agTask").value = b.dataset.task; $("agTask").focus(); }
    if (b.dataset.ag === "skip") { const r = desk.skip(b.dataset.q); if (r.ok) passed(state.page); else fail(state.page, r.reason); }
    if (b.dataset.ag === "export") exportJson(b.dataset.id, b.dataset.n);
  });
  view.addEventListener("submit", (e) => {
    const form = here() && e.target.closest?.("[data-ag-form]");
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.agForm;
    if (kind === "task") onTask(form);
    if (kind === "answer") onAnswer(form);
    if (kind === "resume") onResume(form);
    if (kind === "connect") onConnect(e.submitter);
    if (kind === "policy") onPolicy(form);
  });
  // The connect draft follows the fields, so a wallet connect or a mode switch redraws the form with what was typed.
  const follow = (e) => {
    if (!here()) return;
    const el = e.target;
    if (parseRoute(state.page).view === "connect" && Object.hasOwn(draft, el.name) && (el.type !== "radio" || el.checked)) draft[el.name] = el.value;
    if (e.type === "change" && (el.id === "agLogSession" || el.id === "agLogKind")) {
      filter = { session: Number($("agLogSession").value) || 0, kind: $("agLogKind").value };
      draw(state.page, true);
    }
  };
  view.addEventListener("input", follow);
  view.addEventListener("change", follow);
  desk.subscribe(() => { if (here()) draw(state.page, false); });

  return {
    prefix: PREFIX,
    title(page) {
      const r = parseRoute(page), a = r.id ? desk.agent(r.id) : null;
      if (r.view === "roster") return "Agents";
      if (r.view === "connect") return "Connect an agent";
      if (r.view === "approvals") return "Approvals";
      if (!a || (r.view === "session" && !desk.summary(a.id, r.n))) return "No such page";
      return { detail: a.name, log: `${a.name} · log`, policy: `${a.name} · policy`, session: `${a.name} · session ${r.n}` }[r.view] || "No such page";
    },
    // silent marks a redraw the person did not ask for (mode switch, wallet change): typed text stays.
    render(page, { silent } = {}) {
      if (!silent) { note = ""; error = ""; if (parseRoute(page).view !== "connect") draft = freshDraft(); }
      draw(page, !silent);
    },
  };
}
