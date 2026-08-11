import type { Cluster, ThemeAlgo, ThemeSuggestion } from "./types";
import { clusterEnd, clusterFingerprint, clusterStart } from "./clustering";

// Theme extraction: find groups of journeys that were secretly one project.
//
// Starting point was the grouping heuristics in
// JourneysData/scripts/build_task_chains.py (site_family, tokenize/stem/clean,
// pair scoring at the 0.40 link threshold), with three upgrades aimed at
// surfacing *delegable projects* rather than any recurring activity:
//
//  1. IDF-weighted token overlap — a rare token shared between two sessions
//     ("fenway", "greenhouse") is strong evidence; a common one ("login",
//     "account") is nearly none.
//  2. Habitual-domain detection — a site family the user touches on most of
//     their active days is a routine, not a project, and is demoted to the
//     same weak tier as google/youtube. Projects are bursty and time-bounded;
//     habits recur forever.
//  3. Average-linkage agglomerative grouping over the sparse similarity graph
//     instead of single-linkage union-find, so themes can't chain-drift
//     (A~B, B~C pulling an unrelated A and C together).
//
// Runs entirely client-side; LLM refinement stays in the offline pipeline.

export const GENERIC_SITE_FAMILIES = new Set([
  "google.com",
  "bing.com",
  "youtube.com",
  "reddit.com",
  "amazon.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "wikipedia.org",
  // General-purpose AI assistants are used across unrelated projects. Their
  // presence is weak evidence, like a search engine, not a project identity.
  "chatgpt.com",
  "openai.com",
  "claude.ai",
  "perplexity.ai",
  "gemini.google.com",
]);

const TEXT_STOPWORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be", "best",
  "by", "can", "current", "do", "for", "from", "get", "go", "help", "how", "i",
  "if", "in", "into", "is", "it", "its", "latest", "list", "look", "looking",
  "me", "more", "my", "near", "need", "of", "on", "or", "out", "please",
  "price", "prices", "research", "review", "search", "searching", "see",
  "show", "tell", "that", "the", "their", "them", "to", "up", "using", "view",
  "what", "when", "where", "which", "who", "with", "you", "your",
  // web-noise additions for title/url token streams
  "www", "com", "http", "https", "html", "php", "index", "page", "home",
  "login", "sign", "account", "email", "inbox", "dashboard", "settings",
  // platform boilerplate and brand names of generic sites — these describe
  // where you were, not what you were doing
  "feed", "notification", "notifications", "messages", "trending", "explore",
  "profile", "following", "followers", "share", "shorts", "reel", "reels",
  "google", "youtube", "instagram", "facebook", "linkedin", "reddit",
  "amazon", "tiktok", "wikipedia", "bing", "twitter",
  "chatgpt", "openai", "claude", "gemini", "perplexity", "signin",
]);

const CONTENT_QUERY_KEYS = new Set([
  "q", "query", "search_query", "k", "keyword", "keywords", "term",
  "jobid", "id", "asin", "sku", "product", "hotel", "v",
]);

// Long-horizon projects resume after weeks — the window exists only to bound
// computation, not to encode a belief that related sessions must be close.
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const RECENCY_HALF_LIFE_DAYS = 60;
const LINK_THRESHOLD = 0.4;
// Pairs scoring below this are not even recorded as candidate edges.
const EDGE_FLOOR = 0.3;
const MAX_COMPARISONS_PER_CLUSTER = 200;
const MAX_PAIRS_PER_FAMILY = 400;
const MAX_PAIRS_PER_TOKEN = 200;
const BURST_WINDOW_DAYS = 4;
// Hard ceiling on scored pairs so a dense 1,500-cluster history can't stall
// the themes screen; passes fill in priority order (time, family, token).
const MAX_TOTAL_CANDIDATES = 60_000;
// Topic threads link on vocabulary alone, so their bar is on token overlap.
const TOPIC_THRESHOLD = 0.25;
const MAX_TOKENS_PER_CLUSTER = 12;
const SEARCH_TERM_WEIGHT = 3;
const HABITUAL_MIN_ACTIVE_DAYS = 6;
const HABITUAL_DAY_COVERAGE = 0.5;
const DEFAULT_MAX_SUGGESTIONS = 14;

