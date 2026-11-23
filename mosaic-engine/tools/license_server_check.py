#!/usr/bin/env python3
"""The engine against the license server (license-server/, run locally with `wrangler dev`):
online activation, refresh picking up a change, revocation, a trial, a wrong key, and the server
being unreachable, with every output still rendering throughout.

Needs a test build (cmake -DMOSAIC_LICENSE_TEST_KEY=ON) and `npm ci` in license-server/.

    python tools/license_server_check.py [--engine PATH] [--out DIR]
"""
import argparse, hashlib, hmac, json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
server_dir = os.path.join(os.path.dirname(root), "license-server")
default_engine = os.path.join(root, "build", "Release", "mosaic_engine.exe") if os.name == "nt" else os.path.join(root, "build", "mosaic_engine")
ap = argparse.ArgumentParser()
ap.add_argument("--engine", default=default_engine)
ap.add_argument("--out", default="ci-out")
ap.add_argument("--port", type=int, default=8093)
ap.add_argument("--server-port", type=int, default=8788)
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
ENGINE = f"http://127.0.0.1:{args.port}"
SERVER = f"http://127.0.0.1:{args.server_port}"
ADMIN = "check-admin-token-0123456789"
WEBHOOK_SECRET = "check-webhook-secret"
PRICES = {"starter": "pri_checkstarter", "venue": "pri_checkvenue"}
SEED = hashlib.sha512(b"bluvu-license-test-key: published, never trust in a venue build").hexdigest()[:64]

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg, flush=True)
    if not cond:
        failures.append(msg)
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error title=license_server_check::" + msg.replace("%", "%25").replace("\n", " "), flush=True)

