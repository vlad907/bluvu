// The offline activation page: paste the request code from Settings → License, get the license file.

export function activatePage(env) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activate Bluvu offline</title>
<style>
  :root { --bg: #0e1116; --surface: #161b22; --border: #2a313c; --text: #e6e9ef; --muted: #8b95a5; --accent: #2f7ff7; --bad: #f25555; --ok: #2fcf73; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  p { color: var(--muted); }
  ol { color: var(--muted); padding-left: 20px; }
  textarea, input { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font: 13px ui-monospace, Menlo, monospace; }
  textarea { min-height: 110px; resize: vertical; word-break: break-all; }
  label { display: block; margin: 18px 0 6px; font-weight: 600; }
  button { margin-top: 16px; height: 40px; padding: 0 18px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .msg { margin-top: 16px; padding: 12px 14px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); }
  .msg.bad { border-color: var(--bad); }
  .msg.ok { border-color: var(--ok); }
  .fine { font-size: 13px; margin-top: 40px; }
</style>
</head>
<body>
<main>
  <h1>Activate Bluvu offline</h1>
  <p>For a media server without internet access.</p>
  <ol>
    <li>In the editor on the media server, open <b>Settings → License</b>, enter your license key and choose <b>Get request code</b>.</li>
    <li>Paste the code here, from any device with internet.</li>
    <li>Bring the license file back to the media server (USB stick, or open the editor from this device) and choose <b>Install license file…</b></li>
  </ol>
  <label for="code">Request code</label>
  <textarea id="code" spellcheck="false" placeholder="eyJ…"></textarea>
  <label for="email">Email (only for a trial)</label>
  <input id="email" type="email" autocomplete="email" placeholder="you@venue.com">
  <button id="go">Get the license file</button>
  <div id="msg" class="msg" hidden></div>
  <p class="fine">Bluvu is a product of Blue Arc Networks. <a href="${env.SITE_URL}" style="color: var(--muted)">${String(env.SITE_URL).replace(/^https?:\/\//, "")}</a></p>
</main>
<script>
  const go = document.getElementById("go"), msg = document.getElementById("msg");
  const show = (text, kind) => { msg.hidden = false; msg.className = "msg " + kind; msg.textContent = text; };
  go.onclick = async () => {
    const code = document.getElementById("code").value.trim();
    if (!code) return show("Paste the request code first.", "bad");
    go.disabled = true;
    try {
      const r = await fetch("/v1/offline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, email: document.getElementById("email").value.trim() }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Something went wrong (" + r.status + ")");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data.license], { type: "application/json" }));
      a.download = "bluvu-license.json";
      a.click();
      show("Downloaded bluvu-license.json. Install it in Settings → License on the media server.", "ok");
    } catch (e) {
      show(e.message, "bad");
    } finally {
      go.disabled = false;
    }
  };
</script>
</body>
</html>`;
}
