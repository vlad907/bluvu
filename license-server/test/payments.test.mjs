// Payments, end to end against a local server: Paddle's webhooks (signed like Paddle signs them) make
// and renew licenses, the checkout's success page gets the key, upgrades and the billing portal go
// through emailed links, and a fake Paddle API stands in for Paddle's.
//
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { startServer, openLicense } from "./harness.mjs";

const SECRET = "test-webhook-secret-for-paddle";
const PRICES = { starter: "pri_starter01", venue: "pri_venue01" };
const DAY = 86400_000;
const PC = { machineGuid: "pg", smbiosUuid: "pu", systemDisk: "pd" };

// ---- a fake Paddle API ----
const paddleCalls = [];
const paddleCustomers = { ctm_buyer01: { id: "ctm_buyer01", email: "buyer@venue.test", name: "Buyer Bar" } };
let paddle, srv;
before(async () => {
  paddle = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      paddleCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const send = (status, data) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(data)));
      let m;
      if (req.method === "GET" && (m = req.url.match(/^\/customers\/([^/]+)$/)))
        return paddleCustomers[m[1]] ? send(200, { data: paddleCustomers[m[1]] }) : send(404, { error: { code: "not_found", detail: "no such customer" } });
      if (req.method === "POST" && /^\/customers\/[^/]+\/portal-sessions$/.test(req.url))
        return send(201, { data: { urls: { general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_test?token=abc" } } } });
      if (req.method === "PATCH" && /^\/subscriptions\/[^/]+\/preview$/.test(req.url))
        return send(200, { data: { immediate_transaction: { details: { totals: { grand_total: "75000", currency_code: "USD" } } } } });
      if (req.method === "PATCH" && /^\/subscriptions\/[^/]+$/.test(req.url)) return send(200, { data: { id: req.url.split("/").pop() } });
      send(404, { error: { detail: "fake Paddle: unknown route" } });
    });
  });
  await new Promise((r) => paddle.listen(0, "127.0.0.1", r));
  srv = await startServer({
    PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_API_KEY: "pdl_sdbx_apikey_test",
    PADDLE_API_URL: `http://127.0.0.1:${paddle.address().port}`,
    PADDLE_PRICES: JSON.stringify(PRICES),
    PADDLE_CLIENT_TOKEN: "test_clienttoken",
    LINK_SECRET: "test-link-secret-0123456789abcdef0123",
    EMAIL_OUTBOX_ONLY: "1",
  });
});
after(() => {
  srv?.stop();
  paddle?.close();
});

// ---- events, signed like Paddle ----
let n = 0;
function event(type, data, occurredAt = new Date()) {
  return { event_id: `evt_test${String(++n).padStart(6, "0")}`, event_type: type, occurred_at: occurredAt.toISOString(), notification_id: `ntf_test${n}`, data };
}
function sign(raw, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex")}`;
}
async function deliver(ev, signature) {
  const raw = JSON.stringify(ev);
  return srv.post("/webhooks/paddle", raw, { "Paddle-Signature": signature ?? sign(raw) });
}
const period = (start, days = 365) => ({ starts_at: new Date(start).toISOString(), ends_at: new Date(start + days * DAY).toISOString() });
const subscription = (id, customer, price, extra = {}) => ({
  id,
  status: "active",
  customer_id: customer,
  items: [{ status: "active", quantity: 1, price: { id: price } }],
  current_billing_period: period(Date.now()),
  scheduled_change: null,
  ...extra,
});
const licenseOf = async (sub) => (await srv.admin("GET", "/licenses?q=")).body.licenses.find((l) => l.subscriptionId === sub);
const detail = async (id) => (await srv.admin("GET", `/licenses/${id}`)).body;
const linkIn = (text) => text.match(/https?:\/\/\S+\/billing\/\S+/)[0];