def request(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else (b"{}" if method != "GET" else None)
    req = urllib.request.Request(base + path, method=method, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None

admin = lambda method, path, body=None: request(SERVER, method, "/admin/api" + path, body, {"Authorization": f"Bearer {ADMIN}"})
engine = lambda method, path, body=None: request(ENGINE, method, path, body)

def wait_up(base, path, proc, what, tries=180):
    for _ in range(tries):
        if proc.poll() is not None:
            break
        try:
            if request(base, "GET", path)[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"{what} didn't start")

def renders():
    ids = [o["id"] for o in engine("GET", "/api/outputs")[1]["outputs"] if o.get("enabled", True)]
    f0 = engine("GET", "/api/metrics")[1]["engine"]["frameId"]
    deadline = time.time() + 30
    while time.time() < deadline and engine("GET", "/api/metrics")[1]["engine"]["frameId"] < f0 + 5:
        time.sleep(0.3)
    frames = []
    for i in ids:
        for _ in range(40):
            try:
                with urllib.request.urlopen(f"{ENGINE}/api/outputs/{i}/frame.bgra", timeout=10) as r:
                    frames.append(r.status == 200)
                    break
            except Exception:
                time.sleep(0.5)
        else:
            frames.append(False)
    return bool(ids) and all(frames) and engine("GET", "/api/metrics")[1]["engine"]["frameId"] >= f0 + 5

npm_bin = os.path.join(server_dir, "node_modules", ".bin", "wrangler.cmd" if os.name == "nt" else "wrangler")
if not os.path.exists(npm_bin):
    print("  (license-server/node_modules missing: run npm ci there; skipped)")
    sys.exit(0)

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
    vars_file = os.path.join(tmp, "test.vars")
    open(vars_file, "w").write(f"SIGNING_SEED={SEED}\nSIGNING_KID=test\nADMIN_TOKEN={ADMIN}\nPADDLE_WEBHOOK_SECRET={WEBHOOK_SECRET}\n"
                               f"PADDLE_PRICES={json.dumps(PRICES)}\nEMAIL_OUTBOX_ONLY=1\n")
    persist = os.path.join(tmp, "state")
    shell = os.name == "nt"
    subprocess.run([npm_bin, "d1", "migrations", "apply", "bluvu-license", "--local", "--persist-to", persist], cwd=server_dir, check=True,
                   capture_output=True, shell=shell)
    slog = open(os.path.join(args.out, "license-server.log"), "w")
    server = subprocess.Popen([npm_bin, "dev", "--local", "--port", str(args.server_port), "--persist-to", persist, "--env-file", vars_file],
                              cwd=server_dir, stdout=slog, stderr=slog, shell=shell)
    procs = []
    def start_engine(name, fingerprint, server_url=SERVER):
        os.makedirs(f"{tmp}/{name}", exist_ok=True)
        log = open(os.path.join(args.out, f"license-server-engine-{name}.log"), "w")
        p = subprocess.Popen([args.engine, "--data", f"{tmp}/{name}", "--port", str(args.port), "--license-enforce"], stdout=log, stderr=log,
                             env=dict(os.environ, MOSAIC_LICENSE_FINGERPRINT=fingerprint, MOSAIC_LICENSE_SERVER=server_url))
        procs.append(p)
        wait_up(ENGINE, "/api/health", p, "engine")
        return p
    def stop(p):
        p.terminate()
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            p.kill()
    try:
        wait_up(SERVER, "/health", server, "wrangler dev")
        print("online activation:", flush=True)
        st, r = admin("POST", "/licenses", {"email": "venue@check.test", "name": "Check Venue", "plan": "venue", "expires": "2099-01-01"})
        check(st == 201, f"admin issues a Venue license ({st})")
        lic = r["license"]
        e = start_engine("one", "pc1-guid,pc1-uuid,pc1-disk")
        if not engine("GET", "/api/license")[1].get("testBuild"):
            print("  (not a test build: skipped)")
            stop(e)
            sys.exit(0)
        st, r = engine("POST", "/api/license/activate", {"key": "BLUVU-WRONG-WRONG-WRONG-WRONG"})
        check(st == 502 and "no license with that key" in str(r), f"a wrong key says so ({st}: {r})")
        st, r = engine("POST", "/api/license/activate", {"key": lic["key"]})
        check(st == 200 and r["state"] == "valid" and r["plan"] == "venue" and r["maxScreens"] == 32, f"activates online: {r.get('state')} {r.get('plan')} {r.get('maxScreens')}")
        st, d = admin("GET", f"/licenses/{lic['id']}")
        check(d["license"]["machine"] and d["license"]["machine"]["machineGuid"] == "pc1-guid", "the server records the media server")

        print("refresh:", flush=True)
        admin("PATCH", f"/licenses/{lic['id']}", {"maxScreens": 5})
        st, r = engine("POST", "/api/license/refresh")
        check(st == 200 and r["maxScreens"] == 5 and r["lastRefresh"]["ok"], f"a change made on the server arrives ({r.get('maxScreens')})")
        st, r = engine("POST", "/api/outputs", {"name": "Fifth"})
        check(st == 201, f"5 screens allowed now: the 5th is added ({st})")
        st, r = engine("POST", "/api/outputs", {"name": "Sixth"})
        check(st == 403 and "allows 5 screens" in str(r), f"the 6th is refused ({st}: {r})")

        print("revocation:", flush=True)
        admin("POST", f"/licenses/{lic['id']}/revoke")
        st, r = engine("POST", "/api/license/refresh")
        st, s = engine("GET", "/api/license")
        check(s["state"] == "none" and os.path.exists(f"{tmp}/one/license-revoked.json"), f"revoked: the engine drops it ({s['state']})")
        check(renders(), "and the outputs keep rendering")
        admin("POST", f"/licenses/{lic['id']}/restore")
        st, r = engine("POST", "/api/license/activate", {"key": lic["key"]})
        check(st == 200 and r["state"] == "valid", f"restored and activated again ({st})")

        print("moving it away (Remove from this server tells the server):", flush=True)
        st, r = engine("DELETE", "/api/license")
        st, d = admin("GET", f"/licenses/{lic['id']}")
        check(r["state"] == "none" and d["license"]["machine"] is None, "removed here and released on the server")
        stop(e)

        print("a trial:", flush=True)
        e = start_engine("two", "pc2-guid,pc2-uuid,pc2-disk")
        st, r = engine("POST", "/api/license/trial", {"email": "try@check.test"})
        check(st == 200 and r["state"] == "trial" and 13 <= r["daysLeft"] <= 14, f"a 14-day trial ({st}: {r.get('state')}, {r.get('daysLeft')} days)")
        engine("DELETE", "/api/license")
        st, r = engine("POST", "/api/license/trial", {})
        check(st == 502 and "had its trial" in str(r), f"only once per PC ({st}: {r})")
        stop(e)

        print("bought online (a Paddle webhook, signed like Paddle signs it):", flush=True)
        def webhook(n, kind, price, ends_days):
            t = time.time()
            iso = lambda x: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(x))
            ev = {"event_id": f"evt_check{n:06d}", "event_type": kind, "occurred_at": iso(t + n), "data": {
                "id": "sub_check0001", "status": "active", "customer_id": "ctm_check0001", "transaction_id": "txn_check000000001",
                "items": [{"price": {"id": price}, "quantity": 1}], "current_billing_period": {"starts_at": iso(t), "ends_at": iso(t + ends_days * 86400)}}}
            raw = json.dumps(ev)
            ts = str(int(t))
            sig = hmac.new(WEBHOOK_SECRET.encode(), f"{ts}:{raw}".encode(), hashlib.sha256).hexdigest()
            req = urllib.request.Request(SERVER + "/webhooks/paddle", method="POST", data=raw.encode(), headers={"Content-Type": "application/json", "Paddle-Signature": f"ts={ts};h1={sig}"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status
        check(webhook(1, "subscription.created", PRICES["starter"], 365) == 200, "the subscription webhook is accepted")
        st, p = request(SERVER, "GET", "/v1/purchase?txn=txn_check000000001")
        check(st == 200 and p.get("ready") and p["plan"] == "starter", f"the checkout's page gets the key ({st}: {p})")
        e = start_engine("four", "pc4-guid,pc4-uuid,pc4-disk")
        st, r = engine("POST", "/api/license/activate", {"key": p["key"]})
        check(st == 200 and r["plan"] == "starter" and r["maxScreens"] == 8 and r.get("renews") is True and r["links"]["billing"].endswith("/billing"),
              f"activates as Starter, renewing by itself ({r.get('plan')}, {r.get('maxScreens')}, renews {r.get('renews')})")
        check(webhook(2, "subscription.updated", PRICES["venue"], 365) == 200, "the upgrade webhook is accepted")
        st, r = engine("POST", "/api/license/refresh")
        check(st == 200 and r["plan"] == "venue" and r["maxScreens"] == 32, f"the upgrade arrives on refresh ({r.get('plan')}, {r.get('maxScreens')})")
        check(renders(), "and the outputs keep rendering")
        stop(e)

        print("the license server unreachable:", flush=True)
        e = start_engine("three", "pc3-guid,pc3-uuid,pc3-disk", server_url="http://127.0.0.1:9")
        st, r = engine("POST", "/api/license/activate", {"key": lic["key"]})
        check(st == 502 and "couldn't reach the license server" in str(r) and "request code" in str(r), f"says so and points to offline activation ({st}: {r})")
        check(renders(), "and the outputs keep rendering")
        stop(e)
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()
        if os.name == "nt":  # kill the whole tree first: wrangler's children (workerd) outlive it on Windows
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(server.pid)], capture_output=True)
        server.terminate()
        try:
            server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            server.kill()
        slog.close()
        time.sleep(1)

print(f"\n{'LICENSE SERVER CHECKS FAILED: ' + str(len(failures)) if failures else 'LICENSE SERVER CHECKS PASSED'}")
sys.exit(1 if failures else 0)
