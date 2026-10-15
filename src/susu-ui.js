// Susu circle pages for rf3://susu (flows 7, 8, 9 and 14).
// Every page here is a MOCK. The circle program is not written, so ./susu.js plays it and this file draws it.
//   - This file imports the mock engine and nothing else. It holds no wallet call, no RPC call and no transaction
//     code, so no page here can sign or send. The one fetch reads this app's own fixture file.
//   - The engine decides every rule. A page passes in who is acting and shows what came back, refusals included.
//   - Views are pure functions from plain data to HTML strings, so they run in Node tests without a DOM.
//   - The Content-Security-Policy allows no inline style and no inline handler. Views use classes and data attributes.
//   - Every string from the fixture, storage, a name lookup, a form or the agent passes through esc() before it is markup.
import * as S from "./susu.js";

export const PREFIX = "rf3://susu";
export const STORE_KEY = "rf3.susu";
const FIXTURE_URL = "data/susu-demo.json";
const MAX_MADE = 4; // circles started in this browser, beside the demo circle
const RESERVED = ["new"]; // rf3://susu/new is a page, so no circle may take that id
const SUB_TITLES = { join: "Join", agent: "Agent allowance", withdraw: "Withdrawal refused", pay: "Contribution", payout: "Payout", missed: "Missed and top up", history: "History", leave: "Leave" };
const ROUTE_RE = /^rf3:\/\/susu(?:\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z]+))?)?$/;
// The same two shapes the engine accepts for a member: look-alike letters never reach a lookup.
const SNS_RE = /^[a-z0-9_-]{1,63}\.sns$/;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OUT_CLS = ["t-ok", "t-warn", "t-red", "t-bone"];
const FLASH_CLS = ["su-ok", "su-info", "notice-warn", "notice-red"];
const DEMO_NOTE = "No wallet connected. Connect Phantom to turn this button on. The connection is real. The signature is a mock and nothing is sent.";
const AGENT_RULE = "Agents never join a circle or accept its terms. This step is yours.";

