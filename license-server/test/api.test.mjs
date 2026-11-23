// The license server's API, end to end: starts `wrangler dev` on an empty local database with the
// published test key, then activates, refreshes, moves, revokes, runs trials and offline codes, and
// checks every license file's Ed25519 signature the way the engine does.
//
//   npm test            (needs `npm ci` once)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, openLicense as open } from "./harness.mjs";

let srv, BASE, post, admin;
before(async () => {
  srv = await startServer({ MOVES_PER_YEAR: 2 });
  ({ base: BASE, post, admin } = srv);
});
after(() => srv?.stop());

const PC1 = { machineGuid: "g1", smbiosUuid: "u1", systemDisk: "d1" };
const PC2 = { machineGuid: "g2", smbiosUuid: "u2", systemDisk: "d2" };
const PC3 = { machineGuid: "g3", smbiosUuid: "u3", systemDisk: "d3" };
const PC4 = { machineGuid: "g4", smbiosUuid: "u4", systemDisk: "d4" };

let lic;

test("admin needs the token", async () => {
  const r = await fetch(`${BASE}/admin/api/licenses`);
  assert.equal(r.status, 401);
  const forged = await fetch(`${BASE}/admin/api/licenses`, { headers: { "Cf-Access-Authenticated-User-Email": "someone@example.com" } });
  assert.equal(forged.status, 401, "the plain Access email header alone isn't trusted");
});

