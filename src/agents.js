// Agents engine (flows 12 and 13): many agents, one live session each, seven tools, a policy the agent cannot reach,
// approvals that time out, breaches that hold the agent, and the event log the pages draw from.
// Pure: no DOM, no network, no storage. The clock, the leak scanner and the four page reads are handed in, so every
// rule runs in Node tests. An agent (today the scripted demo) calls in through call(). A human acts through
// human.*. Nothing in this file runs an agent, signs, holds a key or sends a transaction.
// Amounts are BigInt lamports inside and canonical SOL strings outside.
import { parsePaymentRequest } from "./security.js";
import { solToLamports, lamportsToSol } from "./solana/tx.js";

export const RUN_STATES = Object.freeze(["idle", "running", "needs you", "paused", "breached", "unreachable", "stopped", "revoked", "wallet changed"]);
export const SOURCES = Object.freeze(["scripted", "mcp", "registry"]);
// The whole tool surface. It holds no sign tool, no key tool and no cap tool, so no call can do those things.
export const TOOLS = Object.freeze(["rf3.open", "rf3.read_page", "rf3.resolve_name", "rf3.get_balance", "rf3.propose_payment", "rf3.ask_human", "rf3.contribute_circle"]);
export const READ_TOOLS = Object.freeze(TOOLS.slice(0, 4));
export const EVENT_TYPES = Object.freeze(["session.start", "tool.start", "tool.complete", "approval.pending", "approval.decided", "policy.breach", "session.end"]);
// The rules that count as a breach. Every other refusal leaves the breach count alone.
export const RULES = Object.freeze({
  page: "page-sourced payment",
  task: "not in your task sentence",
  destination: "destination outside the allowlist",
  repeat: "over cap after a deny",
  secret: "secret request",
  cap: "cap request",
  site: "site outside the allowlist",
});
export const APPROVAL_TTL_MS = 5 * 60_000;
export const MAX_BREACHES = 3;
export const LEAK_PLACEHOLDER = "[blocked by leak check]";
export const PAYMENT_SHAPE = "Send 0.5 SOL to name.sns";
export const DEFAULT_POLICY = Object.freeze({ capPerSession: "0.01", maxPerPayment: "0.01", destinations: Object.freeze([]), sites: Object.freeze([]), expiresAt: null });

const ARG_MAX = 500, ARGS_MAX = 8, REASON_MAX = 200, TASK_MAX = 500, NOTE_MAX = 200, NAME_MAX = 24, LIST_MAX = 50;
const PAGE_TEXT_MAX = 20_000, PAGES_MAX = 16, EVENTS_MAX = 4000;
const U64_MAX = 2n ** 64n - 1n;
const NAME_RE = /^[a-z0-9_-]{1,63}\.(?:sns|sol)$/;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ID_RE = /^[a-z0-9-]{1,32}$/;
const RESERVED_IDS = ["connect", "approvals"]; // rf3://agents/connect and rf3://agents/approvals are pages
const TOOL_NAME_RE = /^[a-z0-9_.]{1,40}$/;
// Argument names start with a letter, so "__proto__" can never be one.
const KEY_RE = /^[a-z][a-z_]{0,23}$/;
const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const PAGE_RE = /^rf3:\/\/[a-z0-9/_-]{1,80}$/;
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const FAILED = Symbol("the leak check did not run");
const NOT_CLAIMED = "This agent is not claimed. A human claims it with a wallet before it can do that.";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// One short line of text, trimmed. "" when empty, null for anything else.
const line = (v, max) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length <= max && !CTRL.test(t) ? t : null;
};
const tryLamports = (v) => { try { return typeof v === "string" ? solToLamports(v) : null; } catch { return null; } };
const brief = (e) => String(e?.message ?? e ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "The read failed.";
const freeze = (v) => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const refuse = (refused, reason, more) => ({ ok: false, refused, reason, ...more });
const no = (reason, more) => ({ ok: false, reason, ...more });
const yes = (more) => ({ ok: true, ...more });

// Answers from the page's reads (chain data, page titles) are third-party values. Only plain JSON-safe data of
// bounded size is passed on.
function plain(v, depth = 0) {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v.slice(0, ARG_MAX);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (depth >= 3 || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.slice(0, 32).map((x) => plain(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 32)) if (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) out[k] = plain(x, depth + 1);
  return out;
}
// A balance in lamports from the page's read: a bigint, a whole number, or digits. Null for anything else.
function toCount(v) {
  const n = typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : typeof v === "string" && /^\d{1,20}$/.test(v) ? BigInt(v) : null;
  return n !== null && n >= 0n && n <= U64_MAX ? n : null;
}

// ---------- Sites ----------
// What rf3.open may point at: one https address, one name, or one of RobotFac3's own pages. Null for anything else.
// An address with a login part (https://phantom.com@evil.example/), a port or a punycode host is refused, as in the
// address bar: each one can show a different host from the one it opens.
function siteOf(raw) {
  const low = raw.toLowerCase();
  if (NAME_RE.test(low) || PAGE_RE.test(low)) return { target: low, key: low, host: null };
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOST_RE.test(u.hostname) || u.hostname.includes("xn--")) return null;
  return { target: u.href, key: u.hostname, host: u.hostname };
}
const isSiteEntry = (x) => HOST_RE.test(x) || NAME_RE.test(x) || PAGE_RE.test(x);
// An empty list means any site. A host entry also covers its subdomains. A name entry covers that name only.
const siteAllowed = (sites, site) => !sites.length || sites.some((e) => e === site.key || (site.host !== null && !NAME_RE.test(e) && site.host.endsWith(`.${e}`)));

// ---------- Secret requests ----------
// A heuristic. It catches the plain ways of asking for a secret and will miss rewordings.
const SECRET_REQUEST_RE = /\b(?:seed|recovery|secret|backup|mnemonic)[\s_-]*(?:phrases?|words?|keys?)\b|\bmnemonic\b|\bprivate[\s_-]*keys?\b|\bpass[\s_-]*(?:words?|codes?|phrases?)\b|\bsudo\b/i;
// Fullwidth letters and invisible characters are folded away first, so neither can split a word the pattern knows.
const folded = (text) => String(text ?? "").normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "");
export function isSecretRequest(text) {
  return SECRET_REQUEST_RE.test(folded(text));
}

// ---------- Cap requests ----------
// A heuristic too. It catches the plain ways of asking a person for a looser policy and will miss rewordings.
// What holds without it: no tool changes a policy, and a raise takes the person's own second press on a confirm sheet.
const LIST_NOUN = String.raw`(?:allow[\s-]?list|white[\s-]?list|allowed\s+(?:destinations?|sites?|names?))`;
const CAP_NOUN = String.raw`(?:caps?|limits?|polic(?:y|ies)|allowance|expiry|max(?:imum)?\s+per\s+(?:payment|session)|${LIST_NOUN})`;
// Up to 60 characters inside one sentence. The dot in name.sns ends no sentence.
const SAME_SENTENCE = String.raw`(?:(?![.?!](?:\s|$)).){0,60}?`;
const CAP_REQUEST_RE = new RegExp([
  String.raw`\b(?:raise|increase|lift|remove|drop|change|edit|set|widen|extend|loosen|relax|bump|double|update)\b${SAME_SENTENCE}\b${CAP_NOUN}\b`,
  String.raw`\b(?:add|put|include)\b${SAME_SENTENCE}\b${LIST_NOUN}\b`,
  String.raw`\b(?:higher|bigger|larger|more|unlimited)\s+(?:(?:session|payment|spend(?:ing)?)\s+)?(?:caps?|limits?|allowance)\b`,
  String.raw`\b(?:auto|pre)[\s-]?approv|\bapprove\s+(?:all|every|everything|any)\b`,
].join("|"), "i");
export function isCapRequest(text) {
  return CAP_REQUEST_RE.test(folded(text));
}

