// Payments through Paddle Billing (merchant of record). Sandbox until the owner says go live.
//
// - POST /webhooks/paddle: Paddle's notifications, signed (Paddle-Signature: ts=..;h1=HMAC-SHA256 of
//   "ts:body" with PADDLE_WEBHOOK_SECRET). A subscription creates its license (and the key is emailed);
//   a renewal moves `expires` to the end of the new billing period; a plan change (Starter -> Venue)
//   changes the plan, which reaches the media server on its next daily refresh (or Check now).
//   A failed payment changes nothing about the license: it stays valid to its end date, then has the
//   30-day grace period, while Paddle retries the card. Cancelling keeps it to the end of what was paid.
//   Webhooks never shorten a license or revoke one: refunds and chargebacks are revoked by hand.
// - Each event is applied once (paddle_events), and subscription events older than the last one
//   applied don't change the plan or status (Paddle doesn't promise order).
// - The Paddle API (PADDLE_API_KEY; PADDLE_API_URL, sandbox by default) looks up a customer's email
//   when the customer event hasn't arrived yet, opens the billing portal and changes plans.
//
// Prices: PADDLE_PRICES = {"starter": "pri_...", "venue": "pri_...", "enterprise": "pri_..."} (plain
// config, set at deployment from the Paddle catalog).

import { createLicense, findOrCreateCustomer, getLicense, getLicenseByKey, HttpError, iso, logEvent, now, PLANS } from "./core.js";
import { sendEmail, sendKeyOnce, planName } from "./email.js";

const RANK = { starter: 1, venue: 2, enterprise: 3 };
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const toUnix = (s) => (s ? Math.floor(Date.parse(s) / 1000) : null);

export function prices(env) {
  let p = {};
  try {
    p = typeof env.PADDLE_PRICES === "string" ? JSON.parse(env.PADDLE_PRICES || "{}") : env.PADDLE_PRICES ?? {};
  } catch {
    throw new HttpError(500, "PADDLE_PRICES isn't valid JSON");
  }
  return Object.fromEntries(Object.entries(p).filter(([plan, id]) => RANK[plan] && typeof id === "string" && id));
}

// The plan a subscription's items buy: the highest one we know.
function planOf(env, items) {
  const byPrice = Object.fromEntries(Object.entries(prices(env)).map(([plan, id]) => [id, plan]));
  let plan = null;
  for (const it of items ?? []) {
    const p = byPrice[it?.price?.id ?? it?.price_id];
    if (p && (!plan || RANK[p] > RANK[plan])) plan = p;
  }
  return plan;
}

// ---- the webhook signature ----
const sameText = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
async function verifySignature(env, header, raw) {
  if (!env.PADDLE_WEBHOOK_SECRET) throw new HttpError(500, "PADDLE_WEBHOOK_SECRET isn't set");
  let ts = null;
  const h1 = [];
  for (const part of String(header ?? "").split(";")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim());
    if (k === "ts") ts = v;
    if (k === "h1" && v) h1.push(v.toLowerCase());
  }
  if (!ts || !/^\d+$/.test(ts) || !h1.length) throw new HttpError(401, "missing or malformed Paddle-Signature");
  if (Math.abs(now() - parseInt(ts, 10)) > 300) throw new HttpError(401, "Paddle-Signature is too old (or the clock is off)");
  const mac = await hmacHex(env.PADDLE_WEBHOOK_SECRET, `${ts}:${raw}`);
  if (!h1.some((h) => sameText(h, mac))) throw new HttpError(401, "Paddle-Signature doesn't match");
}

