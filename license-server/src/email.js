// Emails: every one is written to the `emails` table first (the admin view shows them and can send a
// key again), then sent through Cloudflare Email Service when the EMAIL binding is set up (needs the
// domain onboarded; see README.md). Without it, nothing leaves the server: the row says why.
// EMAIL_OUTBOX_ONLY=1 (development and tests) treats a recorded email as good enough to go on.

import { iso, logEvent, now } from "./core.js";

export async function sendEmail(env, { to, kind, subject, text, licenseId = null }) {
  const t = now();
  const row = await env.DB.prepare("INSERT INTO emails (license_id, to_addr, kind, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(licenseId, to, kind, subject, text, t)
    .first();
  let error = "";
  if (/\.invalid$/i.test(to)) error = "no address for this customer yet";
  else if (!env.EMAIL?.send)
    error = env.EMAIL_OUTBOX_ONLY === "1" ? "development: recorded only (EMAIL_OUTBOX_ONLY)" : "no email service set up (the EMAIL binding): not sent";
  else {
    try {
      await env.EMAIL.send({ to, from: { email: env.EMAIL_FROM || "licenses@bluvu.example", name: "Bluvu" }, subject, text });
    } catch (e) {
      error = `the email service refused it: ${e?.message ?? e}`;
    }
  }
  await env.DB.prepare("UPDATE emails SET sent_at = ?, error = ? WHERE id = ?").bind(error ? null : now(), error, row.id).run();
  if (licenseId) await logEvent(env, licenseId, error ? "email-failed" : "emailed", { kind, to, error: error || undefined }, "server");
  // "recorded": good enough to go on with in development, where nothing is ever sent.
  return { sent: !error, recorded: !error || env.EMAIL_OUTBOX_ONLY === "1", error };
}

const planNames = { starter: "Starter", venue: "Venue", enterprise: "Enterprise", comp: "Complimentary", trial: "Trial" };
export const planName = (p) => planNames[p] ?? p;

// The license key, after a purchase (or sent again from the admin view).
export function keyEmail(env, lic, customer) {
  const server = (env.SERVER_URL || "https://license.bluvu.example").replace(/\/$/, "");
  return {
    to: customer.email,
    kind: "key",
    licenseId: lic.id,
    subject: `Your Bluvu ${planName(lic.plan)} license key`,
    text: [
      `Thank you${customer.name ? `, ${customer.name}` : ""}. Your Bluvu ${planName(lic.plan)} license key:`,
      "",
      `    ${lic.key}`,
      "",
      "To activate it, open the editor on your media server, go to Settings → License, paste the key and",
      "choose Activate online. A media server without internet: choose Get request code instead and follow",
      `the steps at ${server}/activate.`,
      "",
      lic.expires ? `It renews every year; this period runs until ${iso(lic.expires).slice(0, 10)}.` : "It doesn't expire.",
      `Billing, receipts, upgrading or cancelling: ${server}/billing`,
      "",
      "Bluvu, by Blue Arc Networks",
    ].join("\n"),
  };
}

// Sends the key once per license, when the customer's address is known.
export async function sendKeyOnce(env, lic) {
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(lic.customer_id).first();
  if (!customer || /\.invalid$/i.test(customer.email)) return false;
  const done = await env.DB.prepare("SELECT id FROM emails WHERE license_id = ? AND kind = 'key' LIMIT 1").bind(lic.id).first();
  if (done) return false;
  await sendEmail(env, keyEmail(env, lic, customer));
  return true;
}
