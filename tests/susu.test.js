// The susu circle mock engine (src/susu.js): one or more tests per rule S1 to S15, plus the named cases.
// Nothing here touches a chain or a wallet. The addresses are public ones already used elsewhere in the tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/susu.js";

const RAW = readFileSync(new URL("../data/susu-demo.json", import.meta.url), "utf8");
const SRC = readFileSync(new URL("../src/susu.js", import.meta.url), "utf8");
const W = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const W2 = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const W3 = "7XGrbd3dmdesSR5vAu7siidiZ1YHyizzuPCQAnh2g2Lo";
const CYRILLIC_A = String.fromCharCode(0x430);
const REQ = { circle: "family-circle", round: 2, amount: "50" };

// Every circle the tests hand to the engine is frozen, so any write to its input throws.
function freeze(v) {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
const fixture = () => freeze(S.loadFixture(RAW));
const tweak = (edit) => { const raw = JSON.parse(RAW); edit(raw); return raw; };
const human = (memberId = "you", wallet = W) => ({ mode: "human", wallet, memberId, agentName: "Scout" });
const agent = (memberId = "you", agentName = "Scout") => ({ mode: "agent", wallet: W, memberId, agentName });
const seat = (c, id) => c.members.find((m) => m.id === id);
// Every circle the engine hands back must itself pass the shape check, so serialize runs on each one.
const ok = (r) => { assert.equal(r.ok, true, r.reason); S.serialize(r.circle); return freeze(r.circle); };
const walk = (c, days, who = human()) => { for (let i = 0; i < days; i++) c = ok(S.nextDay(c, who)); return c; };
// Everything that holds money or decides who gets it. A refusal must leave this identical.
const ledger = (c) => JSON.stringify([c.today, c.status, c.members, c.rounds]);
function refused(before, r, verdict = "refused") {
  assert.equal(r.ok, false);
  assert.equal(r.verdict, verdict);
  assert.ok(typeof r.reason === "string" && r.reason.length > 10, "a plain reason");
  assert.equal(ledger(r.circle), ledger(before), `nothing moves: ${r.reason}`);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, verdict === "stopped" ? "stop" : "block");
  assert.equal(r.rows[0].text, r.reason);
  assert.equal(r.circle.history.length, before.history.length + 1);
  S.serialize(r.circle);
  return r;
}
const TRIO = { name: "Trio", amount: "50", cadence: "monthly", seats: 3, start: "2026-11-01", order: "fixed", members: ["ama.sns", "ben.sns", W3] };
const forming = () => ok(S.createCircle(TRIO, human("m1"), "2026-10-13"));
const yes = { accept: true, otherCircles: [] };
function trio() {
  let c = forming();
  for (const [id, wallet] of [["m1", W], ["m2", W2], ["m3", W3]]) c = ok(S.join(c, human(id, wallet), yes));
  return c;
}
// The same checksum the engine writes, so a test can forge an envelope whose checksum is right.
function box(state) {
  const s = JSON.stringify(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `{"v":1,"sum":"${(h >>> 0).toString(16).padStart(8, "0")}","state":${s}}`;
}
const total = (c) => c.members.reduce((sum, m) => sum + S.parseUsdc(m.usdc), 0n) + S.parseUsdc(S.overview(c, "you").vault);

// ---------- S1 Fixture ----------
test("susu S1: the fixture is Family Circle on 2026-10-13, round 2 open, pre-notice due today", () => {
  const c = fixture();
  assert.equal(c.name, "Family Circle");
  assert.deepEqual([c.amount, c.cadence, c.seats, c.rounds.length, c.collateralRounds, c.graceHours, c.order, c.today], ["50", "monthly", 4, 4, 1, 48, "fixed", "2026-10-13"]);
  assert.deepEqual(c.members.map((m) => m.id), ["amara", "you", "kofi", "dana"]);
  assert.deepEqual(c.members.map((m) => m.slot), [1, 2, 3, 4]);
  assert.ok(c.members.every((m) => /^[a-z0-9_-]+\.sns$/.test(m.name)));
  assert.equal(seat(c, "dana").name, "dana.sns");
  // No real addresses: every seat carries the mock label, and the file holds nothing shaped like an address.
  assert.ok(c.members.every((m) => m.wallet === S.MOCK_WALLET && m.wallet === "mock member"));
  assert.equal(/[1-9A-HJ-NP-Za-km-z]{32,}/.test(RAW), false);
  for (const m of c.members) { assert.ok(S.parseUsdc(m.usdc) >= 0n); assert.match(m.feeSol, /^\d+(\.\d{1,9})?$/); }

  const [r1, r2] = c.rounds;
  assert.deepEqual([r1.due, r1.state, r1.pot.state, r1.pot.amount], ["2026-09-14", "settled", "paid", "200"]);
  assert.equal(S.cell(c, "dana", 1).state, "drawn");
  assert.deepEqual([seat(c, "dana").collateral, S.topUpStatus(c, "dana").pending, S.topUpStatus(c, "dana").owed], ["0", true, "50"]);
  assert.equal(S.topUpStatus(c, "dana").together, "Before Oct 14 you need 100 USDC.");

  assert.deepEqual([r2.due, r2.state, r2.payments.length], ["2026-10-14", "open", 2]);
  assert.equal(r2.payments.filter((p) => p.by === "agent").length, 1);
  assert.equal(S.cell(c, "kofi", 2).label, "paid by agent");
  assert.equal(S.cell(c, "you", 2).state, "due");
  assert.equal(seat(c, "you").allowance.state, "active");
  assert.equal(S.preNotice(c, "you").text, "Your agent will pay 50 USDC to Family Circle on Oct 14.");
  const o = S.overview(c, "you");
  assert.deepEqual([o.round.n, o.round.paid, o.round.seats, o.vault, o.mock, o.chain], [2, 2, 4, "250", "mock · no chain", "Solana"]);
  assert.equal(S.grid(c).rows.length, 4);
  assert.equal(S.grid(c).rows[3].cells.length, 4);
});

test("susu S1: loadFixture refuses anything unexpected with a plain error", () => {
  const bad = [
    ["an extra field", (f) => { f.admin = "me"; }],
    ["a missing field", (f) => { delete f.graceHours; }],
    ["a number for the amount", (f) => { f.amount = 50; }],
    ["a second spelling of the amount", (f) => { f.amount = "50.0"; }],
    ["a date that does not exist", (f) => { f.today = "2026-02-30"; }],
    ["a clock before the members joined", (f) => { f.today = "2026-09-01"; }],
    ["a round left open after its grace", (f) => { f.today = "2026-10-20"; }],
    ["an unknown member status", (f) => { f.members[3].status = "banned"; }],
    ["a malformed wallet", (f) => { f.members[0].wallet = "0xabc"; }],
    ["a repeated member", (f) => { f.members[3].name = "amara.sns"; }],
    ["a look-alike name", (f) => { f.members[3].name = `d${CYRILLIC_A}na.sns`; }],
    ["a seat out of order", (f) => { f.members[3].slot = 1; }],
    ["a payment from a stranger", (f) => { f.rounds[1].payments[0].member = "mallory"; }],
    ["two payments from one seat", (f) => { f.rounds[1].payments[1].member = "amara"; }],
    ["a payment of another amount", (f) => { f.rounds[1].payments[0].amount = "5"; }],
    ["a pot that does not add up", (f) => { f.rounds[0].pot.amount = "2000"; }],
    ["a due date off the schedule", (f) => { f.rounds[1].due = "2026-10-20"; }],
    ["a changed recipient", (f) => { f.rounds[1].recipient = "dana"; }],
    ["a second open round", (f) => { f.rounds[2].state = "open"; }],
    ["more collateral than the rule", (f) => { f.members[0].collateral = "500"; }],
    ["another grace", (f) => { f.graceHours = 0; }],
    ["another chain", (f) => { f.chain = "ethereum"; }],
    ["a circle that is not the mock", (f) => { f.mock = false; }],
    ["an agent that takes the name YOU", (f) => { f.members[1].allowance.agent = "You"; }],
    ["a direction-override character in a row", (f) => { f.history[0].text = `ok${String.fromCharCode(0x202e)}live`; }],
    ["markup in a row", (f) => { f.history[0].text = "<img src=x onerror=alert(1)>"; }],
    ["an empty row", (f) => { f.history[0].text = ""; }],
    ["an unknown row kind", (f) => { f.history[0].kind = "refund"; }],
    ["an unknown actor", (f) => { f.history[0].actor = "<b>admin</b>"; }],
    ["a script step for a stranger", (f) => { f.script[0].member = "mallory"; }],
    ["a null member", (f) => { f.members[2] = null; }],
    ["a round list of the wrong type", (f) => { f.rounds = "all paid"; }],
  ];
  for (const [what, edit] of bad) assert.throws(() => S.loadFixture(tweak(edit)), (e) => e.constructor === Error && e.message.length > 8, what);
  for (const junk of [null, undefined, 42, [], "not json", "[]", '{"v":1}', RAW.replace('"v": 1,', '"v": 1, "__proto__": { "x": 1 },')]) {
    assert.throws(() => S.loadFixture(junk), (e) => e.constructor === Error, String(junk).slice(0, 20));
  }
  // Text and a parsed object load to the same circle, and the caller's object is left alone.
  const raw = JSON.parse(RAW);
  assert.deepEqual(S.loadFixture(raw), S.loadFixture(RAW));
  assert.notEqual(S.loadFixture(raw), raw);
});

// ---------- S2 Money ----------
test("susu S2: USDC is exact BigInt micro-units from decimal strings, one canonical string out", () => {
  assert.equal(S.parseUsdc("50"), 50_000_000n);
  assert.equal(S.parseUsdc("0.000001"), 1n);
  assert.equal(S.parseUsdc("12.5"), 12_500_000n);
  assert.equal(S.parseUsdc("0"), 0n);
  // One micro-unit above 2^53: a float would round this away.
  assert.equal(S.parseUsdc("9007199254.740993"), 9007199254740993n);
  assert.equal(S.formatUsdc(9007199254740993n), "9007199254.740993");
  assert.equal(S.formatUsdc(0n), "0");
  assert.equal(S.formatUsdc(1n), "0.000001");
  for (const [a, b] of [["50.000000", "50"], ["50.0", "50"], ["0.10", "0.1"], ["12.50", "12.5"], ["7", "7"]]) assert.equal(S.canonUsdc(a), b);
  for (const bad of ["", " 50", "50 ", ".5", "5.", "0,5", "1,5", "1e3", "01", "-1", "+1", "0.0000001", "1_000", "0x10", "NaN", "Infinity", "five", "18446744073710", 50, 50.5, 50n, null, undefined, ["50"], { amount: "50" }]) {
    assert.throws(() => S.parseUsdc(bad), (e) => e.constructor === Error, String(bad));
  }
  for (const bad of [1, 1.5, "1", -1n, 1n << 64n, null]) assert.throws(() => S.formatUsdc(bad), Error, String(bad));
});

// ---------- S3 Create ----------
test("susu S3: validateTerms accepts one clean form and names the field on every bad one", () => {
  const form = { name: " Lagos Aunties ", amount: "12.50", cadence: "weekly", seats: "5", start: "2026-11-02", order: "fixed", members: ["Ama.sns", "ben.sns", W2, "efua.sns", "kwame.sns"] };
  assert.deepEqual(S.validateTerms(form, "2026-10-13"), {
    ok: true,
    terms: { name: "Lagos Aunties", amount: "12.5", cadence: "weekly", seats: 5, start: "2026-11-02", order: "fixed", members: ["ama.sns", "ben.sns", W2, "efua.sns", "kwame.sns"] },
  });
  const bad = [
    ["name", { name: "" }], ["name", { name: "A" }], ["name", { name: "Bad.Name" }], ["name", { name: "<b>x</b>" }], ["name", { name: "x".repeat(41) }],
    ["amount", { amount: "0" }], ["amount", { amount: "0,5" }], ["amount", { amount: 12.5 }], ["amount", { amount: "100001" }], ["amount", { amount: "1e2" }],
    ["cadence", { cadence: "daily" }],
    ["seats", { seats: 2 }], ["seats", { seats: 13 }], ["seats", { seats: 3.5 }], ["seats", { seats: "five" }],
    ["members", { seats: 4 }],
    ["start", { start: "2026-10-13" }], ["start", { start: "2026-10-01" }], ["start", { start: "2026-13-01" }], ["start", { start: "Nov 2" }], ["start", { cadence: "monthly", start: "2026-11-30" }],
    ["order", { order: "random" }], ["order", { order: "bid" }], ["order", {}, "order"],
    ["members", { members: ["a.sns", "b.sns"], seats: 3 }], ["members", { members: ["ama.sns", "AMA.sns", "b.sns", "c.sns", "d.sns"] }],
    ["members", { members: ["ama.sol", "b.sns", "c.sns", "d.sns", "e.sns"] }], ["members", { members: [`t${String.fromCharCode(0x43e)}ly.sns`, "b.sns", "c.sns", "d.sns", "e.sns"] }],
    ["members", { members: ["bob", "b.sns", "c.sns", "d.sns", "e.sns"] }], ["members", { members: "ama.sns" }], ["members", { members: [W2, W2, "c.sns", "d.sns", "e.sns"] }],
  ];
  for (const [field, patch, drop] of bad) {
    const input = { ...form, ...patch };
    if (drop) delete input[drop];
    const v = S.validateTerms(input, "2026-10-13");
    assert.equal(v.ok, false, JSON.stringify(patch));
    assert.ok(v.errors.some((e) => e.field === field && e.reason.length > 8), `${field}: ${JSON.stringify(v.errors)}`);
  }
  assert.equal(S.validateTerms(null, "2026-10-13").ok, false);
  assert.equal(S.validateTerms(form, "yesterday").errors[0].field, "today");
});

test("susu S3: the terms sheet lists every date, every slot and the stated gap with the real number", () => {
  const sheet = S.termsSheet(fixture());
  assert.deepEqual(sheet.dates, ["2026-09-14", "2026-10-14", "2026-11-14", "2026-12-14"]);
  assert.deepEqual(sheet.slots.map((s) => [s.slot, s.round, s.member, s.dueText, s.graceEnds, s.drawOn]), [
    [1, 1, "amara.sns", "Sep 14", "2026-09-16", "2026-09-17"], [2, 2, "nia.sns", "Oct 14", "2026-10-16", "2026-10-17"],
    [3, 3, "kofi.sns", "Nov 14", "2026-11-16", "2026-11-17"], [4, 4, "dana.sns", "Dec 14", "2026-12-16", "2026-12-17"],
  ]);
  assert.deepEqual([sheet.amount, sheet.pot, sheet.collateral, sheet.graceHours, sheet.rounds, sheet.chain, sheet.mock], ["50", "200", "50", 48, 4, "Solana", "mock · no chain"]);
  // 50 USDC x 3 remaining rounds.
  assert.equal(sheet.lines.leaveAfterPot, "A member who leaves after taking the pot costs the circle up to 150 USDC beyond their collateral. The program cannot collect it.");
  assert.equal(sheet.lines.missed, "When the grace ends the program draws 50 USDC from that member's collateral and pays the pot in full. The member tops up before the next round or leaves.");
  assert.equal(sheet.lines.grace, "A late contribution has 48 hours of grace. Every member sees the time left.");
  assert.equal(sheet.lines.collateral, "Each member posts 50 USDC of collateral at join. That is one round's amount.");
  assert.equal(sheet.lines.organizer, "The organizer has no power after creation.");
  assert.match(sheet.lines.lock, /^Terms lock at round 1\./);

  // Another circle: 12.5 USDC weekly, 5 seats. 12.5 x 4 remaining rounds = 50.
  const weekly = S.termsSheet({ name: "Lagos Aunties", amount: "12.5", cadence: "weekly", seats: 5, start: "2026-11-02", order: "fixed", members: ["ama.sns", "ben.sns", W2, "efua.sns", "kwame.sns"] });
  assert.deepEqual(weekly.dates, ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.deepEqual([weekly.pot, weekly.collateral, weekly.exposure], ["62.5", "12.5", "50"]);
  assert.match(weekly.lines.leaveAfterPot, /up to 50 USDC beyond their collateral/);
  // Monthly rounds keep their day across a year end.
  assert.deepEqual(S.termsSheet({ ...TRIO, start: "2026-11-28" }).dates, ["2026-11-28", "2026-12-28", "2027-01-28"]);
  assert.throws(() => S.termsSheet({ name: "x" }), (e) => e.constructor === Error);
});

test("susu S3: only a person with a wallet creates a circle; terms lock and the organizer keeps no power", () => {
  const r = S.createCircle(TRIO, human("m1"), "2026-10-13");
  const c = ok(r);
  assert.deepEqual([c.id, c.status, c.today, c.organizer, c.amount], ["trio", "forming", "2026-10-13", "m1", "50"]);
  assert.ok(c.members.every((m) => m.status === "invited" && m.wallet === "" && m.collateral === "0" && m.allowance.state === "none"));
  assert.ok(c.rounds.every((x) => x.state === "scheduled"));
  assert.deepEqual([r.rows.length, r.rows[0].actor, r.rows[0].kind], [1, "YOU", "create"]);
  assert.equal(r.sheet.lines.leaveAfterPot, "A member who leaves after taking the pot costs the circle up to 100 USDC beyond their collateral. The program cannot collect it.");

  for (const who of [agent("m1"), human("m1", null), human("m1", "not-a-wallet"), { mode: "admin", wallet: W }, null]) {
    const no = S.createCircle(TRIO, who, "2026-10-13");
    assert.deepEqual([no.ok, no.circle], [false, null]);
  }
  const noTerms = S.createCircle({ ...TRIO, amount: "0,5" }, human("m1"), "2026-10-13");
  assert.deepEqual([noTerms.ok, noTerms.errors[0].field], [false, "amount"]);

  // No change goes through, before round 1 or after it, for the organizer, a member or an agent.
  const live = trio();
  assert.equal(live.history.at(-1).text, "All 3 seats joined. Terms are locked. Round 1 opened. 50 USDC is due Nov 1.");
  for (const circle of [c, live]) {
    assert.match(refused(circle, S.changeTerms(circle, human("m1"), { amount: "5" })).reason, /^The organizer has no power after creation\. Terms lock at round 1\./);
    assert.match(refused(circle, S.changeTerms(circle, human("m2", W2), { order: ["m2", "m1", "m3"] })).reason, /^Terms lock at round 1\./);
    assert.equal(refused(circle, S.changeTerms(circle, agent("m1"), { amount: "5" })).reason, "Agents never change a circle's terms or its order.");
  }
});

// ---------- S4 Join ----------
test("susu S4: join states, the fixed pot destination and one circle per USDC account", () => {
  let c = forming();
  assert.equal(S.joinStatus(c, agent("m1")).state, "agent");
  assert.equal(S.joinStatus(c, human("m1", null)).state, "no-wallet");
  assert.equal(S.joinStatus(c, human("m9")).state, "invalid");
  assert.equal(S.joinStatus(c, human("m3", W2)).state, "wrong-wallet");
  assert.deepEqual(S.joinStatus(c, human("m1")), { state: "valid", reason: "" });
  const sheet = S.joinSheet(c, "m2");
  assert.deepEqual([sheet.slot, sheet.of, sheet.payoutDate, sheet.pot, sheet.collateral, sheet.inviteExpires], [2, 3, "2026-12-01", "150", "50", "2026-10-31"]);
  assert.equal(sheet.lines.account, "One circle per USDC account.");
  assert.equal(sheet.lines.wallet, "Your pot goes to the wallet you join with. Keep it.");

  // The page cannot skip the accept step or the other-circles check.
  refused(c, S.join(c, human("m1")));
  refused(c, S.join(c, human("m1"), { accept: true }));
  refused(c, S.join(c, human("m1"), { accept: "yes", otherCircles: [] }));
  refused(c, S.join(c, human("m1"), { accept: true, otherCircles: [{ members: [] }] }));
  refused(c, S.join(c, human("m1", null), yes));
  const other = ok(S.join(ok(S.createCircle({ ...TRIO, name: "Other" }, human("m1"), "2026-10-13")), human("m1"), yes));
  const clash = refused(c, S.join(c, human("m1"), { accept: true, otherCircles: [other] }));
  assert.deepEqual([clash.state, clash.reason], ["account", "One circle per USDC account. This wallet already pays into Other."]);

  const r = S.join(c, human("m1"), yes);
  c = ok(r);
  assert.deepEqual([r.state, r.slot, r.payoutTo], ["joined", 1, W]);
  assert.deepEqual([seat(c, "m1").status, seat(c, "m1").wallet, seat(c, "m1").usdc, seat(c, "m1").collateral, seat(c, "m1").joinedOn], ["joined", W, "450", "50", "2026-10-13"]);
  assert.equal(S.payoutSheet(c, "m1").to, W);
  assert.deepEqual([r.rows[0].actor, r.rows[0].kind, r.rows[0].member], ["YOU", "join", "m1"]);
  assert.equal(c.status, "forming");

  assert.equal(S.joinStatus(c, human("m1")).state, "member");
  assert.equal(S.joinStatus(c, human("m2")).state, "member", "one wallet, one seat");
  assert.equal(S.joinStatus(c, human("m1", W2)).state, "taken");
  refused(c, S.join(c, human("m1"), yes));
  refused(c, S.join(c, human("m1", W2), yes));

  const poor = JSON.parse(JSON.stringify(c));
  poor.members[1].usdc = "49.999999";
  assert.equal(S.joinStatus(poor, human("m2", W2)).state, "short");
  assert.equal(S.joinSheet(poor, "m2").usdcShort, true);
  refused(poor, S.join(poor, human("m2", W2), yes));

  refused(c, S.decline(c, agent("m2")));
  assert.equal(refused(c, S.decline(c, human("m3", W2))).reason, "This seat was offered to another wallet.");
  const declined = ok(S.decline(c, human("m2", W2)));
  assert.equal(seat(declined, "m2").status, "declined");
  assert.equal(S.joinStatus(declined, human("m2", W2)).state, "declined");
  refused(declined, S.join(declined, human("m2", W2), yes));
  refused(declined, S.decline(declined, human("m2", W2)));

  // Invites close the day before round 1 falls due.
  const lastDay = walk(c, 18);
  assert.deepEqual([lastDay.today, S.joinStatus(lastDay, human("m2", W2)).state], ["2026-10-31", "valid"]);
  const tooLate = walk(lastDay, 1);
  assert.equal(S.joinStatus(tooLate, human("m2", W2)).state, "expired");
  refused(tooLate, S.join(tooLate, human("m2", W2), yes));

  c = ok(S.join(c, human("m2", W2), yes));
  const last = S.join(c, human("m3", W3), yes);
  c = ok(last);
  assert.deepEqual([c.status, c.rounds[0].state, last.rows.map((x) => `${x.actor}/${x.kind}`)], ["active", "open", ["YOU/join", "PROGRAM/open"]]);
  assert.equal(S.joinStatus(c, human("m3", W3)).state, "member");
});

// ---------- S5 Allowance ----------
test("susu S5: the allowance is off by default and only a person sets, pauses or revokes it", () => {
  let c = trio();
  assert.ok(c.members.every((m) => m.allowance.state === "none"), "off by default");
  const sheet = S.allowanceSheet(fixture(), "amara");
  assert.deepEqual([sheet.state, sheet.enforcer, sheet.destination, sheet.perRound, sheet.roundsLeft, sheet.approvedTotal], ["none", "the circle program", "Family Circle vault", "50", 3, "150"]);
  assert.equal(sheet.lines.exception, "One exception: a circle allowance. The program fixes the destination and the amount. You get a notice a day before. You can pause or revoke at any time.");
  assert.equal(sheet.lines.destination, "It pays Family Circle's vault and no other destination.");

  for (const fn of [S.setAllowance, S.pauseAllowance, S.resumeAllowance, S.revokeAllowance]) refused(c, fn(c, agent("m1")));
  refused(c, S.setAllowance(c, human("m1", null)));
  refused(c, S.setAllowance(c, human("m1", W2)), "refused");
  refused(c, S.pauseAllowance(c, human("m1")));

  const set = S.setAllowance(c, human("m1"));
  c = ok(set);
  assert.deepEqual([set.state, seat(c, "m1").allowance, set.rows[0].actor, set.rows[0].kind], ["active", { state: "active", agent: "Scout" }, "YOU", "allowance-set"]);
  assert.equal(set.rows[0].text, "Set the agent allowance. The circle program may pull 50 USDC per round into Trio's vault.");
  refused(c, S.setAllowance(c, human("m1")));
  refused(c, S.resumeAllowance(c, human("m1")));
  // Pause needs no signature. A seat that joined with a real wallet still answers only to that wallet.
  refused(c, S.pauseAllowance(c, human("m1", null)));
  refused(c, S.pauseAllowance(c, human("m1", W2)));
  assert.equal(S.pauseAllowance(fixture(), human("you", null)).state, "paused");
  c = ok(S.pauseAllowance(c, human("m1")));
  assert.equal(seat(c, "m1").allowance.state, "paused");
  refused(c, S.pauseAllowance(c, human("m1")));
  c = ok(S.resumeAllowance(c, human("m1")));
  assert.equal(seat(c, "m1").allowance.state, "active");
  refused(c, S.revokeAllowance(c, human("m1", null)));
  c = ok(S.revokeAllowance(c, human("m1")));
  assert.equal(S.allowanceSheet(c, "m1").state, "revoked");
  refused(c, S.revokeAllowance(c, human("m1")));
  c = ok(S.setAllowance(c, human("m1")));
  assert.equal(seat(c, "m1").allowance.state, "active");
  // A seat that has not joined has nothing to set.
  const open = forming();
  refused(open, S.setAllowance(open, human("m1")));
});

// ---------- S6 Pre-notice ----------
test("susu S6: the day before the due date the member is told, and OK is a human decision", () => {
  const c = fixture();
  const n = S.preNotice(c, "you");
  assert.deepEqual([n.kind, n.round, n.amount, n.due, n.answer], ["agent", 2, "50", "2026-10-14", null]);
  assert.equal(n.text, "Your agent will pay 50 USDC to Family Circle on Oct 14.");
  assert.equal(S.preNotice(c, "kofi"), null, "already paid");
  assert.equal(S.preNotice(c, "nobody"), null);
  assert.deepEqual([S.preNotice(c, "dana").kind, S.preNotice(c, "dana").text], ["reminder", "50 USDC is due to Family Circle on Oct 14. Pay by hand."]);

  refused(c, S.answerPreNotice(c, agent(), "ok"));
  refused(c, S.answerPreNotice(c, human(), "maybe"));
  refused(c, S.answerPreNotice(c, human("dana"), "ok"));
  refused(c, S.answerPreNotice(c, human("you", null), "hand"));

  const r = S.answerPreNotice(c, human(), "ok");
  const said = ok(r);
  assert.deepEqual(r.rows, [{ day: "2026-10-13", actor: "YOU", kind: "ok", text: "Said OK. The agent pays 50 USDC to Family Circle on Oct 14.", member: "you" }]);
  assert.deepEqual([S.preNotice(said, "you").answer, S.preNotice(said, "you").line], ["ok", "Agent will pay Oct 14. You said OK on Oct 13."]);
  refused(said, S.answerPreNotice(said, human(), "pause"));
  const paid = walk(said, 1);
  assert.equal(S.cell(paid, "you", 2).label, "paid by agent");
  assert.equal(S.preNotice(paid, "you"), null);
  assert.equal(S.preNotice(paid, "dana"), null, "the notice is for the day before only");
});

test("susu S6: no answer still pays on the due date; Pause stops it; Pay by hand now replaces it", () => {
  const c = fixture();
  const silent = S.nextDay(c, human());
  assert.deepEqual(silent.rows.filter((x) => x.member === "you").map((x) => [x.actor, x.kind]), [["SCOUT", "pay"]]);
  assert.equal(seat(silent.circle, "you").usdc, "70");

  const paused = ok(S.answerPreNotice(c, human(), "pause"));
  assert.equal(seat(paused, "you").allowance.state, "paused");
  assert.equal(S.preNotice(paused, "you").text, "Your agent is paused. 50 USDC is due to Family Circle on Oct 14.");
  const stopped = S.nextDay(paused, human());
  assert.deepEqual(stopped.rows.filter((x) => x.member === "you").map((x) => [x.actor, x.kind, x.text]), [["SCOUT", "stop", "Stopped for nia.sns. The allowance is paused. Nothing moved."]]);
  assert.deepEqual([seat(stopped.circle, "you").usdc, S.cell(stopped.circle, "you", 2).state], ["120", "due"]);

  const byHand = S.answerPreNotice(c, human(), "hand");
  const hand = ok(byHand);
  assert.deepEqual([byHand.rows[0].actor, byHand.rows[0].kind, S.cell(hand, "you", 2).label, seat(hand, "you").usdc, seat(hand, "you").feeSol], ["YOU", "pay", "paid by hand", "70", "0.01"]);
  const after = S.nextDay(hand, human());
  assert.deepEqual(after.rows.filter((x) => x.member === "you"), [], "the agent has nothing to pay");
  assert.equal(seat(after.circle, "you").usdc, "70");
});

// ---------- S7 Agent contribute policy ----------
test("susu S7: the agent pays the exact amount for the current round and nothing else moves", () => {
  // Oct 13 is the notice day, so the person says OK first. That is the review step before an agent payment.
  const c = ok(S.answerPreNotice(fixture(), human(), "ok"));
  assert.deepEqual(S.checkContribute(c, agent(), REQ), { verdict: "allow", code: "ok", reason: "Round 2, 50 USDC, into Family Circle's vault." });
  assert.equal(S.checkContribute(c, agent(), { ...REQ, amount: "50.000000" }).verdict, "allow", "one amount, two spellings");
  const r = S.agentContribute(c, agent(), REQ);
  const paid = ok(r);
  assert.deepEqual([r.verdict, r.round, r.amount], ["paid", 2, "50"]);
  assert.deepEqual(r.rows, [{ day: "2026-10-13", actor: "SCOUT", kind: "pay", text: "Paid 50 USDC to Family Circle for round 2 of 4 under nia.sns's allowance.", member: "you" }]);
  assert.deepEqual([seat(paid, "you").usdc, seat(paid, "you").feeSol, seat(paid, "you").collateral], ["70", "0.009995", "50"]);
  assert.deepEqual(S.cell(paid, "you", 2), { state: "paid", by: "agent", label: "paid by agent", day: "2026-10-13", hoursLeft: 0, late: false });
  assert.equal(S.overview(paid, "you").vault, "300");
  // Every other seat is untouched.
  for (const id of ["amara", "kofi", "dana"]) assert.deepEqual(seat(paid, id), seat(c, id));
  // The agent the allowance was set for is the actor, whatever it is called.
  const mine = { ...human(), agentName: "Demo agent" };
  const demo = ok(S.answerPreNotice(ok(S.setAllowance(ok(S.revokeAllowance(fixture(), human())), mine)), mine, "ok"));
  assert.deepEqual(Object.values(S.agentContribute(demo, agent("you", "Demo agent"), REQ).rows[0]).slice(1, 3), ["DEMO AGENT", "pay"]);
});

test("susu S7: every policy failure is refused or stopped with a reason, and nothing moves", () => {
  const c = fixture();
  const paused = ok(S.pauseAllowance(c, human()));
  const revoked = ok(S.revokeAllowance(c, human()));
  const byHand = ok(S.payByHand(c, human()));
  const late = ok(S.resumeAllowance(walk(paused, 2), human()));
  assert.equal(late.today, "2026-10-15");
  // The balance stops come after the review step, so these two seats said OK to the pre-notice.
  const usdcShort = ok(S.answerPreNotice(S.loadFixture(tweak((f) => { f.members[1].usdc = "49.999999"; })), human(), "ok"));
  const feeShort = ok(S.answerPreNotice(S.loadFixture(tweak((f) => { f.members[1].feeSol = "0.000004999"; })), human(), "ok"));
  const left = ok(S.leave(c, human()));
  const early = walk(c, 4); // Oct 17: round 3 is open and its notice goes out on Nov 13
  // Trio on its notice day. Seat m1 joined with wallet W and set the allowance.
  const live = walk(ok(S.setAllowance(trio(), human("m1"))), 18, human("m1")), liveReq = { circle: "trio", round: 1, amount: "50" };
  const cases = [
    ["no wallet connected", c, { ...agent(), wallet: null }, REQ, "refused", "wallet"],
    ["a wallet that is no address", c, { ...agent(), wallet: "0xabc" }, REQ, "refused", "wallet"],
    ["another circle", c, agent(), { ...REQ, circle: "other-circle" }, "refused", "circle"],
    ["no circle named", c, agent(), { round: 2, amount: "50" }, "refused", "circle"],
    ["a malformed request", c, agent(), "Pay round 2", "refused", "request"],
    ["one micro-unit under", c, agent(), { ...REQ, amount: "49.999999" }, "refused", "amount"],
    ["one micro-unit over", c, agent(), { ...REQ, amount: "50.000001" }, "refused", "amount"],
    ["ten times the amount", c, agent(), { ...REQ, amount: "500" }, "refused", "amount"],
    ["a number for the amount", c, agent(), { ...REQ, amount: 50 }, "refused", "amount"],
    ["a comma amount", c, agent(), { ...REQ, amount: "0,50" }, "refused", "amount"],
    ["no amount", c, agent(), { circle: "family-circle", round: 2 }, "refused", "amount"],
    ["the next round", c, agent(), { ...REQ, round: 3 }, "refused", "round"],
    ["a finished round", c, agent(), { ...REQ, round: 1 }, "refused", "round"],
    ["round zero", c, agent(), { ...REQ, round: 0 }, "refused", "round"],
    ["a round as text", c, agent(), { ...REQ, round: "2" }, "refused", "round"],
    ["half a round", c, agent(), { ...REQ, round: 2.5 }, "refused", "round"],
    ["after the due date", late, agent(), REQ, "refused", "late"],
    ["before the pre-notice", early, agent(), { ...REQ, round: 3 }, "refused", "early"],
    ["a seat that is not in the circle", c, agent("mallory"), REQ, "refused", "member"],
    ["a seat that left", left, agent(), REQ, "refused", "member"],
    ["a wallet that did not join the seat", live, { ...agent("m1"), wallet: W2 }, liveReq, "refused", "member"],
    ["no allowance set", c, agent("dana"), REQ, "refused", "allowance"],
    ["a revoked allowance", revoked, agent(), REQ, "refused", "allowance"],
    ["an allowance set for another agent", c, agent("you", "Hermes"), REQ, "refused", "allowance"],
    ["already paid by an agent", c, agent("kofi", "Hermes"), REQ, "refused", "paid"],
    ["a paused allowance", paused, agent(), REQ, "stopped", "paused"],
    ["already paid by hand", byHand, agent(), REQ, "stopped", "paid-by-hand"],
    ["the pre-notice unanswered", c, agent(), REQ, "stopped", "notice"],
    ["USDC short", usdcShort, agent(), REQ, "stopped", "usdc-short"],
    ["fee SOL short", feeShort, agent(), REQ, "stopped", "fee-short"],
  ];
  for (const [what, circle, who, req, verdict, code] of cases) {
    const v = S.checkContribute(circle, who, req);
    assert.deepEqual([v.verdict, v.code], [verdict, code], what);
    const r = refused(circle, S.agentContribute(circle, who, req), verdict);
    assert.deepEqual([r.code, r.reason, r.rows[0].actor], [code, v.reason, who.agentName.toUpperCase()], what);
  }
  assert.equal(S.checkContribute(usdcShort, agent(), REQ).reason, "USDC is short: nia.sns holds 49.999999 USDC and round 2 needs 50 USDC. Nothing moved. Pay by hand.");
  assert.equal(S.checkContribute(feeShort, agent(), REQ).reason, "The agent's fee balance is short: 0.000004999 SOL of the 0.000005 SOL needed. Nothing moved. Pay by hand.");
  // A person does not pay through the agent's path, and an actor nobody can name does nothing.
  refused(c, S.agentContribute(c, human(), REQ));
  for (const who of [null, {}, { mode: "agent" }, agent("you", "YOU"), agent("you", "Program"), agent("you", "<b>x</b>"), { mode: "root", agentName: "Scout", memberId: "you" }]) {
    const r = S.agentContribute(c, who, REQ);
    assert.deepEqual([r.ok, r.verdict, r.rows.length, ledger(r.circle)], [false, "refused", 0, ledger(c)]);
    assert.equal(S.checkContribute(c, who, REQ).verdict, "refused");
  }
});

test("susu S7: a second contribution for the same round is refused", () => {
  const c = ok(S.answerPreNotice(fixture(), human(), "ok"));
  const once = ok(S.agentContribute(c, agent(), REQ));
  const again = refused(once, S.agentContribute(once, agent(), REQ));
  assert.deepEqual([again.code, again.reason], ["paid", "Round 2 is already paid. A second contribution for the same round is refused."]);
  assert.equal(refused(once, S.payByHand(once, human())).reason, "Round 2 is already paid. The agent paid on Oct 13.");
  const hand = ok(S.payByHand(c, human()));
  assert.equal(refused(hand, S.payByHand(hand, human())).reason, "Round 2 is already paid. You paid by hand on Oct 13.");
  assert.equal(refused(hand, S.agentContribute(hand, agent(), REQ), "stopped").reason, "Round 2 was paid by hand on Oct 13. Nothing moved.");
  assert.equal(seat(once, "you").usdc, "70");
  assert.equal(once.rounds[1].payments.filter((p) => p.member === "you").length, 1);
});

test("susu S7 and S8: a contribution after the deadline is refused", () => {
  // The agent's deadline is the due date.
  const paused = ok(S.pauseAllowance(fixture(), human()));
  const day15 = ok(S.resumeAllowance(walk(paused, 2), human()));
  const late = refused(day15, S.agentContribute(day15, agent(), REQ));
  assert.deepEqual([late.code, late.reason], ["late", "Round 2 was due Oct 14. The agent pays on or before the due date. Pay by hand before the grace ends on Oct 16."]);
  // A person may still pay inside the grace, and the round then settles without a draw.
  const day16 = walk(day15, 1);
  const inGrace = S.payByHand(day16, human());
  assert.equal(inGrace.rows[0].text, "Paid 50 USDC by hand for round 2 of 4, inside the grace.");
  assert.deepEqual([S.cell(ok(inGrace), "you", 2).state, S.cell(inGrace.circle, "you", 2).late], ["paid", true]);
  // Once the grace has ended the program has drawn and the round is closed to everyone.
  const day17 = walk(day16, 1);
  assert.equal(S.cell(day17, "you", 2).state, "drawn");
  assert.equal(refused(day17, S.payByHand(day17, human(), { round: 2 })).reason, "Round 2 closed on Oct 17. That deadline has passed.");
  assert.equal(refused(day17, S.payByHand(day17, human("dana"), { round: 2 })).reason, "Round 2 closed on Oct 17. That deadline has passed.");
  assert.equal(refused(day17, S.agentContribute(day17, agent(), REQ)).code, "round");
});

// ---------- S8 Pay by hand ----------
test("susu S8: only a person in You mode pays by hand", () => {
  const c = fixture();
  assert.equal(refused(c, S.payByHand(c, agent())).reason, "Switch to You to pay by hand.");
  refused(c, S.payByHand(c, human("you", null)));
  refused(c, S.payByHand(c, human("mallory")));
  refused(c, S.payByHand(c, human(), { round: 3 }));
  refused(c, S.payByHand(c, human(), { round: "2" }));
  refused(c, S.payByHand(c, human(), "now"));
  const r = S.payByHand(c, human(), { round: 2 });
  const paid = ok(r);
  assert.deepEqual(r.rows, [{ day: "2026-10-13", actor: "YOU", kind: "pay", text: "Paid 50 USDC by hand for round 2 of 4.", member: "you" }]);
  assert.deepEqual([seat(paid, "you").usdc, seat(paid, "you").feeSol, S.cell(paid, "you", 2).label], ["70", "0.01", "paid by hand"]);

  const broke = freeze(S.loadFixture(tweak((f) => { f.members[3].usdc = "10"; })));
  assert.equal(refused(broke, S.payByHand(broke, human("dana"))).reason, "USDC is short: this seat holds 10 USDC and round 2 needs 50 USDC.");
  // A seat joined through join() answers only to the wallet that signed.
  const live = trio();
  assert.equal(refused(live, S.payByHand(live, human("m1", W2))).reason, "This wallet is not a member of Trio.");
  assert.equal(seat(ok(S.payByHand(live, human("m1", W))), "m1").usdc, "400");
  const open = forming();
  refused(open, S.payByHand(open, human("m1")));
});

// ---------- S9 Round clock ----------
test("susu S9: walking nextDay reaches pre-notice, agent payment, dana.sns late with grace, the draw and a claimable pot, in that order", () => {
  let c = fixture();
  const sum = total(c);
  assert.equal(sum, 860_000_000n);
  // Day 0, Oct 13: the pre-notice is due.
  assert.equal(c.today, "2026-10-13");
  assert.equal(S.preNotice(c, "you").text, "Your agent will pay 50 USDC to Family Circle on Oct 14.");
  const sent = c.history.findLast((h) => h.member === "you");
  assert.deepEqual([sent.kind, sent.actor, sent.day], ["notice", "SCOUT", "2026-10-13"]);

  // Oct 14, the due date: the agent pays. dana.sns tops up the old draw and has nothing left for round 2.
  let r = S.nextDay(c, human());
  c = ok(r);
  assert.equal(r.day, "2026-10-14");
  assert.deepEqual(r.rows.map((x) => [x.actor, x.kind, x.member]), [["dana.sns", "top-up", "dana"], ["SCOUT", "pay", "you"]]);
  assert.deepEqual([S.cell(c, "you", 2).label, S.cell(c, "you", 2).day, seat(c, "you").usdc, seat(c, "you").feeSol], ["paid by agent", "2026-10-14", "70", "0.009995"]);
  assert.deepEqual([seat(c, "dana").usdc, seat(c, "dana").collateral, S.cell(c, "dana", 2).state], ["0", "50", "due"]);
  assert.equal(S.overview(c, "you").late.length, 0);

  // Oct 15: dana.sns is late. Every member sees the same time left.
  r = S.nextDay(c, human());
  c = ok(r);
  assert.deepEqual(r.rows, [{ day: "2026-10-15", actor: "PROGRAM", kind: "late", text: "dana.sns is late for round 2. 48 hours of grace end on Oct 16.", member: "dana" }]);
  assert.deepEqual([S.cell(c, "dana", 2).state, S.cell(c, "dana", 2).hoursLeft], ["late", 48]);
  for (const viewer of ["amara", "you", "kofi", "dana", "nobody"]) {
    assert.deepEqual(S.overview(c, viewer).late, [{ id: "dana", name: "dana.sns", hoursLeft: 48, graceEnds: "2026-10-16" }]);
  }
  assert.equal(S.describe(c, "dana"), "Round 2 of 4. 50 USDC due Oct 14. It is late. Pay by hand before the grace ends on Oct 16.");
  assert.equal(c.rounds[1].state, "open");

  // Oct 16: one day of grace left. Nothing has moved.
  r = S.nextDay(c, human());
  c = ok(r);
  assert.deepEqual([r.rows.length, S.cell(c, "dana", 2).hoursLeft, c.rounds[1].pot.state], [0, 24, "none"]);

  // Oct 17: the program draws from dana.sns's collateral, the pot is ready in full and round 3 opens.
  r = S.nextDay(c, human());
  c = ok(r);
  assert.deepEqual(r.rows.map((x) => [x.actor, x.kind]), [["PROGRAM", "draw"], ["PROGRAM", "pot"], ["PROGRAM", "open"]]);
  assert.equal(r.rows[0].text, "Drew 50 USDC from dana.sns's collateral for round 2. The pot is paid in full. dana.sns tops up 50 USDC before round 3 or leaves.");
  assert.equal(r.rows[1].text, "Round 2 pot of 200 USDC is ready for nia.sns. It goes to the wallet fixed at join.");
  assert.deepEqual([seat(c, "dana").collateral, S.cell(c, "dana", 2).state, S.topUpStatus(c, "dana").pending], ["0", "drawn", true]);
  assert.deepEqual(c.rounds[1].pot, { state: "claimable", amount: "200", since: "2026-10-17", paidOn: "" });
  assert.deepEqual([S.payoutSheet(c, "you").state, S.payoutSheet(c, "you").line, S.payoutSheet(c, "amara").state], ["claimable", "Pot unclaimed since Oct 17", "claimed"]);
  assert.deepEqual([c.rounds[2].state, c.rounds[2].due, S.overview(c, "you").round.n], ["open", "2026-11-14", 3]);

  // The order of the whole walk, read back from the history. kofi.sns's own rows on Oct 13 are left out.
  const kinds = c.history.filter((h) => h.day >= "2026-10-13" && h.member !== "kofi").map((h) => `${h.kind}:${h.member}`);
  assert.deepEqual(kinds, ["notice:you", "top-up:dana", "pay:you", "late:dana", "draw:dana", "pot:you", "open:"]);
  assert.equal(total(c), sum, "no USDC appears or disappears");
});

test("susu S9: payout is ready as soon as everyone has paid, and the next round opens on schedule", () => {
  let c = ok(S.payByHand(fixture(), human()));
  const r = S.payByHand(c, human("dana"));
  c = ok(r);
  assert.deepEqual(r.rows.map((x) => `${x.actor}/${x.kind}`), ["YOU/pay", "PROGRAM/pot", "PROGRAM/open"]);
  assert.deepEqual(c.rounds[1].pot, { state: "claimable", amount: "200", since: "2026-10-13", paidOn: "" });
  assert.deepEqual([c.rounds[2].state, c.rounds[2].due, S.whatIsDue(c, "you").due], ["open", "2026-11-14", "2026-11-14"]);
  assert.equal(seat(c, "dana").collateral, "0", "no draw happened");
});

test("susu S9: an unclaimed pot stays claimable and is shown as unclaimed since its date", () => {
  let c = walk(fixture(), 38);
  assert.deepEqual([c.today, S.overview(c, "you").round.n], ["2026-11-20", 4]);
  const waiting = S.overview(c, "you").unclaimed;
  assert.deepEqual(waiting.map((x) => [x.n, x.pot.amount, x.pot.line, x.recipientName]), [[2, "200", "Pot unclaimed since Oct 17", "nia.sns"], [3, "150", "Pot unclaimed since Nov 17", "kofi.sns"]]);
  const claim = S.claimPayout(c, human());
  c = ok(claim);
  assert.deepEqual([claim.round, claim.amount, seat(c, "you").usdc], [2, "200", "220"]);
  assert.deepEqual(S.overview(c, "you").unclaimed.map((x) => x.n), [3]);
});

test("susu S9: a member in default tops up before the next round; one round of collateral covers one miss", () => {
  // With spare USDC dana.sns tops up after the second draw.
  let c = walk(freeze(S.loadFixture(tweak((f) => { f.members[3].usdc = "200"; }))), 4);
  assert.deepEqual([c.today, seat(c, "dana").usdc, seat(c, "dana").collateral], ["2026-10-17", "150", "0"]);
  assert.equal(S.topUpStatus(c, "dana").line, "Top up 50 USDC of collateral before round 3 is due on Nov 14 or leave.");
  refused(c, S.topUp(c, agent("dana")));
  refused(c, S.topUp(c, human("dana", null)));
  refused(c, S.topUp(c, human("amara")));
  const up = S.topUp(c, human("dana"));
  c = ok(up);
  assert.deepEqual([up.amount, up.rows[0].kind, seat(c, "dana").usdc, seat(c, "dana").collateral, S.topUpStatus(c, "dana").pending], ["50", "top-up", "100", "50", false]);
  assert.equal(refused(c, S.topUp(c, human("dana"))).reason, "Collateral is full. Nothing is owed.");

  // With nothing left the second miss is uncovered, and the row says so.
  const dry = walk(fixture(), 4);
  assert.equal(refused(dry, S.topUp(dry, human("dana"))).reason, "USDC is short: this seat holds 0 USDC and the top-up is 50 USDC.");
  const r3 = walk(dry, 30);
  const day = S.nextDay(r3, human());
  assert.equal(day.day, "2026-11-17");
  assert.deepEqual(day.rows.map((x) => x.kind), ["short", "pot", "open"]);
  assert.equal(day.rows[0].text, "dana.sns missed round 3 with 0 USDC of collateral left. The pot is 50 USDC short. The program cannot collect it.");
  assert.deepEqual([day.circle.rounds[2].pot.amount, S.cell(day.circle, "dana", 3).state], ["150", "short"]);
});

test("susu S9: the whole circle runs to the end, stays well-formed every day and returns collateral at close", () => {
  let c = fixture();
  const sum = total(c), stops = [];
  for (let i = 0; i < 70; i++) {
    const r = S.nextDay(c, human());
    c = ok(r);
    assert.deepEqual(S.deserialize(S.serialize(c)), c, c.today);
    assert.equal(total(c), sum, c.today);
    stops.push(...r.rows.filter((x) => x.kind === "stop").map((x) => `${x.day} ${x.actor} ${x.text}`));
  }
  assert.deepEqual([c.status, c.today], ["complete", "2026-12-22"]);
  // The hard stop: the viewer never claimed the pot, so by round 4 the agent finds 20 USDC and halts.
  assert.deepEqual(stops, ["2026-12-14 SCOUT Stopped for nia.sns. USDC is short: nia.sns holds 20 USDC and round 4 needs 50 USDC. Nothing moved. Pay by hand."]);
  assert.deepEqual(c.members.map((m) => [m.id, m.usdc, m.collateral]), [["amara", "260", "0"], ["you", "20", "0"], ["kofi", "80", "0"], ["dana", "0", "0"]]);
  assert.deepEqual(c.history.filter((h) => h.kind === "return").map((h) => h.text), ["Returned 50 USDC of collateral to amara.sns.", "Returned 50 USDC of collateral to kofi.sns."]);
  assert.deepEqual(c.rounds.map((x) => [x.state, x.pot.state, x.pot.amount]), [["settled", "paid", "200"], ["settled", "claimable", "200"], ["settled", "claimable", "150"], ["settled", "claimable", "150"]]);
  assert.equal(S.describe(c, "you"), "All 4 rounds of Family Circle are finished.");
  assert.equal(ok(S.claimPayout(c, human())).members[1].usdc, "220", "the pot is still claimable after the circle ends");
  refused(c, S.agentContribute(c, agent(), REQ));
  refused(c, S.nextDay(c, agent()));
});

// ---------- S10 Payout ----------
test("susu S10: only this round's member claims, once, to the wallet fixed at join", () => {
  const early = fixture();
  assert.equal(refused(early, S.claimPayout(early, human())).reason, "Round 2's pot becomes claimable when everyone has paid or the grace has ended. 2 of 4 have paid.");
  assert.equal(S.payoutSheet(early, "you").state, "waiting");
  assert.equal(S.payoutSheet(early, "kofi").state, "not-your-turn");

  const c = walk(early, 4);
  assert.equal(refused(c, S.claimPayout(c, agent())).reason, "Agents never claim a pot. Switch to You.");
  assert.equal(refused(c, S.claimPayout(c, human("amara"), { round: 2 })).reason, "Round 2's pot goes to nia.sns. Only that round's member claims it.");
  assert.equal(refused(c, S.claimPayout(c, human("amara"))).reason, "Round 1's pot was paid on Sep 17. A pot is paid once.");
  assert.equal(refused(c, S.claimPayout(c, human(), { to: W2 })).reason, "The pot goes to the wallet fixed at join. Nobody can change the recipient.");
  refused(c, S.claimPayout(c, human("you", null)));
  refused(c, S.claimPayout(c, human(), { round: 9 }));
  refused(c, S.claimPayout(c, human("kofi")));

  const r = S.claimPayout(c, human());
  const paid = ok(r);
  assert.deepEqual([r.round, r.amount, r.to, seat(paid, "you").usdc], [2, "200", "mock member", "270"]);
  assert.deepEqual(paid.rounds[1].pot, { state: "paid", amount: "200", since: "2026-10-17", paidOn: "2026-10-17" });
  assert.deepEqual([r.rows[0].actor, r.rows[0].kind], ["YOU", "claim"]);
  assert.equal(refused(paid, S.claimPayout(paid, human())).reason, "Round 2's pot was paid on Oct 17. A pot is paid once.");

  // A seat joined with a real wallet: the pot follows that wallet and no other.
  let live = trio();
  for (const [id, wallet] of [["m1", W], ["m2", W2], ["m3", W3]]) live = ok(S.payByHand(live, human(id, wallet)));
  assert.deepEqual([S.payoutSheet(live, "m1").state, S.payoutSheet(live, "m1").to, S.payoutSheet(live, "m1").amount], ["claimable", W, "150"]);
  assert.equal(refused(live, S.claimPayout(live, human("m1", W2))).reason, "This wallet is not a member of Trio.");
  refused(live, S.claimPayout(live, human("m2", W2), { round: 1 }));
  refused(live, S.claimPayout(live, human("m1", W), { to: W2 }));
  const mine = S.claimPayout(live, human("m1", W), { round: 1, to: W });
  assert.deepEqual([mine.ok, mine.to, seat(mine.circle, "m1").wallet, seat(mine.circle, "m1").usdc], [true, W, W, "550"]);
});

// ---------- S11 Withdraw ----------
test("susu S11: every arbitrary withdrawal is refused, for a person, an agent and the organizer alike", () => {
  for (const c of [fixture(), walk(fixture(), 4), trio()]) {
    const vault = S.overview(c, "you").vault, organizer = c.organizer;
    for (const who of [human(), human("dana"), agent(), agent("kofi", "Hermes"), human(organizer), human("stranger"), human("you", null)]) {
      const r = refused(c, S.withdraw(c, who, { amount: "100", to: W2 }));
      assert.equal(r.code, "withdraw");
      assert.ok(r.reason.startsWith("The program has no withdraw instruction and no admin key. Money leaves the vault only as a round's payout or as collateral returned at close."));
      assert.equal(r.reason.endsWith("The organizer has no power after creation."), who.mode === "human" && who.memberId === organizer);
      assert.equal(S.overview(r.circle, "you").vault, vault);
    }
    assert.equal(S.withdraw(c, null).ok, false);
  }
  assert.equal(S.NO_WITHDRAW, S.overview(fixture(), "you").lines.withdraw);
});

// ---------- S12 Leave ----------
test("susu S12: leave names the forfeited amount and includes revoking the program's allowance", () => {
  const c = fixture();
  const sheet = S.leaveSheet(c, "you");
  assert.deepEqual([sheet.forfeited, sheet.label, sheet.steps], ["50", "Leave and forfeit 50 USDC", ["Revoke the program's allowance", "Leave Family Circle"]]);
  // amara.sns took the round 1 pot and still owes rounds 3 and 4: 100 USDC, 50 of it covered.
  assert.deepEqual([S.leaveSheet(c, "amara").forfeited, S.leaveSheet(c, "amara").uncovered], ["50", "50"]);
  assert.equal(S.leaveSheet(c, "amara").lines.uncovered, "You took the pot. Leaving now costs the circle 50 USDC beyond your collateral. The program cannot collect it.");
  assert.deepEqual([S.leaveSheet(c, "dana").forfeited, S.leaveSheet(c, "dana").label, S.leaveSheet(c, "dana").uncovered], ["0", "Leave the circle", "0"]);

  assert.equal(refused(c, S.leave(c, agent())).reason, "Agents never leave a circle for a member. Switch to You.");
  refused(c, S.leave(c, human("you", null)));
  const r = S.leave(c, human());
  const gone = ok(r);
  assert.deepEqual([r.forfeited, r.steps[0], r.rows.map((x) => `${x.actor}/${x.kind}`)], ["50", "Revoke the program's allowance", ["YOU/allowance-revoke", "YOU/leave"]]);
  assert.deepEqual([seat(gone, "you").status, seat(gone, "you").allowance.state, seat(gone, "you").usdc, seat(gone, "you").collateral], ["left", "revoked", "120", "50"]);
  assert.equal(r.rows[1].text, "Left Family Circle. Forfeited 50 USDC of collateral.");
  refused(gone, S.leave(gone, human()));
  refused(gone, S.payByHand(gone, human()));
  // The forfeited collateral covers the next round that seat misses, and the agent no longer pays for it.
  const after = walk(gone, 4);
  assert.deepEqual([S.cell(after, "you", 2).state, seat(after, "you").collateral, seat(after, "you").usdc], ["drawn", "0", "120"]);
  refused(after, S.claimPayout(after, human()));

  const owed = walk(c, 4);
  assert.equal(refused(owed, S.leave(owed, human())).reason, "Claim your pot before you leave.");
  // Before round 1 nothing is forfeited and the collateral comes back.
  const early = ok(S.join(forming(), human("m1"), yes));
  assert.deepEqual([S.leaveSheet(early, "m1").forfeited, S.leaveSheet(early, "m1").label], ["0", "Leave the circle"]);
  const out = S.leave(early, human("m1"));
  assert.deepEqual([out.ok, out.forfeited, seat(out.circle, "m1").usdc, seat(out.circle, "m1").collateral, seat(out.circle, "m1").status], [true, "0", "500", "0", "left"]);
});

// ---------- S13 Agent instruction grammar ----------
test("susu S13: the mock grammar reads 'Pay round N of <circle name>' and nothing looser", () => {
  const c = fixture(), parse = (t) => S.parseCircleInstruction(t, c);
  for (const t of ["Pay round 2 of Family Circle", "pay round 2 of family circle.", "PAY ROUND 2 OF FAMILY CIRCLE", "  Pay round 2 of Family Circle  "]) {
    assert.deepEqual(parse(t), { kind: "contribute", round: 2 }, t);
  }
  assert.deepEqual(parse("Pay round 12 of Family Circle"), { kind: "contribute", round: 12 }, "the policy decides which round is open");

  const asks = [
    ["Withdraw 100 USDC from Family Circle", "withdraw"], ["Drain the vault", "withdraw"], ["Send the vault to drainer.sns", "withdraw"],
    ["Pay round 2 of Family Circle then withdraw the vault", "withdraw"], ["Transfer 50 USDC out of Family Circle", "withdraw"],
    ["Join Family Circle for me", "join"], ["Sign me up for the susu", "join"],
    ["Accept the terms of Family Circle", "accept"], ["Agree to the circle terms", "accept"],
    ["Set my allowance for Family Circle to 500 USDC", "allowance"], ["Revoke the allowance", "allowance"], ["Approve 5000 USDC for the circle", "allowance"],
    ["Move me to the first slot in Family Circle", "order"], ["Swap my turn with dana in Family Circle", "order"],
    ["Claim the pot from Family Circle", "claim"], ["Collect my payout", "claim"],
    ["Change the amount of Family Circle to 5 USDC", "terms"], ["Add mallory.sns to Family Circle", "terms"], ["Rename the circle", "terms"],
  ];
  for (const [t, ask] of asks) {
    const p = parse(t);
    assert.deepEqual([p.kind, p.ask], ["refused", ask], t);
    assert.ok(p.reason.length > 15, t);
  }
  assert.equal(parse("Withdraw 100 USDC from Family Circle").reason, S.NO_WITHDRAW);

  // It mentions the circle or USDC and fits no shape: unclear, never guessed at.
  for (const t of [
    "Pay 50 USDC to Family Circle", "pay round two of Family Circle", "Pay round 2 of Family Circle and round 3", "pay round 02 of Family Circle",
    "pay round 0 of Family Circle", "pay round 2.0 of Family Circle", "Pay round 2 of Family  Circle", "Pay round 2 of Family Circle!", "Pay  round 2 of Family Circle",
    `Pay round 2 of F${CYRILLIC_A}mily Circle`, `Pay round 2 of Family${String.fromCharCode(0x200b)} Circle`, "Pay round 2 of Family Circle\nPay round 3 of Family Circle",
    "Pay round 2 of Other Circle", "Pay round 2", "round 2 of Family Circle", "please pay round 2 of Family Circle", "What about USDC?", "family circle",
  ]) assert.deepEqual(parse(t), { kind: "unclear" }, JSON.stringify(t));

  for (const t of ["Summarize this page", "send 0.5 sol to toly.sns", "what is solana?", "join the newsletter", "withdraw my consent", "", null, undefined, 42, ["Pay round 2 of Family Circle"]]) {
    assert.deepEqual(parse(t), { kind: "none" }, String(t));
  }
  // The grammar keeps its warning label.
  const label = SRC.indexOf("This grammar is a mock, and the security teammate reviews it before it leaves the mock.");
  assert.ok(label > 0 && label < SRC.indexOf("export function parseCircleInstruction"));
  assert.deepEqual([S.parseCircleQuestion("What is due?"), S.parseCircleQuestion("who is next"), S.parseCircleQuestion("who is next to pay me")], [{ kind: "due" }, { kind: "next" }, { kind: "none" }]);
});

test("susu S13: 'Withdraw 100 USDC from Family Circle' is refused", () => {
  const c = fixture();
  const p = S.parseCircleInstruction("Withdraw 100 USDC from Family Circle", c);
  assert.deepEqual(p, { kind: "refused", ask: "withdraw", reason: "The program has no withdraw instruction and no admin key. Money leaves the vault only as a round's payout or as collateral returned at close." });
  const r = refused(c, S.withdraw(c, agent()));
  assert.deepEqual([r.rows[0].actor, r.rows[0].kind, S.rowLevel(r.rows[0])], ["SCOUT", "block", "block"]);
});

test("susu S13: 'pay round 3 of Family Circle' is refused while round 2 is open", () => {
  const c = fixture();
  const p = S.parseCircleInstruction("pay round 3 of Family Circle", c);
  assert.deepEqual(p, { kind: "contribute", round: 3 });
  const r = refused(c, S.agentContribute(c, agent(), { circle: c.id, round: p.round, amount: c.amount }));
  assert.deepEqual([r.verdict, r.code, r.reason], ["refused", "round", "Round 2 is open. Round 3 cannot be paid now."]);
  // The same sentence for round 2 goes through once the person has said OK to the pre-notice.
  const two = S.parseCircleInstruction("Pay round 2 of Family Circle", c), said = ok(S.answerPreNotice(c, human(), "ok"));
  assert.equal(S.agentContribute(c, agent(), { circle: c.id, round: two.round, amount: c.amount }).code, "notice");
  assert.equal(S.agentContribute(said, agent(), { circle: c.id, round: two.round, amount: c.amount }).ok, true);
});

// ---------- S14 Plain words ----------
test("susu S14: describe, whatIsDue and whoIsNext answer from circle state only", () => {
  const c = fixture();
  assert.equal(S.describe(c, "you"), "Round 2 of 4. 50 USDC due Oct 14. I will pay on Oct 14 unless you pause me.");
  assert.equal(S.describe(c, "dana"), "Round 2 of 4. 50 USDC due Oct 14. I have no allowance for this circle. Pay by hand.");
  assert.equal(S.describe(c, "kofi"), "Round 2 of 4. 50 USDC due Oct 14. I paid on Oct 13.");
  assert.equal(S.describe(c, "amara"), "Round 2 of 4. 50 USDC due Oct 14. You paid by hand on Oct 10.");
  assert.equal(S.describe(ok(S.pauseAllowance(c, human())), "you"), "Round 2 of 4. 50 USDC due Oct 14. I am paused. Pay by hand or resume me.");
  assert.equal(S.describe(freeze(S.loadFixture(tweak((f) => { f.members[1].usdc = "20"; }))), "you"), "Round 2 of 4. 50 USDC due Oct 14. You hold 20 USDC, so I will stop on Oct 14. Add USDC or pay by hand.");
  assert.equal(S.describe(walk(c, 4), "you"), "Round 3 of 4. 50 USDC due Nov 14. I will pay on Nov 14 unless you pause me.");
  assert.equal(S.describe(forming(), "m1"), "Trio has 0 of 3 seats filled. Round 1 is due Nov 1.");

  assert.deepEqual(S.whatIsDue(c, "you"), { state: "due", round: 2, of: 4, amount: "50", due: "2026-10-14", topUp: "0", text: "50 USDC for round 2 of 4, due Oct 14." });
  assert.equal(S.whatIsDue(c, "dana").text, "50 USDC for round 2 of 4, due Oct 14. A 50 USDC collateral top-up is also pending.");
  assert.deepEqual([S.whatIsDue(c, "kofi").state, S.whatIsDue(c, "kofi").text], ["paid", "Round 2 is paid. Round 3 is due Nov 14."]);
  assert.deepEqual([S.whatIsDue(walk(c, 2), "dana").state, S.whatIsDue(walk(c, 2), "dana").text], ["late", "50 USDC for round 2 of 4, late since Oct 14. The grace ends on Oct 16."]);
  assert.equal(S.whatIsDue(c, "stranger").state, "none");
  assert.deepEqual(S.whoIsNext(c), { round: 2, memberId: "you", name: "nia.sns", due: "2026-10-14", text: "nia.sns takes the round 2 pot. kofi.sns takes round 3." });
  assert.equal(S.whoIsNext(walk(c, 4)).text, "kofi.sns takes the round 3 pot. dana.sns takes round 4.");
  // The answers take the circle and a seat. There is no parameter through which page text could reach them.
  assert.deepEqual([S.describe.length, S.whatIsDue.length, S.whoIsNext.length], [2, 2, 1]);
});

// ---------- S15 History and persistence ----------
test("susu S15: every state change appends a row with the right actor", () => {
  const c = fixture();
  const changes = [
    ["YOU", S.answerPreNotice(c, human(), "ok")], ["YOU", S.pauseAllowance(c, human())], ["YOU", S.payByHand(c, human())],
    ["YOU", S.setAllowance(c, human("amara"))], ["YOU", S.leave(c, human("dana"))], ["YOU", S.withdraw(c, human())],
    ["SCOUT", S.agentContribute(c, agent(), REQ)], ["SCOUT", S.withdraw(c, agent())], ["HERMES", S.payByHand(c, agent("kofi", "Hermes"))],
  ];
  for (const [actor, r] of changes) {
    assert.ok(r.rows.length >= 1);
    assert.deepEqual(r.circle.history.slice(-r.rows.length), r.rows);
    assert.deepEqual(r.circle.history.slice(0, c.history.length), c.history, "earlier rows are kept as they were");
    for (const row of r.rows) {
      assert.deepEqual(Object.keys(row), ["day", "actor", "kind", "text", "member"]);
      assert.deepEqual([row.day, row.actor], [c.today, actor]);
      assert.ok(row.text.length > 0 && typeof row.kind === "string");
    }
  }
  // The clock's own rows come from the program, the scripted members and the agents.
  const day = S.nextDay(walk(c, 3), human());
  assert.ok(day.rows.length === 3 && day.rows.every((row) => row.actor === "PROGRAM" && row.day === "2026-10-17"));
  assert.deepEqual(day.rows.map(S.rowLevel), ["warn", "ok", "ok"]);
  // The clock logs an agent payment under the name the allowance was set for, whoever presses Next day.
  assert.equal(S.nextDay(c, { ...human(), agentName: "Demo" }).rows.find((row) => row.kind === "pay").actor, "SCOUT");
  assert.equal(c.history.length, 24, "the frozen input never changed");
});

test("susu S15: serialize and deserialize round-trip the whole state", () => {
  let c = ok(S.answerPreNotice(fixture(), human(), "ok"));
  c = ok(S.claimPayout(walk(c, 4), human()));
  const text = S.serialize(c);
  assert.equal(typeof text, "string");
  assert.equal(text, box(c));
  assert.deepEqual(S.deserialize(text), c);
  assert.equal(S.serialize(S.deserialize(text)), text);
  assert.deepEqual(S.restore(text, RAW), { circle: c, source: "storage", reason: "" });
  assert.deepEqual(S.restore(S.serialize(fixture()), JSON.parse(RAW)).source, "storage");
  const made = trio();
  assert.deepEqual(S.deserialize(S.serialize(made)), made);
  for (const empty of [null, undefined, ""]) assert.deepEqual(S.restore(empty, RAW), { circle: fixture(), source: "fixture", reason: "Nothing is stored yet." });
});

test("susu S15: tampered serialized state is refused and the fixture is used instead", () => {
  const c = walk(fixture(), 1), text = S.serialize(c), base = fixture();
  const forged = (edit) => { const s = JSON.parse(JSON.stringify(c)); edit(s); return box(s); };
  const tampered = [
    ["a balance edited in place", text.replace('"usdc":"70"', '"usdc":"999999"')],
    ["a payout wallet edited in place", text.replace('"wallet":"mock member"', `"wallet":"${W2}"`)],
    ["a truncated value", text.slice(0, -40)],
    ["a missing checksum", `{"v":1,"state":${JSON.stringify(c)}}`],
    ["a wrong version", text.replace('{"v":1,', '{"v":2,')],
    ["text that is not JSON", "family-circle"],
    ["a number", 42],
    ["an extra field with a matching checksum", forged((s) => { s.admin = "me"; })],
    ["a float balance with a matching checksum", forged((s) => { s.members[1].usdc = 1e9; })],
    ["a second payment with a matching checksum", forged((s) => { s.rounds[1].payments.push({ member: "you", by: "hand", day: "2026-10-14", amount: "50" }); })],
    ["a pot paid twice over with a matching checksum", forged((s) => { s.rounds[0].pot.amount = "400"; })],
    ["a withdrawal row from an unknown actor", forged((s) => { s.history.push({ day: "2026-10-14", actor: "admin", kind: "pay", text: "x", member: "" }); })],
  ];
  assert.ok(text.includes('"usdc":"70"') && text.includes('"wallet":"mock member"'));
  for (const [what, bad] of tampered) {
    assert.throws(() => S.deserialize(bad), (e) => e.constructor === Error && e.message.length > 8, what);
    const r = S.restore(bad, RAW);
    assert.deepEqual([r.source, r.circle], ["fixture", base], what);
    assert.ok(r.reason.length > 8, what);
  }
  // Well-formed, checksum right, and still refused: it does not descend from this fixture.
  const strangers = [
    ["another circle's terms", forged((s) => { s.name = "Family Circlf"; }), /terms/],
    ["a reordered payout", forged((s) => { [s.members[1].name, s.members[2].name] = [s.members[2].name, s.members[1].name]; }), /terms/],
    ["a clock moved back", forged((s) => { s.today = "2026-10-12"; s.history = s.history.filter((h) => h.day <= "2026-10-12"); s.rounds[1].payments = s.rounds[1].payments.filter((p) => p.day <= "2026-10-12"); s.rounds[1].answers = []; }), /older/],
    ["a finished round rewritten", forged((s) => { s.rounds[0].payments[3].by = "hand"; }), /finished round/],
  ];
  for (const [what, bad, why] of strangers) {
    assert.doesNotThrow(() => S.deserialize(bad), what);
    const r = S.restore(bad, RAW);
    assert.deepEqual([r.source, r.circle], ["fixture", base], what);
    assert.match(r.reason, why, what);
  }
  // A broken state is never written, and a broken fixture is never papered over.
  const broken = JSON.parse(JSON.stringify(c));
  broken.members[1].usdc = "70.0";
  assert.throws(() => S.serialize(broken), (e) => e.constructor === Error);
  assert.throws(() => S.restore(text, tweak((f) => { f.mock = false; })), (e) => e.constructor === Error);
});

// ---------- The human-only rules, in one place ----------
test("susu: an agent cannot join, accept terms, set an allowance, claim or withdraw", () => {
  const open = forming(), c = fixture(), ready = walk(c, 4);
  assert.equal(S.payoutSheet(ready, "you").state, "claimable");
  const tries = [
    ["join", open, S.join(open, agent("m1"), yes)],
    ["accept terms", open, S.acceptTerms(open, agent("m1"), { otherCircles: [] })],
    ["decline", open, S.decline(open, agent("m1"))],
    ["set an allowance", c, S.setAllowance(c, agent("amara"))],
    ["pause an allowance", c, S.pauseAllowance(c, agent())],
    ["revoke an allowance", c, S.revokeAllowance(c, agent())],
    ["answer the pre-notice", c, S.answerPreNotice(c, agent(), "ok")],
    ["pay by hand", c, S.payByHand(c, agent())],
    ["claim", ready, S.claimPayout(ready, agent())],
    ["withdraw", ready, S.withdraw(ready, agent(), { amount: "100" })],
    ["top up", ready, S.topUp(ready, agent("dana"))],
    ["leave", c, S.leave(c, agent())],
    ["change terms", c, S.changeTerms(c, agent(), { amount: "5" })],
    ["move the clock", c, S.nextDay(c, agent())],
  ];
  for (const [what, before, r] of tries) {
    refused(before, r);
    assert.equal(r.rows[0].actor, "SCOUT", what);
    assert.match(r.reason, /Agents never|Switch to You|no withdraw instruction/, what);
  }
  assert.equal(S.createCircle(TRIO, agent("m1"), "2026-10-13").reason, "Agents never start a circle. Switch to You.");
  // The same calls from a person go through, so the refusals above are about who is acting.
  assert.equal(S.acceptTerms(open, human("m1"), { otherCircles: [] }).ok, true);
  assert.equal(S.setAllowance(c, human("amara")).ok, true);
  assert.equal(S.claimPayout(ready, human()).ok, true);
});

// ---------- Invariants under arbitrary call order ----------
test("susu: seeded random calls never create or lose USDC, never move money on a refusal, never throw", () => {
  let seed = 20261012;
  const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const pick = (a) => a[rnd(a.length)];
  const wallets = [W, W2, W3, null, "junk", 42];
  const strangers = [undefined, null, 0, "you", {}, [], { mode: "human" }, { mode: "agent", agentName: {} }, { mode: "human", memberId: {}, wallet: {} }];
  const seen = new Set();
  for (let run = 0; run < 45; run++) {
    let c = run % 3 === 1 ? forming() : fixture();
    const ids = [...c.members.map((m) => m.id), "nobody"], sum = total(c);
    for (let step = 0; step < 70; step++) {
      const who = rnd(20) === 0 ? pick(strangers) : { mode: pick(["human", "human", "agent", "root"]), wallet: pick(wallets), memberId: pick(ids), agentName: pick(["Scout", "Hermes", "YOU", "", undefined]), agentHeld: [undefined, false, false, true, "x"][(run + step) % 5] };
      const open = c.rounds.find((r) => r.state === "open");
      const req = { circle: pick([c.id, c.id, "other"]), round: pick([open ? open.n : 1, open ? open.n : 1, 1, 3, "2", null]), amount: pick([c.amount, c.amount, "1", "abc", 50]) };
      const r = pick([
        () => S.nextDay(c, who), () => S.nextDay(c, { mode: "human", wallet: W, memberId: "you", agentName: "Scout" }), () => S.payByHand(c, who), () => S.payByHand(c, who, { round: pick([1, 2, 9, "x"]) }),
        () => S.agentContribute(c, who, req), () => S.agentContribute(c, who, pick([null, "pay", req])), () => S.answerPreNotice(c, who, pick(["ok", "pause", "hand", "x"])),
        () => S.setAllowance(c, who), () => S.pauseAllowance(c, who), () => S.resumeAllowance(c, who), () => S.revokeAllowance(c, who), () => S.claimPayout(c, who),
        () => S.claimPayout(c, who, { round: pick([1, 2, 3, 0, "a"]), to: pick([W, W2, "mock member"]) }), () => S.withdraw(c, who, { amount: "100", to: W2 }), () => S.topUp(c, who), () => S.leave(c, who),
        () => S.changeTerms(c, who, { amount: "1" }), () => S.join(c, who, pick([yes, {}, null])), () => S.acceptTerms(c, who, { otherCircles: [] }), () => S.decline(c, who),
      ])();
      assert.equal(typeof r.ok, "boolean");
      if (!r.ok) assert.equal(ledger(r.circle), ledger(c), r.reason);
      assert.equal(total(r.circle), sum, "USDC is conserved");
      assert.ok(r.circle.members.every((m) => S.parseUsdc(m.usdc) >= 0n && S.parseUsdc(m.collateral) <= S.parseUsdc(c.amount)));
      const text = S.serialize(r.circle);
      // Whatever order the calls come in, the demo circle's stored copy still descends from the fixture.
      if (c.id === "family-circle") assert.equal(S.restore(text, RAW).reason, "", `run ${run}, step ${step}`);
      for (const row of r.rows) seen.add(row.kind);
      c = freeze(r.circle);
    }
  }
  // The walk reached real traffic: payments, draws, pots, joins, claims and refusals.
  for (const kind of ["pay", "draw", "pot", "open", "join", "claim", "block", "stop", "leave", "top-up", "late"]) assert.ok(seen.has(kind), kind);
});

// ---------- The module itself ----------
test("susu: the engine is pure and never writes to the circle it is given", () => {
  for (const [what, re] of [
    ["an import", /^\s*import\s/m], ["a require", /\brequire\s*\(/], ["the DOM", /\b(?:document|window|navigator)\s*\./], ["the network", /\bfetch\s*\(|XMLHttpRequest|WebSocket/],
    ["storage", /\b(?:localStorage|sessionStorage|indexedDB)\b/], ["the system clock", /Date\.now|new Date\(\s*\)|performance\./], ["randomness", /Math\.random|crypto\./],
    ["floating-point money", /parseFloat|toFixed|Math\.round/],
  ]) assert.equal(re.test(SRC), false, `src/susu.js uses ${what}`);
  // Frozen input: any in-place write would throw here.
  const c = fixture(), before = JSON.stringify(c);
  for (const fn of [
    () => S.nextDay(c, human()), () => S.payByHand(c, human()), () => S.agentContribute(c, agent(), REQ), () => S.answerPreNotice(c, human(), "pause"),
    () => S.setAllowance(c, human("dana")), () => S.revokeAllowance(c, human()), () => S.leave(c, human()), () => S.withdraw(c, human()),
    () => S.claimPayout(c, human()), () => S.topUp(c, human("dana")), () => S.changeTerms(c, human("amara")), () => S.overview(c, "you"), () => S.grid(c), () => S.serialize(c),
  ]) assert.doesNotThrow(fn);
  assert.equal(JSON.stringify(c), before);
  // A circle that fails its shape check is refused by every entry point, readers included.
  const bent = JSON.parse(RAW);
  bent.members[1].usdc = 120;
  for (const fn of [() => S.nextDay(bent, human()), () => S.payByHand(bent, human()), () => S.agentContribute(bent, agent(), REQ), () => S.withdraw(bent, human()), () => S.describe(bent, "you"), () => S.overview(bent, "you"), () => S.parseCircleInstruction("Pay round 2 of Family Circle", bent)]) {
    assert.throws(fn, (e) => e.constructor === Error);
  }
});

// ---------- Review fixes (2026-10-12): one test per confirmed finding ----------
test("susu review 1: a held agent pays nothing on the due date, and the stop row says so", () => {
  const c = fixture(), held = { ...human(), agentHeld: true };
  const r = S.nextDay(c, held), after = ok(r);
  assert.deepEqual(r.rows.filter((x) => x.member === "you"), [{ day: "2026-10-14", actor: "SCOUT", kind: "stop", text: "Stopped for nia.sns. The agent is held in the Agents panel. Nothing moved. Pay by hand.", member: "you" }]);
  assert.deepEqual([seat(after, "you").usdc, seat(after, "you").feeSol, S.cell(after, "you", 2).state], ["120", "0.01", "due"]);
  // Fail closed: only a plain false, or no flag at all, lets the agent pay.
  const pays = (who) => S.nextDay(c, who).rows.some((x) => x.kind === "pay" && x.member === "you");
  for (const flag of [true, "no", 1, 0, null, {}]) assert.equal(pays({ ...human(), agentHeld: flag }), false, String(flag));
  assert.deepEqual([pays({ ...human(), agentHeld: false }), pays(human())], [true, true]);
  // The hold follows the agent, whichever seat is viewed. Another member's agent still pays on the program's clock.
  assert.deepEqual(S.nextDay(c, { ...human("amara"), agentHeld: true }).rows.filter((x) => x.member === "you").map((x) => [x.actor, x.kind]), [["SCOUT", "stop"]]);
  const nov14 = S.nextDay(walk(c, 31), held);
  assert.equal(nov14.day, "2026-11-14");
  assert.deepEqual(nov14.rows.filter((x) => x.kind === "pay" || x.kind === "stop").map((x) => [x.actor, x.kind, x.member]), [["SCOUT", "stop", "you"], ["HERMES", "pay", "kofi"]]);
  // A person still pays by hand after the stop.
  assert.equal(S.payByHand(after, human()).ok, true);
});

test("susu review 2: an agent contribution needs a connected wallet, and a joined seat answers only to its own", () => {
  // Trio seat m1 joined with wallet W and turned the allowance on. Oct 31 is the notice day and the member said OK.
  let c = walk(ok(S.setAllowance(trio(), human("m1"))), 18, human("m1"));
  assert.equal(c.today, "2026-10-31");
  c = ok(S.answerPreNotice(c, human("m1"), "ok"));
  const req = { circle: "trio", round: 1, amount: "50" }, as = (wallet) => ({ ...agent("m1"), wallet });
  assert.equal(refused(c, S.payByHand(c, human("m1", W2))).reason, "This wallet is not a member of Trio.");
  for (const [wallet, code, reason] of [[W2, "member", "This wallet is not a member of Trio."], [null, "wallet", "No wallet is connected. Connect Phantom first."], ["junk", "wallet", "No wallet is connected. Connect Phantom first."]]) {
    assert.deepEqual(S.checkContribute(c, as(wallet), req), { verdict: "refused", code, reason }, String(wallet));
    const r = refused(c, S.agentContribute(c, as(wallet), req));
    assert.deepEqual([r.code, r.reason, r.rows[0].actor], [code, reason, "SCOUT"]);
  }
  const paid = S.agentContribute(c, as(W), req);
  assert.deepEqual([paid.ok, paid.rows[0].text, seat(paid.circle, "m1").usdc], [true, "Paid 50 USDC to Trio for round 1 of 3 under ama.sns's allowance.", "400"]);
  // A fixture seat holds the mock label, so any connected wallet stands in for it. With none connected the agent is refused.
  const f = ok(S.answerPreNotice(fixture(), human(), "ok"));
  assert.equal(refused(f, S.agentContribute(f, { ...agent(), wallet: null }, REQ)).code, "wallet");
  assert.equal(S.agentContribute(f, { ...agent(), wallet: W3 }, REQ).ok, true);
  // The program's clock is no agent trigger. It pays the seat's share on the due date with no wallet connected.
  assert.equal(S.cell(ok(S.nextDay(f, human("you", null))), "you", 2).label, "paid by agent");
});

test("susu review 3: the agent pays after the pre-notice, and on the notice day only after an OK", () => {
  const c = fixture();
  // Notice day, no answer yet: the agent stops and the notice still waits.
  assert.deepEqual(S.checkContribute(c, agent(), REQ), { verdict: "stopped", code: "notice", reason: "The pre-notice for round 2 waits for your answer. Nothing moved." });
  const wait = refused(c, S.agentContribute(c, agent(), REQ), "stopped");
  assert.deepEqual([wait.code, wait.rows[0].actor, S.preNotice(wait.circle, "you").answer], ["notice", "SCOUT", null]);
  // After the OK the same request pays, and the OK row sits before the pay row.
  const said = ok(S.answerPreNotice(wait.circle, human(), "ok")), paid = ok(S.agentContribute(said, agent(), REQ));
  assert.deepEqual(paid.history.slice(-2).map((h) => [h.actor, h.kind, h.day]), [["YOU", "ok", "2026-10-13"], ["SCOUT", "pay", "2026-10-13"]]);
  // Pause at the notice, then resume: the notice holds no OK, so the agent waits for the due date.
  const resumed = ok(S.resumeAllowance(ok(S.answerPreNotice(c, human(), "pause")), human()));
  const later = refused(resumed, S.agentContribute(resumed, agent(), REQ), "stopped");
  assert.deepEqual([later.code, later.reason], ["notice", "The pre-notice for round 2 holds no OK. The agent pays on Oct 14. Nothing moved."]);
  assert.equal(S.cell(walk(resumed, 1), "you", 2).label, "paid by agent");
  // On the due date itself the agent pays with or without an answer.
  const due = ok(S.resumeAllowance(walk(ok(S.pauseAllowance(c, human())), 1), human()));
  assert.deepEqual([due.today, due.rounds[1].answers.some((a) => a.member === "you"), S.agentContribute(due, agent(), REQ).ok], ["2026-10-14", false, true]);
  // Round 3 opens on Oct 17. Its notice goes out on Nov 13, and the agent pays nothing before that day.
  const open = walk(c, 4), req3 = { ...REQ, round: 3 };
  assert.deepEqual([open.today, S.preNotice(open, "you")], ["2026-10-17", null]);
  const early = refused(open, S.agentContribute(open, agent(), req3));
  assert.deepEqual([early.code, early.reason], ["early", "The agent pays after the pre-notice. The notice for round 3 goes out on Nov 13."]);
  assert.equal(refused(walk(open, 26), S.agentContribute(walk(open, 26), agent(), req3)).code, "early", "Nov 12 is still early");
  assert.equal(S.checkContribute(walk(open, 27), agent(), req3).code, "notice", "Nov 13 is the notice day");
  // The fixture keeps the same rule: an agent payment before the due date follows a notice row and that seat's OK.
  for (const r of c.rounds) for (const p of r.payments.filter((x) => x.by === "agent" && x.day < r.due)) {
    const rows = c.history.filter((h) => h.member === p.member && h.day === S.addDays(r.due, -1)).map((h) => h.kind);
    assert.deepEqual([p.day, rows, r.answers.filter((a) => a.member === p.member).map((a) => a.answer)], [S.addDays(r.due, -1), ["notice", "ok", "pay"], ["ok"]], `round ${r.n}, ${p.member}`);
  }
  assert.equal(c.rounds[1].payments.some((p) => p.member === "kofi" && p.by === "agent"), true, "the opening frame keeps one cell paid by agent");
});

test("susu review 4: a stored copy the engine could never reach is set aside for the fixture", () => {
  const base = fixture(), day14 = walk(base, 1);
  const forged = (from, edit) => { const s = JSON.parse(JSON.stringify(from)); edit(s); return box(s); };
  const okRow = { day: "2026-10-13", actor: "YOU", kind: "ok", text: "Said OK. The agent pays 50 USDC to Family Circle on Oct 14.", member: "you" };
  const cases = [
    ["a paid pot made claimable again", forged(base, (s) => { s.rounds[0].pot = { state: "claimable", amount: "200", since: "2026-09-17", paidOn: "" }; }), /finished round/],
    ["a paid pot's date moved", forged(day14, (s) => { s.rounds[0].pot.paidOn = "2026-10-14"; }), /finished round/],
    ["a finished round's answer erased", forged(base, (s) => { s.rounds[0].answers = []; }), /finished round/],
    ["a payout wallet swapped", forged(base, (s) => { s.members[1].wallet = W2; }), /seat/],
    ["a join date moved", forged(base, (s) => { s.members[1].joinedOn = "2026-09-10"; }), /seat/],
    ["the open round's payments erased and refunded", forged(day14, (s) => { s.rounds[1].payments.splice(0, 2); s.members[0].usdc = "360"; s.members[2].usdc = "180"; }), /open round/],
    ["an open-round payment re-dated", forged(day14, (s) => { s.rounds[1].payments[0].day = "2026-10-11"; }), /open round/],
    ["an answer erased", forged(day14, (s) => { s.rounds[1].answers = []; }), /open round/],
    ["the history replaced by one forged OK", forged(base, (s) => { s.history = [okRow]; s.rounds[1].answers.push({ member: "you", answer: "ok", day: "2026-10-13" }); }), /history/],
    ["a fixture row dropped", forged(day14, (s) => { s.history.splice(3, 1); }), /history/],
    ["a fixture row reworded", forged(day14, (s) => { s.history[0].text = "Created Family Circle."; }), /history/],
    ["USDC minted in a seat", forged(base, (s) => { s.members[1].usdc = "99999"; }), /USDC/],
    ["USDC taken from a seat", forged(day14, (s) => { s.members[0].usdc = "0"; }), /USDC/],
    ["collateral restored for free", forged(base, (s) => { s.members[3].collateral = "50"; }), /USDC/],
    ["a fee balance raised", forged(day14, (s) => { s.members[1].feeSol = "5"; }), /fee/],
  ];
  for (const [what, text, why] of cases) {
    assert.doesNotThrow(() => S.deserialize(text), what);
    const r = S.restore(text, RAW);
    assert.deepEqual([r.source, r.circle], ["fixture", base], what);
    assert.match(r.reason, why, what);
  }
  // The reviewer's copy: round 1 claimable again, 99999 USDC, another wallet, round 2's payments erased. It loaded, and the pot paid out twice.
  const twice = forged(base, (s) => { s.rounds[0].pot = { state: "claimable", amount: "200", since: "2026-09-17", paidOn: "" }; s.members[1].usdc = "99999"; s.members[1].wallet = W2; s.rounds[1].payments = []; s.rounds[1].answers = []; });
  assert.equal(S.restore(twice, RAW).source, "fixture");
  // What the engine itself writes still loads, every day of a full run with an OK, a claim, a payment by hand and a seat that leaves.
  let c = ok(S.answerPreNotice(base, human(), "ok"));
  const steps = {
    "2026-10-17": (x) => ok(S.claimPayout(x, human())), "2026-10-20": (x) => ok(S.leave(x, human("dana"))),
    "2026-10-21": (x) => freeze(S.withdraw(x, human()).circle), "2026-11-13": (x) => ok(S.answerPreNotice(x, human("kofi"), "hand")),
  };
  for (let i = 0; i < 70; i++) {
    c = ok(S.nextDay(c, human()));
    if (steps[c.today]) c = steps[c.today](c);
    assert.deepEqual(S.restore(S.serialize(c), RAW), { circle: c, source: "storage", reason: "" }, c.today);
  }
  assert.deepEqual([c.status, seat(c, "dana").status, c.history.some((h) => h.kind === "block")], ["complete", "left", true]);
});

test("susu review 5: a decline needs a connected wallet", () => {
  const c = forming();
  for (const wallet of [null, "junk"]) assert.equal(refused(c, S.decline(c, human("m2", wallet))).reason, "No wallet is connected. Connect Phantom first.");
  assert.equal(seat(ok(S.decline(c, human("m2", W2))), "m2").status, "declined");
});

test("susu review 6: an allowance is used by, and logged under, the agent it was set for", () => {
  // Round 3, viewed as kofi.sns: kofi's rows carry HERMES and nia's carry SCOUT, as they do viewed from any other seat.
  const rowsAs = (viewer) => {
    let c = walk(fixture(), 4), rows = [];
    while (c.today < "2026-11-14") { const r = S.nextDay(c, human(viewer)); c = ok(r); rows.push(...r.rows.filter((x) => x.kind === "notice" || x.kind === "pay").filter((x) => x.member !== "amara")); }
    return rows.map((x) => [x.day, x.actor, x.kind, x.member]);
  };
  const want = [["2026-11-13", "SCOUT", "notice", "you"], ["2026-11-13", "HERMES", "notice", "kofi"], ["2026-11-14", "SCOUT", "pay", "you"], ["2026-11-14", "HERMES", "pay", "kofi"]];
  for (const viewer of ["kofi", "you", "amara", "dana", "nobody"]) assert.deepEqual(rowsAs(viewer), want, viewer);
  // Nov 13, kofi.sns said OK. Scout asks to pay from kofi's seat and is refused. Hermes pays.
  const c = ok(S.answerPreNotice(walk(fixture(), 31), human("kofi"), "ok")), req = { ...REQ, round: 3 };
  assert.deepEqual(S.checkContribute(c, agent("kofi", "Scout"), req), { verdict: "refused", code: "allowance", reason: "This allowance is set for Hermes." });
  const no = refused(c, S.agentContribute(c, agent("kofi", "Scout"), req));
  assert.deepEqual([no.code, no.rows[0].actor, seat(no.circle, "kofi").usdc], ["allowance", "SCOUT", "130"]);
  const yesRow = S.agentContribute(c, agent("kofi", "hermes"), req);
  assert.deepEqual([yesRow.ok, yesRow.rows[0].actor, yesRow.rows[0].text], [true, "HERMES", "Paid 50 USDC to Family Circle for round 3 of 4 under kofi.sns's allowance."]);
  // A wrong agent is refused even while the allowance is paused: the request itself is wrong.
  const paused = ok(S.pauseAllowance(walk(fixture(), 31), human("kofi")));
  assert.equal(S.checkContribute(paused, agent("kofi", "Scout"), req).code, "allowance");
  assert.equal(S.checkContribute(paused, agent("kofi", "Hermes"), req).code, "paused");
  // An allowance that names no agent is logged under the acting member's own agent, and under AGENT for anyone else.
  const unnamed = freeze(S.loadFixture(tweak((f) => { f.members[1].allowance.agent = ""; })));
  const actor = (who) => S.nextDay(unnamed, who).rows.find((x) => x.kind === "pay" && x.member === "you").actor;
  assert.deepEqual([actor(human()), actor({ ...human(), agentName: "Demo" }), actor(human("kofi"))], ["SCOUT", "DEMO", "AGENT"]);
});
