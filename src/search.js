// Local Web3 project search. The index ships with the app (data/projects.json), so queries never leave the device.
// Pure functions only, so tests can run them in Node.
export const CHAIN_LABELS = {
  solana: "Solana", ethereum: "Ethereum", base: "Base", arbitrum: "Arbitrum",
  hyperliquid: "Hyperliquid", tempo: "Tempo", robinhood: "Robinhood Chain", zcash: "Zcash",
};

// The ingest script already filtered URLs. The page checks again before showing or opening one.
export function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!/^[a-z0-9.-]+$/.test(u.hostname) || u.hostname.includes("xn--") || !u.hostname.includes(".")) return null;
  return u.href;
}

const words = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);

export function prepare(projects) {
  return (projects || []).filter((p) => p && safeUrl(p.url) && Array.isArray(p.chains)).map((p) => ({
    ...p,
    _name: words([p.name, ...(p.aka || [])].join(" ")),
    _text: new Set(words(`${p.category} ${p.description} ${p.chains.map((c) => CHAIN_LABELS[c] || c).join(" ")}`)),
    _host: new URL(p.url).hostname,
  }));
}

// Every word must match somewhere. Name matches outrank host, category and description matches.
// Size (total value locked) only breaks near-ties. There is no paid ranking.
export function search(index, query, chain = "all", limit = 30) {
  const q = words(query);
  if (!q.length) return [];
  const scored = [];
  for (const p of index) {
    if (chain !== "all" && !p.chains.includes(chain)) continue;
    let score = p._name.join(" ") === q.join(" ") ? 20 : 0;
    for (const w of q) {
      if (p._name.includes(w)) score += 10;
      else if (p._name.some((n) => n.startsWith(w))) score += 6;
      else if (p._host.includes(w)) score += 5;
      else if (p._text.has(w)) score += 2;
      else if (w.length > 3 && [...p._text].some((t) => t.startsWith(w))) score += 1;
      else { score = 0; break; }
    }
    if (score) scored.push([score + Math.log10(1 + (p.tvl || 0)) / 2, p]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, p]) => p);
}
