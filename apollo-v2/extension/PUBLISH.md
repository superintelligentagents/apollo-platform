# Publishing the Apollo History Helper to the Chrome Web Store

This is the **only** way to give annotators a true one-click "import my
history" button with no Developer Mode. Confirmed by browser-security review:

- A web page can never read Chrome history without an extension (the `chrome.history`
  API is extension-only).
- Chrome's user-data directory is on the File System Access **blocklist**, so the file
  picker cannot open `Default/History` in place — the file must be copied first. That's
  irreducible friction; the extension avoids it entirely by reading the live history API.
- Unpacked install (Developer Mode) is unsuitable for non-technical crowdworkers.

## Store-ready package

`apollo-history-helper-store.zip` — icons, code, and a store-compliant manifest. It contains
neither the manifest `key` field nor the private `key.pem`. Upload or update the item through
the Chrome Developer Dashboard. Rebuild with:

```bash
cd apollo-v2/extension
python3 - <<'EOF'
import json, shutil, os
os.makedirs("store_pkg", exist_ok=True)
m = json.load(open("manifest.json")); m.pop("key", None)
json.dump(m, open("store_pkg/manifest.json", "w"), indent=2)
for f in ["background.js","icon16.png","icon48.png","icon128.png"]:
    shutil.copy(f, "store_pkg/")
EOF
(cd store_pkg && zip ../apollo-history-helper-store.zip manifest.json background.js icon*.png)
```

## Submission steps (~15 min + 1–3 day review)

1. Create a Chrome Web Store developer account (one-time **$5** fee):
   https://chrome.google.com/webstore/devconsole
2. "New item" → upload `apollo-history-helper-store.zip`.
3. Store listing:
   - **Category**: Productivity. **Language**: English.
   - **Description**: explain it reads history *only* for the Apollo task-collection study,
     processes locally, and transmits nothing itself.
   - **Screenshots** (1280×800): the Apollo import screen with the connected button (a couple
     of the `scratchpad/*.png` shots work).
   - **Privacy**: single purpose = "let the Apollo research app read your Chrome history with
     your consent." Justify the `history` permission in the same words. Link a privacy policy
     (a short page stating: history is read on-device, only uploaded when the participant
     submits a task, never sold).
4. Because it requests the `history` permission, expect a **permissions/privacy review**.
   Keeping the single, clearly-justified purpose makes this pass smoothly.
5. Publish. Confirm the dashboard item ID, then copy its public key into the unpacked manifest
   so local development resolves to the same ID. Update `web/src/extension.ts` only if the store
   item ID differs.

## After publishing — flip the web app to the store link

In `shared/src/ui/screens/history.ts`, change the install card's download button from the
local `.zip` to the store URL:

```
https://chrome.google.com/webstore/detail/jodeickgpmlohcpebffkbbkpnadppgfb
```

so the flow becomes: **Import my history → Add to Chrome (one click) → back to the app →
one-button import**. The `externally_connectable` allow-list already covers the live origin.

## Optional future: Google Data Portability API

`dataportability.chrome.history` (OAuth) can export *synced* history without an extension, but
it's asynchronous (minutes–days), requires Google app verification, and misses local-only
history — so it's a nice-to-have "import from your Google account" path, not the core flow.
