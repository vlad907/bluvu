#!/usr/bin/env python3
"""End-to-end check of licensing on a built engine (docs/LICENSING_PLAN.md). Run by ci_check.py.

The rule it guards above all: licensing never blacks out a wall. In every failure case (no license,
a damaged one, another PC's, the clock set back, expired, over the plan's limit, a restart while
expired) every output keeps rendering, and the saved layout comes back after a restart.

Also: a plan's screen limit and features refuse only what would *add* to them; when the license has
lapsed the setup is locked but day-to-day operation (a scene recall) works; updates pause; a damaged
license file is refused without losing the one installed; offline activation round-trips.

Needs a test build (cmake -DMOSAIC_LICENSE_TEST_KEY=ON) for the signed-license cases, and the
bluvu_license tool next to the engine. Without them only the unsigned cases run.

    python tools/license_check.py [--engine PATH] [--tool PATH] [--out DIR] [--port N]
"""
import argparse, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

# Messages carry "→" and "×"; Windows consoles and pipes default to cp1252, which can't print them.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
exe = ".exe" if os.name == "nt" else ""
default_engine = os.path.join(root, "build", "Release", "mosaic_engine.exe") if os.name == "nt" else os.path.join(root, "build", "mosaic_engine")
ap = argparse.ArgumentParser()
ap.add_argument("--engine", default=default_engine)
ap.add_argument("--tool", default=None, help="bluvu_license (default: next to the engine)")
ap.add_argument("--out", default="ci-out")
ap.add_argument("--port", type=int, default=8097)
args = ap.parse_args()
tool = args.tool or os.path.join(os.path.dirname(os.path.abspath(args.engine)), "bluvu_license" + exe)
os.makedirs(args.out, exist_ok=True)
BASE = f"http://127.0.0.1:{args.port}"
FP = "fp-guid,fp-uuid,fp-disk"  # this "PC", in test builds (MOSAIC_LICENSE_FINGERPRINT)
MACHINE = {"machineGuid": "fp-guid", "smbiosUuid": "fp-uuid", "systemDisk": "fp-disk"}

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg, flush=True)
    if not cond:
        failures.append(msg)
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error title=license_check::" + msg.replace("%", "%25").replace("\n", " "), flush=True)

def request(method, path, body=None, raw=None):
    """(status, parsed JSON reply); never raises for HTTP errors."""
    data = raw.encode() if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if data is None and method not in ("GET", "HEAD"):
        data = b"{}"
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read()
            return r.status, json.loads(text) if text and r.headers.get("Content-Type", "").startswith("application/json") else text
    except urllib.error.HTTPError as e:
        text = e.read()
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text

