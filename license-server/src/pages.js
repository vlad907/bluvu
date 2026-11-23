// The website pages the license server serves itself: offline activation, and (phase 4) a sandbox
// checkout, the page after it with the key, and billing (portal, upgrade) by emailed link. The real
// website (phase 6) links here or takes these over.

const STYLE = `  :root { --bg: #0e1116; --surface: #161b22; --border: #2a313c; --text: #e6e9ef; --muted: #8b95a5; --accent: #2f7ff7; --bad: #f25555; --ok: #2fcf73; color-scheme: dark; }
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
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 24px; }
  .plan { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .plan h2 { margin: 0 0 4px; font-size: 18px; }
  .plan p { margin: 0 0 8px; font-size: 14px; }
  .key { font: 600 20px ui-monospace, Menlo, monospace; letter-spacing: .04em; padding: 14px; background: var(--surface); border: 1px solid var(--ok); border-radius: 8px; word-break: break-all; }
  .sandbox { display: inline-block; font-size: 12px; font-weight: 700; color: #111; background: #f5c542; border-radius: 4px; padding: 2px 6px; margin-left: 8px; vertical-align: middle; }
  select { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 15px; }
  a { color: var(--accent); }
`;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function shell(env, title, body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${STYLE}</style>
</head>
<body>
<main>
${body}
  <p class="fine">Bluvu is a product of Blue Arc Networks. <a href="${esc(env.SITE_URL)}" style="color: var(--muted)">${esc(String(env.SITE_URL).replace(/^https?:\/\//, ""))}</a></p>
</main>
${script}
</body>
</html>`;
}

export const messagePage = (env, title, text, ok = true) =>
  shell(env, title, `  <h1>${esc(title)}</h1>\n  <div class="msg ${ok ? "ok" : "bad"}">${esc(text)}</div>`);

const isSandbox = (env) => (env.PADDLE_ENV || "sandbox") !== "production";
const planText = {
  starter: ["Starter", "Up to 8 screens, one wall."],
  venue: ["Venue", "Up to 32 screens, several walls, sound zones and capture cards."],
  enterprise: ["Enterprise", "Unlimited screens."],
};

// The checkout (Paddle.js overlay). After paying, Paddle.js hands us the transaction, and the next
// page waits for the webhook to make the license.
export function buyPage(env, prices) {
  const plans = Object.keys(prices);
  if (!env.PADDLE_CLIENT_TOKEN || !plans.length)
    return messagePage(env, "Buy Bluvu", "The checkout isn't set up on this server yet (PADDLE_CLIENT_TOKEN and PADDLE_PRICES).", false);
  const cards = plans
    .map((p) => `    <div class="plan"><h2>${esc(planText[p][0])}</h2><p>${esc(planText[p][1])}</p><p>One media server, one year, renews yearly.</p><button data-price="${esc(prices[p])}">Buy ${esc(planText[p][0])}</button></div>`)
    .join("\n");
  return shell(
    env,
    "Buy Bluvu",
    `  <h1>Buy Bluvu${isSandbox(env) ? '<span class="sandbox">SANDBOX: test cards only</span>' : ""}</h1>
  <p>A license is for one media server and runs for a year, renewing by itself. Receiving PCs never need one. Paddle handles the payment and the tax as the seller.</p>
  <div class="plans">
${cards}
  </div>
  <div id="msg" class="msg bad" hidden></div>`,
    `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  ${isSandbox(env) ? 'Paddle.Environment.set("sandbox");' : ""}
  Paddle.Initialize({
    token: ${JSON.stringify(env.PADDLE_CLIENT_TOKEN)},
    eventCallback: (e) => {
      if (e.name === "checkout.completed" && e.data && e.data.transaction_id) location.href = "/purchase?txn=" + encodeURIComponent(e.data.transaction_id);
    },
  });
  for (const b of document.querySelectorAll("button[data-price]"))
    b.onclick = () => Paddle.Checkout.open({ items: [{ priceId: b.dataset.price, quantity: 1 }], settings: { displayMode: "overlay" } });
</script>`,
  );
}

// After the checkout: waits for the license (the webhook usually lands within seconds), shows the key.
export function purchasePage(env) {
  return shell(
    env,
    "Your Bluvu license",
    `  <h1>Thank you</h1>
  <p id="wait">Making your license… this usually takes a few seconds.</p>
  <div id="done" hidden>
    <p>Your <b id="plan"></b> license key:</p>
    <div class="key" id="key"></div>
    <ol>
      <li>Open the editor on your media server and go to <b>Settings → License</b>.</li>
      <li>Paste the key and choose <b>Activate online</b>. No internet there? Choose <b>Get request code</b> and use the <a href="/activate">offline activation page</a>.</li>
    </ol>
    <p id="mail"></p>
  </div>
  <div id="msg" class="msg bad" hidden></div>`,
    `<script>
  const txn = new URLSearchParams(location.search).get("txn");
  const $ = (id) => document.getElementById(id);
  const names = { starter: "Starter", venue: "Venue", enterprise: "Enterprise" };
  let tries = 0;
  async function poll() {
    try {
      const r = await fetch("/v1/purchase?txn=" + encodeURIComponent(txn || ""));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      if (d.ready) {
        $("wait").hidden = true; $("done").hidden = false;
        $("plan").textContent = names[d.plan] || d.plan; $("key").textContent = d.key;
        $("mail").textContent = d.email ? "We've also emailed it to " + d.email + ", with the receipt from Paddle." : "We'll also email it to you, with the receipt from Paddle.";
        return;
      }
    } catch (e) {
      if (++tries > 3) { $("msg").hidden = false; $("msg").textContent = e.message; return; }
    }
    if (++tries > 60) { $("wait").textContent = "This is taking longer than usual. The key will arrive by email; if it doesn't within the hour, reply to Paddle's receipt."; return; }
    setTimeout(poll, 2000);
  }
  poll();
</script>`,
  );
}

// Billing: the key holder asks, the billing contact gets the link.
export function billingPage(env, prices) {
  const ups = Object.keys(prices).filter((p) => p !== "starter");
  return shell(
    env,
    "Bluvu billing",
    `  <h1>Billing</h1>
  <p>Change the card, see receipts, cancel, or upgrade a license bought on the website. We email a link to the license's billing contact, so the key alone can't change what's paid.</p>
  <label for="key">License key</label>
  <input id="key" placeholder="BLUVU-XXXXX-XXXXX-XXXXX-XXXXX" autocomplete="off" spellcheck="false">
  <label for="what">What to do</label>
  <select id="what">
    <option value="portal">Payment method, receipts, cancelling</option>
${ups.map((p) => `    <option value="upgrade:${esc(p)}">Upgrade to ${esc(planText[p][0])}</option>`).join("\n")}
  </select>
  <button id="go">Email me the link</button>
  <div id="msg" class="msg" hidden></div>`,
    `<script>
  const go = document.getElementById("go"), msg = document.getElementById("msg");
  const show = (t, k) => { msg.hidden = false; msg.className = "msg " + k; msg.textContent = t; };
  go.onclick = async () => {
    const [action, plan] = document.getElementById("what").value.split(":");
    go.disabled = true;
    try {
      const r = await fetch("/v1/billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: document.getElementById("key").value, action, plan }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Something went wrong (" + r.status + ")");
      show("Sent to " + d.to + ". The link works for an hour.", "ok");
    } catch (e) { show(e.message, "bad"); } finally { go.disabled = false; }
  };
</script>`,
  );
}

const money = (t) => {
  if (!t?.amount || !t?.currency) return null;
  const n = Number(t.amount) / 100;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: t.currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${t.currency}`;
  }
};
export function upgradePage(env, token, p) {
  const total = money(p.total);
  return shell(
    env,
    "Upgrade Bluvu",
    `  <h1>Upgrade to ${esc(planText[p.to]?.[0] ?? p.to)}${isSandbox(env) ? '<span class="sandbox">SANDBOX</span>' : ""}</h1>
  <p>License ${esc(p.key.slice(0, 11))}… from ${esc(planText[p.from]?.[0] ?? p.from)} to ${esc(planText[p.to]?.[0] ?? p.to)}: ${esc(planText[p.to]?.[1] ?? "")}</p>
  <p>${total ? `Charged now: <b>${esc(total)}</b> (the rest of this year, prorated, with tax).` : "Paddle charges the prorated difference for the rest of this year now."} After that it renews at the ${esc(planText[p.to]?.[0] ?? p.to)} price.</p>
  <form method="post" action="/billing/upgrade">
    <input type="hidden" name="t" value="${esc(token)}">
    <button>Upgrade and pay</button>
  </form>`,
  );
}

export function activatePage(env) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activate Bluvu offline</title>
<style>
${STYLE}</style>
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