// ---------- Provenance ----------
// Amounts on a page. Each number is taken whole or dropped: "0,5 sol" gives nothing, because a looser pattern once
// read it as 5 SOL.
const RE_PAGE_AMOUNT = /(?<![\d.,])(\d+(?:\.\d{1,9})?)\s*sol\b/g;
function pageValues(pages) {
  const text = pages.map(String).join("\n").toLowerCase();
  const amounts = new Set();
  for (const m of text.matchAll(RE_PAGE_AMOUNT)) {
    const l = tryLamports(m[1]);
    if (l !== null) amounts.add(lamportsToSol(l));
  }
  return { amounts, hasName: (name) => text.includes(name) };
}
// Where each field of a proposal came from: "user", "page" or "agent". A field is "user" only when the strict parse
// of the sentence the human typed holds the same canonical value. A label the agent puts on its own proposal is
// never read. amount and name are canonical, as parsePaymentRequest returns them.
export function checkProvenance({ task, pages = [], amount, name }) {
  const typed = parsePaymentRequest(task);
  const seen = pageValues(Array.isArray(pages) ? pages : []);
  const fromUser = (k, v) => typed.kind === "payment" && typeof v === "string" && typed[k] === v;
  const out = {
    amount: fromUser("amount", amount) ? "user" : seen.amounts.has(amount) ? "page" : "agent",
    name: fromUser("name", name) ? "user" : typeof name === "string" && name && seen.hasName(name) ? "page" : "agent",
  };
  const user = out.amount === "user" && out.name === "user";
  return { ...out, user, rule: user ? null : out.amount === "page" || out.name === "page" ? RULES.page : RULES.task };
}

// ---------- Policy ----------
const basePolicy = () => ({ cap: solToLamports(DEFAULT_POLICY.capPerSession), max: solToLamports(DEFAULT_POLICY.maxPerPayment), destinations: [], sites: [], expiresAt: null });
const viewPolicy = (p) => ({ capPerSession: lamportsToSol(p.cap), maxPerPayment: lamportsToSol(p.max), destinations: [...p.destinations], sites: [...p.sites], expiresAt: p.expiresAt });
const readList = (v, ok) => {
  if (!Array.isArray(v) || v.length > LIST_MAX || !v.every((x) => typeof x === "string")) return null;
  const list = [...new Set(v.map((x) => x.toLowerCase()))];
  return list.every(ok) ? list : null;
};
// Reads a policy edit strictly. Amounts are SOL text (a float would round), lists hold exact entries, expiry is a
// whole millisecond. One bad field refuses the whole edit.
function readPolicy(patch, base) {
  if (!isPlain(patch)) return { bad: "A policy edit is a set of fields." };
  const p = { ...base, destinations: [...base.destinations], sites: [...base.sites] };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "capPerSession" || k === "maxPerPayment") {
      const l = tryLamports(v);
      if (l === null) return { bad: `${k} is a positive SOL amount with up to 9 decimals, written as text.` };
      p[k === "capPerSession" ? "cap" : "max"] = l;
    } else if (k === "destinations") {
      const list = readList(v, (x) => NAME_RE.test(x));
      if (!list) return { bad: "destinations is a list of names like name.sns." };
      p.destinations = list;
    } else if (k === "sites") {
      const list = readList(v, isSiteEntry);
      if (!list) return { bad: "sites is a list of hosts like solana.com, names like name.sns and rf3:// pages." };
      p.sites = list;
    } else if (k === "expiresAt") {
      if (v !== null && !(Number.isSafeInteger(v) && v > 0)) return { bad: "expiresAt is a time in milliseconds, or null for no expiry." };
      p.expiresAt = v;
    } else return { bad: "That policy field does not exist." };
  }
  return { policy: p };
}
// The fields an edit would loosen. A list widens when it starts allowing an entry it refused before.
const widens = (old, next) => old.length > 0 && (next.length === 0 || next.some((x) => !old.includes(x)));
function raisedFields(old, next) {
  const out = [];
  if (next.cap > old.cap) out.push("capPerSession");
  if (next.max > old.max) out.push("maxPerPayment");
  if (widens(old.destinations, next.destinations)) out.push("destinations");
  if (widens(old.sites, next.sites)) out.push("sites");
  if (old.expiresAt !== null && (next.expiresAt === null || next.expiresAt > old.expiresAt)) out.push("expiresAt");
  return out;
}
const INNER = { capPerSession: "cap", maxPerPayment: "max", destinations: "destinations", sites: "sites", expiresAt: "expiresAt" };

// The one policy decision, used at proposal time, at approve and again right before signing.
// spend is { spent, reserved, denied: [{ name, lamports }] }. counted is this payment's own share of reserved, so an
// approved payment is never counted twice. repeat is on for a new proposal only.
function judge(p, spend, lamports, name, t, { counted = 0n, repeat = false } = {}) {
  const block = (reason, rule = null) => ({ verdict: "block", rule, reason });
  if (p.expiresAt !== null && t >= p.expiresAt) return block("The policy expired.");
  if (typeof lamports !== "bigint" || lamports <= 0n || lamports > U64_MAX) return block("That amount is invalid.");
  if (typeof name !== "string" || !NAME_RE.test(name)) return block("That name is invalid.");
  if (p.destinations.length && !p.destinations.includes(name)) return block(`${name} is outside the allowed destinations.`, RULES.destination);
  const amount = lamportsToSol(lamports), total = spend.spent + spend.reserved - counted + lamports;
  const overMax = lamports > p.max, overCap = total > p.cap;
  // Asking again for a payment a human already turned down, while it still needs a human, is pressure. It ends here.
  if (repeat && (overMax || overCap) && spend.denied.some((d) => d.name === name && lamports >= d.lamports)) {
    return block(`A payment to ${name} was already denied in this session. ${amount} SOL is over the limit again.`, RULES.repeat);
  }
  if (overMax) return { verdict: "escalate", rule: null, reason: `${amount} SOL is over the ${lamportsToSol(p.max)} SOL limit for one payment.` };
  if (overCap) return { verdict: "escalate", rule: null, reason: `${amount} SOL brings this session to ${lamportsToSol(total)} SOL. The session cap is ${lamportsToSol(p.cap)} SOL.` };
  return { verdict: "allow", rule: null, reason: "Within the policy. A human still approves and signs." };
}
// The same decision as a pure function over SOL strings, for the review sheet and for tests.
// Returns { verdict: "block" | "escalate" | "allow", breach: rule name or null, reason }.
export function checkPolicy({ policy = {}, amount, name, spent = "0", reserved = "0", denied = [], now = 0, repeat = true } = {}) {
  const count = (v) => (v === "0" ? 0n : tryLamports(v));
  const p = readPolicy(policy, basePolicy());
  const spend = { spent: count(spent), reserved: count(reserved), denied: Array.isArray(denied) ? denied.map((d) => ({ name: d?.name, lamports: tryLamports(d?.amount) })) : null };
  if (p.bad || spend.spent === null || spend.reserved === null || !spend.denied || spend.denied.some((d) => d.lamports === null) || !Number.isFinite(now)) {
    return { verdict: "block", breach: null, reason: "The policy or the spend so far is malformed." };
  }
  const v = judge(p.policy, spend, tryLamports(amount), name, now, { repeat: repeat === true });
  return { verdict: v.verdict, breach: v.rule, reason: v.reason };
}

