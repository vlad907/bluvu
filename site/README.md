# Bluvu website

Static marketing site: `index.html`, `styles.css`, `main.js`, and media in `media/`. No build step.

- **Preview:** `python3 -m http.server 8765` in this folder, then open http://localhost:8765
- **Media:** see [CONTENT.md](CONTENT.md) for every file the page expects. A missing file shows a
  labelled placeholder; drop the file in `media/` with the listed name and reload.
- **Hosting:** Cloudflare Workers (static assets) at https://bluvu.video and www.bluvu.video, set up
  in `wrangler.jsonc`. Deploy from this folder with `npx wrangler@4 deploy` (needs `npx wrangler@4 login`
  to the Blue Arc Networks Cloudflare account). Pushing to GitHub does not deploy by itself.
  `.assetsignore` keeps this README, CONTENT.md and the config off the live site.