// Hosting platforms where the subdomain IS the site — collapsing them to the
// registrable domain would merge every user's site into one fake family.
const HOSTED_SUFFIXES = new Set([
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "wordpress.com",
  "blogspot.com",
  "substack.com",
  "notion.site",
  "amazonaws.com",
]);

export function siteFamily(domain: string): string {
  const d = (domain || "").trim().toLowerCase();
  if (!d) return "";
  const parts = d.split(".");
  if (parts.length <= 2) return d;
  const lastTwo = parts.slice(-2).join(".");
  if (HOSTED_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  const secondLevel = parts[parts.length - 2];
  if (["co", "com", "org", "gov"].includes(secondLevel) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

// Unspaced CJK runs need word segmentation or they become one giant token.
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

export function tokenize(text: string): string[] {
  if (!text) return [];
  // Unicode-aware: Korean/Japanese/etc. titles must produce tokens too, not
  // silently degrade theme matching to site-families only.
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const tokens: string[] = [];
  for (const t of raw) {
    if (t.length > 3 && segmenter && CJK_RUN.test(t)) {
      for (const seg of segmenter.segment(t)) {
        if (seg.isWordLike && seg.segment.length > 1) tokens.push(seg.segment);
      }
    } else if (t.length > 1) {
      tokens.push(t);
    }
  }
  return tokens;
}

export function stemToken(token: string): string {
  // English suffix stripping only applies to ASCII tokens.
  if (!/^[a-z0-9]+$/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  for (const suffix of ["ing", "ers", "er", "ed", "es", "s"]) {
    if (token.length > 4 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

// Stem + filter a raw token; null when it's noise. The stem is the matching
// key — callers that show tokens to users should keep the original form too.
export function normalizeToken(original: string): string | null {
  // Check stopwords on BOTH forms: "using" stems to "us", which would
  // otherwise sneak past the list and contaminate df/co-occurrence stats.
  if (TEXT_STOPWORDS.has(original)) return null;
  const tok = stemToken(original);
  if (tok.length < 2 || TEXT_STOPWORDS.has(tok) || /^\d+$/.test(tok)) return null;
  // Short mixed letter/number fragments such as `3m1`, `1e2`, and `4d`
  // usually come from map coordinates, tracking IDs, or opaque URL paths.
  // Keep recognizable model/product tokens with at least three letters
  // (`gpt4`, `iphone15`, `cs231n`).
  const letterCount = tok.match(/\p{L}/gu)?.length ?? 0;
  const digitCount = tok.match(/\d/g)?.length ?? 0;
  if (digitCount > 0 && letterCount > 0 && letterCount < 3) return null;
  // Long digit-heavy slugs from URL paths (event codes, hashes) are noise,
  // while recognizable names such as iphone15 and cs231n remain useful.
  if (tok.length >= 8 && digitCount >= 4 && digitCount >= letterCount) return null;
  if (tok.length > 20) return null;
  return tok;
}

export function cleanTokens(tokens: Iterable<string>): string[] {
  const cleaned: string[] = [];
  for (const token of tokens) {
    const tok = normalizeToken(token);
    if (tok) cleaned.push(tok);
  }
  return cleaned;
}

export function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return (2 * shared) / (left.size + right.size);
}

export type ClusterFeatures = {
  fingerprint: string;
  siteFamilies: Set<string>;
  primaryFamily: string;
  tokens: Set<string>;
  // stem -> the original surface form, for display ("venue", not "venu")
  tokenOriginals: Map<string, string>;
  midTime: number;
  day: string;
  start: string | null;
  end: string | null;
};

function urlTokens(url: string): string[] {
  try {
    const u = new URL(url);
    const out: string[] = [];
    for (const seg of u.pathname.split("/")) {
      out.push(...tokenize(safeDecode(seg)));
    }
    u.searchParams.forEach((value, key) => {
      if (CONTENT_QUERY_KEYS.has(key.toLowerCase())) {
        out.push(...tokenize(safeDecode(value)));
      }
    });
    return out;
  } catch {
    return [];
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function buildClusterFeatures(c: Cluster): ClusterFeatures {
  const familyCounts = new Map<string, number>();
  const tokenCounts = new Map<string, number>();
  const tokenOriginals = new Map<string, string>();

  const addTokens = (tokens: string[], weight: number) => {
    for (const original of tokens) {
      const tok = normalizeToken(original);
      if (!tok) continue;
      tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + weight);
      if (!tokenOriginals.has(tok)) tokenOriginals.set(tok, original.toLowerCase());
    }
  };

  for (const v of c.visits || []) {
    const family = siteFamily(v.domain || hostOf(v.url));
    if (family) familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
    addTokens(tokenize(v.title || ""), 1);
    addTokens(tokenize(v.url ? urlTokens(v.url).join(" ") : ""), 1);
    // Typed search terms are the clearest statement of intent in the history.
    addTokens(tokenize(v.search_term || ""), SEARCH_TERM_WEIGHT);
  }

  const nonGeneric = [...familyCounts.entries()].filter(([f]) => !GENERIC_SITE_FAMILIES.has(f));
  const primaryFamily = (nonGeneric.length ? nonGeneric : [...familyCounts.entries()])
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  const topTokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOKENS_PER_CLUSTER)
    .map(([tok]) => tok);

  const start = clusterStart(c);
  const end = clusterEnd(c);
  const startMs = start ? new Date(start).getTime() : 0;
  const endMs = end ? new Date(end).getTime() : startMs;

  return {
    fingerprint: c.fingerprint || clusterFingerprint(c),
    siteFamilies: new Set(familyCounts.keys()),
    primaryFamily,
    tokens: new Set(topTokens),
    tokenOriginals,
    midTime: (startMs + endMs) / 2,
    day: (start || "").slice(0, 10),
    start,
    end,
  };
}

type CorpusStats = {
  idf: Map<string, number>;
  df: Map<string, number>;
  // A token is "strong" (topic-grade) if it appears in at most this many
  // clusters. Median-IDF is the wrong bar here: singletons dominate any
  // vocabulary, and a *shared* token always has df >= 2, so nearly nothing
  // shared would ever clear a singleton-dominated median.
  strongDfCap: number;
  // Co-occurrence counts between strong tokens ("kbo|tigers" -> #clusters
  // containing both) — lightweight semantic relatedness without embeddings.
  cooc: Map<string, number>;
  habitualFamilies: Set<string>;
};

const coocKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const RELATED_MIN_COOC = 3;

function buildCorpusStats(features: ClusterFeatures[]): CorpusStats {
  const df = new Map<string, number>();
  const familyDays = new Map<string, Set<string>>();
  const activeDays = new Set<string>();

  for (const f of features) {
    if (f.day) activeDays.add(f.day);
    for (const tok of f.tokens) df.set(tok, (df.get(tok) || 0) + 1);
    for (const fam of f.siteFamilies) {
      if (!familyDays.has(fam)) familyDays.set(fam, new Set());
      if (f.day) familyDays.get(fam)!.add(f.day);
    }
  }

  const n = features.length;
  const idf = new Map<string, number>();
  for (const [tok, count] of df) {
    idf.set(tok, Math.log(1 + n / count));
  }
  const strongDfCap = Math.max(3, Math.ceil(n * 0.15));

  const cooc = new Map<string, number>();
  for (const f of features) {
    const strong = [...f.tokens].filter((t) => (df.get(t) ?? Infinity) <= strongDfCap);
    for (let a = 0; a < strong.length; a++) {
      for (let b = a + 1; b < strong.length; b++) {
        const key = coocKey(strong[a], strong[b]);
        cooc.set(key, (cooc.get(key) || 0) + 1);
      }
    }
  }

  // A family the user touches on most active days is a routine, not a project.
  const habitualFamilies = new Set<string>();
  if (activeDays.size >= HABITUAL_MIN_ACTIVE_DAYS) {
    for (const [fam, days] of familyDays) {
      if (days.size / activeDays.size >= HABITUAL_DAY_COVERAGE) habitualFamilies.add(fam);
    }
  }

  return { idf, df, strongDfCap, cooc, habitualFamilies };
}

// Semantic-ish relatedness: count cross pairs of strong tokens that co-occur
// in enough OTHER clusters ("kbo" in one session, "tigers" in the other).
function relatedStrongPairCount(a: ClusterFeatures, b: ClusterFeatures, stats: CorpusStats): number {
  let related = 0;
  for (const ta of a.tokens) {
    if ((stats.df.get(ta) ?? Infinity) > stats.strongDfCap) continue;
    for (const tb of b.tokens) {
      if (ta === tb) continue;
      if ((stats.df.get(tb) ?? Infinity) > stats.strongDfCap) continue;
      if ((stats.cooc.get(coocKey(ta, tb)) || 0) >= RELATED_MIN_COOC) related++;
    }
  }
  return related;
}

function idfOverlap(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  let sumA = 0;
  let sumB = 0;
  for (const tok of a) {
    const w = idf.get(tok) || 0;
    sumA += w;
    if (b.has(tok)) shared += w;
  }
  for (const tok of b) sumB += idf.get(tok) || 0;
  if (!sumA || !sumB) return 0;
  return (2 * shared) / (sumA + sumB);
}

function isWeakFamily(family: string, stats: CorpusStats): boolean {
  return GENERIC_SITE_FAMILIES.has(family) || stats.habitualFamilies.has(family);
}

function familyOverlapScore(a: ClusterFeatures, b: ClusterFeatures, stats: CorpusStats): number {
  if (
    a.primaryFamily &&
    a.primaryFamily === b.primaryFamily &&
    !isWeakFamily(a.primaryFamily, stats)
  ) {
    return 1.0;
  }
  for (const f of a.siteFamilies) {
    if (!isWeakFamily(f, stats) && b.siteFamilies.has(f)) return 0.5;
  }
  for (const f of a.siteFamilies) if (b.siteFamilies.has(f)) return 0.15;
  return 0;
}

function sharedStrongTokenCount(a: ClusterFeatures, b: ClusterFeatures, stats: CorpusStats): number {
  // Rare-enough vocabulary; stops habitual wording from carrying a link alone.
  let shared = 0;
  for (const tok of a.tokens) {
    if (b.tokens.has(tok) && (stats.df.get(tok) ?? Infinity) <= stats.strongDfCap) shared++;
  }
  return shared;
}

type Edge = { a: number; b: number; score: number };

export function suggestThemes(clusters: Cluster[], maxSuggestions = DEFAULT_MAX_SUGGESTIONS): ThemeSuggestion[] {
  if (clusters.length < 2) return [];
  const features = clusters.map(buildClusterFeatures);
  const stats = buildCorpusStats(features);
  const order = features
    .map((_, i) => i)
    .sort((a, b) => features[a].midTime - features[b].midTime);

  // Candidate pairs come from two passes so distant sessions of the same
  // project are never starved out by dense intervening browsing:
  //  1. a chronological neighbor scan (token-based links), and
  //  2. an index by primary site family, pairing every same-family session
  //     inside the window regardless of how much browsing sits between them.
  const seenPairs = new Set<string>();
  const candidates: Array<[number, number]> = [];
  // Per-source budgets so a dense chronological pass can never starve the
  // family/token indexes out of the global candidate ceiling.
  const addCandidate = (i: number, j: number, budget: number): boolean => {
    if (i === j || candidates.length >= budget) return false;
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    candidates.push([i, j]);
    return true;
  };
  const CHRONO_BUDGET = Math.floor(MAX_TOTAL_CANDIDATES * 0.6);
  const FAMILY_BUDGET = Math.floor(MAX_TOTAL_CANDIDATES * 0.85);

  for (let oi = 0; oi < order.length; oi++) {
    let comparisons = 0;
    for (let oj = oi + 1; oj < order.length && comparisons < MAX_COMPARISONS_PER_CLUSTER; oj++) {
      if (features[order[oj]].midTime - features[order[oi]].midTime > WINDOW_MS) break;
      comparisons++;
      addCandidate(order[oi], order[oj], CHRONO_BUDGET);
    }
  }

  const byFamily = new Map<string, number[]>();
  for (const i of order) {
    const fam = features[i].primaryFamily;
    if (!fam || isWeakFamily(fam, stats)) continue;
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam)!.push(i);
  }
  for (const members of byFamily.values()) {
    let pairs = 0;
    for (let a = 0; a < members.length && pairs < MAX_PAIRS_PER_FAMILY; a++) {
      for (let b = a + 1; b < members.length && pairs < MAX_PAIRS_PER_FAMILY; b++) {
        if (features[members[b]].midTime - features[members[a]].midTime > WINDOW_MS) break;
        if (addCandidate(members[a], members[b], FAMILY_BUDGET)) pairs++;
      }
    }
  }

  // Third candidate source: an index by strong token, so cross-site projects
  // (trip planning spread over mlb.com + expedia + booking) get compared even
  // when they share no site family and sit far apart chronologically.
  const byToken = new Map<string, number[]>();
  for (const i of order) {
    for (const tok of features[i].tokens) {
      if ((stats.df.get(tok) ?? Infinity) > stats.strongDfCap) continue;
      if (!byToken.has(tok)) byToken.set(tok, []);
      byToken.get(tok)!.push(i);
    }
  }
  for (const members of byToken.values()) {
    if (members.length < 2 || members.length > 40) continue; // ubiquitous tokens are not topics
    let pairs = 0;
    for (let a = 0; a < members.length && pairs < MAX_PAIRS_PER_TOKEN; a++) {
      for (let b = a + 1; b < members.length && pairs < MAX_PAIRS_PER_TOKEN; b++) {
        if (features[members[b]].midTime - features[members[a]].midTime > WINDOW_MS) break;
        if (addCandidate(members[a], members[b], MAX_TOTAL_CANDIDATES)) pairs++;
      }
    }
  }

  // ---- Algorithm 1: cohesion (family + vocabulary + mild recency) ----
  const cohesionEdges: Edge[] = [];
  // ---- Algorithm 2: topic threads (shared/related rare vocabulary, site-agnostic) ----
  const topicEdges: Edge[] = [];
  // ---- Algorithm 4: temporal bursts (tight window, any shared signal) ----
  const burstEdges: Edge[] = [];
  for (const [i, j] of candidates) {
    const fi = features[i];
    const fj = features[j];
    const famScore = familyOverlapScore(fi, fj, stats);
    const tokScore = idfOverlap(fi.tokens, fj.tokens, stats.idf);
    // Content decides whether sessions belong together; elapsed time is only
    // a mild tiebreaker, so a thread resuming after six weeks still links.
    const gapDays = Math.abs(fj.midTime - fi.midTime) / (24 * 60 * 60 * 1000);
    const recency = Math.exp(-gapDays / RECENCY_HALF_LIFE_DAYS);
    const score = 0.5 * famScore + 0.4 * tokScore + 0.1 * recency;

    const strongFamily = famScore >= 0.5;
    const directStrong = sharedStrongTokenCount(fi, fj, stats);
    const strongTokens = directStrong >= 2;
    // A shared site is not enough to connect two distant sessions. Require
    // either topical evidence or a reasonably tight time window; this keeps
    // separate projects on the same marketplace/tool from collapsing.
    const supportedFamily = strongFamily && (gapDays <= 14 || directStrong >= 2 || tokScore >= 0.2);
    if (score >= EDGE_FLOOR && (supportedFamily || strongTokens)) {
      cohesionEdges.push({ a: i, b: j, score });
    }
    // Topic threads are for CROSS-site projects — same-site vocabulary links
    // are already owned by the cohesion pass and mostly amplify a
    // single site's boilerplate (feeds, notifications) into fake topics.
    // Semantic expansion: one direct rare token plus enough co-occurrence-
    // related pairs ("kbo" here, "tigers" there) also qualifies.
    const crossSite = !fi.primaryFamily || !fj.primaryFamily || fi.primaryFamily !== fj.primaryFamily;
    const semantically =
      strongTokens || (directStrong >= 1 && relatedStrongPairCount(fi, fj, stats) >= 2);
    if (semantically && crossSite) {
      topicEdges.push({ a: i, b: j, score: tokScore });
    }
    // Temporal bursts: within a few days, one shared rare token counts — a
    // weekend of organizing spans sites whose pairwise similarity is too weak
    // for the other matchers but which are obviously one arc together.
    // (Same-family links are deliberately excluded: they chain everyday
    // browsing into mega-components and belong to cohesion anyway.)
    if (gapDays <= BURST_WINDOW_DAYS && directStrong >= 1 && crossSite) {
      burstEdges.push({ a: i, b: j, score });
    }
  }

  const cohesionGroups = agglomerate(cohesionEdges, LINK_THRESHOLD);
  const topicGroups = agglomerate(topicEdges, TOPIC_THRESHOLD);
  // Bursts use plain connected components: temporal locality bounds drift,
  // and the point is to capture the whole arc, not to be conservative.
  const burstGroups = connectedComponents(burstEdges);

  // Merge the three passes: precision first, dedupe near-identical member
  // sets, and label each surviving suggestion with the algorithm that found it.
  const suggestions: ThemeSuggestion[] = [];
  const keptSets: Set<string>[] = [];
  const membersOf = new Map<ThemeSuggestion, number[]>();
  const tryAdd = (group: Group, algo: ThemeAlgo) => {
    const suggestion = buildSuggestion(group, features, stats, algo);
    if (!suggestion) return;
    const set = new Set(suggestion.cluster_fingerprints);
    for (const seen of keptSets) {
      if (jaccard(set, seen) >= 0.6) return;
    }
    keptSets.push(set);
    membersOf.set(suggestion, group.members);
    suggestions.push(suggestion);
  };
  for (const g of cohesionGroups) tryAdd(g, "cohesion");
  for (const g of topicGroups) tryAdd(g, "topic");
  // Bursts last (lowest precision), and only arc-sized ones — connected
  // components drift at scale, and a months-long "burst" is a contradiction.
  for (const g of burstGroups) {
    if (g.members.length < 3 || g.members.length > 15) continue;
    const times = g.members.map((i) => features[i].midTime);
    const spanDays = (Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000);
    if (spanDays > 10) continue;
    tryAdd(g, "burst");
  }

  // ---- Second-level chaining: group related themes into meta-projects ----
  // Two themes belong together when their members' rare vocabularies overlap
  // directly ("kbo" in both) or via co-occurrence relatedness ("kia"~"kbo").
  suggestions.sort((a, b) => b.score - a.score);
  const visible = suggestions.slice(0, maxSuggestions);

  // Chain the DISPLAYED themes into meta-projects. A theme's identity
  // vocabulary: rare tokens appearing in at least two of its member sessions.
  // Two themes chain on >=2 shared identity tokens, or a single bridge only
  // when it's entity-grade ("kia", "colm") — common verbs ("add", "use")
  // bridge everything and mean nothing.
  const identityDfCap = Math.max(4, Math.ceil(features.length * 0.03));
  const entityDfCap = Math.max(3, Math.ceil(features.length * 0.01));
  const themeTokens = visible.map((s) => {
    const counts = new Map<string, number>();
    for (const i of membersOf.get(s) ?? []) {
      for (const tok of features[i].tokens) {
        if ((stats.df.get(tok) ?? Infinity) <= identityDfCap) counts.set(tok, (counts.get(tok) || 0) + 1);
      }
    }
    return new Set([...counts.entries()].filter(([, c]) => c >= 2).map(([t]) => t));
  });
  const groupEdges: Edge[] = [];
  for (let a = 0; a < visible.length; a++) {
    for (let b = a + 1; b < visible.length; b++) {
      const shared = [...themeTokens[a]].filter((tok) => themeTokens[b].has(tok));
      const entityBridge =
        shared.length === 1 &&
        shared[0].length >= 3 &&
        (stats.df.get(shared[0]) ?? Infinity) <= entityDfCap;
      if (shared.length >= 2 || entityBridge) {
        groupEdges.push({ a, b, score: shared.length });
      }
    }
  }
  const threadComponents = connectedComponents(groupEdges);
  visible.forEach((s, i) => (s.thread_group = i));
  threadComponents.forEach((component, gi) => {
    // A "group" spanning most of the list is chaining, not a meta-project.
    if (component.members.length > 6) return;
    for (const idx of component.members) visible[idx].thread_group = visible.length + gi;
  });

  return visible;
}

// Plain connected components over an edge list (used by the burst pass).
function connectedComponents(edges: Edge[]): Group[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const byRoot = new Map<number, Group>();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!byRoot.has(root)) byRoot.set(root, { members: [], edgeScores: [] });
    byRoot.get(root)!.members.push(key);
  }
  for (const e of edges) {
    byRoot.get(find(e.a))!.edgeScores.push(e.score);
  }
  return [...byRoot.values()];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

function buildSuggestion(
  group: Group,
  features: ClusterFeatures[],
  stats: CorpusStats,
  algo: ThemeAlgo
): ThemeSuggestion | null {
  if (group.members.length < 2) return null;
  const memberFeatures = group.members.map((i) => features[i]);
  const distinctDays = new Set(memberFeatures.map((f) => f.day).filter(Boolean)).size;
  // Single-day groups are ordinary sessions, not long-horizon material.
  if (distinctDays < 2) return null;

  // For the agglomerative passes, normalize by ALL member pairs (matching how
  // agglomeration treats missing edges as zero) so sparse groups aren't
  // inflated; site/burst groups have no meaningful pair census, so use the
  // plain edge mean there.
  const possiblePairs = (group.members.length * (group.members.length - 1)) / 2;
  const edgeSum = group.edgeScores.reduce((a, b) => a + b, 0);
  const meanScore = !group.edgeScores.length
    ? LINK_THRESHOLD
    : algo === "cohesion" || algo === "topic"
      ? edgeSum / possiblePairs
      : edgeSum / group.edgeScores.length;
  // Reward threads that persist across weeks — the long tail is the point.
  const starts = memberFeatures.map((f) => f.start).filter(Boolean) as string[];
  const ends = memberFeatures.map((f) => f.end).filter(Boolean) as string[];
  const spanMs =
    starts.length && ends.length
      ? new Date([...ends].sort()[ends.length - 1]).getTime() - new Date([...starts].sort()[0]).getTime()
      : 0;
  const spanWeeks = Math.max(0, spanMs / (7 * 24 * 60 * 60 * 1000));
  const groupScore =
    meanScore *
    Math.log2(1 + group.members.length) *
    (1 + 0.15 * Math.min(distinctDays, 7)) *
    (1 + 0.1 * Math.min(spanWeeks, 8));

  // Rank shared tokens by IDF so the theme is named by its distinctive
  // vocabulary, not its most common one.
  const tokenCounts = new Map<string, number>();
  for (const f of memberFeatures) {
    for (const tok of f.tokens) tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + 1);
  }
  // Show the most common surface form of each stem ("venue", not "venu").
  const displayForm = (stem: string): string => {
    const counts = new Map<string, number>();
    for (const f of memberFeatures) {
      const original = f.tokenOriginals.get(stem);
      if (original) counts.set(original, (counts.get(original) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? stem;
  };
  const sharedTokens = [...tokenCounts.entries()]
    .filter(([, count]) => count >= Math.max(2, Math.ceil(group.members.length / 2)))
    .sort((a, b) => (stats.idf.get(b[0]) || 0) * b[1] - (stats.idf.get(a[0]) || 0) * a[1])
    .slice(0, 4)
    .map(([tok]) => displayForm(tok));

  const familyCounts = new Map<string, number>();
  for (const f of memberFeatures) {
    for (const fam of f.siteFamilies) {
      if (!isWeakFamily(fam, stats)) familyCounts.set(fam, (familyCounts.get(fam) || 0) + 1);
    }
  }
  let siteFamilies = [...familyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([fam]) => fam);
  if (!siteFamilies.length) {
    // All member sites are generic/habitual — still show where it happened.
    const allFams = new Map<string, number>();
    for (const f of memberFeatures) {
      for (const fam of f.siteFamilies) allFams.set(fam, (allFams.get(fam) || 0) + 1);
    }
    siteFamilies = [...allFams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([fam]) => fam);
  }

  return {
    theme_id: `theme-${algo}-${group.members[0]}-${group.members.length}`,
    algo,
    thread_group: -1,
    score: Number(groupScore.toFixed(3)),
    shared_tokens: sharedTokens,
    site_families: siteFamilies,
    cluster_fingerprints: memberFeatures.map((f) => f.fingerprint),
    start: starts.length ? [...starts].sort()[0] : null,
    end: ends.length ? [...ends].sort()[ends.length - 1] : null,
    distinct_days: distinctDays,
  };
}

type Group = { members: number[]; edgeScores: number[] };

// Average-linkage agglomerative clustering over the sparse edge graph.
// Groups merge only while the *average* similarity across all cross-pairs
// (missing edges count as 0) stays above the link threshold, so one bridging
// session cannot chain two unrelated projects together.
function agglomerate(edges: Edge[], threshold: number = LINK_THRESHOLD): Group[] {
  const groupOf = new Map<number, number>();
  const groups = new Map<number, Group>();
  const involved = new Set<number>();
  for (const e of edges) {
    involved.add(e.a);
    involved.add(e.b);
  }
  let nextId = 0;
  for (const i of involved) {
    const id = nextId++;
    groupOf.set(i, id);
    groups.set(id, { members: [i], edgeScores: [] });
  }

  const edgeKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairScore = new Map<string, number>();
  for (const e of edges) pairScore.set(edgeKey(e.a, e.b), e.score);

  const groupSim = (ga: Group, gb: Group): { mean: number; scores: number[] } => {
    const scores: number[] = [];
    let total = 0;
    for (const a of ga.members) {
      for (const b of gb.members) {
        const s = pairScore.get(edgeKey(a, b));
        if (s !== undefined) {
          scores.push(s);
          total += s;
        }
      }
    }
    const pairs = ga.members.length * gb.members.length;
    return { mean: pairs ? total / pairs : 0, scores };
  };

  // Candidate merges only exist where at least one edge crosses the groups.
  for (;;) {
    let best: { a: number; b: number; mean: number; scores: number[] } | null = null;
    const seen = new Set<string>();
    for (const e of edges) {
      const ga = groupOf.get(e.a)!;
      const gb = groupOf.get(e.b)!;
      if (ga === gb) continue;
      const key = edgeKey(ga, gb);
      if (seen.has(key)) continue;
      seen.add(key);
      const { mean, scores } = groupSim(groups.get(ga)!, groups.get(gb)!);
      if (mean >= threshold && (!best || mean > best.mean)) {
        best = { a: ga, b: gb, mean, scores };
      }
    }
    if (!best) break;
    const ga = groups.get(best.a)!;
    const gb = groups.get(best.b)!;
    const merged: Group = {
      members: [...ga.members, ...gb.members],
      edgeScores: [...ga.edgeScores, ...gb.edgeScores, ...best.scores],
    };
    groups.delete(best.a);
    groups.delete(best.b);
    const id = nextId++;
    groups.set(id, merged);
    for (const m of merged.members) groupOf.set(m, id);
  }

  return [...groups.values()];
}
