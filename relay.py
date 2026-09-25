#!/usr/bin/env python3
"""RobotFac3 local relay. Python standard library only; nothing to install.

What it does:
  * serves the static prototype on http://localhost:5173 (allow-listed files only)
  * forwards Solana JSON-RPC from the page to the network WITHOUT the browser's Origin header
    (the public endpoint answers 403 to any request that carries one)
  * forwards read-only EVM JSON-RPC to the track chains in chains.json, after each upstream proves its chain ID
  * keeps the RPC API key out of the page: it is read from .env.local and never sent to the browser

What it refuses:
  * connection reuse: every response closes the connection (HTTP/1.0, Connection: close), so bytes left over from
    a rejected request can never be parsed as a second, forged request (request smuggling)
  * any request whose Host is not the one it is serving: localhost/127.0.0.1, or the domains in
    RF3_PUBLIC_HOST on a deployed relay (DNS-rebinding defence)
  * any POST that does not come from this page's own origin (other sites cannot use the relay)
  * any RPC method not on the allow-list below (there is no sendTransaction: Phantom sends, not RobotFac3)
  * upstream redirects (never followed), upstream answers over MAX_RESPONSE, clients that go quiet mid-request
  * more than a bounded rate of upstream calls: the relay is a door to the RPC key, so it is a slow one

In the desktop build the Rust core does this job.
"""
import email.utils
import http.client
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
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
MAX_BODY = 256 * 1024           # a request from the page
MAX_RESPONSE = 4 * 1024 * 1024  # an answer from upstream; the page's largest legitimate one is well under 100 KB
UPSTREAM_TIMEOUT = 20           # per socket operation, so a whole call is bounded by this times a few

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


_ENV_LOCAL = read_env_local()
HELIUS_KEY = (os.environ.get("HELIUS_API_KEY") or _ENV_LOCAL.get("HELIUS_API_KEY", "")).strip()
if HELIUS_KEY and not HELIUS_KEY.replace("-", "").isalnum():
    sys.exit("HELIUS_API_KEY has unexpected characters")
UPSTREAM_NAME = "helius" if HELIUS_KEY else "public"
UPSTREAM_URL = ("https://mainnet.helius-rpc.com/?api-key=" + HELIUS_KEY) if HELIUS_KEY else "https://api.mainnet-beta.solana.com"

# EVM track chains, read-only. Same registry as the Rust core. No eth_sendRawTransaction: the wallet sends, not RobotFac3.
_CHAINS = json.loads((ROOT / "chains.json").read_text())
EVM_METHODS = set(_CHAINS["evmMethods"])
EVM_CHAINS, OVERRIDDEN = {}, []
for _c in _CHAINS["evm"]:
    _key = _c["id"].upper() + "_RPC_URL"
    _override = (os.environ.get(_key) or _ENV_LOCAL.get(_key, "")).strip().strip("\"'")
    if _override:
        # Fail loudly, like a bad HELIUS_API_KEY: quietly falling back to the public endpoint would look like it worked.
        if not _override.startswith("https://") or not urllib.parse.urlsplit(_override).hostname:
            sys.exit("%s must be an https:// URL with a host" % _key)
        OVERRIDDEN.append(_c["id"])
    EVM_CHAINS[_c["id"]] = {"id": _c["id"], "name": _c["name"], "chainId": _c["chainId"], "url": _override or _c["url"]}
VERIFIED_CHAINS = set()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Any 3xx surfaces as an HTTPError. Following it would let an upstream send the call to another host or scheme."""

    def redirect_request(self, *args, **kwargs):
        return None


# The default ProxyHandler stays: https goes through CONNECT with TLS end to end, and dropping it would only
# break people behind a corporate proxy.
_OPENER = urllib.request.build_opener(_NoRedirect)


class UpstreamError(Exception):
    """Something other than an answer came back. The message reads after the chain's name."""


