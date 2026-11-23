// The admin page: one HTML file talking to /admin/api. Behind Cloudflare Access in production; locally
// it asks for the admin token (kept in this tab's sessionStorage only).

export function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bluvu licenses</title>
<style>
  :root { --bg: #0e1116; --surface: #161b22; --surface2: #1d232c; --border: #2a313c; --text: #e6e9ef; --muted: #8b95a5; --accent: #2f7ff7; --bad: #f25555; --warn: #f5a524; --ok: #2fcf73; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header .who { color: var(--muted); font-size: 12px; margin-left: auto; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: 16px; padding: 16px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  input, select, textarea { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; font: inherit; width: 100%; }
  textarea { font: 12px ui-monospace, Menlo, monospace; min-height: 70px; }
  button { background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 12px; font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.danger { color: var(--bad); border-color: rgba(242, 85, 85, .4); background: transparent; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  tr.row { cursor: pointer; } tr.row:hover td { background: var(--surface); } tr.sel td { background: var(--surface2); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 3px; }
  .muted { color: var(--muted); } .mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; border: 1px solid var(--border); }
  .pill.valid { color: var(--ok); border-color: rgba(47, 207, 115, .4); } .pill.grace { color: var(--warn); } .pill.expired, .pill.revoked { color: var(--bad); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .events { max-height: 260px; overflow: auto; font-size: 12px; }
  #msg { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 9px 14px; display: none; }
  .table-wrap { overflow-x: auto; }
</style>
</head>
<body>
<header>
  <h1>Bluvu licenses</h1>
  <input id="q" placeholder="Search email, business, key, notes" style="max-width: 320px">
  <span class="who" id="who"></span>
</header>
<main>
  <section>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Customer</th><th>Plan</th><th>State</th><th>Expires</th><th>Media server</th></tr></thead>
        <tbody id="rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>
  <aside>
    <div class="card" id="detail"><h2>License</h2><p class="muted">Pick one on the left.</p></div>
    <div class="card">
      <h2>Issue a license by hand</h2>
      <div class="grid2">
        <div><label>Email</label><input id="n-email" type="email"></div>
        <div><label>Business</label><input id="n-name"></div>
        <div><label>Plan</label><select id="n-plan"><option>comp</option><option>enterprise</option><option>venue</option><option>starter</option></select></div>
        <div><label>Screens (empty = the plan's)</label><input id="n-screens" inputmode="numeric"></div>
        <div><label>Expires (empty = never)</label><input id="n-expires" type="date"></div>
        <div><label>Grace days</label><input id="n-grace" value="30" inputmode="numeric"></div>
      </div>
      <label>Notes</label><input id="n-notes">
      <div class="actions"><button class="primary" id="n-go">Issue</button></div>
    </div>
  </aside>
</main>
<div id="msg"></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const day = (s) => (s ? s.slice(0, 10) : "never");
let selected = null;
function toast(t) { const m = $("msg"); m.textContent = t; m.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => (m.style.display = "none"), 3500); }
async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = sessionStorage.getItem("adminToken");
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch("/admin/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    const t = prompt("Admin token (local development; production signs in through Cloudflare Access)");
    if (t) { sessionStorage.setItem("adminToken", t); return api(method, path, body); }
  }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
async function list() {
  const { licenses } = await api("GET", "/licenses?q=" + encodeURIComponent($("q").value));
  $("rows").innerHTML = licenses.length ? licenses.map((l) => \`
    <tr class="row\${l.id === selected ? " sel" : ""}" data-id="\${l.id}">
      <td>\${esc(l.customer?.name || l.customer?.email)}<div class="muted">\${esc(l.customer?.name ? l.customer.email : "")}</div></td>
      <td>\${esc(l.plan)}\${l.trial ? " (trial)" : ""}<div class="muted">\${l.maxScreens < 0 ? "unlimited" : l.maxScreens + " screens"}</div></td>
      <td><span class="pill \${l.state}">\${l.state}</span></td>
      <td>\${day(l.expires)}</td>
      <td>\${l.machine ? "seen " + day(l.machine.lastSeen) : '<span class="muted">not activated</span>'}</td>
    </tr>\`).join("") : '<tr><td colspan="5" class="muted">No licenses.</td></tr>';
  document.querySelectorAll("tr.row").forEach((tr) => (tr.onclick = () => show(tr.dataset.id)));
}
async function show(id) {
  selected = id;
  const d = await api("GET", "/licenses/" + id);
  const l = d.license;
  $("detail").innerHTML = \`
    <h2>\${esc(l.customer?.name || l.customer?.email)} <span class="pill \${l.state}">\${l.state}</span></h2>
    <div class="mono">\${esc(l.key)}</div>
    <div class="muted" style="margin-top:6px">\${esc(l.id)} · \${esc(l.customer?.email)} · created \${day(l.created)}</div>
    \${l.subscriptionId ? \`<div class="muted">Paddle \${esc(l.subscriptionId)} · billing \${esc(l.billingStatus || "–")} · <a href="\${d.paddleDashboard}/subscriptions/\${encodeURIComponent(l.subscriptionId)}" target="_blank" rel="noreferrer">open in Paddle</a></div>\` : ""}
    <div class="grid2">
      <div><label>Plan</label><select id="e-plan">\${["starter","venue","enterprise","comp","trial"].map((p) => \`<option\${p === l.plan ? " selected" : ""}>\${p}</option>\`).join("")}</select></div>
      <div><label>Screens (-1 = unlimited)</label><input id="e-screens" value="\${l.maxScreens}"></div>
      <div><label>Expires (empty = never)</label><input id="e-expires" type="date" value="\${l.expires ? l.expires.slice(0, 10) : ""}"></div>
      <div><label>Grace days</label><input id="e-grace" value="\${l.graceDays}"></div>
    </div>
    <label>Features</label><input id="e-features" value="\${esc(l.features.join(", "))}">
    <label>Notes</label><input id="e-notes" value="\${esc(l.notes)}">
    <div class="actions">
      <button class="primary" id="e-save">Save</button>
      \${l.status === "revoked" ? '<button id="e-restore">Restore</button>' : '<button class="danger" id="e-revoke">Revoke</button>'}
      <button id="e-release" \${l.machine ? "" : "disabled"}>Release media server</button>
      <button id="e-moves">Reset moves (\${d.movesThisYear} this year)</button>
      <button id="e-sendkey">Email the key</button>
    </div>
    <label>License file for a request code (offline activation by hand)</label>
    <textarea id="e-code" placeholder="Request code from Settings → License"></textarea>
    <div class="actions"><button id="e-file">Make license file</button></div>
    <h2 style="margin-top:14px">Media servers</h2>
    \${d.machines.map((m) => \`<div class="mono">\${esc([m.machineGuid, m.smbiosUuid, m.systemDisk].map((h) => (h || "–").slice(0, 8)).join(" · "))}</div>
      <div class="muted" style="margin-bottom:6px">activated \${day(m.activated)} · seen \${day(m.lastSeen)}\${m.released ? " · released " + day(m.released) : " · active"}\${m.engine ? " · engine " + esc(m.engine) : ""}</div>\`).join("") || '<p class="muted">None yet.</p>'}
    <h2 style="margin-top:14px">Emails</h2>
    \${d.emails.map((m) => \`<div><span class="muted">\${m.at.replace("T", " ").slice(0, 16)}</span> \${esc(m.kind)} to \${esc(m.to)} \${m.sent ? "" : \`<span class="pill expired">not sent</span> <span class="muted">\${esc(m.error)}</span>\`}</div>\`).join("") || '<p class="muted">None.</p>'}
    <h2 style="margin-top:14px">History</h2>
    <div class="events">\${d.events.map((e) => \`<div><span class="muted">\${e.at.replace("T", " ").slice(0, 16)}</span> \${esc(e.kind)} <span class="muted">\${esc(e.actor)}</span></div>\`).join("")}</div>\`;
  const act = (fn) => async () => { try { await fn(); await show(id); await list(); } catch (e) { toast(e.message); } };
  $("e-save").onclick = act(async () => {
    await api("PATCH", "/licenses/" + id, { plan: $("e-plan").value, maxScreens: $("e-screens").value, expires: $("e-expires").value || null, graceDays: $("e-grace").value, notes: $("e-notes").value,
      features: $("e-features").value.split(",").map((s) => s.trim()).filter(Boolean) });
    toast("Saved. The media server picks it up at its next daily refresh.");
  });
  if ($("e-revoke")) $("e-revoke").onclick = act(async () => { if (confirm("Revoke this license? Its media server stops being licensed at its next refresh (the walls keep playing).")) await api("POST", "/licenses/" + id + "/revoke"); });
  if ($("e-restore")) $("e-restore").onclick = act(() => api("POST", "/licenses/" + id + "/restore"));
  $("e-release").onclick = act(async () => { if (confirm("Release the media server? The license can then be activated on another one without counting as a move.")) await api("POST", "/licenses/" + id + "/release"); });
  $("e-moves").onclick = act(() => api("POST", "/licenses/" + id + "/reset-moves"));
  $("e-sendkey").onclick = act(async () => { const r = await api("POST", "/licenses/" + id + "/send-key"); toast(r.sent ? "Sent." : "Not sent: " + r.error); });
  $("e-file").onclick = act(async () => {
    const r = await api("POST", "/licenses/" + id + "/file", { code: $("e-code").value.trim() || undefined });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.license], { type: "application/json" }));
    a.download = "bluvu-license.json";
    a.click();
  });
  list();
}
$("n-go").onclick = async () => {
  try {
    const r = await api("POST", "/licenses", { email: $("n-email").value, name: $("n-name").value, plan: $("n-plan").value, maxScreens: $("n-screens").value,
      expires: $("n-expires").value || null, graceDays: $("n-grace").value, notes: $("n-notes").value });
    toast("Issued " + r.license.key);
    await list();
    show(r.license.id);
  } catch (e) { toast(e.message); }
};
let qt;
$("q").oninput = () => { clearTimeout(qt); qt = setTimeout(list, 250); };
api("GET", "/me").then((m) => ($("who").textContent = m.actor.replace("admin:", ""))).then(list).catch((e) => toast(e.message));
</script>
</body>
</html>`;
}
