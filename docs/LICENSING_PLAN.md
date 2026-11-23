# Bluvu licensing and sales: plan

Status: **agreed 2026-11-22** (the recommendations below were accepted as they stand). Each phase is
built one at a time on a branch, in test mode. Nothing that costs money or takes real payments starts
without asking.

## Decisions

| Question | Decision |
|---|---|
| Payment provider | **Paddle** (merchant of record), sandbox first |
| What's a screen | Enabled outputs; a cut into cells on a receiving PC counts **each cell** (2×2 = 4) |
| Trial | **14 days**, full Venue features, once per machine, started by an online activation (an offline install can ask for a trial file the same way as a license) |
| Grace period | **30 days** after expiry |
| Hosting | **Cloudflare Workers + D1 + R2**, the site on Cloudflare Pages (account and plugin authorization are yours) |
| Domain | **Not chosen yet.** Code uses `license.bluvu.example` as a placeholder until you pick one |
| Distribution | §1 as written: proprietary LICENSE now, signed release bundles, update channel through the media server, move PCs by one last git update, then repos private |
| Code signing | **Our own Ed25519 signature only for now**; an Authenticode certificate later, when it's worth paying for |
| What locks when lapsed | **Only changing the setup**; day-to-day operation (presets, scenes, show stream, blank, Companion) keeps working |
| Moves | **3 a year**, self-service |

The brief is [prompts/licensing-and-sales.md](../prompts/licensing-and-sales.md).

## The rule over everything else

Licensing never blacks out a wall. It may lock **changing the setup**, **updates** and **adding
screens**. It never stops what's playing, and never stops a restart from coming back up with the saved
layout. That holds when the license server is down, the venue is offline, the license has expired, a
check fails, or the license file is corrupt. In code, that means:

- Saved layouts and canvases load at startup **without** any license check.
- The license is checked in exactly one place on the request path (the engine's pre-routing handler
  in `http_api.cpp`, which already gates changes for the PIN / API key) and in one function that counts
  screens. The render threads, NDI senders, display outputs and receivers never look at it.
- Any exception or parse error in licensing code falls to "can't verify": editing locked, walls on.

## 1. Distribution: the code is public

Today every PC `git clone`s the public repo and the media server builds from source, so a license
check could just be deleted. Proposal:

| Step | What | Why |
|---|---|---|
| A. Now | Add a proprietary `LICENSE` ("all rights reserved, use only under the Bluvu EULA") and a draft `EULA.md`. | The code is public with no license. Strictly that already means "all rights reserved", but saying so stops anyone assuming it's open source. It changes nothing on any PC. Code already published can't be unpublished (clones and forks may exist). |
| B. | CI builds **versioned release bundles** on `windows-2022`: `mosaic_engine.exe`, `mosaic_receiver.exe`, `ui/dist`, `videowall.py` and the scripts, with the NDI runtime DLL. A `manifest.json` lists each file's SHA-256 and is signed with a **release Ed25519 key** (a different key from the license key, kept as a CI secret). Optionally Authenticode-signed too (costs money; later). | Media servers stop needing Visual Studio, CMake and Node. The engine and receivers verify the signature before running an update. |
| C. | **Update channel**: the media server asks the license server for the latest release (sending its license), downloads the bundle, checks the signature, unpacks it to `releases/<version>/`, and switches over with the previous version kept for rollback (and rolls back by itself if the new engine doesn't answer `/api/health` within a minute). Receivers get the bundle **from the media server**, the way they already get the Mosaic Receiver (`/api/receiver/package`). An offline venue uploads a release file in the editor; same check. | Updates only for current licenses; no GitHub access needed on site; venue PCs never need credentials. |
| D. | **Move the installed PCs over without anyone on site**: one last git-based update (through *Update everything*) brings the new updater. `update.ps1` then sees the channel config and switches that PC from `git pull` to releases. The editor shows each PC's channel and version. | Existing PCs only know how to `git pull` from the public repo, so the repo must stay public until every PC has moved. |
| E. | Once the inside bar (and any other known install) reports the release channel, **make both repos private**. | After this, new code is only seen as signed binaries. |

The dashboard (`videowall.py`) stays plain Python in the bundle: receivers are free and carry no
license check, so it doesn't matter that it's readable. A binary check can still be patched by someone
determined; the goal is keeping honest customers honest and making it more than deleting a line.

## 2. The license

**What the customer types:** a license key, `BLUVU-XXXXX-XXXXX-XXXXX-XXXXX` (random, not secret
in itself, useless without activation).

**What the engine stores:** a signed license file, `data/license.json`:

```json
{
  "payload": {
    "v": 1, "kid": "2026-1",
    "licenseId": "lic_...", "customer": "The Inside Bar",
    "plan": "venue", "maxScreens": 32,
    "features": ["multiCanvas", "audio", "capture"],
    "issuedAt": "2026-11-22T00:00:00Z",
    "expires": "2027-11-22T00:00:00Z",
    "graceDays": 30,
    "updatesUntil": "2027-11-22T00:00:00Z",
    "machine": {"machineGuid": "h1", "smbiosUuid": "h2", "systemDisk": "h3"},
    "trial": false
  },
  "sig": "base64url Ed25519 signature over the canonical payload"
}
```

- Verified locally with the **public key compiled into the engine** (Monocypher, a small public-domain
  C library, works on Windows and macOS). `kid` allows a key change later. The private key lives only in
  the license server's secret store, with your offline backup.
- **Comp / perpetual**: `expires: null` (the inside bar's free license).
- **Machine binding:** hashes of three identifiers: Windows `MachineGuid` (survives Windows updates),
  the SMBIOS system UUID (the motherboard's), and the system disk's serial. **Any 2 of 3** must match,
  so a GPU or NIC swap changes nothing, a disk swap or reinstall still passes, and a whole new PC is
  a move.
- **Moving to a new PC:** self-service in the editor or the account page: activate on the new PC, the
  old one is released. Limit 3 moves a year (support can reset it). An old PC that's offline keeps its
  file until that file's own expiry, which is fine: it's one license term at most.
- **Online:** the engine refreshes once a day when it can reach the server (new file after a renewal,
  revoked, moved). Never required while the file is valid.
- **Offline activation:** Settings → License shows a **request code** (key + fingerprint, base64);
  paste it on the website's "Activate offline" page, download the license file, upload it in the
  editor.
- **Clock set back:** the engine keeps the latest time it has seen (file times included). A clock more
  than 2 days behind that counts as "can't verify": editing locked, walls on, message says to fix the
  clock.

## 3. States and what each locks

| State | When | Walls / restarts | Day-to-day operation* | Changing the setup | Adding screens | Updates | Editor shows |
|---|---|---|---|---|---|---|---|
| `trial` | activated trial, 14 days | on | yes | yes | up to Venue | yes | "Trial: N days left" |
| `valid` | signed, unexpired | on | yes | yes | up to plan | yes | nothing |
| `expiring` | within 30 days of expiry | on | yes | yes | up to plan | yes | quiet banner, renew link |
| `grace` | past expiry, within the 30-day grace | on | yes | yes | up to plan | yes | stronger banner |
| `expired` | past grace | **on** | yes | locked | locked | locked | "Renew to edit"; Settings → License open |
| `none` / `invalid` | trial over and no license, tampered file, wrong machine, clock back | **on** | yes | locked | locked | locked | reason, how to fix |

\* Day-to-day operation = recalling presets and scenes, "show this stream on this group", blank and
identify, restarting a source. Companion buttons and the control API use these at showtime, so they never lock.

- Settings → License, the PIN/API-key settings, `GET` requests and receiver check-ins always work.
- **Over the limit** (a downgrade, or a layout imported from a bigger server): everything keeps
  running; only adding or enabling more is refused, with "Starter allows 8 screens; this would be 9.
  Upgrade".
- `GET /api/license` returns plan, state, screens used / allowed, expiry, grace end, days left, the
  reason for `invalid`, and the request code.

## 4. What counts as a screen

Counted by one function over **all running canvases**:

- each **enabled output** (NDI or display) counts 1, **except**
- an output that a receiving PC cuts into cells (`partCols` × `partRows` on its endpoint slots) counts
  as **the number of cells shown**, so a 2×2 cut from one stream counts **4**.

Reason: "screens" is the word on the site and what a customer counts on the wall; the 2×2-from-one-
stream trick is a quality feature (frames can't drift), not a way to get 4 screens for 1. It's still
enforceable inside the engine, because the engine holds the endpoint assignments. The inside bar counts
4 + 10 = **14** that way (11 if outputs only); it gets a comp license either way.

The alternative is counting outputs (streams) only: simpler, matches the capacity table, but a Starter
plan could drive 8 × 9 = 72 screens through 3×3 cuts.

## 5. License server

**Recommendation: Cloudflare Workers + D1 (SQLite) + R2 (release bundles)**, with the signing key as a
Workers secret and the admin view behind Cloudflare Access (only your email gets in). Low cost (free
tier, then about $5 a month), no server to patch, and the static site can live on Cloudflare Pages in
the same account. The repo already has the Cloudflare tooling; its plugin needs authorizing (`/mcp`)
before I can use it, and creating the account is yours.

The simple alternative is a small VPS (Hetzner, Fly) running Python + SQLite: easier to reason about,
but it's a machine to keep patched and backed up.

Endpoints: `POST /activate`, `POST /refresh`, `POST /deactivate`, `POST /offline` (request code →
file), `GET /releases/latest`, `GET /releases/:v` (license-checked, signed URL to R2), `POST
/webhooks/payments`, `GET /account` (magic-link email login: see keys, machines, move, billing portal).
Admin: customers, licenses, machines, revoke, issue comp or Enterprise by hand, resend key, audit log.
Key emails go out through Cloudflare Email Service or Postmark.

## 6. Payments

| | Stripe (Checkout + Billing) | Paddle (merchant of record) |
|---|---|---|
| Sales tax / VAT | **You** register, collect and file (Stripe Tax helps calculate, for an extra fee). Software is taxable in many US states. | Paddle is the seller: it collects and remits worldwide. |
| Fees (approximate, check current pricing) | about 2.9% + 30¢, plus Billing about 0.7%, plus Tax about 0.5% | about 5% + 50¢, all in |
| Yearly auto-renew, proration on upgrade, dunning, receipts, customer portal, webhooks, test mode | yes | yes |
| Invoices / purchase orders for Enterprise | yes | yes |

**Recommendation: Paddle.** Venues buy from anywhere, a yearly B2B software subscription is exactly
what a merchant of record is for, and on a $1,499 sale the difference is about $15–25 against owning
sales-tax filings yourself. (Lemon Squeezy is now part of Stripe and its direction is unclear.)
Stripe if you'd rather keep the lowest fees and already have tax handled.

Flow: plan button → hosted checkout → webhook `subscription.created` → server creates the license,
emails the key → success page shows it. Renewals extend `expires`; a failed payment leaves the license
valid until expiry, then the grace period; upgrade Starter → Venue is a prorated plan change that
raises `maxScreens` on the next refresh. Everything in sandbox / test mode until you say go live.

## 7. Phases

Each phase: on this branch, with tests in `mosaic-engine/tools/ci_check.py` where it's engine code,
Windows CI green, shown working in test mode before the next one starts.

0. **Legal now**: `LICENSE` (proprietary) and `EULA.md`, terms, privacy and refund drafts clearly
   marked *draft for a lawyer*. No behavior change.
1. **Engine license core** (**built**, see "Phase 1 as built" below), in *report-only* mode: verify and store the file, fingerprint, trial,
   states, `GET /api/license`, screen counting, the lock decisions computed but **not enforced**.
   Tests: good / tampered / expired / wrong machine / clock back / grace / limit, and walls keep
   playing and a restart reloads the layout in every failure case.
2. **Editor** (**built**): Settings → License (key, online and offline activation, plan and usage, renew link),
   banners, limit messages.
3. **License server** (test deployment) with the admin view; issue the inside bar's comp license.
4. **Payments** in sandbox: checkout, webhooks, renewals, upgrade, failed payment, portal.
5. **Release bundles and update channel** (§1 B–D), moving MEDIA-SERVER and rcv01 over, with CI green
   before anything reaches them; then make the repos private (§1 E).
6. **Turn enforcement on** (comp license already on MEDIA-SERVER), website checkout buttons, success,
   account and "activate offline" pages.
7. **Docs and support**: activate, move, renew, what happens when it lapses, in the README and on the
   site.

Going live (real payment account, domain, live keys, the code-signing certificate) waits for your
say-so at each step.

## Open questions

All answered: see **Decisions** at the top. Still open: the domain name.

## Phase 1 as built

- Code: `mosaic-engine/engine/src/license/` (`license_format` = the file format and Ed25519 via
  Monocypher; `license` = states, screen counting, request classes, the `Manager`; `fingerprint` = this
  PC's hashed identifiers; `license_tool` = `bluvu_license`, which makes keys and signs files).
- Startup: layouts load and canvases start **before** the license is looked at. The license is checked in
  two places only: the HTTP `guard` (request kinds: read / always / operation / setup / update) and the
  layout store's change check (what would be added: screens, canvases, sound outputs, capture sources).
  A refused change throws `ChangeRefused`, which only the HTTP layer catches (a `403` with the reason).
- API: `GET /api/license`, `PUT /api/license` (body = the license file), `DELETE /api/license`,
  `POST /api/license/request-code {key}`.
- Report-only: without `--license-enforce` nothing is refused; `GET /api/license` → `wouldBlock` counts what
  would have been, with the last one. Every PC runs like this until phase 6.
- Keys: no production key yet (made on the license server in phase 3, private half never in the repo).
  Test builds (`-DMOSAIC_LICENSE_TEST_KEY=ON`, CI only) also trust the published test key
  (`mosaic-engine/tools/license-test-key.txt`) and take `MOSAIC_LICENSE_FINGERPRINT` in place of the PC's.
  A build without it verifies nothing yet, so every venue PC shows `none` in report-only mode.
- Trial: a trial is a license file with `"trial": true` (and `graceDays: 0`), issued by the server in
  phase 3; the engine has no trial of its own to start, so reinstalling can't restart one.
- Tests: `mosaic_engine --license-self-test` (good / tampered / unknown key / expiry / grace / comp / trial /
  machine 2-of-3 / clock set back / screen counting / limits / request kinds) and `tools/license_check.py`
  (real engines: no license, damaged file, Starter at its limit, tampered and another PC's file refused over
  the API, offline activation round trip, expired and over the limit with a restart, grace, another PC, clock
  set back; every case checks all outputs keep rendering). CI runs both.

## Phase 2 as built

- `mosaic-engine/ui/src/License.tsx`: Settings → License shows the plan, customer, state in words,
  screens used of allowed (with a bar), walls / sound outputs / capture cards, and what lapsing means.
  Renew, Upgrade / Buy and Account link to the website (`https://bluvu.example/...` until the domain is
  chosen; the engine sends the links in `GET /api/license` → `links`). Activate: a key field, **Get request
  code** (offline activation: copy it to the website's activate page), **Install license file…** or paste.
  **Remove from this server** (for a move). The PC's identifier hashes (short) are shown for support.
- Top bar: a pill when something needs doing (expiring, grace, trial, lapsed, or no license while
  enforced); it opens Settings → License. In report-only mode a missing license shows no pill and a
  neutral box, so venue editors look as before.
- A change the license refuses comes back as `403` with `"license": true`; the editor shows the reason
  ("Starter allows 8 screens; this would be 9.") with a **License settings** button.
- Online activation (a button shown when `GET /api/license` → `online` is true) arrives with the license
  server in phase 3.
