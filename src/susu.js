// Susu circle mock engine for rf3://susu (flows 7, 8, 9 and 14).
// This file plays a circle program that is not written yet. It is a MOCK: nothing here reaches a chain, a wallet or
// the network, and nothing here signs or holds a key.
//   - Pure: no DOM, no network call, no storage, no system clock. The clock is circle.today, moved only by nextDay.
//   - One JSON-safe state object, the "circle". Functions never change the circle they are given. A state change
//     returns { ok, circle, rows, ... } with a new circle; rows are the history rows it appended.
//   - Every state change takes who is acting ({ mode, wallet, memberId, agentName }) and checks the human-only rules
//     itself, so a page cannot skip them. A refusal returns { ok: false, verdict, reason } and moves no money.
//   - Money is BigInt base units parsed from decimal strings. No floating point touches an amount.
//   - Anything malformed is refused. A circle that fails its shape check makes every function throw a plain Error.

// ---------- Constants ----------
export const MOCK_CHIP = "mock · no chain";
export const CHAIN_LABEL = "Solana";
export const MOCK_WALLET = "mock member"; // fixture seats carry this label in place of an address
export const ENFORCER = "the circle program";
export const GRACE_HOURS = 48;
export const COLLATERAL_ROUNDS = 1;
export const AGENT_FEE_SOL = "0.000005"; // mock fee per agent contribution
// The allowance sentence. The agents page states the same words.
export const ALLOWANCE_EXCEPTION = "One exception: a circle allowance. The program fixes the destination and the amount. You get a notice a day before. You can pause or revoke at any time.";
export const NO_WITHDRAW = "The program has no withdraw instruction and no admin key. Money leaves the vault only as a round's payout or as collateral returned at close.";

