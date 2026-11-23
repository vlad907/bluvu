// Licenses: signing, activation, moves, trials. Shared by the public API, the website pages and the
// admin view. See docs/LICENSING_PLAN.md for the file format the engine checks.

export const PLANS = {
  starter: { maxScreens: 8, features: [] },
  venue: { maxScreens: 32, features: ["multiCanvas", "audio", "capture"] },
  enterprise: { maxScreens: -1, features: ["multiCanvas", "audio", "capture"] },
  comp: { maxScreens: -1, features: ["multiCanvas", "audio", "capture"] },
  trial: { maxScreens: 32, features: ["multiCanvas", "audio", "capture"] },
};

export const now = () => Math.floor(Date.now() / 1000);
export const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---- encoding ----
export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(text) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

function randomId(prefix, n = 16) {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  return prefix + Array.from(r, (b) => alphabet[b % alphabet.length]).join("");
}
// What the customer types: no 0/O, 1/I/L to misread.
export function newKey() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const r = crypto.getRandomValues(new Uint8Array(20));
  const c = Array.from(r, (b) => alphabet[b % alphabet.length]).join("");
  return `BLUVU-${c.slice(0, 5)}-${c.slice(5, 10)}-${c.slice(10, 15)}-${c.slice(15, 20)}`;
}
export const normalizeKey = (k) => String(k ?? "").trim().toUpperCase().replace(/\s+/g, "");

// ---- signing (Ed25519; the private key is a 32-byte seed in the SIGNING_SEED secret) ----
let keyCache = null;
async function signingKey(env) {
  if (!env.SIGNING_SEED || !/^[0-9a-fA-F]{64}$/.test(env.SIGNING_SEED)) throw new HttpError(500, "the license server has no signing key (SIGNING_SEED)");
  if (keyCache?.seed === env.SIGNING_SEED) return keyCache.key;
  // PKCS#8 for an Ed25519 seed: a fixed prefix, then the 32 bytes.
  const prefix = hexBytes("302e020100300506032b657004220420");
  const der = new Uint8Array(48);
  der.set(prefix);
  der.set(hexBytes(env.SIGNING_SEED), 16);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  keyCache = { seed: env.SIGNING_SEED, key };
  return key;
}

export async function signPayload(env, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await signingKey(env), bytes));
  return JSON.stringify({ payload: b64url(bytes), sig: b64url(sig) }, null, 2) + "\n";
}

// ---- machines ----
export function cleanMachine(m) {
  const f = (v) => (typeof v === "string" ? v.slice(0, 128) : "");
  const machine = { machineGuid: f(m?.machineGuid), smbiosUuid: f(m?.smbiosUuid), systemDisk: f(m?.systemDisk) };
  if (!machine.machineGuid && !machine.smbiosUuid && !machine.systemDisk) throw new HttpError(400, "this PC's identity is missing (machine)");
  return machine;
}
const rowMachine = (r) => ({ machineGuid: r.machine_guid, smbiosUuid: r.smbios_uuid, systemDisk: r.system_disk });
// The engine's rule: at least min(2, how many the first one has) of the non-empty identifiers match.
export function sameMachine(a, b) {
  let have = 0, match = 0;
  for (const k of ["machineGuid", "smbiosUuid", "systemDisk"]) {
    if (!a[k]) continue;
    have++;
    if (a[k] === b[k]) match++;
  }
  return have > 0 && match >= Math.min(2, have);
}

// ---- the audit log ----
export async function logEvent(env, licenseId, kind, detail, actor) {
  await env.DB.prepare("INSERT INTO events (license_id, kind, detail, actor, at) VALUES (?, ?, ?, ?, ?)")
    .bind(licenseId, kind, typeof detail === "string" ? detail : JSON.stringify(detail), actor, now())
    .run();
}