def read_capped(response):
    """The body, or None when it is over MAX_RESPONSE (refused up front from Content-Length, or while reading)."""
    declared = (response.headers.get("Content-Length") or "").strip()
    if declared.isdigit() and int(declared) > MAX_RESPONSE:
        return None
    data = response.read(MAX_RESPONSE + 1)
    return None if len(data) > MAX_RESPONSE else data


def upstream_post(url, body):
    """One re-serialized call to an upstream. Returns (status, bytes); raises UpstreamError for anything else."""
    request = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "robotfac3-relay/0.2"})
    try:
        with _OPENER.open(request, timeout=UPSTREAM_TIMEOUT) as upstream:
            status, data = upstream.status, read_capped(upstream)
    except urllib.error.HTTPError as err:
        if 300 <= err.code < 400:
            raise UpstreamError("tried to redirect the call, which the relay never follows")
        try:
            data = read_capped(err)
        except (OSError, http.client.HTTPException):
            data = b""
        status = err.code
    except (urllib.error.URLError, http.client.HTTPException, OSError):
        raise UpstreamError("could not be reached")
    if data is None:
        raise UpstreamError("sent an answer over the relay's size limit")
    return status, data


def verify_chain(chain):
    """Fails closed: an upstream is used only after it reports the chain ID the registry expects."""
    if chain["id"] in VERIFIED_CHAINS:
        return True
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode()
    try:
        status, data = upstream_post(chain["url"], body)
        result = json.loads(data)["result"]
        ok = status == 200 and isinstance(result, str) and len(result) <= 20 and int(result, 16) == chain["chainId"]
    except Exception:
        return False
    if ok:
        VERIFIED_CHAINS.add(chain["id"])
    return ok


# ---- Throttle. The page's own origin check keeps other websites out, but any program can forge those headers, so
# on a public host the relay is an open door to the RPC key's quota. Bound how fast that door can be used.
_THROTTLE = threading.Lock()
_GLOBAL = [50.0, time.monotonic()]              # all clients together: burst 50, then 5 calls/s
_CLIENTS = {}                                   # per client: burst 30, then 3 calls/s
UPSTREAM_SLOTS = threading.BoundedSemaphore(32)  # upstream calls in flight; beyond that, 503 rather than a thread each


def _take(bucket, rate, burst):
    now = time.monotonic()
    bucket[0] = min(burst, bucket[0] + (now - bucket[1]) * rate)
    bucket[1] = now
    if bucket[0] < 1:
        return False
    bucket[0] -= 1
    return True


def throttled(client):
    with _THROTTLE:
        if len(_CLIENTS) > 10000:
            _CLIENTS.clear()  # forget everyone rather than grow without bound
        bucket = _CLIENTS.setdefault(client, [30.0, time.monotonic()])
        return not (_take(bucket, 3.0, 30) and _take(_GLOBAL, 5.0, 50))


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
    except (OSError, ValueError, RuntimeError):  # missing, not a directory, name too long, NUL byte, symlink loop: all 404
        return None
    if ROOT not in resolved.parents or not resolved.is_file() or suffix not in MIME:
        return None
    return resolved


