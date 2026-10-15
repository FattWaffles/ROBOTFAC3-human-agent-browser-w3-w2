// The susu circle pages (src/susu-ui.js): the pure views, then the area driven through a hand-written stand-in for
// the few DOM calls it makes. Nothing here touches a chain or a wallet. Node built-ins only, no DOM library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/susu.js";
import * as UI from "../src/susu-ui.js";

const RAW = readFileSync(new URL("../data/susu-demo.json", import.meta.url), "utf8");
const SRC = readFileSync(new URL("../src/susu-ui.js", import.meta.url), "utf8");
const W = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const W2 = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const HOSTILE = `"><img src=x onerror="alert(1)"><b style="x">`;

const fixture = () => S.loadFixture(RAW);
const human = (memberId = "you", wallet = W) => ({ mode: "human", wallet, memberId, agentName: "Scout" });
const ok = (r) => { assert.equal(r.ok, true, r.reason); return r.circle; };
const walk = (c, days) => { for (let i = 0; i < days; i++) c = ok(S.nextDay(c, human())); return c; };
const dash = (c, ui = {}) => UI.dashboard(UI.dashModel(c, { viewer: "you", ...ui }));
const TRIO = { name: "Trio", amount: "50", cadence: "monthly", seats: 3, start: "2026-11-01", order: "fixed", members: ["ama.sns", "ben.sns", W2] };
const forming = () => ok(S.createCircle(TRIO, human("m1"), "2026-10-13"));

