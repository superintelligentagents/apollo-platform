# Apollo History Helper (Chrome extension)

A tiny MV3 extension that lets the Apollo web app read the user's Chrome history **with their
permission**, so no file-finding or Chrome-quitting is needed. History data is passed to the
allow-listed page for local processing; the extension itself transmits nothing.

## How it works
- `manifest.json` declares the `history` permission and `externally_connectable` limited to the
  Apollo origins (`https://apollo-v2-site.vercel.app/*`, `http://127.0.0.1/*` for dev). The
  pinned `key` gives it a **stable extension ID** (`jodeickgpmlohcpebffkbbkpnadppgfb`) that the
  web app targets (`web/src/extension.ts`).
- `background.js` answers two messages from those origins only: `ping` and `history` (last
  ~120 days, bounded). It returns visits; the page clusters and shows them.

> **Match-pattern gotcha:** `externally_connectable.matches` entries must have a second-level
> domain. `http://localhost/*` is **rejected** (single label) and silently breaks the whole
> extension — use `http://127.0.0.1/*` for local dev.

## Ship options (in order of participant ease)
1. **Chrome Web Store** (best): publish `dist_ext/` (zipped) — participants install in one click,
   no Developer Mode, survives restarts. Requires a one-time $5 dev account + review (~1–3 days).
   The pinned `key` keeps the ID stable, so `web/src/extension.ts` needs no change.
2. **Unpacked** (works today): the app serves `apollo-history-helper.zip`; users enable Developer
   Mode and "Load unpacked". Verified working end-to-end. Downside: Chrome nags about
   developer-mode extensions on each launch.

## Build the downloadable zip
```bash
cd apollo-v2/extension
cp manifest.json background.js dist_ext/
(cd dist_ext && zip ../../web/public/apollo-history-helper.zip manifest.json background.js)
```
`key.pem` is the private signing key. Keep it local and never include it in a distributed or
Web Store zip. It is git-ignored. Use the dashboard's public key in the unpacked manifest when
the development ID must match the store item.
