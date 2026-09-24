#!/usr/bin/env python3
"""Builds data/projects.json, the local Web3 search index. Python standard library only.

Run it weekly:  python3 tools/build_index.py
Source: DefiLlama's public protocol list. Only projects on the Colosseum track chains are kept.
Every URL must be a plain https address with an ASCII host; anything else is dropped, never repaired.
Descriptions are third-party text: the page escapes them and nothing ever executes them.
"""
import datetime
import json
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "projects.json"
SOURCE = "https://api.llama.fi/protocols"
# DefiLlama chain name -> RobotFac3 search chain id
CHAINS = {"Solana": "solana", "Ethereum": "ethereum", "Base": "base", "Arbitrum": "arbitrum",
          "Hyperliquid L1": "hyperliquid", "Tempo": "tempo", "Robinhood Chain": "robinhood", "Zcash": "zcash"}


def safe_url(raw):
    """Plain https, ASCII host, no login part, no port, no punycode. Query and fragment are dropped."""
    if not isinstance(raw, str):
        return None
    try:
        u = urlsplit(raw.strip())
        port = u.port
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if u.scheme != "https" or u.username or u.password or port not in (None, 443):
        return None
    if not host or "." not in host or "xn--" in host or not all(c.isascii() and (c.isalnum() or c in "-.") for c in host):
        return None
    return "https://" + host + (u.path or "/")


def main():
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "robotfac3-index/0.1"})
    with urllib.request.urlopen(req, timeout=90) as res:
        raw = json.load(res)
    by_url, dropped = {}, 0
    for p in raw:
        chains = sorted({CHAINS[c] for c in (p.get("chains") or []) if c in CHAINS})
        if not chains:
            continue
        url = safe_url(p.get("url"))
        if not url:
            dropped += 1
            continue
        tvl = p.get("tvl") if isinstance(p.get("tvl"), (int, float)) else 0
        entry = {
            "name": str(p.get("name", "")).strip()[:80],
            "url": url,
            "description": " ".join(str(p.get("description") or "").split())[:240],
            "category": str(p.get("category") or "").strip()[:40],
            "chains": chains,
            "tvl": int(max(tvl, 0)),
            "aka": [],
            "sources": ["DefiLlama"],
        }
        # Versions of one project share a website (Aave V2, Aave V3): merge them into one result.
        prev = by_url.get(url)
        if prev is None:
            by_url[url] = entry
            continue
        keep, other = (entry, prev) if entry["tvl"] > prev["tvl"] else (prev, entry)
        keep["aka"] = sorted(set(keep["aka"] + other["aka"] + [other["name"]]) - {keep["name"]})[:8]
        keep["chains"] = sorted(set(keep["chains"]) | set(other["chains"]))
        keep["tvl"] = prev["tvl"] + entry["tvl"]
        by_url[url] = keep
    projects = sorted(by_url.values(), key=lambda e: -e["tvl"])
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "built": datetime.date.today().isoformat(),
        "sources": [{"name": "DefiLlama", "url": SOURCE, "count": len(projects)}],
        "projects": projects,
    }, separators=(",", ":")))
    print("wrote %d projects to %s (dropped %d with unsafe or missing URLs)" % (len(projects), OUT.relative_to(ROOT), dropped))


if __name__ == "__main__":
    main()