const MOCK_SEAT = { usdc: "500", feeSol: "0.05" }; // what each seat of a circle made by createCircle starts with
const U64_MAX = (1n << 64n) - 1n;
const MAX_ROUND = 100_000_000_000n; // 100,000 USDC per round
const MAX_HISTORY = 1000;
const MAX_SCRIPT = 64;
const CADENCES = ["weekly", "monthly"];
const CIRCLE_STATUS = ["forming", "active", "complete"];
const MEMBER_STATUS = ["invited", "joined", "declined", "left"];
const ALLOWANCE = ["none", "active", "paused", "revoked"];
const ROUND_STATE = ["settled", "open", "scheduled"]; // the only order rounds may appear in
const PAY_BY = ["hand", "agent", "collateral"];
const ANSWERS = ["ok", "pause", "hand"];
const KINDS = ["create", "join", "decline", "allowance-set", "allowance-pause", "allowance-resume", "allowance-revoke", "notice", "ok", "pay", "stop", "block", "late", "draw", "short", "pot", "open", "claim", "top-up", "leave", "return", "complete"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Only a-z, 0-9, hyphen and underscore in a name, as the SNS resolver accepts: look-alike letters are refused.
const SNS_RE = /^[a-z0-9_-]{1,63}\.sns$/;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NAME_RE = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/; // no full stop, so the instruction grammar's final stop is unambiguous
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEAT_RE = /^[a-z][a-z0-9-]*$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/;
const ACTOR_RE = /^(?:YOU|PROGRAM|[A-Z0-9][A-Z0-9 _-]{0,23}|[a-z0-9_-]{1,63}\.sns)$/;
const DAY_RE = /^(20\d{2})-(\d{2})-(\d{2})$/;
// Every row this file writes fits this set. Stored text outside it (markup, control or look-alike characters) is refused.
const TEXT_RE = /^[A-Za-z0-9 .,:'_-]+$/;

const fail = (why) => { throw new Error(why); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isStr = (v, re, max) => typeof v === "string" && v.length <= max && re.test(v);
const isAddr = (v) => isStr(v, ADDR_RE, 44);
const copy = (v) => JSON.parse(JSON.stringify(v));
// Exactly these fields and no others. An extra field in stored state is treated as tampering.
function exact(o, keys, what) {
  if (!isObj(o)) fail(`${what} is malformed`);
  if (Object.keys(o).length !== keys.length || keys.some((k) => !has(o, k))) fail(`${what} has missing or unexpected fields`);
}

// ---------- Money (S2) ----------
// Decimal strings in and out, BigInt base units in between. "0,5", ".5", "1e3", "01", "-1" and every number are
// refused: a looser reader once turned "0,5" into 5 in the SOL grammar, and a float cannot hold micro-units exactly.
const USDC_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const SOL_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
function toUnits(s, decimals, what) {
  if (typeof s !== "string" || s.length > 30 || !(decimals === 6 ? USDC_RE : SOL_RE).test(s)) fail(`${what} must be a plain decimal with at most ${decimals} decimals`);
  const [whole, frac = ""] = s.split(".");
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"));
  if (units > U64_MAX) fail(`${what} is out of range`);
  return units;
}
function fromUnits(units, decimals) {
  if (typeof units !== "bigint" || units < 0n || units > U64_MAX) fail("An amount must be a BigInt of base units in range");
  const base = 10n ** BigInt(decimals);
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / base}${frac ? "." + frac : ""}`;
}
export const parseUsdc = (s) => toUnits(s, 6, "A USDC amount");
export const formatUsdc = (units) => fromUnits(units, 6);
// One canonical string per amount: "50.000000" and "50.0" both come out as "50".
export const canonUsdc = (s) => formatUsdc(parseUsdc(s));
// Stored amounts must already be canonical, so two spellings of one amount never sit in the state.
function money(s, what, decimals = 6) {
  const units = toUnits(s, decimals, what);
  if (fromUnits(units, decimals) !== s) fail(`${what} is not in canonical form`);
  return units;
}
const usd = (s) => toUnits(s, 6, "A USDC amount");
const sol = (s) => toUnits(s, 9, "A SOL amount");

// ---------- Days ----------
// A day is an ISO date string. Arithmetic runs on whole day numbers through Date.UTC, which reads no clock.
function dayNum(s) {
  const m = typeof s === "string" ? s.match(DAY_RE) : null;
  if (!m) fail("A date must look like 2026-10-14");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) fail("That date does not exist");
  return t.getTime() / 86_400_000;
}
export const addDays = (day, n) => new Date((dayNum(day) + n) * 86_400_000).toISOString().slice(0, 10);
export const shortDate = (day) => (dayNum(day), `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8))}`);
const pad2 = (n) => String(n).padStart(2, "0");
// Round i (from 0) falls due i cadence steps after the start. Monthly keeps the day of the month, so the start
// day is held to 1 through 28 and no round can land on a date that does not exist.
function dueDate(start, cadence, i) {
  if (cadence === "weekly") return addDays(start, 7 * i);
  const k = Number(start.slice(5, 7)) - 1 + i;
  return `${Number(start.slice(0, 4)) + Math.floor(k / 12)}-${pad2((k % 12) + 1)}-${start.slice(8)}`;
}

// ---------- Shape checks (S1, S15) ----------
const TOP = ["v", "mock", "id", "name", "chain", "token", "amount", "cadence", "seats", "start", "order", "collateralRounds", "graceHours", "status", "today", "organizer", "members", "rounds", "script", "history"];
const MEMBER = ["id", "name", "slot", "status", "wallet", "joinedOn", "usdc", "feeSol", "collateral", "allowance"];
const ROUND = ["n", "due", "recipient", "state", "payments", "answers", "pot"];
const PAYMENT = ["member", "by", "day", "amount"];
const POT = ["state", "amount", "since", "paidOn"];
const ROW = ["day", "actor", "kind", "text", "member"];

// The fixture, stored state and every argument named "circle" pass through here. Nothing is repaired or defaulted.
function check(c) {
  exact(c, TOP, "The circle");
  if (c.v !== 1 || c.mock !== true) fail("This engine reads version 1 of the mock circle and nothing else");
  if (!isStr(c.id, ID_RE, 48)) fail("The circle id is malformed");
  if (!isStr(c.name, NAME_RE, 40) || c.name.length < 2) fail("The circle name is malformed");
  if (c.chain !== "solana" || c.token !== "USDC" || c.order !== "fixed") fail("The chain, token or order is unexpected");
  if (c.collateralRounds !== COLLATERAL_ROUNDS || c.graceHours !== GRACE_HOURS) fail("The collateral or grace rule is unexpected");
  const amount = money(c.amount, "The round amount");
  if (amount <= 0n || amount > MAX_ROUND) fail("The round amount is out of range");
  if (!CADENCES.includes(c.cadence)) fail("The cadence is unexpected");
  if (!Number.isInteger(c.seats) || c.seats < 3 || c.seats > 12) fail("A circle has 3 to 12 seats");
  const today = dayNum(c.today);
  dayNum(c.start);
  if (c.cadence === "monthly" && Number(c.start.slice(8)) > 28) fail("A monthly circle starts on day 1 to 28");
  if (!CIRCLE_STATUS.includes(c.status)) fail("The circle status is unexpected");

  if (!Array.isArray(c.members) || c.members.length !== c.seats) fail("The member list does not match the seats");
  const ids = new Set(), names = new Set(), wallets = new Set();
  c.members.forEach((m, i) => {
    exact(m, MEMBER, "A member");
    if (!isStr(m.id, SEAT_RE, 24) || ids.has(m.id)) fail("A member id is malformed or repeated");
    if (!(isStr(m.name, SNS_RE, 67) || isAddr(m.name)) || names.has(m.name)) fail("A member name is malformed or repeated");
    ids.add(m.id); names.add(m.name);
    if (m.slot !== i + 1) fail("The payout order is out of sequence");
    if (!MEMBER_STATUS.includes(m.status)) fail("A member status is unexpected");
    money(m.usdc, "A USDC balance");
    money(m.feeSol, "A fee balance", 9);
    const held = money(m.collateral, "A collateral balance");
    if (held > amount * BigInt(COLLATERAL_ROUNDS)) fail("A member holds more collateral than the rule allows");
    exact(m.allowance, ["state", "agent"], "An allowance");
    if (!ALLOWANCE.includes(m.allowance.state)) fail("An allowance state is unexpected");
    if (m.allowance.agent !== "" && !agentLabel(m.allowance.agent)) fail("An agent name is malformed");
    const seated = m.status === "joined" || m.status === "left";
    if (seated) {
      if (m.wallet !== MOCK_WALLET && !isAddr(m.wallet)) fail("A member wallet is malformed");
      if (m.wallet !== MOCK_WALLET) { if (wallets.has(m.wallet)) fail("One wallet holds two seats"); wallets.add(m.wallet); }
      if (dayNum(m.joinedOn) > today) fail("A member joined in the future");
    } else if (m.wallet !== "" || m.joinedOn !== "" || held !== 0n || m.allowance.state !== "none" || m.allowance.agent !== "") {
      fail("A seat that has not joined holds member state");
    }
    if (c.status !== "forming" && !seated) fail("A running circle has an empty seat");
  });
  if (c.organizer !== "" && !ids.has(c.organizer)) fail("The organizer is not a seat");

  if (!Array.isArray(c.rounds) || c.rounds.length !== c.seats) fail("The rounds do not match the seats");
  let rank = 0, open = 0, settled = 0;
  c.rounds.forEach((r, i) => {
    exact(r, ROUND, "A round");
    if (r.n !== i + 1 || r.due !== dueDate(c.start, c.cadence, i) || r.recipient !== c.members[i].id) fail("A round does not match the terms");
    const at = ROUND_STATE.indexOf(r.state);
    if (at < rank) fail("The rounds are out of order");
    rank = at;
    if (r.state === "open") open++;
    if (r.state === "settled") settled++;
    if (!Array.isArray(r.payments) || !Array.isArray(r.answers)) fail("A round is malformed");
    const paid = new Set();
    let sum = 0n;
    for (const p of r.payments) {
      exact(p, PAYMENT, "A payment");
      if (!ids.has(p.member) || paid.has(p.member)) fail("A payment names an unknown seat or repeats one");
      paid.add(p.member);
      if (!PAY_BY.includes(p.by)) fail("A payment kind is unexpected");
      if (dayNum(p.day) > today) fail("A payment is dated in the future");
      const a = money(p.amount, "A payment");
      if (p.by === "collateral" ? a > amount : a !== amount) fail("A payment is not the round amount");
      sum += a;
    }
    for (const a of r.answers) {
      exact(a, ["member", "answer", "day"], "A pre-notice answer");
      if (!ids.has(a.member) || !ANSWERS.includes(a.answer) || dayNum(a.day) > today) fail("A pre-notice answer is unexpected");
    }
    exact(r.pot, POT, "A pot");
    const pot = money(r.pot.amount, "A pot");
    if (r.state === "settled") {
      if (paid.size !== c.seats || pot !== sum) fail("A settled round does not add up");
      if (dayNum(r.pot.since) > today) fail("A pot is dated in the future");
      if (r.pot.state === "claimable") { if (r.pot.paidOn !== "") fail("An unclaimed pot carries a paid date"); }
      else if (r.pot.state !== "paid" || dayNum(r.pot.paidOn) < dayNum(r.pot.since) || dayNum(r.pot.paidOn) > today) fail("A pot's state is unexpected");
    } else {
      if (r.pot.state !== "none" || pot !== 0n || r.pot.since !== "" || r.pot.paidOn !== "") fail("A round that has not settled holds a pot");
      if (r.state === "scheduled" && (r.payments.length || r.answers.length)) fail("A round that has not opened holds payments");
      if (r.payments.some((p) => p.by === "collateral")) fail("An open round holds a collateral draw");
      if (r.state === "open" && today > dayNum(r.due) + GRACE_HOURS / 24) fail("A round is open after its grace ended");
    }
  });
  if (open !== (c.status === "active" ? 1 : 0)) fail("The rounds do not match the circle status");
  if (c.status === "forming" && (settled || open)) fail("A forming circle has started rounds");
  if (c.status === "complete" && settled !== c.seats) fail("A complete circle has unfinished rounds");

  if (!Array.isArray(c.script) || c.script.length > MAX_SCRIPT) fail("The mock script is malformed");
  for (const s of c.script) {
    exact(s, ["day", "member", "action"], "A script step");
    dayNum(s.day);
    if (!ids.has(s.member) || !["pay", "top-up"].includes(s.action)) fail("A script step is unexpected");
    // A scripted member's own name is the actor on its rows, so it must be a .sns name.
    if (!SNS_RE.test(c.members.find((m) => m.id === s.member).name)) fail("A script step names a seat without a .sns name");
  }
  if (!Array.isArray(c.history) || c.history.length > MAX_HISTORY) fail("The history is malformed");
  for (const h of c.history) {
    exact(h, ROW, "A history row");
    if (dayNum(h.day) > today) fail("A history row is dated in the future");
    if (!isStr(h.actor, ACTOR_RE, 67) || !KINDS.includes(h.kind)) fail("A history row has an unexpected actor or kind");
    if (!isStr(h.text, TEXT_RE, 300)) fail("A history row's text is malformed");
    if (h.member !== "" && !ids.has(h.member)) fail("A history row names an unknown seat");
  }
  return c;
}

// Reads data/susu-demo.json (already parsed, or as text). Throws a plain Error on anything unexpected.
export function loadFixture(json) {
  let raw = json;
  if (typeof json === "string") { try { raw = JSON.parse(json); } catch { fail("The circle fixture is not valid JSON"); } }
  return copy(check(raw));
}

// ---------- Small readers ----------
const seat = (c, id) => (typeof id === "string" ? c.members.find((m) => m.id === id) : undefined) || null;
const openRound = (c) => c.rounds.find((r) => r.state === "open") || null;
const paymentOf = (r, id) => r.payments.find((p) => p.member === id) || null;
const graceEnd = (c, r) => addDays(r.due, c.graceHours / 24); // the last day a late contribution is accepted
const noticeDay = (r) => addDays(r.due, -1); // the pre-notice goes out the day before the due date
const collateralDue = (c) => usd(c.amount) * BigInt(c.collateralRounds);
const topUpOwed = (c, m) => (m.status === "joined" && c.status === "active" ? collateralDue(c) - usd(m.collateral) : 0n);
const inviteEnd = (c) => addDays(c.start, -1); // invites close the day before round 1 falls due
const every = (c) => (c.cadence === "weekly" ? "week" : "month");
// What the vault holds: collateral, the open round's payments and the pots nobody has claimed yet.
const vaultOf = (c) => c.members.reduce((sum, m) => sum + usd(m.collateral), 0n)
  + c.rounds.reduce((sum, r) => sum + (r.state === "open" ? usd(c.amount) * BigInt(r.payments.length) : r.pot.state === "claimable" ? usd(r.pot.amount) : 0n), 0n);

// ---------- Who is acting, history rows, results ----------
// An agent may not take the labels that mark a person or the program in the history.
const agentLabel = (name) => (isStr(name, AGENT_RE, 24) && !["YOU", "PROGRAM"].includes(name.toUpperCase()) ? name.toUpperCase() : "");
function actorOf(who) {
  if (!isObj(who)) return "";
  if (who.mode === "human") return "YOU";
  return who.mode === "agent" ? agentLabel(who.agentName) : "";
}
function note(c, rows, actor, kind, text, member = "") {
  const row = { day: c.today, actor, kind, text, member };
  c.history.push(row);
  if (c.history.length > MAX_HISTORY) c.history.splice(0, c.history.length - MAX_HISTORY);
  rows.push(row);
}
// A refusal is recorded as a block row (or a stop row) so the history shows what was tried. Nothing else changes.
function refuse(circle, who, reason, verdict = "refused", code = "") {
  const actor = actorOf(who);
  if (!actor) return { ok: false, verdict, code, reason, circle, rows: [] };
  const c = copy(circle), rows = [];
  note(c, rows, actor, verdict === "stopped" ? "stop" : "block", reason, seat(c, who.memberId)?.id || "");
  return { ok: false, verdict, code, reason, circle: c, rows };
}
// The red line each human-only action prints for an agent.
const AGENT_NO = {
  create: "Agents never start a circle. Switch to You.",
  join: "Agents never join a circle or accept its terms. Switch to You.",
  allowance: "Only a person sets, pauses or revokes an allowance. Switch to You.",
  notice: "Only a person answers the pre-notice. Switch to You.",
  hand: "Switch to You to pay by hand.",
  claim: "Agents never claim a pot. Switch to You.",
  topup: "Agents never top up collateral. Switch to You.",
  leave: "Agents never leave a circle for a member. Switch to You.",
  clock: "Only a person moves the mock clock. Switch to You.",
};
// The gate every human-only state change passes first. Returns { deny } holding the finished refusal, or the
// working copy { c, rows, m }. need.wallet: a connected wallet signs this. need.member: the seat must have joined.
function enter(circle, who, action, need = {}) {
  check(circle);
  if (!actorOf(who)) return { deny: refuse(circle, who, "Who is acting is unclear.") };
  if (who.mode !== "human") return { deny: refuse(circle, who, AGENT_NO[action]) };
  if (need.wallet && !isAddr(who.wallet)) return { deny: refuse(circle, who, "No wallet is connected. Connect Phantom first.") };
  const c = copy(circle), m = seat(c, who.memberId);
  if (need.member) {
    if (!m) return { deny: refuse(circle, who, `That seat is not part of ${c.name}.`) };
    if (m.status !== "joined") return { deny: refuse(circle, who, m.status === "left" ? `${m.name} left ${c.name}.` : `${m.name} has not joined ${c.name}.`) };
    // A seat joined through join() answers only to the wallet that signed, for every action. Fixture seats hold
    // the mock label and no address to compare, so there the page's "Viewing as" seat stands in for the wallet.
    if (m.wallet !== MOCK_WALLET && m.wallet !== who.wallet) return { deny: refuse(circle, who, isAddr(who.wallet) ? `This wallet is not a member of ${c.name}.` : "No wallet is connected. Connect Phantom first.") };
  }
  return { c, rows: [], m };
}

// ---------- Create (S3) ----------
// Reads the organizer's form. Returns { ok: true, terms } or { ok: false, errors: [{ field, reason }] }.
// today is the mock day: the start date must come after it, so every member has time to read the terms.
export function validateTerms(input, today) {
  const errors = [];
  const bad = (field, reason) => { errors.push({ field, reason }); };
  if (!isObj(input)) return { ok: false, errors: [{ field: "terms", reason: "The terms are missing." }] };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!isStr(name, NAME_RE, 40) || name.length < 2) bad("name", "Name the circle with 2 to 40 letters, digits, single spaces or hyphens.");
  let amount = "";
  try {
    const units = parseUsdc(typeof input.amount === "string" ? input.amount.trim() : input.amount);
    if (units <= 0n || units > MAX_ROUND) bad("amount", "The amount per round is between 0.000001 and 100000 USDC.");
    else amount = formatUsdc(units);
  } catch { bad("amount", "Type the USDC amount as a plain decimal with at most 6 decimals, such as 50 or 12.5."); }
  if (!CADENCES.includes(input.cadence)) bad("cadence", "Cadence is weekly or monthly.");
  const seats = typeof input.seats === "string" && /^[1-9]\d?$/.test(input.seats) ? Number(input.seats) : input.seats;
  if (!Number.isInteger(seats) || seats < 3 || seats > 12) bad("seats", "A circle has 3 to 12 seats.");
  let now = null, start = "";
  try { now = dayNum(today); } catch { bad("today", "The mock day is malformed."); }
  try {
    if (now !== null && now >= dayNum(input.start)) bad("start", "The start date must be after today.");
    else if (input.cadence === "monthly" && Number(input.start.slice(8)) > 28) bad("start", "A monthly circle starts on day 1 to 28, so every round falls on the same day.");
    else start = (dayNum(input.start), input.start);
  } catch { bad("start", "Pick a start date such as 2026-11-01."); }
  if (input.order !== "fixed") bad("order", "The order is fixed. Members take the pot in the order listed.");
  const members = [];
  if (!Array.isArray(input.members) || input.members.length < 3) bad("members", "A circle needs 3 or more members.");
  else {
    input.members.forEach((raw, i) => {
      const t = typeof raw === "string" ? raw.trim() : "";
      const m = isAddr(t) ? t : t.toLowerCase();
      if (!isAddr(m) && !isStr(m, SNS_RE, 67)) bad("members", `Member ${i + 1} must be a .sns name or a wallet address.`);
      else if (members.includes(m)) bad("members", `Member ${i + 1} is listed twice.`);
      else members.push(m);
    });
    if (Number.isInteger(seats) && input.members.length !== seats) bad("members", "List one member per seat.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, terms: { name, amount, cadence: input.cadence, seats, start, order: "fixed", members } };
}

// Every date, every slot and every rule, with the numbers filled in. Takes validated terms or a circle.
export function termsSheet(terms) {
  let t;
  if (isObj(terms) && has(terms, "v")) { check(terms); t = { ...terms, members: terms.members.map((m) => m.name) }; }
  else {
    const v = validateTerms(terms, "2000-01-01");
    if (!v.ok) fail(v.errors[0].reason);
    t = v.terms;
  }
  const amount = usd(t.amount), n = BigInt(t.seats);
  const slots = t.members.map((member, i) => {
    const due = dueDate(t.start, t.cadence, i), graceEnds = addDays(due, GRACE_HOURS / 24);
    return { slot: i + 1, round: i + 1, member, due, dueText: shortDate(due), graceEnds, drawOn: addDays(graceEnds, 1) };
  });
  const collateral = formatUsdc(amount * BigInt(COLLATERAL_ROUNDS));
  // The most a pot-taker who leaves can cost: every round after the first, with their collateral already drawn.
  const exposure = formatUsdc(amount * (n - 1n));
  return {
    name: t.name, chain: CHAIN_LABEL, mock: MOCK_CHIP, token: "USDC", amount: t.amount, cadence: t.cadence, seats: t.seats, rounds: t.seats,
    start: t.start, order: "fixed", pot: formatUsdc(amount * n), totalPerMember: formatUsdc(amount * n), collateral, graceHours: GRACE_HOURS,
    slots, dates: slots.map((s) => s.due), exposure,
    lines: {
      amount: `Each member pays ${t.amount} USDC every ${every(t)} for ${t.seats} rounds.`,
      pot: `Each round one member takes the pot of ${formatUsdc(amount * n)} USDC, in the fixed order listed.`,
      collateral: `Each member posts ${collateral} USDC of collateral at join. That is one round's amount.`,
      grace: `A late contribution has ${GRACE_HOURS} hours of grace. Every member sees the time left.`,
      missed: `When the grace ends the program draws ${t.amount} USDC from that member's collateral and pays the pot in full. The member tops up before the next round or leaves.`,
      cover: "One round of collateral covers one miss.",
      leaveAfterPot: `A member who leaves after taking the pot costs the circle up to ${exposure} USDC beyond their collateral. The program cannot collect it.`,
      lock: "Terms lock at round 1. A change needs every member to sign again.",
      organizer: "The organizer has no power after creation.",
      account: "One circle per USDC account.",
      wallet: "Your pot goes to the wallet you join with. Keep it.",
      vault: "The program holds the vault and nobody holds a key to it.",
    },
  };
}