// What the Content-Security-Policy and the copy rule forbid in anything this file draws, and what every surface carries.
function clean(html, what, surface = true) {
  assert.ok(!/\sstyle\s*=\s*["']/i.test(html), `${what}: inline style`);
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${what}: inline handler`);
  assert.ok(!/<script|<img(?! src="public\/avatars\/scout\.svg" alt="" \/>)/i.test(html), `${what}: a script tag or an image this file did not write`);
  assert.ok(!/https?:\/\/|(?:data|blob):/i.test(html), `${what}: an outside or inline resource`);
  for (const word of ["savings", "loan", "interest", "deposit", "shared custody"]) assert.ok(!html.toLowerCase().includes(word), `${what}: says "${word}"`);
  assert.ok(html.includes(">Solana<") && html.includes(">mock · no chain<"), `${what}: both chips`);
  if (surface) assert.ok(html.includes('<p class="eyebrow">Scripted mock</p>'), `${what}: the eyebrow says scripted`);
}

// ---------- Pure views ----------
test("route: the susu pages, and a 404 for everything else", () => {
  assert.deepEqual(UI.route("rf3://susu"), { kind: "home" });
  assert.deepEqual(UI.route("rf3://susu/new"), { kind: "new" });
  assert.deepEqual(UI.route("rf3://susu/new/review"), { kind: "review" });
  assert.deepEqual(UI.route("rf3://susu/family-circle"), { kind: "circle", id: "family-circle", sub: "" });
  for (const sub of ["join", "agent", "withdraw", "pay", "payout", "missed", "history", "leave"]) assert.deepEqual(UI.route(`rf3://susu/family-circle/${sub}`), { kind: "circle", id: "family-circle", sub });
  for (const bad of ["rf3://susu/", "rf3://susu/Family", "rf3://susu/a/b/c", "rf3://susu/family-circle/admin", "rf3://susu/new/x", "rf3://susu/family-circle/join?seat=1", "rf3://susu/family-circle/__proto__", "rf3://susux", null, 7]) {
    assert.deepEqual(UI.route(bad), { kind: "404" }, String(bad));
  }
  assert.equal(UI.titleOf("rf3://susu/family-circle/agent", [fixture()]), "Agent allowance · Family Circle");
  assert.equal(UI.titleOf("rf3://susu/nope", [fixture()]), "No such susu page");
});

test("cellChip: every engine cell state has one label, and an unknown state paints red", () => {
  const c = fixture();
  assert.deepEqual(UI.cellChip(S.cell(c, "kofi", 2)), { cls: "chip-sky", text: "paid by agent" });
  assert.deepEqual(UI.cellChip(S.cell(c, "amara", 2)), { cls: "chip-ok", text: "paid by hand" });
  assert.deepEqual(UI.cellChip(S.cell(c, "you", 2)), { cls: "chip-bone", text: "unpaid" });
  assert.deepEqual(UI.cellChip(S.cell(c, "dana", 1)), { cls: "chip-red", text: "drawn from collateral" });
  assert.deepEqual(UI.cellChip(S.cell(c, "you", 3)), { cls: "chip-muted", text: "upcoming" });
  assert.deepEqual(UI.cellChip(S.cell(walk(c, 2), "dana", 2)), { cls: "chip-warn", text: "late · 48 h grace left" });
  assert.deepEqual(UI.cellChip({ state: "constructor" }), { cls: "chip-red", text: "unreadable" });
});

test("dashboard on the fixture day: strip, grid, pre-notice banner, rules, posture and the mock controls", () => {
  const html = dash(fixture());
  clean(html, "dashboard");
  for (const part of [
    "Family Circle", "round 2 of 4", "2 of 4 paid", "200 USDC", "Round 2 · Oct 14", "paid by agent", "paid by hand", "drawn from collateral", "unpaid",
    "Your agent will pay 50 USDC to Family Circle on Oct 14.", "This is your review step.", 'data-act="notice-ok"', 'data-act="notice-pause"', "Pay by hand now",
    "A member who leaves after taking the pot costs the circle up to 150 USDC beyond their collateral. The program cannot collect it.",
    "The program has no withdraw instruction and no admin key.", "Try an arbitrary withdrawal", "No fee on principal. Not a bank. Not FDIC or FSCS insured.",
    "mock controls", "Next day", "Viewing as", "Reset demo", "today Oct 13", "nia.sns takes the pot", "organizer, no power after creation", "<progress max=\"4\" value=\"2\">",
  ]) assert.ok(html.includes(part), part);
  assert.ok(!html.includes("suAgentForm"), "no agent panel in You mode");
  assert.ok(html.includes("No wallet connected."), "no wallet: the page says the signing sheets are off");
  assert.ok(!dash(fixture(), { wallet: W }).includes("No wallet connected."));
});

test("dashboard in Agent mode: the panel with its preset and Try button, and mock controls a person must use", () => {
  const html = dash(fixture(), { mode: "agent", agent: { name: "Scout", can: { ok: true, reason: "" }, task: "Pay round 2 of Family Circle", out: [{ text: "Circle program: BLOCKED.", cls: "t-red" }] } });
  clean(html, "agent dashboard");
  for (const part of ['id="suAgentForm"', 'value="Pay round 2 of Family Circle"', 'data-task="Withdraw 100 USDC from Family Circle"', "Try: withdraw from the vault", "scripted demo", "I will pay on Oct 14 unless you pause me.", '<div class="t-red">Circle program: BLOCKED.</div>']) assert.ok(html.includes(part), part);
  assert.ok(html.includes('data-act="next-day" disabled') && html.includes('<select id="suViewer" disabled>') && html.includes('data-act="reset" disabled'));
  assert.ok(html.includes("Only a person moves the mock clock. Switch to You."));
  const paused = dash(fixture(), { mode: "agent", agent: { name: "Scout", can: { ok: false, reason: "Scout is paused by you." }, task: "", out: [] } });
  assert.ok(paused.includes("Scout is paused by you.") && paused.includes("dot-paused"));
});

test("dashboard through the mock clock: agent-paid cell, late with grace left, drawn, pot unclaimed, Claim or Waiting", () => {
  let c = walk(fixture(), 1); // Oct 14
  assert.match(dash(c), /nia\.sns<small>slot 2 · you<\/small><\/th><td><span class="chip chip-sky" title="Sep 14">paid by agent<\/span><\/td><td class="su-now"><span class="chip chip-sky" title="Oct 14">paid by agent/);
  assert.ok(dash(c).includes("Round 2: paid by agent on Oct 14. 3 of 4 have paid."), "you paid, others pending");
  c = walk(c, 1); // Oct 15
  let html = dash(c);
  assert.ok(html.includes("late · 48 h grace left") && html.includes("<b>dana.sns is late for round 2.</b> 48 hours of grace left. The grace ends on Oct 16."));
  assert.ok(dash(c, { viewer: "dana" }).includes('data-act="pay-now"'), "the late member sees Pay by hand");
  assert.ok(dash(walk(c, 1)).includes("late · 24 h grace left"));
  c = walk(c, 2); // Oct 17
  html = dash(c);
  clean(html, "dashboard after the draw");
  assert.ok(html.includes("Your round 2 pot of 200 USDC is ready.") && html.includes("Pot unclaimed since Oct 17") && html.includes(">Claim<"));
  const other = dash(c, { viewer: "amara" });
  assert.ok(other.includes("Waiting for nia.sns to claim the round 2 pot of 200 USDC. Pot unclaimed since Oct 17.") && !other.includes(">Claim<"));
  const dana = dash(c, { viewer: "dana" });
  assert.ok(dana.includes("Top up 50 USDC of collateral before round 3 is due on Nov 14 or leave.") && dana.includes("Top up or leave"));
  const paid = dash(ok(S.claimPayout(c, human())));
  assert.ok(paid.includes("Pot paid on Oct 17") && !paid.includes("Your round 2 pot"));
});

test("pre-notice banner: unanswered, acknowledged, paused, and the reminder for a manual payer", () => {
  const c = fixture(), base = "rf3://susu/family-circle";
  const open = UI.noticeBanner(S.preNotice(c, "you"), "active", base);
  assert.ok(open.includes("With no answer the agent pays on Oct 14.") && open.includes('data-act="notice-ok"'));
  const said = ok(S.answerPreNotice(c, human(), "ok"));
  const acked = UI.noticeBanner(S.preNotice(said, "you"), "active", base);
  assert.ok(acked.includes("<b>Agent will pay Oct 14. You said OK on Oct 13.</b>") && !acked.includes("notice-ok"));
  const held = ok(S.answerPreNotice(c, human(), "pause"));
  const paused = UI.noticeBanner(S.preNotice(held, "you"), "paused", base);
  assert.ok(paused.includes("Your agent is paused.") && paused.includes("Resume the agent") && paused.includes('data-act="pay-now"'));
  const reminder = UI.noticeBanner(S.preNotice(c, "dana"), "none", base);
  assert.ok(reminder.includes("50 USDC is due to Family Circle on Oct 14. Pay by hand.") && !reminder.includes("notice-ok"));
  assert.equal(S.preNotice(walk(c, 1), "you"), null, "the notice is for the day before only");
});

test("an agent that stopped short puts a Pay by hand banner on the dashboard", () => {
  const raw = JSON.parse(RAW);
  raw.members[1].usdc = "10";
  const c = walk(S.loadFixture(raw), 1);
  assert.equal(UI.stopRow(c, "you").kind, "stop");
  const html = dash(c);
  assert.ok(html.includes("<b>Agent stopped.</b>") && html.includes("USDC is short") && html.includes("Nothing moved."));
  assert.equal(UI.stopRow(fixture(), "you"), null);
  assert.equal(UI.stopRow(c, "amara"), null);
});

test("standing: no wallet, a visitor, a mock seat, a seat bound to another wallet", () => {
  const c = fixture();
  assert.equal(UI.standing(c, "you", null).state, "no-wallet");
  assert.deepEqual(UI.standing(c, "", W), { state: "not-member", text: "This wallet is not a member of Family Circle." });
  assert.deepEqual(UI.standing(c, "you", W), { state: "member", text: "" });
  const trio = ok(S.join(forming(), human("m3", W2), { accept: true, otherCircles: [] }));
  assert.equal(UI.standing(trio, "m3", W2).state, "member");
  assert.equal(UI.standing(trio, "m3", W).text, "This wallet is not a member of Trio.");
  assert.equal(UI.standing(trio, "m1", W).state, "invited");
  assert.ok(dash(c, { viewer: "", wallet: W }).includes("This wallet is not a member of Family Circle."));
});

test("a forming circle: seats filled, the invite link, and Join for an invited seat", () => {
  const trio = ok(S.join(forming(), human("m3", W2), { accept: true, otherCircles: [] }));
  const html = dash(trio, { viewer: "m1", wallet: W });
  clean(html, "forming dashboard");
  for (const part of ["forming · 1 of 3 seats", "<b>Forming: 1 of 3 seats have joined.</b>", "Invites close on Oct 31.", "rf3://susu/trio/join", "Read the terms and join", "This seat has an open invite."]) assert.ok(html.includes(part), part);
});

test("join sheet: slot, payout date, collateral, the stated gaps, and a mock button that needs a wallet", () => {
  const c = fixture(), w = human("you", null);
  const html = UI.joinPage({ id: c.id, name: c.name, j: S.joinSheet(c, "you"), status: S.joinStatus(c, w), invited: false, wallet: null, look: null, flash: null });
  clean(html, "join sheet");
  for (const part of [
    "Join Family Circle", "2 of 4, payout Oct 14", "50 USDC, posted at join, returned at close", "Each member posts 50 USDC of collateral at join.",
    "A member who leaves after taking the pot costs the circle up to 150 USDC beyond their collateral. The program cannot collect it.",
    "One circle per USDC account.", "Your pot goes to the wallet you join with. Keep it.", "Agents never join a circle or accept its terms. This step is yours.",
    "nia.sns is already a member of Family Circle.", ">unusual<", "No wallet connected. Connect Phantom to turn this button on.",
    'data-act="join" disabled>Join and sign (mock)<', 'data-act="decline" disabled>Decline<',
  ]) assert.ok(html.includes(part), part);
  const trio = forming(), who = human("m3", W2);
  const live = UI.joinPage({ id: trio.id, name: trio.name, j: S.joinSheet(trio, "m3"), status: S.joinStatus(trio, who), invited: true, wallet: W2, look: null, flash: null });
  assert.ok(live.includes('data-act="join">Join and sign (mock)<') && live.includes('data-act="decline">Decline<') && live.includes(W2) && live.includes("Invite closes"));
  assert.ok(!live.includes("Connect Phantom to turn this button on"));
  // A .sns seat stays off until the name resolves to the connected wallet. Decline follows the same match as Join.
  const sns = { id: trio.id, name: trio.name, j: S.joinSheet(trio, "m1"), status: S.joinStatus(trio, human("m1", W)), invited: true, wallet: W, flash: null };
  const off = (html) => html.includes('data-act="join" disabled') && html.includes('data-act="decline" disabled');
  assert.ok(off(UI.joinPage({ ...sns, look: { state: "looking" } })));
  const down = UI.joinPage({ ...sns, look: { state: "refused", reason: "Could not reach Solana." } });
  assert.ok(down.includes("RobotFac3 could not check ama.sns. Could not reach Solana. Join and Decline stay off.") && off(down));
  const other = UI.joinPage({ ...sns, look: { state: "resolved", target: W2 } });
  assert.ok(other.includes("This wallet differs from the invited name.") && off(other));
  const mine = UI.joinPage({ ...sns, look: { state: "resolved", target: W } });
  assert.ok(mine.includes('data-act="join">Join and sign (mock)<') && mine.includes('data-act="decline">Decline<'));
  // No wallet connected: an invited seat can neither join nor decline.
  assert.ok(off(UI.joinPage({ ...sns, wallet: null, look: null, status: S.joinStatus(trio, human("m1", null)) })));
  // An address seat viewed with another wallet is refused by the engine's own status, and Decline is off with Join.
  const wrong = UI.joinPage({ id: trio.id, name: trio.name, j: S.joinSheet(trio, "m3"), status: S.joinStatus(trio, human("m3", W)), invited: true, wallet: W, look: null, flash: null });
  assert.ok(wrong.includes("This seat was offered to another wallet.") && off(wrong));
  // A seat short of the collateral cannot join. It can still decline.
  const poor = JSON.parse(JSON.stringify(trio));
  poor.members[2].usdc = "10";
  const short = UI.joinPage({ id: poor.id, name: poor.name, j: S.joinSheet(poor, "m3"), status: S.joinStatus(poor, human("m3", W2)), invited: true, wallet: W2, look: null, flash: null });
  assert.ok(short.includes('data-act="join" disabled') && short.includes('data-act="decline">Decline<'));
  const asAgent = UI.joinPage({ ...sns, look: null, status: S.joinStatus(trio, { ...human("m1", W), mode: "agent" }) });
  assert.ok(asAgent.includes('<div class="notice notice-red">Agents never join a circle or accept its terms. Switch to You.</div>') && asAgent.includes('data-act="decline" disabled'));
});

test("allowance: off by default, and the confirm sheet carries the exception sentence word for word", () => {
  const c = fixture(), a = S.allowanceSheet(c, "dana");
  const html = UI.allowSheet(a, "Scout", null);
  clean(html, "allowance confirm sheet", false);
  for (const part of [
    "Let Scout pay your share", "the circle program", "Family Circle vault only", "50 USDC per round, one payment per round", "a notice one day ahead: OK, Pause, or Pay by hand now", "any time, one signed step",
    "One exception: a circle allowance. The program fixes the destination and the amount. You get a notice a day before. You can pause or revoke at any time.",
    "The SOL spend limit in Settings does not apply to USDC contributions.", ">Allowance off<", ">unusual<", "data-close>Not now<", 'id="suConfirm" class="btn btn-primary" disabled>Confirm allowance (mock)<', "No wallet connected.",
  ]) assert.ok(html.includes(part), part);
  assert.ok(UI.allowSheet(a, "Scout", W).includes('id="suConfirm" class="btn btn-primary">Confirm allowance (mock)<'));
  const page = (seat, mode = "human", wallet = W) => UI.allowancePage({ id: c.id, name: c.name, a: S.allowanceSheet(c, seat), joined: true, mode, wallet, agentName: "Scout", flash: null });
  clean(page("dana"), "allowance page");
  assert.ok(page("dana").includes("allowance off") && page("dana").includes("Off by default.") && page("dana").includes('data-act="allow-on"'));
  assert.ok(page("dana").includes("The agent&#39;s fee balance is short: 0 SOL"), "fee short is stated");
  assert.ok(page("you").includes("allowance active") && page("you").includes('data-act="allow-pause"') && page("you").includes('data-act="allow-revoke"'));
  assert.ok(page("you", "agent").includes("Only a person sets, pauses or revokes an allowance. Switch to You."));
  // A standing allowance names the agent it was set for. An allowance that is off names the agent acting now.
  assert.ok(page("kofi").includes("Let Hermes pay your share of Family Circle") && page("you").includes("Let Scout pay your share of Family Circle") && page("dana").includes("Let Scout pay your share of Family Circle"));
  assert.ok(page("you", "human", null).includes("Turning the allowance on or revoking it needs Phantom."));
  const held = ok(S.pauseAllowance(c, human()));
  assert.ok(UI.allowancePage({ id: c.id, name: c.name, a: S.allowanceSheet(held, "you"), joined: true, mode: "human", wallet: W, agentName: "Scout", flash: null }).includes('data-act="allow-resume"'));
  assert.ok(UI.revokeSheet(a, W).includes(">Revoke (mock)<"));
});

test("the other circle pages: withdraw, pay, payout, missed, history, leave", () => {
  const c = fixture(), base = { id: c.id, name: c.name, mode: "human", wallet: W, flash: null };
  const wd = UI.withdrawPage({ ...base, refusal: { by: "organizer", agent: "Scout", seat: "amara.sns", asked: "250 USDC, the whole vault", reason: `${S.NO_WITHDRAW} The organizer has no power after creation.` } });
  clean(wd, "withdraw");
  for (const part of ["Withdrawal refused", "The circle program has no withdraw instruction and no admin key. Nothing moved.", "you, the organizer (amara.sns)", "The organizer has no power after creation.", "The same refusal applies to a person, to an agent and to the organizer."]) assert.ok(wd.includes(part), part);
  assert.ok(UI.withdrawPage({ ...base, refusal: { by: "agent", agent: "Scout", seat: "nia.sns", asked: "x", reason: "y" } }).includes("Scout, an agent, for nia.sns"));

  const pay = UI.payPage({ ...base, o: S.overview(c, "you"), due: S.whatIsDue(c, "you") });
  clean(pay, "pay");
  for (const part of [">You&#39;re paying<", ">routine<", "Pay 50 USDC to Family Circle", "2 of 4", "Family Circle vault", "nia.sns · 120 USDC (mock balance)", 'data-act="pay" data-round="2">Approve (mock)<']) assert.ok(pay.includes(part), part);
  const noWallet = UI.payPage({ ...base, wallet: null, o: S.overview(c, "you"), due: S.whatIsDue(c, "you") });
  assert.ok(noWallet.includes('data-round="2" disabled>Approve (mock)<') && noWallet.includes("No wallet connected."));
  assert.ok(UI.payPage({ ...base, mode: "agent", o: S.overview(c, "you"), due: S.whatIsDue(c, "you") }).includes("Switch to You to pay by hand."));
  const done = walk(c, 1);
  assert.ok(UI.payPage({ ...base, o: S.overview(done, "you"), due: S.whatIsDue(done, "you") }).includes("Round 2 is already paid. The agent paid on Oct 14. A second contribution for the same round is refused."));
  assert.ok(UI.payPage({ ...base, o: S.overview(done, "dana"), due: S.whatIsDue(done, "dana") }).includes("USDC is short. This seat holds 0 USDC and round 2 needs 50 USDC."));

  const waiting = UI.payoutPage({ ...base, p: S.payoutSheet(c, "you") });
  clean(waiting, "payout");
  assert.ok(waiting.includes('data-round="2" disabled>Claim and sign (mock)<') && waiting.includes("The pot goes to the wallet that joined. Nobody can change the recipient."));
  const ready = walk(c, 4);
  assert.ok(UI.payoutPage({ ...base, p: S.payoutSheet(ready, "you") }).includes('data-act="claim" data-round="2">Claim and sign (mock)<'));
  assert.ok(UI.payoutPage({ ...base, p: S.payoutSheet(ready, "dana") }).includes("Your turn is round 4, due Dec 14. Round 3 is open."));
  assert.ok(UI.payoutPage({ ...base, p: S.payoutSheet(ready, "kofi") }).includes("0 of 4 have paid. The pot is ready when everyone has paid or the grace has ended."), "grace running");

  const missed = (circle, seat) => UI.missedPage({ ...base, o: S.overview(circle, seat), top: S.topUpStatus(circle, seat), terms: S.termsSheet(circle), drawn: circle.history.filter((h) => h.kind === "draw" && h.member === seat) });
  clean(missed(c, "dana"), "missed");
  for (const part of ["Top up 50 USDC of collateral", "Before Oct 14 you need 100 USDC.", ">Top up 50 USDC (mock)<", "Drew 50 USDC from dana.sns&#39;s collateral for round 1.", "One round of collateral covers one miss."]) assert.ok(missed(c, "dana").includes(part), part);
  assert.ok(missed(c, "you").includes("Collateral is full. Nothing is owed."));
  assert.ok(missed(walk(c, 3), "amara").includes('<progress max="48" value="24">'), "everyone sees the grace left");

  const history = UI.historyPage({ ...base, rows: c.history });
  clean(history, "history");
  assert.ok(history.indexOf("Notice to nia.sns: the agent will pay 50 USDC to Family Circle on Oct 14.") < history.indexOf("Created Family Circle"), "newest first");
  assert.ok(history.includes('<span class="chip">HERMES</span>') && history.includes("su-row-warn") && history.includes("You said OK"));
  assert.ok(UI.historyPage({ ...base, rows: [] }).includes("No rows yet."));

  const leave = UI.leavePage({ ...base, l: S.leaveSheet(c, "amara"), status: "joined" });
  clean(leave, "leave");
  for (const part of [">Leave and forfeit 50 USDC (mock)<", "Revoke the program&#39;s allowance (a signed step)", "Leave Family Circle", "You took the pot. Leaving now costs the circle 50 USDC beyond your collateral."]) assert.ok(leave.includes(part), part);
});

test("home, create, review, 404 and the fixture-missing page", () => {
  const home = (mode) => UI.homePage({ circles: [{ id: "family-circle", name: "Family Circle", line: "Round 2 of 4", demo: true }], mode, wallet: null, invite: null, flash: null, posture: S.overview(fixture(), "").lines.posture });
  clean(home("human"), "home");
  for (const part of ["Pool with a circle.", "rotating circle", "program-controlled pool", "Your circles", "Start a circle", "Join with an invite", "demo circle", "Not a bank."]) assert.ok(home("human").includes(part), part);
  assert.ok(home("agent").includes('data-go="rf3://susu/new" disabled>Start a circle<') && home("agent").includes("disabled>Join with an invite<") && home("agent").includes("Agents never start or join a circle. Switch to You."));

  const model = (members, looks = {}, more = {}) => {
    const draft = { name: "Trio", amount: "50", cadence: "monthly", start: "2026-11-01", members, ...more };
    return { draft, rows: UI.memberRows(members, looks), check: S.validateTerms({ ...draft, seats: members.length, order: "fixed" }, "2026-10-13"), mode: "human", wallet: W, today: "2026-10-13", flash: null };
  };
  assert.deepEqual(UI.memberRows(["Ama.sns ", "ama.sns", W, "", "bad name", "ben.sns", "cy.sns", "dee.sns"], { "ben.sns": { state: "resolved", target: W2 }, "cy.sns": { state: "looking" }, "dee.sns": { state: "refused", reason: "No such name." } }).map((x) => x.state),
    ["idle", "duplicate", "address", "empty", "invalid", "resolved", "looking", "refused"]);
  const looks = { "ama.sns": { state: "resolved", target: W }, "ben.sns": { state: "resolved", target: W2 } };
  const ready = model(["ama.sns", "ben.sns", W2], looks);
  assert.equal(UI.createReady(ready), true);
  assert.equal(UI.createReady(model(["ama.sns", "ben.sns", W2], { "ama.sns": looks["ama.sns"] })), false, "an unresolved name keeps review off");
  const form = UI.createPage(ready);
  clean(form, "create");
  for (const part of ['id="suCreate"', 'data-member="0"', 'data-act="row-up" data-i="0" disabled', 'data-act="row-down" data-i="2" disabled', 'data-act="row-remove" data-i="1" disabled', "resolved to 86xC…2MMY", "wallet address, no lookup needed", "Terms preview", "150 USDC", "ama.sns takes the pot on Nov 1.", "Review the terms"]) assert.ok(form.includes(part), part);
  const bad = UI.createPage(model(["ama.sns", "ama.sns", ""], {}, { amount: "0,5" }));
  assert.ok(bad.includes("Type the USDC amount as a plain decimal") && bad.includes("Member 2 is listed twice.") && bad.includes("listed twice"));
  assert.ok(UI.createPage({ ...ready, mode: "agent" }).includes("Agents never start a circle. Switch to You."));

  const review = UI.reviewPage({ terms: ready.check.terms, mode: "human", wallet: null, flash: null });
  clean(review, "review");
  for (const part of ["Create Trio", "Slot 3: 58Pw…JPkx takes the pot on Jan 1.", "The organizer has no power after creation.", "A member who leaves after taking the pot costs the circle up to 100 USDC", "disabled>Create and sign (mock)<", "You sign once."]) assert.ok(review.includes(part), part);
  assert.ok(UI.reviewPage({ terms: null, mode: "human", wallet: W, flash: null }).includes("Nothing to review yet."));

  const lost = UI.lostPage(`rf3://susu/${HOSTILE}`, [fixture()]);
  clean(lost, "404");
  assert.ok(lost.includes("RobotFac3 has no susu page at") && lost.includes("rf3://susu/&quot;&gt;&lt;img"));
  const missing = UI.missingPage(`The file answered 404. ${HOSTILE}`);
  clean(missing, "fixture missing");
  assert.ok(missing.includes("<b>The demo circle is missing.</b>") && missing.includes("data/susu-demo.json"));
});

test("escaping: hostile text in a flash, an agent line, a task, a form value and a lookup never becomes markup", () => {
  const raw = (html) => assert.ok(!html.includes("<img") && !html.includes('onerror="') && !html.includes('style="x"'), html.slice(0, 200));
  raw(UI.outLines([{ text: HOSTILE, cls: 't-red" onclick="x' }]));
  assert.equal(UI.outLines([{ text: "x", cls: 't-red" onclick="x' }]), '<div class="">x</div>');
  raw(dash(fixture(), { flash: { cls: HOSTILE, text: HOSTILE }, mode: "agent", agent: { name: HOSTILE, can: { ok: false, reason: HOSTILE }, task: HOSTILE, out: [{ text: HOSTILE, cls: "" }] }, mock: { storage: "unavailable", note: HOSTILE } }));
  const rows = UI.memberRows([HOSTILE, "ok.sns", W], { "ok.sns": { state: "refused", reason: HOSTILE } });
  raw(UI.createPage({ draft: { name: HOSTILE, amount: HOSTILE, cadence: HOSTILE, start: HOSTILE, members: [] }, rows, check: { ok: false, errors: [{ field: "name", reason: HOSTILE }] }, mode: "human", wallet: W, today: "2026-10-13", flash: null }));
  raw(UI.withdrawPage({ id: "family-circle", refusal: { by: "agent", agent: HOSTILE, seat: HOSTILE, asked: HOSTILE, reason: HOSTILE }, flash: null }));
  raw(UI.homePage({ circles: [{ id: "x", name: HOSTILE, line: HOSTILE, demo: false }], mode: "human", wallet: W, invite: { cls: HOSTILE, text: HOSTILE }, flash: null, posture: HOSTILE }));
  raw(UI.sheet({ lead: HOSTILE, kind: HOSTILE, title: HOSTILE, rows: [[HOSTILE, HOSTILE]], list: [HOSTILE], notes: [["notice-red", HOSTILE]], demo: true }));
});

test("openStore: empty, malformed, a round trip, and a stored circle that fails its checks", () => {
  assert.deepEqual(UI.openStore(null, RAW), { circles: [fixture()], note: "" });
  assert.deepEqual(UI.openStore("", RAW), { circles: [fixture()], note: "" });
  assert.equal(UI.openStore("{nope", RAW).note, "Stored progress was not valid JSON.");
  for (const bad of ["[]", "7", "null", '{"v":2,"circles":[]}', '{"v":1,"circles":[]}', '{"v":1,"circles":[7]}', '{"v":1,"circles":["x"],"extra":1}', JSON.stringify({ v: 1, circles: ["a", "b", "c", "d", "e", "f"] })]) {
    const got = UI.openStore(bad, RAW);
    assert.deepEqual(got.circles, [fixture()], bad);
    assert.equal(got.note, "Stored progress had an unexpected shape.", bad);
  }
  const moved = walk(fixture(), 2), trio = forming();
  const back = UI.openStore(UI.packStore([moved, trio]), RAW);
  assert.deepEqual(back, { circles: [moved, trio], note: "" });
  // The demo circle falls back to the fixture when its stored copy is not this circle. The other circle is kept.
  const swapped = UI.openStore(UI.packStore([trio, trio]), RAW);
  assert.deepEqual(swapped.circles, [fixture(), trio]);
  assert.match(swapped.note, /does not match this circle's terms/);
  // A circle started here with a broken checksum, a reserved id or a repeated id is dropped with a reason.
  const text = S.serialize(trio);
  const tampered = UI.openStore(JSON.stringify({ v: 1, circles: [S.serialize(moved), text.replace('"amount":"50"', '"amount":"5"'), text, text] }), RAW);
  assert.deepEqual(tampered.circles, [moved, trio]);
  assert.match(tampered.note, /A circle started here was dropped\. Stored circle state fails its checksum A circle started here was dropped\. It repeats an id\./);
  assert.throws(() => UI.openStore(null, "{}"), Error, "a bad fixture throws, so the page shows fixture missing");
});

test("rowTitle: the log title for each history row", () => {
  assert.equal(UI.rowTitle({ kind: "ok" }), "You said OK");
  assert.deepEqual([UI.rowTitle({ kind: "ok", actor: "YOU" }), UI.rowTitle({ kind: "ok", actor: "kofi.sns" })], ["You said OK", "Member said OK"]);
  assert.equal(UI.rowTitle({ kind: "block" }), "Refused");
  assert.equal(UI.rowTitle({ kind: "block" }, "Withdrawal refused"), "Withdrawal refused");
  assert.equal(UI.rowTitle({ kind: "pay" }, "Withdrawal refused"), "Contribution paid");
  assert.equal(UI.rowTitle({ kind: "nope" }), "Circle event");
  for (const h of fixture().history) assert.notEqual(UI.rowTitle(h), "Circle event", h.kind);
});

test("the module reaches for nothing it must not: no wallet, RPC or transaction import, one fetch, no inline style", () => {
  const imports = [...SRC.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./susu.js"]);
  assert.ok(!/\bimport\(/.test(SRC), "no dynamic import");
  assert.deepEqual([...SRC.matchAll(/\bfetch\(([^)]*)\)/g)].map((m) => m[1]), ["FIXTURE_URL"]);
  assert.ok(SRC.includes('const FIXTURE_URL = "data/susu-demo.json";'));
  assert.ok(!/style=\\?"/.test(SRC) && !/\son[a-z]+=\\?"/.test(SRC), "no inline style or handler in any HTML string");
  assert.ok(!/signAndSend|signTransaction|sendTransaction|explorer\.solana/.test(SRC));
});

// ---------- The area, driven through a stand-in for the DOM ----------
// The area writes innerHTML and binds listeners on elements it finds by id or by a data attribute. This stand-in
// reads those elements back out of the markup, so a test can press a button the page really drew.
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[k]));
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function pane() {
  let html = "", kids = [];
  return {
    hidden: true,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = String(v); kids = [];
      let select = null;
      for (const m of html.matchAll(/<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
        const attrs = {};
        for (const a of m[2].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : unesc(a[2]);
        if (m[1] === "option") { if (select && ("selected" in attrs || select.value === null)) select.value = attrs.value; continue; }
        const el = {
          tag: m[1], id: attrs.id || "", dataset: {}, value: m[1] === "select" ? null : attrs.value ?? "", disabled: "disabled" in attrs, readOnly: false, isConnected: true, innerHTML: "", listeners: {},
          addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
          fire(type) { assert.equal(this.disabled, false, `${this.id || JSON.stringify(this.dataset)} is disabled`); return Promise.all((this.listeners[type] || []).map((fn) => fn({ preventDefault() {}, target: this }))); },
        };
        for (const [k, val] of Object.entries(attrs)) if (k.startsWith("data-")) el.dataset[camel(k.slice(5))] = val;
        if (m[1] === "select") select = el;
        if (el.id || Object.keys(el.dataset).length) kids.push(el);
      }
    },
    querySelectorAll(sel) { const key = camel(sel.match(/^\[data-([a-z-]+)\]$/)[1]); return kids.filter((k) => key in k.dataset); },
    byId: (id) => kids.find((k) => k.id === id) || null,
    act: (name, more = {}) => kids.find((k) => k.dataset.act === name && Object.entries(more).every(([a, b]) => k.dataset[a] === b)) || null,
    go: (page) => kids.find((k) => k.dataset.go === page) || null,
  };
}
function memory(data = {}) {
  return { data, getItem(k) { return Object.hasOwn(this.data, k) ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); }, removeItem(k) { delete this.data[k]; } };
}
// One mounted area with everything main.js would hand it. store: a memory() to stand in for localStorage, or
// undefined for a browser where storage throws. fixture: the text the fetch answers with, or null for a 404.
function mount({ fixture: text = RAW, store, resolve } = {}) {
  const view = pane(), modal = pane();
  const h = { view, modal, logs: [], said: [], recorded: [], leakOk: true, paused: false, fixture: text, state: { mode: "human", wallet: null, page: null, signing: false } };
  globalThis.fetch = async (url) => { assert.equal(url, "data/susu-demo.json"); return h.fixture === null ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => h.fixture }; };
  if (store) globalThis.localStorage = store; else delete globalThis.localStorage;
  const ctx = {
    $: (id) => (id === "view" ? view : id === "modal" ? modal : view.byId(id) || modal.byId(id)),
    esc: UI.esc, short: (a) => a, icon: () => "", state: h.state,
    log: (level, title, detail = "", actor) => { assert.ok(typeof actor === "string" && actor, `the actor is passed explicitly: ${title}`); h.logs.push({ level, title, detail, actor }); },
    note: (title, text2) => `${title} ${text2}`,
    navigate: (page) => { h.state.page = page; return h.area.render(page, {}); },
    openModal: (html) => { modal.innerHTML = html; modal.hidden = false; },
    closeModal: () => { modal.innerHTML = ""; modal.hidden = true; },
    passesLeakCheck: async (text2, where) => { assert.ok(typeof text2 === "string" && where); return h.leakOk; },
    guardPaste: (el, where) => { assert.ok(el && where, "a real input and a place name"); (h.guarded ||= []).push(el.id || "member"); },
    resolveName: resolve || (async () => { throw new Error("Could not reach Solana."); }),
    desktop: false, hasPhantom: () => false,
    agent: {
      name: () => "Scout", canAct: () => (h.paused ? { ok: false, reason: "Scout is paused by you." } : { ok: true, reason: "" }),
      say: (text2, cls) => h.said.push({ text: text2, cls }), record: (row) => h.recorded.push(row),
    },
  };
  h.area = UI.mountSusu(ctx);
  h.open = (page) => ctx.navigate(page);
  h.redraw = () => h.area.render(h.state.page, { silent: true }); // what main.js does after a mode or wallet change
  h.press = (name, more) => { const el = view.act(name, more); assert.ok(el, `no ${name} button on ${h.state.page}`); return el.fire("click"); };
  h.task = async (text2) => { const box = view.byId("suAgentTask"); assert.ok(box, "no agent task box"); box.value = text2; await view.byId("suAgentForm").fire("submit"); };
  h.last = (n = 1) => h.logs.slice(-n);
  return h;
}
const DASH = "rf3://susu/family-circle";

