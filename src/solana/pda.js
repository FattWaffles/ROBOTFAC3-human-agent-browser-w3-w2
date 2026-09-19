// Program-derived addresses: sha256(seeds || bump || programId || "ProgramDerivedAddress"), first bump that is off-curve.
import { isOnCurve } from "./ed25519.js";

const MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function findProgramAddress(seeds, programId) {
  if (!(programId instanceof Uint8Array) || programId.length !== 32) throw new Error("Program id must be 32 bytes");
  if (seeds.length > 15) throw new Error("Too many seeds");
  for (const s of seeds) if (!(s instanceof Uint8Array) || s.length > 32) throw new Error("Seeds must be byte arrays of at most 32 bytes");
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256(concat(...seeds, Uint8Array.of(bump), programId, MARKER));
    if (!isOnCurve(hash)) return { address: hash, bump };
  }
  throw new Error("No valid program address found");
}
