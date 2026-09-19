// Ed25519 curve-membership check (RFC 8032 §5.1.3 point decoding).
// Needed to derive program addresses (PDAs), which by definition are NOT on the curve.
// This handles only public values (hashes and addresses), never secrets.
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n; // -121665/121666 mod P
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n; // sqrt(-1) mod P

const mod = (a) => ((a % P) + P) % P;
function powMod(base, exp) {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (((v * v) % P) * v) % P;
  const v7 = (((v3 * v3) % P) * v) % P;
  let x = (((u * v3) % P) * powMod(u * v7, (P - 5n) / 8n)) % P;
  const vx2 = (((v * x) % P) * x) % P;
  if (vx2 === u) {
    // x is a root
  } else if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P;
  } else {
    return false;
  }
  if (x === 0n && sign === 1n) return false;
  return true;
}
