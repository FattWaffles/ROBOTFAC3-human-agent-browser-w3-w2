// Phantom's injected provider. RobotFac3 never holds a key: it hands Phantom an unsigned message and Phantom signs.
// Uses the request() form from docs.phantom.com/solana/sending-a-transaction, which needs no SDK.
import { encode } from "./base58.js";

export const provider = () => (window.phantom?.solana?.isPhantom ? window.phantom.solana : null);

export async function connect() {
  const res = await provider().connect();
  return res.publicKey.toString();
}

export const disconnect = () => provider().disconnect();

export async function signAndSend(messageBytes) {
  const { signature } = await provider().request({
    method: "signAndSendTransaction",
    params: { message: encode(messageBytes) },
  });
  return signature;
}
