# Bluvu licensing and sales: plan

Status: **draft for agreement.** Nothing here changes how any PC behaves yet. The open questions are
at the end; each phase is built only after they're answered, one phase at a time, in test mode.

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
| B. | CI builds **versioned release bundles** on `windows-2022`: `mosaic_engine.exe`, `mosaic_receiver.exe`, `ui/dist`, `videowall.py` and the scripts, with the NDI runtime DLL. A `manifest.json` lists each file's SHA-256 and is signed with a **release Ed25519 key** (a different key from the license key, kept as a CI secret). Optionally Authenticode-signed too (costs money, see Q8). | Media servers stop needing Visual Studio, CMake and Node. The engine and receivers verify the signature before running an update. |
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
| `trial` | first run, 14 days (Q3) | on | yes | yes | up to Venue | yes | "Trial: N days left" |
| `valid` | signed, unexpired | on | yes | yes | up to plan | yes | nothing |
| `expiring` | within 30 days of expiry | on | yes | yes | up to plan | yes | quiet banner, renew link |
| `grace` | past expiry, within grace (Q4) | on | yes | yes | up to plan | yes | stronger banner |
| `expired` | past grace | **on** | yes (Q9) | locked | locked | locked | "Renew to edit"; Settings → License open |
| `none` / `invalid` | trial over and no license, tampered file, wrong machine, clock back | **on** | yes (Q9) | locked | locked | locked | reason, how to fix |

\* Day-to-day operation = recalling presets and scenes, "show this stream on this group", blank and
identify, restarting a source. Companion buttons and the control API use these at showtime, so the
proposal is that they never lock (Q9).

- Settings → License, the PIN/API-key settings, `GET` requests and receiver check-ins always work.
- **Over the limit** (a downgrade, or a layout imported from a bigger server): everything keeps
  running; only adding or enabling more is refused, with "Starter allows 8 screens; this would be 9.
  Upgrade".
- `GET /api/license` returns plan, state, screens used / allowed, expiry, grace end, days left, the
  reason for `invalid`, and the request code.

## 4. What counts as a screen (Q2)

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

## 6. Payments (Q1)

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
1. **Engine license core**, in *report-only* mode: verify and store the file, fingerprint, trial,
   states, `GET /api/license`, screen counting, the lock decisions computed but **not enforced**.
   Tests: good / tampered / expired / wrong machine / clock back / grace / limit, and walls keep
   playing and a restart reloads the layout in every failure case.
2. **Editor**: Settings → License (key, online and offline activation, plan and usage, renew link),
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

1. **Payment provider:** Paddle (recommended) or Stripe?
2. **What's a screen:** 2×2 cut from one stream = 4 (recommended) or 1?
3. **Trial:** 14 days, full Venue features, once per machine? Needs an online activation, or works
   offline too (easier to repeat by reinstalling)?
4. **Grace period:** 30 days after expiry?
5. **Hosting:** Cloudflare Workers + D1 + R2 with the site on Cloudflare Pages (recommended), or a VPS?
   You'd create the account and authorize the Cloudflare plugin.
6. **Domain:** which (e.g. bluvu.com), and do you own it already? License server at
   `license.<domain>`.
7. **Distribution:** agree to §1 (proprietary LICENSE now; signed release bundles; update channel through
   the media server; move PCs over by one last git update; repos private after that)? Anything other than
   the inside bar installed from the repo that has to be moved?
8. **Code signing:** buy an Authenticode certificate (or Azure Trusted Signing, about $10 a month) so
   Windows SmartScreen doesn't warn on the binaries, or rely on our own Ed25519 check for now?
9. **What "editing" locks when lapsed:** keep day-to-day operation (presets, scenes, show stream, blank,
   Companion) working and lock only changing the setup (recommended), or lock all changes?
10. **Moves:** 3 machine moves a year, self-service?