test("admin issues a Venue license", async () => {
  const r = await admin("POST", "/licenses", { email: "owner@venue.test", name: "Test Venue", plan: "venue", expires: "2099-01-01" });
  assert.equal(r.status, 201);
  lic = r.body.license;
  assert.match(lic.key, /^BLUVU-[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/);
  assert.equal(lic.maxScreens, 32);
  assert.deepEqual(lic.features, ["multiCanvas", "audio", "capture"]);
});

test("activate with the key gives a signed file bound to the PC", async () => {
  const r = await post("/v1/activate", { key: lic.key.toLowerCase(), machine: PC1, engine: "0.1.0" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = open(r.body.license);
  assert.equal(p.v, 1);
  assert.equal(p.kid, "test");
  assert.equal(p.licenseId, lic.id);
  assert.equal(p.plan, "venue");
  assert.equal(p.maxScreens, 32);
  assert.equal(p.customer, "Test Venue");
  assert.equal(p.expires, "2099-01-01T00:00:00Z");
  assert.deepEqual(p.machine, PC1);
});

test("a wrong key is refused", async () => {
  const r = await post("/v1/activate", { key: "BLUVU-AAAAA-BBBBB-CCCCC-DDDDD", machine: PC1 });
  assert.equal(r.status, 404);
});

test("the same PC with a new disk is the same PC (no move)", async () => {
  const r = await post("/v1/activate", { key: lic.key, machine: { ...PC1, systemDisk: "new-disk" } });
  assert.equal(r.status, 200);
  const d = await admin("GET", `/licenses/${lic.id}`);
  assert.equal(d.body.movesThisYear, 0);
  assert.equal(d.body.machines.filter((m) => !m.released).length, 1);
  PC1.systemDisk = "new-disk";
});

test("refresh picks up a change made by hand", async () => {
  await admin("PATCH", `/licenses/${lic.id}`, { maxScreens: 40 });
  const r = await post("/v1/refresh", { licenseId: lic.id, machine: PC1 });
  assert.equal(r.status, 200);
  assert.equal(open(r.body.license).maxScreens, 40);
});

test("moving to another PC: allowed up to the yearly limit, the old PC can't refresh", async () => {
  let r = await post("/v1/activate", { key: lic.key, machine: PC2 });
  assert.equal(r.status, 200);
  assert.deepEqual(open(r.body.license).machine, PC2);
  r = await post("/v1/refresh", { licenseId: lic.id, machine: PC1 });
  assert.equal(r.status, 409);
  assert.equal(r.body.moved, true);
  r = await post("/v1/activate", { key: lic.key, machine: PC3 });
  assert.equal(r.status, 200, "second move (limit 2 in this test)");
  r = await post("/v1/activate", { key: lic.key, machine: PC4 });
  assert.equal(r.status, 409);
  assert.equal(r.body.moveLimit, true);
  await admin("POST", `/licenses/${lic.id}/reset-moves`);
  r = await post("/v1/activate", { key: lic.key, machine: PC4 });
  assert.equal(r.status, 200, "after support resets the moves");
});

test("deactivate releases the PC, then activating elsewhere isn't a move", async () => {
  let r = await post("/v1/deactivate", { licenseId: lic.id, machine: PC4 });
  assert.equal(r.status, 200);
  assert.equal(r.body.released, true);
  const before = (await admin("GET", `/licenses/${lic.id}`)).body.movesThisYear;
  r = await post("/v1/activate", { key: lic.key, machine: PC1 });
  assert.equal(r.status, 200);
  assert.equal((await admin("GET", `/licenses/${lic.id}`)).body.movesThisYear, before);
});

test("revoked: refresh says so, activation is refused; restore brings it back", async () => {
  await admin("POST", `/licenses/${lic.id}/revoke`);
  let r = await post("/v1/refresh", { licenseId: lic.id, machine: PC1 });
  assert.equal(r.status, 410);
  assert.equal(r.body.revoked, true);
  r = await post("/v1/activate", { key: lic.key, machine: PC1 });
  assert.equal(r.status, 410);
  await admin("POST", `/licenses/${lic.id}/restore`);
  r = await post("/v1/refresh", { licenseId: lic.id, machine: PC1 });
  assert.equal(r.status, 200);
});

test("offline: a request code gives the same file", async () => {
  const code = Buffer.from(JSON.stringify({ v: 1, key: lic.key, machine: PC1, engine: "0.1.0" })).toString("base64url");
  const r = await post("/v1/offline", { code });
  assert.equal(r.status, 200);
  assert.deepEqual(open(r.body.license).machine, PC1);
  const bad = await post("/v1/offline", { code: "not a code" });
  assert.equal(bad.status, 400);
});

test("trial: 14 days, Venue features, once per PC (2 of 3 identifiers)", async () => {
  const pc = { machineGuid: "tg", smbiosUuid: "tu", systemDisk: "td" };
  let r = await post("/v1/trial", { machine: pc, email: "try@venue.test" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = open(r.body.license);
  assert.equal(p.trial, true);
  assert.equal(p.graceDays, 0);
  assert.equal(p.maxScreens, 32);
  const days = (Date.parse(p.expires) - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days <= 14, `expires in ${days} days`);
  r = await post("/v1/trial", { machine: { ...pc, machineGuid: "reinstalled" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.trialUsed, true);
  const code = Buffer.from(JSON.stringify({ v: 1, key: "TRIAL", machine: { machineGuid: "og", smbiosUuid: "ou", systemDisk: "od" } })).toString("base64url");
  r = await post("/v1/offline", { code, email: "offline@venue.test" });
  assert.equal(r.status, 200, "an offline trial through a request code");
  assert.equal(open(r.body.license).trial, true);
});

test("a comp license by hand never expires; a file for a request code by hand", async () => {
  const r = await admin("POST", "/licenses", { email: "bar@inside.test", name: "The Inside Bar", plan: "comp" });
  assert.equal(r.status, 201);
  assert.equal(r.body.license.expires, null);
  assert.equal(r.body.license.maxScreens, -1);
  const code = Buffer.from(JSON.stringify({ v: 1, key: r.body.license.key, machine: PC2 })).toString("base64url");
  const f = await admin("POST", `/licenses/${r.body.license.id}/file`, { code });
  assert.equal(f.status, 200);
  const p = open(f.body.license);
  assert.equal(p.expires, null);
  assert.equal(p.plan, "comp");
  assert.deepEqual(p.machine, PC2);
});

test("search and the history", async () => {
  const s = await admin("GET", "/licenses?q=inside");
  assert.equal(s.body.licenses.length, 1);
  const d = await admin("GET", `/licenses/${lic.id}`);
  const kinds = d.body.events.map((e) => e.kind);
  for (const k of ["created", "activated", "moved", "revoked", "restored", "released", "changed", "moves-reset"]) assert.ok(kinds.includes(k), `history has '${k}'`);
});

test("bad requests get clear errors", async () => {
  let r = await post("/v1/activate", { key: lic.key });
  assert.equal(r.status, 400);
  r = await fetch(`${BASE}/v1/activate`, { method: "POST", body: "not json" });
  assert.equal(r.status, 400);
  r = await fetch(`${BASE}/nope`);
  assert.equal(r.status, 404);
  const page = await fetch(`${BASE}/activate`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Activate Bluvu offline/);
});