test("webhooks need Paddle's signature", async () => {
  const ev = event("subscription.created", subscription("sub_nosig01", "ctm_buyer01", PRICES.starter));
  assert.equal((await srv.post("/webhooks/paddle", JSON.stringify(ev))).status, 401, "none");
  assert.equal((await deliver(ev, sign(JSON.stringify(ev), undefined, "wrong-secret"))).status, 401, "wrong secret");
  assert.equal((await deliver(ev, sign(JSON.stringify(ev), Math.floor(Date.now() / 1000) - 3600))).status, 401, "an hour old (a replay)");
  assert.equal(await licenseOf("sub_nosig01"), undefined, "nothing was made");
});

let lic;
test("a purchase: the subscription makes a Starter license, the key is emailed, the success page shows it", async () => {
  const sub = subscription("sub_buyer01", "ctm_buyer01", PRICES.starter, { transaction_id: "txn_checkout01" });
  let r = await fetch(`${srv.base}/v1/purchase?txn=txn_checkout01`).then((x) => x.json());
  assert.equal(r.ready, false, "not ready before the webhook");
  // Paddle sends these in any order; the transaction also names the subscription.
  const created = event("subscription.created", sub);
  assert.equal((await deliver(created)).status, 200);
  assert.equal((await deliver(event("transaction.completed", { id: "txn_checkout01", origin: "web", status: "completed", customer_id: "ctm_buyer01", subscription_id: "sub_buyer01", items: sub.items, billing_period: sub.current_billing_period }))).status, 200);
  const again = await deliver(created);
  assert.equal(again.body.duplicate, true, "the same event twice is applied once");

  lic = await licenseOf("sub_buyer01");
  assert.ok(lic, "one license for the subscription");
  assert.equal(lic.plan, "starter");
  assert.equal(lic.maxScreens, 8);
  assert.equal(lic.billingStatus, "active");
  assert.equal(lic.customer.email, "buyer@venue.test", "the email came from Paddle's API (no customer event yet)");
  assert.equal(lic.expires.slice(0, 10), sub.current_billing_period.ends_at.slice(0, 10));
  assert.equal((await srv.admin("GET", "/licenses?q=buyer")).body.licenses.length, 1, "not two");

  r = await fetch(`${srv.base}/v1/purchase?txn=txn_checkout01`).then((x) => x.json());
  assert.equal(r.ready, true);
  assert.equal(r.key, lic.key);
  assert.equal(r.email, "buyer@venue.test");

  const d = await detail(lic.id);
  const keyMails = d.emails.filter((e) => e.kind === "key");
  assert.equal(keyMails.length, 1, "the key is emailed once");
  assert.match(keyMails[0].text, new RegExp(lic.key));
  assert.equal(keyMails[0].sent, false, "no email service locally: recorded, not sent");
  assert.ok(paddleCalls.some((c) => c.url === "/customers/ctm_buyer01" && c.auth === "Bearer pdl_sdbx_apikey_test"));
});

test("activating it: the file says it renews by itself", async () => {
  const r = await srv.post("/v1/activate", { key: lic.key, machine: PC });
  assert.equal(r.status, 200);
  const p = openLicense(r.body.license);
  assert.equal(p.plan, "starter");
  assert.equal(p.maxScreens, 8);
  assert.equal(p.renews, true);
});

test("a renewal moves the end date to the new period's end, and never shortens it", async () => {
  const next = period(Date.now() + 365 * DAY);
  await deliver(event("transaction.completed", { id: "txn_renew0000001", origin: "subscription_recurring", status: "completed", customer_id: "ctm_buyer01", subscription_id: "sub_buyer01", items: [{ price: { id: PRICES.starter } }], billing_period: next }));
  let l = await licenseOf("sub_buyer01");
  assert.equal(l.expires.slice(0, 10), next.ends_at.slice(0, 10));
  // A late, older event with the old period doesn't pull it back.
  await deliver(event("subscription.updated", subscription("sub_buyer01", "ctm_buyer01", PRICES.starter), new Date(Date.now() - DAY)));
  l = await licenseOf("sub_buyer01");
  assert.equal(l.expires.slice(0, 10), next.ends_at.slice(0, 10));
  const r = await srv.post("/v1/refresh", { licenseId: lic.id, machine: PC });
  assert.equal(openLicense(r.body.license).expires.slice(0, 10), next.ends_at.slice(0, 10), "the media server gets it on its refresh");
  assert.ok((await detail(lic.id)).events.some((e) => e.kind === "renewed"));
  assert.equal((await fetch(`${srv.base}/v1/purchase?txn=txn_renew0000001`).then((x) => x.json())).ready, false, "a renewal isn't a checkout");
});