// ---------- Small pieces ----------
// The same escape as src/main.js, kept here so the views run in Node tests.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
const usdc = (s) => `${s} USDC`;
const day = (d) => (d ? S.shortDate(d) : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (name) => (SNS_RE.test(name) ? name : short(name)); // a seat named by an address shows in short form
const pathOf = (id, sub = "") => `${PREFIX}/${id}${sub ? `/${sub}` : ""}`;
const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`;
const go = (page, text, cls = "btn-secondary") => `<button type="button" class="btn ${cls}" data-go="${esc(page)}">${esc(text)}</button>`;
// name and more are fixed strings from this file. The label is escaped.
const act = (name, text, cls = "btn-secondary", more = "") => `<button type="button" class="btn ${cls}" data-act="${name}"${more}>${esc(text)}</button>`;
const notice = (cls, html) => `<div class="notice ${cls}">${html}</div>`; // html is escaped by the caller
const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
const lines = (list) => `<ul class="su-lines">${list.filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
const flashOf = (m) => (m.flash ? notice(FLASH_CLS.includes(m.flash.cls) ? m.flash.cls : "su-info", esc(m.flash.text)) : "");
// Every susu surface carries these two chips.
export const mockChips = () => chip("", S.CHAIN_LABEL) + chip("chip-warn", S.MOCK_CHIP);
function head(title, extra = "") {
  return `<p class="eyebrow">Scripted mock</p>
    <div class="su-head"><h1 class="hero">${esc(title)}</h1><div class="row">${mockChips()}${extra}</div></div>`;
}
const frame = (title, body, narrow = true) => `<section class="page${narrow ? " page-narrow" : ""} su">${head(title)}${body}</section>`;
const backRow = (id, more = "") => `<div class="row row-top">${go(pathOf(id), "Back to the circle")}${more}</div>`;

// One mock sheet. It names who is acting, the chain, whether the step is routine or unusual, and the mock.
// The approve button reads "(mock)" and stays off without a connected wallet. The demo note says why.
export function sheet({ lead, kind, title, rows = [], list = [], notes = [], demo = false, extra = "", actions = "" }) {
  return `<div class="row">${chip("chip-bone", lead)}${chip("", S.CHAIN_LABEL)}${chip(kind === "routine" ? "chip-ok" : "chip-warn", kind === "routine" ? "routine" : "unusual")}${chip("chip-warn", S.MOCK_CHIP)}</div>
    <h3>${esc(title)}</h3>
    ${facts(rows)}${extra}
    ${list.some(Boolean) ? `<div class="su-box">${lines(list)}</div>` : ""}
    ${notes.map(([cls, text]) => notice(cls, esc(text))).join("")}
    ${demo ? `<p class="su-demo">${esc(DEMO_NOTE)}</p>` : ""}
    <div class="sheet-actions">${actions}</div>`;
}
const inline = (html) => `<div class="card sheet su-sheet">${html}</div>`;
// A mock sheet's button is on only with a connected wallet, in every mode. In Agent mode the engine then refuses the press.
const mockBtn = (name, text, on, more = "", cls = "btn-primary") => act(name, `${text} (mock)`, cls, `${more}${on ? "" : " disabled"}`);

// ---------- Routes ----------
// rf3://susu, rf3://susu/new, rf3://susu/new/review, rf3://susu/<id> and rf3://susu/<id>/<page>. Anything else is a 404.
export function route(page) {
  const m = typeof page === "string" ? page.match(ROUTE_RE) : null;
  if (!m) return { kind: "404" };
  const [, id, sub] = m;
  if (!id) return { kind: "home" };
  if (id === "new") return !sub ? { kind: "new" } : sub === "review" ? { kind: "review" } : { kind: "404" };
  if (sub && !Object.hasOwn(SUB_TITLES, sub)) return { kind: "404" };
  return { kind: "circle", id, sub: sub || "" };
}
export function titleOf(page, circles = []) {
  const r = route(page), c = r.kind === "circle" ? circles.find((x) => x.id === r.id) : null;
  if (r.kind === "home") return "Susu circle";
  if (r.kind === "new") return "Start a circle";
  if (r.kind === "review") return "Review the terms";
  if (!c) return circles.length ? "No such susu page" : "Susu circle";
  return r.sub ? `${SUB_TITLES[r.sub]} · ${c.name}` : c.name;
}

// ---------- Storage ----------
// Demo progress sits in localStorage under rf3.susu as { v: 1, circles: [text, ...] }, each text written by the
// engine's serialize(). The first is the demo circle. The engine's restore() falls back to the fixture when that
// copy is malformed, fails its checksum or does not descend from the fixture. A circle started here must pass the
// engine's shape check and checksum, or it is dropped and the page says so. Nothing is repaired.
export function openStore(raw, fixtureText) {
  const fixture = S.loadFixture(fixtureText); // a bad fixture throws, and the page shows its "fixture missing" copy
  const fresh = (note) => ({ circles: [fixture], note });
  if (raw === null || raw === undefined || raw === "") return fresh("");
  let box;
  try { box = JSON.parse(raw); } catch { return fresh("Stored progress was not valid JSON."); }
  const shaped = box !== null && typeof box === "object" && !Array.isArray(box) && Object.keys(box).length === 2 && box.v === 1
    && Array.isArray(box.circles) && box.circles.length >= 1 && box.circles.length <= MAX_MADE + 1 && box.circles.every((t) => typeof t === "string");
  if (!shaped) return fresh("Stored progress had an unexpected shape.");
  const demo = S.restore(box.circles[0], fixtureText);
  const circles = [demo.circle], notes = demo.source === "fixture" ? [demo.reason] : [];
  for (const text of box.circles.slice(1)) {
    try {
      const c = S.deserialize(text);
      if (RESERVED.includes(c.id) || circles.some((x) => x.id === c.id)) throw new Error("It repeats an id.");
      circles.push(c);
    } catch (e) { notes.push(`A circle started here was dropped. ${e.message}`); }
  }
  return { circles, note: notes.filter(Boolean).join(" ") };
}
export const packStore = (circles) => JSON.stringify({ v: 1, circles: circles.map((c) => S.serialize(c)) });

// ---------- Readers ----------
// What the connected wallet may do for the viewing seat. Fixture seats hold the mock label in place of an address,
// so there the "Viewing as" seat stands in for the wallet, as it does in the engine.
export function standing(circle, viewer, wallet) {
  const m = circle.members.find((x) => x.id === viewer) || null;
  if (!wallet) return { state: "no-wallet", text: "No wallet connected. The sheets that sign stay off until you connect Phantom." };
  if (!m) return { state: "not-member", text: `This wallet is not a member of ${circle.name}.` };
  if (m.status === "left") return { state: "left", text: `${m.name} left ${circle.name}.` };
  if (m.status !== "joined") return { state: m.status, text: "" };
  if (m.wallet !== S.MOCK_WALLET && m.wallet !== wallet) return { state: "not-member", text: `This wallet is not a member of ${circle.name}.` };
  return { state: "member", text: "" };
}
// The newest row where this seat's agent stopped while the open round is still unpaid. The agent has halted, so the
// person must act. A stop from an earlier day counts only once the due date has arrived. An OK on the pre-notice
// answers the stop that waited for it, so the newer of the two rows decides.
export function stopRow(circle, viewer) {
  const r = circle.rounds.find((x) => x.state === "open");
  if (!r || !viewer || r.payments.some((p) => p.member === viewer)) return null;
  const last = [...circle.history].reverse().find((h) => (h.kind === "stop" || h.kind === "ok") && h.member === viewer && (h.day === circle.today || h.day >= r.due)) || null;
  return last && last.kind === "stop" ? last : null;
}
const ROW_TITLES = {
  create: "Circle created", join: "Joined the circle", decline: "Invite declined", "allowance-set": "Allowance set", "allowance-pause": "Agent paused",
  "allowance-resume": "Agent resumed", "allowance-revoke": "Allowance revoked", notice: "Pre-notice sent", ok: "You said OK", pay: "Contribution paid",
  stop: "Agent stopped", block: "Refused", late: "Contribution late", draw: "Drawn from collateral", short: "Pot short", pot: "Pot ready", open: "Round opened",
  claim: "Pot claimed", "top-up": "Collateral topped up", leave: "Left the circle", return: "Collateral returned", complete: "Circle complete",
};
// The log title for one history row. refusal names what was refused when the page knows. "You" is the person at
// this browser, so another member's OK gets a title of its own.
export const rowTitle = (row, refusal = "") => (row.kind === "block" && refusal ? refusal : row.kind === "ok" && row.actor && row.actor !== "YOU" ? "Member said OK" : ROW_TITLES[row.kind] || "Circle event");

// ---------- Dashboard pieces ----------
// One payment-grid cell as { cls, text }. The engine's cell state decides both, so the grid cannot show a paid
// cell the engine did not record. A state this file does not know paints red.
export function cellChip(cell) {
  const known = {
    paid: cell.by === "agent" ? ["chip-sky", "paid by agent"] : ["chip-ok", "paid by hand"],
    drawn: ["chip-red", "drawn from collateral"], short: ["chip-red", "missed · collateral short"], due: ["chip-bone", "unpaid"],
    late: ["chip-warn", `late · ${cell.hoursLeft} h grace left`], left: ["chip-muted", "left"], upcoming: ["chip-muted", "upcoming"],
  };
  const [cls, text] = Object.hasOwn(known, cell.state) ? known[cell.state] : ["chip-red", "unreadable"];
  return { cls, text };
}
export function gridTable(g, viewer) {
  const now = (r) => (r.state === "open" ? ' class="su-now"' : "");
  const headCells = g.rounds.map((r) => `<th scope="col"${now(r)}>Round ${esc(r.n)}<small>${esc(r.dueText)} · pot to ${esc(label(r.recipientName))}</small></th>`).join("");
  const rows = g.rows.map((m) => {
    const tags = [`slot ${m.slot}`, m.id === viewer ? "you" : "", m.status === "joined" ? "" : m.status].filter(Boolean).join(" · ");
    const cells = m.cells.map((x, i) => {
      const v = cellChip(x);
      return `<td${now(g.rounds[i])}><span class="chip ${v.cls}"${x.day ? ` title="${esc(day(x.day))}"` : ""}>${esc(v.text)}</span></td>`;
    }).join("");
    return `<tr${m.id === viewer ? ' class="su-mine"' : ""}><th scope="row">${esc(label(m.name))}<small>${esc(tags)}</small></th>${cells}</tr>`;
  }).join("");
  return `<div class="card su-grid-card"><div class="su-scroll"><table class="su-grid"><thead><tr><th scope="col">Member</th>${headCells}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
// The mock controls box. It exists because this is the mock build: one browser plays every member and the clock.
export function mockBox(m) {
  const { o, viewer, mode, mock = {} } = m, off = mode === "agent" ? " disabled" : "";
  const opts = [...o.members.map((x) => [x.id, `${label(x.name)} · slot ${x.slot}`]), ["", "a visitor with no seat"]]
    .map(([id, text]) => `<option value="${esc(id)}"${id === viewer ? " selected" : ""}>${esc(text)}</option>`).join("");
  const notes = [
    mode === "agent" ? "Only a person moves the mock clock. Switch to You." : "",
    mock.storage === "unavailable" ? "Storage unavailable. Demo progress lasts until this page reloads." : "",
    mock.note ? `Stored progress was set aside. ${mock.note}` : "",
  ].filter(Boolean);
  return `<div class="su-mock" role="group" aria-label="mock controls">
    <span class="su-mock-tag">mock controls</span>
    <span class="mono">today ${esc(o.todayText)}</span>
    <button type="button" class="btn btn-secondary btn-small" data-act="next-day"${off}>Next day</button>
    <label for="suViewer">Viewing as</label>
    <select id="suViewer"${off}>${opts}</select>
    <button type="button" class="btn btn-secondary btn-small" data-act="reset"${off}>Reset demo</button>
    ${notes.map((t) => `<small>${esc(t)}</small>`).join("")}
  </div>`;
}
// The pre-notice banner: the human-review step before an agent payment. allowance is the viewing seat's allowance state.
export function noticeBanner(pre, allowance, base) {
  const wrap = (cls, html) => `<div class="card su-banner${cls}" role="status">${html}</div>`;
  if (pre.kind === "reminder") return wrap("", `<b>${esc(pre.text)}</b><div class="row">${act("pay-now", "Pay by hand", "btn-primary")}</div>`);
  if (allowance === "paused") return wrap(" su-banner-warn", `<b>${esc(pre.text)}</b><p>${esc(pre.line)}</p><div class="row">${act("pay-now", "Pay by hand", "btn-primary")}${go(`${base}/agent`, "Resume the agent")}</div>`);
  if (pre.answer === "ok") return wrap("", `<div class="row">${chip("chip-ok", "acknowledged")}</div><b>${esc(pre.line)}</b><p>You can still pause the agent on its allowance page.</p><div class="row">${go(`${base}/agent`, "Agent allowance", "btn-secondary btn-small")}</div>`);
  if (pre.answer) return wrap("", `<b>${esc(pre.text)}</b><p>You answered this notice on ${esc(day(pre.answeredOn))}. The agent is on again and pays on the due date.</p><div class="row">${go(`${base}/agent`, "Agent allowance", "btn-secondary btn-small")}</div>`);
  return wrap(" su-banner-warn", `<b>${esc(pre.text)}</b>
    <p>This is your review step. The allowance covers this circle only, one payment per round.</p>
    <p class="muted">${esc(pre.line)}</p>
    <div class="row">${act("notice-ok", "OK", "btn-primary")}${act("notice-pause", "Pause")}${act("pay-now", "Pay by hand now")}</div>`);
}
function banners(m) {
  const { o, viewer, pre, top, stand } = m, base = pathOf(o.id), out = [flashOf(m)];
  if (stand.text) out.push(notice("su-info", esc(stand.text)));
  if (o.status === "forming") {
    const invited = o.you && o.you.status === "invited";
    out.push(notice("su-info", `<b>Forming: ${esc(o.seatsFilled)} of ${esc(o.seats)} seats have joined.</b> Round 1 opens when every seat has joined. Invites close on ${esc(day(S.addDays(m.start, -1)))}. The invite link is <span class="mono break">${esc(`${base}/join`)}</span> and in the mock it works in this browser only.${invited ? ` ${go(`${base}/join`, "Read the terms and join", "btn-primary btn-small")}` : ""}`));
  }
  if (pre) out.push(noticeBanner(pre, o.you.allowance, base));
  // The allowance names an agent. While the Agents panel holds that agent the due-date payment does not run. The seat
  // hears it before the due date, with the panel's own reason and the way to lift the hold.
  const can = m.agent.can;
  if (o.you && o.you.allowance === "active" && (!o.you.agent || o.you.agent === m.agent.name) && !(can && can.ok === true)) {
    out.push(notice("notice-warn", `<b>${esc(m.agent.name)} cannot pay for this seat right now.</b> ${esc(can && can.reason ? can.reason : `${m.agent.name} is held in the Agents panel.`)} Until then nothing is paid under the allowance. ${go("rf3://agents", "Open Agents", "btn-secondary btn-small")}`));
  }
  if (m.stop) out.push(notice("notice-warn", `<b>Agent stopped.</b> ${esc(m.stop.text)} ${act("pay-now", "Pay by hand", "btn-secondary btn-small")}`));
  for (const l of o.late) {
    out.push(notice("notice-warn", `<b>${esc(label(l.name))} is late for round ${esc(o.round.n)}.</b> ${esc(l.hoursLeft)} hours of grace left. The grace ends on ${esc(day(l.graceEnds))}. Then the program draws ${esc(usdc(o.amount))} from that member's collateral.${l.id === viewer ? ` ${act("pay-now", "Pay by hand", "btn-secondary btn-small")}${go(`${base}/missed`, "Missed and top up", "btn-secondary btn-small")}` : ""}`));
  }
  if (top && top.pending) out.push(notice("notice-warn", `<b>${esc(top.line)}</b> ${esc(top.together)} ${go(`${base}/missed`, "Top up or leave", "btn-secondary btn-small")}`));
  for (const u of o.unclaimed) {
    out.push(u.recipient === viewer
      ? notice("su-ok", `<b>Your round ${esc(u.n)} pot of ${esc(usdc(u.pot.amount))} is ready.</b> ${esc(u.pot.line)}. ${go(`${base}/payout`, "Claim", "btn-primary btn-small")}`)
      : notice("su-info", `Waiting for ${esc(label(u.recipientName))} to claim the round ${esc(u.n)} pot of ${esc(usdc(u.pot.amount))}. ${esc(u.pot.line)}.`));
  }
  if (o.status === "complete") out.push(notice("su-info", `All ${esc(o.seats)} rounds of ${esc(o.name)} are finished. Unclaimed pots stay claimable. Remaining collateral went back to the members who stayed.`));
  return out.join("");
}
// Round strip: the round, the amount, the pot card and the your-turn card.
function strip(m) {
  const { o, pay } = m, r = o.round;
  const tile = (name, value, more = "") => `<div class="card su-tile"><small>${esc(name)}</small><b>${esc(value)}</b>${more}</div>`;
  const meter = (value, max, text) => `<progress max="${esc(max)}" value="${esc(value)}">${esc(text)}</progress><span>${esc(text)}</span>`;
  const round = r ? tile("Round", `${r.n} of ${r.of}`, `<span>due ${esc(r.dueText)}</span>${meter(r.paid, r.seats, `${r.paid} of ${r.seats} paid`)}`)
    : o.status === "forming" ? tile("Round", "Forming", meter(o.seatsFilled, o.seats, `${o.seatsFilled} of ${o.seats} seats`))
    : tile("Round", "Complete", `<span>${esc(o.seats)} of ${esc(o.seats)} rounds finished</span>`);
  const per = tile("Per round", usdc(o.amount), `<span>${esc(o.cadence)} · collateral ${esc(usdc(o.collateral))}</span>`);
  const pot = tile("Pot", usdc(o.pot), `${r ? `<span>round ${esc(r.n)} goes to ${esc(label(r.recipientName))}</span>` : ""}${o.unclaimed.map((u) => `<span class="t-warn">Round ${esc(u.n)}: ${esc(u.pot.line)}</span>`).join("")}<span>${esc(usdc(o.vault))} in the vault now</span>`);
  const turnLine = !pay ? "" : pay.state === "waiting" ? `Waiting. ${r ? `${r.paid} of ${r.seats} have paid.` : ""}` : pay.state === "not-your-turn" ? `Your pot is ${usdc(pay.amount)}.` : `${pay.line}.`;
  const turn = !pay ? tile("Your turn", "No seat", "<span>You are viewing as a visitor.</span>")
    : tile("Your turn", `Round ${pay.round} · ${day(pay.due)}`, `<span>${esc(turnLine)}</span>${pay.state === "claimable" ? go(pathOf(o.id, "payout"), "Claim", "btn-primary btn-small") : ""}`);
  return `<div class="su-strip">${round}${per}${pot}${turn}</div>`;
}
function youCard(m) {
  const { o } = m, you = o.you, r = o.round, base = pathOf(o.id);
  if (!you) return "";
  const x = you.cell, allow = you.allowance === "none" ? "off" : `${you.allowance}${you.agent ? ` (${you.agent})` : ""}`;
  const text = you.status === "invited" ? "This seat has an open invite." : you.status === "declined" ? "This seat declined its invite." : you.status === "left" ? "This seat left the circle."
    : !r ? (o.status === "forming" ? "Round 1 has not opened." : "Every round is finished.")
    : x.state === "paid" ? `Round ${r.n}: paid by ${x.by} on ${day(x.day)}. ${r.paid} of ${r.seats} have paid.`
    : x.state === "late" ? `Round ${r.n}: late. ${x.hoursLeft} hours of grace left.`
    : x.state === "due" ? `Round ${r.n}: unpaid, due ${r.dueText}.` : `Round ${r.n}: ${x.label}.`;
  const canPay = you.status === "joined" && x && (x.state === "due" || x.state === "late");
  const buttons = you.status === "invited" ? go(`${base}/join`, "Read the terms and join", "btn-primary")
    : `${canPay ? act("pay-now", "Pay now", "btn-primary") : ""}${go(`${base}/agent`, "Agent allowance")}${go(`${base}/payout`, "Payout")}${go(`${base}/history`, "History")}`;
  return `<div class="card su-you">
    <div class="su-you-text"><small>Your share · ${esc(label(you.name))} · slot ${esc(you.slot)}</small><b>${esc(text)}</b>
      <span>${esc(usdc(you.usdc))} in this seat · collateral ${esc(usdc(you.collateral))} · agent allowance ${esc(allow)}</span></div>
    <div class="row">${buttons}</div>
  </div>`;
}
function calendar(m) {
  const item = (r) => {
    const tag = r.pot.state === "paid" ? chip("chip-ok", r.pot.line) : r.pot.state === "claimable" ? chip("chip-warn", r.pot.line)
      : r.state === "open" ? chip("chip-bone", `open · grace ends ${day(r.graceEnds)}`) : chip("chip-muted", "scheduled");
    return `<li class="card su-cal-item${r.state === "open" ? " su-now" : ""}"><small>${esc(r.dueText)}</small><b>Round ${esc(r.n)}</b><span>${esc(label(r.recipientName))} takes the pot</span>${tag}</li>`;
  };
  return `<ol class="su-cal">${m.g.rounds.map(item).join("")}</ol><p class="su-foot">Today is ${esc(m.o.todayText)} on the mock clock.</p>`;
}
function members(m) {
  const { o, viewer } = m;
  const allow = { none: ["chip-muted", "off"], active: ["chip-ok", "active"], paused: ["chip-warn", "paused"], revoked: ["chip-red", "revoked"] };
  const row = (x) => {
    const [cls, text] = Object.hasOwn(allow, x.allowance) ? allow[x.allowance] : ["chip-red", "unreadable"];
    const tags = [`slot ${x.slot}`, x.id === viewer ? "you" : "", x.id === m.organizer ? "organizer, no power after creation" : "", x.status === "joined" ? "" : x.status].filter(Boolean).join(" · ");
    const wallet = x.wallet === S.MOCK_WALLET ? S.MOCK_WALLET : x.wallet ? short(x.wallet) : "none yet";
    return `<tr><th scope="row">${esc(label(x.name))}<small>${esc(tags)}</small></th>
      <td class="mono"${ADDR_RE.test(x.wallet) ? ` title="${esc(x.wallet)}"` : ""}>${esc(wallet)}</td>
      <td>${esc(usdc(x.collateral))}${x.topUpOwed !== "0" ? `<small>top-up of ${esc(x.topUpOwed)} pending</small>` : ""}</td>
      <td><span class="chip ${cls}">${esc(text)}</span>${x.agent ? `<small>${esc(x.agent)}</small>` : ""}</td>
      <td>Round ${esc(x.payoutRound)} · ${esc(day(x.payoutDue))}</td></tr>`;
  };
  return `<div class="card su-grid-card"><div class="su-scroll"><table class="su-grid"><thead><tr><th scope="col">Member</th><th scope="col">Signing wallet</th><th scope="col">Collateral</th><th scope="col">Agent allowance</th><th scope="col">Takes the pot</th></tr></thead><tbody>${o.members.map(row).join("")}</tbody></table></div></div>`;
}
function rules(m) {
  const t = m.terms.lines, base = pathOf(m.o.id);
  return `<div class="card su-block">
    ${lines([t.amount, t.pot, t.collateral, t.grace, t.missed, t.cover, t.leaveAfterPot, t.lock, t.organizer, t.vault, m.o.lines.withdraw, m.o.lines.yield])}
    <div class="row row-top">${go(`${base}/withdraw`, "Try an arbitrary withdrawal")}${go(`${base}/join`, "Terms sheet")}${go(`${base}/history`, "History")}${m.o.you && m.o.you.status === "joined" ? go(`${base}/leave`, "Leave") : ""}</div>
  </div>`;
}
const posture = (text) => `<div class="card su-block">
    <p>${esc(text)}</p>
    <p>No fee on yield in the mock. Yield is off.</p>
    <p>RobotFac3 adds the browser, agents paying under caps, a human on every signature and the audit log.</p>
    <p>No real money moves here before a security sign-off and a lawyer's view.</p>
  </div>`;
export const outLines = (list) => list.map((l) => `<div class="${OUT_CLS.includes(l.cls) ? l.cls : ""}">${esc(l.text)}</div>`).join("");
// The agent panel, shown on the dashboard in Agent mode. The agent is scripted and the chip says so.
export function agentPanel(m) {
  const { o, agent: a } = m, n = o.round ? o.round.n : 1;
  const tries = [[`Withdraw 100 USDC from ${o.name}`, "Try: withdraw from the vault"], [`Pay round ${n} of ${o.name}`, `Try: pay round ${n}`], ["What is due?", "Try: what is due"], ["Who is next?", "Try: who is next"]];
  return `<div class="card agent su-agent">
    <div class="agent-head">
      <span class="agent-avatar" role="img" aria-label="${esc(a.name)}">${a.name === "Scout" ? "🤖" : esc(a.name.slice(0, 1))}</span>
      <div class="agent-id">
        <div class="agent-name">${esc(a.name)} <span class="dot ${a.can.ok ? "dot-active" : "dot-paused"}"></span></div>
        <div class="agent-wallet">One instruction: contribute. Fixed vault, exact amount, open round, after the pre-notice.</div>
      </div>
      ${chip("chip-warn", "scripted demo")}
    </div>
    <p class="su-say">${esc(m.say)}</p>
    ${a.can.ok ? "" : notice("notice-warn", esc(a.can.reason))}
    <form id="suAgentForm">
      <input id="suAgentTask" class="input input-grow" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Circle task for ${esc(a.name)}" value="${esc(a.task)}" />
      <button class="btn btn-primary">Run</button>
    </form>
    <div class="row row-top">${tries.map(([task, text]) => `<button type="button" class="btn btn-secondary btn-small" data-task="${esc(task)}">${esc(text)}</button>`).join("")}</div>
    <div id="suAgentOut" class="agent-out">${outLines(a.out)}</div>
  </div>`;
}

// ---------- Dashboard ----------
// Everything the dashboard draws, read from the engine for one viewing seat. ui: { viewer, mode, wallet, flash, agent, mock }.
export function dashModel(circle, ui = {}) {
  const viewer = typeof ui.viewer === "string" ? ui.viewer : "", o = S.overview(circle, viewer), seat = Boolean(o.you);
  return {
    viewer, o, g: S.grid(circle), terms: S.termsSheet(circle), organizer: circle.organizer, start: circle.start,
    mode: ui.mode === "agent" ? "agent" : "human", wallet: ui.wallet || null,
    pre: S.preNotice(circle, viewer), top: seat ? S.topUpStatus(circle, viewer) : null, pay: seat ? S.payoutSheet(circle, viewer) : null,
    stand: standing(circle, viewer, ui.wallet || null), stop: stopRow(circle, viewer), say: S.describe(circle, viewer),
    flash: ui.flash || null, mock: ui.mock || {},
    agent: ui.agent || { name: "Agent", can: { ok: true, reason: "" }, task: `Pay round ${o.round ? o.round.n : 1} of ${o.name}`, out: [] },
  };
}
export function dashboard(m) {
  const { o } = m;
  const status = o.status === "forming" ? chip("chip-warn", `forming · ${o.seatsFilled} of ${o.seats} seats`) : o.status === "complete" ? chip("chip-muted", "complete") : chip("chip-ok", `round ${o.round.n} of ${o.round.of}`);
  return `<section class="page su">
    ${head(o.name, status)}
    <p class="lede">A rotating circle on a program-controlled pool. Each member pays ${esc(usdc(o.amount))} every ${o.cadence === "weekly" ? "week" : "month"} and one member takes the pot each round. The circle program is not written yet. This page plays it from a script.</p>
    ${mockBox(m)}
    ${banners(m)}
    ${strip(m)}
    ${m.mode === "agent" ? agentPanel(m) : ""}
    ${youCard(m)}
    <h3 class="section-title">Payments</h3>
    ${gridTable(m.g, m.viewer)}
    <p class="su-foot">Fixed order. ${esc(o.graceHours)} hours of grace, then the program draws from collateral and pays the pot in full. Nobody holds a key to the vault. Money leaves only as a round's payout or as collateral returned at close.</p>
    <h3 class="section-title">Calendar</h3>
    ${calendar(m)}
    <h3 class="section-title">Members</h3>
    ${members(m)}
    <h3 class="section-title">Rules</h3>
    ${rules(m)}
    <h3 class="section-title">Posture</h3>
    ${posture(o.lines.posture)}
  </section>`;
}

// ---------- Circle pages ----------
// m: { id, name, j: joinSheet or null, status: joinStatus, invited, wallet, look, flash }.
export function joinPage(m) {
  const { id, name, j, status, wallet, look } = m;
  if (!j) return frame(`Join ${name}`, `${flashOf(m)}${notice("su-info", "A visitor has no invite. Pick a seat under Viewing as in the mock controls on the circle page.")}${backRow(id)}`);
  const agent = status.state === "agent";
  const matched = !look || (look.state === "resolved" && look.target === wallet);
  const notes = [["notice-warn", AGENT_RULE]];
  if (agent || !["valid", "no-wallet", "member"].includes(status.state)) notes.push(["notice-red", status.reason]);
  else if (status.state === "member") notes.push(["su-info", status.reason]);
  if (look && look.state === "looking") notes.push(["su-info", `Checking that ${j.member} belongs to this wallet.`]);
  if (look && look.state === "refused") notes.push(["notice-red", `RobotFac3 could not check ${j.member}. ${look.reason} Join and Decline stay off.`]);
  if (look && look.state === "resolved") notes.push(matched ? ["su-info", `${j.member} resolves to this wallet.`] : ["notice-red", `This wallet differs from the invited name. ${j.member} resolves to ${short(look.target)}.`]);
  const rows = [
    ["Per round", `${usdc(j.amount)}, ${j.cadence}, ${plural(j.of, "round")}`], ["Your slot", `${j.slot} of ${j.of}, payout ${j.payoutText}`], ["Pot", usdc(j.pot)],
    ["Collateral", `${usdc(j.collateral)}, posted at join, returned at close`], ["If you miss", `${S.GRACE_HOURS} hours of grace, then the program draws from your collateral`],
    ["Payout wallet", wallet || "the wallet you join with"], ["This seat holds", `${usdc(j.usdc)} (mock balance)`],
  ];
  if (m.invited) rows.push(["Invite closes", day(j.inviteExpires)]);
  const slots = `<ol class="su-slots">${j.slots.map((s) => `<li${s.slot === j.slot ? ' class="su-now"' : ""}>${esc(label(s.member))} takes the pot on ${esc(s.dueText)}</li>`).join("")}</ol>`;
  // A decline closes the seat for good. It is on only for the wallet the seat was offered to: connected, matched
  // to the invited name, and past the engine's own checks. A seat short of the collateral can still say no.
  const mayDecline = m.invited && Boolean(wallet) && matched && (status.state === "valid" || status.state === "short");
  return frame(`Join ${name}`, `${flashOf(m)}${inline(sheet({
    lead: m.invited ? "You're joining" : "Your terms", kind: "unusual", title: `Join ${j.circle}`, rows, extra: slots,
    list: [j.lines.collateral, j.lines.missed, j.lines.cover, j.lines.leaveAfterPot, j.lines.lock, j.lines.account, j.lines.wallet],
    notes, demo: !wallet,
    actions: `${act("decline", "Decline", "btn-secondary", mayDecline ? "" : " disabled")}${mockBtn("join", "Join and sign", Boolean(wallet) && (agent || (status.state === "valid" && matched)))}`,
  }))}${backRow(id, status.state === "member" ? go(pathOf(id, "agent"), "Agent allowance") : "")}`);
}
const allowRows = (a) => [
  ["Enforced by", a.enforcer], ["Can pay", `${a.destination} only`], ["Amount", `${usdc(a.perRound)} per round, one payment per round`],
  ["Before each", "a notice one day ahead: OK, Pause, or Pay by hand now"], ["Revoke", "any time, one signed step"],
  ["Approved total", `${usdc(a.approvedTotal)} for ${plural(a.roundsLeft, "round")} left`],
];
// The confirm sheet for turning the allowance on. It carries the exception sentence word for word.
export const allowSheet = (a, agentName, wallet) => sheet({
  lead: a.state === "revoked" ? "Allowance revoked" : "Allowance off", kind: "unusual", title: `Let ${agentName} pay your share`, rows: allowRows(a),
  list: [a.lines.revoke, a.lines.cap], notes: [["notice-warn", a.lines.exception]], demo: !wallet,
  actions: `<button type="button" class="btn btn-secondary" data-close>Not now</button><button type="button" id="suConfirm" class="btn btn-primary"${wallet ? "" : " disabled"}>Confirm allowance (mock)</button>`,
});
export const revokeSheet = (a, wallet) => sheet({
  lead: "You're revoking", kind: "unusual", title: "Revoke the program's allowance", rows: [["Circle", a.circle], ["Enforced by", a.enforcer], ["After this", "the agent pays nothing for this circle"]],
  list: ["Rounds still fall due. You pay them by hand.", "You can set the allowance again later."], demo: !wallet,
  actions: `<button type="button" class="btn btn-secondary" data-close>Keep it</button><button type="button" id="suConfirm" class="btn btn-primary"${wallet ? "" : " disabled"}>Revoke (mock)</button>`,
});
// m: { id, name, a: allowanceSheet or null, joined, mode, wallet, agentName, flash }.
export function allowancePage(m) {
  const { id, a } = m;
  if (!a || !m.joined) return frame("Agent allowance", `${flashOf(m)}${notice("su-info", esc(a ? `${a.member} has not joined ${m.name}. Only a member sets an allowance.` : "A visitor has no seat, so there is no allowance to set."))}${backRow(id)}`);
  const states = {
    none: ["chip-muted", "allowance off", "Off by default. Turning it on opens a confirm sheet and takes one signature."],
    active: ["chip-ok", "allowance active", "On. The agent pays this seat's share each round, a day after the notice."],
    paused: ["chip-warn", "allowance paused", "Paused. The agent pays nothing until you resume it."],
    revoked: ["chip-red", "allowance revoked", "Revoked. The agent pays nothing for this circle."],
  };
  const state = Object.hasOwn(states, a.state) ? states[a.state] : ["chip-red", "unreadable", ""];
  // A standing allowance belongs to the agent it was set for. Turning one on sets it for the agent acting now.
  const payer = (a.state === "active" || a.state === "paused") && a.agent ? a.agent : m.agentName;
  const buttons = a.state === "active" ? `${act("allow-pause", "Pause the agent", "btn-primary")}${act("allow-revoke", "Revoke")}`
    : a.state === "paused" ? `${act("allow-resume", "Resume the agent", "btn-primary")}${act("allow-revoke", "Revoke")}`
    : act("allow-on", "Turn on the allowance", "btn-primary");
  const warns = [
    m.mode === "agent" ? notice("notice-red", "Only a person sets, pauses or revokes an allowance. Switch to You.") : "",
    a.usdcShort ? notice("notice-warn", esc(`USDC is short for the next round. ${a.member} holds ${usdc(a.usdc)} and a round needs ${usdc(a.perRound)}. The agent will stop and ask you to pay by hand.`)) : "",
    a.feeShort ? notice("notice-warn", esc(`The agent's fee balance is short: ${a.feeSol} SOL of the ${S.AGENT_FEE_SOL} SOL one contribution needs. The agent will stop and ask you to pay by hand.`)) : "",
    m.wallet ? "" : notice("su-info", "No wallet connected. You can read this page. Turning the allowance on or revoking it needs Phantom."),
  ].join("");
  return frame("Agent allowance", `${flashOf(m)}${warns}<div class="card su-block">
      <div class="row"><span class="chip ${state[0]}">${esc(state[1])}</span>${a.agent ? chip("", a.agent) : ""}</div>
      <h3 class="su-h">Let ${esc(payer)} pay your share of ${esc(a.circle)}</h3>
      <p>${esc(state[2])}</p>
      ${facts([...allowRows(a), ["This seat holds", `${usdc(a.usdc)} (mock balance)`], ["Agent fee balance", `${a.feeSol} SOL (mock balance)`]])}
      ${notice("notice-warn", esc(a.lines.exception))}
      ${lines([a.lines.notice, a.lines.revoke, a.lines.cap])}
      <div class="row row-top">${buttons}</div>
    </div>${backRow(id)}`);
}
// m: { id, refusal: { by, agent, seat, asked, reason } or null, flash }.
export function withdrawPage(m) {
  const x = m.refusal;
  if (!x) return frame("Withdrawal", `${flashOf(m)}${notice("su-info", "No withdrawal was tried.")}${backRow(m.id, act("withdraw-again", "Try an arbitrary withdrawal"))}`);
  const by = x.by === "agent" ? `${x.agent}, an agent${x.seat ? `, for ${x.seat}` : ""}` : x.by === "organizer" ? `you, the organizer${x.seat ? ` (${x.seat})` : ""}` : `you${x.seat ? ` (${x.seat})` : ""}`;
  return frame("Withdrawal refused", `${flashOf(m)}
    ${notice("notice-red", "<b>Refused.</b> The circle program has no withdraw instruction and no admin key. Nothing moved.")}
    <div class="card su-block">${facts([["Tried by", by], ["Asked for", x.asked], ["Money leaves as", "a round's payout, or collateral returned at close"], ["Program says", x.reason]])}</div>
    <p class="lede">The same refusal applies to a person, to an agent and to the organizer.</p>
    ${backRow(m.id, act("withdraw-again", "Try again"))}`);
}
// m: { id, o: overview, due: whatIsDue, mode, wallet, flash }.
export function payPage(m) {
  const { id, o, due } = m, you = o.you, r = o.round;
  if (!you || you.status !== "joined" || !r) return frame("Contribution", `${flashOf(m)}${notice("su-info", esc(due.text))}${backRow(id)}`);
  const x = you.cell, lacks = S.parseUsdc(you.usdc) < S.parseUsdc(o.amount); // exact compare in base units
  const notes = [];
  if (m.mode === "agent") notes.push(["notice-red", "Switch to You to pay by hand."]);
  if (x.state === "paid") notes.push(["su-info", `Round ${r.n} is already paid. ${x.by === "agent" ? "The agent paid" : "You paid by hand"} on ${day(x.day)}. A second contribution for the same round is refused.`]);
  else if (x.state === "late") notes.push(["notice-warn", `Late since ${r.dueText}. ${x.hoursLeft} hours of grace left. The grace ends on ${day(r.graceEnds)}.`]);
  if (x.state !== "paid" && lacks) notes.push(["notice-red", `USDC is short. This seat holds ${usdc(you.usdc)} and round ${r.n} needs ${usdc(o.amount)}.`]);
  return frame("Contribution", `${flashOf(m)}${inline(sheet({
    lead: "You're paying", kind: "routine", title: `Pay ${usdc(o.amount)} to ${o.name}`,
    rows: [["Circle", o.name], ["Round", `${r.n} of ${r.of}`], ["Amount", usdc(o.amount)], ["Destination", `${o.name} vault`], ["Source", `${you.name} · ${usdc(you.usdc)} (mock balance)`], ["Due", `${r.dueText} · grace ends ${day(r.graceEnds)}`]],
    list: ["The terms fix the amount and the destination.", "A person may pay by hand through the last day of grace."], notes, demo: !m.wallet,
    actions: `${go(pathOf(id), "Cancel")}${mockBtn("pay", "Approve", Boolean(m.wallet), ` data-round="${esc(r.n)}"`)}`,
  }))}`);
}
// m: { id, p: payoutSheet or null, mode, wallet, flash }.
export function payoutPage(m) {
  const { id, p } = m;
  if (!p) return frame("Payout", `${flashOf(m)}${notice("su-info", "A visitor has no seat, so no pot is due to this wallet.")}${backRow(id)}`);
  const cls = p.state === "claimable" ? "su-ok" : "su-info";
  const notes = [[cls, p.state === "claimable" || p.state === "claimed" ? `${p.line}.` : p.line]];
  if (m.mode === "agent") notes.push(["notice-red", "Agents never claim a pot. Switch to You."]);
  return frame("Payout", `${flashOf(m)}${inline(sheet({
    lead: "You're claiming", kind: "routine", title: `Claim the round ${p.round} pot`,
    rows: [["Circle", p.circle], ["Round", `${p.round} of ${p.of}`], ["Amount", usdc(p.amount)], ["To", p.to || "the wallet that joins this seat"], ["Round due", day(p.due)]],
    list: [p.lines.wallet, p.lines.once], notes, demo: !m.wallet,
    actions: `${go(pathOf(id), "Cancel")}${mockBtn("claim", "Claim and sign", Boolean(m.wallet) && (p.state === "claimable" || m.mode === "agent"), ` data-round="${esc(p.round)}"`)}`,
  }))}`);
}
// m: { id, o, top: topUpStatus or null, terms, drawn: [history rows], mode, wallet, flash }.
export function missedPage(m) {
  const { id, o, top } = m, you = o.you;
  const late = o.late.map((l) => `<li><b>${esc(label(l.name))}</b> is late for round ${esc(o.round.n)}. ${esc(l.hoursLeft)} hours of grace left, ending ${esc(day(l.graceEnds))}.<progress max="${esc(o.graceHours)}" value="${esc(l.hoursLeft)}">${esc(l.hoursLeft)} hours left</progress></li>`).join("");
  const drawn = m.drawn.map((h) => `<li>${esc(day(h.day))}: ${esc(h.text)}</li>`).join("");
  const body = !top || !you || you.status !== "joined" ? notice("su-info", "This view has no seat in the circle, so nothing is owed here.")
    : !top.pending ? notice("su-info", "Collateral is full. Nothing is owed.")
    : inline(sheet({
      lead: "You're topping up", kind: "unusual", title: `Top up ${usdc(top.owed)} of collateral`,
      rows: [["Circle", o.name], ["Collateral now", usdc(you.collateral)], ["Top-up", usdc(top.owed)], ["Destination", `${o.name} vault`], ["Source", `${you.name} · ${usdc(top.usdc)} (mock balance)`]],
      list: [top.line, top.together], demo: !m.wallet,
      notes: [...(top.usdcShort ? [["notice-red", `USDC is short. This seat holds ${usdc(top.usdc)} and the top-up is ${usdc(top.owed)}.`]] : []), ...(m.mode === "agent" ? [["notice-red", "Agents never top up collateral. Switch to You."]] : [])],
      actions: `${go(pathOf(id, "leave"), "Leave")}${mockBtn("top-up", `Top up ${usdc(top.owed)}`, Boolean(m.wallet))}`,
    }));
  return frame("Missed and top up", `${flashOf(m)}
    <div class="card su-block"><h3 class="su-h">In grace now</h3>${late ? `<ul class="su-lines su-plain">${late}</ul>` : "<p>Nobody is late in the open round.</p>"}
      ${you && you.cell && you.cell.state === "late" ? `<div class="row row-top">${act("pay-now", "Pay by hand", "btn-primary")}</div>` : ""}</div>
    ${drawn ? `<div class="card su-block"><h3 class="su-h">Drawn from collateral</h3><ul class="su-lines su-plain">${drawn}</ul></div>` : ""}
    ${body}
    <div class="card su-block">${lines([m.terms.lines.grace, m.terms.lines.missed, m.terms.lines.cover])}</div>${backRow(id)}`);
}
// m: { id, name, rows: history rows, flash }. No transaction links: nothing here was sent.
export function historyPage(m) {
  const rows = [...m.rows].reverse().map((h) => `<li class="su-row su-row-${S.rowLevel(h)}"><time>${esc(day(h.day))}</time><span class="chip">${esc(h.actor)}</span><b>${esc(rowTitle(h))}</b><p>${esc(h.text)}</p></li>`).join("");
  return frame(`History · ${m.name}`, `${flashOf(m)}<p class="lede">Every row the mock program and its members wrote, newest first. Nothing here was sent to a chain.</p>
    ${rows ? `<ol class="su-history">${rows}</ol>` : notice("su-info", "No rows yet.")}${backRow(m.id)}`, false);
}
// m: { id, l: leaveSheet or null, status, mode, wallet, flash }.
export function leavePage(m) {
  const { id, l } = m;
  if (!l || m.status !== "joined") return frame("Leave", `${flashOf(m)}${notice("su-info", esc(!l ? "A visitor has no seat to leave." : m.status === "left" ? `${l.member} left ${l.circle}.` : `${l.member} has not joined ${l.circle}.`))}${backRow(id)}`);
  return frame("Leave", `${flashOf(m)}${inline(sheet({
    lead: "You're leaving", kind: "unusual", title: `Leave ${l.circle}`,
    rows: [["Circle", l.circle], ["Seat", l.member], ["Collateral forfeited", usdc(l.forfeited)], ["Cost left to the circle", usdc(l.uncovered)]],
    extra: `<ol class="su-steps">${l.steps.map((s, i) => `<li>${esc(s)}${i === 0 ? " (a signed step)" : ""}</li>`).join("")}</ol>`,
    list: [l.lines.forfeit, l.lines.uncovered], demo: !m.wallet,
    notes: m.mode === "agent" ? [["notice-red", "Agents never leave a circle for a member. Switch to You."]] : [],
    actions: `${go(pathOf(id), "Stay")}${mockBtn("leave", l.label, Boolean(m.wallet), "", "btn-danger")}`,
  }))}`);
}

// ---------- Susu home, create, 404 ----------
// m: { circles: [{ id, name, line, demo }], mode, wallet, invite: { cls, text } or null, flash }.
export function homePage(m) {
  const off = m.mode === "agent" ? " disabled" : "";
  const tiles = m.circles.map((c) => `<button type="button" data-go="${esc(pathOf(c.id))}" class="card tile"><b>${esc(c.name)}</b><span>${esc(c.line)}</span><small>${c.demo ? "demo circle" : "started here"}</small></button>`).join("");
  return `<section class="page su">
    ${head("Susu circle")}
    <p class="lede">Pool with a circle. A rotating circle runs on a program-controlled pool: each member pays a fixed USDC amount each round, and one member takes the pot each round in a fixed order. The circle program is not written yet. These pages play it from a script.</p>
    ${flashOf(m)}
    ${m.wallet ? "" : notice("su-info", "No wallet connected. You can read every page. The sheets that sign stay off until you connect Phantom.")}
    ${m.mode === "agent" ? notice("notice-warn", "Agents never start or join a circle. Switch to You.") : ""}
    <h3 class="section-title">Your circles</h3>
    <div class="grid">${tiles}</div>
    <h3 class="section-title">Start or join</h3>
    <div class="card su-block">
      <div class="row"><button type="button" class="btn btn-primary" data-go="${PREFIX}/new"${off}>Start a circle</button></div>
      <form id="suInviteForm" class="su-inline-form">
        <input id="suInvite" class="input input-grow" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste an invite link, such as ${PREFIX}/family-circle/join" aria-label="Invite link"${off} />
        <button class="btn btn-secondary"${off}>Join with an invite</button>
      </form>
      <div id="suInviteOut">${m.invite ? notice(FLASH_CLS.includes(m.invite.cls) ? m.invite.cls : "su-info", esc(m.invite.text)) : ""}</div>
      <p>In the mock an invite link works in the browser that started the circle. The link carries no terms and no member list.</p>
    </div>
    <h3 class="section-title">Posture</h3>
    ${posture(m.posture)}
  </section>`;
}
// One member row of the create form as { value, name, state, text }. state: empty, address, idle, looking, resolved, refused, duplicate, invalid.
export function memberRows(values, looks = {}) {
  const names = values.map((v) => { const t = typeof v === "string" ? v.trim() : ""; return ADDR_RE.test(t) ? t : t.toLowerCase(); });
  return names.map((name, i) => {
    const value = typeof values[i] === "string" ? values[i] : "";
    if (!name) return { value, name, state: "empty", text: "" };
    if (names.indexOf(name) !== i) return { value, name, state: "duplicate", text: "listed twice" };
    if (ADDR_RE.test(name)) return { value, name, state: "address", text: "wallet address, no lookup needed" };
    if (!SNS_RE.test(name)) return { value, name, state: "invalid", text: "write a .sns name or a wallet address" };
    const x = Object.hasOwn(looks, name) ? looks[name] : null;
    if (!x) return { value, name, state: "idle", text: "not looked up yet" };
    if (x.state === "resolved") return { value, name, state: "resolved", text: `resolved to ${short(x.target)}` };
    return x.state === "looking" ? { value, name, state: "looking", text: "looking up" } : { value, name, state: "refused", text: `refused. ${x.reason}` };
  });
}
export const lookChip = (x) => (x.state === "empty" ? "" : `<span class="chip ${{ resolved: "chip-ok", address: "chip-ok", looking: "chip-muted", idle: "chip-muted" }[x.state] || "chip-red"}">${esc(x.state === "idle" ? "not checked" : x.state)}</span> ${esc(x.text)}`);
// The terms are ready for review when they validate and every member is an address or a resolved .sns name.
export const createReady = (m) => m.check.ok && m.rows.every((x) => x.state === "resolved" || x.state === "address");
// The live preview under the create form. Errors come from the engine's validateTerms.
export function termsPreview(m) {
  if (!m.check.ok) return `<div class="card su-block"><h3 class="su-h">Terms preview</h3><ul class="su-errors">${m.check.errors.map((e) => `<li>${esc(e.reason)}</li>`).join("")}</ul></div>`;
  const t = S.termsSheet(m.check.terms);
  return `<div class="card su-block"><h3 class="su-h">Terms preview</h3>
    ${facts([["Per round", `${usdc(t.amount)}, ${t.cadence}`], ["Rounds", String(t.rounds)], ["Pot", usdc(t.pot)], ["Each member pays in total", usdc(t.totalPerMember)], ["Collateral", usdc(t.collateral)], ["Grace", `${t.graceHours} hours`]])}
    <ol class="su-slots">${t.slots.map((s) => `<li>${esc(label(s.member))} takes the pot on ${esc(s.dueText)}. Grace ends ${esc(day(s.graceEnds))}.</li>`).join("")}</ol>
    ${lines([t.lines.leaveAfterPot, t.lines.organizer])}
    ${createReady(m) ? "" : notice("notice-warn", "Every .sns name must resolve before the terms can be reviewed.")}
  </div>`;
}
// m: { draft, rows, check, mode, wallet, today, flash }.
export function createPage(m) {
  const d = m.draft, off = m.mode === "agent" ? " disabled" : "", n = m.rows.length;
  const row = (x, i) => `<li class="su-member">
      <span class="mono">${i + 1}</span>
      <input class="input" data-member="${i}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder=".sns name or wallet address" aria-label="Member ${i + 1}" value="${esc(x.value)}"${off} />
      <button type="button" class="btn btn-secondary btn-small" data-act="row-up" data-i="${i}"${i === 0 || off ? " disabled" : ""}>Up</button>
      <button type="button" class="btn btn-secondary btn-small" data-act="row-down" data-i="${i}"${i === n - 1 || off ? " disabled" : ""}>Down</button>
      <button type="button" class="btn btn-secondary btn-small" data-act="row-remove" data-i="${i}"${n <= 3 || off ? " disabled" : ""}>Remove</button>
      <output class="su-look" data-look="${i}">${lookChip(x)}</output>
    </li>`;
  const pick = (v, text) => `<option value="${v}"${d.cadence === v ? " selected" : ""}>${text}</option>`;
  return frame("Start a circle", `${flashOf(m)}
    ${m.mode === "agent" ? notice("notice-red", "Agents never start a circle. Switch to You.") : ""}
    ${m.wallet ? "" : notice("su-info", "No wallet connected. You can fill the form. Creating the circle needs Phantom.")}
    <form id="suCreate" class="card su-form">
      <label for="suName">Circle name</label>
      <input id="suName" class="input" autocomplete="off" spellcheck="false" value="${esc(d.name)}"${off} />
      <label for="suAmount">USDC per round</label>
      <input id="suAmount" class="input input-narrow" inputmode="decimal" autocomplete="off" value="${esc(d.amount)}"${off} />
      <label for="suCadence">Cadence</label>
      <select id="suCadence"${off}>${pick("weekly", "weekly")}${pick("monthly", "monthly")}</select>
      <label for="suStart">Start date (after ${esc(day(m.today))} on the mock clock)</label>
      <input id="suStart" type="date" class="input input-narrow" value="${esc(d.start)}"${off} />
      <label>Members, in payout order</label>
      <p class="su-foot">The order is fixed. The first member takes the first pot. Use Up and Down.</p>
      <ol class="su-member-list">${m.rows.map(row).join("")}</ol>
      <div class="row">
        <button type="button" class="btn btn-secondary btn-small" data-act="row-add"${n >= 12 || off ? " disabled" : ""}>Add a member</button>
        <button type="button" class="btn btn-secondary btn-small" data-act="row-mine"${!m.wallet || off ? " disabled" : ""}>Add my wallet</button>
        <button type="button" class="btn btn-secondary btn-small" data-act="row-check"${off}>Look up the names</button>
      </div>
      <div class="row row-top"><button class="btn btn-primary"${off}>Review the terms</button>${go(PREFIX, "Cancel")}</div>
    </form>
    <div id="suPreview">${termsPreview(m)}</div>`);
}
// The organizer terms sheet. m: { terms, mode, wallet, flash }. terms is null when nothing was reviewed.
export function reviewPage(m) {
  if (!m.terms) return frame("Review the terms", `${flashOf(m)}${notice("su-info", `Nothing to review yet. Start at ${PREFIX}/new.`)}<div class="row row-top">${go(`${PREFIX}/new`, "Start a circle")}</div>`);
  const t = S.termsSheet(m.terms), l = t.lines;
  const slots = `<ol class="su-slots">${t.slots.map((s) => `<li>Slot ${esc(s.slot)}: ${esc(label(s.member))} takes the pot on ${esc(s.dueText)}. Grace ends ${esc(day(s.graceEnds))}.</li>`).join("")}</ol>`;
  const notes = [["notice-warn", "You sign once. After that signature the organizer has no power over this circle."]];
  if (m.mode === "agent") notes.push(["notice-red", "Agents never start a circle. Switch to You."]);
  return frame("Review the terms", `${flashOf(m)}${inline(sheet({
    lead: "You're creating", kind: "unusual", title: `Create ${t.name}`,
    rows: [["Per round", `${usdc(t.amount)}, ${t.cadence}`], ["Seats and rounds", String(t.seats)], ["Starts", day(t.start)], ["Pot", usdc(t.pot)], ["Each member pays in total", usdc(t.totalPerMember)], ["Collateral", `${usdc(t.collateral)} per member`], ["Grace", `${t.graceHours} hours`], ["Order", "fixed"]],
    extra: slots, list: [l.amount, l.pot, l.collateral, l.grace, l.missed, l.cover, l.leaveAfterPot, l.lock, l.organizer, l.account, l.wallet, l.vault], notes, demo: !m.wallet,
    actions: `${act("create-cancel", "Cancel")}${mockBtn("create", "Create and sign", Boolean(m.wallet))}`,
  }))}`);
}
export const lostPage = (page, known = []) => frame("No such susu page", `
    ${notice("notice-red", `RobotFac3 has no susu page at <span class="mono break">${esc(page)}</span>.`)}
    <p class="lede">The susu pages are ${PREFIX}, ${PREFIX}/new and each circle's own pages: join, agent, pay, payout, missed, history, leave and withdraw.</p>
    <div class="row row-top">${go(PREFIX, "Susu home")}${known.map((c) => go(pathOf(c.id), c.name)).join("")}</div>`);
export const missingPage = (reason) => frame("Susu circle", `
    ${notice("notice-red", `<b>The demo circle is missing.</b> RobotFac3 could not read ${FIXTURE_URL}, or the file failed its shape check. ${esc(reason)}`)}
    <p class="lede">Nothing is drawn from a fixture that fails its checks. Start the relay from the repo folder and open this page again.</p>`);
const brokenPage = (reason) => frame("Susu circle", `
    ${notice("notice-red", `<b>This circle's state failed its checks.</b> ${esc(reason)}`)}
    <p class="lede">Nothing is drawn from state that fails its checks. Reset the demo to start again from the fixture.</p>
    <div class="row row-top">${act("reset", "Reset demo")}${go(PREFIX, "Susu home")}</div>`);
const nextFirst = (today) => { const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7)); return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`; };

// ---------- The area ----------
// main.js calls this once. ctx is everything this area gets from the UI. It holds no signing call and no RPC call.
export function mountSusu(ctx) {
  const st = {
    boot: null, ready: false, missing: "", fixtureText: "", circles: [], storage: "ok", note: "",
    viewer: {}, // circle id -> the "Viewing as" seat. One browser plays every member.
    out: {}, task: {}, // circle id -> the agent panel's lines and the text in its task box
    refusal: {}, // circle id -> the last refused withdrawal, for rf3://susu/<id>/withdraw
    flash: null, invite: null, draft: null, looks: {}, joinLook: {}, busy: false,
  };
  const view = () => ctx.$("view");
  const circleOf = (id) => st.circles.find((c) => c.id === id) || null;
  const others = (c) => st.circles.filter((x) => x.id !== c.id);
  const clock = () => st.circles[0].today; // a new circle starts on the demo circle's mock day
  const viewerOf = (c) => (typeof st.viewer[c.id] === "string" ? st.viewer[c.id] : c.members.some((m) => m.id === "you") ? "you" : c.organizer || c.members[0].id);
  // Who is acting, as the engine wants it. The engine checks the human-only rules itself from this.
  const who = (c) => ({ mode: ctx.state.mode, wallet: ctx.state.wallet || null, memberId: viewerOf(c), agentName: ctx.agent.name() });
  const agentActor = () => String(ctx.agent.name()).toUpperCase();
  const refuse = (text) => { st.flash = { cls: "notice-red", text }; };

  // The fixture is fetched once from this app's own files. The engine shape-checks it before anything is drawn.
  function load() {
    st.boot ??= (async () => {
      const res = await fetch(FIXTURE_URL);
      if (!res.ok) throw new Error(`The file answered ${res.status}.`);
      const text = await res.text();
      let raw = null;
      try { raw = localStorage.getItem(STORE_KEY); } catch { st.storage = "unavailable"; }
      const opened = openStore(raw, text);
      Object.assign(st, { fixtureText: text, circles: opened.circles, note: opened.note, ready: true, missing: "" });
    })().catch((e) => { st.boot = null; st.ready = false; st.missing = e && e.message ? e.message : "The file could not be read."; });
    return st.boot;
  }
  function save() {
    const text = packStore(st.circles); // the engine checks each circle's shape again as it serializes
    try { localStorage.setItem(STORE_KEY, text); st.storage = "ok"; } catch { st.storage = "unavailable"; }
  }
  function put(c) {
    const i = st.circles.findIndex((x) => x.id === c.id);
    if (i >= 0) st.circles[i] = c; else st.circles.push(c);
    save();
  }
  // Every engine result lands here. A refusal is kept too, because it carries the block row. Each row goes to the
  // security log with the engine's own actor: YOU, the agent's name, PROGRAM or a mock member's name.
  function commit(r, refusal = "") {
    if (r.circle) put(r.circle);
    for (const row of r.rows) ctx.log(S.rowLevel(row), rowTitle(row, refusal), row.text, row.actor);
    return r;
  }
  // One press, one engine call. The page shows the reason for a refusal and says when something was done.
  function press(r, refusal, done = "") {
    // Every press is a human-only action, and the engine refuses each one in Agent mode. A result that says
    // otherwise is thrown away before it can be kept.
    if (ctx.state.mode !== "human" && r.ok !== false) throw new Error("A human-only action was not refused in Agent mode. Nothing was kept.");
    commit(r, refusal);
    st.flash = r.ok ? (done ? { cls: "su-ok", text: done } : null) : { cls: r.verdict === "stopped" ? "notice-warn" : "notice-red", text: r.reason };
    return r;
  }

  // ---------- Agent ----------
  function tell(id, text, cls = "") {
    st.out[id] = [...(st.out[id] || []), { text, cls }].slice(-12);
    const box = ctx.$("suAgentOut");
    if (box) box.innerHTML = outLines(st.out[id]);
    ctx.agent.say(text, cls);
  }
  // A row for the agent's own timeline. A failure there must never undo or hide what the circle already recorded.
  function timeline(tool, summary, outcome) {
    try { ctx.agent.record({ tool, summary, outcome }); } catch (e) { ctx.log("warn", "Agent timeline row not recorded", e.message, "YOU"); }
  }
  // The withdrawal attempt, for a person, the organizer or the agent. The engine refuses every one of them.
  function tryWithdraw(c, asked = "") {
    const w = who(c), agent = w.mode === "agent";
    if (agent) {
      const can = ctx.agent.canAct();
      if (!can.ok) { st.refusal[c.id] = null; st.flash = { cls: "notice-warn", text: `${can.reason} Nothing ran.` }; return null; }
    }
    const o = S.overview(c, w.memberId), r = S.withdraw(c, w);
    // Fail closed: a result that is anything but a refusal is thrown away before it can be kept.
    if (r.ok !== false) throw new Error("The withdrawal was not refused. Nothing was kept.");
    commit(r, "Withdrawal refused");
    st.refusal[c.id] = {
      by: agent ? "agent" : w.memberId !== "" && w.memberId === c.organizer ? "organizer" : "you", agent: ctx.agent.name(), seat: o.you ? o.you.name : "",
      asked: asked || `${usdc(o.vault)}, the whole vault${w.wallet ? `, to ${short(w.wallet)}` : ""}`, reason: r.reason,
    };
    return r;
  }
  // The scripted agent's circle task. It runs only when canAct says yes, and only after the leak check passed.
  // Grammar and policy are the engine's. Anything that is not the one contribute sentence or a read-only question
  // is refused. Nothing is guessed.
  function agentTask(c, task) {
    const w = who(c), name = ctx.agent.name(), actor = agentActor(), id = c.id;
    st.out[id] = [];
    const say = (text, cls = "") => tell(id, text, cls);
    const can = ctx.agent.canAct();
    if (!can.ok) {
      ctx.log("info", `${name} did not run`, can.reason, "YOU");
      return say(`${can.reason} Nothing ran.`, "t-warn");
    }
    ctx.log("info", "Agent task", task, actor);
    const q = S.parseCircleQuestion(task);
    if (q.kind !== "none") {
      // Answers come from circle state only. Page text and invite text never feed them.
      say(q.kind === "due" ? S.whatIsDue(c, w.memberId).text : S.whoIsNext(c).text, "t-bone");
      return timeline("rf3.read_page", q.kind === "due" ? `What is due in ${c.name}` : `Who is next in ${c.name}`, "answered");
    }
    const p = S.parseCircleInstruction(task, c);
    const open = c.rounds.find((x) => x.state === "open");
    if (p.kind === "none") {
      // This area has no path to the SOL grammar, so a task that is not about the circle runs nothing here.
      return say(`That is outside ${c.name}. Here I answer "What is due?" and "Who is next?", and I pay the open round when you write: Pay round ${open ? open.n : 1} of ${c.name}`, "t-warn");
    }
    if (p.kind === "unclear") {
      ctx.log("warn", "Agent could not read that circle instruction", task, actor);
      say(`I could not read that as one exact instruction, so I did nothing. Write it like: Pay round ${open ? open.n : 1} of ${c.name}`, "t-warn");
      return timeline("circle instruction", "An instruction that fits no shape", "refused");
    }
    if (p.kind === "refused") {
      const calls = {
        join: () => S.join(c, w, { accept: true, otherCircles: others(c) }), accept: () => S.acceptTerms(c, w, { otherCircles: others(c) }),
        allowance: () => S.setAllowance(c, w), order: () => S.changeTerms(c, w), terms: () => S.changeTerms(c, w), claim: () => S.claimPayout(c, w),
      };
      if (p.ask === "withdraw") tryWithdraw(c, task);
      else if (Object.hasOwn(calls, p.ask)) {
        const r = calls[p.ask]();
        if (r.ok !== false) throw new Error("An instruction that must be refused was not refused. Nothing was kept.");
        commit(r, "Agent instruction refused");
      } else ctx.log("block", "Agent instruction refused", p.reason, actor);
      say(`Circle program: BLOCKED. ${p.reason}`, "t-red");
      return timeline("circle instruction", `${p.ask} asked for ${c.name}`, "blocked");
    }
    const req = { circle: c.id, round: p.round, amount: c.amount };
    say(`Checking the policy: ${c.name}, round ${p.round}, ${usdc(c.amount)}, into the vault.`);
    const v = S.checkContribute(c, w, req), r = S.agentContribute(c, w, req); // the engine runs the policy again itself
    if (r.ok !== (v.verdict === "allow")) throw new Error("The policy check and the engine disagree. Nothing was kept.");
    commit(r, "Contribution refused");
    if (r.ok) {
      say(`Circle program: PAID. ${usdc(r.amount)} to ${c.name} for round ${r.round}.`, "t-ok");
      say(`The grid cell for round ${r.round} now reads paid by agent.`);
      return timeline("rf3.contribute_circle", `Paid ${usdc(r.amount)} to ${c.name}, round ${r.round}`, "paid");
    }
    say(r.verdict === "stopped" ? `Stopped. ${r.reason}` : `Circle program: REFUSED. ${r.reason}`, r.verdict === "stopped" ? "t-warn" : "t-red");
    return timeline("rf3.contribute_circle", `Round ${p.round} of ${c.name}: ${r.reason}`, r.verdict);
  }
  async function runAgent(id, text) {
    const page = ctx.state.page, task = String(text ?? "").trim();
    if (!task || st.busy) return;
    st.busy = true;
    try {
      const clean = await ctx.passesLeakCheck(task, "circle task box");
      const c = circleOf(id);
      if (!clean) st.task[id] = ""; // blocked text does not stay in the box
      else if (c && ctx.state.page === page && ctx.state.mode === "agent") agentTask(c, task); // otherwise the person moved on or took over
    } catch (e) {
      ctx.log("warn", "Agent task stopped", e.message, agentActor());
      tell(id, `Stopped. ${e.message}`, "t-red");
    } finally { st.busy = false; }
    if (ctx.state.page === page) draw(page, true);
  }

  // ---------- Create form ----------
  const createModel = () => {
    st.draft ??= { name: "", amount: "50", cadence: "monthly", start: nextFirst(clock()), members: ["", "", ""], terms: null };
    const d = st.draft, rows = memberRows(d.members, st.looks);
    const check = S.validateTerms({ name: d.name, amount: d.amount, cadence: d.cadence, seats: d.members.length, start: d.start, order: "fixed", members: d.members }, clock());
    return { draft: d, rows, check, mode: ctx.state.mode, wallet: ctx.state.wallet || null, today: clock(), flash: st.flash };
  };
  function readDraft() {
    if (!ctx.$("suCreate") || !st.draft) return;
    Object.assign(st.draft, { name: ctx.$("suName").value, amount: ctx.$("suAmount").value, cadence: ctx.$("suCadence").value, start: ctx.$("suStart").value });
    st.draft.members = [...view().querySelectorAll("[data-member]")].map((el) => el.value);
  }
  // Redraws the preview and each row's lookup state in place, so typing keeps its focus.
  function paintCreate() {
    if (ctx.state.page !== `${PREFIX}/new`) return; // the person moved on while a lookup ran
    const m = createModel(), box = ctx.$("suPreview");
    if (box) box.innerHTML = termsPreview(m);
    view().querySelectorAll("[data-look]").forEach((el) => { const x = m.rows[Number(el.dataset.look)]; el.innerHTML = x ? lookChip(x) : ""; });
  }
  // A member name resolves through the app's SNS resolver, read-only. A failed or odd answer leaves the row refused.
  async function look(name) {
    const have = st.looks[name];
    if (have && (have.state === "looking" || have.state === "resolved")) return;
    st.looks[name] = { state: "looking" };
    paintCreate();
    try {
      const info = await ctx.resolveName(name);
      if (!info || !ADDR_RE.test(info.target)) throw new Error("The resolver sent an address RobotFac3 cannot read.");
      st.looks[name] = { state: "resolved", target: info.target };
    } catch (e) { st.looks[name] = { state: "refused", reason: e && e.message ? e.message : "The lookup failed." }; }
    paintCreate();
  }
  async function checkField(el, lookup) {
    const page = ctx.state.page, text = String(el.value ?? "").trim();
    if (!text) return;
    if (!(await ctx.passesLeakCheck(text, "circle form"))) { if (el.isConnected) el.value = ""; }
    if (ctx.state.page !== page) return;
    readDraft();
    paintCreate();
    const name = String(el.value ?? "").trim().toLowerCase();
    if (lookup && SNS_RE.test(name)) look(name);
  }

  // ---------- Presses ----------
  function reset() {
    Object.assign(st, { circles: [S.loadFixture(st.fixtureText)], viewer: {}, out: {}, task: {}, refusal: {}, note: "", draft: null, looks: {}, joinLook: {}, invite: null });
    try { localStorage.removeItem(STORE_KEY); st.storage = "ok"; } catch { st.storage = "unavailable"; }
    ctx.log("info", "Demo reset", "The demo circle is back at its fixture day. Circles started here are gone.", "YOU");
  }
  // A confirm sheet in the modal. The engine checks who is acting again when the button is pressed.
  function confirmSheet(html, id, call, refusal, done) {
    ctx.openModal(html);
    ctx.$("suConfirm")?.addEventListener("click", () => {
      const page = ctx.state.page, c = circleOf(id);
      ctx.closeModal();
      if (!c) return;
      try { press(call(c), refusal, done); } catch (e) { refuse(e.message); }
      if (ctx.state.page === page) draw(page, true);
    });
  }
  const moveRow = (i, step) => { readDraft(); const list = st.draft.members, j = i + step; if (Number.isInteger(i) && list[i] !== undefined && list[j] !== undefined) [list[i], list[j]] = [list[j], list[i]]; };
  // A seat offered to a .sns name is held for the wallet that name resolves to. The engine cannot resolve names,
  // so the page does. Join and Decline both stay off until the answer matches the wallet connected at the press.
  const unmatched = (m, w) => {
    if (w.mode !== "human" || !m || m.status !== "invited" || !SNS_RE.test(m.name)) return false;
    const x = st.joinLook[`${m.name}|${w.wallet}`];
    return !x || x.state !== "resolved" || x.target !== w.wallet;
  };
  const acts = {
    "next-day": ({ c }) => {
      // The clock pays under the agent's name only while the Agents engine lets that agent act. The engine writes
      // a stop row for a held agent. Anything but a plain yes from canAct counts as held.
      const can = ctx.agent.canAct();
      const r = press(S.nextDay(c, { ...who(c), agentHeld: !(can && can.ok === true) }), "Mock clock refused");
      if (r.ok) st.flash = { cls: "su-info", text: `Today is ${day(r.day)} on the mock clock. ${r.rows.length ? `${plural(r.rows.length, "new row")} in the security log.` : "Nothing happened overnight."}` };
    },
    reset: ({ c, r }) => {
      if (ctx.state.mode !== "human") return refuse("Only a person resets the demo. Switch to You.");
      reset();
      if (r.kind === "circle" && c && !circleOf(c.id)) ctx.navigate(PREFIX);
    },
    "view-as": ({ c, el }) => {
      if (ctx.state.mode !== "human") return refuse("Only a person changes the viewing seat. Switch to You.");
      const seat = el.value === "" ? null : c.members.find((m) => m.id === el.value);
      if (el.value !== "" && !seat) return refuse("That seat is not part of this circle.");
      st.viewer[c.id] = seat ? seat.id : "";
      ctx.log("info", "Viewing as", seat ? `${seat.name} in ${c.name}` : `a visitor to ${c.name}`, "YOU");
    },
    "notice-ok": ({ c }) => { press(S.answerPreNotice(c, who(c), "ok"), "Pre-notice answer refused"); },
    "notice-pause": ({ c }) => { press(S.answerPreNotice(c, who(c), "pause"), "Pre-notice answer refused"); },
    // In Agent mode "Pay now" is refused on the spot with the engine's reason. A person goes to the contribution sheet.
    "pay-now": ({ c }) => (ctx.state.mode === "agent" ? void press(S.payByHand(c, who(c)), "Pay by hand refused") : ctx.navigate(pathOf(c.id, "pay"))),
    pay: ({ c, el }) => {
      const w = who(c), round = Number(el.dataset.round), n = S.preNotice(c, w.memberId), m = c.members.find((x) => x.id === w.memberId);
      // Paying by hand while a pre-notice waits is the "Pay by hand now" answer, so the engine records it as the answer.
      const answers = w.mode === "human" && Boolean(n) && n.kind === "agent" && n.answer === null && n.round === round && Boolean(m) && m.allowance.state === "active";
      press(answers ? S.answerPreNotice(c, w, "hand") : S.payByHand(c, w, { round }), "Pay by hand refused", `Paid ${usdc(c.amount)} by hand for round ${round} of ${c.seats}. This is a mock receipt. Nothing was sent.`);
    },
    claim: ({ c, el }) => { const r = press(S.claimPayout(c, who(c), { round: Number(el.dataset.round) }), "Claim refused"); if (r.ok) st.flash = { cls: "su-ok", text: `Claimed ${usdc(r.amount)} for round ${r.round}. It went to ${r.to === S.MOCK_WALLET ? "this seat's mock wallet" : short(r.to)}. This is a mock receipt. Nothing was sent.` }; },
    "top-up": ({ c }) => { const r = press(S.topUp(c, who(c)), "Top-up refused"); if (r.ok) st.flash = { cls: "su-ok", text: `Topped up ${usdc(r.amount)} of collateral. This is a mock receipt. Nothing was sent.` }; },
    leave: ({ c }) => { const r = press(S.leave(c, who(c)), "Leave refused"); if (r.ok) st.flash = { cls: "su-ok", text: `Left ${c.name}. ${r.forfeited === "0" ? "No collateral was forfeited." : `Forfeited ${usdc(r.forfeited)} of collateral.`} The program's allowance is revoked.` }; },
    join: ({ c }) => {
      const w = who(c), m = c.members.find((x) => x.id === w.memberId);
      if (unmatched(m, w)) return refuse(`RobotFac3 has not matched ${m.name} to this wallet. Join stays off.`);
      const r = press(S.join(c, w, { accept: true, otherCircles: others(c) }), "Join refused");
      if (r.ok) st.flash = { cls: "su-ok", text: `Joined ${c.name} at slot ${r.slot} of ${c.seats}. The pot goes to ${short(r.payoutTo)}. This is a mock signature. Nothing was sent.` };
    },
    // A declined seat cannot be joined again, so a decline gets the same seat match as a join.
    decline: ({ c }) => {
      const w = who(c), m = c.members.find((x) => x.id === w.memberId);
      if (unmatched(m, w)) return refuse(`RobotFac3 has not matched ${m.name} to this wallet. Decline stays off.`);
      press(S.decline(c, w), "Decline refused", `Declined the invite to ${c.name}.`);
    },
    "allow-on": ({ c }) => {
      if (ctx.state.mode === "agent") return void press(S.setAllowance(c, who(c)), "Allowance refused");
      confirmSheet(allowSheet(S.allowanceSheet(c, viewerOf(c)), ctx.agent.name(), ctx.state.wallet), c.id, (x) => S.setAllowance(x, who(x)), "Allowance refused", `Allowance set. The circle program may pull ${usdc(c.amount)} per round into ${c.name}'s vault. This is a mock signature.`);
    },
    "allow-pause": ({ c }) => { press(S.pauseAllowance(c, who(c)), "Allowance refused", "Agent paused. It pays nothing until you resume it."); },
    "allow-resume": ({ c }) => { press(S.resumeAllowance(c, who(c)), "Allowance refused", "Agent resumed."); },
    "allow-revoke": ({ c }) => {
      if (ctx.state.mode === "agent") return void press(S.revokeAllowance(c, who(c)), "Allowance refused");
      confirmSheet(revokeSheet(S.allowanceSheet(c, viewerOf(c)), ctx.state.wallet), c.id, (x) => S.revokeAllowance(x, who(x)), "Allowance refused", "Allowance revoked. This is a mock signature.");
    },
    "withdraw-again": ({ c }) => { tryWithdraw(c); },
    "row-up": ({ el }) => moveRow(Number(el.dataset.i), -1),
    "row-down": ({ el }) => moveRow(Number(el.dataset.i), 1),
    "row-remove": ({ el }) => { readDraft(); const i = Number(el.dataset.i); if (st.draft.members.length > 3 && Number.isInteger(i) && st.draft.members[i] !== undefined) st.draft.members.splice(i, 1); },
    "row-add": () => { readDraft(); if (st.draft.members.length < 12) st.draft.members.push(""); },
    "row-mine": () => {
      readDraft();
      const list = st.draft.members, mine = ctx.state.wallet;
      if (!mine) return refuse("No wallet is connected.");
      if (list.includes(mine)) return refuse("This wallet is already in the list.");
      const gap = list.findIndex((v) => !v.trim());
      if (gap >= 0) list[gap] = mine; else if (list.length < 12) list.push(mine);
    },
    "row-check": () => { readDraft(); for (const x of memberRows(st.draft.members, st.looks)) if (x.state === "idle" || x.state === "refused") { delete st.looks[x.name]; look(x.name); } },
    review: async () => {
      readDraft();
      const d = createModel().draft;
      if (ctx.state.mode !== "human") { ctx.log("block", "Circle not started", "Agents never start a circle. Switch to You.", agentActor()); return refuse("Agents never start a circle. Switch to You."); }
      // The fields are checked as one text, so a secret spread over several rows is still caught. Blocked text is dropped.
      if (!(await ctx.passesLeakCheck([d.name, d.amount, ...d.members].join(" "), "circle form"))) {
        Object.assign(d, { name: "", amount: "", members: d.members.map(() => ""), terms: null });
        return refuse("The leak check blocked text in this form. The name, amount and member fields were cleared.");
      }
      const m = createModel(); // read after the check, so a lookup that answered meanwhile counts
      if (!m.check.ok) return refuse(m.check.errors[0].reason);
      if (!createReady(m)) return refuse("Every .sns name must resolve before the terms can be reviewed. Press Look up the names.");
      st.draft.terms = m.check.terms;
      ctx.navigate(`${PREFIX}/new/review`);
    },
    "create-cancel": () => { ctx.log("info", "Circle not created", "Cancelled on the terms sheet.", "YOU"); ctx.navigate(`${PREFIX}/new`); },
    create: () => {
      const t = st.draft && st.draft.terms;
      if (!t) return refuse(`Nothing to create. Start at ${PREFIX}/new.`);
      const w = { mode: ctx.state.mode, wallet: ctx.state.wallet || null, memberId: "", agentName: ctx.agent.name() };
      // The organizer's own seat, when the connected wallet is on the list by address or by a resolved name.
      const mine = w.wallet ? t.members.findIndex((n) => n === w.wallet || (Object.hasOwn(st.looks, n) && st.looks[n].target === w.wallet)) : -1;
      if (mine >= 0) w.memberId = `m${mine + 1}`;
      if (st.circles.length > MAX_MADE) return refuse(`This browser holds ${plural(MAX_MADE, "circle")} started here. Reset the demo to start another.`);
      const r = S.createCircle(t, w, clock());
      if (!r.ok) { if (w.mode === "agent") ctx.log("block", "Circle not started", r.reason, agentActor()); return refuse(r.reason); }
      if (RESERVED.includes(r.circle.id) || circleOf(r.circle.id)) return refuse(`A circle called ${t.name} cannot be kept here. Pick another name.`);
      st.viewer[r.circle.id] = w.memberId || "m1";
      commit(r);
      st.draft = null;
      st.flash = { cls: "su-ok", text: `Created ${r.circle.name}. Every seat is invited. This is a mock signature. Nothing was sent.` };
      ctx.navigate(pathOf(r.circle.id));
    },
  };
  // Where each press belongs. A press that arrives on any other page does nothing.
  const placeOf = (name) => (name === "reset" ? "" : name.startsWith("row-") || name === "review" ? "new" : name.startsWith("create") ? "review" : "circle");
  async function run(name, el) {
    const page = ctx.state.page, r = route(page), c = r.kind === "circle" ? circleOf(r.id) : null, place = Object.hasOwn(acts, name) ? placeOf(name) : "none";
    if (place === "none" || (place && r.kind !== place) || (place === "circle" && !c)) return;
    // The engine throws a plain Error on a malformed circle. It is caught here and shown.
    try { await acts[name]({ c, el, r }); } catch (e) { refuse(e.message); ctx.log("warn", "Circle action refused", e.message, "YOU"); }
    if (ctx.state.page === page) draw(page, true);
  }
  async function invite(text) {
    const page = ctx.state.page, t = String(text ?? "").trim(), show = (cls, msg) => { st.invite = { cls, text: msg }; if (ctx.state.page === page) draw(page, true); };
    if (!t) return;
    if (ctx.state.mode !== "human") return show("notice-red", "Agents never join a circle. Switch to You.");
    const out = ctx.$("suInviteOut");
    if (out) out.innerHTML = notice("su-info", "Checking the invite.");
    // The leak check runs first. The format check runs only on text that passed it.
    if (!(await ctx.passesLeakCheck(t, "invite box"))) return show("notice-red", "The leak check blocked that text. RobotFac3 did not read it as an invite.");
    const r = route(t), c = r.kind === "circle" && r.sub === "join" ? circleOf(r.id) : null;
    if (r.kind !== "circle" || r.sub !== "join") return show("notice-red", `That is not an invite RobotFac3 can read. An invite looks like ${PREFIX}/family-circle/join.`);
    if (!c) return show("notice-red", "This browser holds no circle with that id. In the mock an invite works in the browser that started the circle.");
    st.invite = null;
    if (ctx.state.page === page) ctx.navigate(pathOf(c.id, "join"));
  }

  // ---------- Pages ----------
  // A seat offered to a .sns name: resolve the name, read-only, and compare it with the connected wallet.
  function seatLook(c, page, silent) {
    const m = c.members.find((x) => x.id === viewerOf(c)), wallet = ctx.state.wallet;
    if (!m || m.status !== "invited" || !wallet || !SNS_RE.test(m.name) || ctx.state.mode !== "human") return null;
    const key = `${m.name}|${wallet}`;
    if (!silent && st.joinLook[key] && st.joinLook[key].state === "refused") delete st.joinLook[key]; // a fresh visit asks again
    if (st.joinLook[key]) return st.joinLook[key];
    st.joinLook[key] = { state: "looking" };
    ctx.resolveName(m.name).then((info) => {
      if (!info || !ADDR_RE.test(info.target)) throw new Error("The resolver sent an address RobotFac3 cannot read.");
      st.joinLook[key] = { state: "resolved", target: info.target };
    }).catch((e) => { st.joinLook[key] = { state: "refused", reason: e && e.message ? e.message : "The lookup failed." }; })
      .then(() => { if (ctx.state.page === page) draw(page, true); }); // drawn only when the person is still on this page
    return st.joinLook[key];
  }
  function circlePage(c0, r, page, silent) {
    // Two routes are attempts in themselves. Opening the withdrawal page tries a withdrawal. An agent opening the
    // join page tries to join. The engine refuses each one and leaves a block row.
    if (r.sub === "withdraw" && (!silent || !st.refusal[c0.id])) tryWithdraw(c0);
    if (r.sub === "join" && !silent && ctx.state.mode === "agent") {
      const tried = S.join(c0, who(c0), { accept: true, otherCircles: others(c0) });
      if (tried.ok !== false) throw new Error("An agent's join was not refused. Nothing was kept.");
      commit(tried, "Join refused");
    }
    const c = circleOf(c0.id), v = viewerOf(c), w = who(c), seat = c.members.find((x) => x.id === v) || null;
    const base = { id: c.id, name: c.name, mode: w.mode === "agent" ? "agent" : "human", wallet: w.wallet, flash: st.flash };
    if (!r.sub) {
      const n = c.rounds.find((x) => x.state === "open");
      return dashboard(dashModel(c, {
        viewer: v, mode: w.mode, wallet: w.wallet, flash: st.flash, mock: { storage: st.storage, note: st.note },
        agent: { name: ctx.agent.name(), can: ctx.agent.canAct(), task: typeof st.task[c.id] === "string" ? st.task[c.id] : `Pay round ${n ? n.n : 1} of ${c.name}`, out: st.out[c.id] || [] },
      }));
    }
    if (r.sub === "join") return joinPage({ ...base, j: seat ? S.joinSheet(c, v) : null, status: S.joinStatus(c, w), invited: Boolean(seat) && seat.status === "invited", look: seatLook(c, page, silent) });
    if (r.sub === "agent") return allowancePage({ ...base, a: seat ? S.allowanceSheet(c, v) : null, joined: Boolean(seat) && seat.status === "joined", agentName: ctx.agent.name() });
    if (r.sub === "withdraw") return withdrawPage({ ...base, refusal: st.refusal[c.id] || null });
    if (r.sub === "pay") return payPage({ ...base, o: S.overview(c, v), due: S.whatIsDue(c, v) });
    if (r.sub === "payout") return payoutPage({ ...base, p: seat ? S.payoutSheet(c, v) : null });
    if (r.sub === "missed") return missedPage({ ...base, o: S.overview(c, v), top: seat ? S.topUpStatus(c, v) : null, terms: S.termsSheet(c), drawn: c.history.filter((h) => (h.kind === "draw" || h.kind === "short") && (!seat || h.member === v)).slice(-4) });
    if (r.sub === "history") return historyPage({ ...base, rows: c.history });
    return leavePage({ ...base, l: seat ? S.leaveSheet(c, v) : null, status: seat ? seat.status : "" });
  }
  function pageFor(r, page, silent) {
    if (r.kind === "home") {
      if (!silent) st.invite = null; // an invite answer belongs to the visit it was given on
      const tile = (c, i) => {
        const o = S.overview(c, viewerOf(c));
        const text = o.status === "forming" ? `Forming · ${o.seatsFilled} of ${o.seats} seats` : o.status === "complete" ? `Complete · ${plural(o.seats, "round")}` : `Round ${o.round.n} of ${o.round.of} · ${usdc(o.amount)} ${o.cadence} · ${o.round.paid} of ${o.round.seats} paid`;
        return { id: c.id, name: c.name, line: text, demo: i === 0 };
      };
      return homePage({ circles: st.circles.map(tile), mode: ctx.state.mode, wallet: ctx.state.wallet || null, invite: st.invite, flash: st.flash, posture: S.overview(st.circles[0], "").lines.posture });
    }
    if (r.kind === "new") return createPage(createModel());
    if (r.kind === "review") return reviewPage({ terms: st.draft ? st.draft.terms : null, mode: ctx.state.mode, wallet: ctx.state.wallet || null, flash: st.flash });
    const c = r.kind === "circle" ? circleOf(r.id) : null;
    return c ? circlePage(c, r, page, silent) : lostPage(page, st.circles);
  }
  function bind() {
    const v = view();
    v.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => ctx.navigate(b.dataset.go)));
    v.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => run(b.dataset.act, b)));
    const pick = ctx.$("suViewer");
    pick?.addEventListener("change", () => run("view-as", pick));
    // Agent panel: pastes are held for the leak check, and Run goes through the leak check before anything is read.
    const form = ctx.$("suAgentForm"), box = ctx.$("suAgentTask"), r = route(ctx.state.page);
    if (form && box && r.kind === "circle") {
      ctx.guardPaste(box, "circle task box");
      box.addEventListener("input", () => { st.task[r.id] = box.value; });
      v.querySelectorAll("[data-task]").forEach((b) => b.addEventListener("click", () => { box.value = b.dataset.task; st.task[r.id] = box.value; }));
      form.addEventListener("submit", (e) => { e.preventDefault(); if (!box.readOnly) return runAgent(r.id, box.value); });
    }
    const inv = ctx.$("suInviteForm"), link = ctx.$("suInvite");
    if (inv && link) {
      ctx.guardPaste(link, "invite box");
      inv.addEventListener("submit", (e) => { e.preventDefault(); if (!link.readOnly) return invite(link.value); });
    }
    const make = ctx.$("suCreate");
    if (make) {
      // The date field takes a date and no free text, so it has no paste to hold.
      const text = [ctx.$("suName"), ctx.$("suAmount")], rows = [...v.querySelectorAll("[data-member]")];
      [...text, ...rows].forEach((el) => ctx.guardPaste(el, "circle form"));
      const sync = () => { readDraft(); paintCreate(); };
      [...text, ...rows, ctx.$("suStart")].forEach((el) => el.addEventListener("input", sync));
      ctx.$("suCadence").addEventListener("change", sync);
      text.forEach((el) => el.addEventListener("change", () => checkField(el, false)));
      rows.forEach((el) => el.addEventListener("change", () => checkField(el, true)));
      make.addEventListener("submit", (e) => { e.preventDefault(); return run("review"); });
    }
  }
  function draw(page, silent) {
    const r = route(page);
    let html;
    try { html = pageFor(r, page, silent); } catch (e) { html = brokenPage(e.message); if (!silent) ctx.log("warn", "Circle page refused", e.message, "YOU"); }
    st.flash = null;
    view().innerHTML = html;
    bind();
  }
  async function render(page, { silent } = {}) {
    if (!st.ready) {
      view().innerHTML = frame("Susu circle", `<p class="mono muted">Reading the demo circle…</p>`);
      await load();
      if (ctx.state.page !== page) return; // the person moved on while the fixture loaded
      if (!st.ready) return void (view().innerHTML = missingPage(st.missing));
    }
    draw(page, silent);
  }

  return {
    prefix: PREFIX,
    title: (page) => titleOf(page, st.circles),
    render,
    // A seat check belongs to the wallet it was made for. A new wallet starts with none.
    onWallet() { st.joinLook = {}; },
  };
}
