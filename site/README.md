# Bluvu website

Static marketing site: `index.html`, `styles.css`, `main.js`, and media in `media/`. No build step.

- **Preview:** `python3 -m http.server 8765` in this folder, then open http://localhost:8765
- **Media:** see [CONTENT.md](CONTENT.md) for every file the page expects. A missing file shows a
  labelled placeholder; drop the file in `media/` with the listed name and reload.
- **Hosting:** any static host. GitHub Pages (Settings → Pages → deploy from `main`, folder `/site`
  via an Actions workflow) or Cloudflare Pages (build command empty, output directory `site`).
