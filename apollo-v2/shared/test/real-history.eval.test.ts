// Ad-hoc local evaluation on the researcher's own history (dogfooding).
// Not part of the regular suite: run explicitly, prints aggregates only.
import { it } from "vitest";
import { readFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { chromeTimeToIso } from "../src/chrome-time";
import { clusterVisitsHeuristic, prepareJourneys } from "../src/clustering";
import { siteFamily, suggestThemes } from "../src/themes";
import type { Cluster, Visit } from "../src/types";

const HISTORY_PATH = process.env.REAL_HISTORY_PATH;

it.skipIf(!HISTORY_PATH)("evaluate ensemble on real history", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(HISTORY_PATH!));

  const names = new Set(
    db.exec("select name from sqlite_master where type='table'").flatMap((r) => r.values).flat() as string[]
  );
  const hasClusters = names.has("clusters") && names.has("clusters_and_visits");
  console.log("cluster tables:", hasClusters);

  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };

  let raw: Cluster[] = [];
  if (hasClusters) {
    const res = db.exec(`
      SELECT c.cluster_id, cav.visit_id, v.visit_time, u.url, u.title, IFNULL(k.term, '')
      FROM clusters c
      JOIN clusters_and_visits cav ON cav.cluster_id = c.cluster_id
      JOIN visits v ON v.id = cav.visit_id
      JOIN urls u ON u.id = v.url
      LEFT JOIN (SELECT url_id, MAX(term) AS term FROM keyword_search_terms GROUP BY url_id) k
        ON k.url_id = v.url
      WHERE c.cluster_id IN (SELECT cluster_id FROM clusters ORDER BY cluster_id DESC LIMIT 4000)
      ORDER BY c.cluster_id DESC, v.visit_time
      LIMIT 40000
    `);
    const map = new Map<number, Cluster>();
    for (const row of res[0]?.values ?? []) {
      const [cid, vid, ts, url, title, term] = row as [number, number, number, string, string, string];
      if (!map.has(cid)) map.set(cid, { cluster_id: cid, visits: [] });
      map.get(cid)!.visits.push({
        id: vid,
        url,
        title: title || "",
        visited_at: chromeTimeToIso(ts),
        from_visit: 0,
        domain: hostOf(url),
        search_term: term || undefined,
      });
    }
    raw = [...map.values()];
  }
  if (!raw.length) {
    const res = db.exec(`
      SELECT v.id, u.url, u.title, v.visit_time, v.from_visit, IFNULL(k.term, '')
      FROM visits v JOIN urls u ON u.id = v.url
      LEFT JOIN (SELECT url_id, MAX(term) AS term FROM keyword_search_terms GROUP BY url_id) k
        ON k.url_id = v.url
      ORDER BY v.visit_time DESC LIMIT 40000
    `);
    const visits: Visit[] = (res[0]?.values ?? []).map((row) => {
      const [id, url, title, ts, fromVisit, term] = row as [number, string, string, number, number, string];
      return {
        id,
        url,
        title: title || "",
        visited_at: chromeTimeToIso(ts),
        from_visit: fromVisit,
        domain: hostOf(url),
        search_term: term || undefined,
      };
    });
    console.log("fallback path, visits:", visits.length);
    raw = clusterVisitsHeuristic(visits);
  }
  db.close();

  console.log("raw clusters:", raw.length, "| total visits:", raw.reduce((s, c) => s + c.visits.length, 0));

  const journeys = prepareJourneys(raw, new Set());
  console.log("journeys after normalize:", journeys.length);
  const spanDaysAll = new Set(journeys.map((j) => j.visits[0]?.visited_at.slice(0, 10))).size;
  console.log("distinct active days:", spanDaysAll);
  console.log(
    "date range:",
    journeys.map((j) => j.visits[0]?.visited_at).sort()[0]?.slice(0, 10),
    "->",
    journeys.map((j) => j.visits[0]?.visited_at).sort().at(-1)?.slice(0, 10)
  );

  // top families by journey count (domains only)
  const famCount = new Map<string, number>();
  for (const j of journeys) {
    const fams = new Set(j.visits.map((v) => siteFamily(v.domain || "")));
    for (const f of fams) if (f) famCount.set(f, (famCount.get(f) || 0) + 1);
  }
  console.log(
    "top families:",
    [...famCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `${f}(${n})`).join(", ")
  );

  const t0 = performance.now();
  const suggestions = suggestThemes(journeys, 14);
  console.log(`ensemble: ${Math.round(performance.now() - t0)}ms, ${suggestions.length} suggestions`);
  for (const s of suggestions) {
    console.log(
      `[g${s.thread_group}][${s.algo}] score=${s.score} n=${s.cluster_fingerprints.length} days=${s.distinct_days} span=${s.start?.slice(0, 10)}..${s.end?.slice(0, 10)} | ${s.site_families.slice(0, 4).join(",")} | ${s.shared_tokens.join(",")}`
    );
  }
  const themed = new Set(suggestions.flatMap((s) => s.cluster_fingerprints));
  console.log(`coverage: ${themed.size}/${journeys.length} journeys in a theme`);
}, 120000);
