// Security core, shared by the human and the agent.
//   1. Leak check: stop things that look like secrets from being submitted through RobotFac3's own inputs.
//   2. Injection detector (heuristic): flags text aimed at AI agents. Telemetry only; it is NOT the protection.
//   3. Agent policy: the actual protection. Payment details that came from web content are never acted on,
//      and anything over the spend limit goes to a human.
import { decode } from "./solana/base58.js";
import { solToLamports, lamportsToSol, fromBase64 } from "./solana/tx.js";

// ---------- 1. Leak check ----------
let bip39 = null;
// src/vendor/bip39-english.txt, sha256 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
export function setWordlist(text) {
  const words = String(text).split("\n").map((w) => w.trim()).filter(Boolean);
  bip39 = words.length === 2048 ? new Set(words) : null;
}
// True while the word list is missing. The check still runs, with a broader rule that flags more harmless text.
export const isDegraded = () => bip39 === null;

// A best-effort sample of common token shapes, not a complete list.
const TOKEN_PATTERNS = [
  { type: "API key", re: /(?<![A-Za-z0-9])sk-(ant-|proj-)[A-Za-z0-9_-]{20,}/ },
  { type: "API key", re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{32,}/ },
  { type: "API key", re: /(?<![A-Za-z0-9])[sr]k_(live|test)_[A-Za-z0-9]{20,}/ },
  { type: "API key", re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { type: "AWS access key", re: /(?<![A-Za-z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/ },
  { type: "GitHub token", re: /(?<![A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})/ },
  { type: "Slack token", re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{20,}/ },
  { type: "Private key file", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { type: "Login token (JWT)", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const MAX_CANDIDATES = 16;

// A Solana secret key is 64 bytes: a 32-byte seed followed by the public key derived from it.
// A transaction signature is also 64 bytes, so length alone proves nothing. We check the derivation
// with the browser's own Ed25519 (sign with the seed, verify with the claimed public key).
// Returns true, false, or null when this browser can't do the check.
async function isSecretKey(bytes) {
  if (bytes.length !== 64) return false;
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(bytes.subarray(0, 32), 16);
  try {
    const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    const pub = await crypto.subtle.importKey("raw", bytes.subarray(32), { name: "Ed25519" }, false, ["verify"]);
    const probe = new Uint8Array(8);
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, probe);
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, probe);
  } catch {
    return null;
  } finally {
    pkcs8.fill(0);
  }
}

const B58 = "1-9A-HJ-NP-Za-km-z";
const RE_B58_RUN = new RegExp(`(?<![${B58}])[${B58}]{80,100}(?![${B58}])`, "g");
const RE_B58_WRAPPED = new RegExp(`(?<![${B58}])[${B58}]{8,}(?:\\s+[${B58}]{8,}){1,8}(?![${B58}])`, "g");
const RE_BYTE_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*,?\s*\]/g;
const RE_NUMBER_LIST = /(?<![\dA-Za-z])\d{1,3}(?:[^\dA-Za-z]{1,8}\d{1,3}){63,127}(?!\d)/g;
const RE_HEX = /(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{128})(?![0-9a-fA-F])/g;
const RE_BASE64 = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{86}(?:==)?(?![A-Za-z0-9+/_=-])/g;

const tryDecode = (fn) => { try { return fn(); } catch { return null; } };
const bytesFromNumbers = (nums) => (nums.length === 64 && nums.every((n) => n >= 0 && n <= 255) ? Uint8Array.from(nums) : null);

// Every candidate still has to pass isSecretKey, so widening this list cannot add false positives.
// "canonical" marks the two ordinary ways a Solana key is written; only those are blocked when the
// browser can't run the keypair check (otherwise any long hash would be blocked there).
function secretKeyCandidates(text) {
  const out = [];
  const add = (bytes, canonical = false) => { if (bytes && bytes.length === 64 && out.length < MAX_CANDIDATES) out.push({ bytes, canonical }); };

  for (const m of text.matchAll(RE_B58_RUN)) {
    const run = m[0];
    if (run.length <= 90) add(tryDecode(() => decode(run)), true);
    // A key glued to a prefix or suffix: try key-length windows at both ends.
    for (const len of [86, 87, 88]) {
      if (run.length > len) {
        add(tryDecode(() => decode(run.slice(0, len))));
        add(tryDecode(() => decode(run.slice(-len))));
      }
    }
  }
  for (const m of text.matchAll(RE_B58_WRAPPED)) {
    const joined = m[0].replace(/\s+/g, "");
    if (joined.length >= 80 && joined.length <= 90) add(tryDecode(() => decode(joined)));
  }
  for (const m of text.matchAll(RE_BYTE_ARRAY)) add(bytesFromNumbers(m[0].match(/\d+/g).map(Number)), true);
  for (const m of text.matchAll(RE_NUMBER_LIST)) {
    const nums = m[0].match(/\d+/g).map(Number);
    add(bytesFromNumbers(nums.slice(0, 64)));
    if (nums.length > 64) add(bytesFromNumbers(nums.slice(-64)));
  }
  for (const m of text.matchAll(RE_HEX)) add(Uint8Array.from(m[1].match(/../g), (h) => parseInt(h, 16)));
  for (const m of text.matchAll(RE_BASE64)) add(tryDecode(() => fromBase64(m[0].replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "") + "==")));
  return out;
}

// A seed phrase is 12 to 24 BIP39 words. We flag any 12-token window where at least 11 tokens are BIP39 words
// (so one typo or an "and" doesn't hide it) and at least 9 are different (so "test test test…" doesn't trip it).
// Known gaps: non-English word lists, words run together, 4-letter abbreviations.
function findSeedPhrase(text) {
  const cleaned = text.normalize("NFKC").toLowerCase()
    .replace(/\b\d+(st|nd|rd|th)\b/g, " ")   // 1st, 2nd …
    .replace(/\bw\d+\s*=/g, " ")             // w1= …
    .replace(/(^|\s)[a-z]\)/g, " ");         // a) b) …
  const tokens = cleaned.split(/[^a-z]+/).filter(Boolean);
  const isWord = bip39 ? (w) => bip39.has(w) : (w) => w.length >= 3 && w.length <= 8;
  const need = bip39 ? 11 : 12;
  for (let i = 0; i + 12 <= tokens.length; i++) {
    const window = tokens.slice(i, i + 12);
    if (window.filter(isWord).length >= need && new Set(window).size >= 9) return true;
  }
  return false;
}

export async function scanForSecrets(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (findSeedPhrase(t)) return { type: "Seed phrase" };

  const candidates = secretKeyCandidates(t);
  let unverified = false;
  try {
    for (const c of candidates) {
      const verdict = await isSecretKey(c.bytes);
      if (verdict === true) return { type: "Solana private key" };
      if (verdict === null && c.canonical) unverified = true;
    }
  } finally {
    for (const c of candidates) c.bytes.fill(0);
  }
  if (unverified) return { type: "Possible private key", note: "This browser can't tell a private key from a transaction signature, so RobotFac3 blocked it to be safe." };

  for (const p of TOKEN_PATTERNS) if (p.re.test(t)) return { type: p.type };
  return null;
}

// ---------- 2. Injection detector (heuristic, telemetry only) ----------
const INJECTION_RE =
  /(ignore (all |any )?(previous|prior) instructions|attention (ai|agent)|system prompt|you are an? (ai|agent)|as an ai agent)[\s\S]{0,200}?(send|transfer|approve|sign)\s+(?<amount>\d*\.?\d+)\s*sol\s+to\s+(?<target>[\w-]+(\.[\w-]+)*)/i;

export function detectInjection(pageText) {
  const m = String(pageText || "").match(INJECTION_RE);
  if (!m) return null;
  return { amount: m.groups.amount, target: m.groups.target, excerpt: m[0].slice(0, 160) };
}

// ---------- 3. Agent policy ----------
export const DEFAULT_CAP = "0.01";

// Reads "Send 0.5 SOL to name.sns" and nothing looser. A sentence that mentions an amount or a name but doesn't
// fit exactly is "unclear" and must be refused, never guessed at: a looser pattern once read "0,5 sol" as 5 SOL.
const PAYMENT_RE = /^(?:please\s+)?(?:tip|send|pay)\s+((?:0|[1-9]\d*)(?:\.\d{1,9})?)\s*sol\s+to\s+([a-z0-9_-]{1,63}\.(?:sns|sol))[.!]?$/i;
export function parsePaymentRequest(task) {
  const text = String(task || "").trim();
  const m = text.match(PAYMENT_RE);
  if (m) {
    try {
      // One canonical amount string, used for the policy check, the screen and the signed bytes.
      return { kind: "payment", amount: lamportsToSol(solToLamports(m[1])), name: m[2].toLowerCase() };
    } catch { return { kind: "unclear" }; }
  }
  const mentionsMoney = /\d/.test(text) && (/\bsol\b/i.test(text) || /\.(sns|sol)\b/i.test(text));
  return { kind: mentionsMoney ? "unclear" : "none" };
}

export function getCap() {
  try {
    const v = localStorage.getItem("rf3.cap");
    solToLamports(v);
    return v;
  } catch { return DEFAULT_CAP; }
}

// origin: "user" (the human typed it) or "page" (it came from web content).
// Web content can never create a payment, whatever the amount. Anything that doesn't parse is refused.
export function evaluateAgentPayment({ amount, origin }) {
  if (origin !== "user") {
    return { verdict: "block", reason: "The payment details came from web content, not from you." };
  }
  let lamports, cap;
  try {
    lamports = solToLamports(amount);
    cap = solToLamports(getCap());
  } catch {
    return { verdict: "block", reason: "That amount isn't valid." };
  }
  if (lamports > cap) {
    return { verdict: "escalate", reason: `${amount} SOL is over the agent's ${getCap()} SOL spend limit.` };
  }
  return { verdict: "allow", reason: `Within the ${getCap()} SOL spend limit. You still approve and sign.` };
}
