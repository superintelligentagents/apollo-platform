// Apollo History Helper — answers history requests from the allow-listed
// Apollo web app origins only (see externally_connectable in manifest.json).
// History data goes to the page for local processing; nothing is transmitted
// anywhere by this extension.

const WINDOW_DAYS = 120;
const MAX_URLS = 20000;
const MAX_VISITS = 60000;

chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "ping") {
    sendResponse({ ok: true, version: 1 });
    return false;
  }
  if (msg && msg.type === "history") {
    (async () => {
      try {
        const start = Date.now() - WINDOW_DAYS * 86400000;
        const items = await chrome.history.search({
          text: "",
          startTime: start,
          maxResults: MAX_URLS,
        });
        const visits = [];
        const CHUNK = 50;
        for (let i = 0; i < items.length && visits.length < MAX_VISITS; i += CHUNK) {
          await Promise.all(
            items.slice(i, i + CHUNK).map(async (item) => {
              const vs = await chrome.history.getVisits({ url: item.url });
              for (const v of vs) {
                if (v.visitTime && v.visitTime >= start) {
                  visits.push({
                    id: Number(v.visitId) || 0,
                    url: item.url,
                    title: item.title || "",
                    visited_at: new Date(v.visitTime).toISOString(),
                    from_visit: Number(v.referringVisitId) || 0,
                  });
                }
              }
            })
          );
        }
        sendResponse({ ok: true, visits: visits.slice(0, MAX_VISITS) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // keep the message channel open for the async response
  }
  return false;
});
