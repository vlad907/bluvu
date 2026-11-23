# Bluvu license server

Issues signed license files and handles activation, moves, trials and revocation for Bluvu media
servers. An admin view lets Blue Arc Networks see customers, licenses and machines, revoke, and issue
comp or Enterprise licenses by hand. Cloudflare Workers + D1. The plan and the file format are in
[docs/LICENSING_PLAN.md](../docs/LICENSING_PLAN.md).

**Not deployed yet.** Everything below "Deploying" needs the Cloudflare account, which only the owner
creates. Until then it runs locally with the published **test** key, which only test builds of the
engine accept.

## API

| | |
|---|---|
| `POST /v1/activate {key, machine, engine}` | The license file for this media server. Activating on another PC moves it there (3 moves a year; support can reset). |
| `POST /v1/refresh {licenseId, machine}` | A fresh file (renewals, upgrades, changes by hand). `410 {revoked}`, or `409 {moved}` if it's now on another PC. The engine calls it daily. |
| `POST /v1/deactivate {licenseId, machine}` | Releases this PC (Settings → License → Remove), so the next activation isn't a move. |
| `POST /v1/trial {machine, email?}` | A 14-day trial with Venue's features, once per machine (2 of 3 identifiers). |
| `POST /v1/offline {code, email?}` | The file for an offline request code. A code made with the key `TRIAL` starts a trial. |
| `GET /activate` | The offline activation page (paste the request code, download the file). |
| `/admin`, `/admin/api/...` | The admin view: list and search, edit plan / screens / expiry / grace, revoke and restore, release the media server, reset moves, make a file for a request code, issue by hand. History of every change. |

`machine` is the engine's hashed identifiers: `{machineGuid, smbiosUuid, systemDisk}`. Replies are JSON;
errors are `{error, ...}` with a status that says what happened.

## Locally

```bash
cd license-server
npm ci
cp .dev.vars.example .dev.vars        # the test key and a local admin token
npm run db:local
npm run dev                           # http://localhost:8787, admin at /admin
```

Point an engine (test build) at it: `MOSAIC_LICENSE_SERVER=http://127.0.0.1:8787`.

Tests: `npm test` (the API against a fresh local database, checking each file's signature), and from
`mosaic-engine/`, `python tools/license_server_check.py` (a real engine activating, refreshing, being
revoked, starting a trial, and the server being unreachable). CI runs both on Windows.

## Deploying (needs the owner)

Nothing here costs money on Cloudflare's free tier except a domain. Steps, in order:

1. **Account.** Create the Cloudflare account and add the domain (not chosen yet). Authorize the
   Cloudflare plugin in Claude Code (`/mcp`) if Claude should do the rest.
2. **Database.** `npx wrangler d1 create bluvu-license`, put its id in `wrangler.toml`, then
   `npx wrangler d1 migrations apply bluvu-license --remote`.
3. **The signing key** (once, on a trusted computer, never in the repository):
   `mosaic-engine/build/bluvu_license keygen bluvu-signing-key.txt`. It prints the public key.
   - Keep `bluvu-signing-key.txt` **offline** (a USB stick in a safe, and a second copy elsewhere). Anyone
     with it can make licenses; losing it means a new key and new engine builds.
   - `npx wrangler secret put SIGNING_SEED` and paste the 64 hex digits; `npx wrangler secret put
     SIGNING_KID` with a key id such as `2026-1`.
   - Add the public key and the key id to `trustedKeys()` in
     `mosaic-engine/engine/src/license/license.cpp`. Engines built from then on accept its licenses.
4. **Admin access.** In Cloudflare Zero Trust, an Access application for `license.<domain>/admin*` that
   lets in only your email. Set `ADMIN_EMAILS`, `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and
   `ACCESS_AUD` (the application's audience tag). The admin view checks Access's signed token itself, so
   the plain email header can't be forged.
5. **Deploy.** `npx wrangler deploy`, with a custom domain `license.<domain>`. Set `SITE_URL`, and in the
   engine `kServer` / `kSite` (`license.cpp`).
6. **The inside bar.** Issue a `comp` license in the admin view, and activate it on MEDIA-SERVER (online, or
   with a request code and **Make license file**). Only then can enforcement be switched on (phase 6).

Payments (Paddle webhooks that create and renew licenses) arrive in phase 4.