// ---------- Calls ----------
// Copies a call out of whatever the agent handed over, reading each value once. Only short text survives.
// The copy is what gets checked, stored and used, so a value cannot change between the leak check and its use.
function readRequest(req) {
  const t = req?.tool, raw = req?.args ?? {};
  const entries = isPlain(raw) ? Object.entries(raw) : null;
  const ok = entries !== null && entries.length <= ARGS_MAX && entries.every(([k, v]) => KEY_RE.test(k) && typeof v === "string" && v.length <= ARG_MAX);
  return {
    // A tool name that is no plain identifier is never stored: it could carry anything.
    tool: typeof t === "string" && TOOL_NAME_RE.test(t) ? t : "",
    args: ok ? Object.fromEntries(entries) : {},
    bad: !ok,
    reason: line(req?.reason, REASON_MAX) || "",
  };
}

// createEngine({ now, scan, host })
//   now()       milliseconds, from the page's clock
//   scan(text)  async leak check: null when clean, a hit object ({ type, note? }) otherwise
//   host        optional reads the page performs for the agent: open(target), readPage(target or null),
//               resolveName(name), getBalance(address). A missing one refuses its tool.
export function createEngine({ now, scan, host = {} } = {}) {
  if (typeof now !== "function" || typeof scan !== "function") throw new Error("createEngine needs now() and scan(text)");
  const agents = new Map(), asks = new Map(), subs = new Set(), queue = [];
  let wallet; // the connected wallet as the page last reported it; undefined until the first report
  let ids = 0;

  // A clock that gives no number stops everything: no timeout can be trusted without it.
  const time = () => { const t = now(); if (!Number.isFinite(t)) throw new Error("The clock gave no time."); return t; };
  const last = (a) => a.sessions[a.sessions.length - 1] || null;
  const live = (a) => { const s = last(a); return s && s.endedAt === null ? s : null; };
  const sessionOf = (a, n) => (n === undefined ? last(a) : Number.isInteger(n) ? a.sessions[n - 1] || null : null);
  const needs = (s) => (s.approval ? 1 : 0) + (s.question ? 1 : 0);
  // The policy a session is measured against: today's while it runs, the one it ended under afterwards. A later
  // edit must never restate what an ended session spent against.
  const policyOf = (a, s) => (s.endedAt === null ? a.policy : s.policyAtEnd);

  function statusOf(a) {
    const s = live(a);
    if (!s) return a.rest;
    if (s.walletChanged) return "wallet changed";
    if (s.held) return "breached";
    if (s.unreachable) return "unreachable";
    if (s.paused) return "paused";
    return needs(s) ? "needs you" : "running";
  }

  // ---------- Listeners ----------
  // Delivered after the current step has finished, so a listener always reads settled state and can call back in.
  function tell(change) {
    if (!queue.length) queueMicrotask(flush);
    queue.push({ agentId: null, event: null, action: null, leak: null, ...change });
  }
  function flush() {
    for (const change of queue.splice(0)) {
      for (const fn of [...subs]) { try { fn(change); } catch { /* a broken listener must not stop the engine */ } }
    }
  }
  function subscribe(fn) {
    if (typeof fn !== "function") throw new Error("subscribe needs a function");
    subs.add(fn);
    return () => subs.delete(fn);
  }

  // ---------- Events ----------
  // Tool rows stop at EVENTS_MAX per session so a runaway agent cannot fill the tab's memory. The count of rows
  // left out is kept and shown. Approval, breach and session rows are always written.
  function emit(a, s, type, data, extra) {
    if ((type === "tool.start" || type === "tool.complete") && s.events.length >= EVENTS_MAX) {
      s.dropped++;
      return tell({ agentId: a.id, ...extra });
    }
    const event = freeze({ seq: ++s.seq, at: time(), agent: a.name, agentId: a.id, session: s.n, type, ...data });
    s.events.push(event);
    tell({ agentId: a.id, event, ...extra });
  }
  // Human presses and system holds, kept beside the seven agent event types so the log can say who did what.
  function act(a, s, action, detail = "", actor = "YOU") {
    const entry = freeze({ at: time(), actor, action, detail, agent: a.name, agentId: a.id, session: s ? s.n : null });
    a.log.push(entry);
    tell({ agentId: a.id, action: entry });
  }

  // ---------- Views (plain copies; nothing here gives a caller a handle on engine state) ----------
  function meter(p, s) {
    const used = s.spent + s.reserved, left = p.cap > used ? p.cap - used : 0n, pct = (used * 100n) / p.cap;
    return {
      spent: lamportsToSol(s.spent), reserved: lamportsToSol(s.reserved), used: lamportsToSol(used),
      cap: lamportsToSol(p.cap), left: lamportsToSol(left), percent: pct > 100n ? 100 : Number(pct),
      level: used >= p.cap ? "red" : used * 5n >= p.cap * 4n ? "warn" : "ok", // amber at 80 percent, red at 100
    };
  }
  function viewAsk(ask) {
    const a = agents.get(ask.agentId), s = a.sessions[ask.session - 1];
    const base = {
      id: ask.id, kind: ask.kind, agentId: a.id, agent: a.name, source: a.source, session: ask.session, call: ask.call, status: ask.status,
      reason: ask.reason, createdAt: ask.createdAt, expiresAt: ask.expiresAt,
      msLeft: ask.status === "pending" ? Math.max(0, ask.expiresAt - time()) : 0,
      decision: ask.decision ? { ...ask.decision } : null,
    };
    if (ask.kind === "question") return { ...base, question: ask.question, answer: ask.answer };
    return {
      ...base, sentence: ask.sentence, amount: ask.amount, lamports: String(ask.lamports), name: ask.name, task: s.task,
      provenance: { ...ask.provenance }, verdict: ask.verdict, policyReason: ask.policyReason,
      capRemaining: meter(policyOf(a, s), s).left, signature: ask.signature,
    };
  }
  function viewSession(a, s) {
    const pick = (id) => (id ? viewAsk(asks.get(id)) : null);
    return {
      n: s.n, task: s.task, payment: s.payment ? { ...s.payment } : null, live: s.endedAt === null, preview: s.preview,
      startedAt: s.startedAt, endedAt: s.endedAt, endedBy: s.endedBy,
      paused: s.paused, pausedWhy: s.pausedWhy, walletChanged: s.walletChanged, unreachable: s.unreachable,
      breach: s.held ? { ...s.held } : null, breaches: s.breaches, page: s.page,
      ...meter(policyOf(a, s), s), approval: pick(s.approval), question: pick(s.question), needs: needs(s),
      steps: s.calls, lastEventAt: s.events.length ? s.events[s.events.length - 1].at : s.startedAt,
    };
  }
  function viewAgent(a) {
    const s = last(a);
    return {
      id: a.id, name: a.name, source: a.source, avatar: a.avatar, claimedBy: a.claimedBy, status: statusOf(a),
      breaches: a.breaches, policy: viewPolicy(a.policy), raisePending: a.raise !== null,
      sessions: a.sessions.length, session: s ? viewSession(a, s) : null,
    };
  }
  function summary(agentId, n) {
    const a = agents.get(agentId), s = a && sessionOf(a, n);
    if (!s) return null;
    return {
      agent: a.name, agentId: a.id, session: s.n, task: s.task, preview: s.preview,
      startedAt: s.startedAt, endedAt: s.endedAt, ended: s.endedBy,
      steps: s.calls, proposals: s.proposals, approvals: s.approved, denials: s.denials, cancelled: s.cancelled,
      questions: s.questions, breaches: s.breaches, ...meter(policyOf(a, s), s),
      signatures: [...s.signatures], events: s.events.length, eventsDropped: s.dropped,
    };
  }
  // Built from the stored rows only. A row never holds an argument that failed the leak check, so the file cannot.
  function exportSession(agentId, n) {
    const a = agents.get(agentId), s = a && sessionOf(a, n);
    if (!s) return null;
    const p = policyOf(a, s);
    return {
      format: "rf3.agent-session", version: 1, exportedAt: time(),
      note: "Browser policy, kept for this tab only. For an ended session, policy and lamports.cap are the values it ended under. agentLog holds the presses made outside any session, such as the claim and policy changes. An argument that failed the leak check is stored as a placeholder.",
      agent: { id: a.id, name: a.name, source: a.source, avatar: a.avatar, claimedBy: a.claimedBy },
      policy: viewPolicy(p),
      lamports: { spent: String(s.spent), reserved: String(s.reserved), cap: String(p.cap) },
      summary: summary(agentId, s.n),
      human: a.log.filter((x) => x.session === s.n),
      agentLog: a.log.filter((x) => x.session === null),
      events: [...s.events],
    };
  }
  const events = (agentId, n) => { const a = agents.get(agentId), s = a && sessionOf(a, n); return s ? [...s.events] : []; };
  const pending = () => [...asks.values()].filter((x) => x.status === "pending").sort((x, y) => x.expiresAt - y.expiresAt).map(viewAsk);

  // ---------- Leak check ----------
  // Null when clean, the hit when found, FAILED when the check could not run. Clean means the scanner answered
  // exactly null. Anything else it says or throws refuses the text.
  async function check(text) {
    try {
      const hit = await scan(text);
      if (hit === null) return null;
      if (isPlain(hit)) return { type: line(hit.type, 60) || "Secret", note: line(hit.note, 300) || "" };
    } catch { /* falls through: the check did not run */ }
    return FAILED;
  }
  const leakNo = (hit, tail) => (hit === FAILED
    ? no(`The leak check could not run. ${tail}`)
    : no(`The leak check found a ${hit.type.toLowerCase()}. ${tail}`, { leak: { type: hit.type, note: hit.note } }));
  // Every argument and the reason, one by one. A value that fails is replaced before anything stores or uses it.
  async function screen(r) {
    const hits = [];
    let failed = false;
    const one = async (field, text) => {
      const hit = await check(text);
      if (hit === null) return text;
      if (hit === FAILED) failed = true; else hits.push({ field, type: hit.type, note: hit.note });
      return LEAK_PLACEHOLDER;
    };
    for (const k of Object.keys(r.args)) r.args[k] = await one(`args.${k}`, r.args[k]);
    if (r.reason) r.reason = await one("reason", r.reason);
    return { hits, failed };
  }

  // ---------- Approvals and questions ----------
  const END = {
    you: ["stopped", "The session ended."], stop: ["stopped", "The session was stopped."], breach: ["stopped", "The session ended after three breaches."],
    revoke: ["revoked", "The agent was revoked."], expiry: ["expired", "The policy expired."], wallet: ["wallet changed", "The wallet changed."],
  };
  // Closes a pending approval or question for good. Nothing reopens one: decide() and answer() act on "pending" only.
  function close(a, s, ask, status, by, reason, out, extra) {
    if (ask.status === "approved") s.reserved -= ask.lamports; // an approval that never reached Phantom gives its share back
    ask.status = status;
    ask.decision = { by, reason, at: time() };
    const slot = ask.kind === "payment" ? "approval" : "question";
    if (s[slot] === ask.id) s[slot] = null;
    emit(a, s, "approval.decided", { id: ask.id, kind: ask.kind, outcome: status, by, reason, ...extra });
    ask.resolve(out);
  }
  // An approval with no answer is a deny. The denied amount is remembered so asking again can be told apart.
  function timeOut(a, s, ask) {
    if (ask.kind === "payment") { s.denials++; s.denied.push({ name: ask.name, lamports: ask.lamports }); }
    close(a, s, ask, "denied by timeout", "timeout", "No answer in 5 minutes.", refuse("denied by timeout", "No answer in 5 minutes."));
  }
  function cancel(a, s, ask, by, [code, reason]) {
    if (ask.kind === "payment") s.cancelled++;
    close(a, s, ask, "cancelled", by, reason, refuse(code, reason));
  }
  function cancelPending(a, s, by, why) {
    for (const id of [s.approval, s.question]) {
      const ask = id && asks.get(id);
      if (ask && ask.status === "pending") cancel(a, s, ask, by, why);
    }
  }
  // Runs before every decision, so no call and no press acts on a card or a policy that has run out.
  function expire() {
    const t = time(), out = { denied: [], ended: [] };
    for (const a of agents.values()) {
      const s = live(a);
      if (!s) continue;
      for (const id of [s.approval, s.question]) {
        const ask = id && asks.get(id);
        if (ask && ask.status === "pending" && t >= ask.expiresAt) { timeOut(a, s, ask); out.denied.push(ask.id); }
      }
      if (a.policy.expiresAt !== null && t >= a.policy.expiresAt) { end(a, s, "expiry"); out.ended.push(a.id); }
    }
    return out;
  }
  // Ends a session. Pending cards are cancelled. A payment already approved and on its way to Phantom is left to
  // settle(): ending a session never undoes or hides what was sent.
  function end(a, s, by) {
    if (s.endedAt !== null) return;
    s.endedAt = time();
    s.endedBy = by;
    s.policyAtEnd = { ...a.policy, destinations: [...a.policy.destinations], sites: [...a.policy.sites] };
    a.rest = by === "revoke" ? "revoked" : "stopped";
    cancelPending(a, s, by, END[by]);
    emit(a, s, "session.end", { by, steps: s.calls, proposals: s.proposals, approvals: s.approved, denials: s.denials, breaches: s.breaches, spent: lamportsToSol(s.spent), cap: lamportsToSol(a.policy.cap), signatures: [...s.signatures] });
  }
  // Counts a breach and holds the agent until a human resumes it with a note. The third in one session ends it.
  function breach(a, s, c, rule, tried, reason, more) {
    s.breaches++;
    a.breaches++;
    s.held = { rule, tried, tool: c.tool, at: time(), count: s.breaches };
    emit(a, s, "policy.breach", { call: c.k, tool: c.tool, rule, tried, count: s.breaches });
    // A held agent keeps no open card: whatever it had in front of the human is withdrawn with it.
    cancelPending(a, s, "breach", ["breached", "The agent was held after a breach."]);
    if (s.breaches >= MAX_BREACHES) end(a, s, "breach");
    return refuse("breach", reason, { rule, breach: { rule, count: s.breaches, ended: s.endedAt !== null }, ...more });
  }
  // Why a call cannot run right now, or null. None of these counts as a breach. inFlight is a call that started
  // before a pause: it may finish.
  function gate(a, s, inFlight = false) {
    if (s.endedAt !== null) {
      if (a.rest === "revoked") return refuse(...END.revoke);
      return s.endedBy === "expiry" ? refuse(...END.expiry) : refuse("stopped", "The session ended.");
    }
    if (s.walletChanged) return refuse("wallet changed", "The wallet changed. The session waits for the claiming wallet.");
    if (s.held) return refuse("breached", `Held after a breach: ${s.held.rule}. A human reviews it.`);
    if (s.paused && !inFlight) return refuse("paused", "Paused by the human.");
    return null;
  }
  // A card waiting on the human. The agent's call stays open until the card closes.
  function wait(a, s, c, ask) {
    const t = time();
    Object.assign(ask, { id: `${ask.kind === "payment" ? "ap" : "q"}-${++ids}`, agentId: a.id, session: s.n, call: c.k, status: "pending", createdAt: t, expiresAt: t + APPROVAL_TTL_MS, decision: null });
    asks.set(ask.id, ask);
    s[ask.kind === "payment" ? "approval" : "question"] = ask.id;
    const { resolve, lamports, agentId, session, status, decision, signature, answer, ...shown } = ask;
    const open = new Promise((done) => { ask.resolve = (res) => done(c.finish(res)); });
    emit(a, s, "approval.pending", ask.kind === "payment" ? { ...shown, task: s.task, capRemaining: meter(a.policy, s).left } : shown);
    return open;
  }

  // ---------- The seven tools ----------
  // Runs one read through the page. A session that was stopped, revoked, held or lost its wallet while the read
  // was out gets no answer back.
  async function viaHost(a, s, name, arg) {
    const fn = isPlain(host) && typeof host[name] === "function" ? host[name] : null;
    if (!fn) return { stop: refuse("not connected", "This build has nothing attached for that tool.") };
    let value;
    try { value = await fn(arg); } catch (e) { return { stop: refuse("failed", brief(e)) }; }
    expire();
    const late = gate(a, s, true);
    return late ? { stop: late } : { value };
  }
  const tools = {
    async "rf3.open"(a, s, c, args) {
      const site = typeof args.target === "string" ? siteOf(args.target) : null;
      if (!site) return refuse("unclear", "rf3.open takes a target: one https address, one .sns name or one rf3:// page.");
      if (!siteAllowed(a.policy.sites, site)) return breach(a, s, c, RULES.site, `open ${site.key}`, `${site.key} is outside the allowed sites.`);
      const r = await viaHost(a, s, "open", site.target);
      if (r.stop) return r.stop;
      s.page = site.target;
      return yes({ result: { opened: site.target } });
    },
    async "rf3.read_page"(a, s) {
      const r = await viaHost(a, s, "readPage", s.page);
      if (r.stop) return r.stop;
      if (typeof r.value !== "string") return refuse("failed", "The page gave no text.");
      const text = r.value.slice(0, PAGE_TEXT_MAX);
      // Kept so a later proposal can be matched against what this agent was shown. The agent gets the same cut of
      // the text that is kept here. Once a page drops off the list its values still fail the task-sentence rule.
      s.pages.push(text);
      if (s.pages.length > PAGES_MAX) s.pages.shift();
      // The row records how much was read. Page text is third-party content and stays out of the log.
      return yes({ result: { origin: "page", page: s.page, text }, logged: { origin: "page", page: s.page, chars: text.length } });
    },
    async "rf3.resolve_name"(a, s, c, args) {
      const name = typeof args.name === "string" ? args.name.toLowerCase() : "";
      if (!NAME_RE.test(name)) return refuse("unclear", "rf3.resolve_name takes a name like name.sns.");
      const r = await viaHost(a, s, "resolveName", name);
      if (r.stop) return r.stop;
      return yes({ result: { origin: "chain", name, answer: plain(r.value) } });
    },
    async "rf3.get_balance"(a, s, c, args) {
      const address = args.address === undefined ? a.claimedBy : args.address;
      if (typeof address !== "string" || !ADDRESS_RE.test(address)) return refuse("unclear", "rf3.get_balance takes an address. With none it reads the claiming wallet.");
      const r = await viaHost(a, s, "getBalance", address);
      if (r.stop) return r.stop;
      const lamports = toCount(r.value);
      if (lamports === null) return refuse("failed", "The balance answer was malformed.");
      return yes({ result: { origin: "chain", address, lamports: String(lamports), sol: lamportsToSol(lamports) } });
    },
    // Order: grammar, provenance, claim, policy, then one card for the human. Each step refuses before the next runs.
    "rf3.propose_payment"(a, s, c, args, reason) {
      s.proposals++;
      const pay = parsePaymentRequest(args.sentence);
      if (pay.kind !== "payment") return refuse("unclear", `That payment is unclear. Write it exactly like: ${PAYMENT_SHAPE}`);
      const sentence = `Send ${pay.amount} SOL to ${pay.name}`;
      // Payment details come only from the sentence the human typed. Page text, tool results and the agent's own
      // output can never create, redirect or resize a payment.
      const { user, rule, ...provenance } = checkProvenance({ task: s.task, pages: s.pages, amount: pay.amount, name: pay.name });
      if (!user) {
        return breach(a, s, c, rule, sentence, rule === RULES.page
          ? "These payment details match text from a page. Payment details come only from the human's task sentence."
          : "These payment details are missing from the human's task sentence.", { provenance });
      }
      if (!a.claimedBy) return refuse("not claimed", NOT_CLAIMED, { provenance });
      const lamports = solToLamports(pay.amount);
      const v = judge(a.policy, s, lamports, pay.name, time(), { repeat: true });
      if (v.verdict === "block") return v.rule ? breach(a, s, c, v.rule, sentence, v.reason) : refuse("blocked", v.reason);
      if (s.approval) return refuse("one at a time", "One approval at a time. The pending one needs an answer first.");
      return wait(a, s, c, { kind: "payment", sentence, amount: pay.amount, lamports, name: pay.name, reason, provenance, verdict: v.verdict, policyReason: v.reason, signature: null });
    },
    "rf3.ask_human"(a, s, c, args, reason) {
      const question = line(args.question, REASON_MAX);
      if (!question) return refuse("unclear", "rf3.ask_human takes a question of one short line.");
      // Checked before the claim and before any card exists, so no form asking for a secret ever renders.
      if (isSecretRequest(question) || isSecretRequest(reason)) {
        return breach(a, s, c, RULES.secret, `ask: ${question}`, "A request for a seed phrase, a key, a password or sudo is refused before anything is shown.");
      }
      // The same for a looser policy. A human changes a cap on the policy page, so this ask never becomes a card.
      if (isCapRequest(question) || isCapRequest(reason)) {
        return breach(a, s, c, RULES.cap, `ask: ${question}`, "A request to loosen the policy is refused before anything is shown. A human changes the policy on the policy page.");
      }
      if (!a.claimedBy) return refuse("not claimed", NOT_CLAIMED);
      if (s.question) return refuse("one at a time", "One question at a time. The pending one needs an answer first.");
      s.questions++;
      return wait(a, s, c, { kind: "question", question, reason, answer: null });
    },
    "rf3.contribute_circle": () => refuse("not in this build", "Circle contributions run in the susu mock only."),
  };

  function route(a, s, c, r, leak) {
    const held = gate(a, s);
    if (held) return held;
    if (r.bad) return refuse("malformed", "Arguments are up to 8 short text values with plain lowercase names.");
    if (!TOOLS.includes(r.tool)) return refuse("unknown tool", `There is no such tool. The seven tools are ${TOOLS.join(", ")}.`);
    if (!r.reason) return refuse("no reason", "Every call needs a one-line reason of up to 200 characters.");
    if (leak.failed) return refuse("leak check", "The leak check could not run, so the call was refused.");
    if (leak.hits.length) return refuse("leak check", `The leak check found a ${leak.hits[0].type.toLowerCase()} in this call. Nothing from it was used.`);
    return tools[r.tool](a, s, c, r.args, r.reason);
  }
  // What the page needs to open the leak modal: the agent's name, the kind of secret and the fields it sat in.
  const leakOf = (a, leak) => (leak.hits.length ? { agent: a.name, agentId: a.id, type: leak.hits[0].type, note: leak.hits[0].note, fields: leak.hits.map((h) => h.field) } : null);
  // Writes the closing row once and builds what the agent gets back: the result, or the refusal with its rule name.
  function complete(a, s, c, res, leak) {
    if (c.out) return c.out;
    const { logged, ...rest } = res;
    const out = { tool: c.tool, ...rest, state: statusOf(a) };
    if (leak.hits.length) out.leak = leakOf(a, leak);
    c.out = out;
    emit(a, s, "tool.complete", {
      call: c.k, tool: c.tool, ok: out.ok, refused: out.refused ?? null, rule: out.rule ?? null, detail: out.reason ?? "",
      result: logged ?? out.result ?? null, leak: out.leak ? { type: out.leak.type, fields: [...out.leak.fields] } : null,
    }, { leak: out.leak ?? null });
    return out;
  }

  // The agent's only way in. It takes a tool name, text arguments and a one-line reason, and it can reach nothing
  // in human.*. The promise for a payment or a question stays open until the human's card closes.
  async function call(agentId, req) {
    try {
      const a = agents.get(agentId);
      if (!a) return refuse("unknown agent", "No agent has that id.", { tool: null });
      const r = readRequest(req);
      const leak = await screen(r);
      expire();
      const s = last(a);
      if (!s) {
        const why = a.rest === "revoked" ? END.revoke : ["no session", "No session is running. A human starts one."];
        const found = leakOf(a, leak); // with no session there is no row to write, and the page still hears of the leak
        if (found) tell({ agentId: a.id, leak: found });
        return { tool: r.tool || "unknown", ...refuse(...why), state: statusOf(a), ...(found && { leak: found }) };
      }
      s.unreachable = false; // it just called
      const c = { k: ++s.calls, tool: r.tool || "unknown", out: null, finish: null };
      c.finish = (res) => complete(a, s, c, res, leak);
      emit(a, s, "tool.start", { call: c.k, tool: c.tool, args: { ...r.args }, reason: r.reason });
      let res;
      try { res = await route(a, s, c, r, leak); } catch { res = refuse("error", "RobotFac3 hit an error and refused the call."); }
      return c.finish(res);
    } catch {
      return refuse("error", "RobotFac3 hit an error and refused the call.", { tool: null });
    }
  }
  // What a page hands to an agent: one function, bound to one agent id.
  const port = (agentId) => Object.freeze({ agentId, call: (req) => call(agentId, req) });

  // ---------- Human side ----------
  // Called by the page for a person's press, for Phantom's answer and for wallet changes. None of these takes
  // agent input, and no tool leads here. Text a person typed is leak-checked again before it is stored or sent on.
  const askOf = (id, kind) => { const ask = asks.get(id); return ask && ask.kind === kind ? ask : null; };
  const human = {
    async addAgent(spec) {
      if (!isPlain(spec)) return no("An agent needs an id, a name and a source.");
      const { id, source } = spec, name = line(spec.name, NAME_MAX), avatar = spec.avatar === undefined ? "" : line(spec.avatar, 64);
      if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.includes(id)) return no("The id uses a-z, 0-9 and hyphens, up to 32 characters. The ids connect and approvals belong to pages.");
      if (!name) return no("The name is one line of up to 24 characters.");
      if (!SOURCES.includes(source)) return no("The source is scripted, mcp or registry.");
      if (avatar === null) return no("The avatar is one short line.");
      const p = readPolicy(spec.policy ?? {}, basePolicy());
      if (p.bad) return no(p.bad);
      const hit = await check(name);
      if (hit !== null) return leakNo(hit, "Nothing was saved.");
      if (agents.has(id)) return no("An agent with that id already exists.");
      const a = { id, name, source, avatar, claimedBy: null, policy: p.policy, rest: "idle", breaches: 0, sessions: [], raise: null, log: [] };
      agents.set(id, a);
      act(a, null, "add", `${name} · ${source}`);
      return yes({ agent: viewAgent(a) });
    },
    // No wallet, no claim. The claim binds the agent to one wallet address until a human revokes it.
    claim(agentId, address) {
      const a = agents.get(agentId);
      if (!a) return no("No agent has that id.");
      if (typeof address !== "string" || !ADDRESS_RE.test(address)) return no("No wallet, no claim. Connect Phantom first.");
      if (wallet !== undefined && wallet !== address) return no("That address is different from the connected wallet.");
      if (a.claimedBy && a.claimedBy !== address) return no("This agent is claimed by another wallet. Revoke it first.");
      a.claimedBy = address;
      if (a.rest === "revoked") a.rest = "idle";
      const s = live(a);
      // A preview held when Phantom connected was waiting for this claim, so that one hold ends here. A pause and a
      // breach hold stay: a claim is no Resume press.
      if (s) { if (s.preview) s.walletChanged = false; s.preview = false; }
      act(a, s, "claim", address);
      return yes({ agent: viewAgent(a) });
    },
    revoke(agentId) {
      const a = agents.get(agentId);
      if (!a) return no("No agent has that id.");
      const s = live(a);
      act(a, s, "revoke", "Landed transactions stay as they are.");
      a.claimedBy = null;
      a.raise = null;
      if (s) end(a, s, "revoke");
      a.rest = "revoked";
      return yes({ agent: viewAgent(a) });
    },
    // Lowering applies at once. Raising is held: the first call returns needsConfirm with the old and new values,
    // and only a second call with the same edit and confirm: true applies it. A confirm with no matching first
    // call is treated as a first call, so a page cannot skip the confirm sheet by accident.
    setPolicy(agentId, patch, opts) {
      const a = agents.get(agentId);
      if (!a) return no("No agent has that id.");
      const r = readPolicy(patch, a.policy);
      if (r.bad) return no(r.bad);
      const old = a.policy, next = r.policy, raised = raisedFields(old, next), key = JSON.stringify(viewPolicy(next));
      const confirmed = raised.length > 0 && opts?.confirm === true && a.raise === key;
      const needsConfirm = raised.length > 0 && !confirmed;
      // The fields that only tighten apply at once, in a mixed edit too. The raised ones wait for the confirm.
      const applied = { ...next };
      if (needsConfirm) for (const f of raised) applied[INNER[f]] = old[INNER[f]];
      const before = viewPolicy(old), after = viewPolicy(applied);
      const changed = Object.keys(after).filter((f) => JSON.stringify(after[f]) !== JSON.stringify(before[f]));
      a.policy = applied;
      a.raise = needsConfirm ? key : null;
      const s = live(a);
      if (changed.length) act(a, s, confirmed ? "policy raised" : "policy lowered", changed.map((f) => `${f}: ${JSON.stringify(before[f])} → ${JSON.stringify(after[f])}`).join(" · "));
      if (s) expire(); // an expiry moved into the past ends the session now
      return yes({ needsConfirm, old: before, next: viewPolicy(next), raised, policy: viewPolicy(a.policy) });
    },
    // task is the sentence the human typed. It is the only source a payment's amount and name can come from, so a
    // sentence that mentions money in any looser shape is refused here, before an agent sees it.
    async startSession(agentId, task) {
      const text = line(task, TASK_MAX);
      if (!text) return no("A session needs a task sentence of one line, up to 500 characters.");
      const hit = await check(text);
      if (hit !== null) return leakNo(hit, "No session was started.");
      const pay = parsePaymentRequest(text);
      if (pay.kind === "unclear") return no(`That payment is unclear. Write it exactly like: ${PAYMENT_SHAPE}`, { unclear: true });
      const a = agents.get(agentId);
      if (!a) return no("No agent has that id.");
      if (a.rest === "revoked") return no("This agent was revoked. Claim it again to start a session.");
      if (live(a)) return no("This agent already has a session running.");
      const t = time();
      if (a.policy.expiresAt !== null && t >= a.policy.expiresAt) return no("The policy expired. Set a new expiry first.");
      if (a.claimedBy && wallet !== undefined && wallet !== a.claimedBy) return no("The connected wallet is different from the claiming wallet.", { needs: "wallet", wallet: a.claimedBy });
      const s = {
        n: a.sessions.length + 1, task: text, payment: pay.kind === "payment" ? { amount: pay.amount, name: pay.name } : null,
        preview: a.claimedBy === null, startedAt: t, endedAt: null, endedBy: null, policyAtEnd: null,
        paused: false, pausedWhy: "", walletChanged: false, unreachable: false, held: null,
        spent: 0n, reserved: 0n, denied: [], breaches: 0, page: null, pages: [], approval: null, question: null,
        events: [], seq: 0, dropped: 0, calls: 0, proposals: 0, approved: 0, denials: 0, cancelled: 0, questions: 0, signatures: [],
      };
      a.sessions.push(s);
      emit(a, s, "session.start", { task: text, payment: s.payment ? { ...s.payment } : null, preview: s.preview, claimedBy: a.claimedBy, policy: viewPolicy(a.policy) });
      return yes({ session: s.n, agent: viewAgent(a) });
    },
    endSession: (agentId) => finishBy(agentId, "you", "end session"),
    stop: (agentId) => finishBy(agentId, "stop", "stop"),
    // New calls are refused with "paused". A call already open, such as a pending card, may finish.
    pause(agentId) {
      const a = agents.get(agentId), s = a && live(a);
      if (!s) return no("No session is running.");
      if (!s.paused) { s.paused = true; s.pausedWhy = "Paused by you."; act(a, s, "pause"); }
      return yes({ status: statusOf(a) });
    },
    // The switch to You mode: every running agent is paused, with the reason shown on its card.
    pauseAll(reason) {
      const why = line(reason, NOTE_MAX) || "Paused by you.", paused = [];
      for (const a of agents.values()) {
        const s = live(a);
        if (!s || s.paused) continue;
        s.paused = true;
        s.pausedWhy = why;
        act(a, s, "pause", why);
        paused.push(a.id);
      }
      return yes({ paused });
    },
    // Lifts a pause, a wallet hold and a breach hold. After a wallet change the connected wallet has to be the
    // claiming wallet again. An unclaimed preview stays held until it is claimed with the connected wallet, and
    // claim() ends that hold. After a breach the human writes a note, so every release of a held agent has a
    // reason on the record.
    async resume(agentId, note) {
      const text = note === undefined ? "" : line(note, NOTE_MAX);
      if (text === null) return no("The note is one line of up to 200 characters.");
      if (text) { const hit = await check(text); if (hit !== null) return leakNo(hit, "The agent stays held."); }
      expire();
      const a = agents.get(agentId), s = a && live(a);
      if (!s) return no("No session is running.");
      if (s.walletChanged && (!a.claimedBy || wallet !== a.claimedBy)) return no("Wallet changed. Reconnect the claiming wallet to resume.", { needs: "wallet", wallet: a.claimedBy });
      if (s.held && !text) return no("Resume after a breach needs a note.", { needs: "note" });
      if (!s.paused && !s.walletChanged && !s.held) return yes({ status: statusOf(a) });
      Object.assign(s, { paused: false, pausedWhy: "", walletChanged: false, held: null });
      act(a, s, "resume", text);
      return yes({ status: statusOf(a) });
    },
    // The page calls this on every Phantom connect, disconnect and account change. Each session of an agent that
    // the new wallet did not claim is held and its pending cards are denied: a payment approved under one wallet
    // must never be signed by another.
    walletChanged(address) {
      wallet = typeof address === "string" && ADDRESS_RE.test(address) ? address : null;
      const held = [];
      for (const a of agents.values()) {
        const s = live(a);
        if (!s || (a.claimedBy && a.claimedBy === wallet)) continue;
        if (!s.walletChanged) { s.walletChanged = true; act(a, s, "wallet changed", a.claimedBy ? `Reconnect ${a.claimedBy} to resume.` : "Claim with the connected wallet to resume.", "RF3"); }
        cancelPending(a, s, "wallet", END.wallet);
        held.push(a.id);
      }
      return yes({ wallet, held });
    },
    // The transport reports an agent it can no longer hear. Approvals freeze until the agent calls again.
    markUnreachable(agentId) {
      const a = agents.get(agentId), s = a && live(a);
      if (!s) return no("No session is running.");
      s.unreachable = true;
      act(a, s, "unreachable", "", "RF3");
      return yes({ status: statusOf(a) });
    },
    // decision is exactly "approve" or "reject". An approval that timed out or was cancelled stays closed.
    // Approving one card decides that card only: the next proposal gets its own card and its own policy check.
    async decide(approvalId, decision, reason) {
      if (decision !== "approve" && decision !== "reject") return no("Choose approve or reject.");
      const why = reason === undefined ? "" : line(reason, NOTE_MAX);
      if (why === null) return no("The reason is one line of up to 200 characters.");
      if (why) { const hit = await check(why); if (hit !== null) return leakNo(hit, "Nothing was sent to the agent."); }
      expire();
      const ask = askOf(approvalId, "payment");
      if (!ask) return no("No approval has that id.");
      if (ask.status !== "pending") return no(`This approval is closed: ${ask.status}.`, { approval: viewAsk(ask) });
      const a = agents.get(ask.agentId), s = a.sessions[ask.session - 1];
      if (decision === "reject") {
        s.denials++;
        s.denied.push({ name: ask.name, lamports: ask.lamports });
        close(a, s, ask, "rejected", "YOU", why, refuse("rejected", why || "Rejected by the human."));
        return yes({ approval: viewAsk(ask) });
      }
      const hold = s.held ? "Review the breach first." : s.unreachable ? "The agent is unreachable. Approvals are frozen." : s.walletChanged || !a.claimedBy || (wallet !== undefined && wallet !== a.claimedBy) ? "The connected wallet is different from the claiming wallet." : null;
      if (hold) return no(hold, { approval: viewAsk(ask) });
      const v = judge(a.policy, s, ask.lamports, ask.name, time());
      if (v.verdict === "block") {
        cancel(a, s, ask, "policy", ["blocked", v.reason]);
        return no(v.reason, { verdict: "block", approval: viewAsk(ask) });
      }
      s.reserved += ask.lamports; // reserved now, so a second payment cannot spend the same room while Phantom is open
      s.approved++;
      ask.status = "approved";
      ask.decision = { by: "YOU", reason: why, at: time() };
      emit(a, s, "approval.decided", { id: ask.id, kind: ask.kind, outcome: "approved", by: "YOU", reason: why });
      return yes({ verdict: v.verdict, reason: v.reason, approval: viewAsk(ask) });
    },
    // The second policy check, run by the review right before Phantom opens. ok: false means do not sign. A block
    // closes the approval and gives back its reserved amount.
    recheck(approvalId) {
      expire();
      const ask = askOf(approvalId, "payment");
      if (!ask) return no("No approval has that id.", { verdict: "block" });
      if (ask.status !== "pending" && ask.status !== "approved") return no(`This approval is closed: ${ask.status}.`, { verdict: "block" });
      const a = agents.get(ask.agentId), s = a.sessions[ask.session - 1];
      const stop = gate(a, s, true)?.reason || (!a.claimedBy || (wallet !== undefined && wallet !== a.claimedBy) ? "The connected wallet is different from the claiming wallet." : null);
      const v = stop ? { verdict: "block", reason: stop } : judge(a.policy, s, ask.lamports, ask.name, time(), { counted: ask.status === "approved" ? ask.lamports : 0n });
      if (v.verdict === "block") {
        cancel(a, s, ask, "policy", ["blocked", v.reason]);
        return no(v.reason, { verdict: "block", approval: viewAsk(ask) });
      }
      return yes({ verdict: v.verdict, reason: v.reason, capRemaining: meter(a.policy, s).left, approval: viewAsk(ask) });
    },
    // Phantom's answer for an approved payment. sent: true needs the transaction signature and moves the amount
    // from reserved to spent. sent: false gives the amount back. This works after a stop too: the record of what
    // was sent has to stay true.
    settle(approvalId, result) {
      const ask = askOf(approvalId, "payment");
      if (!ask) return no("No approval has that id.");
      if (ask.status !== "approved") return no(`Nothing to settle. This approval is ${ask.status}.`);
      const a = agents.get(ask.agentId), s = a.sessions[ask.session - 1];
      let out;
      if (result?.sent === true) {
        const signature = result.signature;
        if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return no("A sent payment needs its transaction signature. The amount stays reserved.");
        s.reserved -= ask.lamports;
        s.spent += ask.lamports;
        s.signatures.push(signature);
        Object.assign(ask, { status: "sent", signature });
        out = yes({ result: { outcome: "sent", signature, amount: ask.amount, name: ask.name } });
      } else if (result?.sent === false) {
        s.reserved -= ask.lamports;
        ask.status = "not sent";
        out = refuse("not sent", line(result.reason, NOTE_MAX) || "The payment was not sent.");
      } else return no("Say whether the payment was sent.");
      if (s.approval === ask.id) s.approval = null;
      ask.resolve(out);
      return yes({ approval: viewAsk(ask), ...meter(policyOf(a, s), s) });
    },
    // The answer goes back to the agent, so it is leak-checked first. A hit keeps the question open.
    async answer(questionId, text) {
      const reply = line(text, ARG_MAX);
      if (!reply) return no("An answer is one line of up to 500 characters.");
      const hit = await check(reply);
      if (hit !== null) return leakNo(hit, "Nothing was sent to the agent.");
      expire();
      const q = askOf(questionId, "question");
      if (!q) return no("No question has that id.");
      if (q.status !== "pending") return no(`This question is closed: ${q.status}.`);
      const a = agents.get(q.agentId);
      q.answer = reply;
      close(a, a.sessions[q.session - 1], q, "answered", "YOU", "", yes({ result: { answer: reply } }), { answer: reply });
      return yes({ question: viewAsk(q) });
    },
    skip(questionId) {
      expire();
      const q = askOf(questionId, "question");
      if (!q) return no("No question has that id.");
      if (q.status !== "pending") return no(`This question is closed: ${q.status}.`);
      const a = agents.get(q.agentId);
      close(a, a.sessions[q.session - 1], q, "skipped", "YOU", "", refuse("skipped", "The human skipped the question."));
      return yes({ question: viewAsk(q) });
    },
  };
  function finishBy(agentId, by, action) {
    const a = agents.get(agentId), s = a && live(a);
    if (!s) return no("No session is running.");
    act(a, s, action, "Landed transactions stay as they are.");
    end(a, s, by);
    return yes({ status: statusOf(a), summary: summary(agentId, s.n) });
  }

  return Object.freeze({
    call, port, human: Object.freeze(human),
    tick: () => expire(), subscribe,
    agents: () => [...agents.values()].map(viewAgent),
    agent: (id) => (agents.has(id) ? viewAgent(agents.get(id)) : null),
    approval: (id) => (asks.has(id) ? viewAsk(asks.get(id)) : null),
    sessions: (id) => (agents.has(id) ? agents.get(id).sessions.map((s) => summary(id, s.n)) : []),
    pending, events, summary, exportSession,
  });
}