// ---- the Paddle API ----
async function paddleApi(env, method, path, body) {
  if (!env.PADDLE_API_KEY) throw new HttpError(503, "billing isn't set up on this server yet (PADDLE_API_KEY)");
  const base = (env.PADDLE_API_URL || "https://sandbox-api.paddle.com").replace(/\/$/, "");
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Paddle said no: ${data?.error?.detail ?? data?.error?.code ?? r.status}`);
  return data.data;
}

// ---- customers ----
async function customerFor(env, paddleCustomerId) {
  const linked = await env.DB.prepare("SELECT * FROM customers WHERE paddle_customer_id = ?").bind(paddleCustomerId).first();
  if (linked) return linked;
  let pc = await env.DB.prepare("SELECT * FROM paddle_customers WHERE id = ?").bind(paddleCustomerId).first();
  if (!pc && env.PADDLE_API_KEY) {
    try {
      const c = await paddleApi(env, "GET", `/customers/${encodeURIComponent(paddleCustomerId)}`);
      if (c?.email) pc = await rememberCustomer(env, { id: paddleCustomerId, email: c.email, name: c.name ?? "" });
    } catch (e) {
      console.error("customer lookup", e?.message);
    }
  }
  // Not known yet: a placeholder, fixed (and the key emailed) when customer.created arrives.
  const customer = await findOrCreateCustomer(env, pc?.email || `${paddleCustomerId}@pending.invalid`, pc?.name ?? "");
  if (!customer.paddle_customer_id)
    await env.DB.prepare("UPDATE customers SET paddle_customer_id = ? WHERE id = ? AND paddle_customer_id IS NULL").bind(paddleCustomerId, customer.id).run();
  return { ...customer, paddle_customer_id: customer.paddle_customer_id ?? paddleCustomerId };
}

async function rememberCustomer(env, { id, email, name }) {
  await env.DB.prepare(
    "INSERT INTO paddle_customers (id, email, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = excluded.updated_at",
  )
    .bind(id, email, name ?? "", now())
    .run();
  return { id, email, name: name ?? "" };
}

// customer.created / customer.updated: fill in a placeholder, then email any key that was waiting.
async function onCustomer(env, data) {
  if (!data?.id || !data?.email) return;
  await rememberCustomer(env, { id: data.id, email: data.email, name: data.name ?? "" });
  const linked = await env.DB.prepare("SELECT * FROM customers WHERE paddle_customer_id = ?").bind(data.id).first();
  if (!linked) return;
  if (/\.invalid$/i.test(linked.email)) {
    const existing = await env.DB.prepare("SELECT * FROM customers WHERE lower(email) = lower(?)").bind(data.email).first();
    if (existing) {
      // The address already has an account (a trial, say): its licenses join it.
      await env.DB.batch([
        env.DB.prepare("UPDATE licenses SET customer_id = ? WHERE customer_id = ?").bind(existing.id, linked.id),
        env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(linked.id),
        env.DB.prepare("UPDATE customers SET paddle_customer_id = COALESCE(paddle_customer_id, ?), name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?").bind(
          data.id,
          data.name ?? "",
          existing.id,
        ),
      ]);
    } else {
      await env.DB.prepare("UPDATE customers SET email = ?, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?").bind(data.email, data.name ?? "", linked.id).run();
    }
  }
  const owner = await env.DB.prepare("SELECT id FROM customers WHERE paddle_customer_id = ?").bind(data.id).first();
  const { results } = await env.DB.prepare("SELECT * FROM licenses WHERE customer_id = ? AND subscription_id IS NOT NULL").bind(owner?.id ?? linked.id).all();
  for (const lic of results) await sendKeyOnce(env, lic);
}

// ---- subscriptions -> licenses ----
function billingStatus(sub) {
  if (!sub?.status) return null;
  if (sub.status === "active" && sub.scheduled_change?.action === "cancel") return "canceling";
  return sub.status; // active | trialing | past_due | paused | canceled
}

// One place where a subscription's state lands on its license.
async function applySubscription(env, s) {
  const plan = planOf(env, s.items);
  let lic = await env.DB.prepare("SELECT * FROM licenses WHERE subscription_id = ?").bind(s.subscriptionId).first();
  if (!lic) {
    if (!plan) throw new HttpError(422, `no plan for these prices: ${(s.items ?? []).map((i) => i?.price?.id).join(", ")} (check PADDLE_PRICES)`);
    if (!s.customerId) throw new HttpError(422, "the subscription has no customer");
    const customer = await customerFor(env, s.customerId);
    try {
      const created = await createLicense(
        env,
        { customer, plan, expires: s.periodEnd ?? now() + 365 * 86400, graceDays: parseInt(env.GRACE_DAYS ?? "30", 10), subscriptionId: s.subscriptionId },
        "webhook",
      );
      await env.DB.prepare("UPDATE licenses SET checkout_txn = ?, billing_status = ?, paddle_at = ? WHERE id = ?")
        .bind(s.transactionId ?? null, s.status ?? "active", s.occurredAt, created.id)
        .run();
      lic = await getLicense(env, created.id);
      await sendKeyOnce(env, lic);
      return lic;
    } catch (e) {
      // Another webhook for the same subscription made it first (the unique index): update that one.
      lic = await env.DB.prepare("SELECT * FROM licenses WHERE subscription_id = ?").bind(s.subscriptionId).first();
      if (!lic) throw e;
    }
  }

  const set = [];
  const vals = [];
  const changes = {};
  if (s.periodEnd && (!lic.expires || s.periodEnd > lic.expires)) {
    set.push("expires = ?"), vals.push(s.periodEnd), (changes.expires = iso(s.periodEnd));
  }
  if (s.transactionId && !lic.checkout_txn) set.push("checkout_txn = ?"), vals.push(s.transactionId);
  if (s.occurredAt >= lic.paddle_at && s.status) {
    if (plan && plan !== lic.plan) {
      set.push("plan = ?", "max_screens = ?", "features = ?");
      vals.push(plan, PLANS[plan].maxScreens, JSON.stringify(PLANS[plan].features));
      changes.plan = `${lic.plan} -> ${plan}`;
    }
    if (s.status !== lic.billing_status) set.push("billing_status = ?"), vals.push(s.status), (changes.billing = `${lic.billing_status || "-"} -> ${s.status}`);
    set.push("paddle_at = ?"), vals.push(s.occurredAt);
  }
  if (set.length) {
    await env.DB.prepare(`UPDATE licenses SET ${set.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, now(), lic.id).run();
    if (Object.keys(changes).length) {
      const kind = changes.plan ? "plan-changed" : changes.expires ? "renewed" : s.status === "past_due" ? "payment-failed" : s.status === "canceled" || s.status === "canceling" ? "canceled" : "billing";
      await logEvent(env, lic.id, kind, changes, "webhook");
    }
  }
  return getLicense(env, lic.id);
}

