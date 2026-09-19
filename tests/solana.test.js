// Run with: node --test tests/
// Expected values in fixtures.json were produced by @solana/web3.js 1.99.0 and @bonfida/spl-name-service 4.0.1
// (reference libraries, used once to generate the answer key; they are not dependencies of this project).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encode, decode, decodeAddress } from "../src/solana/base58.js";
import { isOnCurve } from "../src/solana/ed25519.js";
import { findProgramAddress } from "../src/solana/pda.js";
import { buildTransferMessage, unsignedWire, toBase64, fromBase64, compactU16, solToLamports, lamportsToSol } from "../src/solana/tx.js";
import { deriveKeys, parseName } from "../src/solana/sns.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url)));
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));

test("base58 encode/decode matches the reference for every sample", () => {
  for (const { hex, b58 } of fx.base58) {
    assert.equal(encode(fromHex(hex)), b58);
    assert.deepEqual(decode(b58), fromHex(hex));
  }
  assert.throws(() => decode("0OIl"), /Invalid base58/);
  assert.throws(() => decodeAddress("abc"), /Not a Solana address/);
});

test("ed25519 on-curve check matches the reference for 204 inputs", () => {
  for (const { hex, on } of fx.onCurve) assert.equal(isOnCurve(fromHex(hex)), on, hex);
});

test("program-derived addresses match the reference (address and bump)", async () => {
  for (const c of fx.pda) {
    const { address, bump } = await findProgramAddress(c.seeds.map(fromHex), decodeAddress(c.program));
    assert.equal(encode(address), c.address);
    assert.equal(bump, c.bump);
  }
});

test("SNS account derivations match the reference", async () => {
  for (const n of fx.sns.names) {
    const k = await deriveKeys(n.name);
    assert.equal(encode(k.domainKey), n.domainKey, n.name);
    assert.equal(encode(k.nftRecord), n.nftRecord, n.name);
    assert.equal(encode(k.mint), n.mint, n.name);
    if (!n.isSub) {
      assert.equal(encode(k.solV1), n.solV1, n.name);
      assert.equal(encode(k.solV2), n.solV2, n.name);
      assert.equal(encode(k.urlV2), n.urlV2, n.name);
    }
  }
});

test("transfer message and unsigned wire transaction are byte-identical to the reference", () => {
  for (const c of fx.tx) {
    const msg = buildTransferMessage({ from: c.from, to: c.to, lamports: BigInt(c.lamports), blockhash: c.blockhash });
    assert.equal(toBase64(msg), c.messageB64);
    assert.equal(toBase64(unsignedWire(msg)), c.wireB64);
    assert.deepEqual(fromBase64(c.messageB64), msg);
  }
});

test("transfer builder rejects bad input", () => {
  const ok = { from: fx.tx[0].from, to: fx.tx[0].to, blockhash: fx.tx[0].blockhash };
  assert.throws(() => buildTransferMessage({ ...ok, lamports: 0n }));
  assert.throws(() => buildTransferMessage({ ...ok, lamports: -1n }));
  assert.throws(() => buildTransferMessage({ ...ok, lamports: 2n ** 64n }));
  assert.throws(() => buildTransferMessage({ ...ok, to: "not-an-address", lamports: 1n }));
  assert.throws(() => buildTransferMessage({ ...ok, blockhash: "abc", lamports: 1n }));
});

test("compact-u16 and SOL amounts", () => {
  assert.deepEqual([...compactU16(0)], [0]);
  assert.deepEqual([...compactU16(127)], [127]);
  assert.deepEqual([...compactU16(128)], [0x80, 1]);
  assert.deepEqual([...compactU16(16384)], [0x80, 0x80, 1]);
  assert.equal(solToLamports("0.001"), 1_000_000n);
  assert.equal(solToLamports("2"), 2_000_000_000n);
  assert.equal(solToLamports("0.000000001"), 1n);
  for (const bad of ["0", "-1", "1e3", "0.0000000001", "abc", "", "1.", ".5"]) assert.throws(() => solToLamports(bad), bad);
  assert.equal(lamportsToSol(1_000_000n), "0.001");
  assert.equal(lamportsToSol(-5000n), "-0.000005");
  assert.equal(lamportsToSol(3_000_000_000n), "3");
});

test("name parsing maps .sol to .sns and rejects junk", () => {
  assert.deepEqual(parseName("Toly.SOL"), { label: "toly", typedTld: ".sol", display: "toly.sns" });
  assert.deepEqual(parseName(" toly.sns "), { label: "toly", typedTld: ".sns", display: "toly.sns" });
  for (const bad of ["toly", "toly.eth", ".sns", "a..sns", "a.b.c.sns", "a b.sns"]) assert.throws(() => parseName(bad), bad);
});
