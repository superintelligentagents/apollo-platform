import { normalizeSubject, REGION_GLOBAL, regionShortLabel, subjectTop } from "./taxonomy";

// Turning the region and subject picks into something an author can act on.
//
// The collection guidance asks each contributor to keep any one country to
// roughly a third of their own output and to leave roughly a third with no
// country at all. Nobody can follow a rule they cannot see, and the reporting
// feed is metadata-only and team-wide — so this computes the same shares from
// the local upload log, which is the only record of an author's own history.
//
// Deliberately expressed as "your largest single region" rather than "your home
// country": we never ask where a contributor lives, and inferring it from their
// submissions would be both presumptuous and wrong for anyone already spreading
// their work. Concentration is the thing that matters, wherever it points.

export const MAX_SINGLE_REGION_SHARE = 1 / 3;
export const MIN_GLOBAL_SHARE = 1 / 3;

// Below this, shares are noise — three tasks in a row on one subject is a
// coincidence, not a pattern, and nagging about it would train people to
// ignore the panel.
export const MIN_TASKS_FOR_GUIDANCE = 8;

export type Share = { key: string; label: string; count: number; share: number };

// The minimum a record needs to be counted. Kept structural so this works for
// both the local upload log and a server-side submission row — callers decide
// what counts as an authored task before handing it over.
export type DistributionInput = { region?: string; subjects?: string[] };

export type DistributionSummary = {
  /** Authored tasks carrying region/subject metadata. */
  labelled: number;
  /** Authored tasks with no metadata — submitted before the fields existed. */
  unlabelled: number;
  regions: Share[];
  subjects: Share[];
  /** Largest single country, excluding the location-agnostic bucket. */
  topRegion: Share | null;
  globalShare: number;
  /** Null until there are enough tasks for a share to mean anything. */
  advice: string | null;
};

function shares(counts: Map<string, number>, total: number, label: (k: string) => string): Share[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: label(key), count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"));
}

export function summarizeDistribution(authored: readonly DistributionInput[]): DistributionSummary {
  const regionCounts = new Map<string, number>();
  const subjectCounts = new Map<string, number>();
  let labelled = 0;

  for (const entry of authored) {
    const region = entry.region;
    const subjects = (entry.subjects ?? []).flatMap((s) => {
      const canonical = normalizeSubject(s);
      return canonical ? [canonical] : [];
    });
    if (!region && !subjects.length) continue;
    labelled += 1;
    if (region) regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    // Counted at the group level: a task tagged two leaves inside one group is
    // one task's worth of that subject, not two.
    for (const top of new Set(subjects.map(subjectTop))) {
      subjectCounts.set(top, (subjectCounts.get(top) ?? 0) + 1);
    }
  }

  const regions = shares(regionCounts, labelled, regionShortLabel);
  const subjects = shares(subjectCounts, labelled, (k) => k);
  const topRegion = regions.find((r) => r.key !== REGION_GLOBAL) ?? null;
  const globalShare = labelled ? (regionCounts.get(REGION_GLOBAL) ?? 0) / labelled : 0;

  return {
    labelled,
    unlabelled: authored.length - labelled,
    regions,
    subjects,
    topRegion,
    globalShare,
    advice: adviceFor({ labelled, topRegion, globalShare, subjects }),
  };
}

// One line, or none. A panel that always scolds gets tuned out, so this returns
// the single most useful nudge and stays quiet when the spread is fine.
function adviceFor(input: {
  labelled: number;
  topRegion: Share | null;
  globalShare: number;
  subjects: Share[];
}): string | null {
  if (input.labelled < MIN_TASKS_FOR_GUIDANCE) return null;

  if (input.topRegion && input.topRegion.share > MAX_SINGLE_REGION_SHARE) {
    return `${pct(input.topRegion.share)} of your tasks are set in ${input.topRegion.label}. Aim for about a third or less from any one country.`;
  }
  if (input.globalShare < MIN_GLOBAL_SHARE) {
    return `${pct(input.globalShare)} of your tasks have no specific country. Aim for about a third — these are the easiest to keep working everywhere.`;
  }
  const topSubject = input.subjects[0];
  if (topSubject && topSubject.share > 0.5) {
    return `${pct(topSubject.share)} of your tasks are ${topSubject.label}. Try a subject you have not covered yet.`;
  }
  return null;
}

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