export async function handleWebhook(request, env) {
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new HttpError(413, "too large");
  await verifySignature(env, request.headers.get("Paddle-Signature"), raw);
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "not JSON");
  }
  if (!ev?.event_id || !ev?.event_type) throw new HttpError(400, "not a Paddle event");
  if (await env.DB.prepare("SELECT id FROM paddle_events WHERE id = ?").bind(ev.event_id).first()) return { ok: true, duplicate: true };
  const occurredAt = toUnix(ev.occurred_at) ?? now();
  const d = ev.data ?? {};
  let license = null;

  if (ev.event_type.startsWith("subscription.")) {
    license = await applySubscription(env, {
      subscriptionId: d.id,
      customerId: d.customer_id,
      transactionId: d.transaction_id ?? null,
      items: d.items,
      periodEnd: toUnix(d.current_billing_period?.ends_at),
      status: billingStatus(d),
      occurredAt,
    });
  } else if (ev.event_type === "transaction.completed" && d.subscription_id) {
    license = await applySubscription(env, {
      subscriptionId: d.subscription_id,
      customerId: d.customer_id,
      transactionId: d.origin === "web" || !d.origin ? d.id : null,
      items: d.items,
      periodEnd: toUnix(d.billing_period?.ends_at),
      status: null, // a transaction says nothing about the subscription's status
      occurredAt,
    });
  } else if (ev.event_type === "customer.created" || ev.event_type === "customer.updated") {
    await onCustomer(env, d);
  }
  // Anything else (other transaction states, adjustments, ...) is acknowledged and left to the admin.

  await env.DB.prepare("INSERT OR IGNORE INTO paddle_events (id, type, occurred_at, received_at) VALUES (?, ?, ?, ?)").bind(ev.event_id, ev.event_type, occurredAt, now()).run();
  return { ok: true, license: license?.id ?? null };
}

