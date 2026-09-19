// Solana Name Service resolution, written from the SNS-IP 5 rules that @bonfida/spl-name-service 4.0.1 implements:
//   1. tokenized name  -> whoever holds the NFT
//   2. SOL record v2   -> its content, if staleness id == current owner and RoA id == content
//   3. SOL record v1   -> its content, if signed by the current owner
//   4. otherwise       -> the registry owner, unless that owner is a program address (then refuse)
// Every unclear case fails closed: the name does not resolve and nothing can be sent.
import { encode, decodeAddress } from "./base58.js";
import { isOnCurve } from "./ed25519.js";
import { concat, sha256, findProgramAddress } from "./pda.js";
import { fromBase64 } from "./tx.js";
import { rpc } from "./rpc.js";

const NAME_PROGRAM_ID = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
const NAME_TOKENIZER_ID = "nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const NAME_PROGRAM = decodeAddress(NAME_PROGRAM_ID);
const ROOT_DOMAIN = decodeAddress("58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx");
const NAME_TOKENIZER = decodeAddress(NAME_TOKENIZER_ID);
// From this mainnet slot on, SNS stops answering ".sol"; that ending moves to a separate registry.
export const SOL_TLD_CUTOFF_SLOT = 452825395;
const RECORDS_CENTRAL_STATE = decodeAddress("2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo");
const ZERO32 = new Uint8Array(32);
const HEADER_LEN = 96; // parent(32) | owner(32) | class(32)
const utf8 = new TextEncoder();

export class SnsError extends Error {
  constructor(code, message) { super(message); this.name = "SnsError"; this.code = code; }
}

const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// "Toly.SOL" -> { label: "toly", typedTld: ".sol", display: "toly.sns" }
// Only a-z, 0-9, hyphen and underscore are accepted. Anything else (accents, other scripts, emoji, invisible
// characters) can look identical to a different name on screen, so it is refused rather than displayed.
const LABEL = /^[a-z0-9_-]{1,63}$/;
export function parseName(input) {
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^(.+)\.(sol|sns)$/);
  if (!m) throw new SnsError("bad-name", "Names end in .sns (or the older .sol)");
  const label = m[1];
  const parts = label.split(".");
  if (parts.length > 2 || !parts.every((p) => LABEL.test(p))) {
    throw new SnsError("bad-name", "RobotFac3 only looks up names made of a-z, 0-9, hyphen and underscore. Other characters can look identical to a different name.");
  }
  return { label, typedTld: "." + m[2], display: label + ".sns" };
}

export function assertTldStillAnswered(typedTld, slot) {
  if (typedTld === ".sol" && slot >= SOL_TLD_CUTOFF_SLOT) {
    throw new SnsError("sol-retired", ".sol lookups ended at slot 452,825,395. If you mean the SNS name, type it with .sns");
  }
}

const hashName = (name) => sha256(utf8.encode("SPL Name Service" + name));

async function nameAccountKey(hashed, classKey, parentKey) {
  const { address } = await findProgramAddress([hashed, classKey || ZERO32, parentKey || ZERO32], NAME_PROGRAM);
  return address;
}

// Derivations only (no network). Exported for tests.
export async function deriveKeys(label) {
  const parts = label.split(".");
  let domainKey;
  if (parts.length === 2) {
    const parent = await nameAccountKey(await hashName(parts[1]), null, ROOT_DOMAIN);
    domainKey = await nameAccountKey(await hashName("\0" + parts[0]), null, parent);
  } else {
    domainKey = await nameAccountKey(await hashName(label), null, ROOT_DOMAIN);
  }
  const keys = {
    domainKey,
    nftRecord: (await findProgramAddress([utf8.encode("nft_record"), domainKey], NAME_TOKENIZER)).address,
    mint: (await findProgramAddress([utf8.encode("tokenized_name"), domainKey], NAME_TOKENIZER)).address,
  };
  if (parts.length === 1) {
    keys.solV1 = await nameAccountKey(await hashName("\x01SOL"), null, domainKey);
    keys.solV2 = await nameAccountKey(await hashName("\x02SOL"), RECORDS_CENTRAL_STATE, domainKey);
    keys.urlV2 = await nameAccountKey(await hashName("\x02url"), RECORDS_CENTRAL_STATE, domainKey);
  }
  return keys;
}

const VALIDATION_LEN = { 0: 0, 1: 32, 2: 20, 3: 32 }; // None, Solana, Ethereum, UnverifiedSolana
const SOLANA = 1;

function parseRecordV2(data) {
  if (data.length < HEADER_LEN + 8) throw new SnsError("record-malformed", "A record on this name is malformed");
  const view = new DataView(data.buffer, data.byteOffset + HEADER_LEN, 8);
  const staleness = view.getUint16(0, true);
  const roa = view.getUint16(2, true);
  const sLen = VALIDATION_LEN[staleness];
  const rLen = VALIDATION_LEN[roa];
  if (sLen === undefined || rLen === undefined) throw new SnsError("record-malformed", "A record on this name is malformed");
  const body = data.subarray(HEADER_LEN + 8);
  return {
    staleness, roa,
    stalenessId: body.subarray(0, sLen),
    roaId: body.subarray(sLen, sLen + rLen),
    content: body.subarray(sLen + rLen),
  };
}

async function verifyEd25519(publicKey, signature, message) {
  let key;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new SnsError("cannot-verify", "This browser can't verify the name's signed record, so RobotFac3 won't resolve it");
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
}

