// The admin view: customers, licenses, machines, revoke, issue a comp or Enterprise license by hand.
//
// Who gets in:
// - In production, Cloudflare Access protects /admin*: the request carries a signed JWT
//   (Cf-Access-Jwt-Assertion), checked here against the team's keys (ACCESS_TEAM_DOMAIN, ACCESS_AUD),
//   and its email must be in ADMIN_EMAILS. The plain email header alone is never trusted.
// - For local development and scripts, ADMIN_TOKEN (a secret) as "Authorization: Bearer <token>".

import {
  activate,
  activeMachine,
  createLicense,
  findOrCreateCustomer,
  getLicense,
  HttpError,
  iso,
  licenseFile,
  logEvent,
  movesThisYear,
  now,
  PLANS,
  readRequestCode,
  release,
  unb64url,
} from "./core.js";
import { adminPage } from "./admin_page.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---- authentication ----
let jwksCache = { at: 0, keys: [] };
async function accessKeys(env) {
  if (Date.now() - jwksCache.at < 3600_000 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  const { keys } = await r.json();
  jwksCache = { at: Date.now(), keys: keys ?? [] };
  return jwksCache.keys;
}

async function accessEmail(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, s] = token.split(".");
  if (!s) return null;
  const header = JSON.parse(new TextDecoder().decode(unb64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(unb64url(p)));
  const jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(s), new TextEncoder().encode(`${h}.${p}`));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || !(payload.exp > now())) return null;
  return String(payload.email ?? "").toLowerCase() || null;
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function adminActor(request, env) {
  const email = await accessEmail(request, env).catch(() => null);
  const allowed = String(env.ADMIN_EMAILS ?? "").toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
  if (email && allowed.includes(email)) return `admin:${email}`;
  const auth = request.headers.get("Authorization") ?? "";
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 && auth.startsWith("Bearer ") && sameSecret(auth.slice(7), env.ADMIN_TOKEN)) return "admin:token";
  return null;
}

// ---- views of the data ----
async function licenseRow(env, lic) {
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(lic.customer_id).first();
  const m = await activeMachine(env, lic.id);
  const t = now();
  const state =
    lic.status === "revoked" ? "revoked" : !lic.expires ? "valid" : t < lic.expires ? "valid" : t < lic.expires + lic.grace_days * 86400 ? "grace" : "expired";
  return {
    id: lic.id,
    key: lic.key,
    plan: lic.plan,
    maxScreens: lic.max_screens,
    features: JSON.parse(lic.features || "[]"),
    expires: lic.expires ? iso(lic.expires) : null,
    graceDays: lic.grace_days,
    status: lic.status,
    state,
    trial: !!lic.trial,
    notes: lic.notes,
    subscriptionId: lic.subscription_id,
    created: iso(lic.created_at),
    customer: customer && { id: customer.id, email: customer.email, name: customer.name },
    machine: m && { machineGuid: m.machine_guid, smbiosUuid: m.smbios_uuid, systemDisk: m.system_disk, activated: iso(m.activated_at), lastSeen: iso(m.last_seen), engine: m.engine },
  };
}

const parseExpires = (v) => {
  if (v === null || v === "" || v === undefined) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new HttpError(400, "expires should be a date (2027-11-22) or empty for never");
  return Math.floor(t / 1000);
};

