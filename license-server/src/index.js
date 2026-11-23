// Bluvu license server (Cloudflare Worker). Routes:
//
//   POST /v1/activate    {key, machine, engine}        -> license file (activates, or moves within the limit)
//   POST /v1/refresh     {licenseId, machine, engine}  -> license file (410 revoked, 409 moved away)
//   POST /v1/deactivate  {licenseId, machine}          -> releases this machine (to move the license)
//   POST /v1/trial       {machine, email?, engine}     -> a 14-day trial license file, once per machine
//   POST /v1/offline     {code}                        -> license file for an offline request code
//                                                         (key "TRIAL" in the code starts a trial)
//   GET  /activate                                     -> the offline activation page
//   GET  /health
//   /admin, /admin/api/*                               -> the admin view (admin.js)
//
// The engine and the website talk JSON. Errors: {error, ...} with a status that says what happened.

import { activate, cleanMachine, getLicense, getLicenseByKey, HttpError, readRequestCode, refresh, release, startTrial } from "./core.js";
import { handleAdmin } from "./admin.js";
import { activatePage } from "./pages.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

async function body(request) {
  if (request.headers.get("Content-Length") > 65536) throw new HttpError(413, "too large");
  try {
    const b = await request.json();
    if (!b || typeof b !== "object") throw new Error();
    return b;
  } catch {
    throw new HttpError(400, "the request body should be JSON");
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/health") return json({ ok: true });
  if (path === "/activate" && method === "GET") return new Response(activatePage(env), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(request, env, path);

  if (method === "POST" && path.startsWith("/v1/")) {
    const b = await body(request);
    const file = (text) => json({ license: text });
    switch (path) {
      case "/v1/activate":
        return file(await activate(env, await getLicenseByKey(env, b.key), cleanMachine(b.machine), b.engine, "engine"));
      case "/v1/refresh":
        return file(await refresh(env, await getLicense(env, String(b.licenseId ?? "")), cleanMachine(b.machine), b.engine));
      case "/v1/deactivate": {
        const lic = await getLicense(env, String(b.licenseId ?? ""));
        if (!lic) throw new HttpError(404, "no such license");
        return json({ released: await release(env, lic, cleanMachine(b.machine), "engine") });
      }
      case "/v1/trial":
        return file(await startTrial(env, cleanMachine(b.machine), typeof b.email === "string" ? b.email : "", b.engine));
      case "/v1/offline": {
        const r = readRequestCode(b.code);
        if (r.key === "TRIAL") return file(await startTrial(env, r.machine, typeof b.email === "string" ? b.email : "", r.engine));
        return file(await activate(env, await getLicenseByKey(env, r.key), r.machine, r.engine, "website"));
      }
    }
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: "the license server had a problem; try again in a minute" }, 500);
    }
  },
};