// The organizer signs once (mock). The new circle is forming: every seat is invited and nobody has joined.
// who.memberId may name the organizer's own seat ("m1" is the first listed member) so the history can say so.
export function createCircle(input, who, today) {
  const deny = (reason) => ({ ok: false, verdict: "refused", code: "", reason, circle: null, rows: [], errors: [] });
  if (!actorOf(who)) return deny("Who is acting is unclear.");
  if (who.mode !== "human") return deny(AGENT_NO.create);
  if (!isAddr(who.wallet)) return deny("No wallet is connected. Connect Phantom first.");
  const v = validateTerms(input, today);
  if (!v.ok) return { ...deny(v.errors[0].reason), errors: v.errors };
  const t = v.terms;
  const members = t.members.map((name, i) => ({
    id: `m${i + 1}`, name, slot: i + 1, status: "invited", wallet: "", joinedOn: "", usdc: MOCK_SEAT.usdc, feeSol: MOCK_SEAT.feeSol,
    collateral: "0", allowance: { state: "none", agent: "" },
  }));
  const c = {
    v: 1, mock: true, id: t.name.toLowerCase().replace(/ /g, "-"), name: t.name, chain: "solana", token: "USDC", amount: t.amount,
    cadence: t.cadence, seats: t.seats, start: t.start, order: "fixed", collateralRounds: COLLATERAL_ROUNDS, graceHours: GRACE_HOURS,
    status: "forming", today, organizer: members.some((m) => m.id === who.memberId) ? who.memberId : "", members,
    rounds: members.map((m, i) => ({ n: i + 1, due: dueDate(t.start, t.cadence, i), recipient: m.id, state: "scheduled", payments: [], answers: [], pot: { state: "none", amount: "0", since: "", paidOn: "" } })),
    script: [], history: [],
  };
  const rows = [];
  note(c, rows, "YOU", "create", `Created ${c.name}: ${c.amount} USDC every ${every(c)}, ${c.seats} seats, fixed order. The organizer has no power after this.`, c.organizer);
  return { ok: true, circle: check(c), rows, sheet: termsSheet(c) };
}

// Always refused. Terms and order are fixed at creation and lock at round 1; the re-sign step is not in the mock.
export function changeTerms(circle, who) {
  check(circle);
  if (isObj(who) && who.mode === "agent") return refuse(circle, who, "Agents never change a circle's terms or its order.");
  const organizer = isObj(who) && who.memberId !== "" && who.memberId === circle.organizer;
  return refuse(circle, who, `${organizer ? "The organizer has no power after creation. " : ""}Terms lock at round 1. A change needs every member to sign again, and the mock has no re-sign step.`);
}

// ---------- Join (S4) ----------
// state: agent, invalid, member, taken, declined, expired, no-wallet, wrong-wallet, short, valid.
function joinState(c, who) {
  const no = (state, reason) => ({ state, reason });
  if (!actorOf(who)) return no("unclear", "Who is acting is unclear.");
  if (who.mode !== "human") return no("agent", AGENT_NO.join);
  const m = seat(c, who.memberId);
  if (!m) return no("invalid", `This invite does not match a seat in ${c.name}.`);
  if (m.status === "joined") return m.wallet === MOCK_WALLET || m.wallet === who.wallet ? no("member", `${m.name} is already a member of ${c.name}.`) : no("taken", "That seat is taken.");
  if (isAddr(who.wallet) && c.members.some((x) => x.status === "joined" && x.wallet === who.wallet)) return no("member", `This wallet already holds a seat in ${c.name}.`);
  if (m.status === "declined") return no("declined", `This invite to ${c.name} was declined.`);
  if (m.status === "left" || c.status !== "forming") return no("taken", "That seat is closed.");
  if (c.today > inviteEnd(c)) return no("expired", `This invite expired on ${shortDate(inviteEnd(c))}.`);
  if (!isAddr(who.wallet)) return no("no-wallet", "No wallet is connected. Connect Phantom to join.");
  // A seat offered to an address is held for that address. A seat offered to a .sns name is resolved by the page.
  if (isAddr(m.name) && m.name !== who.wallet) return no("wrong-wallet", "This seat was offered to another wallet.");
  if (usd(m.usdc) < collateralDue(c)) return no("short", `Collateral is ${formatUsdc(collateralDue(c))} USDC. This seat holds ${m.usdc} USDC.`);
  return no("valid", "");
}
export const joinStatus = (circle, who) => joinState(check(circle), who);

