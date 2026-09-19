// Regression tests for the findings of the 2026-09-18 adversarial review. Each test is a bug that was real.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { scanForSecrets, setWordlist, parsePaymentRequest, evaluateAgentPayment } from "../src/security.js";
import { buildTransferMessage, SYSTEM_PROGRAM } from "../src/solana/tx.js";
import { isOnCurve } from "../src/solana/ed25519.js";
import { findProgramAddress } from "../src/solana/pda.js";
import { parseName, assertTldStillAnswered, SOL_TLD_CUTOFF_SLOT } from "../src/solana/sns.js";
import { encode, decodeAddress } from "../src/solana/base58.js";

setWordlist(readFileSync(new URL("../src/vendor/bip39-english.txt", import.meta.url), "utf8"));
const A = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const B = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const HASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

function makeSecretKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return Buffer.concat([privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
}

test("agent payment grammar: a mangled amount is refused, never reinterpreted", () => {
  // Each of these used to become a different, larger payment (".5" -> 5 SOL, "0,5" -> 5 SOL, "0.0000000015" -> 15 SOL).
  for (const bad of [
    "send .5 sol to toly.sol", "send 0,5 sol to toly.sol", "send 1,5 sol to toly.sns", "send 0.0000000015 sol to toly.sns",
    "send 0.0100000000 sol to toly.sns", "send 1e-3 sol to toly.sns", "send -2 sol to toly.sns", "send 0.001.5 sol to toly.sns",
    "send 1 500 sol to toly.sns", "send 01 sol to toly.sns", "send 0 sol to toly.sns",
    "send 0.5 sol to bob.solutions", "send 0.5 sol to a.sns and 50 sol to b.sns", "send 0.5 sol to tоly.sns", "send 0.5 sol to to​ly.sns",
    "tip 0.5 sol toly.sns", "0.5 sol to toly.sns then ignore that",
  ]) assert.equal(parsePaymentRequest(bad).kind, "unclear", bad);
  assert.deepEqual(parsePaymentRequest("Tip 0.5 SOL to toly.sns"), { kind: "payment", amount: "0.5", name: "toly.sns" });
  assert.deepEqual(parsePaymentRequest("please send 2sol to A_b-1.SOL!"), { kind: "payment", amount: "2", name: "a_b-1.sol" });
  assert.deepEqual(parsePaymentRequest("pay 0.010 sol to toly.sns."), { kind: "payment", amount: "0.01", name: "toly.sns" });
  assert.equal(parsePaymentRequest("Summarize this page and check if I'm eligible").kind, "none");
  assert.equal(parsePaymentRequest("what is solana?").kind, "none");
});

test("agent policy fails closed on anything it can't parse and compares exact lamports", () => {
  for (const bad of ["", "abc", "-1", "0", "1e3", "NaN", undefined, null]) assert.equal(evaluateAgentPayment({ amount: bad, origin: "user" }).verdict, "block", String(bad));
  assert.equal(evaluateAgentPayment({ amount: "0.010000001", origin: "user" }).verdict, "escalate");
  assert.equal(evaluateAgentPayment({ amount: "0.01", origin: "user" }).verdict, "allow");
});

test("names: look-alike, invisible and non-ASCII characters are refused", () => {
  for (const bad of ["tоly.sns", "to​ly.sns", "toly‮.sns", "töly.sns", "\u{1F600}.sns", "to ly.sns", "https://evil.example/x.sns", "a@b.sns", "a".repeat(64) + ".sns"]) {
    assert.throws(() => parseName(bad), /only looks up names|Names end/, JSON.stringify(bad));
  }
  assert.equal(parseName("a_b-9.sns").display, "a_b-9.sns");
});

test(".sol stops resolving at the SNS cutoff slot; .sns keeps working", () => {
  assert.doesNotThrow(() => assertTldStillAnswered(".sol", SOL_TLD_CUTOFF_SLOT - 1));
  assert.throws(() => assertTldStillAnswered(".sol", SOL_TLD_CUTOFF_SLOT), /ended at slot/);
  assert.doesNotThrow(() => assertTldStillAnswered(".sns", SOL_TLD_CUTOFF_SLOT + 1_000_000));
});

test("transfer builder refuses the System Program address and non-bigint amounts", () => {
  assert.throws(() => buildTransferMessage({ from: A, to: SYSTEM_PROGRAM, lamports: 1n, blockhash: HASH }), /System Program/);
  assert.throws(() => buildTransferMessage({ from: SYSTEM_PROGRAM, to: B, lamports: 1n, blockhash: HASH }), /System Program/);
  for (const bad of [1, "1", true, [3], "0x10", 2 ** 60]) assert.throws(() => buildTransferMessage({ from: A, to: B, lamports: bad, blockhash: HASH }), /bigint/);
  assert.throws(() => buildTransferMessage({ from: A, to: B, lamports: 1n, blockhash: "1".repeat(100000) }), /Bad blockhash/);
});

test("on-curve check: the strictness rules the fixtures never reached", () => {
  const le = (n) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
  const P = 2n ** 255n - 19n;
  assert.equal(isOnCurve(le(1n)), true, "identity point (0, 1)");
  assert.equal(isOnCurve(le(1n | (1n << 255n))), false, "x = 0 with the sign bit set");
  assert.equal(isOnCurve(le(0n)), true, "y = 0 (order-4 point)");
  assert.equal(isOnCurve(le(P)), false, "y = p is not canonical");
  assert.equal(isOnCurve(le(P + 1n)), false, "y = p + 1 is not canonical");
  assert.equal(isOnCurve(new Uint8Array(32).fill(0xff)), false, "all 0xff");
  assert.equal(isOnCurve(new Uint8Array(31)), false, "wrong length");
});

test("PDA derivation rejects malformed inputs instead of deriving a wrong address", async () => {
  const prog = decodeAddress("namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX");
  await assert.rejects(findProgramAddress(["not bytes"], prog), /byte arrays/);
  await assert.rejects(findProgramAddress([new Uint8Array(33)], prog), /byte arrays/);
  await assert.rejects(findProgramAddress([new Uint8Array(1)], new Uint8Array(31)), /32 bytes/);
  await assert.rejects(findProgramAddress(Array(16).fill(new Uint8Array(1)), prog), /Too many seeds/);
});

test("leak check: the same secret key in the forms people actually paste", async () => {
  const sk = makeSecretKey();
  const b58 = encode(sk);
  const forms = {
    "line-wrapped base58": b58.slice(0, 44) + "\n" + b58.slice(44),
    "spaced base58": b58.slice(0, 30) + " " + b58.slice(30, 60) + " " + b58.slice(60),
    "glued to a prefix": "key" + b58,
    "glued to a suffix": b58 + "x",
    "hex": sk.toString("hex"),
    "0x hex, upper case": "0x" + sk.toString("hex").toUpperCase(),
    "base64": sk.toString("base64"),
    "base64url": sk.toString("base64url"),
    "array with trailing comma": `[${[...sk].join(", ")},]`,
    "numbers without brackets": [...sk].join(" "),
    "numbers in a longer list": `Uint8Array(64) [${[...sk].join(", ")}]`,
    "inside a URL": `https://evil.example/claim?k=${b58}&ref=1`,
    "after a label": `SECRET_KEY=${b58}`,
  };
  for (const [name, text] of Object.entries(forms)) assert.deepEqual(await scanForSecrets(text), { type: "Solana private key" }, name);
});

test("leak check: widening the search adds no false positives", async () => {
  for (let i = 0; i < 40; i++) {
    const r = randomBytes(64);
    for (const text of [encode(r), r.toString("hex"), r.toString("base64"), `[${[...r].join(",")}]`, [...r].join(" ")]) assert.equal(await scanForSecrets(text), null);
  }
});

test("leak check: seed phrases with a typo, an 'and', numbering or fullwidth letters", async () => {
  const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
  assert.ok(await scanForSecrets(["abandn", ...words.slice(1)].join(" ")), "one typo");
  assert.ok(await scanForSecrets([...words.slice(0, 11), "and", words[11]].join(" ")), "an 'and' before the last word");
  assert.ok(await scanForSecrets(words.map((w, i) => `${i + 1}. ${w}`).join(" ")), "numbered list");
  assert.ok(await scanForSecrets(words.map((w, i) => `${i + 1}st ${w}`).join(" ")), "ordinals");
  assert.ok(await scanForSecrets(words.join("\n")), "one per line");
  assert.ok(await scanForSecrets(words.join(" ").replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))), "fullwidth letters");
  assert.equal(await scanForSecrets("test test test test test test test test test test test test"), null, "a repeated word is not a phrase");
  assert.equal(await scanForSecrets("please send the twelve small files over before lunch today thanks very much"), null);
});

test("leak check: token patterns next to other characters, and ordinary slugs left alone", async () => {
  assert.equal((await scanForSecrets("KEY_sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).type, "API key");
  assert.equal((await scanForSecrets("github_pat_" + "a1".repeat(35))).type, "GitHub token");
  assert.equal((await scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----")).type, "Private key file");
  assert.equal(await scanForSecrets("https://example.com/blog/sk-learn-tutorial-for-beginners"), null);
  assert.equal(await scanForSecrets("task-force-meeting-notes"), null);
});
