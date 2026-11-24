#!/usr/bin/env python3
"""End-to-end check of a built engine, used by CI (Windows/WARP) and locally.

Runs the engine on a frozen test pattern and checks real pixels:
  - every output's corner markers have the right colours in the right corners
  - a 90-degree output has its corners rotated clockwise
  - a free angle tilts the sampled region about its centre
  - PATCHing an output's crop over the REST API changes what it renders
  - a half-transparent source blends over the one below it
  - scenes recall, and crossfade when asked to
  - the wall tool generates outputs with bezel gaps and resizes the canvas
  - wall groups: a second (1x1) group, moving it, deleting it with its outputs
  - group presets: save, clear, recall with a crossfade limited to the group
  - image sources, the signal-loss fallback image, and layout history / restore
  - a video file: plays, pauses, restarts and loops (skipped where Media Foundation is missing)
  - endpoints: check-in, assignment and status of a receiving PC
  - every rendered frame reached every output (no partial frames)
  - an NDI stream that can't start at first keeps trying, and comes up by itself

    python tools/ci_check.py [--engine PATH] [--out DIR]

Set MOSAIC_SOFTWARE_GPU=1 to run on WARP (no GPU needed). Exits non-zero on failure.
"""
import argparse, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
default_engine = os.path.join(root, "build", "Release", "mosaic_engine.exe") if os.name == "nt" else os.path.join(root, "build", "mosaic_engine")
ap = argparse.ArgumentParser()
ap.add_argument("--engine", default=default_engine)
ap.add_argument("--out", default="ci-out")
ap.add_argument("--port", type=int, default=8098)
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
BASE = f"http://127.0.0.1:{args.port}"

RED, GREEN, BLUE, WHITE = (255, 0, 0), (0, 255, 0), (26, 89, 255), (255, 255, 255)

def out(i, crop, **kw):
    o = {"id": f"out-{i}", "name": f"Out {i}", "width": 1920, "height": 1080,
         "crop": dict(zip("xywh", crop)), "pixelFormat": "uyvy"}
    o.update(kw)
    return o

layout = {
    "id": "ci", "name": "CI check", "frameRate": float(os.environ.get("MOSAIC_CI_FPS", 60)),  # MOSAIC_CI_FPS=8: like the CI runner
    "canvas": {"width": 3840, "height": 2160, "background": [0, 0, 0, 1]},
    "sources": [{"id": "pattern", "type": "test_pattern", "animated": False,
                 "rect": {"x": 0, "y": 0, "w": 3840, "h": 2160}}],
    "outputs": [
        out(1, (0, 0, 1920, 1080)),
        out(2, (1920, 0, 1920, 1080)),
        out(3, (0, 1080, 1920, 1080), pixelFormat="bgra"),
        out(4, (1920, 1080, 1920, 1080)),
        # tile 1 rotated 90 clockwise, scaled to fit a 1920x1080 output
        out(5, (0, 0, 1920, 1080), rotation=90, scaleMode="stretch"),
    ],
}

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg, flush=True)
    if not cond:
        failures.append(msg)
        if os.environ.get("GITHUB_ACTIONS"):  # an annotation on the run: readable without opening the log
            print("::error title=ci_check::" + msg.replace("%", "%25").replace("\n", " "), flush=True)

def frame_id(canvas=None):
    return json.loads(get("/api/metrics", canvas=canvas)[1])["engine"]["frameId"]

def pause(seconds, frames=12):
    """Waits `seconds`, and until the engine has rendered `frames` more frames: a change made just
    before has then reached the frames the checks look at, however slow the machine (the CI
    runner renders in software at a few frames a second)."""
    t0, f0 = time.time(), frame_id()
    time.sleep(seconds)
    while frame_id() < f0 + frames and time.time() - t0 < seconds + 30:
        time.sleep(0.1)

def wait_for(fn, timeout=20, every=0.25):
    """Polls fn() until it returns something true (returned), or the last value after `timeout`."""
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() > end:
            return v
        time.sleep(every)

def get(path, timeout=10, canvas=None):
    req = urllib.request.Request(BASE + path, headers={"X-Mosaic-Canvas": canvas} if canvas else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.headers, r.read()

def call(method, path, body=None, canvas=None):
    data = json.dumps(body).encode() if body is not None else b"{}"
    headers = {"Content-Type": "application/json"}
    if canvas:
        headers["X-Mosaic-Canvas"] = canvas
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")

def frame(oid, canvas=None):
    for _ in range(30):  # WARP can be slow to produce the first frames
        try:
            h, body = get(f"/api/outputs/{oid}/frame.bgra", canvas=canvas)
            return int(h["X-Width"]), int(h["X-Height"]), body
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"no frame from {oid}")

def pixel(img, x, y):
    w, _, data = img
    i = (y * w + x) * 4
    return data[i + 2], data[i + 1], data[i]  # BGRA -> RGB

def close(a, b, tol=48):
    return all(abs(p - q) <= tol for p, q in zip(a, b))

def png_bytes(w, h, rgb):
    """A small solid-colour PNG, written by hand (no imaging library needed)."""
    import struct, zlib
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))

def corners(img):
    w, h, _ = img
    m = 60  # centre of the 96 px markers inset 12 px
    return {"TL": pixel(img, m, m), "TR": pixel(img, w - m, m), "BL": pixel(img, m, h - m), "BR": pixel(img, w - m, h - m)}