// ---- after the checkout: the success page asks for the key ----
export async function purchase(env, txn) {
  if (!/^txn_[a-z0-9]{10,40}$/.test(String(txn ?? ""))) throw new HttpError(400, "that isn't a checkout reference");
  const lic = await env.DB.prepare("SELECT * FROM licenses WHERE checkout_txn = ?").bind(txn).first();
  if (!lic) return { ready: false };
  if (now() - lic.created_at > 7 * 86400) throw new HttpError(410, "this checkout is more than a week old: the key is in the email we sent");
  const customer = await env.DB.prepare("SELECT email FROM customers WHERE id = ?").bind(lic.customer_id).first();
  return {
    ready: true,
    key: lic.key,
    plan: lic.plan,
    maxScreens: lic.max_screens,
    expires: lic.expires ? iso(lic.expires) : null,
    email: /\.invalid$/i.test(customer?.email ?? "") ? null : customer?.email,
  };
}

// ---- links by email: billing portal and upgrades need the inbox, not only the key ----
// A token is base64url(JSON {p, l, plan?, exp}) + "." + HMAC-SHA256 with LINK_SECRET.
const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
function linkSecret(env) {
  if (!env.LINK_SECRET || env.LINK_SECRET.length < 32) throw new HttpError(503, "billing links aren't set up on this server yet (LINK_SECRET)");
  return env.LINK_SECRET;
}
export async function makeToken(env, claims, ttl = 3600) {
  const body = b64(JSON.stringify({ ...claims, exp: now() + ttl }));
  return `${body}.${await hmacHex(linkSecret(env), body)}`;
}
export async function readToken(env, token) {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac || !sameText(mac, await hmacHex(linkSecret(env), body))) throw new HttpError(403, "this link isn't valid: ask for a new one");
  const c = JSON.parse(unb64(body));
  if (!(c.exp > now())) throw new HttpError(403, "this link has expired (they last an hour): ask for a new one");
  return c;
}

const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, b, d) => a + "•".repeat(Math.min(b.length, 6)) + d);

// POST /v1/billing {key, action: "portal" | "upgrade", plan?}: emails the billing contact a link.
// Holding the key (which venue staff may) isn't enough to change what's paid.
export async function requestBillingLink(env, { key, action, plan }, origin) {
  const lic = await getLicenseByKey(env, key);
  if (!lic) throw new HttpError(404, "no license with that key: check it against the email you got");
  if (!lic.subscription_id) throw new HttpError(409, "this license isn't billed through the website: contact Blue Arc Networks");
  if (lic.status === "revoked") throw new HttpError(410, "this license has been revoked: contact Blue Arc Networks");
  if (action !== "portal" && action !== "upgrade") throw new HttpError(400, "action should be portal or upgrade");
  if (action === "upgrade") {
    if (!RANK[plan] || !prices(env)[plan]) throw new HttpError(400, `can't upgrade to '${plan}' here${plan === "enterprise" ? ": Enterprise is by quote, contact Blue Arc Networks" : ""}`);
    if (RANK[plan] <= (RANK[lic.plan] ?? 0)) throw new HttpError(409, `this license is already ${planName(lic.plan)}`);
  }
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(lic.customer_id).first();
  if (!customer || /\.invalid$/i.test(customer.email)) throw new HttpError(409, "we don't have the billing email for this license yet: try again in a few minutes");
  const recent = await env.DB.prepare("SELECT created_at FROM emails WHERE license_id = ? AND kind IN ('billing-link', 'upgrade-link') ORDER BY created_at DESC LIMIT 1")
    .bind(lic.id)
    .first();
  if (recent && now() - recent.created_at < 60) throw new HttpError(429, "a link was just sent: check the inbox (and spam) before asking again");
  const token = await makeToken(env, { p: action, l: lic.id, plan: action === "upgrade" ? plan : undefined });
  const url = `${origin}/billing/${action}?t=${token}`;
  const r = await sendEmail(env, {
    to: customer.email,
    kind: action === "upgrade" ? "upgrade-link" : "billing-link",
    licenseId: lic.id,
    subject: action === "upgrade" ? `Upgrade your Bluvu license to ${planName(plan)}` : "Your Bluvu billing",
    text: [
      action === "upgrade"
        ? `Someone asked to upgrade the Bluvu license ${lic.key.slice(0, 11)}… from ${planName(lic.plan)} to ${planName(plan)}. To see the price and confirm:`
        : `Here's the link to your Bluvu billing (payment method, receipts, cancelling) for ${lic.key.slice(0, 11)}…:`,
      "",
      url,
      "",
      "The link works for an hour. If you didn't ask for it, ignore this email: nothing changes.",
      "",
      "Bluvu, by Blue Arc Networks",
    ].join("\n"),
  });
  if (!r.recorded) throw new HttpError(503, `couldn't send the email (${r.error}): contact Blue Arc Networks`);
  return { sent: true, to: maskEmail(customer.email) };
}