// What the join sheet shows for one seat: slot, payout date, collateral and the stated gaps.
export function joinSheet(circle, memberId) {
  const c = check(circle), m = seat(c, memberId);
  if (!m) fail(`That seat is not part of ${c.name}`);
  const sheet = termsSheet(c), mine = sheet.slots[m.slot - 1];
  return {
    circle: c.name, chain: CHAIN_LABEL, mock: MOCK_CHIP, member: m.name, slot: m.slot, of: c.seats, payoutRound: mine.round, payoutDate: mine.due,
    payoutText: mine.dueText, pot: sheet.pot, amount: c.amount, cadence: c.cadence, collateral: sheet.collateral, usdc: m.usdc,
    usdcShort: m.status === "invited" && usd(m.usdc) < collateralDue(c), inviteExpires: inviteEnd(c), slots: sheet.slots, lines: sheet.lines,
  };
}

// One signature (mock): accept the terms, post collateral, fix the payout wallet. opts.accept must be true.
// opts.otherCircles is every other circle the page holds, so "one circle per USDC account" is checked here.
export function join(circle, who, opts = {}) {
  check(circle);
  const s = joinState(circle, who);
  const no = (reason, state = s.state) => ({ ...refuse(circle, who, reason), state });
  if (s.state !== "valid") return no(s.reason);
  if (!isObj(opts) || opts.accept !== true) return no("Read and accept the terms before you join.");
  if (!Array.isArray(opts.otherCircles)) return no("RobotFac3 could not check this wallet's other circles.");
  for (const o of opts.otherCircles) {
    try { check(o); } catch { return no("RobotFac3 could not check this wallet's other circles."); }
    // An SPL Approve replaces the delegate on a USDC account, so a second circle would break the first.
    if (o.id !== circle.id && o.status !== "complete" && o.members.some((x) => x.status === "joined" && x.wallet === who.wallet)) {
      return no(`One circle per USDC account. This wallet already pays into ${o.name}.`, "account");
    }
  }
  const c = copy(circle), rows = [], m = seat(c, who.memberId), due = collateralDue(c);
  m.status = "joined";
  m.wallet = who.wallet; // the pot goes here. No function in this file writes this field again.
  m.joinedOn = c.today;
  m.usdc = formatUsdc(usd(m.usdc) - due);
  m.collateral = formatUsdc(due);
  note(c, rows, "YOU", "join", `Joined ${c.name} at slot ${m.slot} of ${c.seats}. Posted ${m.collateral} USDC of collateral. The pot goes to the wallet that joined.`, m.id);
  if (c.members.every((x) => x.status === "joined")) {
    c.status = "active";
    c.rounds[0].state = "open";
    note(c, rows, "PROGRAM", "open", `All ${c.seats} seats joined. Terms are locked. Round 1 opened. ${c.amount} USDC is due ${shortDate(c.rounds[0].due)}.`);
  }
  return { ok: true, circle: c, rows, state: "joined", slot: m.slot, payoutTo: m.wallet };
}
// Accepting the terms and joining are one signature, so this is join with accept set.
export const acceptTerms = (circle, who, opts = {}) => join(circle, who, { ...(isObj(opts) ? opts : {}), accept: true });

