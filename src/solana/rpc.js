// JSON-RPC over fetch. The browser only ever talks to the same-origin relay (/rpc);
// the relay forwards to Solana without the browser's Origin header and keeps any API key out of the page.
let endpoint = "/rpc";
let nextId = 0;

export function setEndpoint(url) { endpoint = url; }

export class RpcError extends Error {
  constructor(message, code) { super(message); this.name = "RpcError"; this.code = code; }
}

export async function rpc(method, params = []) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
    });
  } catch {
    throw new RpcError("Can't reach the relay. Is relay.py running?", "network");
  }
  if (res.status === 429) throw new RpcError("Solana RPC is rate-limiting. Wait a few seconds and retry.", 429);
  let body;
  try { body = await res.json(); } catch { throw new RpcError(`RPC returned HTTP ${res.status}`, res.status); }
  if (body.error) throw new RpcError(body.error.message || "RPC error", body.error.code);
  if (!res.ok) throw new RpcError(`RPC returned HTTP ${res.status}`, res.status);
  return body.result;
}
