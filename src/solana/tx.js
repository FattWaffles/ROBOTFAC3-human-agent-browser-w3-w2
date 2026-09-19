// Serializes a plain SOL transfer as a legacy Solana transaction message.
// Layout: header(3) | accounts | recent blockhash(32) | instructions. Tested byte-for-byte against @solana/web3.js.
import { decodeAddress, decode } from "./base58.js";
import { concat } from "./pda.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const LAMPORTS_PER_SOL = 1_000_000_000n;
const U64_MAX = 2n ** 64n - 1n;

export function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("compact-u16 out of range");
  const out = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Uint8Array.from(out);
}

// Converts a decimal SOL string ("0.001") to lamports without floating point.
export function solToLamports(sol) {
  const s = String(sol).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error("Amount must be a positive number with at most 9 decimals");
  const [whole, frac = ""] = s.split(".");
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, "0"));
  if (lamports <= 0n || lamports > U64_MAX) throw new Error("Amount out of range");
  return lamports;
}

export function lamportsToSol(lamports) {
  const v = BigInt(lamports);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / LAMPORTS_PER_SOL}${frac ? "." + frac : ""}`;
}

export function buildTransferMessage({ from, to, lamports, blockhash }) {
  const amount = BigInt(lamports);
  if (amount <= 0n || amount > U64_MAX) throw new Error("Amount out of range");
  const fromKey = decodeAddress(from);
  const toKey = decodeAddress(to);
  const hash = decode(blockhash);
  if (hash.length !== 32) throw new Error("Bad blockhash");
  const self = from === to;

  // Account order: writable signer (payer), writable non-signer (recipient), read-only non-signer (System Program).
  const accounts = self ? [fromKey, decodeAddress(SYSTEM_PROGRAM)] : [fromKey, toKey, decodeAddress(SYSTEM_PROGRAM)];
  const header = Uint8Array.of(1, 0, 1); // 1 signature, 0 read-only signed, 1 read-only unsigned
  const programIndex = accounts.length - 1;
  const ixAccounts = self ? [0, 0] : [0, 1];

  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, amount, true);

  return concat(
    header,
    compactU16(accounts.length), ...accounts,
    hash,
    compactU16(1),
    Uint8Array.of(programIndex),
    compactU16(ixAccounts.length), Uint8Array.from(ixAccounts),
    compactU16(data.length), data,
  );
}

// Unsigned wire transaction (one empty signature slot), for simulateTransaction with sigVerify:false.
export function unsignedWire(message) {
  return concat(compactU16(1), new Uint8Array(64), message);
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
