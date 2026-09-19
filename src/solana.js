// Solana layer: .sol resolution, transaction building, simulation, Phantom.
import {
  Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { resolve, getRecord, Record } from "@bonfida/spl-name-service";

const DEFAULT_RPC = `${location.origin}/rpc`;

export function getRpc() {
  try { return localStorage.getItem("rf3.rpc") || import.meta.env.VITE_RPC_URL || DEFAULT_RPC; }
  catch { return import.meta.env.VITE_RPC_URL || DEFAULT_RPC; }
}

let conn;
export function connection() {
  if (!conn || conn.rpcEndpoint !== getRpc()) {
    conn = new Connection(getRpc(), { commitment: "confirmed", disableRetryOnRateLimit: true });
  }
  return conn;
}

export async function resolveSol(domain) {
  const c = connection();
  const owner = await resolve(c, domain);
  const [lamports, urlRec] = await Promise.all([
    c.getBalance(owner).catch(() => null),
    getRecord(c, domain, Record.Url, true).catch(() => null),
  ]);
  const url = typeof urlRec === "string" ? urlRec.replace(/\0/g, "").trim() : null;
  return {
    domain,
    owner: owner.toBase58(),
    sol: lamports == null ? null : lamports / LAMPORTS_PER_SOL,
    url: url || null,
  };
}

export async function buildTransfer(from, to, sol) {
  const c = connection();
  const { blockhash } = await c.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: new PublicKey(from),
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: new PublicKey(from),
      toPubkey: new PublicKey(to),
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    })],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

// Runs the transaction against current chain state without signing it,
// and reports how each balance would change.
export async function simulate(tx, from, to) {
  const c = connection();
  const [preFrom, preTo] = await Promise.all([
    c.getBalance(new PublicKey(from)),
    c.getBalance(new PublicKey(to)),
  ]);
  const res = await c.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: [from, to] },
  });
  const v = res.value;
  const post = v.accounts?.map((a) => (a ? a.lamports : 0));
  const sameAccount = from === to;
  return {
    ok: !v.err,
    err: v.err,
    logs: v.logs || [],
    units: v.unitsConsumed,
    slot: res.context.slot,
    fromDelta: post ? (post[0] - preFrom) / LAMPORTS_PER_SOL : null,
    toDelta: post && !sameAccount ? (post[1] - preTo) / LAMPORTS_PER_SOL : null,
  };
}

export const phantom = () => (window.phantom?.solana?.isPhantom ? window.phantom.solana : null);

export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