// ---- customers and licenses ----
export async function findOrCreateCustomer(env, email, name = "") {
  email = String(email ?? "").trim();
  if (!email) throw new HttpError(400, "an email address is needed");
  const found = await env.DB.prepare("SELECT * FROM customers WHERE lower(email) = lower(?)").bind(email).first();
  if (found) {
    if (name && !found.name) await env.DB.prepare("UPDATE customers SET name = ? WHERE id = ?").bind(name, found.id).run();
    return { ...found, name: found.name || name };
  }
  const c = { id: randomId("cus_"), email, name, created_at: now() };
  await env.DB.prepare("INSERT INTO customers (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(c.id, c.email, c.name, c.created_at).run();
  return c;
}

export async function createLicense(env, { customer, plan, maxScreens, features, expires, graceDays, trial = false, notes = "", subscriptionId = null }, actor) {
  if (!PLANS[plan]) throw new HttpError(400, `unknown plan '${plan}'`);
  const t = now();
  const lic = {
    id: randomId("lic_"),
    key: newKey(),
    customer_id: customer.id,
    plan,
    max_screens: Number.isInteger(maxScreens) ? maxScreens : PLANS[plan].maxScreens,
    features: JSON.stringify(Array.isArray(features) ? features : PLANS[plan].features),
    expires: expires ?? null,
    grace_days: Number.isInteger(graceDays) ? graceDays : trial ? 0 : 30,
    trial: trial ? 1 : 0,
    subscription_id: subscriptionId,
    notes,
  };
  await env.DB.prepare(
    `INSERT INTO licenses (id, key, customer_id, plan, max_screens, features, expires, grace_days, status, trial, subscription_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  )
    .bind(lic.id, lic.key, lic.customer_id, lic.plan, lic.max_screens, lic.features, lic.expires, lic.grace_days, lic.trial, lic.subscription_id, lic.notes, t, t)
    .run();
  await logEvent(env, lic.id, "created", { plan, maxScreens: lic.max_screens, expires: lic.expires && iso(lic.expires) }, actor);
  return { ...lic, status: "active", created_at: t, updated_at: t };
}

export const getLicense = (env, id) => env.DB.prepare("SELECT * FROM licenses WHERE id = ?").bind(id).first();
export const getLicenseByKey = (env, key) => env.DB.prepare("SELECT * FROM licenses WHERE key = ?").bind(normalizeKey(key)).first();
export const activeMachine = (env, licenseId) =>
  env.DB.prepare("SELECT * FROM machines WHERE license_id = ? AND released_at IS NULL ORDER BY id DESC LIMIT 1").bind(licenseId).first();

// Moves this last year (since a support reset, if later).
export async function movesThisYear(env, licenseId) {
  const reset = await env.DB.prepare("SELECT max(at) AS at FROM events WHERE license_id = ? AND kind = 'moves-reset'").bind(licenseId).first();
  const since = Math.max(now() - 365 * 86400, reset?.at ?? 0);
  const r = await env.DB.prepare("SELECT count(*) AS n FROM events WHERE license_id = ? AND kind = 'moved' AND at > ?").bind(licenseId, since).first();
  return r?.n ?? 0;
}

// The signed license file for this license on this machine.
export async function licenseFile(env, lic, machine) {
  const customer = await env.DB.prepare("SELECT name, email FROM customers WHERE id = ?").bind(lic.customer_id).first();
  const payload = {
    v: 1,
    kid: env.SIGNING_KID || "test",
    licenseId: lic.id,
    customer: customer?.name || customer?.email || "",
    plan: lic.plan,
    maxScreens: lic.max_screens,
    features: JSON.parse(lic.features || "[]"),
    issuedAt: iso(now()),
    expires: lic.expires ? iso(lic.expires) : null,
    graceDays: lic.grace_days,
    updatesUntil: lic.expires ? iso(lic.expires) : "",
    machine,
    trial: !!lic.trial,
    // A paid subscription that renews by itself: the editor says "renews on" instead of asking to renew.
    renews: !!lic.subscription_id && (lic.billing_status === "active" || lic.billing_status === "trialing"),
  };
  return signPayload(env, payload);
}

// Activates (or refreshes) a license on a machine, moving it from another one within the yearly
// limit. Returns the license file.
export async function activate(env, lic, machine, engine, actor) {
  if (!lic) throw new HttpError(404, "no license with that key: check it against the email you got");
  if (lic.status === "revoked") throw new HttpError(410, "this license has been revoked: contact Blue Arc Networks", { revoked: true });
  const t = now();
  const cur = await activeMachine(env, lic.id);
  if (cur && sameMachine(rowMachine(cur), machine)) {
    // The same PC (perhaps one part changed): keep it, with its identifiers as they are now.
    await env.DB.prepare("UPDATE machines SET machine_guid = ?, smbios_uuid = ?, system_disk = ?, last_seen = ?, engine = ? WHERE id = ?")
      .bind(machine.machineGuid, machine.smbiosUuid, machine.systemDisk, t, String(engine ?? "").slice(0, 32), cur.id)
      .run();
  } else {
    if (cur) {
      const limit = parseInt(env.MOVES_PER_YEAR ?? "3", 10);
      const moves = await movesThisYear(env, lic.id);
      if (moves >= limit)
        throw new HttpError(409, `this license has moved to another media server ${moves} times this year (the limit is ${limit}): contact Blue Arc Networks to move it again`, {
          moveLimit: true,
        });
      await env.DB.prepare("UPDATE machines SET released_at = ? WHERE id = ?").bind(t, cur.id).run();
    }
    await env.DB.prepare("INSERT INTO machines (license_id, machine_guid, smbios_uuid, system_disk, activated_at, last_seen, engine) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(lic.id, machine.machineGuid, machine.smbiosUuid, machine.systemDisk, t, t, String(engine ?? "").slice(0, 32))
      .run();
    await logEvent(env, lic.id, cur ? "moved" : "activated", { machine }, actor);
  }
  return licenseFile(env, lic, machine);
}

// A fresh file for the machine the license is on (after a renewal, an upgrade, a change by hand).
export async function refresh(env, lic, machine, engine) {
  if (!lic) throw new HttpError(404, "no such license");
  if (lic.status === "revoked") throw new HttpError(410, "this license has been revoked", { revoked: true });
  const cur = await activeMachine(env, lic.id);
  if (!cur || !sameMachine(rowMachine(cur), machine))
    throw new HttpError(409, "this license is now on another media server: activate it again here to move it", { moved: true });
  await env.DB.prepare("UPDATE machines SET last_seen = ?, engine = ? WHERE id = ?").bind(now(), String(engine ?? "").slice(0, 32), cur.id).run();
  return licenseFile(env, lic, machine);
}

export async function release(env, lic, machine, actor) {
  const cur = await activeMachine(env, lic.id);
  if (!cur) return false;
  if (machine && !sameMachine(rowMachine(cur), machine)) throw new HttpError(409, "this license isn't on this media server");
  await env.DB.prepare("UPDATE machines SET released_at = ? WHERE id = ?").bind(now(), cur.id).run();
  await logEvent(env, lic.id, "released", { machine: rowMachine(cur) }, actor);
  return true;
}

// A 14-day trial with Venue's features, once per machine.
export async function startTrial(env, machine, email, engine) {
  const { results } = await env.DB.prepare("SELECT * FROM trials").all();
  if (results.some((r) => sameMachine(rowMachine(r), machine) || sameMachine(machine, rowMachine(r))))
    throw new HttpError(409, "this media server has had its trial: buy a license to keep editing", { trialUsed: true });
  const days = parseInt(env.TRIAL_DAYS ?? "14", 10);
  const customer = await findOrCreateCustomer(env, email || `trial-${crypto.randomUUID()}@trial.invalid`, "");
  const lic = await createLicense(env, { customer, plan: "trial", trial: true, expires: now() + days * 86400, graceDays: 0 }, "engine");
  await env.DB.prepare("INSERT INTO trials (license_id, machine_guid, smbios_uuid, system_disk, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(lic.id, machine.machineGuid, machine.smbiosUuid, machine.systemDisk, now())
    .run();
  return activate(env, lic, machine, engine, "engine");
}

// An offline request code (Settings → License → Get request code): base64url JSON {v, key, machine}.
export function readRequestCode(code) {
  let r;
  try {
    r = JSON.parse(new TextDecoder().decode(unb64url(String(code ?? "").trim())));
  } catch {
    throw new HttpError(400, "that isn't a request code: copy the whole code from Settings → License");
  }
  if (!r || typeof r !== "object" || !r.key || !r.machine) throw new HttpError(400, "that isn't a request code: copy the whole code from Settings → License");
  return { key: normalizeKey(r.key), machine: cleanMachine(r.machine), engine: r.engine ?? "" };
}