test("area: the seam, the first render, the tab title and storage that is unavailable", async () => {
  const h = mount();
  assert.equal(h.area.prefix, "rf3://susu");
  assert.equal(typeof h.area.render, "function");
  assert.equal(h.area.title(DASH), "Susu circle", "before the fixture is read");
  await h.open(DASH);
  clean(h.view.innerHTML, "area dashboard");
  assert.ok(h.view.innerHTML.includes("Your agent will pay 50 USDC to Family Circle on Oct 14."));
  assert.ok(h.view.innerHTML.includes("Storage unavailable. Demo progress lasts until this page reloads."), "storage unavailable has its own copy");
  assert.equal(h.area.title(DASH), "Family Circle");
  assert.equal(h.area.title(`${DASH}/join`), "Join · Family Circle");
  assert.equal(h.logs.length, 0, "drawing the dashboard writes no log row");
});

test("area: OK on the pre-notice logs 'You said OK' with actor YOU and the banner says so", async () => {
  const h = mount({ store: memory() });
  await h.open(DASH);
  assert.ok(!h.view.innerHTML.includes("Storage unavailable"));
  await h.press("notice-ok");
  assert.deepEqual(h.last()[0], { level: "ok", title: "You said OK", detail: "Said OK. The agent pays 50 USDC to Family Circle on Oct 14.", actor: "YOU" });
  assert.ok(h.view.innerHTML.includes("Agent will pay Oct 14. You said OK on Oct 13.") && !h.view.act("notice-ok"));
  // Progress is stored under rf3.susu, and a second mount reads it back.
  assert.deepEqual(Object.keys(globalThis.localStorage.data), ["rf3.susu"]);
  const again = mount({ store: globalThis.localStorage });
  await again.open(DASH);
  assert.ok(again.view.innerHTML.includes("Agent will pay Oct 14. You said OK on Oct 13."));
  // A hand edit to the stored state is set aside and the page says so.
  const edited = memory({ "rf3.susu": globalThis.localStorage.data["rf3.susu"].replace(/Oct 14/, "Oct 15") });
  const third = mount({ store: edited });
  await third.open(DASH);
  assert.ok(third.view.innerHTML.includes("Stored progress was set aside. Stored circle state fails its checksum") && third.view.act("notice-ok"));
});

