// Base58 (Bitcoin alphabet), as used for Solana addresses and signatures.
// Hand-written so the page ships no third-party code. Tested against @solana/web3.js output (tests/fixtures.json).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = []; // base58 digits, least significant first
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = []; // least significant first
  for (let i = zeros; i < str.length; i++) {
    let carry = INDEX.get(str[i]);
    if (carry === undefined) throw new Error("Invalid base58 character");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// Decodes a Solana address and insists on exactly 32 bytes.
export function decodeAddress(str) {
  if (typeof str !== "string" || str.length < 32 || str.length > 44) throw new Error("Not a Solana address");
  const bytes = decode(str);
  if (bytes.length !== 32) throw new Error("Not a Solana address");
  return bytes;
}