async function body(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

// ---- routes ----
export async function handleAdmin(request, env, path) {
  if (path === "/admin" && request.method === "GET") return new Response(adminPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  if (!path.startsWith("/admin/api/")) throw new HttpError(404, "not found");
  const actor = await adminActor(request, env);
  if (!actor) throw new HttpError(401, "sign in through Cloudflare Access, or send the admin token");
  const m = request.method;
  const sub = path.slice("/admin/api".length);

  if (sub === "/me" && m === "GET") return json({ actor, plans: PLANS });

  if (sub === "/licenses" && m === "GET") {
    const q = `%${(new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase()}%`;
    const { results } = await env.DB.prepare(
      `SELECT l.* FROM licenses l JOIN customers c ON c.id = l.customer_id
       WHERE lower(c.email) LIKE ? OR lower(c.name) LIKE ? OR lower(l.key) LIKE ? OR l.id LIKE ? OR lower(l.notes) LIKE ?
       ORDER BY l.created_at DESC LIMIT 200`,
    )
      .bind(q, q, q, q, q)
      .all();
    return json({ licenses: await Promise.all(results.map((l) => licenseRow(env, l))) });
  }

  if (sub === "/licenses" && m === "POST") {
    const b = await body(request);
    const customer = await findOrCreateCustomer(env, b.email, String(b.name ?? ""));
    const plan = String(b.plan ?? "comp");
    const lic = await createLicense(
      env,
      {
        customer,
        plan,
        maxScreens: b.maxScreens === undefined || b.maxScreens === "" ? undefined : parseInt(b.maxScreens, 10),
        features: Array.isArray(b.features) ? b.features : undefined,
        expires: parseExpires(b.expires),
        graceDays: b.graceDays === undefined || b.graceDays === "" ? undefined : parseInt(b.graceDays, 10),
        notes: String(b.notes ?? ""),
      },
      actor,
    );
    return json({ license: await licenseRow(env, lic) }, 201);
  }

  const one = sub.match(/^\/licenses\/(lic_[a-z0-9]+)(?:\/([a-z-]+))?$/);
  if (one) {
    const lic = await getLicense(env, one[1]);
    if (!lic) throw new HttpError(404, "no such license");
    const action = one[2];
    if (!action && m === "GET") {
      const { results: machines } = await env.DB.prepare("SELECT * FROM machines WHERE license_id = ? ORDER BY id DESC").bind(lic.id).all();
      const { results: events } = await env.DB.prepare("SELECT * FROM events WHERE license_id = ? ORDER BY at DESC LIMIT 100").bind(lic.id).all();
      return json({
        license: await licenseRow(env, lic),
        movesThisYear: await movesThisYear(env, lic.id),
        machines: machines.map((r) => ({
          machineGuid: r.machine_guid,
          smbiosUuid: r.smbios_uuid,
          systemDisk: r.system_disk,
          activated: iso(r.activated_at),
          lastSeen: iso(r.last_seen),
          released: r.released_at ? iso(r.released_at) : null,
          engine: r.engine,
        })),
        events: events.map((e) => ({ kind: e.kind, detail: e.detail, actor: e.actor, at: iso(e.at) })),
      });
    }
    if (!action && m === "PATCH") {
      const b = await body(request);
      const set = [];
      const vals = [];
      if (b.plan !== undefined) {
        if (!PLANS[b.plan]) throw new HttpError(400, `unknown plan '${b.plan}'`);
        set.push("plan = ?"), vals.push(b.plan);
      }
      if (b.maxScreens !== undefined) set.push("max_screens = ?"), vals.push(parseInt(b.maxScreens, 10));
      if (b.features !== undefined) set.push("features = ?"), vals.push(JSON.stringify(b.features));
      if (b.expires !== undefined) set.push("expires = ?"), vals.push(parseExpires(b.expires));
      if (b.graceDays !== undefined) set.push("grace_days = ?"), vals.push(parseInt(b.graceDays, 10));
      if (b.notes !== undefined) set.push("notes = ?"), vals.push(String(b.notes));
      if (!set.length) throw new HttpError(400, "nothing to change");
      await env.DB.prepare(`UPDATE licenses SET ${set.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, now(), lic.id).run();
      await logEvent(env, lic.id, "changed", b, actor);
      return json({ license: await licenseRow(env, await getLicense(env, lic.id)) });
    }
    if (m === "POST" && (action === "revoke" || action === "restore")) {
      await env.DB.prepare("UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?").bind(action === "revoke" ? "revoked" : "active", now(), lic.id).run();
      await logEvent(env, lic.id, action === "revoke" ? "revoked" : "restored", "", actor);
      return json({ license: await licenseRow(env, await getLicense(env, lic.id)) });
    }
    if (m === "POST" && action === "release") {
      return json({ released: await release(env, lic, null, actor) });
    }
    if (m === "POST" && action === "reset-moves") {
      await logEvent(env, lic.id, "moves-reset", "", actor);
      return json({ movesThisYear: 0 });
    }
    // A license file by hand, for a request code (or for the machine it's on now).
    if (m === "POST" && action === "file") {
      const b = await body(request);
      if (b.code) {
        const r = readRequestCode(b.code);
        return json({ license: await activate(env, lic, r.machine, r.engine, actor) });
      }
      const cur = await activeMachine(env, lic.id);
      if (!cur) throw new HttpError(409, "not activated on any media server: give a request code");
      return json({ license: await licenseFile(env, lic, { machineGuid: cur.machine_guid, smbiosUuid: cur.smbios_uuid, systemDisk: cur.system_disk }) });
    }
  }
  throw new HttpError(404, "not found");
}
