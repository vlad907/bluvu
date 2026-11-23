# Prompt: set up licensing and sales for Bluvu

Copy everything below the line into a new Claude Code session opened in this repository.

---

You're setting up licensing and online sales for **Bluvu**, the video-wall software in this repository
(a product of Blue Arc Networks). The goal: a venue can buy a one-year license on the website, get a
license key, enter it in the editor, and the software runs within the limits of the plan they paid for.
It renews yearly. Plan the whole thing with me first, then build it in phases. Don't change how any
existing PC behaves until we've agreed the plan.

## What Bluvu is today (read these before planning)

- `mosaic-engine/`: the **media server**. C++ engine (Direct3D 11 on Windows, Metal on macOS for dev)
  with an HTTP API (`engine/src/api/http_api.cpp`) and a React/TypeScript editor (`ui/src/`) served on
  port 8090. Layouts are JSON (`engine/src/core/layout.cpp`). It already has an optional editor PIN and
  API key (`editorPin`, `apiKey` in `http_api.cpp`; Settings → Access in the editor). Read
  `mosaic-engine/README.md` and `docs/CONTROL_API.md`.
- `videowall.py`: the **dashboard on every receiving PC** (Python standard library only). It checks in
  with the engine every few seconds (`endpoint_checkin`, `POST /api/endpoints/checkin`) and runs NDI
  Studio Monitor or our Mosaic Receiver, which it downloads from the media server.
- **Install and update:** `install*.ps1`, `setup-receiver.ps1`, `update.ps1`. Every PC does
  `git clone` / `git pull` from the public GitHub repo `vlad907/video-wall-control`, and the media server
  **builds the engine from source** (Visual Studio + CMake). The editor's *Update everything* button
  makes every PC pull and rebuild. `origin` also pushes to `vlad907/bluvu`.
- **Both GitHub repos are public and there is no LICENSE file.**
- **Website:** `site/` (static HTML). `site/products.html` has the plans and hardware with example prices.

## The plans (from `site/products.html`; confirm with me before building)

- A license is **per media server, per year**. **Receivers never need a license.**
- **Starter**: $599/year, up to 8 screens. **Venue**: $1,499/year, up to 32 screens, several walls,
  sound zones and capture cards. **Enterprise**: by quote, unlimited, several servers and sites.
- Hardware (servers, receivers, the inside-bar kit) is a one-time purchase, sold by quote for now.
- Promised on the site: **if a license lapses, the walls keep showing what they show; editing and
  updates pause until it's renewed.**

## Rules you must keep

1. **Never black out a wall** because of licensing: not when the license server is down, when the venue
   is offline, when the license has expired, or when a check fails. Licensing may lock *editing*,
   *updates* and *adding screens*. It never stops what's already playing, and never stops a restart from
   coming back up with the saved layout.
2. **Work offline.** Venues sit on isolated AV networks. Use a **signed license file** (for example
   Ed25519) that the engine verifies locally with an embedded public key: plan, screen limit, features,
   expiry, the machine it's bound to. It phones home only to renew or refresh, with a generous grace
   period (suggest 30 days), and gives a manual offline activation path (copy a request code, paste back
   a license file).
3. **Bind to the media server** with a stable fingerprint that survives a Windows update and a GPU or
   NIC swap, plus a self-service "move my license to a new PC" with a sensible limit.
4. **Decide what a "screen" is** and count it in one place: enabled outputs across all running canvases
   (NDI outputs and display outputs). A 2×2 cut from one stream by the Mosaic Receiver counts as
   4 screens or 1? Propose an answer and ask me.
5. **The existing venue** (the inside bar: media server `MEDIA-SERVER`, receiving PCs `rcv01` etc.)
   must keep working through the change. Give it a free license that doesn't expire. Before any change
   reaches a venue PC, push and confirm the Windows CI (`.github/workflows/mosaic-engine-windows.yml`)
   is green.
6. Don't put secrets (Stripe keys, the license signing private key) in the repo. The private signing key
   lives only on the license server or in a secret store, and I keep an offline backup.
7. Don't start anything that costs money or takes payments for real (accounts, domains, live keys)
   without asking me. Build against test mode first.

## Problem to solve first: the code is public

A license check in public source code can be deleted, and venues currently build from source. Before
writing licensing code, propose how Bluvu gets distributed, with trade-offs. For example:

- Make the repos **private**, and ship **prebuilt, signed Windows binaries** (engine, receiver, editor
  build, dashboard) as versioned releases. The media server stops needing Visual Studio.
- Replace `git pull` updates with an **update channel**: the media server downloads a signed release
  (from the license server, or a private GitHub Releases feed through the license server) and hands it to
  receivers the way it already hands out the Mosaic Receiver. Updates only for licenses that are current.
- What happens to the PCs already installed from the public repo, and how they move to the new channel
  without anyone on site.
- Whether the source should get a proprietary LICENSE / EULA now, before anything else, since it's
  currently public with no license at all.

## Pieces to build (plan them, then do them in order)

1. **License format and checks in the engine**: verify and store the license, expose
   `GET /api/license` (plan, screens used and allowed, expiry, state: valid / grace / expired / none),
   enforce the screen limit when outputs are added or enabled, lock editing and updates when expired, and
   keep everything already running. A trial mode (suggest 14 days, full features) so people can try it.
2. **Editor UI**: Settings → License (enter a key, activate online or offline, see plan and usage,
   renew link), a quiet banner when within 30 days of expiry or in grace, and clear messages when a limit
   blocks an action ("Starter allows 8 screens; this would be 9. Upgrade").
3. **License server**: issues and signs licenses, handles activation, deactivation and moving machines,
   renewals, and the payment webhooks. Propose where it runs. The repo has Cloudflare tooling (Workers +
   D1 would fit; its plugin needs authorizing first), but compare it with something simple. Include an
   admin view for me: customers, licenses, machines, revoke, issue a comp or Enterprise license by hand.
4. **Payments**: compare **Stripe** (Checkout + Billing for yearly renewals; I handle sales tax myself)
   with a **merchant of record** such as Paddle or Lemon Squeezy (they handle sales tax / VAT). Recommend
   one and ask me. Yearly subscriptions that auto-renew, upgrade Starter → Venue mid-term with proration,
   failed-payment handling (the grace period), receipts, a customer portal to manage billing and get the key.
5. **Website**: the plan buttons on `site/products.html` go to checkout; a success page that shows the
   key and how to enter it; an account / "find my license" page; pages for the EULA, terms, privacy
   policy and refunds (draft them clearly marked as drafts for a lawyer to review).
6. **Docs and support**: how to activate, move, renew, and what happens when it lapses, in the README and
   on the site.
7. **Tests**: license verification (good, tampered, expired, wrong machine, clock set back), the screen
   limit, the grace period, and the rule that walls keep playing in every failure case. Add them to the
   existing checks (`mosaic-engine/tools/ci_check.py`) so CI runs them.

## How to work with me

- Start by reading the files above, then write the plan as a short doc: the distribution decision, the
  license format, what each state locks, the server and payment choices, and the phases. Ask me the open
  questions in one go (payment provider, what counts as a screen, trial length, grace period, hosting,
  domain), then wait for my answers before building.
- Build one phase at a time on a branch, with tests, and show me each phase working (in test mode)
  before the next.
