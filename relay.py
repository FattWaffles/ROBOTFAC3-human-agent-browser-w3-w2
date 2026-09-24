#!/usr/bin/env python3
"""RobotFac3 local relay. Python standard library only; nothing to install.

What it does:
  * serves the static prototype on http://localhost:5173 (allow-listed files only)
  * forwards Solana JSON-RPC from the page to the network WITHOUT the browser's Origin header
    (the public endpoint answers 403 to any request that carries one)
  * keeps the RPC API key out of the page: it is read from .env.local and never sent to the browser

What it refuses:
  * connection reuse: every response closes the connection (HTTP/1.0, Connection: close), so bytes left over from
    a rejected request can never be parsed as a second, forged request (request smuggling)
  * any request whose Host is not the one it is serving: localhost/127.0.0.1, or the domains in
    RF3_PUBLIC_HOST on a deployed relay (DNS-rebinding defence)
  * any POST that does not come from this page's own origin (other sites cannot use the relay)
  * any RPC method not on the allow-list below (there is no sendTransaction: Phantom sends, not RobotFac3)

In the desktop build the Rust core does this job.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Public deploy: name every domain the relay answers on, comma-separated, e.g.
#   RF3_PUBLIC_HOST=robotfac3.com,www.robotfac3.com,robotfac3.onrender.com
# Unset (the default) keeps the relay on this machine only, so a stray run is never exposed.
PUBLIC_HOSTS = tuple(h.strip().lower() for h in os.environ.get("RF3_PUBLIC_HOST", "").split(",") if h.strip())
# Render sets RENDER_EXTERNAL_HOSTNAME to the service's own *.onrender.com name. Trusting it beats
# guessing that name: a wrong guess refuses every real request with 421 while /healthz keeps the
# platform health check green, which looks like a healthy service serving a dead site.
_SELF = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "").strip().lower()
if _SELF and PUBLIC_HOSTS:  # RF3_PUBLIC_HOST stays the explicit opt-in; this only adds to it
    PUBLIC_HOSTS += (_SELF,)
PUBLIC = bool(PUBLIC_HOSTS)
# Render and Fly hand the port over in PORT; RF3_PORT stays for local runs.
PORT = int(os.environ.get("PORT") or os.environ.get("RF3_PORT") or "5173")
HOST = "0.0.0.0" if PUBLIC else "127.0.0.1"  # every interface only when a public host is named
if PUBLIC:
    # Behind the host's TLS terminator the Host header carries the domain and no port, and the
    # page's own origin is https. Anything else is still refused, so rebinding gains nothing.
    ALLOWED_HOSTS = set(PUBLIC_HOSTS)
    ALLOWED_ORIGINS = {"https://" + h for h in PUBLIC_HOSTS}
else:
    ALLOWED_HOSTS = {"localhost:%d" % PORT, "127.0.0.1:%d" % PORT}
    ALLOWED_ORIGINS = {"http://" + h for h in ALLOWED_HOSTS}
MAX_BODY = 256 * 1024

RPC_METHODS = {
    "getAccountInfo", "getBalance", "getGenesisHash", "getLatestBlockhash", "getMultipleAccounts",
    "getSignatureStatuses", "getSlot", "getTokenLargestAccounts", "getTransaction", "simulateTransaction",
}

STATIC_DIRS = {"src": {".js", ".txt"}, "public": {".png", ".svg", ".ico"}, "data": {".json"}}
STATIC_FILES = {"index.html", "styles.css"}
MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".json": "application/json",
}
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
                               "connect-src 'self'; frame-src https:; base-uri 'none'; form-action 'none'; "
                               "frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-store",
}
if PUBLIC:
    SECURITY_HEADERS["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"


def read_env_local():
    env = {}
    path = ROOT / ".env.local"
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip().strip("\"'")
    return env


HELIUS_KEY = (os.environ.get("HELIUS_API_KEY") or read_env_local().get("HELIUS_API_KEY", "")).strip()
if HELIUS_KEY and not HELIUS_KEY.replace("-", "").isalnum():
    sys.exit("HELIUS_API_KEY has unexpected characters")
UPSTREAM_NAME = "helius" if HELIUS_KEY else "public"
UPSTREAM_URL = ("https://mainnet.helius-rpc.com/?api-key=" + HELIUS_KEY) if HELIUS_KEY else "https://api.mainnet-beta.solana.com"

# EVM track chains, read-only. Same registry as the Rust core. No eth_sendRawTransaction: the wallet sends, not RobotFac3.
_CHAINS = json.loads((Path(__file__).resolve().parent / "chains.json").read_text())
EVM_METHODS = set(_CHAINS["evmMethods"])
EVM_CHAINS = {}
for _c in _CHAINS["evm"]:
    _override = os.environ.get(_c["id"].upper() + "_RPC_URL", "")
    EVM_CHAINS[_c["id"]] = {"id": _c["id"], "name": _c["name"], "chainId": _c["chainId"],
                            "url": _override if _override.startswith("https://") else _c["url"]}
VERIFIED_CHAINS = set()


def verify_chain(chain):
    """Fails closed: an upstream is used only after it reports the chain ID the registry expects."""
    if chain["id"] in VERIFIED_CHAINS:
        return True
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode()
    request = urllib.request.Request(chain["url"], data=body, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "robotfac3-relay/0.2"})
    try:
        with urllib.request.urlopen(request, timeout=20) as upstream:
            ok = int(json.loads(upstream.read())["result"], 16) == chain["chainId"]
    except Exception:
        return False
    if ok:
        VERIFIED_CHAINS.add(chain["id"])
    return ok


def resolve_static(url_path):
    """Maps a URL path to an allow-listed file, or None."""
    path = url_path.split("?", 1)[0].split("#", 1)[0]
    if path == "/":
        path = "/index.html"
    parts = [p for p in path.split("/") if p]
    if not parts or any(p in (".", "..") or p.startswith(".") or "\\" in p for p in parts):
        return None
    candidate = ROOT.joinpath(*parts)
    suffix = candidate.suffix.lower()
    if len(parts) == 1:
        if parts[0] not in STATIC_FILES:
            return None
    elif parts[0] not in STATIC_DIRS or suffix not in STATIC_DIRS[parts[0]]:
        return None
    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, RuntimeError):
        return None
    if ROOT not in resolved.parents or not resolved.is_file() or suffix not in MIME:
        return None
    return resolved


class Handler(BaseHTTPRequestHandler):
    server_version = "rf3-relay"
    sys_version = ""
    # HTTP/1.0 on purpose: http.server only honours keep-alive for 1.1, and this relay must never reuse a connection.
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass  # request bodies and URLs are never logged

    def reply(self, status, body, content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.close_connection = True
        self.send_response(status)
        self.send_header("Connection", "close")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        # http.server's own error pages (bad request line, oversized headers) get the same headers and close too.
        # The message is fixed: the default one echoes part of the request back.
        try:
            self.reply(code, {"error": "bad request"})
        except OSError:
            pass

    def host_ok(self):
        return self.headers.get("Host", "").strip().lower() in ALLOWED_HOSTS

    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(200, {"ok": True})  # before the Host check: the platform probe sets its own Host
        if not self.host_ok():
            return self.reply(421, {"error": "unexpected Host"})
        if self.path == "/relay/info":
            return self.reply(200, {"upstream": UPSTREAM_NAME, "methods": sorted(RPC_METHODS),
                                    "chains": [{"id": c["id"], "name": c["name"], "chainId": c["chainId"]} for c in EVM_CHAINS.values()]})
        target = resolve_static(self.path)
        if target is None:
            return self.reply(404, {"error": "not found"})
        self.reply(200, target.read_bytes(), MIME[target.suffix.lower()])

    do_HEAD = do_GET

    def do_POST(self):
        if not self.host_ok():
            return self.reply(421, {"error": "unexpected Host"})
        if self.headers.get("Origin") not in ALLOWED_ORIGINS:
            return self.reply(403, {"error": "cross-origin requests are refused"})
        if self.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin":
            return self.reply(403, {"error": "cross-site requests are refused"})
        chain = None
        if self.path == "/rpc":
            upstream_url, methods = UPSTREAM_URL, RPC_METHODS
        elif self.path.startswith("/rpc/evm/") and self.path[len("/rpc/evm/"):] in EVM_CHAINS:
            chain = EVM_CHAINS[self.path[len("/rpc/evm/"):]]
            upstream_url, methods = chain["url"], EVM_METHODS
        else:
            return self.reply(404, {"error": "not found"})
        if self.headers.get("Transfer-Encoding") is not None or len(self.headers.get_all("Content-Length") or []) != 1:
            return self.reply(400, {"error": "exactly one Content-Length and no Transfer-Encoding"})
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self.reply(415, {"error": "Content-Type must be application/json"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411, {"error": "Content-Length required"})
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {"error": "body too large"})
        raw = self.rfile.read(length)
        try:
            call = json.loads(raw)
        except (ValueError, RecursionError):
            return self.reply(400, {"error": "invalid JSON"})
        if not isinstance(call, dict) or not isinstance(call.get("method"), str) or call["method"] not in methods:
            return self.reply(403, {"jsonrpc": "2.0", "id": None, "error": {"code": -32601, "message": "method not allowed by the relay"}})

        # Re-serialize so only a well-formed single call goes upstream; no browser headers are forwarded.
        body = json.dumps({"jsonrpc": "2.0", "id": call.get("id", 1), "method": call["method"], "params": call.get("params", [])}).encode()
        if chain is not None and not verify_chain(chain):
            return self.reply(502, {"jsonrpc": "2.0", "id": call.get("id"), "error": {"code": -32000, "message": "couldn't confirm the upstream is %s, so the relay won't use it" % chain["name"]}})
        request = urllib.request.Request(upstream_url, data=body, method="POST",
                                         headers={"Content-Type": "application/json", "User-Agent": "robotfac3-relay/0.2"})
        try:
            with urllib.request.urlopen(request, timeout=20) as upstream:
                return self.reply(upstream.status, upstream.read())
        except urllib.error.HTTPError as err:
            return self.reply(err.code, err.read() or json.dumps({"error": "upstream HTTP %d" % err.code}).encode())
        except (urllib.error.URLError, TimeoutError, OSError):
            return self.reply(502, {"jsonrpc": "2.0", "id": call.get("id"), "error": {"code": -32000, "message": "relay could not reach Solana"}})


if __name__ == "__main__":
    if PUBLIC:
        print("RobotFac3 relay on %s:%d for %s  (RPC upstream: %s)" % (HOST, PORT, ", ".join(PUBLIC_HOSTS), UPSTREAM_NAME))
    else:
        print("RobotFac3 relay on http://localhost:%d  (RPC upstream: %s)" % (PORT, UPSTREAM_NAME))
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
