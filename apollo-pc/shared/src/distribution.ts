import { normalizeSubject, REGION_GLOBAL, regionShortLabel, subjectTop } from "./taxonomy";

export const MAX_SINGLE_REGION_SHARE = 1 / 3;
export const MIN_GLOBAL_SHARE = 1 / 3;
export const MIN_TASKS_FOR_GUIDANCE = 8;

export type Share = { key: string; label: string; count: number; share: number };
export type DistributionInput = { region?: string; subjects?: string[] };

export type DistributionSummary = {
  labelled: number;
  unlabelled: number;
  regions: Share[];
  subjects: Share[];
  topRegion: Share | null;
  globalShare: number;
  advice: string | null;
};

function shares(counts: Map<string, number>, total: number, label: (key: string) => string): Share[] {
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
    const subjects = (entry.subjects ?? []).flatMap((subject) => {
      const canonical = normalizeSubject(subject);
      return canonical ? [canonical] : [];
    });
    if (!region && !subjects.length) continue;
    labelled += 1;
    if (region) regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    for (const top of new Set(subjects.map(subjectTop))) {
      subjectCounts.set(top, (subjectCounts.get(top) ?? 0) + 1);
    }
  }

  const regions = shares(regionCounts, labelled, regionShortLabel);
  const subjects = shares(subjectCounts, labelled, (key) => key);
  const topRegion = regions.find((region) => region.key !== REGION_GLOBAL) ?? null;
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
    return `${pct(input.globalShare)} of your tasks have no specific country. Aim for about a third.`;
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
