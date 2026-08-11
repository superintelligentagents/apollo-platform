import type { Cluster, Visit } from "./types";

// Ported from journeys-helper-tauri/src/main.ts so v2 journeys line up with v1
// fingerprints and filtering behavior.

const SENSITIVE_URL_SUBSTRINGS = ["prolific", "gusto"];
const MIN_VISITS_PER_JOURNEY = 3;
const DOMAIN_GAP_MS = 10 * 60 * 1000;
const SEARCH_GAP_MS = 60 * 60 * 1000;
const DUPLICATE_SQUASH_MS = 5000;
const TOPIC_GAP_MS = 30 * 60 * 1000;

// Words that describe browser chrome or generic actions rather than intent.
// Sessionization uses these only to decide whether two nearby, unlinked visits
// belong together; the richer cross-day theme model has its own corpus-aware
// weighting in themes.ts.
const SESSION_STOPWORDS = new Set([
  "about", "account", "best", "chatgpt", "click", "current", "dashboard",
  "google", "home", "http", "https", "latest", "login", "open", "page",
  "search", "settings", "sign", "signin", "the", "this", "view", "with",
  "www", "com", "org", "net",
]);

const GENERIC_SESSION_DOMAINS = [
  "google.com", "bing.com", "chatgpt.com", "openai.com", "claude.ai",
  "perplexity.ai", "youtube.com", "reddit.com", "amazon.com",
];

function isGenericSessionDomain(domain: string): boolean {
  const d = (domain || "").toLowerCase().replace(/^www\./, "");
  return GENERIC_SESSION_DOMAINS.some((base) => d === base || d.endsWith(`.${base}`));
}

function sessionTokens(v: Visit): Set<string> {
  let path = "";
  try {
    const u = new URL(v.url);
    path = decodeURIComponent(u.pathname.replace(/[\/_-]+/g, " "));
  } catch {
    path = "";
  }
  const raw = `${v.title || ""} ${v.search_term || ""} ${path}`
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    raw.filter((token) => {
      if (token.length < 3 || token.length > 24 || SESSION_STOPWORDS.has(token) || /^\d+$/.test(token)) return false;
      const letters = token.match(/\p{L}/gu)?.length ?? 0;
      const digits = token.match(/\d/g)?.length ?? 0;
      return !(digits > 0 && letters < 3);
    })
  );
}

function sharesTopic(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  // One distinctive shared term is enough for small page signatures; larger
  // signatures require proportionate agreement so boilerplate cannot bridge.
  return shared >= 2 || (shared === 1 && Math.min(a.size, b.size) <= 6);
}