test("area: Pause at the pre-notice, then the allowance page resumes and revokes", async () => {
  const h = mount({ store: memory() });
  await h.open(DASH);
  await h.press("notice-pause");
  assert.equal(h.last()[0].title, "Agent paused");
  assert.ok(h.view.innerHTML.includes("Your agent is paused."));
  await h.open(`${DASH}/agent`);
  assert.ok(h.view.innerHTML.includes("allowance paused"));
  await h.press("allow-resume");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor], ["Agent resumed", "YOU"]);
  // Revoke opens a confirm sheet. Without a wallet its button is off and the demo note shows.
  await h.press("allow-revoke");
  assert.equal(h.modal.hidden, false);
  assert.ok(h.modal.innerHTML.includes("Revoke (mock)") && h.modal.innerHTML.includes("No wallet connected.") && h.modal.byId("suConfirm").disabled);
  h.state.wallet = W;
  await h.press("allow-revoke");
  await h.modal.byId("suConfirm").fire("click");
  assert.equal(h.modal.hidden, true);
  assert.equal(h.last()[0].title, "Allowance revoked");
  assert.ok(h.view.innerHTML.includes("allowance revoked") && h.view.innerHTML.includes("Allowance revoked. This is a mock signature."));
  // Turning it on again goes through the confirm sheet with the exception sentence.
  await h.press("allow-on");
  assert.ok(h.modal.innerHTML.includes(S.ALLOWANCE_EXCEPTION) && h.modal.innerHTML.includes("Confirm allowance (mock)"));
  await h.modal.byId("suConfirm").fire("click");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor], ["Allowance set", "YOU"]);
  assert.ok(h.view.innerHTML.includes("allowance active"));
  // In Agent mode the press is refused with the reason and a block row under the agent's name. No sheet opens.
  h.state.mode = "agent";
  await h.redraw();
  await h.press("allow-pause");
  assert.deepEqual(h.last()[0], { level: "block", title: "Allowance refused", detail: "Only a person sets, pauses or revokes an allowance. Switch to You.", actor: "SCOUT" });
  assert.ok(h.view.innerHTML.includes("allowance active") && h.modal.hidden);
});