// A decline closes the seat for good, so it needs a connected wallet like the join it answers.
export function decline(circle, who) {
  const g = enter(circle, who, "join", { wallet: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g;
  if (!m || m.status !== "invited") return refuse(circle, who, m ? `${m.name} has no open invite to ${c.name}.` : `This invite does not match a seat in ${c.name}.`);
  if (isAddr(m.name) && m.name !== who.wallet) return refuse(circle, who, "This seat was offered to another wallet.");
  m.status = "declined";
  note(c, rows, "YOU", "decline", `Declined the invite to ${c.name}. This seat is not in the circle.`, m.id);
  return { ok: true, circle: c, rows, state: "declined" };
}

// ---------- Allowance (S5) ----------
// Off by default. The enforcer is the circle program: it pulls one round's amount into this circle's vault and
// nothing else. The agent only triggers it.
export function allowanceSheet(circle, memberId) {
  const c = check(circle), m = seat(c, memberId);
  if (!m) fail(`That seat is not part of ${c.name}`);
  const left = c.rounds.filter((r) => r.state !== "settled").length;
  return {
    circle: c.name, chain: CHAIN_LABEL, mock: MOCK_CHIP, member: m.name, state: m.allowance.state, agent: m.allowance.agent,
    enforcer: ENFORCER, destination: `${c.name} vault`, perRound: c.amount, roundsLeft: left, approvedTotal: formatUsdc(usd(c.amount) * BigInt(left)),
    usdc: m.usdc, feeSol: m.feeSol, usdcShort: usd(m.usdc) < usd(c.amount), feeShort: sol(m.feeSol) < sol(AGENT_FEE_SOL),
    lines: {
      enforcer: `The enforcer is ${ENFORCER}.`,
      destination: `It pays ${c.name}'s vault and no other destination.`,
      amount: `It moves ${c.amount} USDC per round, once per round.`,
      notice: "You get a notice a day before each agent payment. You answer OK, Pause, or Pay by hand now.",
      revoke: "Pause stops the agent at once. Revoke is one signature in your wallet.",
      cap: "The SOL spend limit in Settings does not apply to USDC contributions.",
      exception: ALLOWANCE_EXCEPTION,
    },
  };
}
function allowance(circle, who, from, to, kind, wallet, text) {
  const g = enter(circle, who, "allowance", { wallet, member: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g;
  if (c.status === "complete") return refuse(circle, who, `${c.name} is finished.`);
  if (!from.includes(m.allowance.state)) return refuse(circle, who, `The allowance is ${m.allowance.state === "none" ? "not set" : m.allowance.state}.`);
  m.allowance.state = to;
  if (kind === "allowance-set") m.allowance.agent = agentLabel(who.agentName) ? who.agentName : "";
  note(c, rows, "YOU", kind, text(c), m.id);
  return { ok: true, circle: c, rows, state: to };
}
export const setAllowance = (circle, who) => allowance(circle, who, ["none", "revoked"], "active", "allowance-set", true, (c) => `Set the agent allowance. ${ENFORCER[0].toUpperCase()}${ENFORCER.slice(1)} may pull ${c.amount} USDC per round into ${c.name}'s vault.`);
export const pauseAllowance = (circle, who) => allowance(circle, who, ["active"], "paused", "allowance-pause", false, () => "Paused the agent. It pays nothing until resumed.");
export const resumeAllowance = (circle, who) => allowance(circle, who, ["paused"], "active", "allowance-resume", false, () => "Resumed the agent.");
export const revokeAllowance = (circle, who) => allowance(circle, who, ["active", "paused"], "revoked", "allowance-revoke", true, () => "Revoked the program's allowance.");

// ---------- Pre-notice (S6) ----------
// Due the day before the round's due date for a joined member who has not paid. kind "agent": the allowance is
// active or paused. kind "reminder": the member pays by hand. Returns null when no notice is due today.
export function preNotice(circle, memberId) {
  const c = check(circle), m = seat(c, memberId), r = openRound(c);
  if (!m || m.status !== "joined" || !r || c.today !== addDays(r.due, -1) || paymentOf(r, m.id)) return null;
  const on = shortDate(r.due), a = r.answers.find((x) => x.member === m.id) || null;
  const base = { round: r.n, of: c.seats, amount: c.amount, due: r.due, answer: a ? a.answer : null, answeredOn: a ? a.day : "" };
  if (m.allowance.state === "paused") return { ...base, kind: "agent", text: `Your agent is paused. ${c.amount} USDC is due to ${c.name} on ${on}.`, line: `Agent paused. Pay ${c.amount} USDC by hand before ${on} ends.` };
  if (m.allowance.state !== "active") return { ...base, kind: "reminder", text: `${c.amount} USDC is due to ${c.name} on ${on}. Pay by hand.`, line: "" };
  return {
    ...base, kind: "agent", text: `Your agent will pay ${c.amount} USDC to ${c.name} on ${on}.`,
    line: a && a.answer === "ok" ? `Agent will pay ${on}. You said OK on ${shortDate(a.day)}.` : `With no answer the agent pays on ${on}.`,
  };
}
// answer: "ok", "pause" or "hand" (pay by hand now). OK is recorded as a human decision with actor YOU.
export function answerPreNotice(circle, who, answer) {
  const g = enter(circle, who, "notice", { wallet: answer === "hand", member: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g, r = openRound(c), n = preNotice(circle, m.id);
  if (!ANSWERS.includes(answer)) return refuse(circle, who, "Answer OK, Pause, or Pay by hand now.");
  if (!n || n.kind !== "agent" || m.allowance.state !== "active") return refuse(circle, who, "No agent pre-notice is waiting for an answer.");
  if (n.answer) return refuse(circle, who, `This pre-notice was answered on ${shortDate(n.answeredOn)}.`);
  if (answer === "hand") {
    const no = handBlock(c, m, r);
    if (no) return refuse(circle, who, no);
    payIn(c, r, m, "hand");
    note(c, rows, "YOU", "pay", `Paid ${c.amount} USDC by hand for round ${r.n}. The agent has nothing to pay this round.`, m.id);
  } else if (answer === "pause") {
    m.allowance.state = "paused";
    note(c, rows, "YOU", "allowance-pause", `Paused the agent at the pre-notice. Round ${r.n} waits for a payment by hand.`, m.id);
  } else {
    note(c, rows, "YOU", "ok", `Said OK. The agent pays ${c.amount} USDC to ${c.name} on ${shortDate(r.due)}.`, m.id);
  }
  r.answers.push({ member: m.id, answer, day: c.today });
  settle(c, rows);
  return { ok: true, circle: c, rows, answer };
}

// ---------- Contributions (S7, S8) ----------
// The agent's whole policy, checked every time before anything moves and again inside agentContribute.
// req: { circle: <circle id>, round: <integer>, amount: <USDC string> }. Returns { verdict, code, reason }.
// refused: the request is wrong (wallet, circle, amount, round, late, early, member, allowance, paid).
// stopped: the request is right and the agent must halt (paused, paid-by-hand, notice, usdc-short, fee-short).
// by is who asks, as checkContribute and agentContribute pass it: an agent's ask needs a connected wallet, the
// wallet that joined the seat and the agent the allowance names. nextDay passes no by. That call is the program's
// clock paying under the seat's own allowance on the due date.
function policy(c, m, req, by = null) {
  const no = (verdict, code, reason) => ({ verdict, code, reason });
  // Every mock sheet needs a connected wallet, and so does the agent. A disconnect in Phantom stops it.
  if (by && !isAddr(by.wallet)) return no("refused", "wallet", "No wallet is connected. Connect Phantom first.");
  if (!isObj(req)) return no("refused", "request", "The request is malformed.");
  if (req.circle !== c.id) return no("refused", "circle", `This allowance pays ${c.name} and no other circle.`);
  let amount = null;
  try { amount = parseUsdc(req.amount); } catch { /* refused below */ }
  if (amount === null || amount !== usd(c.amount)) return no("refused", "amount", `The amount must be exactly ${c.amount} USDC.`);
  const r = openRound(c);
  if (!r) return no("refused", "round", `${c.name} has no open round.`);
  if (!Number.isInteger(req.round) || req.round !== r.n) return no("refused", "round", `Round ${r.n} is open. ${Number.isInteger(req.round) && req.round > 0 && req.round <= c.seats ? `Round ${req.round}` : "That round"} cannot be paid now.`);
  if (c.today > r.due) return no("refused", "late", `Round ${r.n} was due ${shortDate(r.due)}. The agent pays on or before the due date. Pay by hand before the grace ends on ${shortDate(graceEnd(c, r))}.`);
  // The allowance promises a notice a day before each agent payment, so nothing is paid ahead of the notice day.
  if (c.today < noticeDay(r)) return no("refused", "early", `The agent pays after the pre-notice. The notice for round ${r.n} goes out on ${shortDate(noticeDay(r))}.`);
  if (!m || m.status !== "joined") return no("refused", "member", `${m ? m.name : "That seat"} has not joined ${c.name}.`);
  // A seat joined through join() answers only to the wallet that signed. That holds for the agent's one action too.
  if (by && m.wallet !== MOCK_WALLET && m.wallet !== by.wallet) return no("refused", "member", `This wallet is not a member of ${c.name}.`);
  if (m.allowance.state !== "active" && m.allowance.state !== "paused") return no("refused", "allowance", m.allowance.state === "revoked" ? `The allowance for ${c.name} is revoked.` : `No allowance is set for ${c.name}.`);
  // The person set the allowance for one named agent. Another agent's ask is wrong, paused or not.
  if (by && m.allowance.agent !== "" && agentLabel(m.allowance.agent) !== agentLabel(by.agentName)) return no("refused", "allowance", `This allowance is set for ${m.allowance.agent}.`);
  if (m.allowance.state === "paused") return no("stopped", "paused", "The allowance is paused. Nothing moved.");
  const p = paymentOf(r, m.id);
  if (p && p.by === "hand") return no("stopped", "paid-by-hand", `Round ${r.n} was paid by hand on ${shortDate(p.day)}. Nothing moved.`);
  if (p) return no("refused", "paid", `Round ${r.n} is already paid. A second contribution for the same round is refused.`);
  // The notice day is the person's review step. Until this seat says OK the agent waits for the due date.
  const a = r.answers.find((x) => x.member === m.id);
  if (c.today < r.due && !(a && a.answer === "ok")) return no("stopped", "notice", a ? `The pre-notice for round ${r.n} holds no OK. The agent pays on ${shortDate(r.due)}. Nothing moved.` : `The pre-notice for round ${r.n} waits for your answer. Nothing moved.`);
  if (usd(m.usdc) < amount) return no("stopped", "usdc-short", `USDC is short: ${m.name} holds ${m.usdc} USDC and round ${r.n} needs ${c.amount} USDC. Nothing moved. Pay by hand.`);
  if (sol(m.feeSol) < sol(AGENT_FEE_SOL)) return no("stopped", "fee-short", `The agent's fee balance is short: ${m.feeSol} SOL of the ${AGENT_FEE_SOL} SOL needed. Nothing moved. Pay by hand.`);
  return no("allow", "ok", `Round ${r.n}, ${c.amount} USDC, into ${c.name}'s vault.`);
}
export function checkContribute(circle, who, req) {
  const c = check(circle);
  if (!actorOf(who)) return { verdict: "refused", code: "who", reason: "Who is acting is unclear." };
  return policy(c, seat(c, who.memberId), req, who);
}
function payIn(c, r, m, by) {
  m.usdc = formatUsdc(usd(m.usdc) - usd(c.amount));
  if (by === "agent") m.feeSol = fromUnits(sol(m.feeSol) - sol(AGENT_FEE_SOL), 9);
  r.payments.push({ member: m.id, by, day: c.today, amount: c.amount });
}
// The one thing an agent may do in a circle. The policy runs here even when the page already ran it.
export function agentContribute(circle, who, req) {
  const c = copy(check(circle)), rows = [];
  if (!actorOf(who)) return refuse(circle, who, "Who is acting is unclear.");
  if (who.mode !== "agent") return refuse(circle, who, "A person pays through Pay by hand.");
  const m = seat(c, who.memberId), v = policy(c, m, req, who);
  if (v.verdict !== "allow") return refuse(circle, who, v.reason, v.verdict, v.code);
  const r = openRound(c);
  payIn(c, r, m, "agent");
  note(c, rows, actorOf(who), "pay", `Paid ${c.amount} USDC to ${c.name} for round ${r.n} of ${c.seats} under ${m.name}'s allowance.`, m.id);
  settle(c, rows);
  return { ok: true, verdict: "paid", code: "ok", reason: "", circle: c, rows, round: r.n, amount: c.amount };
}

// Why a payment by hand cannot go through, or "" when it can.
function handBlock(c, m, r, round) {
  if (!r) return `${c.name} has no open round.`;
  if (round !== undefined && round !== r.n) {
    const asked = Number.isInteger(round) ? c.rounds[round - 1] : null;
    if (asked && asked.state === "settled") return `Round ${asked.n} closed on ${shortDate(asked.pot.since)}. That deadline has passed.`;
    return asked ? `Round ${r.n} is the open round. Round ${asked.n} opens after it.` : "That round is not part of this circle.";
  }
  const p = paymentOf(r, m.id);
  if (p) return `Round ${r.n} is already paid. ${p.by === "agent" ? "The agent paid" : "You paid by hand"} on ${shortDate(p.day)}.`;
  if (c.today > graceEnd(c, r)) return `Round ${r.n} closed on ${shortDate(graceEnd(c, r))}. That deadline has passed.`;
  if (usd(m.usdc) < usd(c.amount)) return `USDC is short: this seat holds ${m.usdc} USDC and round ${r.n} needs ${c.amount} USDC.`;
  return "";
}
// Human only, in You mode, with a connected wallet. Accepted through the last day of grace; the agent is held to
// the due date. opts.round is optional and must name the open round when given.
export function payByHand(circle, who, opts = {}) {
  const g = enter(circle, who, "hand", { wallet: true, member: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g, r = openRound(c);
  const no = handBlock(c, m, r, isObj(opts) ? opts.round : null);
  if (no) return refuse(circle, who, no);
  payIn(c, r, m, "hand");
  note(c, rows, "YOU", "pay", `Paid ${c.amount} USDC by hand for round ${r.n} of ${c.seats}${c.today > r.due ? ", inside the grace" : ""}.`, m.id);
  settle(c, rows);
  return { ok: true, circle: c, rows, round: r.n, amount: c.amount };
}

// ---------- Round clock (S9) ----------
// Each mock day is the start of that calendar day.
//   due - 1          pre-notice day; an agent asked to pay today pays only after the seat's OK
//   due              scheduled agents pay on arrival, with or without an answer; a payment by hand today is on time
//   due + 1, due + 2 late, with 48 then 24 hours of grace left; a payment by hand is still accepted
//   due + 3          the program draws from collateral, the pot is ready and the next round opens
function settle(c, rows) {
  const r = openRound(c);
  if (!r || r.payments.length !== c.seats) return;
  const pot = r.payments.reduce((sum, p) => sum + usd(p.amount), 0n), to = seat(c, r.recipient);
  r.state = "settled";
  r.pot = { state: "claimable", amount: formatUsdc(pot), since: c.today, paidOn: "" };
  note(c, rows, "PROGRAM", "pot", `Round ${r.n} pot of ${r.pot.amount} USDC is ready for ${to.name}. It goes to the wallet fixed at join.`, to.id);
  const next = c.rounds[r.n];
  if (next) {
    next.state = "open";
    note(c, rows, "PROGRAM", "open", `Round ${next.n} of ${c.seats} opened. ${c.amount} USDC is due ${shortDate(next.due)}.`);
    return;
  }
  c.status = "complete";
  note(c, rows, "PROGRAM", "complete", `All ${c.seats} rounds of ${c.name} are finished. Unclaimed pots stay claimable.`);
  // The second and last way money leaves the vault: collateral returned at close.
  for (const m of c.members) {
    if (m.status !== "joined" || usd(m.collateral) === 0n) continue;
    note(c, rows, "PROGRAM", "return", `Returned ${m.collateral} USDC of collateral to ${m.name}.`, m.id);
    m.usdc = formatUsdc(usd(m.usdc) + usd(m.collateral));
    m.collateral = "0";
  }
}
// Grace has ended: every seat that has not paid is covered from its own collateral, as far as that collateral goes.
function draw(c, r, rows) {
  const amount = usd(c.amount), drawn = [];
  for (const m of c.members) {
    if (paymentOf(r, m.id)) continue;
    const held = usd(m.collateral), take = held < amount ? held : amount;
    m.collateral = formatUsdc(held - take);
    r.payments.push({ member: m.id, by: "collateral", day: c.today, amount: formatUsdc(take) });
    drawn.push({ m, held, take });
  }
  // "Paid in full" is only said when every draw this round covered the whole amount.
  const full = drawn.every((d) => d.take === amount);
  for (const { m, held, take } of drawn) {
    const after = c.rounds[r.n] && m.status === "joined" ? ` ${m.name} tops up ${c.amount} USDC before round ${r.n + 1} or leaves.` : "";
    if (take === amount) note(c, rows, "PROGRAM", "draw", `Drew ${c.amount} USDC from ${m.name}'s collateral for round ${r.n}.${full ? " The pot is paid in full." : ""}${after}`, m.id);
    else note(c, rows, "PROGRAM", "short", `${m.name} missed round ${r.n} with ${formatUsdc(held)} USDC of collateral left. The pot is ${formatUsdc(amount - take)} USDC short. The program cannot collect it.`, m.id);
  }
}
// Moves of the other mock members, read from the fixture's script. The actor is the member's own name.
function playScript(c, rows) {
  for (const s of c.script) {
    if (s.day !== c.today) continue;
    const m = seat(c, s.member), r = openRound(c);
    if (m.status !== "joined") continue;
    if (s.action === "top-up") {
      const owed = topUpOwed(c, m);
      if (owed === 0n || usd(m.usdc) < owed) continue;
      m.usdc = formatUsdc(usd(m.usdc) - owed);
      m.collateral = formatUsdc(usd(m.collateral) + owed);
      note(c, rows, m.name, "top-up", `Topped up ${formatUsdc(owed)} USDC of collateral.`, m.id);
    } else if (!handBlock(c, m, r)) {
      payIn(c, r, m, "hand");
      note(c, rows, m.name, "pay", `Paid ${c.amount} USDC by hand for round ${r.n} of ${c.seats}.`, m.id);
      settle(c, rows);
    }
  }
}
// Only a person presses "Next day". An agent row carries the name the seat's allowance was set for, so the actor
// is the same whichever seat is viewed. who.agentName labels the acting member's agent only when that allowance
// names none. who.agentHeld says the Agents engine holds the acting agent (paused, stopped, breached, revoked).
// Only a plain false, or no flag, lets that agent pay: a payment under the name of an agent that may not act
// would make the log contradict the Agents panel.
export function nextDay(circle, who) {
  const g = enter(circle, who, "clock");
  if (g.deny) return g.deny;
  const { c, rows } = g;
  c.today = addDays(c.today, 1);
  playScript(c, rows);
  const r = openRound(c);
  if (r) {
    const mine = agentLabel(who.agentName);
    const label = (m) => agentLabel(m.allowance.agent) || (m.id === who.memberId && mine) || "AGENT";
    // The hold follows the agent's name. With a name nobody can read, it falls on the acting member's own seat.
    const held = (m) => who.agentHeld !== undefined && who.agentHeld !== false && (mine ? label(m) === mine : m.id === who.memberId);
    const waiting = c.members.filter((m) => m.status === "joined" && !paymentOf(r, m.id));
    if (c.today === addDays(r.due, -1)) {
      for (const m of waiting) if (m.allowance.state === "active") note(c, rows, label(m), "notice", `Notice to ${m.name}: the agent will pay ${c.amount} USDC to ${c.name} on ${shortDate(r.due)}.`, m.id);
    }
    if (c.today === r.due) {
      for (const m of waiting) {
        if (m.allowance.state !== "active" && m.allowance.state !== "paused") continue;
        // A fixed sentence: the Agents engine's own reason may hold characters a history row refuses.
        if (held(m)) { note(c, rows, label(m), "stop", `Stopped for ${m.name}. The agent is held in the Agents panel. Nothing moved. Pay by hand.`, m.id); continue; }
        const v = policy(c, m, { circle: c.id, round: r.n, amount: c.amount });
        if (v.verdict === "allow") { payIn(c, r, m, "agent"); note(c, rows, label(m), "pay", `Paid ${c.amount} USDC to ${c.name} for round ${r.n} of ${c.seats} under ${m.name}'s allowance.`, m.id); }
        else note(c, rows, label(m), "stop", `Stopped for ${m.name}. ${v.reason}`, m.id);
      }
    }
    if (c.today === addDays(r.due, 1)) {
      for (const m of waiting) note(c, rows, "PROGRAM", "late", `${m.name} is late for round ${r.n}. ${c.graceHours} hours of grace end on ${shortDate(graceEnd(c, r))}.`, m.id);
    }
    if (c.today > graceEnd(c, r)) draw(c, r, rows);
    settle(c, rows);
  }
  return { ok: true, circle: c, rows, day: c.today };
}

// ---------- Payout (S10) ----------
// Only this round's member, once per round, to the wallet fixed at join.
export function payoutSheet(circle, memberId) {
  const c = check(circle), m = seat(c, memberId);
  if (!m) fail(`That seat is not part of ${c.name}`);
  const r = c.rounds[m.slot - 1], open = openRound(c);
  const state = r.pot.state === "paid" ? "claimed" : r.pot.state === "claimable" ? "claimable" : r.state === "open" ? "waiting" : "not-your-turn";
  return {
    circle: c.name, chain: CHAIN_LABEL, mock: MOCK_CHIP, member: m.name, round: r.n, of: c.seats, state, due: r.due,
    amount: r.pot.state === "none" ? formatUsdc(usd(c.amount) * BigInt(c.seats)) : r.pot.amount, to: m.wallet, since: r.pot.since, paidOn: r.pot.paidOn,
    line: state === "claimable" ? `Pot unclaimed since ${shortDate(r.pot.since)}` : state === "claimed" ? `Pot paid on ${shortDate(r.pot.paidOn)}`
      : state === "waiting" ? `${r.payments.length} of ${c.seats} have paid. The pot is ready when everyone has paid or the grace has ended.`
      : `Your turn is round ${r.n}, due ${shortDate(r.due)}.${open ? ` Round ${open.n} is open.` : ""}`,
    lines: { wallet: "The pot goes to the wallet that joined. Nobody can change the recipient.", once: "A pot is paid once per round, to that round's member." },
  };
}
// opts.round defaults to the member's own round. opts.to is optional; anything but the join wallet is refused.
export function claimPayout(circle, who, opts = {}) {
  const g = enter(circle, who, "claim", { wallet: true, member: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g, o = isObj(opts) ? opts : {};
  const r = has(o, "round") ? (Number.isInteger(o.round) && c.rounds[o.round - 1]) || null : c.rounds[m.slot - 1];
  if (!r) return refuse(circle, who, "That round is not part of this circle.");
  if (r.recipient !== m.id) return refuse(circle, who, `Round ${r.n}'s pot goes to ${seat(c, r.recipient).name}. Only that round's member claims it.`);
  if (has(o, "to") && o.to !== m.wallet) return refuse(circle, who, "The pot goes to the wallet fixed at join. Nobody can change the recipient.");
  if (r.pot.state === "paid") return refuse(circle, who, `Round ${r.n}'s pot was paid on ${shortDate(r.pot.paidOn)}. A pot is paid once.`);
  if (r.pot.state !== "claimable") return refuse(circle, who, `Round ${r.n}'s pot becomes claimable when everyone has paid or the grace has ended. ${r.payments.length} of ${c.seats} have paid.`);
  m.usdc = formatUsdc(usd(m.usdc) + usd(r.pot.amount));
  r.pot.state = "paid";
  r.pot.paidOn = c.today;
  note(c, rows, "YOU", "claim", `Claimed the round ${r.n} pot: ${r.pot.amount} USDC to the wallet fixed at join.`, m.id);
  return { ok: true, circle: c, rows, round: r.n, amount: r.pot.amount, to: m.wallet };
}

// ---------- Withdraw (S11) ----------
// Always refused, for a person, an agent and the organizer alike. There is no code path here that moves vault
// money on request: the two exits are claimPayout and the collateral return inside settle.
export function withdraw(circle, who) {
  check(circle);
  const organizer = isObj(who) && who.mode === "human" && who.memberId !== "" && who.memberId === circle.organizer;
  return refuse(circle, who, `${NO_WITHDRAW}${organizer ? " The organizer has no power after creation." : ""}`, "refused", "withdraw");
}

// ---------- Top up and leave (S9, S12) ----------
export function topUpStatus(circle, memberId) {
  const c = check(circle), m = seat(c, memberId), r = openRound(c);
  if (!m) fail(`That seat is not part of ${c.name}`);
  const owed = topUpOwed(c, m), unpaid = r && m.status === "joined" && !paymentOf(r, m.id), need = owed + (unpaid ? usd(c.amount) : 0n);
  return {
    owed: formatUsdc(owed), pending: owed > 0n, usdc: m.usdc, usdcShort: usd(m.usdc) < owed,
    line: owed > 0n ? `Top up ${formatUsdc(owed)} USDC of collateral${r ? ` before round ${r.n} is due on ${shortDate(r.due)}` : ""} or leave.` : "",
    together: owed > 0n && unpaid ? `Before ${shortDate(r.due)} you need ${formatUsdc(need)} USDC.` : "",
  };
}
export function topUp(circle, who) {
  const g = enter(circle, who, "topup", { wallet: true, member: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g, owed = topUpOwed(c, m);
  if (owed === 0n) return refuse(circle, who, "Collateral is full. Nothing is owed.");
  if (usd(m.usdc) < owed) return refuse(circle, who, `USDC is short: this seat holds ${m.usdc} USDC and the top-up is ${formatUsdc(owed)} USDC.`);
  m.usdc = formatUsdc(usd(m.usdc) - owed);
  m.collateral = formatUsdc(usd(m.collateral) + owed);
  note(c, rows, "YOU", "top-up", `Topped up ${formatUsdc(owed)} USDC of collateral.`, m.id);
  return { ok: true, circle: c, rows, amount: formatUsdc(owed) };
}
// What leaving costs, for the button label. Before round 1 the collateral comes back in full. In a running circle
// the collateral stays in the vault and covers the next round this seat misses.
function leaveCost(c, m) {
  const forfeited = c.status === "active" ? usd(m.collateral) : 0n;
  const tookPot = c.rounds[m.slot - 1].state === "settled";
  const owes = usd(c.amount) * BigInt(c.rounds.filter((r) => r.state !== "settled" && !paymentOf(r, m.id)).length);
  return { forfeited, uncovered: c.status === "active" && tookPot && owes > forfeited ? owes - forfeited : 0n };
}
export function leaveSheet(circle, memberId) {
  const c = check(circle), m = seat(c, memberId);
  if (!m) fail(`That seat is not part of ${c.name}`);
  const { forfeited, uncovered } = leaveCost(c, m);
  return {
    circle: c.name, chain: CHAIN_LABEL, mock: MOCK_CHIP, member: m.name, forfeited: formatUsdc(forfeited), uncovered: formatUsdc(uncovered),
    label: forfeited > 0n ? `Leave and forfeit ${formatUsdc(forfeited)} USDC` : "Leave the circle",
    steps: ["Revoke the program's allowance", `Leave ${c.name}`],
    lines: {
      forfeit: forfeited > 0n ? `Your ${formatUsdc(forfeited)} USDC of collateral stays in the vault and covers the next round you miss.` : c.status === "forming" ? "Round 1 has not opened. Your collateral comes back in full." : "You hold no collateral in the vault.",
      uncovered: uncovered > 0n ? `You took the pot. Leaving now costs the circle ${formatUsdc(uncovered)} USDC beyond your collateral. The program cannot collect it.` : "",
    },
  };
}
export function leave(circle, who) {
  const g = enter(circle, who, "leave", { wallet: true, member: true });
  if (g.deny) return g.deny;
  const { c, rows, m } = g;
  if (c.status === "complete") return refuse(circle, who, `${c.name} is finished. Collateral was returned at close.`);
  if (c.rounds[m.slot - 1].pot.state === "claimable") return refuse(circle, who, "Claim your pot before you leave.");
  const { forfeited } = leaveCost(c, m);
  if (m.allowance.state !== "revoked") {
    m.allowance.state = "revoked";
    note(c, rows, "YOU", "allowance-revoke", "Revoked the program's allowance.", m.id);
  }
  if (c.status === "forming") { m.usdc = formatUsdc(usd(m.usdc) + usd(m.collateral)); m.collateral = "0"; }
  m.status = "left";
  note(c, rows, "YOU", "leave", forfeited > 0n ? `Left ${c.name}. Forfeited ${formatUsdc(forfeited)} USDC of collateral.` : `Left ${c.name}.`, m.id);
  return { ok: true, circle: c, rows, forfeited: formatUsdc(forfeited), steps: ["Revoke the program's allowance", `Leave ${c.name}`] };
}

// ---------- Agent instruction grammar (S13) ----------
// MOCK. This grammar is a mock, and the security teammate reviews it before it leaves the mock.
// It reads "Pay round N of <circle name>" and nothing looser: single spaces, the circle's exact name in any case,
// an optional final full stop. It carries no amount and no destination: the program fixes both.
// A sentence that asks for anything else in a circle is refused with the reason. A sentence that mentions the
// circle or USDC and fits no shape is "unclear" and must be refused by the caller. Nothing is guessed.
const PAY_ROUND_RE = /^pay round ([1-9]\d?) of ([a-z0-9]+(?:[ -][a-z0-9]+)*)\.?$/i;
const ABOUT_RE = /\b(?:circle|susu|vault|usdc|allowance|collateral|payout|round\s*\d+|the\s+pot|the\s+terms)\b/i;
// First match wins. Plain "move", "send" and "transfer" rank below the specific asks, so each refusal names its rule.
const ASKS = [
  ["withdraw", /\b(?:withdraw\w*|drain\w*|sweep\w*|empty|take\s+out|pull\s+out|cash\s+out)\b/i, NO_WITHDRAW],
  ["join", /\b(?:join\w*|enrol\w*|sign\s+(?:me\s+)?up)\b/i, "Agents never join a circle. A person joins in You mode."],
  ["accept", /\b(?:accept\w*|agree\w*|sign\w*)\b/i, "Agents never accept a circle's terms. A person reads and signs them."],
  ["allowance", /\b(?:allowance|approv\w*|delegat\w*|revok\w*|paus\w*|resum\w*|unpaus\w*)\b/i, "Only a person sets, pauses or revokes an allowance."],
  ["order", /\b(?:order|reorder\w*|slot|slots|swap\w*|turn|first|earlier)\b/i, "The payout order is fixed in the terms."],
  ["claim", /\b(?:claim\w*|collect\w*|payout|pay\s+out)\b/i, "Agents never claim a pot. Only that round's member claims it."],
  ["withdraw", /\b(?:transfer\w*|send\w*|mov\w*|refund\w*)\b/i, NO_WITHDRAW],
  ["terms", /\b(?:chang\w*|edit\w*|updat\w*|set|rais\w*|lower\w*|renam\w*|add|remov\w*|kick\w*|invit\w*)\b/i, "Terms lock at round 1. Agents never change them."],
];
export function parseCircleInstruction(text, circle) {
  const c = check(circle), t = typeof text === "string" ? text.trim() : "";
  const m = t.match(PAY_ROUND_RE);
  if (m && m[2].toLowerCase() === c.name.toLowerCase()) return { kind: "contribute", round: Number(m[1]) };
  if (!ABOUT_RE.test(t) && !t.toLowerCase().includes(c.name.toLowerCase())) return { kind: "none" };
  for (const [ask, re, reason] of ASKS) if (re.test(t)) return { kind: "refused", ask, reason };
  return { kind: "unclear" };
}
// The two read-only questions. Answers come from whatIsDue and whoIsNext, which read circle state only.
export function parseCircleQuestion(text) {
  const t = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (/^what is due\??$/.test(t)) return { kind: "due" };
  return /^who is next\??$/.test(t) ? { kind: "next" } : { kind: "none" };
}

// ---------- Plain words (S14) ----------
// The line the agent says about one seat. Built from circle state only: page text and invite text never feed it.
export function describe(circle, memberId) {
  const c = check(circle), m = seat(c, memberId), r = openRound(c);
  if (c.status === "forming") return `${c.name} has ${c.members.filter((x) => x.status === "joined").length} of ${c.seats} seats filled. Round 1 is due ${shortDate(c.rounds[0].due)}.`;
  if (!r) return `All ${c.seats} rounds of ${c.name} are finished.`;
  const head = `Round ${r.n} of ${c.seats}. ${c.amount} USDC due ${shortDate(r.due)}.`;
  if (!m || m.status !== "joined") return `${head} ${m ? `${m.name} left ${c.name}.` : `That seat is not part of ${c.name}.`}`;
  const p = paymentOf(r, m.id);
  if (p) return `${head} ${p.by === "agent" ? "I paid" : "You paid by hand"} on ${shortDate(p.day)}.`;
  if (c.today > r.due) return `${head} It is late. Pay by hand before the grace ends on ${shortDate(graceEnd(c, r))}.`;
  if (m.allowance.state === "paused") return `${head} I am paused. Pay by hand or resume me.`;
  if (m.allowance.state !== "active") return `${head} I have no allowance for this circle. Pay by hand.`;
  if (usd(m.usdc) < usd(c.amount)) return `${head} You hold ${m.usdc} USDC, so I will stop on ${shortDate(r.due)}. Add USDC or pay by hand.`;
  if (sol(m.feeSol) < sol(AGENT_FEE_SOL)) return `${head} My fee balance is short, so I will stop on ${shortDate(r.due)}. Pay by hand.`;
  return `${head} I will pay on ${shortDate(r.due)} unless you pause me.`;
}
export function whatIsDue(circle, memberId) {
  const c = check(circle), m = seat(c, memberId), r = openRound(c);
  const none = (text) => ({ state: "none", round: r ? r.n : 0, of: c.seats, amount: "0", due: "", topUp: "0", text });
  if (!m || m.status !== "joined") return none(m ? `Nothing. ${m.name} is not a member of ${c.name}.` : `That seat is not part of ${c.name}.`);
  if (!r) return none(c.status === "forming" ? `Nothing yet. Round 1 is due ${shortDate(c.rounds[0].due)} once every seat has joined.` : `Nothing. All ${c.seats} rounds are finished.`);
  const owed = topUpOwed(c, m), extra = owed > 0n ? ` A ${formatUsdc(owed)} USDC collateral top-up is also pending.` : "";
  const next = c.rounds[r.n], p = paymentOf(r, m.id);
  if (p) return { ...none(`Round ${r.n} is paid.${next ? ` Round ${next.n} is due ${shortDate(next.due)}.` : ""}${extra}`), state: "paid", topUp: formatUsdc(owed) };
  const late = c.today > r.due;
  return {
    state: late ? "late" : "due", round: r.n, of: c.seats, amount: c.amount, due: r.due, topUp: formatUsdc(owed),
    text: `${c.amount} USDC for round ${r.n} of ${c.seats}, ${late ? `late since ${shortDate(r.due)}. The grace ends on ${shortDate(graceEnd(c, r))}` : `due ${shortDate(r.due)}`}.${extra}`,
  };
}
export function whoIsNext(circle) {
  const c = check(circle), r = openRound(c);
  if (!r) return { round: 0, memberId: "", name: "", due: "", text: c.status === "forming" ? `${c.members[0].name} takes the round 1 pot once every seat has joined.` : "Nobody. Every round has paid out." };
  const m = seat(c, r.recipient), next = c.rounds[r.n];
  return { round: r.n, memberId: m.id, name: m.name, due: r.due, text: `${m.name} takes the round ${r.n} pot.${next ? ` ${seat(c, next.recipient).name} takes round ${next.n}.` : ""}` };
}

// ---------- Views for the pages ----------
// One cell of the payment grid. state: paid, drawn, short, due, late, left, upcoming.
function cellOf(c, m, r) {
  const p = paymentOf(r, m.id), blank = { state: "upcoming", by: "", label: "", day: "", hoursLeft: 0, late: false };
  if (p && p.by === "collateral") return p.amount === c.amount ? { ...blank, state: "drawn", by: p.by, label: "drawn from collateral", day: p.day } : { ...blank, state: "short", by: p.by, label: "missed, collateral short", day: p.day };
  if (p) return { ...blank, state: "paid", by: p.by, label: `paid by ${p.by}`, day: p.day, late: p.day > r.due };
  if (r.state !== "open") return blank;
  if (m.status === "left") return { ...blank, state: "left", label: "left the circle" };
  if (c.today <= r.due) return { ...blank, state: "due", label: `due ${shortDate(r.due)}` };
  const hoursLeft = (dayNum(graceEnd(c, r)) - dayNum(c.today) + 1) * 24;
  return { ...blank, state: "late", label: `late · ${hoursLeft} hours of grace left`, hoursLeft, late: true };
}
export function cell(circle, memberId, round) {
  const c = check(circle), m = seat(c, memberId), r = Number.isInteger(round) ? c.rounds[round - 1] : null;
  if (!m || !r) fail("That seat or round is not part of this circle");
  return cellOf(c, m, r);
}
const roundOf = (c, r) => ({
  n: r.n, of: c.seats, state: r.state, due: r.due, dueText: shortDate(r.due), graceEnds: graceEnd(c, r), drawOn: addDays(graceEnd(c, r), 1),
  recipient: r.recipient, recipientName: seat(c, r.recipient).name, paid: r.payments.length, seats: c.seats,
  pot: { ...r.pot, line: r.pot.state === "claimable" ? `Pot unclaimed since ${shortDate(r.pot.since)}` : r.pot.state === "paid" ? `Pot paid on ${shortDate(r.pot.paidOn)}` : "" },
});
const memberOf = (c, m) => ({
  id: m.id, name: m.name, slot: m.slot, status: m.status, wallet: m.wallet, joinedOn: m.joinedOn, usdc: m.usdc, feeSol: m.feeSol, collateral: m.collateral,
  topUpOwed: formatUsdc(topUpOwed(c, m)), allowance: m.allowance.state, agent: m.allowance.agent, payoutRound: m.slot, payoutDue: c.rounds[m.slot - 1].due,
});
// The payment grid: one row per seat in payout order, one cell per round.
export function grid(circle) {
  const c = check(circle);
  return { rounds: c.rounds.map((r) => roundOf(c, r)), rows: c.members.map((m) => ({ ...memberOf(c, m), cells: c.rounds.map((r) => cellOf(c, m, r)) })) };
}
// Everything the dashboard reads, for one viewing seat. you is null when memberId is not a seat.
export function overview(circle, memberId) {
  const c = check(circle), r = openRound(c), m = seat(c, memberId);
  return {
    id: c.id, name: c.name, chain: CHAIN_LABEL, mock: MOCK_CHIP, status: c.status, today: c.today, todayText: shortDate(c.today),
    amount: c.amount, cadence: c.cadence, seats: c.seats, seatsFilled: c.members.filter((x) => x.status === "joined").length,
    pot: formatUsdc(usd(c.amount) * BigInt(c.seats)), collateral: formatUsdc(collateralDue(c)), graceHours: c.graceHours, vault: formatUsdc(vaultOf(c)),
    round: r ? roundOf(c, r) : null,
    late: r ? c.members.filter((x) => cellOf(c, x, r).state === "late").map((x) => ({ id: x.id, name: x.name, hoursLeft: cellOf(c, x, r).hoursLeft, graceEnds: graceEnd(c, r) })) : [],
    unclaimed: c.rounds.filter((x) => x.pot.state === "claimable").map((x) => roundOf(c, x)),
    members: c.members.map((x) => memberOf(c, x)),
    you: m ? { ...memberOf(c, m), cell: r ? cellOf(c, m, r) : null } : null,
    lines: { withdraw: NO_WITHDRAW, yield: "Yield is off in the mock.", posture: "No fee on principal. Not a bank. Not FDIC or FSCS insured. No real money moves in the mock." },
  };
}
// Log level for a history row, in the security core log's terms.
export const rowLevel = (row) => (row.kind === "block" ? "block" : ["stop", "late", "draw", "short"].includes(row.kind) ? "warn" : "ok");

// ---------- Persistence (S15) ----------
// The checksum catches a hand edit or a half-written value. Anyone who can write this origin's storage can
// recompute it, so it protects against accidents and gives no protection against code running on the page.
function sum32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function serialize(circle) {
  const state = JSON.stringify(check(circle));
  return `{"v":1,"sum":"${sum32(state)}","state":${state}}`;
}
// Returns the circle, or throws a plain Error. The same shape check as the fixture runs on every stored value.
export function deserialize(text) {
  if (typeof text !== "string" || text.length > 2_000_000) fail("Stored circle state is missing or too large");
  let box;
  try { box = JSON.parse(text); } catch { fail("Stored circle state is not valid JSON"); }
  exact(box, ["v", "sum", "state"], "Stored circle state");
  if (box.v !== 1 || box.sum !== sum32(JSON.stringify(box.state))) fail("Stored circle state fails its checksum");
  return copy(check(box.state));
}
// Stored progress for the fixture's circle, or the fixture itself when storage is empty, malformed or does not
// descend from this fixture. Returns { circle, source: "storage" | "fixture", reason }. A bad fixture still throws.
export function restore(text, fixtureJson) {
  const fixture = loadFixture(fixtureJson);
  const fallback = (reason) => ({ circle: fixture, source: "fixture", reason });
  if (text === null || text === undefined || text === "") return fallback("Nothing is stored yet.");
  let c;
  try { c = deserialize(text); } catch (e) { return fallback(e.message); }
  // Terms lock at round 1 and the mock clock only moves forward, so stored state must agree with the fixture on both.
  const terms = (x) => JSON.stringify([x.id, x.name, x.amount, x.cadence, x.seats, x.start, x.organizer, x.script, x.members.map((m) => [m.id, m.name, m.slot])]);
  if (terms(c) !== terms(fixture)) return fallback("Stored circle state does not match this circle's terms.");
  if (c.today < fixture.today) return fallback("Stored circle state is older than the fixture.");
  // The engine only adds to what the fixture holds. Each rule below names one thing no function in this file can
  // do, so a stored copy that did it was edited by hand. The checksum cannot tell: anyone can recompute it.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const grew = (list, from) => list.length >= from.length && same(list.slice(0, from.length), from);
  for (const [i, f] of fixture.rounds.entries()) {
    const r = c.rounds[i];
    // A finished round keeps its payments, its answers and its pot. A pot that was paid stays paid: a pot is paid once.
    if (f.state === "settled" && !(same([r.payments, r.answers, r.pot.amount, r.pot.since], [f.payments, f.answers, f.pot.amount, f.pot.since]) && (f.pot.state !== "paid" || same(r.pot, f.pot)))) return fallback("Stored circle state rewrites a finished round.");
    // The open round only gains payments and answers.
    if (f.state === "open" && !(grew(r.payments, f.payments) && grew(r.answers, f.answers))) return fallback("Stored circle state rewrites the open round.");
  }
  for (const [i, f] of fixture.members.entries()) {
    const m = c.members[i];
    // The wallet is fixed at join, and a seat that left stays out. The mock fee balance is only ever spent.
    if (f.wallet !== "" && (m.wallet !== f.wallet || m.joinedOn !== f.joinedOn || (f.status === "left" && m.status !== "left"))) return fallback("Stored circle state rewrites a member's seat.");
    if (sol(m.feeSol) > sol(f.feeSol)) return fallback("Stored circle state raises a fee balance.");
  }
  // Rows are appended and never edited. note() trims the oldest rows at MAX_HISTORY, far past the demo's full run,
  // and a copy trimmed that far is set aside as well.
  if (!grew(c.history, fixture.history)) return fallback("Stored circle state rewrites the history.");
  // USDC only moves between seats, collateral, the open round and unclaimed pots. The total never changes.
  const pool = (x) => x.members.reduce((sum, m) => sum + usd(m.usdc), 0n) + vaultOf(x);
  if (pool(c) !== pool(fixture)) return fallback("Stored circle state creates or loses USDC.");
  return { circle: c, source: "storage", reason: "" };
}
