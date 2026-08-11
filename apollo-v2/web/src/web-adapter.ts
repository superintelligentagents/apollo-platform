import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { hasSavedHistoryHandle, pickHistoryFile, readSavedHistoryFile, supportsFsAccess } from "./fs-access";
import { extensionAvailable, readHistoryFromExtension } from "./extension";
import {
  chromeTimeToIso,
  clusterVisitsHeuristic,
  presignEndpoint,
  uploadJsonBrowser,
  type Cluster,
  type PlatformAdapter,
  type ProfileOption,
  type UploadJsonOptions,
  type Visit,
} from "@odyssey/shared";

let sqlPromise: Promise<SqlJsStatic> | null = null;

function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    // Wasm is vendored into public/ at install time — no CDN dependency.
    // BASE_URL keeps it working when hosted under a subpath (e.g. GH Pages).
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
    sqlPromise = initSqlJs({ locateFile: (file) => `${base}${file}` });
  }
  return sqlPromise;
}

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsArrayBuffer(file);
  });
}

function tableNames(db: Database): Set<string> {
  const res = db.exec("select name from sqlite_master where type='table'");
  return new Set(res.flatMap((r) => r.values).flat() as string[]);
}

function hasClusterTables(db: Database): boolean {
  const names = tableNames(db);
  return names.has("clusters") && names.has("clusters_and_visits");
}

// Not every Chromium-family History has keyword_search_terms; join only if present.
function keywordJoin(db: Database): { select: string; join: string } {
  return tableNames(db).has("keyword_search_terms")
    ? {
        select: ", IFNULL(k.term, '')",
        join: "LEFT JOIN (SELECT url_id, MAX(term) AS term FROM keyword_search_terms GROUP BY url_id) k ON k.url_id = v.url",
      }
    : { select: ", ''", join: "" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function searchTermFromUrl(url: string): string {
  try {
    return (new URL(url).searchParams.get("q") || "").trim();
  } catch {
    return "";
  }
}

// Bound ingestion so a huge History file can't exhaust tab memory — but high
// enough to cover Chrome's full ~90-day visit retention even for heavy users
// (1,500 clusters covered only ~5 weeks for one). Recency bias starts at
// ingestion: themes can't find threads the reader never loads.
const MAX_CLUSTERS = 4000;
const MAX_VISITS = 40000;

function readClusters(db: Database): Cluster[] {
  const kw = keywordJoin(db);
  const query = `
    SELECT c.cluster_id, cav.visit_id, v.visit_time, u.url, u.title${kw.select}
    FROM clusters c
    JOIN clusters_and_visits cav ON cav.cluster_id = c.cluster_id
    JOIN visits v ON v.id = cav.visit_id
    JOIN urls u ON u.id = v.url
    ${kw.join}
    WHERE c.cluster_id IN (SELECT cluster_id FROM clusters ORDER BY cluster_id DESC LIMIT ${MAX_CLUSTERS})
    ORDER BY c.cluster_id DESC, v.visit_time
    LIMIT ${MAX_VISITS}
  `;
  const res = db.exec(query);
  if (!res.length) return [];
  const clusters = new Map<number, Cluster>();
  for (const row of res[0].values) {
    const [cid, vid, ts, url, title, term] = row as [number, number, number, string, string, string];
    if (!clusters.has(cid)) clusters.set(cid, { cluster_id: cid, visits: [] });
    clusters.get(cid)!.visits.push({
      id: vid,
      url,
      title: title || "",
      visited_at: chromeTimeToIso(ts),
      from_visit: 0,
      domain: hostOf(url),
      search_term: term || searchTermFromUrl(url) || undefined,
    });
  }
  return [...clusters.values()].sort((a, b) => b.cluster_id - a.cluster_id);
}

function readVisits(db: Database): Visit[] {
  const kw = keywordJoin(db);
  const query = `
    SELECT v.id, u.url, u.title, v.visit_time, v.from_visit${kw.select}
    FROM visits v
    JOIN urls u ON u.id = v.url
    ${kw.join}
    ORDER BY v.visit_time DESC
    LIMIT ${MAX_VISITS}
  `;
  const res = db.exec(query);
  if (!res.length) return [];
  return res[0].values.map((row) => {
    const [id, url, title, ts, fromVisit, term] = row as [number, string, string, number, number, string];
    return {
      id,
      url,
      title: title || "",
      visited_at: chromeTimeToIso(ts),
      from_visit: fromVisit,
      domain: hostOf(url),
      search_term: term || searchTermFromUrl(url) || undefined,
    };
  });
}

export function createWebAdapter(): PlatformAdapter {
  return {
    platform: "web",

    // No profile auto-detect in the browser — the user picks the History file.
    async detectProfiles(): Promise<ProfileOption[] | null> {
      return null;
    },

    async loadClusters(source: ProfileOption | File | "chrome-extension"): Promise<Cluster[]> {
      if (source === "chrome-extension") {
        const visits = await readHistoryFromExtension();
        if (!visits) throw new Error("The helper extension didn't respond — is it installed and enabled?");
        return clusterVisitsHeuristic(visits);
      }
      if (!(source instanceof File)) throw new Error("Profile sources are for the desktop app.");
      const SQL = await getSql();
      const bytes = await readFileBytes(source);
      const db = new SQL.Database(bytes);
      try {
        const names = tableNames(db);
        if (names.has("moz_places")) {
          throw new Error("That's a Firefox history file — we need Chrome's \"History\" file.");
        }
        if (!names.has("visits") || !names.has("urls")) {
          throw new Error("That file doesn't look like a Chrome History database.");
        }
        // Empty-but-present Journeys tables must not suppress the fallback.
        const clusters = hasClusterTables(db) ? readClusters(db) : [];
        return clusters.length ? clusters : clusterVisitsHeuristic(readVisits(db));
      } finally {
        db.close();
      }
    },

    async uploadJson(opts: UploadJsonOptions): Promise<void> {
      await uploadJsonBrowser(
        presignEndpoint(),
        {
          participantId: opts.participantId,
          studyId: opts.studyId,
          taskId: opts.taskId,
          filename: opts.filename,
          contentType: "application/json",
        },
        opts.body
      );
    },

    storage: {
      async get(key: string): Promise<string | null> {
        return localStorage.getItem(key);
      },
      async set(key: string, value: string): Promise<void> {
        localStorage.setItem(key, value);
      },
    },

    detectExtension: extensionAvailable,

    ...(supportsFsAccess()
      ? { pickHistoryFile, readSavedHistoryFile, hasSavedHistoryHandle }
      : {}),
  };
}
