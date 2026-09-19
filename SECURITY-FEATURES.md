# RobotFac3 — Security & DLP Feature List

As of 2026-09-19.

## Summary

No Island code or features are integrated: Island is closed-source enterprise software, and we use it as the model, not as a dependency. Island ships enterprise DLP with no Web3, agents or payments. RobotFac3 builds its own DLP and security layer, which the human user and the AI agent share.

The website handles discovery, and the native Tauri app is meant to deliver the full feature set. That is the same split Island uses.

## Shipped: DLP leak check

The leak check stops things that look like secrets from being submitted through RobotFac3's own inputs: the address bar, the agent task box and the Settings fields. It covers both typed and pasted input. It runs only in the page, drops the bytes at once and never sends a suspected secret to any relay. The code is in [`src/security.js`](src/security.js).

| What it catches | How it decides | Known gaps |
| --- | --- | --- |
| Solana private keys (base58, hex, byte arrays, number lists) | A 64-byte value is blocked only if its last 32 bytes are the public key derived from its first 32, checked with WebCrypto Ed25519. Transaction signatures are not flagged. | Browsers without Ed25519 fall back to blocking only the two standard key formats |
| Seed phrases | Any 12-word window with at least 11 BIP39 words and at least 9 different words. One typo doesn't hide a phrase, and "test test test…" doesn't trigger it. | Non-English word lists, words run together, 4-letter abbreviations |
| API tokens | Matches a sample of common token shapes | A sample, not a complete list |

If the BIP39 word list fails to load, the check keeps running with a broader rule that flags more harmless text, and the activity log shows a warning. The word list is vendored and pinned by sha256.

## Shipped: agent, transaction and browser security

The agent policy is the real protection against prompt injection. The injection regex only produces telemetry.

| Feature | What it does |
| --- | --- |
| Web content can't create payments | Payment details that come from a page are never acted on, whatever the amount |
| Strict task grammar | Only an exact sentence like "Send 0.5 SOL to name.sns" is accepted. Anything unclear is refused, never guessed at. |
| Spend cap | 0.01 SOL by default. Any amount over the cap goes to a human for approval. |
| Injection detector | A regex that flags text aimed at AI agents. It is telemetry only and not a defense. |
| Transaction simulation | Every send is simulated on mainnet before signing, and the approval sheet shows the result |
| No key custody | RobotFac3 never holds, sees or can recover the wallet key. It hands Phantom an unsigned message, and Phantom signs. |
| Content Security Policy | `default-src 'none'`. Scripts, styles, images and connections come only from `'self'`, and there is no inline script or style. |
| Framed-page sandbox | Pages are framed with `sandbox` and without `allow-same-origin`, so they run in an opaque origin |
| Name-resolution safety | A `.sol` name is looked up as `.sns` with a warning on the name page and the approval sheet. It will be refused once SNS stops answering `.sol` (early October). Subdomains are refused. |

## Island comparison

We cover DLP on our own inputs and add Web3 and agent protections Island doesn't have. We can't match Island's network-level DLP inside third-party pages, because Island ships its own Chromium and our shell uses the system WebView.

| Island-style capability | RobotFac3 status |
| --- | --- |
| Block secrets typed or pasted into the browser | Shipped, on RobotFac3's own inputs only |
| Inspect data inside third-party pages and uploads | Not possible in the web preview. Planned at the native layer, and advisory only. |
| Network-level DLP on request bodies | Not planned: WKWebView can't intercept request bodies |
| Isolate untrusted content | Shipped: sandboxed frames in an opaque origin, plus a strict CSP |
| Policy engine for risky actions | Shipped for payments: web-sourced payments are refused, and a spend cap sends larger amounts to a human |
| Transaction simulation and a human approval gate | RobotFac3 only; Island has no equivalent |
| AI agent guardrails | RobotFac3 only; Island has no equivalent |

## Known limits

- **Prompt injection is not solved.** The detector is a regex that misses rewordings; in testing it caught 2 of 8 attack variants. The protection comes from the payment rule plus human approval of every signature.
- **DLP can't see inside third-party pages** in the web preview, and it will only be advisory inside pages on desktop.
- **No DLP on agent output yet.** The agent is scripted, and no model is connected.
- **Simulation is a preview, not a guarantee.** The chain can change before signing, and Phantom may add a priority fee. There is no post-send verification yet.
- **Real sends are untested.** A send has not been run with a funded wallet.
- **The human approval gate is a single point.** Embedded wallets get no Phantom-side prompt, and nothing mitigates approval fatigue yet.

## Roadmap

The hackathon deadline is 2026-10-12. The next pieces move into the Rust core of the Tauri shell under the security lead's dependency policy.

- [ ] DLP on agent output: scan everything the agent is about to type or send
- [ ] Provenance-gated agent actions with a quarantined page reader, where the LLM runs behind the relay with no sign, send or fetch tool
- [ ] On-chain agent allowance, with the cap enforced through `transferRecurring`
- [ ] x402 payments signed by the agent's own spending key
- [ ] Post-send verification of transactions
- [ ] Refuse `.sol` names once SNS stops answering them
