// Security core, shared by the human and the agent.
//   1. Leak check: stop things that look like secrets from being submitted through RobotFac3's own inputs.
//   2. Injection detector (heuristic): flags text aimed at AI agents. Telemetry only; it is NOT the protection.
//   3. Agent policy: the actual protection. Payment details that came from web content are never acted on,
//      and anything over the spend limit goes to a human.
import { decode } from "./solana/base58.js";

// ---------- 1. Leak check ----------
let bip39 = null;
// src/vendor/bip39-english.txt, sha256 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
export function setWordlist(text) {
  const words = text.split("\n").map((w) => w.trim()).filter(Boolean);
  bip39 = words.length === 2048 ? new Set(words) : null;
}

const TOKEN_PATTERNS = [
  { type: "API key", re: /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { type: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
];
const SEED_LENGTHS = [12, 15, 18, 21, 24];
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

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

function findSeedPhrase(text) {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!bip39) {
    // Word list unavailable: fall back to the broad rule (may flag harmless text, never misses a phrase).
    return SEED_LENGTHS.includes(words.length) && words.every((w) => w.length >= 3 && w.length <= 8);
  }
  let run = 0;
  for (const w of words) {
    run = bip39.has(w) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

export async function scanForSecrets(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (findSeedPhrase(t)) return { type: "Seed phrase" };

  const candidates = [];
  for (const m of t.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g)) {
    try { candidates.push(decode(m[0])); } catch { /* not base58 */ }
  }
  for (const m of t.matchAll(/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g)) {
    const nums = m[0].slice(1, -1).split(",").map((n) => Number(n.trim()));
    if (nums.every((n) => n >= 0 && n <= 255)) candidates.push(Uint8Array.from(nums));
  }
  let unverified = false;
  try {
    for (const bytes of candidates) {
      const verdict = await isSecretKey(bytes);
      if (verdict === true) return { type: "Solana private key" };
      if (verdict === null && bytes.length === 64) unverified = true;
    }
  } finally {
    for (const bytes of candidates) bytes.fill(0);
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

export function getCap() {
  try {
    const v = localStorage.getItem("rf3.cap");
    return v && /^\d+(\.\d{1,9})?$/.test(v) && Number(v) > 0 ? v : DEFAULT_CAP;
  } catch { return DEFAULT_CAP; }
}

// origin: "user" (the human typed it) or "page" (it came from web content).
// Web content can never create a payment, whatever the amount.
export function evaluateAgentPayment({ amount, origin }) {
  if (origin !== "user") {
    return { verdict: "block", reason: "The payment details came from web content, not from you." };
  }
  const cap = getCap();
  if (Number(amount) > Number(cap)) {
    return { verdict: "escalate", reason: `${amount} SOL is over the agent's ${cap} SOL spend limit.` };
  }
  return { verdict: "allow", reason: `Within the ${cap} SOL spend limit. You still approve and sign.` };
}