class Handler(BaseHTTPRequestHandler):
    server_version = "rf3-relay"
    sys_version = ""
    # HTTP/1.0 on purpose: http.server only honours keep-alive for 1.1, and this relay must never reuse a connection.
    protocol_version = "HTTP/1.0"
    # Deadline for every socket operation (request line, headers, the body read, the response write). An idle or
    # half-sent request then frees its thread instead of holding it until the client goes away; http.server catches
    # the timeout in handle_one_request and closes the connection silently.
    timeout = 15

    def log_message(self, fmt, *args):
        pass  # request bodies and URLs are never logged

    def reply(self, status, body, content_type="application/json", cache="no-store", modified=None, extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.close_connection = True
        self.send_response(status)
        self.send_header("Connection", "close")
        self.send_header("Content-Type", content_type)
        if status != 304:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if modified is not None:
            self.send_header("Last-Modified", email.utils.formatdate(modified, usegmt=True))
        for name, value in list(SECURITY_HEADERS.items()) + list((extra or {}).items()):
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and status != 304:
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

    def client_ip(self):
        # Behind the host's proxy the socket peer is the proxy; it appends the real client as the LAST hop of
        # X-Forwarded-For (earlier hops are whatever the client claimed). Locally the socket peer is the client.
        if PUBLIC:
            last = self.headers.get("X-Forwarded-For", "").rsplit(",", 1)[-1].strip()
            if last:
                return last
        return self.client_address[0]

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
        # Images, the word list and the search index change rarely: cache them for an hour. The page's own files are
        # revalidated on every visit (one small 304 when unchanged), so an edit shows up immediately.
        durable = target.parent.name in ("public", "data", "vendor")
        mtime = int(target.stat().st_mtime)
        mime = MIME[target.suffix.lower()]
        cache = "public, max-age=3600" if durable else "no-cache"
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                if int(email.utils.parsedate_to_datetime(since).timestamp()) >= mtime:
                    return self.reply(304, b"", mime, cache=cache, modified=mtime)
            except (TypeError, ValueError, OverflowError):
                pass
        self.reply(200, target.read_bytes(), mime, cache=cache, modified=mtime)

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
        # The id and params are echoed upstream after re-serialization. Keep them small and simply shaped, so the
        # relay never spends real CPU on a hostile body (Python 3.9 has no limit on int-to-string conversion).
        call_id = call.get("id", 1)
        id_ok = call_id is None or (isinstance(call_id, str) and len(call_id) <= 64) \
            or (isinstance(call_id, int) and not isinstance(call_id, bool) and abs(call_id) < 2 ** 53)
        params = call.get("params", [])
        if not id_ok or not isinstance(params, list):
            return self.reply(400, {"error": "id must be a short string or number and params a list"})

        # Re-serialize so only a well-formed single call goes upstream; no browser headers are forwarded.
        body = json.dumps({"jsonrpc": "2.0", "id": call_id, "method": call["method"], "params": params}).encode()
        what = chain["name"] if chain is not None else "Solana"
        error = lambda code, message: {"jsonrpc": "2.0", "id": call_id, "error": {"code": code, "message": message}}
        if throttled(self.client_ip()):
            return self.reply(429, error(-32000, "too many requests through the relay; wait a second and retry"), extra={"Retry-After": "1"})
        if not UPSTREAM_SLOTS.acquire(blocking=False):
            return self.reply(503, error(-32000, "the relay is busy; try again in a moment"), extra={"Retry-After": "2"})
        try:
            if chain is not None and not verify_chain(chain):
                return self.reply(502, error(-32000, "couldn't confirm the upstream is %s, so the relay won't use it" % what))
            try:
                status, data = upstream_post(upstream_url, body)
            except UpstreamError as err:
                return self.reply(502, error(-32000, "%s %s" % (what, err)))
        finally:
            UPSTREAM_SLOTS.release()
        # Only JSON goes back to the page. An upstream's HTML error page must not be served as application/json.
        try:
            json.loads(data)
        except ValueError:
            data = error(-32000, "%s answered with something that isn't JSON (HTTP %d)" % (what, status))
        return self.reply(status, data)


if __name__ == "__main__":
    overrides = (" · overrides: " + ", ".join(OVERRIDDEN)) if OVERRIDDEN else ""  # ids only, never the URLs (they may carry keys)
    if PUBLIC:
        print("RobotFac3 relay on %s:%d for %s  (RPC upstream: %s%s)" % (HOST, PORT, ", ".join(PUBLIC_HOSTS), UPSTREAM_NAME, overrides))
    else:
        print("RobotFac3 relay on http://localhost:%d  (RPC upstream: %s%s)" % (PORT, UPSTREAM_NAME, overrides))
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