with tempfile.TemporaryDirectory() as tmp:
    os.makedirs(f"{tmp}/layouts")
    json.dump(layout, open(f"{tmp}/layouts/ci.json", "w"))
    log = open(os.path.join(args.out, "engine.log"), "w")
    proc = subprocess.Popen([args.engine, "--data", f"{tmp}/data", "--layouts", f"{tmp}/layouts", "--layout", "ci",
                             "--port", str(args.port), "--ui", os.path.join(root, "ui", "dist")], stderr=log, stdout=log)
    try:
        for _ in range(60):
            try:
                get("/api/health", timeout=2)
                break
            except Exception:
                time.sleep(0.5)
        print("engine:", flush=True)
        pause(3)
        m = json.loads(get("/api/metrics")[1])
        e = m["engine"]
        print(f"  {e['backend']} on {e['device']}, {e['renderFps']:.1f} fps", flush=True)

        print("corner markers (orientation and crop):", flush=True)
        expected = {"TL": RED, "TR": GREEN, "BL": BLUE, "BR": WHITE}
        for i in (1, 2, 3, 4):
            img = frame(f"out-{i}")
            check(img[0] == 1920 and img[1] == 1080, f"out-{i} is 1920x1080 (got {img[0]}x{img[1]})")
            c = corners(img)
            for k, want in expected.items():
                check(close(c[k], want), f"out-{i} {k} marker {c[k]} ~ {want}")

        print("rotation 90 clockwise:", flush=True)
        c = corners(frame("out-5"))
        # Clockwise: the source's bottom-left becomes the top-left, top-left becomes top-right.
        for k, want in {"TL": BLUE, "TR": RED, "BR": GREEN, "BL": WHITE}.items():
            check(close(c[k], want), f"out-5 {k} marker {c[k]} ~ {want}")

        print("free angle (tilted panels):", flush=True)
        centre = (960, 540)
        straight = pixel(frame("out-1"), *centre)
        call("PATCH", "/api/outputs/out-1", {"angle": 180})
        pause(1.0)
        c = corners(frame("out-1"))
        for k, want in {"TL": WHITE, "TR": BLUE, "BL": GREEN, "BR": RED}.items():
            check(close(c[k], want), f"angle 180: out-1 {k} marker {c[k]} ~ {want}")
        call("PATCH", "/api/outputs/out-1", {"angle": 12.5})
        pause(1.0)
        img = frame("out-1")
        check(close(pixel(img, *centre), straight, 30), f"angle 12.5: centre pixel stays {pixel(img, *centre)} ~ {straight}")
        check(not close(pixel(img, 60, 60), RED, 48), "angle 12.5: the corner marker moved away from the corner")
        call("PATCH", "/api/outputs/out-1", {"angle": 0})
        pause(1.0)

        print("live crop change over REST:", flush=True)
        probe = [(330, 330), (1500, 330), (330, 800), (1500, 800)]  # inside grid cells: the tile's own colour
        before = [pixel(frame("out-1"), x, y) for x, y in probe]
        target = [pixel(frame("out-2"), x, y) for x, y in probe]
        check(any(not close(a, b, 10) for a, b in zip(before, target)), "out-1 and out-2 differ before the change")
        req = urllib.request.Request(BASE + "/api/outputs/out-1", method="PATCH",
                                     data=json.dumps({"crop": {"x": 1920, "y": 0}}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
        pause(1.5)
        after = [pixel(frame("out-1"), x, y) for x, y in probe]
        check(all(close(a, b, 10) for a, b in zip(after, target)), f"out-1 now matches out-2 {after} ~ {target}")

        print("enlarged pictures are filtered bicubically:", flush=True)
        def edges(img):  # how hard the picture's edges are: mean step between neighbours along some rows (green)
            w, h, data = img
            total = 0
            for y in range(10, h, 20):
                g = data[y * w * 4 + 1:(y + 1) * w * 4:4]
                total += sum(abs(p - q) for p, q in zip(g, g[1:]))
            return total / (len(range(10, h, 20)) * (w - 1))
        whole = call("GET", "/api/outputs")["outputs"][0]["crop"]
        call("PATCH", "/api/outputs/out-1", {"crop": {"x": 1920, "y": 0, "w": 480, "h": 270}})  # shown 4x its size
        pause(1.0)
        sharp = frame("out-1")
        call("PATCH", "/api/outputs/out-1", {"smooth": True})
        pause(1.0)
        plain = frame("out-1")
        check(edges(sharp) > edges(plain) * 1.05, f"edges are harder than with bilinear ({edges(sharp):.2f} against {edges(plain):.2f})")
        flat = (1320, 760)  # the middle of a grid cell (330, 190 in the crop): one colour, which neither filter may change
        check(close(pixel(sharp, *flat), pixel(plain, *flat), 2), f"a flat area keeps its colour ({pixel(sharp, *flat)} ~ {pixel(plain, *flat)})")
        call("PATCH", "/api/outputs/out-1", {"smooth": False, "crop": whole})
        pause(1.0)
        back = [pixel(frame("out-1"), x, y) for x, y in probe]
        check(all(close(a, b, 10) for a, b in zip(back, target)), "and the output is as before at its own size")

        print("source opacity (alpha blending):", flush=True)
        spot = (330, 330)
        base = pixel(frame("out-1"), *spot)
        red = call("POST", "/api/sources", {"name": "red", "type": "solid", "color": [1, 0, 0, 1], "opacity": 0.5})
        pause(1.0)
        got = pixel(frame("out-1"), *spot)
        want = tuple(round(0.5 * a + 0.5 * b) for a, b in zip(base, (255, 0, 0)))
        check(close(got, want, 12), f"50% red over the pattern {got} ~ {want}")
        call("DELETE", f"/api/sources/{red['id']}")

        # A 600 x 300 layer gets 3-pixel dots: the tag is 33 high, 6 in from the layer's corner,
        # its text 6 further in. out-3 (BGRA, exact colours) shows the canvas from y = 1080.
        print("layer titles:", flush=True)
        tagged = call("POST", "/api/sources", {"name": "TV1 (some box)", "type": "solid", "color": [0, 1, 0, 1],
                                               "rect": {"x": 300, "y": 1380, "w": 600, "h": 300}, "title": True})
        pause(1.0)
        img = frame("out-3")
        tag_width = lambda im: next(x for x in range(306, 900) if close(pixel(im, x, 320), (0, 255, 0), 12)) - 306
        check(close(pixel(img, 318, 313), (255, 255, 255), 12), f"the title's text is white {pixel(img, 318, 313)}")
        check(close(pixel(img, 308, 336), (0, 55, 0), 12), f"on a dark, see-through box {pixel(img, 308, 336)}")
        check(close(pixel(img, 500, 450), (0, 255, 0), 12), "and the rest of the layer is untouched")
        check(tag_width(img) == 63, f"it says the name up to the bracket: 3 letters, {tag_width(img)} px wide (63)")
        saved = next(x for x in call("GET", "/api/layout")["sources"] if x["id"] == tagged["id"])
        check(saved.get("title") is True, "the layout remembers the title is on")
        call("PATCH", f"/api/sources/{tagged['id']}", {"titleText": "CABLE 12"})
        pause(1.0)
        img = frame("out-3")
        check(tag_width(img) == 153, f"its own text replaces the name: 8 letters, {tag_width(img)} px wide (153)")
        call("PATCH", f"/api/sources/{tagged['id']}", {"title": False})
        pause(1.0)
        check(close(pixel(frame("out-3"), 318, 313), (0, 255, 0), 12), "switched off, the title is gone")
        call("DELETE", f"/api/sources/{tagged['id']}")

        print("display outputs remember their monitor:", flush=True)
        o = call("PATCH", "/api/outputs/out-4", {"display": "\\\\.\\DISPLAY9", "displayId": "model-and-port"})
        check(o.get("displayId") == "model-and-port", "an output keeps the monitor chosen for it")
        o = call("PATCH", "/api/outputs/out-4", {"name": "Out 4"})
        check(o.get("displayId") == "model-and-port", "through other changes")
        o = call("PATCH", "/api/outputs/out-4", {"display": "\\\\.\\DISPLAY6"})
        check(not o.get("displayId"), "and forgets it when another display is chosen by name (learnt again when it opens)")
        o = call("PATCH", "/api/outputs/out-4", {"display": ""})
        check(not o.get("display") and not o.get("displayId"), "back to an NDI stream")
        pause(1.0)

        print("sound outputs, mono on one output of a device:", flush=True)
        lay = call("GET", "/api/layout")
        lay["audioOutputs"] = [{"id": "zone-1", "name": "Zone 1", "source": "BOX (one)", "device": "", "channelPair": 0, "monoChannel": 3}]
        call("PUT", "/api/layout", lay)
        kept = call("GET", "/api/layout").get("audioOutputs", [])
        check(len(kept) == 1 and kept[0].get("monoChannel") == 3, f"the layout keeps 'mono on output 3' ({kept[0].get('monoChannel') if kept else None})")
        check(isinstance(call("GET", "/api/audio").get("outputs"), list), "and the sound status still answers")
        lay = call("GET", "/api/layout")
        lay["audioOutputs"] = []
        call("PUT", "/api/layout", lay)

        print("scenes:", flush=True)
        call("POST", "/api/scenes", {"name": "pattern only"})
        call("POST", "/api/sources", {"name": "blue", "type": "solid", "color": [0, 0, 1, 1]})
        call("POST", "/api/scenes", {"name": "all blue"})
        pause(1.0)
        check(close(pixel(frame("out-1"), *spot), (0, 0, 255), 12), "blue source covers the canvas")
        call("POST", "/api/scenes/pattern-only/recall")
        pause(1.0)
        check(close(pixel(frame("out-1"), *spot), base, 12), "recalling 'pattern only' restores the pattern")
        def mix_seen(oid, a, b, seconds):
            """True if, during the next `seconds`, the output shows a colour between a and b."""
            last = [None]
            def look():
                last[0] = pixel(frame(oid), *spot)
                return not close(last[0], a, 20) and not close(last[0], b, 20)
            return wait_for(look, timeout=seconds, every=0.1), last[0]
        call("POST", "/api/scenes/all-blue/recall", {"transitionMs": 4000})
        seen, mid = mix_seen("out-1", base, (0, 0, 255), 4.0)
        check(seen, f"mid-crossfade is a mix {mid}")
        check(wait_for(lambda: close(pixel(frame("out-1"), *spot), (0, 0, 255), 12), timeout=15), "crossfade ends on the new scene")
        call("POST", "/api/scenes/pattern-only/recall")

        print("wall tool (bezel gaps):", flush=True)
        lay = call("PUT", "/api/wall", {"cols": 2, "rows": 1, "outputWidth": 1920, "outputHeight": 1080, "gapX": 100, "fitCanvas": True})
        crops = {o["id"]: o["crop"] for o in lay["outputs"]}
        # 3940 wide for the wall; 2160 high because standalone out-3/out-4 sit below it.
        check(lay["canvas"]["width"] == 3940 and lay["canvas"]["height"] == 2160, f"canvas fits the wall and the other outputs ({lay['canvas']['width']}x{lay['canvas']['height']})")
        check(crops["out-1"]["x"] == 0 and crops["out-2"]["x"] == 2020, f"panel 2 starts after the 100 px bezel (x={crops['out-2']['x']})")
        check(all(o["group"] == "wall" for o in lay["outputs"] if o["id"] in ("out-1", "out-2")), "wall outputs are grouped")
        check(len(lay["outputs"]) == 5, f"other outputs kept ({len(lay['outputs'])} outputs)")
        check(lay["sources"][0]["rect"]["w"] == 3940, "full-canvas source follows the new canvas")
        pause(1.5)
        img = frame("out-2")
        check(img[0] == 1920 and img[1] == 1080, "wall output renders")

        print("wall groups:", flush=True)
        lay = call("POST", "/api/walls", {"name": "Double wide", "cols": 1, "rows": 1, "outputWidth": 3840, "outputHeight": 1080, "y": 1080})
        dw = [o for o in lay["outputs"] if o.get("group") == "double-wide"]
        check(len(dw) == 1 and dw[0]["id"] == "double-wide-1" and dw[0]["name"] == "Double wide", f"1x1 group makes one output ({[o['id'] for o in dw]})")
        ndi = [o["ndiName"] for o in lay["outputs"]]
        check(len(set(ndi)) == len(ndi), "every output keeps a unique NDI name")
        check(lay["canvas"]["width"] == 3940 and lay["canvas"]["height"] == 2160, "a new group leaves the canvas alone")
        check(len(lay["walls"]) == 2 and any(o.get("group") == "wall" for o in lay["outputs"]), "the first wall is still there")
        lay = call("POST", "/api/walls/double-wide/move", {"x": 50, "y": 0})
        crop = next(o["crop"] for o in lay["outputs"] if o["id"] == "double-wide-1")
        check(crop["x"] == 50 and crop["y"] == 0 and crop["w"] == 3840, f"moving a group shifts its outputs ({crop})")
        img = frame("double-wide-1")
        check(img[0] == 3840 and img[1] == 1080, "group output renders")
        call("DELETE", "/api/walls/double-wide?outputs=delete")
        lay = json.loads(get("/api/layout")[1])
        check(not any(o.get("group") == "double-wide" for o in lay["outputs"]) and len(lay["walls"]) == 1, "deleting a group removes its outputs")

        print("group presets:", flush=True)
        call("POST", "/api/walls", {"name": "Side", "cols": 1, "rows": 1, "x": 0, "y": 1080})
        pause(1.0)
        side0, other0 = pixel(frame("side-1"), *spot), pixel(frame("out-2"), *spot)
        call("POST", "/api/sources", {"name": "Blue", "type": "solid", "color": [0, 0, 1, 1], "group": "side",
                                      "rect": {"x": 0, "y": 1080, "w": 1920, "h": 1080}})
        saved = call("POST", "/api/walls/side/presets", {"name": "All blue"})
        check(saved["id"] == "all-blue" and saved["sources"][0]["rect"]["y"] == 0, "preset saved relative to the group")
        call("POST", "/api/walls/side/clear")
        pause(1.0)
        check(close(pixel(frame("side-1"), *spot), side0, 12), "clearing the group shows what's under it")
        call("POST", "/api/walls/side/presets/all-blue/recall", {"transitionMs": 4000})
        seen, mid = mix_seen("side-1", side0, (0, 0, 255), 4.0)
        check(seen, f"the group crossfades {mid}")
        check(close(pixel(frame("out-2"), *spot), other0, 12), "outputs outside the group don't fade")
        check(wait_for(lambda: close(pixel(frame("side-1"), *spot), (0, 0, 255), 12), timeout=15), "recalled preset fills the group")
        ctl = json.loads(get("/api/control")[1])
        g = next(x for x in ctl["groups"] if x["id"] == "side")
        check(g["activePreset"] == "all-blue" and [p["id"] for p in g["presets"]] == ["all-blue"], "control summary lists the group's presets")
        lay = call("POST", "/api/walls/side/move", {"x": 2020, "y": 1080})
        rect = next(x["rect"] for x in lay["sources"] if x.get("group") == "side")
        check(rect["x"] == 2020 and rect["y"] == 1080, "group content moves with the group")
        call("DELETE", "/api/walls/side?outputs=delete")

        print("images and signal-loss fallback:", flush=True)
        png = png_bytes(8, 8, (255, 200, 0))
        req = urllib.request.Request(BASE + "/api/media?name=slate.png", method="POST", data=png, headers={"Content-Type": "image/png"})
        with urllib.request.urlopen(req, timeout=10) as r:
            check(json.loads(r.read())["name"] == "slate.png", "image uploaded")
        check(any(f["name"] == "slate.png" for f in json.loads(get("/api/media")[1])["files"]), "image listed")
        img_src = call("POST", "/api/sources", {"name": "Slate", "type": "image", "image": "slate.png", "rect": {"x": 0, "y": 0, "w": 1920, "h": 1080}})
        pause(1.0)
        check(close(pixel(frame("out-1"), *spot), (255, 200, 0), 12), "image source draws")
        call("DELETE", f"/api/sources/{img_src['id']}")
        call("PUT", "/api/layout", {"fallbackImage": "slate.png"})
        ndi_src = call("POST", "/api/sources", {"name": "Gone", "type": "ndi", "ndiName": "NOWHERE (Nothing)", "rect": {"x": 0, "y": 0, "w": 1920, "h": 1080}})
        pause(4.5)
        check(close(pixel(frame("out-1"), *spot), (255, 200, 0), 12), "a stream with no signal shows the fallback image")
        st = next(x for x in json.loads(get("/api/sources")[1])["sources"] if x["id"] == ndi_src["id"])["status"]
        check(st.get("signal") == "lost" and st.get("showing") == "fallback image", f"status reports the lost signal ({st.get('signal')}, {st.get('showing')})")
        call("DELETE", f"/api/sources/{ndi_src['id']}")
        call("PUT", "/api/layout", {"fallbackImage": ""})

        print("video file:", flush=True)
        can_video = False
        clip = open(os.path.join(here, "test-clip.mp4"), "rb").read()  # 1 s red, then 1 s blue (H.264, 30 fps)
        req = urllib.request.Request(BASE + "/api/media?name=clip.mp4", method="POST", data=clip, headers={"Content-Type": "video/mp4"})
        with urllib.request.urlopen(req, timeout=20) as r:
            check(json.loads(r.read())["kind"] == "video", "video uploaded")
        vid = call("POST", "/api/sources", {"name": "Clip", "type": "video", "video": "clip.mp4", "loop": True,
                                            "rect": {"x": 0, "y": 0, "w": 1920, "h": 1080}})
        def vstatus():
            return next(x for x in json.loads(get("/api/sources")[1])["sources"] if x["id"] == vid["id"])["status"]
        # Its own status (not one left from an earlier source with the same id), once it's opened or failed.
        st = wait_for(lambda: (lambda x: x if x.get("type") == "video" and (x.get("video") or x.get("status") not in (None, "", "ok")) else None)(vstatus()), timeout=30) or vstatus()
        print(f"  ..   {st.get('status')} · {st.get('video')}", flush=True)
        if "Media Foundation" in st.get("status", "") or "no decoder" in st.get("status", ""):
            print("  skip this machine can't decode H.264 (no Media Foundation): video checks skipped", flush=True)
        else:
            check(st.get("video", {}).get("codec") == "H.264" and st["video"]["width"] == 320, "video opened (H.264, 320x180)")
            can_video = True
            shows = lambda rgb: close(pixel(frame("out-1"), *spot), rgb, 40)
            # A GPU that can't convert decoded frames makes the engine decode on the CPU instead.
            wait_for(lambda: vstatus().get("status") in ("playing", "paused") and frame_id() and shows((255, 0, 0)) or shows((0, 0, 255)), timeout=20)
            print(f"  ..   {vstatus().get('status')} · decoder: {vstatus().get('video', {}).get('decoder')}", flush=True)
            call("POST", f"/api/sources/{vid['id']}/restart", {})
            check(wait_for(lambda: shows((255, 0, 0)), timeout=0.9, every=0.05), f"plays the first second (red) {pixel(frame('out-1'), *spot)}")
            check(wait_for(lambda: shows((0, 0, 255)), timeout=6, every=0.05), f"then the next (blue) {pixel(frame('out-1'), *spot)}")
            call("PATCH", f"/api/sources/{vid['id']}", {"playing": False})
            wait_for(lambda: vstatus()["status"] == "paused", timeout=15)
            pause(0.3)
            held = pixel(frame("out-1"), *spot)
            pause(1.2)
            after = pixel(frame("out-1"), *spot)
            check(close(after, held, 12) and vstatus()["status"] == "paused", f"pausing holds the picture ({held} -> {after}, {vstatus()['status']})")
            call("PATCH", f"/api/sources/{vid['id']}", {"playing": True})
            call("POST", f"/api/sources/{vid['id']}/restart", {})
            check(wait_for(lambda: shows((255, 0, 0)), timeout=0.9, every=0.05), "restart goes back to the first frame (red)")
            time.sleep(2.2)
            check(wait_for(lambda: vstatus()["status"] == "playing", timeout=10), "it loops (still playing after the end)")
            # Switched off, a video isn't decoded (an 8K file would use the CPU for nothing): its position holds.
            call("PATCH", f"/api/sources/{vid['id']}", {"enabled": False})
            check(wait_for(lambda: vstatus()["status"] == "off (not decoding)", timeout=10), f"switched off, it stops decoding ({vstatus()['status']})")
            pos = vstatus()["video"]["positionS"]
            time.sleep(1.5)
            st = vstatus()
            check(abs(st["video"]["positionS"] - pos) < 0.01 and st["video"]["decodeFps"] == 0, f"and its position holds ({pos:.2f} -> {st['video']['positionS']:.2f} s)")
            call("PATCH", f"/api/sources/{vid['id']}", {"enabled": True})
            check(wait_for(lambda: vstatus()["status"] == "playing", timeout=10), "switched on again, it plays on")
            if sys.platform == "win32":  # Media Foundation only knows which decoder it got once a frame is out
                decoder = wait_for(lambda: vstatus()["video"].get("decoder"), timeout=10)
                check(bool(decoder), f"the status names the decoder it got ({decoder})")
        call("DELETE", f"/api/sources/{vid['id']}")
        call("DELETE", "/api/media/clip.mp4")

        # Arrangements: a group's area divided into slots with one stream each, switched from a
        # control system (Blue Vue). The streams here don't exist; only where they go is checked.
        print("arrangements and slots:", flush=True)
        call("POST", "/api/walls", {"name": "Ultra", "cols": 1, "rows": 1, "outputWidth": 3840, "outputHeight": 1080, "x": 0, "y": 1080})
        def group(gid="ultra"):
            return next(x for x in json.loads(get("/api/control")[1])["groups"] if x["id"] == gid)
        def group_sources(gid="ultra"):
            return [x for x in json.loads(get("/api/layout")[1])["sources"] if x.get("group") == gid]
        g = group()
        check([(a["id"], a["slots"]) for a in g["arrangements"]] == [("full", 1), ("two", 2), ("quad", 4), ("five", 5)] and not g["on"] and g["slots"] == [],
              f"a group lists its arrangements, and starts with no content ({[(a['id'], a['slots']) for a in g['arrangements']]})")
        cams = [f"PC (Cam {i})" for i in range(1, 6)]
        r = call("POST", "/api/walls/ultra/arrange", {"arrangement": "five", "streams": cams})
        g = group()
        check(r["arrangement"] == "five" and g["on"] and [x["ndiName"] for x in g["slots"]] == cams and g["slots"][0]["name"] == "Main",
              "five streams: a main one and two each side")
        rects = {x["slot"]: (x["rect"]["x"], x["rect"]["y"], x["rect"]["w"], x["rect"]["h"]) for x in group_sources()}
        check(rects == {1: (960, 1080, 1920, 1080), 2: (0, 1080, 960, 540), 3: (0, 1620, 960, 540), 4: (2880, 1080, 960, 540), 5: (2880, 1620, 960, 540)},
              f"on a 32:9 group the main picture and the four small ones are all 16:9 ({rects})")
        call("POST", "/api/walls/ultra/slots/3", {"ndiName": "PC (Replay)"})
        g = group()
        check([x["ndiName"] for x in g["slots"]] == cams[:2] + ["PC (Replay)"] + cams[3:], "one slot changes, the others carry on")
        call("POST", "/api/walls/ultra/slots/5", {})
        g = group()
        check(g["slots"][4]["signal"] == "empty" and g["slots"][4]["ndiName"] == "" and len(group_sources()) == 4, "a slot can be emptied")
        call("POST", "/api/walls/ultra/arrange", {"arrangement": "two"})
        g = group()
        check(g["arrangement"] == "two" and [x["ndiName"] for x in g["slots"]] == cams[:2], "switching arrangement keeps the first slots' streams")
        rects = sorted((x["rect"]["x"], x["rect"]["w"]) for x in group_sources())
        check(rects == [(0, 1920), (1920, 1920)], f"two side by side ({rects})")
        pause(0.5)
        call("POST", "/api/walls/ultra/content", {"on": False})
        g = group()
        check(not g["on"] and g["canRestore"] and not group_sources(), "switched off, the group has no content of its own (it follows what's under it)")
        call("POST", "/api/walls/ultra/content", {"on": True})
        g = group()
        check(g["on"] and g["arrangement"] == "two" and [x["ndiName"] for x in g["slots"]] == cams[:2], "switched on, its arrangement and streams are back")
        call("POST", "/api/walls/ultra/clear")
        call("POST", "/api/walls/ultra/slots/2", {"ndiName": "PC (Late)"})
        g = group()
        check(g["on"] and [x["ndiName"] for x in g["slots"]] == [cams[0], "PC (Late)"], "a slot changed while off switches the group back on with it")
        call("POST", "/api/walls/ultra/show", {"ndiName": "PC (Whole)"})
        g = group()
        check(g["arrangement"] == "full" and [x["ndiName"] for x in g["slots"]] == ["PC (Whole)"], "showing one stream is the arrangement 'full'")
        def refused(path, body):
            try:
                call("POST", path, body)
                return False
            except urllib.error.HTTPError as ex:
                return ex.code == 400
        check(refused("/api/walls/ultra/arrange", {"arrangement": "nine"}) and refused("/api/walls/ultra/slots/2", {"ndiName": "x"})
              and refused("/api/walls/ultra/slots/1", {"playlist": "../x"}), "an unknown arrangement, slot or bad playlist name is refused")
        call("POST", "/api/walls/ultra/arrange", {"arrangement": "quad", "slots": [{"ndiName": cams[0]}, {"playlist": "Loop"}, {}, {"ndiName": cams[3]}]})
        saved = call("POST", "/api/walls/ultra/presets", {"name": "Quad mix"})
        call("POST", "/api/walls/ultra/show", {"ndiName": "PC (Whole)"})
        call("POST", "/api/walls/ultra/presets/quad-mix/recall", {})
        g = group()
        check(g["arrangement"] == "quad" and [x["ndiName"] or x["playlist"] for x in g["slots"]] == [cams[0], "Loop", "", cams[3]] and g["activePreset"] == "quad-mix",
              "a preset brings back the arrangement and what each slot played")
        # Grid groups also offer one stream per panel, laid on the panels (bezel gaps left out).
        g = group("wall")
        check([(a["id"], a["slots"]) for a in g["arrangements"]][:2] == [("full", 1), ("panels", g["displays"])] and g["displays"] > 1,
              f"a group of several panels also offers one stream per panel ({g['displays']} panels)")
        call("POST", "/api/walls/wall/arrange", {"arrangement": "panels", "streams": cams[:g["displays"]]})
        crops = sorted((o["crop"]["x"], o["crop"]["y"], o["crop"]["w"], o["crop"]["h"]) for o in json.loads(get("/api/layout")[1])["outputs"] if o.get("group") == "wall")
        rects = sorted((x["rect"]["x"], x["rect"]["y"], x["rect"]["w"], x["rect"]["h"]) for x in group_sources("wall"))
        check(rects == crops, f"each stream covers exactly its panel ({rects})")
        call("POST", "/api/walls/wall/clear")

        print("background and playlists:", flush=True)
        ctl = json.loads(get("/api/control")[1])
        check(ctl["background"] == {"on": False, "chosen": False, "ndiName": "", "playlist": "", "video": "", "signal": "empty"}, f"no background to start with ({ctl['background']})")
        check(refused("/api/background", {"on": True}), "switching on a background that was never chosen is refused")
        bg = call("POST", "/api/background", {"ndiName": "PC (Ambient)"})
        lay = json.loads(get("/api/layout")[1])
        first = lay["sources"][0]
        check(bg["on"] and bg["ndiName"] == "PC (Ambient)" and first["id"] == "background" and
              (first["rect"]["w"], first["rect"]["h"]) == (lay["canvas"]["width"], lay["canvas"]["height"]), "the background is one stream under everything, covering the canvas")
        bg = call("POST", "/api/background", {"on": False})
        check(not bg["on"] and bg["ndiName"] == "PC (Ambient)" and not json.loads(get("/api/layout")[1])["sources"][0]["enabled"], "switched off, it remembers its stream")
        bg = call("POST", "/api/background", {"on": True})
        check(bg["on"] and bg["ndiName"] == "PC (Ambient)", "and comes back on with it")
        pl = call("POST", "/api/playlists", {"name": "Loop"})
        check(pl["id"] == "Loop" and pl["videos"] == 0, "a playlist is a folder of videos")
        for name in ("b.mp4", "a.mp4"):
            req = urllib.request.Request(BASE + f"/api/media?name={name}&playlist=Loop", method="POST", data=clip, headers={"Content-Type": "video/mp4"})
            urllib.request.urlopen(req, timeout=20).read()
        pls = json.loads(get("/api/playlists")[1])["playlists"]
        check([(p["id"], [f["name"] for f in p["files"]]) for p in pls] == [("Loop", ["a.mp4", "b.mp4"])], f"videos uploaded into it are listed in play order ({pls})")
        check(json.loads(get("/api/control")[1])["playlists"] == [{"id": "Loop", "name": "Loop", "videos": 2}], "control lists the playlists")
        check(not any(f["name"] in ("a.mp4", "b.mp4") for f in json.loads(get("/api/media")[1])["files"]), "and they stay out of the single-file media list")
        bg = call("POST", "/api/background", {"playlist": "Loop"})
        check(bg["on"] and bg["playlist"] == "Loop" and bg["ndiName"] == "", "a playlist can be the background")
        if can_video:
            def playing():
                st = next((x for x in json.loads(get("/api/sources")[1])["sources"] if x["id"] == "background"), {}).get("status") or {}
                return (st.get("video") or {}).get("file", "")
            seen = []
            def step():
                f = playing()
                if f and (not seen or seen[-1] != f):
                    seen.append(f)
                return len(seen) >= 3
            wait_for(step, timeout=25, every=0.1)
            check(seen[:3] == ["Loop/a.mp4", "Loop/b.mp4", "Loop/a.mp4"], f"the playlist plays its videos in order and starts over ({seen})")
            # A video added while it plays joins in.
            req = urllib.request.Request(BASE + "/api/media?name=c.mp4&playlist=Loop", method="POST", data=clip, headers={"Content-Type": "video/mp4"})
            urllib.request.urlopen(req, timeout=20).read()
            check(wait_for(lambda: playing() == "Loop/c.mp4", timeout=25, every=0.1), "a video added to the folder is played too")
            # The same playlist in a slot of a group: its picture is on that part of the wall.
            call("POST", "/api/walls/ultra/arrange", {"arrangement": "two", "slots": [{"playlist": "Loop"}, {}]})
            left = lambda: pixel(frame("ultra-1"), 400, 500)
            check(wait_for(lambda: close(left(), (255, 0, 0), 40) or close(left(), (0, 0, 255), 40), timeout=20, every=0.1), f"a playlist plays in a slot {left()}")
        else:
            print("  skip playlist playback: this machine can't decode the test clip", flush=True)
        call("DELETE", "/api/sources/background")
        call("DELETE", "/api/walls/ultra?outputs=delete")
        call("DELETE", "/api/playlists/Loop/a.mp4")
        check([f["name"] for f in json.loads(get("/api/playlists")[1])["playlists"][0]["files"]][:1] == ["b.mp4"], "a video can be removed from a playlist")
        call("DELETE", "/api/playlists/Loop")
        check(json.loads(get("/api/playlists")[1])["playlists"] == [], "and the playlist deleted")

        print("layout history:", flush=True)
        hist = json.loads(get("/api/layouts/ci/history")[1])["history"]
        check(len(hist) >= 1, f"earlier versions are kept ({len(hist)})")
        names_before = [o["name"] for o in json.loads(get("/api/layout")[1])["outputs"]]
        call("POST", f"/api/layouts/ci/history/{hist[-1]['version']}/restore", {})
        restored = json.loads(get("/api/layout")[1])
        check(len(restored["outputs"]) == 5 and not restored["walls"], "restoring the oldest version brings back the original layout")
        check(len(json.loads(get("/api/layouts/ci/history")[1])["history"]) == len(hist) + 1, "the replaced version is kept too")

        print("CPU breakdown:", flush=True)
        cpu = json.loads(get("/api/system/cpu?ms=300")[1])
        check(cpu["cores"] >= 1 and 0 <= cpu["enginePercent"] <= 100, "the engine reports its share of the CPU")
        if sys.platform == "win32":
            names = [t["name"] for t in cpu["threads"]]
            check(any(n.startswith("canvas ") for n in names), f"and which threads use it, by name ({names[:6]})")

        print("NDI|HX decoding setting:", flush=True)
        check(json.loads(get("/api/system/ndi")[1])["gpuDecode"] is False, "NDI|HX inputs are decoded on the CPU unless asked otherwise")
        check(call("PUT", "/api/system/ndi", {"gpuDecode": True})["gpuDecode"] is True, "GPU decoding can be switched on")
        check(json.load(open(f"{tmp}/data/engine.json")).get("ndiGpuDecode") is True, "and is kept for the next start (data/engine.json)")
        check(call("PUT", "/api/system/ndi", {"gpuDecode": False})["gpuDecode"] is False, "and off again")

        print("endpoints:", flush=True)
        r = call("POST", "/api/endpoints/checkin", {"host": "WALL-PC.example.org", "dashboardPort": 9000, "screens": [], "panels": []})
        check(r["endpoint"] is None, "an unknown PC gets no assignment")
        unassigned = {u["host"]: u for u in json.loads(get("/api/endpoints")[1])["unassigned"]}
        check("WALL-PC.example.org" in unassigned, "it is listed as a PC to set up")
        check(unassigned.get("WALL-PC.example.org", {}).get("dashboardPort") == 9000, "with the port of its dashboard, for the editor's link")
        call("POST", "/api/endpoints", {"name": "Spare PC", "host": "spare-pc", "displays": [{"output": "out-1"}]})
        spare = next(x for x in json.loads(get("/api/endpoints")[1])["endpoints"] if x["id"] == "spare-pc")
        check(not spare["online"] and spare["lastSeenSecondsAgo"] is None, "an endpoint that never checked in is listed offline")
        call("POST", "/api/endpoints", {"name": "Wall PC", "host": "wall-pc", "displays": [{"output": "out-1"}, {"output": "out-2"}]})
        r = call("POST", "/api/endpoints/checkin", {"host": "WALL-PC.example.org", "screens": [],
                                                    "panels": [{"index": 1, "reachable": True, "playing": "X"}]})
        streams = [d.get("stream", "") for d in r["displays"]]
        check(r["endpoint"]["id"] == "wall-pc" and len(streams) == 2 and streams[0].endswith("(Mosaic_Output_01)"),
              f"its check-in returns its displays ({streams})")
        e = next(x for x in json.loads(get("/api/endpoints")[1])["endpoints"] if x["id"] == "wall-pc")
        check(e["online"] and not e["displays"][0]["ok"], "status shows it online, display 1 playing the wrong stream")
        call("PUT", "/api/endpoints/wall-pc", {"player": "mosaic"})
        plain = lambda: call("POST", "/api/endpoints/checkin", {"host": "wall-pc", "screens": [], "panels": []})["endpoint"].get("plainScaling")
        check(plain() is False, "a receiver sharpens enlarged pictures unless told otherwise")
        call("PUT", "/api/endpoints/wall-pc", {"plainScaling": True})
        check(plain() is True, "turning sharpening off for an endpoint reaches its PC at the next check-in")
        call("PUT", "/api/endpoints/wall-pc", {"plainScaling": False})
        check(plain() is False, "and turning it back on")
        r = call("POST", "/api/endpoints/checkin", {"host": "wall-pc", "panels": [], "receiver": {"spreadMax10s": 0, "alignedRatio": 1.0, "refreshHz": 60,
                                                    "displays": [{"index": 1, "shownFrameId": 1234, "late": 2}]}})
        check(r["endpoint"]["player"] == "mosaic", "the check-in tells the PC to use the Mosaic Receiver")
        e = next(x for x in json.loads(get("/api/endpoints")[1])["endpoints"] if x["id"] == "wall-pc")
        check(e["receiver"]["spreadMax10s"] == 0 and e["displays"][0]["shownFrameId"] == 1234, "the receiver's sync status reaches the editor")

        print("switching one screen of a PC off (black), the PC stays on:", flush=True)
        e = call("POST", "/api/endpoints/wall-pc/displays/2/blank", {"on": True})
        check([d.get("blank", False) for d in e["displays"]] == [False, True], "screen 2 is marked off, screen 1 is not")
        r = call("POST", "/api/endpoints/checkin", {"host": "wall-pc", "screens": [], "panels": []})
        streams = [d.get("stream", "") for d in r["displays"]]
        check(streams[1] == "blank" and streams[0].endswith("(Mosaic_Output_01)"), f"the PC is told to show black there and its stream on the other ({streams})")
        call("POST", "/api/endpoints/checkin", {"host": "wall-pc", "screens": [], "panels": [
            {"index": 1, "reachable": True, "playing": streams[0]}, {"index": 2, "reachable": True, "playing": "blank"}]})
        ep = next(x for x in call("GET", "/api/control")["endpoints"] if x["id"] == "wall-pc")
        check([s["blank"] for s in ep["screens"]] == [False, True] and ep["displaysBlank"] == 1 and not ep["blank"],
              f"the control summary lists each screen and which is off ({ep['screens']})")
        check(ep["displaysOk"] == 2, f"a screen showing black as asked counts as fine ({ep['displaysOk']} of 2)")
        saved = next(x for x in call("GET", "/api/layout")["endpoints"] if x["id"] == "wall-pc")
        check(saved["displays"][1].get("blank") is True, "it is saved with the layout (stays off through a restart)")
        e = call("POST", "/api/endpoints/wall-pc/blank", {"on": True})
        check(all(d.get("blank") for d in e["displays"]), "without a screen number, every screen of the PC goes off")
        ep = next(x for x in call("GET", "/api/control")["endpoints"] if x["id"] == "wall-pc")
        check(ep["blank"] and ep["displaysBlank"] == 2, "and the PC reads as off")
        e = call("POST", "/api/endpoints/wall-pc/blank", {"on": False, "display": 1})
        check([d.get("blank", False) for d in e["displays"]] == [False, True], "a screen number in the body works too: screen 1 back on")
        e = call("POST", "/api/endpoints/wall-pc/blank", {"on": False})
        r = call("POST", "/api/endpoints/checkin", {"host": "wall-pc", "screens": [], "panels": []})
        check(not any(d.get("blank") for d in e["displays"]) and all(d["stream"].startswith("") and d["stream"] != "blank" for d in r["displays"]),
              "all back on: both screens get their streams again")
        def refused(path, body):
            try:
                call("POST", path, body)
                return 0
            except urllib.error.HTTPError as ex:
                return ex.code
        check(refused("/api/endpoints/wall-pc/displays/9/blank", {"on": True}) == 400, "a screen the PC doesn't have is refused")
        check(refused("/api/endpoints/nobody/blank", {"on": True}) == 404, "and so is a PC that isn't set up")
        check(refused("/api/endpoints/spare-pc/blank", {"on": True}) == 400, "and one that doesn't run the Mosaic Receiver")

        print("one stream across a 2x2 of screens:", flush=True)
        call("POST", "/api/endpoints", {"name": "Quad PC", "host": "quad-pc", "player": "mosaic",
                                        "displays": [{"output": "out-1", "part": {"cols": 2, "rows": 2, "index": k}} for k in (1, 2, 3, 4)]})
        r = call("POST", "/api/endpoints/checkin", {"host": "quad-pc", "screens": [], "panels": []})
        crops = [d.get("crop") for d in r["displays"]]
        check(crops == [{"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}, {"x": 0.5, "y": 0.0, "w": 0.5, "h": 0.5},
                        {"x": 0.0, "y": 0.5, "w": 0.5, "h": 0.5}, {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5}],
              f"each screen gets its quarter of the one stream ({crops[1]})")
        check(len({d["stream"] for d in r["displays"]}) == 1 and r["displays"][0]["width"] == 960 and not any(d.get("error") for d in r["displays"]),
              "all four show the same stream, at a quarter of its size each")
        # Bezel correction: 40 px across and 20 px down are left out between the cells (out-1 is 1920 x 1080).
        gap = {"gapX": 40, "gapY": 20}
        call("PUT", "/api/endpoints/quad-pc", {"displays": [{"output": "out-1", "part": {"cols": 2, "rows": 2, "index": k, **gap}} for k in (1, 2, 3, 4)]})
        r = call("POST", "/api/endpoints/checkin", {"host": "quad-pc", "screens": [], "panels": []})
        c = [d["crop"] for d in r["displays"]]
        near = lambda a, b: abs(a - b) < 1e-9
        check(near(c[0]["w"], 940 / 1920) and near(c[0]["h"], 530 / 1080) and near(c[1]["x"], 980 / 1920) and near(c[2]["y"], 550 / 1080)
              and c[0]["x"] == 0 and c[1]["y"] == 0 and near(c[3]["x"] + c[3]["w"], 1) and near(c[3]["y"] + c[3]["h"], 1),
              f"bezel correction leaves the gap out between the cells and keeps the outer edges ({c[1]})")
        check(r["displays"][0]["width"] == 940 and r["displays"][0]["height"] == 530 and r["displays"][0]["part"]["gapX"] == 40, "and each cell is that much smaller")
        ep = next(e for e in json.loads(get("/api/endpoints")[1])["endpoints"] if e["id"] == "quad-pc")
        check(ep["displays"][3]["part"] == {"cols": 2, "rows": 2, "index": 4, "gapX": 40, "gapY": 20}, "the editor sees the gap")
        call("PUT", "/api/endpoints/quad-pc", {"displays": [{"output": "out-1", "part": {"cols": 2, "rows": 2, "index": k, "gapX": 5000}} for k in (1, 2, 3, 4)]})
        r = call("POST", "/api/endpoints/checkin", {"host": "quad-pc", "screens": [], "panels": []})
        check(r["displays"][0]["crop"]["w"] >= 0.25 - 1e-9, f"an oversized gap still leaves half the picture on the screens ({r['displays'][0]['crop']['w']:.3f})")
        # Identify: the PC's screens show their numbers for a while; not saved with the layout.
        r = call("POST", "/api/endpoints/checkin", {"host": "quad-pc", "screens": [], "panels": []})
        check(r["endpoint"]["identify"] is False, "identify is off unless asked for")
        ep = call("POST", "/api/endpoints/quad-pc/identify", {"on": True})
        check(540 < ep["identifySecondsLeft"] <= 600, f"identify turns on for 10 minutes ({ep['identifySecondsLeft']} s left)")
        r = call("POST", "/api/endpoints/checkin", {"host": "QUAD-PC.example.org", "screens": [], "panels": []})
        check(r["endpoint"]["identify"] is True and len(r["displays"]) == 4, "the check-in tells the PC to show its screen numbers, and still what it plays")
        saved = next(e for e in json.loads(get("/api/layout")[1])["endpoints"] if e["id"] == "quad-pc")
        check("identify" not in saved, "identify isn't saved with the layout")
        ep = call("POST", "/api/endpoints/quad-pc/identify", {"on": False})
        r = call("POST", "/api/endpoints/checkin", {"host": "quad-pc", "screens": [], "panels": []})
        check(ep["identifySecondsLeft"] == 0 and r["endpoint"]["identify"] is False, "and off again")
        try:
            call("POST", "/api/endpoints/spare-pc/identify", {"on": True})
            refused = False
        except urllib.error.HTTPError as ex:
            refused = ex.code == 400
        check(refused, "identify is refused for a PC that plays with Studio Monitor")
        call("PUT", "/api/endpoints/quad-pc", {"player": "studio_monitor"})
        r = call("POST", "/api/endpoints/checkin", {"host": "quad-pc", "screens": [], "panels": []})
        check("Mosaic Receiver" in (r["displays"][0].get("error") or ""), "Studio Monitor can't show part of a stream, and says so")
        call("PUT", "/api/endpoints/quad-pc", {"displays": [{"output": "out-1"}]})
        ep = next(e for e in json.loads(get("/api/endpoints")[1])["endpoints"] if e["id"] == "quad-pc")
        check("part" not in ep["displays"][0] and "crop" not in ep["displays"][0], "back to the whole picture")
        call("DELETE", "/api/endpoints/quad-pc")

        print("colour correction:", flush=True)
        def mean_rgb(img):
            w, h, data = img
            n, acc = 0, [0, 0, 0]
            for i in range(0, len(data), 4 * 101):
                acc[0] += data[i + 2]; acc[1] += data[i + 1]; acc[2] += data[i]; n += 1
            return [a / n for a in acc]
        call("PATCH", "/api/outputs/out-1", {"color": None})
        pause(1.0)
        base_rgb = mean_rgb(frame("out-1"))
        call("PATCH", "/api/outputs/out-1", {"color": {"red": 0.5}})
        halved = lambda h: abs(h[0] - base_rgb[0] * 0.5) < 12 and abs(h[1] - base_rgb[1]) < 12
        wait_for(lambda: halved(mean_rgb(frame("out-1"))), timeout=15)
        half = mean_rgb(frame("out-1"))
        check(halved(half) and base_rgb[0] > 30, f"red gain 0.5 halves red only ({base_rgb[0]:.0f} -> {half[0]:.0f})")
        call("PATCH", "/api/outputs/out-1", {"color": {"red": 1, "saturation": 0}})
        pause(0.5)
        g = mean_rgb(frame("out-1"))
        check(max(g) - min(g) < 3, f"saturation 0 makes it grey ({[round(x) for x in g]})")
        call("PATCH", "/api/outputs/out-1", {"color": None})
        check("color" not in next(o for o in json.loads(get("/api/layout")[1])["outputs"] if o["id"] == "out-1"), "reset leaves no colour settings")

        print("capture card (built-in test device):", flush=True)
        devs = call("GET", "/api/capture")["devices"]
        check(any(d["kind"] == "test" for d in devs), f"capture devices listed ({[d['name'] for d in devs]})")
        call("POST", "/api/sources", {"id": "cap", "name": "Capture", "type": "capture", "device": "Mosaic test capture", "rect": {"x": 0, "y": 0, "w": 64, "h": 36}})
        call("POST", "/api/outputs", {"id": "cap-ndi", "name": "Capture (NDI)", "source": "cap", "crop": {"x": 0, "y": 0, "w": 1280, "h": 720}, "width": 1280, "height": 720, "pixelFormat": "bgra"})
        pause(1.5)
        want = [(255, 255, 255), (255, 255, 0), (0, 255, 255), (0, 255, 0), (255, 0, 255), (255, 0, 0), (0, 0, 255), (0, 0, 0)]
        def bars_of(img):
            # Two points in each bar: the device's moving white bar (24 px) can cover one, not both.
            return [[pixel(img, x - 50, 360), pixel(img, x + 50, 360)] for x in range(80, 1280, 160)]
        def bars_match(got, tol):
            return all(any(close(g, w_, tol) for g in pair) for pair, w_ in zip(got, want))
        bars = bars_of(frame("cap-ndi"))
        check(bars_match(bars, 30), f"a capture source sent as NDI carries its picture ({[b[0] for b in bars[:3]]}...)")
        st = next(c for c in call("GET", "/api/capture")["open"] if c["name"] == "Mosaic test capture")
        check(st["width"] == 1280 and st["fps"] > 20, f"the device runs ({st['width']}x{st['height']}, {st['fps']:.0f} fps)")
        call("DELETE", "/api/outputs/cap-ndi")
        call("DELETE", "/api/sources/cap")
        # The same bars arriving as UYVY (how NDI sources come in), unpacked to RGB on the GPU.
        call("POST", "/api/sources", {"id": "capu", "name": "Capture UYVY", "type": "capture", "device": "Mosaic test capture (UYVY)", "rect": {"x": 0, "y": 0, "w": 64, "h": 36}})
        call("POST", "/api/outputs", {"id": "capu-ndi", "name": "Capture UYVY (NDI)", "source": "capu", "crop": {"x": 0, "y": 0, "w": 1280, "h": 720}, "width": 1280, "height": 720, "pixelFormat": "bgra"})
        pause(1.5)
        got = bars_of(frame("capu-ndi"))
        check(bars_match(got, 6), f"a UYVY source is unpacked to the right colours ({got})")
        call("DELETE", "/api/outputs/capu-ndi")
        call("DELETE", "/api/sources/capu")

        print("display outputs:", flush=True)
        call("PATCH", "/api/outputs/out-5", {"display": "\\\\.\\DISPLAY99"})
        pause(1)
        m5 = next(o for o in json.loads(get("/api/metrics")[1])["outputs"] if o["id"] == "out-5")
        check(m5["sink"] == "display" and m5.get("error"), f"an output on a monitor that isn't there says why ({m5.get('error')})")
        call("PATCH", "/api/outputs/out-5", {"delayMs": 250, "displayMode": {"width": 1920, "height": 1080, "refreshHz": 60}})
        o5 = next(o for o in json.loads(get("/api/layout")[1])["outputs"] if o["id"] == "out-5")
        check(o5.get("delayMs") == 250 and o5.get("displayMode") == {"width": 1920, "height": 1080, "refreshHz": 60},
              f"a display output keeps its delay and monitor mode ({o5.get('delayMs')}, {o5.get('displayMode')})")
        pause(0.5)
        call("PATCH", "/api/outputs/out-5", {"delayMs": 5000, "displayMode": None})
        o5 = next(o for o in json.loads(get("/api/layout")[1])["outputs"] if o["id"] == "out-5")
        check(o5.get("delayMs") == 1000 and "displayMode" not in o5, f"delay capped at 1 s, mode reset by null ({o5.get('delayMs')}, {o5.get('displayMode')})")
        call("PATCH", "/api/outputs/out-5", {"delayMs": 0})
        pause(1)
        call("PATCH", "/api/outputs/out-5", {"display": ""})
        pause(1)
        m5 = next(o for o in json.loads(get("/api/metrics")[1])["outputs"] if o["id"] == "out-5")
        check(m5["sink"] != "display", "back to an NDI stream")
        gpus = call("GET", "/api/gpus")["gpus"]
        print(f"  (GPUs: {[g['name'] for g in gpus]})")

        print("canvases:", flush=True)
        r = call("POST", "/api/canvases", {"name": "Wall Two"})
        c2 = r["id"]
        call("POST", "/api/walls", {"id": "w2", "name": "Wall two", "cols": 2, "rows": 1, "outputWidth": 640, "outputHeight": 360}, canvas=c2)
        l2 = json.loads(get("/api/layout", canvas=c2)[1])
        names2 = [o["ndiName"] for o in l2["outputs"]]
        check(names2 == ["Wall_Two_01", "Wall_Two_02"], f"a new canvas names its streams after itself ({names2})")
        check(len(json.loads(get("/api/layout")[1])["outputs"]) == 5, "the first canvas is untouched")
        pause(1.5)
        check(wait_for(lambda: frame_id(c2) > 5, timeout=30), "the second canvas renders at the same time")
        # A PC that knows its monitors makes an output wait for one that isn't there, before any
        # question of who uses it: so there this takes a monitor that exists (the first listed).
        listed = [l.split()[0] for l in subprocess.run([args.engine, "--monitors"], capture_output=True, text=True, timeout=60).stdout.splitlines()
                  if l.strip().startswith("\\\\.\\")]
        shared = listed[0] if listed else "\\\\.\\DISPLAY98"
        call("PATCH", "/api/outputs/out-5", {"display": shared})
        pause(0.5)
        call("PATCH", "/api/outputs/w2-1", {"display": shared}, canvas=c2)
        pause(1)
        e2 = next(o for o in json.loads(get("/api/metrics", canvas=c2)[1])["outputs"] if o["id"] == "w2-1").get("error", "")
        check("already used by" in e2, f"a monitor another canvas shows is refused ({e2})")
        call("PATCH", "/api/outputs/w2-1", {"display": ""}, canvas=c2)
        call("PATCH", "/api/outputs/out-5", {"display": ""})
        pause(1)
        call("POST", "/api/endpoints", {"name": "Two A", "host": "two-a", "player": "mosaic", "displays": [{"output": "w2-1"}]}, canvas=c2)
        call("POST", "/api/endpoints", {"name": "Two B", "host": "two-b", "player": "mosaic", "displays": [{"output": "w2-2"}]}, canvas=c2)
        r = call("POST", "/api/endpoints/checkin", {"host": "two-a", "screens": [], "panels": []})
        check(r["layout"] == l2["id"] and r["displays"][0]["stream"].endswith("(Wall_Two_01)"), "a PC set up on the second canvas gets its streams")
        shown = lambda off: [[1000 + i, 5_000_000 + i * 33333 + off] for i in range(40)]
        call("POST", "/api/endpoints/checkin", {"host": "two-a", "screens": [], "panels": [], "receiver": {"shownAtEngine": shown(0)}})
        call("POST", "/api/endpoints/checkin", {"host": "two-b", "screens": [], "panels": [], "receiver": {"shownAtEngine": shown(6000)}})
        gs = json.loads(get("/api/endpoints", canvas=c2)[1])["groupSync"]
        check(gs.get("pcs") == 2 and abs(gs.get("spreadMs", 0) - 6) < 0.5, f"the canvas's PCs are compared ({gs})")
        check(any(x["host"] == "two-a" for x in json.loads(get("/api/endpoints")[1]).get("elsewhere", [])), "the first canvas lists them as on another canvas")
        call("POST", f"/api/canvases/{c2}/simulate-gpu-loss", {})
        f1 = frame_id()
        def restarted():
            try:
                c = next(x for x in call("GET", "/api/canvases")["canvases"] if x["id"] == c2)
                return c["restarts"] >= 1 and c["running"] and not c["error"] and frame_id(c2) > 3
            except Exception:  # between stopping and starting again it doesn't answer
                return False
        check(wait_for(restarted, timeout=60, every=0.5), "a canvas whose GPU device is lost starts again by itself")
        check(wait_for(lambda: frame_id() > f1 + 5, timeout=20), "the other canvas kept running")
        call("DELETE", f"/api/canvases/{c2}")
        try:
            call("PATCH", "/api/outputs/w2-1", {"name": "x"}, canvas=c2)
            refused = False
        except urllib.error.HTTPError as ex:
            refused = ex.code == 409
        check(refused, "a change aimed at a stopped canvas is refused")
        check(len(call("GET", "/api/canvases")["canvases"]) == 1, "the canvas is stopped")

        print("frame delivery:", flush=True)
        pause(2)
        m = json.loads(get("/api/metrics")[1])
        json.dump(m, open(os.path.join(args.out, "metrics.json"), "w"), indent=2)
        s = m["sync"]
        check(m["engine"]["frameId"] > 30, f"rendered {m['engine']['frameId']} frames")
        check(all(o["framesSent"] > 0 for o in m["outputs"]), "every output sent frames")
        check(s["framesPartial"] == 0, f"no partial frames ({s['framesComplete']} complete, {s['framesPartial']} partial)")

        for i in range(1, 6):
            try:
                open(os.path.join(args.out, f"out-{i}.jpg"), "wb").write(get(f"/api/outputs/out-{i}/snapshot.jpg")[1])
            except Exception as ex:
                print(f"  (snapshot out-{i} failed: {ex})")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

print("display outputs follow their monitor:", flush=True)
mm = subprocess.run([args.engine, "--monitors"], capture_output=True, text=True, timeout=60)
print("".join("  " + line + "\n" for line in mm.stdout.splitlines()), end="", flush=True)
check(mm.returncode == 0 and "MONITOR MATCH PASSED" in mm.stdout, "an output stays with its monitor, waits while it is off, and this PC's monitors can be listed")

# NDI streams that can't start at first: like a canvas starting again while its old streams still
# hold their names. A test NDI system refuses each name 6 times (the engine's first 5 quick tries
# and one retry), so the streams can only come up through the engine trying again later.
print("NDI streams that can't start at first:", flush=True)
with tempfile.TemporaryDirectory() as tmp:
    os.makedirs(f"{tmp}/layouts")
    json.dump(layout, open(f"{tmp}/layouts/ci.json", "w"))
    log = open(os.path.join(args.out, "engine-retry.log"), "w")
    proc = subprocess.Popen([args.engine, "--data", f"{tmp}/data", "--layouts", f"{tmp}/layouts", "--layout", "ci", "--port", str(args.port)],
                            stderr=log, stdout=log, env=dict(os.environ, MOSAIC_TEST_NDI_SENDER_FAILS="6"))
    try:
        for _ in range(60):
            try:
                get("/api/health", timeout=2)
                break
            except Exception:
                time.sleep(0.5)
        sinks = lambda: {o["id"]: (o["sink"], o.get("error", "")) for o in json.loads(get("/api/metrics")[1])["outputs"]}
        first = wait_for(sinks, timeout=30)
        check(first and all(k == "null" and "trying again" in e for k, e in first.values()),
              f"a stream that can't start says so ({first and next(iter(first.values()))})")
        up = wait_for(lambda: all(k == "ndi" and not e for k, e in sinks().values()), timeout=20, every=0.5)
        check(up, f"and starts by itself a few seconds later ({sinks()})")
        sent = lambda: {o["id"]: o["framesSent"] for o in json.loads(get("/api/metrics")[1])["outputs"]}
        a = sent()
        time.sleep(1.5)
        b = sent()
        check(all(b[i] > a[i] for i in a), "and sends frames on it")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    print("  " + "\n  ".join(l.strip() for l in open(os.path.join(args.out, "engine-retry.log")) if "NDI sender" in l)[:600], flush=True)

print(f"\n{'FAILED: ' + str(len(failures)) + ' check(s)' if failures else 'ALL CHECKS PASSED'}")
sys.exit(1 if failures else 0)