test("area: Next day walks the fixture, logs each row with its own actor, and only a person moves the clock", async () => {
  const h = mount({ store: memory() });
  await h.open(DASH);
  await h.press("next-day");
  assert.deepEqual(h.logs.map((l) => [l.level, l.title, l.actor]), [["ok", "Collateral topped up", "dana.sns"], ["ok", "Contribution paid", "SCOUT"]]);
  assert.ok(h.view.innerHTML.includes("today Oct 14") && h.view.innerHTML.includes("Today is Oct 14 on the mock clock. 2 new rows in the security log."));
  await h.press("next-day");
  assert.deepEqual(h.last()[0], { level: "warn", title: "Contribution late", detail: "dana.sns is late for round 2. 48 hours of grace end on Oct 16.", actor: "PROGRAM" });
  assert.ok(h.view.innerHTML.includes("late · 48 h grace left"));
  await h.press("next-day");
  assert.ok(h.view.innerHTML.includes("Nothing happened overnight.") && h.view.innerHTML.includes("late · 24 h grace left"));
  await h.press("next-day");
  assert.deepEqual(h.last(3).map((l) => l.title), ["Drawn from collateral", "Pot ready", "Round opened"]);
  assert.ok(h.view.innerHTML.includes("Pot unclaimed since Oct 17"));
  h.state.mode = "agent";
  await h.redraw();
  assert.equal(h.view.act("next-day").disabled, true);
  assert.equal(h.view.byId("suViewer").disabled, true);
});

test("area: Viewing as plays the other members, and Reset demo goes back to the fixture", async () => {
  const h = mount({ store: memory() });
  h.state.wallet = W;
  await h.open(DASH);
  const pick = (seat) => { const el = h.view.byId("suViewer"); el.value = seat; return el.fire("change"); };
  assert.equal(h.view.byId("suViewer").value, "you");
  await pick("dana");
  assert.deepEqual(h.last()[0], { level: "info", title: "Viewing as", detail: "dana.sns in Family Circle", actor: "YOU" });
  assert.ok(h.view.innerHTML.includes("Top up 50 USDC of collateral before round 2 is due on Oct 14 or leave.") && h.view.innerHTML.includes("Before Oct 14 you need 100 USDC."));
  await pick("");
  assert.ok(h.view.innerHTML.includes("This wallet is not a member of Family Circle.") && h.view.innerHTML.includes("No seat"));
  await pick("ghost");
  assert.ok(h.view.innerHTML.includes("That seat is not part of this circle."));
  await pick("you");
  await h.press("notice-ok");
  await h.press("reset");
  assert.ok(h.view.act("notice-ok"), "the pre-notice waits again");
  assert.equal(h.last()[0].title, "Demo reset");
  assert.deepEqual(globalThis.localStorage.data, {});
});

test("area: the agent panel pays the open round once, and the grid cell reads paid by agent", async () => {
  const h = mount({ store: memory() });
  // Oct 13 is the notice day. The person connects a wallet and says OK. That is the review step before the agent pays.
  h.state.wallet = W;
  await h.open(DASH);
  await h.press("notice-ok");
  h.state.mode = "agent";
  await h.redraw();
  assert.equal(h.view.byId("suAgentTask").value, "Pay round 2 of Family Circle");
  assert.ok(h.guarded.includes("suAgentTask"), "pastes into the task box are held for the leak check");
  await h.task("Pay round 2 of Family Circle");
  assert.deepEqual(h.said.map((s) => s.cls), ["", "t-ok", ""]);
  assert.equal(h.said[1].text, "Circle program: PAID. 50 USDC to Family Circle for round 2.");
  assert.deepEqual(h.logs.map((l) => [l.level, l.title, l.actor]), [["ok", "You said OK", "YOU"], ["info", "Agent task", "SCOUT"], ["ok", "Contribution paid", "SCOUT"]]);
  assert.deepEqual(h.recorded, [{ tool: "rf3.contribute_circle", summary: "Paid 50 USDC to Family Circle, round 2", outcome: "paid" }]);
  assert.match(h.view.innerHTML, /nia\.sns<small>slot 2 · you<\/small><\/th><td>.*?<\/td><td class="su-now"><span class="chip chip-sky" title="Oct 13">paid by agent/);
  assert.ok(h.view.innerHTML.includes("Circle program: PAID."), "the lines stay on the page after the redraw");
  // A second contribution for the same round is refused and nothing moves.
  await h.task("Pay round 2 of Family Circle");
  assert.equal(h.said.at(-1).text, "Circle program: REFUSED. Round 2 is already paid. A second contribution for the same round is refused.");
  assert.deepEqual([h.last()[0].level, h.last()[0].title, h.last()[0].actor], ["block", "Contribution refused", "SCOUT"]);
  assert.equal(h.recorded.at(-1).outcome, "refused");
  // The wrong round is refused while round 2 is open.
  await h.task("pay round 3 of Family Circle");
  assert.match(h.said.at(-1).text, /^Circle program: REFUSED\. Round 2 is open\./);
});