async function tokenizedOwner(mint) {
  let largest;
  try {
    largest = await rpc("getTokenLargestAccounts", [encode(mint), { commitment: "confirmed" }]);
  } catch (e) {
    if (e.code === -32602) throw new SnsError("nft-owner", "This name is tokenized and its holder couldn't be found");
    // The free public RPC refuses this lookup outright (always HTTP 429).
    if (e.code === 429) throw new SnsError("nft-needs-rpc", "This name is held as an NFT. Finding its holder needs a full RPC provider, so RobotFac3 won't resolve it on the public endpoint");
    throw e;
  }
  const first = largest?.value?.[0]?.address;
  if (!first) throw new SnsError("nft-owner", "This name is tokenized and its holder couldn't be found");
  if (typeof first !== "string") throw new SnsError("nft-owner", "This name is tokenized and its holder couldn't be found");
  const info = await rpc("getAccountInfo", [first, { encoding: "base64", commitment: "confirmed" }]);
  const data = info?.value?.owner === TOKEN_PROGRAM_ID ? accountData(info.value) : null;
  // SPL token account: mint(32) | owner(32) | amount(u64)
  if (!data || data.length < 72 || !equal(data.subarray(0, 32), mint)) {
    throw new SnsError("nft-owner", "This name is tokenized and its holder couldn't be found");
  }
  const amount = new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true);
  if (amount !== 1n) throw new SnsError("nft-owner", "This name is tokenized and its holder couldn't be found");
  return data.subarray(32, 64);
}

// Decodes one account from an RPC response, or throws if the response isn't shaped the way we asked for it.
function accountData(account) {
  if (!Array.isArray(account.data) || account.data[1] !== "base64" || typeof account.data[0] !== "string") {
    throw new SnsError("rpc-shape", "Solana returned an answer RobotFac3 can't read, so it won't resolve this name");
  }
  return fromBase64(account.data[0]);
}

export async function resolveName(input) {
  const name = parseName(input);
  if (name.label.includes(".")) throw new SnsError("unsupported", "Subdomains aren't supported in this prototype yet");
  const keys = await deriveKeys(name.label);
  const wanted = [keys.nftRecord, keys.solV1, keys.solV2, keys.urlV2, keys.domainKey];
  const res = await rpc("getMultipleAccounts", [wanted.map(encode), { encoding: "base64", commitment: "confirmed" }]);
  if (!Array.isArray(res?.value) || res.value.length !== wanted.length || !Number.isSafeInteger(res?.context?.slot)) {
    throw new SnsError("rpc-shape", "Solana returned an answer RobotFac3 can't read, so it won't resolve this name");
  }
  assertTldStillAnswered(name.typedTld, res.context.slot);
  // An account only counts if the expected program owns it. Anyone can fund a bare system account at these
  // addresses, and that must not be mistaken for a record.
  const owners = [NAME_TOKENIZER_ID, NAME_PROGRAM_ID, NAME_PROGRAM_ID, NAME_PROGRAM_ID, NAME_PROGRAM_ID];
  const [nftRecord, solV1, solV2, urlV2, registry] = res.value.map((a, i) => (a && a.owner === owners[i] ? accountData(a) : null));

  if (!registry || registry.length < HEADER_LEN) throw new SnsError("not-registered", `${name.display} isn't registered`);
  const registryOwner = registry.subarray(32, 64);

  const result = {
    ...name,
    domainKey: encode(keys.domainKey),
    registryOwner: encode(registryOwner),
    slot: res.context.slot,
    url: null,
  };

  // Website record: shown only if the record was written by the current owner (staleness check) and is https.
  if (urlV2) {
    try {
      const rec = parseRecordV2(urlV2);
      if (rec.staleness === SOLANA && equal(rec.stalenessId, registryOwner)) {
        const text = new TextDecoder().decode(rec.content).replace(/\0/g, "").trim();
        const u = new URL(text);
        if (u.protocol === "https:" && !u.username && !u.password) result.url = u.href;
      }
    } catch { /* an unreadable website record is ignored, never trusted */ }
  }

  // 1. Tokenized name
  if (nftRecord && nftRecord.length >= 98 && nftRecord[0] === 2) {
    const holder = await tokenizedOwner(keys.mint);
    if (!isOnCurve(holder)) throw new SnsError("pda-owner", "This name is held by a program, not a wallet, so RobotFac3 won't send to it");
    return { ...result, target: encode(holder), via: "NFT holder" };
  }

  // 2. SOL record v2
  if (solV2) {
    const rec = parseRecordV2(solV2);
    if (rec.content.length !== 32) throw new SnsError("record-malformed", "This name's SOL record is malformed");
    if (rec.staleness !== SOLANA || rec.roa !== SOLANA) throw new SnsError("record-unverified", "This name's SOL record isn't verified, so RobotFac3 won't resolve it");
    if (equal(rec.stalenessId, registryOwner)) {
      if (!equal(rec.roaId, rec.content)) throw new SnsError("record-unverified", "This name's SOL record isn't verified, so RobotFac3 won't resolve it");
      return { ...result, target: encode(rec.content), via: "SOL record" };
    }
    // stale record (written by a previous owner): ignored
  }

  // 3. SOL record v1
  if (solV1 && solV1.length >= HEADER_LEN + 32 + 64) {
    const content = solV1.subarray(HEADER_LEN, HEADER_LEN + 32);
    const signature = solV1.subarray(HEADER_LEN + 32, HEADER_LEN + 96);
    const message = utf8.encode(hex(concat(content, keys.solV1)));
    if (await verifyEd25519(registryOwner, signature, message)) {
      return { ...result, target: encode(content), via: "SOL record (v1)" };
    }
  }

  // 4. Registry owner, never a program address
  if (!isOnCurve(registryOwner)) {
    throw new SnsError("pda-owner", "This name is held by a program, not a wallet, so RobotFac3 won't send to it");
  }
  return { ...result, target: result.registryOwner, via: "owner" };
}