def outputs_layout(n):
    return {
        "id": "lic", "name": "License check", "frameRate": float(os.environ.get("MOSAIC_CI_FPS", 30)),
        "canvas": {"width": 3840, "height": 2160, "background": [0, 0, 0, 1]},
        "sources": [{"id": "pattern", "type": "test_pattern", "animated": False, "rect": {"x": 0, "y": 0, "w": 3840, "h": 2160}}],
        "outputs": [{"id": f"out-{i}", "name": f"Out {i}", "width": 640, "height": 360,
                     "crop": {"x": (i % 3) * 1280, "y": (i // 3) * 1080, "w": 1280, "h": 1080}} for i in range(n)],
        "scenes": [{"id": "s1", "name": "Scene 1", "sources": [{"id": "pattern", "type": "solid", "color": [1, 0, 0, 1],
                                                                 "rect": {"x": 0, "y": 0, "w": 3840, "h": 2160}}]}],
    }

def sign(payload):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
    try:
        r = subprocess.run([tool, "sign", "--test", f.name], capture_output=True, text=True, timeout=30)
        if r.returncode:
            raise RuntimeError("bluvu_license sign failed: " + r.stderr)
        return r.stdout
    finally:
        os.unlink(f.name)

def lic(expires, issued="2025-01-01T00:00:00Z", **kw):
    p = {"licenseId": "lic_ci", "customer": "CI", "plan": "starter", "maxScreens": 4, "features": [],
         "issuedAt": issued, "expires": expires, "graceDays": 30, "machine": MACHINE}
    p.update(kw)
    return sign(p)

class Engine:
    def __init__(self, name, data, layout_outputs, enforce=False, fingerprint=FP):
        self.name, self.data = name, data
        self.layouts = os.path.join(os.path.dirname(data), "layouts")
        os.makedirs(self.layouts, exist_ok=True)
        os.makedirs(data, exist_ok=True)
        json.dump(outputs_layout(layout_outputs), open(os.path.join(self.layouts, "lic.json"), "w"))
        self.args = [args.engine, "--data", data, "--layouts", self.layouts, "--layout", "lic", "--port", str(args.port)]
        if enforce:
            self.args.append("--license-enforce")
        self.env = dict(os.environ, MOSAIC_LICENSE_FINGERPRINT=fingerprint)

    def __enter__(self):
        self.log = open(os.path.join(args.out, f"license-{self.name}.log"), "w")
        self.proc = subprocess.Popen(self.args, stdout=self.log, stderr=self.log, env=self.env)
        for _ in range(120):
            if self.proc.poll() is not None:
                break
            try:
                if request("GET", "/api/health")[0] == 200:
                    return self
            except Exception:
                pass
            time.sleep(0.5)
        raise RuntimeError(f"engine ({self.name}) didn't start; see license-{self.name}.log")

    def __exit__(self, *exc):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()

def all_render(what):
    """Every enabled output gives frames, and the engine keeps rendering new ones."""
    ids = [o["id"] for o in request("GET", "/api/outputs")[1]["outputs"] if o.get("enabled", True)]
    f0 = request("GET", "/api/metrics")[1]["engine"]["frameId"]
    ok = []
    for oid in ids:
        good = False
        for _ in range(40):
            if request("GET", f"/api/outputs/{oid}/frame.bgra")[0] == 200:
                good = True
                break
            time.sleep(0.5)
        ok.append(good)
    deadline = time.time() + 30
    while time.time() < deadline and request("GET", "/api/metrics")[1]["engine"]["frameId"] < f0 + 5:
        time.sleep(0.3)
    f1 = request("GET", "/api/metrics")[1]["engine"]["frameId"]
    check(ids and all(ok) and f1 >= f0 + 5, f"{what}: all {len(ids)} outputs render (frames {f0} -> {f1})")

def state():
    return request("GET", "/api/license")[1]

with tempfile.TemporaryDirectory() as tmp:
    print("no license, report-only (as every PC runs today):", flush=True)
    with Engine("none", f"{tmp}/a/data", 4):
        s = state()
        check(s["state"] == "none" and not s["enforced"], f"state none, not enforced ({s['state']}, enforced={s['enforced']})")
        check(s["used"]["screens"] == 4, f"counts 4 screens ({s['used']})")
        all_render("no license")
        code, _ = request("PATCH", "/api/outputs/out-1", {"name": "Renamed"})
        check(code == 200, f"report-only: a setup change still goes through ({code})")
        code, _ = request("POST", "/api/outputs", {"name": "Fifth"})
        check(code == 201, f"report-only: adding a screen still goes through ({code})")
        s = state()
        check(s["wouldBlock"]["count"] >= 2, f"and both are reported as what enforcement would refuse ({s['wouldBlock']})")

    print("a damaged license file:", flush=True)
    os.makedirs(f"{tmp}/b/data")
    open(f"{tmp}/b/data/license.json", "w").write('{"payload": "garbage", "sig')
    with Engine("damaged", f"{tmp}/b/data", 4, enforce=True):
        s = state()
        check(s["state"] == "invalid", f"state invalid: {s['reason']}")
        all_render("damaged license, enforced")
        code, _ = request("POST", "/api/scenes/s1/recall")
        check(code == 200, f"day-to-day operation works (scene recall: {code})")
        code, r = request("PATCH", "/api/outputs/out-1", {"name": "x"})
        check(code == 403 and "walls keep playing" in str(r), f"setup locked with a clear message ({code}: {r})")

    with Engine("probe", f"{tmp}/p/data", 1):
        test_build = state().get("testBuild", False)
    if not test_build or not os.path.exists(tool):
        print("  (not a test build, or no bluvu_license: signed-license cases skipped)", flush=True)
    else:
        print("a Starter license (4 screens here), enforced:", flush=True)
        os.makedirs(f"{tmp}/c/data")
        open(f"{tmp}/c/data/license.json", "w").write(lic("2099-01-01T00:00:00Z"))
        with Engine("starter", f"{tmp}/c/data", 4, enforce=True):
            s = state()
            check(s["state"] == "valid" and s["maxScreens"] == 4 and s["locks"]["addScreens"], f"valid, 4 of 4 screens ({s['state']}, {s['used']})")
            code, r = request("POST", "/api/outputs", {"name": "Fifth"})
            check(code == 403 and "allows 4 screens; this would be 5" in str(r), f"the 5th screen is refused ({code}: {r})")
            check(len(request("GET", "/api/outputs")[1]["outputs"]) == 4, "and wasn't added")
            code, _ = request("PATCH", "/api/outputs/out-3", {"enabled": False})
            check(code == 200, f"switching one off is fine ({code})")
            code, _ = request("POST", "/api/outputs", {"name": "Replacement"})
            check(code == 201, f"then another can be added ({code})")
            code, r = request("POST", "/api/canvases", {"name": "Second wall"})
            check(code == 403 and "Venue" in str(r), f"a second wall needs Venue ({code}: {r})")
            all_render("Starter at its limit")

            print("installing licenses over the API:", flush=True)
            tampered = json.loads(lic("2099-01-01T00:00:00Z", maxScreens=4))
            tampered["sig"] = tampered["sig"][:-4] + ("AAAA" if not tampered["sig"].endswith("AAAA") else "BBBB")
            code, r = request("PUT", "/api/license", raw=json.dumps(tampered))
            check(code == 400 and state()["state"] == "valid", f"a tampered file is refused and the old license kept ({code}: {r})")
            other = lic("2099-01-01T00:00:00Z", machine={"machineGuid": "x", "smbiosUuid": "y", "systemDisk": "z"})
            code, r = request("PUT", "/api/license", raw=other)
            check(code == 400 and "another media server" in str(r), f"another PC's license is refused ({code}: {r})")
            code, r = request("POST", "/api/license/request-code", {"key": "BLUVU-TEST-0000"})
            req_code = r.get("code", "") if isinstance(r, dict) else ""
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"licenseId": "lic_offline", "customer": "CI", "plan": "venue", "maxScreens": 32,
                           "features": ["multiCanvas", "audio", "capture"], "expires": "2099-01-01T00:00:00Z", "graceDays": 30}, f)
            signed = subprocess.run([tool, "sign", "--test", f.name, "--request", req_code], capture_output=True, text=True, timeout=30)
            os.unlink(f.name)
            code, r = request("PUT", "/api/license", raw=signed.stdout)
            s = state()
            check(code == 200 and s["plan"] == "venue" and s["licenseId"] == "lic_offline",
                  f"offline activation: request code -> signed file -> installed ({code}, {s['plan']})")
            code, _ = request("POST", "/api/outputs", {"name": "Sixth"})
            check(code == 201, f"after the upgrade, more screens can be added ({code})")

        print("expired, over its limit, enforced (and a restart):", flush=True)
        os.makedirs(f"{tmp}/d/data")
        open(f"{tmp}/d/data/license.json", "w").write(lic("2025-06-01T00:00:00Z"))
        for run in ("expired", "expired-restart"):
            with Engine(run, f"{tmp}/d/data", 6, enforce=True):
                s = state()
                check(s["state"] == "expired" and s["locks"]["setup"], f"{run}: state expired, setup locked ({s['state']})")
                all_render(f"{run}, 6 screens on a 4-screen plan")
                code, _ = request("POST", "/api/scenes/s1/recall")
                check(code == 200, f"{run}: a scene recall works ({code})")
                code, r = request("PATCH", "/api/outputs/out-1", {"name": "x"})
                check(code == 403 and "ran out" in str(r), f"{run}: changing the setup is refused ({code}: {r})")
                code, r = request("POST", "/api/system/update", {"target": "receivers"})
                check(code == 403 and "Updates are paused" in str(r), f"{run}: updates pause ({code}: {r})")

        print("grace period:", flush=True)
        os.makedirs(f"{tmp}/e/data")
        grace_expiry = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 5 * 86400))
        open(f"{tmp}/e/data/license.json", "w").write(lic(grace_expiry))
        with Engine("grace", f"{tmp}/e/data", 3, enforce=True):
            s = state()
            check(s["state"] == "grace" and not s["locks"]["setup"] and 24 <= s["daysLeft"] <= 26, f"5 days past expiry: grace, {s['daysLeft']} days left, nothing locked")
            code, _ = request("PATCH", "/api/outputs/out-1", {"name": "x"})
            check(code == 200, f"setup changes work in grace ({code})")

        print("another PC, and the clock set back:", flush=True)
        os.makedirs(f"{tmp}/f/data")
        open(f"{tmp}/f/data/license.json", "w").write(lic("2099-01-01T00:00:00Z"))
        with Engine("other-pc", f"{tmp}/f/data", 3, enforce=True, fingerprint="new-guid,new-uuid,fp-disk"):
            s = state()
            check(s["state"] == "invalid" and "another media server" in s["reason"], f"another PC: invalid ({s['reason']})")
            all_render("another PC's license")
        json.dump({"lastSeen": int(time.time()) + 30 * 86400}, open(f"{tmp}/f/data/license-state.json", "w"))
        with Engine("clock", f"{tmp}/f/data", 3, enforce=True):
            s = state()
            check(s["state"] == "invalid" and "clock" in s["reason"], f"clock 30 days behind: invalid ({s['reason']})")
            all_render("clock set back")

print(f"\n{'LICENSE CHECKS FAILED: ' + str(len(failures)) if failures else 'LICENSE CHECKS PASSED'}")
sys.exit(1 if failures else 0)
