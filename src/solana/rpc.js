// JSON-RPC over fetch. The browser only ever talks to the same-origin relay (/rpc);
// the relay forwards to Solana without the browser's Origin header and keeps any API key out of the page.
let endpoint = "/rpc";
// In the desktop app the page has no network path to Solana: the Rust core makes the call.
const desktop = globalThis.__TAURI__?.core;
async function desktopFetch(id, method, params, chain) {
  const { status, body } = chain === "solana"
    ? await desktop.invoke("rpc", { id, method, params })
    : await desktop.invoke("evm_rpc", { chain, id, method, params });
  return new Response(body || null, { status });
}

export function setEndpoint(url) { endpoint = url; }

export class RpcError extends Error {
  constructor(message, code) { super(message); this.name = "RpcError"; this.code = code; }
}

// chain: "solana" (default) or an EVM track chain id from chains.json, e.g. "base".
export async function rpc(method, params = [], chain = "solana") {
  // A random id per call, checked on the way back, so a stray or replayed response can't be taken for this one.
  const id = crypto.getRandomValues(new Uint32Array(1))[0];
  const where = chain === "solana" ? "Solana RPC" : `${chain} RPC`;
  let res;
  try {
    res = desktop ? await desktopFetch(id, method, params, chain) : await fetch(chain === "solana" ? endpoint : `/rpc/evm/${encodeURIComponent(chain)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  } catch (err) {
    throw new RpcError(desktop ? String(err || `The desktop app couldn't reach ${where}.`) : `Can't reach RobotFac3's relay for ${where}. Check your connection (running locally? make sure relay.py is up).`, "network");
  }
  if (res.status === 429) throw new RpcError(`${where} is rate-limiting. Wait a few seconds and retry.`, 429);
  let body;
  try { body = await res.json(); } catch { throw new RpcError(`RPC returned HTTP ${res.status}`, res.status); }
  if (body?.error) throw new RpcError(body.error.message || "RPC error", body.error.code);
  if (!res.ok) throw new RpcError(`RPC returned HTTP ${res.status}`, res.status);
  if (body?.id !== id || !("result" in body)) throw new RpcError("RPC response didn't match the request", "mismatch");
  return body.result;
}
