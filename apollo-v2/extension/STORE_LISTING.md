# Chrome Web Store listing — copy/paste fields

Everything you need is prepared. Upload package: **`apollo-history-helper-store.zip`**
(manifest is store-compliant, icons + description-length verified). The package contains no
private key. The unpacked development build keeps the dashboard-provided public `key` value so
its local ID matches the store item. Screenshots:
**`store-assets/1-home.png`** and **`store-assets/2-import-button.png`** (both exactly 1280×800).
Privacy policy is live at **https://apollo-v2-site.vercel.app/privacy.html**.

Submit at https://chrome.google.com/webstore/devconsole (one-time $5 developer fee).

---

## Store listing fields (paste these)

**Item name**
```
Apollo History Helper
```

**Summary** (≤132 chars — this is `description` in the manifest, prefilled)
```
Reads your Chrome history for the Apollo research study, with your permission. Everything stays on your device until you submit.
```

**Detailed description**
```
Apollo History Helper works with the Apollo research app (apollo-v2-site.vercel.app), a study
that builds long-horizon web-task benchmarks from real browsing.

With one click on the Apollo web app, this extension imports your recent Chrome history so you
don't have to export or upload a file. It reads your history only when you ask, and only for the
Apollo app's own pages.

Your data stays on your device. Nothing is transmitted until you choose to submit a task — and
then only the task you authored, with the sessions you selected, is uploaded. History you don't
turn into a submitted task is never sent anywhere.

Uninstall any time from chrome://extensions to stop all access.
```

**Category:** Productivity
**Language:** English

**Privacy policy URL**
```
https://apollo-v2-site.vercel.app/privacy.html
```

---

## Privacy practices tab (required — the `history` permission triggers this)

**Single purpose**
```
Let a participant import their own Chrome history into the Apollo research app with one click,
so they can build browsing-based tasks without manually exporting a file.
```

**Permission justification — `history`**
```
The core function is importing the user's browsing history into the Apollo app at their request.
The chrome.history API is the only way to read that history; the extension uses it solely for
this one-click import and for nothing else.
```

**Host / remote-code:** none. The extension bundles no remote code and contacts no server; it
only passes data to the allow-listed Apollo page via externally_connectable.

**Data usage disclosures** (check these boxes):
- Collects "Web history" — YES. (This category covers page URLs, titles, visit times, and the
  visit/referrer IDs the extension reads — all part of "web history" per Chrome's definition.)
- Purpose: "App functionality" (the import). Not sold, not for ads, not for creditworthiness.
- Certify the three data-usage compliance checkboxes (no selling, only for the disclosed
  purpose, not transferred except for the app's core function).

**IMPORTANT — why this certification stays truthful under the data-licensing model:**
the extension-collected data (raw history) is never sold, licensed, or published. What may be
licensed is the participant's AUTHORED task text (request + rubrics + site scope), which is a
compensated research contribution the participant knowingly submits — disclosed in the privacy
policy and at the upload button. Raw visit-level provenance stays internal for QA only and must
NEVER be included in a published or licensed dataset, or this certification (and CWS Limited
Use policy) would be violated.

---

## After it's published — one small app change

The Web Store assigns the extension's public ID on first publish. It **may** match the pinned
ID (`jodeickgpmlohcpebffkbbkpnadppgfb`) because the manifest keeps its `key`, but verify:

1. In the dev console, copy the published **Item ID**.
2. If it differs from the pinned ID, set it in the web app and redeploy:
   - `apollo-v2/web/src/extension.ts` → `EXTENSION_ID` default, **or** build with
     `VITE_EXTENSION_ID=<published-id> npm run build -w web`.
3. Then change the install card's download link (`shared/src/ui/screens/history.ts`, the
   "Download the helper" button) to the store URL:
   `https://chrome.google.com/webstore/detail/<published-id>`

That flips the flow to: **Import my history → Add to Chrome (one click) → one-button import.**
