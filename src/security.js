// Security core: shared by the human and the agent.
// 1. DLP — stop secrets from leaving the browser.
// 2. Injection guard — web content can't give the agent orders.
// 3. Agent policy — spend limits; a human approves every signature.

const SECRET_PATTERNS = [
  { type: "API key", re: /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { type: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { type: "Solana private key", re: /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/ },
  { type: "Private key (byte array)", re: /\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
];

export function scanForSecrets(text) {
  const t = (text || "").trim();
  const words = t.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return { type: "Seed phrase" };
  }
  for (const p of SECRET_PATTERNS) if (p.re.test(t)) return { type: p.type };
  return null;
}

const INJECTION_RE =
  /(ignore (all |any )?(previous|prior) instructions|attention (ai|agent)|system prompt|you are an? (ai|agent)|as an ai agent)[\s\S]{0,200}?(send|transfer|approve|sign)\s+(?<amount>\d*\.?\d+)\s*sol\s+to\s+(?<target>[\w-]+(\.[\w-]+)*)/i;

export function scanForInjection(pageText) {
  const m = (pageText || "").match(INJECTION_RE);
  if (!m) return null;
  return { amount: parseFloat(m.groups.amount), target: m.groups.target, excerpt: m[0].slice(0, 160) };
}

export const DEFAULT_CAP = 0.01;
export function getCap() {
  try { return parseFloat(localStorage.getItem("rf3.cap")) || DEFAULT_CAP; } catch { return DEFAULT_CAP; }
}

// origin: "user" (you typed/asked it) or "page" (it came from web content)
export function evaluateAgentPayment({ amount, origin }) {
  if (origin !== "user") {
    return { verdict: "block", reason: "The destination came from web content, not from you." };
  }
  const cap = getCap();
  if (amount > cap) {
    return { verdict: "escalate", reason: `${amount} SOL is over the agent's ${cap} SOL spend limit.` };
  }
  return { verdict: "allow", reason: `Within the ${cap} SOL spend limit. You still sign in Phantom.` };
}