// GET /billing/portal?t=...: a Paddle customer-portal session, then off to it.
export async function portalUrl(env, token) {
  const c = await readToken(env, token);
  if (c.p !== "portal") throw new HttpError(403, "this link isn't for billing");
  const lic = await getLicense(env, c.l);
  const customer = lic && (await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(lic.customer_id).first());
  if (!customer?.paddle_customer_id) throw new HttpError(409, "this license has no billing account");
  const s = await paddleApi(env, "POST", `/customers/${encodeURIComponent(customer.paddle_customer_id)}/portal-sessions`, { subscription_ids: [lic.subscription_id] });
  const url = s?.urls?.general?.overview;
  if (!url) throw new HttpError(502, "Paddle didn't return a portal link");
  return url;
}

// GET /billing/upgrade?t=... shows the price (Paddle's preview); POST confirms the plan change.
// Paddle charges the prorated difference now; the license follows through the webhook.
async function upgradeTarget(env, token) {
  const c = await readToken(env, token);
  if (c.p !== "upgrade" || !RANK[c.plan]) throw new HttpError(403, "this link isn't for an upgrade");
  const lic = await getLicense(env, c.l);
  if (!lic?.subscription_id) throw new HttpError(409, "this license isn't billed through the website");
  if (RANK[c.plan] <= (RANK[lic.plan] ?? 0)) throw new HttpError(409, `this license is already ${planName(lic.plan)}`);
  const priceId = prices(env)[c.plan];
  if (!priceId) throw new HttpError(503, `no price set up for ${planName(c.plan)}`);
  const body = { items: [{ price_id: priceId, quantity: 1 }], proration_billing_mode: "prorated_immediately" };
  return { lic, plan: c.plan, body };
}
export async function upgradePreview(env, token) {
  const { lic, plan, body } = await upgradeTarget(env, token);
  let total = null;
  try {
    const p = await paddleApi(env, "PATCH", `/subscriptions/${encodeURIComponent(lic.subscription_id)}/preview`, body);
    const t = p?.immediate_transaction?.details?.totals ?? p?.update_summary?.result;
    if (t) total = { amount: t.grand_total ?? t.amount, currency: t.currency_code };
  } catch (e) {
    if (e.status === 503) throw e;
  }
  return { from: lic.plan, to: plan, key: lic.key, total };
}
export async function upgradeConfirm(env, token) {
  const { lic, plan, body } = await upgradeTarget(env, token);
  await paddleApi(env, "PATCH", `/subscriptions/${encodeURIComponent(lic.subscription_id)}`, body);
  await logEvent(env, lic.id, "upgrade-requested", { to: plan }, "customer");
  return { from: lic.plan, to: plan };
}