test("upgrading: the key holder asks, the billing contact confirms by email, the webhook changes the plan", async () => {
  let r = await srv.post("/v1/billing", { key: lic.key, action: "upgrade", plan: "venue" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.to, "b••••@venue.test", "says where, without showing the whole address");
  r = await srv.post("/v1/billing", { key: lic.key, action: "upgrade", plan: "venue" });
  assert.equal(r.status, 429, "not twice in a minute");
  const mail = (await detail(lic.id)).emails.find((e) => e.kind === "upgrade-link");
  const link = linkIn(mail.text);
  const token = new URL(link).searchParams.get("t");

  const page = await fetch(`${srv.base}/billing/upgrade?t=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /\$750\.00/, "shows Paddle's prorated price");
  const bad = await fetch(`${srv.base}/billing/upgrade?t=${encodeURIComponent(token.slice(0, -2) + "00")}`);
  assert.equal(bad.status, 403, "a changed link doesn't work");

  const done = await fetch(`${srv.base}/billing/upgrade`, { method: "POST", body: new URLSearchParams({ t: token }) });
  assert.equal(done.status, 200);
  const patch = paddleCalls.find((c) => c.method === "PATCH" && c.url === "/subscriptions/sub_buyer01");
  assert.deepEqual(patch.body, { items: [{ price_id: PRICES.venue, quantity: 1 }], proration_billing_mode: "prorated_immediately" });
  assert.equal((await licenseOf("sub_buyer01")).plan, "starter", "nothing changes until Paddle confirms");

  await deliver(event("subscription.updated", subscription("sub_buyer01", "ctm_buyer01", PRICES.venue, { current_billing_period: period(Date.now()) })));
  const l = await licenseOf("sub_buyer01");
  assert.equal(l.plan, "venue");
  assert.equal(l.maxScreens, 32);
  assert.deepEqual(l.features, ["multiCanvas", "audio", "capture"]);
  r = await srv.post("/v1/refresh", { licenseId: lic.id, machine: PC });
  assert.equal(openLicense(r.body.license).maxScreens, 32, "the media server gets Venue on its next refresh");
  // A stale event from before the upgrade doesn't undo it.
  await deliver(event("subscription.updated", subscription("sub_buyer01", "ctm_buyer01", PRICES.starter), new Date(Date.now() - 2 * DAY)));
  assert.equal((await licenseOf("sub_buyer01")).plan, "venue");
  r = await srv.post("/v1/billing", { key: lic.key, action: "upgrade", plan: "venue" });
  assert.equal(r.status, 409, "already Venue");
});

test("a failed payment keeps the license valid; Paddle retries the card", async () => {
  await deliver(event("subscription.past_due", subscription("sub_buyer01", "ctm_buyer01", PRICES.venue, { status: "past_due" })));
  const l = await licenseOf("sub_buyer01");
  assert.equal(l.billingStatus, "past_due");
  assert.equal(l.state, "valid");
  assert.equal(l.status, "active");
  const r = await srv.post("/v1/refresh", { licenseId: lic.id, machine: PC });
  assert.equal(r.status, 200);
  assert.equal(openLicense(r.body.license).renews, false, "the editor no longer says it renews by itself");
  assert.ok((await detail(lic.id)).events.some((e) => e.kind === "payment-failed"));
});

test("cancelling keeps it to the end of what was paid", async () => {
  const before = (await licenseOf("sub_buyer01")).expires;
  await deliver(event("subscription.updated", subscription("sub_buyer01", "ctm_buyer01", PRICES.venue, { scheduled_change: { action: "cancel", effective_at: before } })));
  assert.equal((await licenseOf("sub_buyer01")).billingStatus, "canceling");
  await deliver(event("subscription.canceled", subscription("sub_buyer01", "ctm_buyer01", PRICES.venue, { status: "canceled", current_billing_period: null })));
  const l = await licenseOf("sub_buyer01");
  assert.equal(l.billingStatus, "canceled");
  assert.equal(l.expires, before);
  assert.equal(l.status, "active", "never revoked by a webhook");
  assert.equal((await srv.post("/v1/refresh", { licenseId: lic.id, machine: PC })).status, 200);
});

test("the customer arriving after the subscription: the key waits for the address; an existing customer is reused", async () => {
  const existing = await srv.admin("POST", "/licenses", { email: "late@venue.test", name: "Late Lounge", plan: "comp" });
  await deliver(event("subscription.created", subscription("sub_late01", "ctm_late01", PRICES.venue, { transaction_id: "txn_late00000001" })));
  let l = await licenseOf("sub_late01");
  assert.match(l.customer.email, /@pending\.invalid$/, "Paddle's API didn't know it either: a placeholder");
  let p = await fetch(`${srv.base}/v1/purchase?txn=txn_late00000001`).then((x) => x.json());
  assert.equal(p.ready, true);
  assert.equal(p.email, null);
  assert.equal((await detail(l.id)).emails.length, 0, "no key email to nowhere");

  await deliver(event("customer.created", { id: "ctm_late01", email: "late@venue.test", name: "Late Lounge" }));
  l = await licenseOf("sub_late01");
  assert.equal(l.customer.email, "late@venue.test");
  assert.equal(l.customer.id, existing.body.license.customer.id, "joined the existing customer");
  assert.equal((await detail(l.id)).emails.filter((e) => e.kind === "key").length, 1, "and now the key is emailed");
});

test("the billing portal by emailed link", async () => {
  const l = await licenseOf("sub_late01");
  const r = await srv.post("/v1/billing", { key: l.key, action: "portal" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const link = linkIn((await detail(l.id)).emails.find((e) => e.kind === "billing-link").text);
  const go = await fetch(`${srv.base}/billing/portal?t=${new URL(link).searchParams.get("t")}`, { redirect: "manual" });
  assert.equal(go.status, 303);
  assert.match(go.headers.get("location"), /^https:\/\/sandbox-customer-portal\.paddle\.com\//);
  const call = paddleCalls.find((c) => c.url === "/customers/ctm_late01/portal-sessions");
  assert.deepEqual(call.body, { subscription_ids: ["sub_late01"] });
  const upgradeLink = await fetch(`${srv.base}/billing/upgrade?t=${new URL(link).searchParams.get("t")}`);
  assert.equal(upgradeLink.status, 403, "a portal link isn't an upgrade link");
});

test("refusals: unknown prices, licenses not bought online, bad keys", async () => {
  let r = await deliver(event("subscription.created", subscription("sub_odd01", "ctm_buyer01", "pri_somethingelse")));
  assert.equal(r.status, 422, "Paddle retries it after PADDLE_PRICES is fixed");
  const comp = (await srv.admin("GET", "/licenses?q=late%40venue")).body.licenses.find((x) => x.plan === "comp");
  r = await srv.post("/v1/billing", { key: comp.key, action: "portal" });
  assert.equal(r.status, 409);
  r = await srv.post("/v1/billing", { key: "BLUVU-AAAAA-BBBBB-CCCCC-DDDDD", action: "portal" });
  assert.equal(r.status, 404);
  assert.equal((await fetch(`${srv.base}/v1/purchase?txn=nope`)).status, 400);
  r = await deliver(event("adjustment.created", { id: "adj_x" }));
  assert.equal(r.status, 200, "other events are acknowledged");
});

test("the pages", async () => {
  for (const [path, text] of [["/buy", /pri_venue01/], ["/purchase?txn=txn_checkout01", /license key/], ["/billing", /Email me the link/]]) {
    const r = await fetch(srv.base + path);
    assert.equal(r.status, 200, path);
    assert.match(await r.text(), text, path);
  }
  assert.match(await (await fetch(srv.base + "/buy")).text(), /SANDBOX/);
});