test("area: 'Withdraw 100 USDC from Family Circle' prints BLOCKED and writes a block row under the agent's name", async () => {
  const h = mount({ store: memory() });
  h.state.mode = "agent";
  await h.open(DASH);
  const before = S.overview(S.deserialize(JSON.parse(UI.packStore([fixture()])).circles[0]), "you").vault;
  await h.view.querySelectorAll("[data-task]").find((b) => b.dataset.task.startsWith("Withdraw")).fire("click");
  assert.equal(h.view.byId("suAgentTask").value, "Withdraw 100 USDC from Family Circle");
  await h.view.byId("suAgentForm").fire("submit");
  assert.deepEqual(h.said.at(-1), { text: `Circle program: BLOCKED. ${S.NO_WITHDRAW}`, cls: "t-red" });
  assert.deepEqual(h.last()[0], { level: "block", title: "Withdrawal refused", detail: S.NO_WITHDRAW, actor: "SCOUT" });
  assert.deepEqual(h.recorded.at(-1), { tool: "circle instruction", summary: "withdraw asked for Family Circle", outcome: "blocked" });
  const stored = S.deserialize(JSON.parse(globalThis.localStorage.data["rf3.susu"]).circles[0]);
  assert.equal(S.overview(stored, "you").vault, before, "nothing left the vault");
  assert.deepEqual(stored.history.at(-1), { day: "2026-10-13", actor: "SCOUT", kind: "block", text: S.NO_WITHDRAW, member: "you" });
  // The withdrawal page shows that attempt.
  await h.redraw();
  h.state.page = `${DASH}/withdraw`;
  await h.area.render(h.state.page, { silent: true });
  assert.ok(h.view.innerHTML.includes("Scout, an agent, for nia.sns") && h.view.innerHTML.includes("Withdraw 100 USDC from Family Circle"));
  // Every other circle instruction is refused with a block row. Nothing is guessed.
  await h.open(DASH);
  for (const [text, reason] of [["Join Family Circle for me", "Agents never join a circle."], ["Claim the pot from Family Circle", "Agents never claim a pot."], ["Set my allowance for Family Circle to 500 USDC", "Only a person sets, pauses or revokes an allowance."], ["Change the terms of Family Circle", "Terms lock at round 1."]]) {
    const rows = h.logs.length;
    await h.task(text);
    assert.ok(h.said.at(-1).text.startsWith(`Circle program: BLOCKED. ${reason}`), text);
    assert.deepEqual([h.last()[0].level, h.last()[0].actor], ["block", "SCOUT"], text);
    assert.equal(h.logs.length, rows + 2, "the task row and one block row");
  }
  await h.task("family circle please");
  assert.equal(h.said.at(-1).cls, "t-warn");
  assert.deepEqual([h.last()[0].level, h.last()[0].title], ["warn", "Agent could not read that circle instruction"]);
  await h.task("What is due?");
  assert.deepEqual(h.said.at(-1), { text: "50 USDC for round 2 of 4, due Oct 14.", cls: "t-bone" });
  await h.task("Who is next?");
  assert.equal(h.said.at(-1).text, "nia.sns takes the round 2 pot. kofi.sns takes round 3.");
  await h.task("Send 0.5 SOL to toly.sns");
  assert.ok(h.said.at(-1).text.startsWith("That is outside Family Circle."));
  assert.equal(stored.rounds[1].payments.length, 2);
});

test("area: the agent runs nothing when it may not act, when the leak check blocks, or when the person took over", async () => {
  const h = mount({ store: memory() });
  h.state.mode = "agent";
  await h.open(DASH);
  h.paused = true;
  await h.task("Pay round 2 of Family Circle");
  assert.deepEqual(h.said, [{ text: "Scout is paused by you. Nothing ran.", cls: "t-warn" }]);
  assert.deepEqual(h.logs.map((l) => [l.level, l.title, l.actor]), [["info", "Scout did not run", "YOU"]]);
  assert.deepEqual(h.recorded, []);
  h.paused = false;
  h.leakOk = false;
  await h.task("Pay round 2 of Family Circle");
  assert.equal(h.said.length, 1, "blocked by the leak check before anything is read");
  assert.equal(h.view.byId("suAgentTask").value, "", "blocked text does not stay in the box");
  assert.equal(h.logs.length, 1, "and nothing was logged or run for it");
  h.leakOk = true;
  // The person switches to You while the leak check is still running.
  const box = h.view.byId("suAgentTask"), form = h.view.byId("suAgentForm");
  box.value = "Pay round 2 of Family Circle";
  const running = form.fire("submit");
  h.state.mode = "human";
  await running;
  assert.equal(h.said.length, 1);
  assert.ok(!globalThis.localStorage.data["rf3.susu"], "nothing was stored, because nothing changed");
});

test("area: in Agent mode Pay now refuses with 'Switch to You to pay by hand', and a person pays on the sheet", async () => {
  const h = mount({ store: memory() });
  h.state.mode = "agent";
  await h.open(DASH);
  await h.press("pay-now");
  assert.deepEqual(h.last()[0], { level: "block", title: "Pay by hand refused", detail: "Switch to You to pay by hand.", actor: "SCOUT" });
  assert.ok(h.view.innerHTML.includes('<div class="notice notice-red">Switch to You to pay by hand.</div>'));
  assert.equal(h.state.page, DASH);
  h.state.mode = "human";
  await h.redraw();
  await h.press("pay-now");
  assert.equal(h.state.page, `${DASH}/pay`);
  assert.equal(h.view.act("pay").disabled, true, "Approve (mock) is off without a wallet");
  h.state.wallet = W;
  await h.redraw();
  await h.press("pay");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor, h.last()[0].detail], ["Contribution paid", "YOU", "Paid 50 USDC by hand for round 2. The agent has nothing to pay this round."]);
  assert.ok(h.view.innerHTML.includes("Paid 50 USDC by hand for round 2 of 4. This is a mock receipt. Nothing was sent.") && h.view.innerHTML.includes("You paid by hand on Oct 13."));
  await h.press("pay");
  assert.deepEqual([h.last()[0].level, h.last()[0].title], ["block", "Pay by hand refused"]);
  assert.ok(h.view.innerHTML.includes("Round 2 is already paid. You paid by hand on Oct 13."));
});

test("area: the withdrawal page refuses a person, the organizer and an agent, each with a block row", async () => {
  const h = mount({ store: memory() });
  h.state.wallet = W;
  await h.open(DASH);
  await h.view.go(`${DASH}/withdraw`).fire("click");
  assert.equal(h.state.page, `${DASH}/withdraw`);
  assert.deepEqual(h.logs, [{ level: "block", title: "Withdrawal refused", detail: S.NO_WITHDRAW, actor: "YOU" }]);
  for (const part of ["Withdrawal refused", "you (nia.sns)", "250 USDC, the whole vault, to 86xC…2MMY", "Nothing moved."]) assert.ok(h.view.innerHTML.includes(part), part);
  await h.redraw();
  assert.equal(h.logs.length, 1, "a redraw after a mode or wallet change is not a second attempt");
  await h.press("withdraw-again");
  assert.equal(h.logs.length, 2);
  // The organizer's seat gets the same refusal, with the line about its power.
  await h.open(DASH);
  const pick = h.view.byId("suViewer");
  pick.value = "amara";
  await pick.fire("change");
  await h.open(`${DASH}/withdraw`);
  assert.equal(h.last()[0].detail, `${S.NO_WITHDRAW} The organizer has no power after creation.`);
  assert.ok(h.view.innerHTML.includes("you, the organizer (amara.sns)"));
  // An agent that opens the page is refused under its own name. A paused agent runs nothing.
  h.state.mode = "agent";
  await h.open(`${DASH}/withdraw`);
  assert.deepEqual([h.last()[0].level, h.last()[0].actor], ["block", "SCOUT"]);
  assert.ok(h.view.innerHTML.includes("Scout, an agent, for amara.sns"));
  h.paused = true;
  const rows = h.logs.length;
  await h.open(`${DASH}/withdraw`);
  assert.equal(h.logs.length, rows);
  assert.ok(h.view.innerHTML.includes("Scout is paused by you. Nothing ran.") && h.view.innerHTML.includes("No withdrawal was tried."));
});

test("area: the join page refuses an agent with a block row, and a fixture seat is already a member", async () => {
  const h = mount({ store: memory() });
  await h.open(`${DASH}/join`);
  assert.equal(h.logs.length, 0);
  assert.ok(h.view.innerHTML.includes("nia.sns is already a member of Family Circle.") && h.view.act("join").disabled && h.view.act("decline").disabled);
  h.state.mode = "agent";
  await h.open(`${DASH}/join`);
  assert.deepEqual(h.logs, [{ level: "block", title: "Join refused", detail: "Agents never join a circle or accept its terms. Switch to You.", actor: "SCOUT" }]);
  assert.ok(h.view.innerHTML.includes('<div class="notice notice-red">Agents never join a circle or accept its terms. Switch to You.</div>'));
  assert.equal(h.view.act("join").disabled, true, "a mock button needs a wallet in every mode");
  h.state.wallet = W;
  await h.redraw();
  assert.equal(h.logs.length, 1, "a redraw is not a second attempt");
  await h.press("join");
  assert.equal(h.logs.length, 2);
  assert.deepEqual([h.last()[0].level, h.last()[0].title, h.last()[0].actor], ["block", "Join refused", "SCOUT"]);
  // The same holds on the contribution sheet: the press is refused with the pay-by-hand reason.
  await h.open(`${DASH}/pay`);
  await h.press("pay");
  assert.deepEqual(h.last()[0], { level: "block", title: "Pay by hand refused", detail: "Switch to You to pay by hand.", actor: "SCOUT" });
});

test("area: claim the pot, top up, and leave, each on its own mock sheet", async () => {
  const h = mount({ store: memory() });
  h.state.wallet = W;
  await h.open(DASH);
  for (let i = 0; i < 4; i++) await h.press("next-day");
  await h.view.go(`${DASH}/payout`).fire("click");
  await h.press("claim");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor], ["Pot claimed", "YOU"]);
  assert.ok(h.view.innerHTML.includes("Claimed 200 USDC for round 2.") && h.view.innerHTML.includes("Pot paid on Oct 17."));
  assert.equal(h.view.act("claim").disabled, true, "a pot is paid once");
  // dana.sns was drawn and tops up.
  await h.open(DASH);
  const pick = h.view.byId("suViewer");
  pick.value = "dana";
  await pick.fire("change");
  await h.open(`${DASH}/missed`);
  assert.ok(h.view.innerHTML.includes("USDC is short. This seat holds 0 USDC and the top-up is 50 USDC."));
  await h.press("top-up");
  assert.deepEqual([h.last()[0].level, h.last()[0].title, h.last()[0].actor], ["block", "Top-up refused", "YOU"]);
  // kofi.sns leaves: the button carries the forfeited amount and the allowance is revoked on the way out.
  await h.open(DASH);
  const pick2 = h.view.byId("suViewer");
  pick2.value = "kofi";
  await pick2.fire("change");
  await h.open(`${DASH}/leave`);
  assert.ok(h.view.innerHTML.includes(">Leave and forfeit 50 USDC (mock)<"));
  await h.press("leave");
  assert.deepEqual(h.last(2).map((l) => l.title), ["Allowance revoked", "Left the circle"]);
  assert.ok(h.view.innerHTML.includes("kofi.sns left Family Circle."));
  await h.open(`${DASH}/history`);
  assert.ok(h.view.innerHTML.includes("Left Family Circle. Forfeited 50 USDC of collateral."));
});

