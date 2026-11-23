// Starts `wrangler dev` on an empty local database with the published test key, for the tests.
import { spawn, execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
export const ADMIN = "test-admin-token-0123456789";
// The published test key (mosaic-engine/tools/license-test-key.txt).
export const SEED = createHash("sha512").update("bluvu-license-test-key: published, never trust in a venue build").digest().subarray(0, 32);
export const TEST_PUBLIC_KEY = "de7a9c609cbaca3b3766692fc2ebeca0c3093be28e4d18508ce5b1e93bf46136";

// vars: extra KEY=value lines for the worker. Returns {base, stop}.
export async function startServer(vars = {}) {
  const port = 8790 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "bluvu-license-test-"));
  const all = { SIGNING_SEED: SEED.toString("hex"), SIGNING_KID: "test", ADMIN_TOKEN: ADMIN, ...vars };
  const file = join(dir, "test.vars");
  writeFileSync(file, Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const persist = join(dir, "state");
  const shell = process.platform === "win32";
  execFileSync(wrangler, ["d1", "migrations", "apply", "bluvu-license", "--local", "--persist-to", persist], { cwd: root, stdio: "ignore", shell });
  const server = spawn(wrangler, ["dev", "--local", "--port", String(port), "--persist-to", persist, "--env-file", file], { cwd: root, stdio: "ignore", shell });
  const stop = () => {
    // On Windows wrangler runs under a shell and its workerd child outlives a plain kill.
    if (process.platform === "win32" && server.pid) {
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { stdio: "ignore" });
      } catch {}
    }
    server.kill();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (i === 119) {
      stop();
      throw new Error("wrangler dev didn't start");
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const post = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const admin = async (method, path, body) => {
    const r = await fetch(base + "/admin/api" + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  return { base, stop, post, admin };
}

// Opens a license file like the engine: the signature over the payload's bytes, with the test key.
export function openLicense(fileText) {
  const f = JSON.parse(fileText);
  const bytes = Buffer.from(f.payload, "base64url");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(TEST_PUBLIC_KEY, "hex")]), format: "der", type: "spki" });
  assert.ok(verify(null, bytes, key, Buffer.from(f.sig, "base64url")), "signature verifies with the test public key");
  return JSON.parse(bytes.toString());
}
