// RobotFac3 desktop shell (Tauri v2).
// The UI window can call three commands and nothing else. Websites open in their own windows with no IPC.
// The page never touches the network for Solana: RPC goes through Rust with the same allow-list as relay.py.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

// Same list as relay.py. There is no sendTransaction: the wallet sends, not RobotFac3.
const RPC_METHODS: &[&str] = &[
    "getAccountInfo", "getBalance", "getGenesisHash", "getLatestBlockhash", "getMultipleAccounts",
    "getSignatureStatuses", "getSlot", "getTokenLargestAccounts", "getTransaction", "simulateTransaction",
];
const MAX_BODY: usize = 256 * 1024;

struct Upstream {
    name: &'static str,
    url: String,
}

// HELIUS_API_KEY from the environment, else the free public endpoint. The key never reaches the page.
fn upstream() -> Upstream {
    match std::env::var("HELIUS_API_KEY") {
        Ok(k) if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => Upstream {
            name: "helius",
            url: format!("https://mainnet.helius-rpc.com/?api-key={k}"),
        },
        _ => Upstream { name: "public", url: "https://api.mainnet-beta.solana.com".into() },
    }
}

// EVM track chains from the shared registry (same file relay.py reads). Read-only, and each
// upstream must report the expected chain ID before any call is forwarded.
#[derive(Clone)]
struct EvmChain {
    id: String,
    name: String,
    chain_id: u64,
    url: String,
}

struct Networks {
    chains: Vec<EvmChain>,
    methods: Vec<String>,
    verified: Mutex<HashSet<String>>,
}

fn networks() -> Networks {
    let v: Value = serde_json::from_str(include_str!("../../chains.json")).expect("chains.json is valid");
    let text = |c: &Value, k: &str| c[k].as_str().expect("chains.json field").to_string();
    let methods = v["evmMethods"].as_array().expect("evmMethods").iter().map(|m| m.as_str().expect("method").to_string()).collect();
    let chains = v["evm"]
        .as_array()
        .expect("evm")
        .iter()
        .map(|c| {
            let id = text(c, "id");
            let url = std::env::var(format!("{}_RPC_URL", id.to_uppercase()))
                .ok()
                .filter(|u| u.starts_with("https://"))
                .unwrap_or_else(|| text(c, "url"));
            EvmChain { name: text(c, "name"), chain_id: c["chainId"].as_u64().expect("chainId"), id, url }
        })
        .collect();
    Networks { chains, methods, verified: Mutex::new(HashSet::new()) }
}

fn verify_chain(chain: &EvmChain) -> Result<(), String> {
    let res = post(&chain.url, br#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#)?;
    let got = res["body"]
        .as_str()
        .and_then(|b| serde_json::from_str::<Value>(b).ok())
        .and_then(|v| v["result"].as_str().and_then(|h| u64::from_str_radix(h.trim_start_matches("0x"), 16).ok()));
    if got == Some(chain.chain_id) {
        Ok(())
    } else {
        Err(format!("Couldn't confirm the upstream is {}, so RobotFac3 won't use it", chain.name))
    }
}

fn post(url: &str, body: &[u8]) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut res = agent
        .post(url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "robotfac3-desktop/0.1")
        .send(body)
        .map_err(|_| "RobotFac3 could not reach Solana".to_string())?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    Ok(json!({ "status": status, "body": text }))
}

#[tauri::command]
async fn rpc(state: tauri::State<'_, Upstream>, id: u32, method: String, params: Value) -> Result<Value, String> {
    if !RPC_METHODS.contains(&method.as_str()) {
        return Err("method not allowed by the desktop relay".into());
    }
    // Re-serialized here, so only a single well-formed call ever leaves the machine.
    let body = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
        .map_err(|_| "bad request".to_string())?;
    if body.len() > MAX_BODY {
        return Err("request too large".into());
    }
    let url = state.url.clone();
    tauri::async_runtime::spawn_blocking(move || post(&url, &body))
        .await
        .map_err(|_| "RPC task failed".to_string())?
}

#[tauri::command]
async fn evm_rpc(
    state: tauri::State<'_, Networks>,
    chain: String,
    id: u32,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let c = state.chains.iter().find(|c| c.id == chain).cloned().ok_or_else(|| "unknown chain".to_string())?;
    if !state.methods.iter().any(|m| *m == method) {
        return Err("method not allowed by the desktop relay".into());
    }
    let body = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
        .map_err(|_| "bad request".to_string())?;
    if body.len() > MAX_BODY {
        return Err("request too large".into());
    }
    let checked = state.verified.lock().map_err(|_| "state error".to_string())?.contains(&c.id);
    let (chain_id, res) = tauri::async_runtime::spawn_blocking(move || {
        if !checked {
            verify_chain(&c)?;
        }
        post(&c.url, &body).map(|r| (c.id, r))
    })
    .await
    .map_err(|_| "RPC task failed".to_string())??;
    state.verified.lock().map_err(|_| "state error".to_string())?.insert(chain_id);
    Ok(res)
}

#[tauri::command]
fn rpc_info(state: tauri::State<'_, Upstream>, nets: tauri::State<'_, Networks>) -> Value {
    let chains: Vec<Value> = nets.chains.iter().map(|c| json!({ "id": c.id, "name": c.name, "chainId": c.chain_id })).collect();
    json!({ "upstream": state.name, "methods": RPC_METHODS, "chains": chains })
}

static NEXT_SITE: AtomicU32 = AtomicU32::new(1);

// Opens an https site in its own window. No capability names these windows, so the site gets no IPC.
#[tauri::command]
async fn open_site(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "That address isn't valid".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Only plain https addresses open".into());
    }
    let host = parsed.host_str().unwrap_or("site").to_string();
    let label = format!("site-{}", NEXT_SITE.fetch_add(1, Ordering::Relaxed));
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title(format!("{host} · RobotFac3"))
        .inner_size(1100.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(upstream())
        .manage(networks())
        .invoke_handler(tauri::generate_handler![rpc, evm_rpc, rpc_info, open_site])
        .setup(|app| {
            // The UI window can never be navigated away from the embedded app.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("RobotFac3")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running RobotFac3");
}
