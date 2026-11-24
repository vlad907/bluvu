# Bluvu site: content to supply

Drop each file into `site/media/` **with the exact file name below** and reload the page. It
replaces the dashed placeholder by itself; nothing else needs editing. Placeholders show the
slot ID and file name, so you can see on the page where each one goes.

Priority: **P1** = needed to launch, **P2** = makes it much stronger, **P3** = nice to have.

## General specs

- **Video:** MP4, H.264, 1920×1080, 30 fps, **no audio track** (the site plays it muted), 8–20 s,
  loops cleanly (end frame ≈ start frame). Aim for under 8 MB each. Export the matching poster frame
  as a JPEG with the same name (`.jpg`): it shows while the video loads.
  `ffmpeg -i in.mov -an -vf scale=1920:-2 -c:v libx264 -crf 26 -preset slow -movflags +faststart out.mp4`
- **Photos:** JPEG, at least 2400 px on the long side, quality ~80. Landscape unless noted.
- **Screenshots:** PNG at 2× (e.g. a 1440×810 browser window captured on a Retina Mac = 2880×1620).
  Crop to 16:9. Use a realistic layout with real-looking stream names, not "test 1 / test 2".
  Hide anything private (IP addresses you don't want public, PC names, customer names).

## Already done: editor shots (captured by Claude)

These are in `site/media/` and on the page now. They were captured from the real editor running the
inside-bar layout, with demo "game" videos and simulated receiving PCs. The media server's name shows as
MEDIA-SERVER. To redo them later (new UI, real venue names), ask Claude to recapture them.

| Slot | File | What it shows |
|---|---|---|
| tilt-demo | `tilt-demo.mp4` + `.jpg` | Close-up: tilting a screen by its handle, Shift-snap to 45°, `[` `]` nudges, live preview (13 s) |
| (spare) | `freeform-editor.jpg` | Inside-bar wall in the editor, a tilted screen selected; for social posts |
| editor-drag | `editor-drag.mp4` + `.jpg` | Drag with snap guides, tilt with `[` `]`, resize the centre wall (13 s) |
| sources-layers | `sources-layers.mp4` + `.jpg` | Move a layer, fade its opacity down and back (10 s) |
| endpoints | `endpoints.jpg` | Three PCs online and in step, a new PC waiting for *Set up* |
| updates | `updates.jpg` | Settings → Updates, every PC up to date, *Update everything* |
| (spare) | `sources-layers-still.jpg` | Inputs view still, for social posts |

Note: the editor's own title bar still says **Mosaic**. If the product is Bluvu, rename it in the
editor (`mosaic-engine/ui`) before the next recapture.

## From your venue footage (IMG_3102, IMG_3107)

| File | From | What |
|---|---|---|
| `hero-loop.mp4` + `hero-poster.jpg` | IMG_3107 | 16:9 crop, drone footage across every screen (14 s, no sound) |
| `freeform-photo.jpg` | IMG_3102 | 4:3 crop of the whole wall, used as the inset |
| `gallery-1.jpg` | IMG_3102 | Wide shot of the wall and bar |
| `gallery-2.jpg` | IMG_3107 | Guests at a table with the wall playing |
| `gallery-6.jpg` | IMG_3102 | The editor on a laptop at the bar |

The hero is cropped from a portrait clip, so it's 1080 px wide. A landscape reshoot (tripod, wall
switching presets, lights down) would look sharper. The IMG_3102 wide shot shows a ladder and loose cables under
the wall; a tidy reshoot would help there too.

## Your shots: in real life (still to do)

| # | File | Type | Pri | What to capture |
|---|---|---|---|---|
| 4 | `og-image.jpg` | Image, **1200×630** | **P1** | Link preview card. Claude can make it from #1 or #3 plus the logo. |
| 5 | `sync-slowmo.mp4` + `.jpg` | Phone video (slow-mo) | P2 | Test pattern with the frame counter across the 2×2 and the side PCs, at 120/240 fps, counters matching. |
| 6 | `control-hardware.jpg` | Photo, 3:2 | P2 | Stream Deck / Companion page or touch panel in a hand behind the bar, wall blurred behind. |
| 8 | `gallery-3.jpg` | Photo | P2 | Side screens close: tilted / portrait 43" and 24". |
| 9 | `gallery-4.jpg` | Photo (wide tile, 2:1) | P2 | Close-up of a bezel line where one picture crosses two screens cleanly. |
| 10 | `gallery-5.jpg` | Photo (wide tile) | P3 | The hardware: media server, receiving PCs, rack. Tidy cables. |