test("area: a missing or malformed fixture has its own page, a later visit tries again, and a stale load draws nothing", async () => {
  const h = mount({ fixture: null });
  await h.open(DASH);
  assert.ok(h.view.innerHTML.includes("The demo circle is missing.") && h.view.innerHTML.includes("The file answered 404."));
  h.fixture = RAW.replace('"seats": 4', '"seats": 5');
  await h.open(DASH);
  assert.ok(h.view.innerHTML.includes("The demo circle is missing.") && h.view.innerHTML.includes("The member list does not match the seats"));
  h.fixture = RAW;
  // The person leaves while the fixture loads: the late answer must not draw over the page they went to.
  h.state.page = DASH;
  const slow = h.area.render(DASH, {});
  h.state.page = "rf3://home";
  h.view.innerHTML = "HOME";
  await slow;
  assert.equal(h.view.innerHTML, "HOME");
  await h.open(DASH);
  assert.ok(h.view.innerHTML.includes("Your agent will pay 50 USDC to Family Circle on Oct 14."));
});

test("area: susu home, the invite box and the 404", async () => {
  const h = mount({ store: memory() });
  await h.open("rf3://susu");
  clean(h.view.innerHTML, "area home");
  assert.ok(h.view.innerHTML.includes("Round 2 of 4 · 50 USDC monthly · 2 of 4 paid") && h.view.go(DASH));
  assert.ok(h.guarded.includes("suInvite"));
  const paste = async (text) => { h.view.byId("suInvite").value = text; await h.view.byId("suInviteForm").fire("submit"); };
  await paste("hello there");
  assert.ok(h.view.innerHTML.includes("That is not an invite RobotFac3 can read."));
  await paste("rf3://susu/other-circle/join");
  assert.ok(h.view.innerHTML.includes("This browser holds no circle with that id."));
  h.leakOk = false;
  await paste("rf3://susu/family-circle/join");
  assert.ok(h.view.innerHTML.includes("The leak check blocked that text.") && h.state.page === "rf3://susu");
  h.leakOk = true;
  await paste(" rf3://susu/family-circle/join ");
  assert.equal(h.state.page, `${DASH}/join`);
  h.state.mode = "agent";
  await h.open("rf3://susu");
  assert.ok(h.view.byId("suInvite").disabled && h.view.go("rf3://susu/new").disabled);
  for (const lost of ["rf3://susu/nope", "rf3://susu/family-circle/admin", "rf3://susu/a/b/c"]) {
    await h.open(lost);
    assert.ok(h.view.innerHTML.includes("RobotFac3 has no susu page at") && h.view.innerHTML.includes(lost), lost);
    assert.equal(h.area.title(lost), "No such susu page");
  }
});

test("area: start a circle with resolved names, review the terms, create it, and join the seat this wallet holds", async () => {
  const names = { "ama.sns": W2, "ben.sns": "7XGrbd3dmdesSR5vAu7siidiZ1YHyizzuPCQAnh2g2Lo" };
  const h = mount({ store: memory(), resolve: async (name) => { if (!names[name]) throw new Error("No such name."); return { target: names[name], display: name }; } });
  h.state.wallet = W;
  await h.open("rf3://susu/new");
  assert.ok(["suName", "suAmount", "member"].every((id) => h.guarded.includes(id)), "pastes into the form are held for the leak check");
  const type = async (el, text) => { el.value = text; await el.fire("input"); await el.fire("change"); };
  await type(h.view.byId("suName"), "Trio");
  const rows = () => h.view.querySelectorAll("[data-member]");
  await type(rows()[0], "ama.sns");
  await type(rows()[1], "nobody.sns");
  await h.press("row-mine");
  assert.equal(rows()[2].value, W);
  assert.ok(h.view.innerHTML.includes("resolved to 58Pw…JPkx") && h.view.innerHTML.includes("refused. No such name."));
  await h.view.byId("suCreate").fire("submit");
  assert.equal(h.state.page, "rf3://susu/new", "an unresolved name keeps the review closed");
  assert.ok(h.view.innerHTML.includes("Every .sns name must resolve before the terms can be reviewed."));
  await type(rows()[1], "ben.sns");
  await h.press("row-down", { i: "0" });
  assert.deepEqual(rows().map((el) => el.value), ["ben.sns", "ama.sns", W]);
  await h.press("row-up", { i: "2" });
  assert.deepEqual(rows().map((el) => el.value), ["ben.sns", W, "ama.sns"]);
  await h.view.byId("suCreate").fire("submit");
  assert.equal(h.state.page, "rf3://susu/new/review");
  for (const part of ["Create Trio", "Slot 2: 86xC…2MMY takes the pot on Dec 1.", ">Create and sign (mock)<"]) assert.ok(h.view.innerHTML.includes(part), part);
  await h.press("create");
  assert.equal(h.state.page, "rf3://susu/trio");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor], ["Circle created", "YOU"]);
  assert.ok(h.view.innerHTML.includes("forming · 0 of 3 seats") && h.view.innerHTML.includes("Created Trio."));
  assert.equal(h.view.byId("suViewer").value, "m2", "the organizer views as the seat this wallet holds");
  assert.equal(JSON.parse(globalThis.localStorage.data["rf3.susu"]).circles.length, 2);
  // Join the address seat with the wallet it was offered to.
  await h.view.go("rf3://susu/trio/join").fire("click");
  await h.press("join");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor], ["Joined the circle", "YOU"]);
  assert.ok(h.view.innerHTML.includes("Joined Trio at slot 2 of 3.") && h.view.innerHTML.includes("already holds a seat in Trio") === false);
  // A .sns seat resolves to another wallet, and this wallet already holds a seat, so Join stays off.
  await h.open("rf3://susu/trio");
  const pick = h.view.byId("suViewer");
  pick.value = "m1";
  await pick.fire("change");
  await h.open("rf3://susu/trio/join");
  await new Promise((r) => setTimeout(r, 0)); // the read-only name lookup answers, then the page draws again
  assert.ok(h.view.innerHTML.includes("This wallet already holds a seat in Trio.") && h.view.innerHTML.includes("This wallet differs from the invited name. ben.sns resolves to 7XGr…g2Lo."));
  assert.equal(h.view.act("join").disabled, true);
  // With another wallet connected the same seat is checked against that wallet, and still refused.
  h.state.wallet = W2;
  h.area.onWallet(W2);
  await h.redraw();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.view.innerHTML.includes("This wallet differs from the invited name.") && h.view.act("join").disabled);
  h.state.wallet = W;
  h.area.onWallet(W);
  await h.open("rf3://susu");
  assert.ok(h.view.go("rf3://susu/trio"), "the new circle is on the home page");
  // A name already taken here, or one that would take a page's address, is refused on the terms sheet.
  const start = async (name) => {
    await h.open("rf3://susu/new");
    await type(h.view.byId("suName"), name);
    await type(rows()[0], "ama.sns");
    await type(rows()[1], "ben.sns");
    await type(rows()[2], W);
    await h.view.byId("suCreate").fire("submit");
    await h.press("create");
  };
  for (const name of ["Trio", "New"]) {
    await start(name);
    assert.equal(h.state.page, "rf3://susu/new/review", name);
    assert.ok(h.view.innerHTML.includes(`A circle called ${name} cannot be kept here. Pick another name.`), name);
    await h.press("create-cancel");
    assert.equal(h.state.page, "rf3://susu/new");
  }
  assert.equal(JSON.parse(globalThis.localStorage.data["rf3.susu"]).circles.length, 2, "nothing was added");
  // In Agent mode the form is read-only and the terms sheet refuses with a block row under the agent's name.
  h.state.mode = "agent";
  await h.open("rf3://susu/new/review");
  await h.press("create");
  assert.deepEqual(h.last()[0], { level: "block", title: "Circle not started", detail: "Agents never start a circle. Switch to You.", actor: "SCOUT" });
  await h.open("rf3://susu/new");
  assert.ok(h.view.byId("suName").disabled && h.view.innerHTML.includes("Agents never start a circle. Switch to You."));
  h.state.mode = "human";
  // Blocked text is dropped from the form before the terms can be reviewed, and the reviewed terms go with it.
  await h.open("rf3://susu/new");
  h.leakOk = false;
  await h.view.byId("suCreate").fire("submit");
  h.leakOk = true;
  assert.equal(h.state.page, "rf3://susu/new");
  assert.ok(h.view.innerHTML.includes("The leak check blocked text in this form.") && h.view.byId("suName").value === "" && rows().every((el) => el.value === ""));
  await h.open("rf3://susu/new/review");
  assert.ok(h.view.innerHTML.includes("Nothing to review yet.") && !h.view.act("create"));
  // Reset removes circles started here.
  await h.open("rf3://susu/trio");
  await h.press("reset");
  assert.equal(h.state.page, "rf3://susu");
  assert.ok(!h.view.go("rf3://susu/trio"));
});

test("area: every page draws for every seat on every mock day until the circle is complete", async () => {
  const h = mount({ store: memory() });
  h.state.wallet = W;
  const seats = ["you", "amara", "kofi", "dana", ""], subs = ["", "/join", "/agent", "/pay", "/payout", "/missed", "/history", "/leave", "/withdraw"];
  let days = 0;
  for (; days < 80; days++) {
    for (const seat of seats) {
      await h.open(DASH);
      const pick = h.view.byId("suViewer");
      pick.value = seat;
      await pick.fire("change");
      for (const sub of subs) {
        await h.open(`${DASH}${sub}`);
        assert.ok(!h.view.innerHTML.includes("failed its checks"), `day ${days}, seat ${seat || "visitor"}, page ${sub || "/"}`);
        clean(h.view.innerHTML, `day ${days}, seat ${seat || "visitor"}, page ${sub || "/"}`);
      }
    }
    await h.open(DASH);
    if (h.view.innerHTML.includes(">complete<")) break;
    await h.press("next-day");
  }
  assert.equal(days, 65, "Oct 13 to Dec 17");
  assert.ok(h.view.innerHTML.includes("All 4 rounds of Family Circle are finished.") && h.view.innerHTML.includes("today Dec 17"));
  assert.ok(!h.logs.some((l) => l.title === "Circle page refused" || l.title === "Circle action refused"));
  // The stored copy still passes the engine's checks and descends from the fixture.
  const again = mount({ store: globalThis.localStorage });
  await again.open(DASH);
  assert.ok(again.view.innerHTML.includes("today Dec 17") && !again.view.innerHTML.includes("Stored progress was set aside"));
});

