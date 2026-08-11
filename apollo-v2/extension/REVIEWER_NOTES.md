# Reviewer notes

Paste the block below into the **"Notes for reviewers"** field in the Chrome Web Store
dev console (Privacy practices tab). Clear test steps + a plain statement of the single
purpose noticeably speed review for `history`-permission extensions.

---

```
WHAT THIS EXTENSION DOES
This is a helper for a single research web app, Apollo (https://apollo-v2-site.vercel.app),
which lets a consenting participant build web-task descriptions from their own browsing. The
extension's only job is a one-click "import my history" so the participant doesn't have to
manually export a file.

SINGLE PURPOSE
Read the user's own Chrome history, on their explicit click, and pass it to the Apollo web
page (and only that page) for local processing. Nothing else.

HOW TO TEST (about 1 minute, no account needed)
1. Load/install the extension.
2. Open https://apollo-v2-site.vercel.app
3. Choose the "Internal annotator" tab; enter any name and any email; click Start.
4. Click "Load my history." The page will show a green "Chrome history helper connected"
   badge and an "Import my Chrome history" button (this is the extension's ping response).
5. Click "Import my Chrome history." The extension reads recent history via chrome.history
   and returns it to the page, which then displays the browsing grouped into sessions —
   entirely in the page, on the local machine.

DATA & NETWORK BEHAVIOR
- The extension makes NO network requests of its own (no fetch/XHR; grep background.js).
- It responds only to messages from the origins in manifest "externally_connectable"
  (the Apollo app + 127.0.0.1 for local dev). It cannot be invoked by other sites.
- It reads page URLs, titles, visit times, and Chrome's internal visit/referrer IDs for
  ~120 days (constants WINDOW_DAYS / MAX_URLS / MAX_VISITS in background.js), then hands
  them to the requesting Apollo page. The extension itself stores and transmits nothing.
- History only leaves the device if the participant later chooses to submit a task in the
  Apollo app — that upload is done by the web app, not by this extension.

SOURCE
The entire logic is ~50 lines in background.js (one onMessageExternal listener handling
"ping" and "history"). No remote code, no libraries, no content scripts.

PRIVACY POLICY
https://apollo-v2-site.vercel.app/privacy.html
```