## Products page (`products.html`)

Product photos, 4:3, on a plain dark background or in place behind a screen:

| File | Pri | What |
|---|---|---|
| `server-compact.jpg` | P2 | The mini PC media server |
| `server-venue.jpg` | P2 | The desktop media server |
| `server-flagship.jpg` | P3 | The rack server |
| `receiver-one.jpg` | P2 | Small receiver, ideally on a VESA mount behind a TV |
| `receiver-quad.jpg` | P2 | Four-output receiver, cables to a 2×2 |
| `receiver-pro.jpg` | P3 | 4K receiver |

**Prices and hardware are examples to confirm.** Everything on the page is a first pass: hardware
$399–$8,999, license Starter $599/yr (8 screens), Venue $1,499/yr (32 screens), Enterprise by quote, the
inside-bar kit at $8,999, 2-year hardware warranty, and "walls keep running if a license lapses". The
screen counts per server are planning figures from the engine's measurements (4 × 4K and 24 × 1080p at
60 fps on the GPU, without NDI encoding) plus NDI bandwidth. Measure on the real hardware before quoting them.
The license tiers aren't enforced by the software yet.

## Editor shots that need the media server (Windows)

These features only run on Windows, so they couldn't be captured on the Mac. Take them on MEDIA-SERVER
(browser at 2×, window about 1600×900), or have Claude capture them over the network.

| File | Pri | What |
|---|---|---|
| `audio.png` | P2 | Settings → Audio: named zones (bar, patio, …) with source, volume, mute |
| (optional) `monitor.png` | P3 | Monitor view with real NDI outputs and the real GPU |

## Brand and words

| Item | Pri | Notes |
|---|---|---|
| Blue Arc Networks link / logo | P2 | The hero says "Brought to you by Blue Arc Networks" and the footer credits it. Send the company's URL and logo to link them. |
| Logo (SVG) | **P1** | A wordmark and a square mark. The site uses a stand-in 2×2 tile mark; send `logo.svg` and `logo-mark.svg` and I'll wire them in (and redo `favicon.svg`). |
| Contact email | **P1** | The *Book a demo* form and footer use `hello@bluvu.video`. Set it up in Cloudflare Email Routing (forward to your inbox), or use a form service (Formspree, Tally, HubSpot) for the form. |
| Domain | Done | `bluvu.video`, on Cloudflare (DNS and hosting). |
| Pricing model | **P1** | FAQ "How is it priced?" is a placeholder. Per site, per screen, subscription, or "contact us". |
| Testimonial | P2 | One quote from the venue: name, role, venue, city (with their OK to be named). The *In the wild* section has a placeholder. |
| Venue name / logo use | P2 | Permission to name the venue and show its photos. |
| Headline check | P2 | Hero: "Every screen in the room, from one browser tab." Change if you have a line you like better. |
| Company details | P3 | Legal name for the footer, location, social links (LinkedIn, YouTube, Instagram). |
| Founder / team photo + short bio | P3 | For an About section later. |

## Claims to confirm before launch

The copy only says what the README says is working. Check these are true for the version you'll sell:

- "Works with Crestron, Q-SYS, AMX": the API is plain HTTP, so they can send it, but only say this if
  you're happy to support it. Bitfocus Companion is the one most likely tried.
- Multi-PC sync "within one refresh" with a Buffer, and the 2×2 from one stream: the README says these
  are checked by CI but **not yet run on the receiving PCs**.
- "Each screen remembers its monitor": matching rules checked, **not yet tried on real monitors**.
- Nothing on the site quotes a screen count or fps limit. If you want "up to 24 screens", it was measured
  on a Mac without NDI; measure it on Windows first.