export class UnionFind {
  private parent: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

export function isSensitiveUrl(url: string): boolean {
  const u = (url || "").toLowerCase();
  return SENSITIVE_URL_SUBSTRINGS.some((b) => u.includes(b));
}

const SECRET_QUERY_KEY = /(^|[_-])(access[_-]?token|token|auth|authorization|code|credential|jwt|key|oauth|pass(word|wd)?|secret|session(id)?|sig(nature)?|state|sso|ticket)([_-]|$)/i;
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LONG_OPAQUE_VALUE = /^(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{64,})$/;

// Preserve useful content parameters (search queries, product IDs, filters)
// while ensuring selected history never uploads URL credentials, fragments,
// OAuth/session material, signatures, or obvious opaque secrets.
export function sanitizeHistoryUrl(raw: string): string | null {
  if (!raw || isSensitiveUrl(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.username = "";
    u.password = "";
    u.hash = "";
    for (const [key, value] of [...u.searchParams.entries()]) {
      if (SECRET_QUERY_KEY.test(key) || JWT_VALUE.test(value) || LONG_OPAQUE_VALUE.test(value)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function filterSensitiveClusters(clusters: Cluster[]): Cluster[] {
  return clusters
    .map((c) => {
      const visits = (c.visits || []).filter((v) => !isSensitiveUrl(v.url));
      return { ...c, visits };
    })
    .filter((c) => (c.visits || []).length > 0);
}

export function squashConsecutiveDuplicates(c: Cluster): Cluster {
  const visits = c.visits || [];
  if (visits.length <= 1) return c;
  const keep: Visit[] = [];
  for (const v of visits) {
    const prev = keep[keep.length - 1];
    if (!prev) {
      keep.push(v);
      continue;
    }
    const sameUrl = normalizeUrl(prev.url) === normalizeUrl(v.url);
    const gapMs = Math.abs(new Date(v.visited_at).getTime() - new Date(prev.visited_at).getTime());
    // Collapse rapid, same-URL repeats (Chrome often logs two close entries for the same click)
    if (sameUrl && gapMs <= DUPLICATE_SQUASH_MS) continue;
    keep.push(v);
  }
  return { ...c, visits: keep };
}

export function mergeClustersByOverlap(clusters: Cluster[]): Cluster[] {
  if (!clusters.length) return clusters;
  const uf = new UnionFind(clusters.length);

  const keyToCluster = new Map<string, number>();
  clusters.forEach((c, idx) => {
    (c.visits || []).forEach((v) => {
      const key = `${v.visited_at}|${v.url}`;
      const existing = keyToCluster.get(key);
      if (existing !== undefined) {
        uf.union(idx, existing);
      } else {
        keyToCluster.set(key, idx);
      }
    });
  });

  const mergedMap = new Map<number, Cluster>();
  clusters.forEach((c, idx) => {
    const root = uf.find(idx);
    const existing = mergedMap.get(root);
    if (!existing) {
      mergedMap.set(root, { ...c, visits: [...(c.visits || [])] });
    } else {
      existing.visits = [...(existing.visits || []), ...(c.visits || [])];
    }
  });

  const result: Cluster[] = [];
  mergedMap.forEach((c) => {
    const dedup = new Map<string, Visit>();
    (c.visits || []).forEach((v) => {
      const key = `${v.visited_at}|${v.url}`;
      if (!dedup.has(key)) dedup.set(key, v);
    });
    const visits = Array.from(dedup.values()).sort(
      (a, b) => new Date(a.visited_at).getTime() - new Date(b.visited_at).getTime()
    );
    result.push({ ...c, visits });
  });

  return result;
}

export function normalizeClusters(clusters: Cluster[]): Cluster[] {
  let normalized = mergeClustersByOverlap(clusters);
  normalized = normalized.map(squashConsecutiveDuplicates);
  return normalized.filter((c) => (c.visits || []).length >= MIN_VISITS_PER_JOURNEY);
}

export function clusterFingerprint(c: Cluster): string {
  const visits = c.visits || [];
  const first = visits[0];
  const last = visits[visits.length - 1];
  const anchors = visits
    .slice(0, 3)
    .map((v) => `${v.visited_at}|${v.url}`)
    .join("||");
  const tail = visits
    .slice(-2)
    .map((v) => `${v.visited_at}|${v.url}`)
    .join("||");
  return [visits.length, first?.visited_at ?? "", last?.visited_at ?? "", first?.url ?? "", last?.url ?? "", anchors, tail].join(
    "::"
  );
}

// Semantic-temporal clustering for history without Chrome's Journeys tables.
// A time window only makes adjacent visits candidates; shared topic language,
// a referrer chain, repeated search, or same-domain proximity supplies the
// evidence needed to join them.
export function clusterVisitsHeuristic(visits: Visit[]): Cluster[] {
  if (!visits.length) return [];
  const sorted = [...visits].sort((a, b) => new Date(a.visited_at).getTime() - new Date(b.visited_at).getTime());
  const uf = new UnionFind(sorted.length);
  const idToIdx = new Map<number, number>(sorted.map((v, i) => [v.id, i]));
  const lastBySearch = new Map<string, number>();
  const lastByDomain = new Map<string, number>();
  const topics = sorted.map(sessionTokens);

  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const t = new Date(v.visited_at).getTime();
    if (i > 0) {
      const gap = t - new Date(sorted[i - 1].visited_at).getTime();
      // Time creates a candidate, not an automatic merge. This prevents a
      // person switching from travel to finance to AI research in one sitting
      // from becoming a single journey.
      if (gap <= TOPIC_GAP_MS && sharesTopic(topics[i], topics[i - 1])) uf.union(i, i - 1);
    }
    if (v.from_visit !== undefined && idToIdx.has(v.from_visit)) {
      uf.union(i, idToIdx.get(v.from_visit)!);
    }
    if (v.search_term) {
      const prev = lastBySearch.get(v.search_term);
      if (prev !== undefined && t - new Date(sorted[prev].visited_at).getTime() <= SEARCH_GAP_MS) {
        uf.union(i, prev);
      }
      lastBySearch.set(v.search_term, i);
    }
    if (v.domain) {
      const prev = lastByDomain.get(v.domain);
      if (prev !== undefined && t - new Date(sorted[prev].visited_at).getTime() <= DOMAIN_GAP_MS) {
        // General-purpose hubs host many unrelated intents. Same-domain use
        // there is only evidence when the page/search topics also agree.
        if (!isGenericSessionDomain(v.domain) || sharesTopic(topics[i], topics[prev])) {
          uf.union(i, prev);
        }
      }
      lastByDomain.set(v.domain, i);
    }
  }

  const groups = new Map<number, Visit[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(sorted[i]);
  }

  const clusters: Cluster[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => new Date(a.visited_at).getTime() - new Date(b.visited_at).getTime());
    clusters.push({ cluster_id: clusters.length, visits: group });
  }
  clusters.sort(
    (a, b) => new Date(b.visits[0].visited_at).getTime() - new Date(a.visits[0].visited_at).getTime()
  );
  return clusters.map((c, idx) => ({ ...c, cluster_id: idx }));
}

// Full pipeline from raw clusters to annotated, deduped journeys.
export function prepareJourneys(raw: Cluster[], processedFingerprints: Set<string>): Cluster[] {
  let clusters = filterSensitiveClusters(raw);
  clusters = normalizeClusters(clusters);
  const annotated = clusters.map((c, idx) => {
    const withDefaults: Cluster = { ...c, cluster_id: c.cluster_id ?? idx };
    withDefaults.fingerprint = clusterFingerprint(withDefaults);
    return withDefaults;
  });
  return annotated.filter((c) => !processedFingerprints.has(c.fingerprint || ""));
}

export function clusterStart(c: Cluster): string | null {
  return c.visits[0]?.visited_at ?? null;
}

export function clusterEnd(c: Cluster): string | null {
  return c.visits[c.visits.length - 1]?.visited_at ?? null;
}