// ---------- Review fixes (2026-10-12): the wiring for each confirmed finding ----------
const storedCircle = (i = 0) => S.deserialize(JSON.parse(globalThis.localStorage.data["rf3.susu"]).circles[i]);
const tick = () => new Promise((r) => setTimeout(r, 5));
const NIA_CELL = /nia\.sns<small>slot 2 · you<\/small><\/th><td>.*?<\/td><td class="su-now"><span class="chip (chip-[a-z]+)"[^>]*>([^<]+)</;

test("area review 1: Next day pays nothing under Scout's name while the Agents engine holds Scout", async () => {
  const h = mount({ store: memory() });
  await h.open(DASH);
  h.paused = true;
  await h.press("next-day");
  assert.deepEqual(h.logs.map((l) => [l.level, l.title, l.actor]), [["ok", "Collateral topped up", "dana.sns"], ["warn", "Agent stopped", "SCOUT"]]);
  assert.equal(h.last()[0].detail, "Stopped for nia.sns. The agent is held in the Agents panel. Nothing moved. Pay by hand.");
  assert.deepEqual([storedCircle().today, S.cell(storedCircle(), "you", 2).state, storedCircle().members[1].usdc], ["2026-10-14", "due", "120"]);
  assert.deepEqual(h.view.innerHTML.match(NIA_CELL).slice(1), ["chip-bone", "unpaid"]);
  assert.ok(h.view.innerHTML.includes("<b>Agent stopped.</b> Stopped for nia.sns. The agent is held in the Agents panel. Nothing moved. Pay by hand.") && h.view.act("pay-now"));
  // The same press with Scout free to act pays, as before.
  const free = mount({ store: memory() });
  await free.open(DASH);
  await free.press("next-day");
  assert.deepEqual(free.view.innerHTML.match(NIA_CELL).slice(1), ["chip-sky", "paid by agent"]);
});

test("area review 2 and 3: the agent panel needs a connected wallet and the pre-notice OK before it pays", async () => {
  const h = mount({ store: memory() });
  h.state.mode = "agent";
  await h.open(DASH);
  // No wallet is connected and the page says so. The agent is refused like every mock sheet.
  assert.ok(h.view.innerHTML.includes("No wallet connected."));
  await h.task("Pay round 2 of Family Circle");
  assert.deepEqual(h.said.at(-1), { text: "Circle program: REFUSED. No wallet is connected. Connect Phantom first.", cls: "t-red" });
  assert.deepEqual([h.last()[0].level, h.last()[0].title, h.last()[0].actor], ["block", "Contribution refused", "SCOUT"]);
  // A wallet is connected and the pre-notice is unanswered: the agent stops, the banner stays, the cell stays unpaid.
  h.state.wallet = W;
  await h.redraw();
  await h.task("Pay round 2 of Family Circle");
  assert.deepEqual(h.said.at(-1), { text: "Stopped. The pre-notice for round 2 waits for your answer. Nothing moved.", cls: "t-warn" });
  assert.deepEqual([h.last()[0].level, h.last()[0].title, h.last()[0].actor], ["warn", "Agent stopped", "SCOUT"]);
  assert.equal(h.recorded.at(-1).outcome, "stopped");
  assert.ok(h.view.innerHTML.includes("This is your review step.") && h.view.act("notice-ok"));
  assert.deepEqual(h.view.innerHTML.match(NIA_CELL).slice(1), ["chip-bone", "unpaid"]);
  // The person says OK. The stop it answers leaves the page, and the agent then pays.
  h.state.mode = "human";
  await h.redraw();
  assert.ok(h.view.innerHTML.includes("<b>Agent stopped.</b> The pre-notice for round 2 waits for your answer."));
  await h.press("notice-ok");
  assert.ok(!h.view.innerHTML.includes("<b>Agent stopped.</b>") && h.view.innerHTML.includes("You said OK on Oct 13."));
  h.state.mode = "agent";
  await h.redraw();
  await h.task("Pay round 2 of Family Circle");
  assert.equal(h.said.at(-2).text, "Circle program: PAID. 50 USDC to Family Circle for round 2.");
  assert.deepEqual(h.logs.filter((l) => ["You said OK", "Contribution paid"].includes(l.title)).map((l) => l.actor), ["YOU", "SCOUT"]);
  assert.deepEqual(h.view.innerHTML.match(NIA_CELL).slice(1), ["chip-sky", "paid by agent"]);
  // Round 3 opens on Oct 17. Its notice goes out on Nov 13, so the preset is refused 28 days early.
  h.state.mode = "human";
  await h.redraw();
  for (let i = 0; i < 4; i++) await h.press("next-day");
  h.state.mode = "agent";
  await h.redraw();
  assert.equal(h.view.byId("suAgentTask").value, "Pay round 3 of Family Circle");
  await h.task("Pay round 3 of Family Circle");
  assert.equal(h.said.at(-1).text, "Circle program: REFUSED. The agent pays after the pre-notice. The notice for round 3 goes out on Nov 13.");
  assert.equal(storedCircle().rounds[2].payments.length, 0);
});

test("area review 5: Decline needs the wallet the invited name resolves to, like Join", async () => {
  const trio = ok(S.createCircle({ ...TRIO, members: [W, "bob.sns", "cy.sns"] }, human("m1"), "2026-10-13"));
  const names = { "bob.sns": W2 };
  const open = async (wallet) => {
    const h = mount({ store: memory({ "rf3.susu": UI.packStore([fixture(), trio]) }), resolve: async (name) => { await new Promise((r) => setTimeout(r, 0)); if (!names[name]) throw new Error("No such name."); return { target: names[name] }; } });
    h.state.wallet = wallet;
    await h.open("rf3://susu/trio");
    const pick = h.view.byId("suViewer");
    pick.value = "m2";
    await pick.fire("change");
    await h.open("rf3://susu/trio/join");
    await tick(); // the read-only name lookup answers, then the page draws again
    return h;
  };
  // No wallet connected: Join and Decline are both off.
  let h = await open(null);
  assert.ok(h.view.act("join").disabled && h.view.act("decline").disabled, "no wallet");
  // A wallet the invited name does not resolve to: the page says so and both stay off.
  h = await open(W);
  assert.ok(h.view.innerHTML.includes("This wallet differs from the invited name. bob.sns resolves to 58Pw…JPkx."));
  assert.ok(h.view.act("join").disabled && h.view.act("decline").disabled, "another wallet");
  // The invited wallet: both are on.
  h = await open(W2);
  assert.ok(h.view.innerHTML.includes("bob.sns resolves to this wallet."));
  assert.ok(!h.view.act("join").disabled && !h.view.act("decline").disabled, "the invited wallet");
  // Phantom changes account after the page was drawn. The press is checked against the wallet connected now.
  h.state.wallet = W;
  h.area.onWallet(W);
  await h.press("decline");
  assert.ok(h.view.innerHTML.includes("RobotFac3 has not matched bob.sns to this wallet. Decline stays off."));
  assert.equal(storedCircle(1).members[1].status, "invited");
  assert.equal(h.logs.some((l) => l.title === "Invite declined"), false);
  await tick();
  assert.ok(h.view.act("decline").disabled, "the redraw for the new wallet turns it off");
  // Back on the invited wallet the decline goes through, with actor YOU.
  h.state.wallet = W2;
  h.area.onWallet(W2);
  await h.redraw();
  await tick();
  await h.press("decline");
  assert.deepEqual([h.last()[0].title, h.last()[0].actor, storedCircle(1).members[1].status], ["Invite declined", "YOU", "declined"]);
});

test("area review 6: the log names each allowance's own agent, and Scout cannot pay from a seat set for Hermes", async () => {
  const h = mount({ store: memory() });
  h.state.wallet = W;
  await h.open(DASH);
  const pick = h.view.byId("suViewer");
  pick.value = "kofi";
  await pick.fire("change");
  for (let i = 0; i < 31; i++) await h.press("next-day");
  assert.ok(h.view.innerHTML.includes("today Nov 13") && h.view.innerHTML.includes("Your agent will pay 50 USDC to Family Circle on Nov 14."));
  await h.press("notice-ok");
  h.state.mode = "agent";
  await h.redraw();
  await h.task("Pay round 3 of Family Circle");
  assert.equal(h.said.at(-1).text, "Circle program: REFUSED. This allowance is set for Hermes.");
  assert.deepEqual([h.last()[0].level, h.last()[0].actor, S.cell(storedCircle(), "kofi", 3).state], ["block", "SCOUT", "due"]);
  h.state.mode = "human";
  await h.redraw();
  await h.press("next-day");
  const rows = h.logs.filter((l) => /^Notice to .* on Nov 14\.$|for round 3 of 4 under/.test(l.detail)).map((l) => [l.title, l.actor, l.detail.match(/(nia|kofi)\.sns/)[1]]);
  assert.deepEqual(rows, [["Pre-notice sent", "SCOUT", "nia"], ["Pre-notice sent", "HERMES", "kofi"], ["Contribution paid", "SCOUT", "nia"], ["Contribution paid", "HERMES", "kofi"]]);
});
