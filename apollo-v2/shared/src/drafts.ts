import type { Cluster, ThemeSuggestion } from "./types";
import { buildClusterFeatures, GENERIC_SITE_FAMILIES } from "./themes";
import { clusterEnd, clusterStart } from "./clustering";

// Nobody should face an empty request box: editing a draft is far cheaper
// than authoring one. History-backed modes get a draft written from the
// user's own sessions; blank-page mode gets a fill-in-the-blanks scaffold.
// [Bracketed] slots mark the parts only the author knows — validation blocks
// upload until they're replaced.

export const FREEFORM_SCAFFOLD =
  "I want to [do what?] by [when?]. Please [the concrete ask — what to find, compare, book, or apply to], " +
  "keeping in mind [constraints — budget, dates, places]. When it's done there should be " +
  "[the result — a plan, a booking, a ranked shortlist].";

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function titleCase(token: string): string {
  return token ? token[0].toUpperCase() + token.slice(1) : token;
}

export function draftFromJourneys(
  basket: Cluster[],
  theme?: ThemeSuggestion | null
): { title: string; request: string } {
  const familyCounts = new Map<string, number>();
  const tokenCounts = new Map<string, number>();
  const originals = new Map<string, string>();
  for (const c of basket) {
    const f = buildClusterFeatures(c);
    for (const fam of f.siteFamilies) {
      if (!GENERIC_SITE_FAMILIES.has(fam)) familyCounts.set(fam, (familyCounts.get(fam) || 0) + 1);
    }
    for (const tok of f.tokens) {
      tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + 1);
      const original = f.tokenOriginals.get(tok);
      if (original && !originals.has(tok)) originals.set(tok, original);
    }
  }
  const families = [...familyCounts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  // Prefer the theme's distinctive vocabulary when we have it; otherwise the
  // basket's most repeated tokens.
  const tokens = (theme?.shared_tokens?.length
    ? theme.shared_tokens
    : [...tokenCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([tok]) => originals.get(tok) ?? tok)
  ).slice(0, 3);

  const starts = basket.map((c) => clusterStart(c)).filter(Boolean).sort() as string[];
  const ends = basket.map((c) => clusterEnd(c)).filter(Boolean).sort() as string[];
  const start = starts[0] ?? null;
  const end = ends[ends.length - 1] ?? null;
  const spanDays =
    start && end ? Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / DAY_MS) + 1) : 0;
  const spanText =
    spanDays > 13
      ? `${Math.round(spanDays / 7)} weeks`
      : `${spanDays} day${spanDays === 1 ? "" : "s"}`;

  const familyList = families.slice(0, 3).join(", ") || "a few sites";
  const topicText = tokens.length ? ` working on ${tokens.join(", ")}` : "";
  const focus = families[0] ? ` on ${families.slice(0, 2).join(" and ")}` : "";

  const request =
    `Between ${fmtDate(start)} and ${fmtDate(end)} (about ${spanText}) I kept coming back to ${familyList}${topicText}. ` +
    `Pick this up and finish it for me: [what exactly should happen — compare options, book, apply, decide?]. ` +
    `Work${focus}, keep in mind [constraints — budget, dates, places], ` +
    `and when it's done there should be [the result — a plan, a booking, a ranked shortlist].`;

  const title = tokens.length
    ? `Finish my ${tokens.slice(0, 2).map(titleCase).join(" / ")} project`
    : families[0]
      ? `Finish what I started on ${families[0]}`
      : "";

  return { title, request };
}

export function hasUnfilledSlots(text: string): boolean {
  return /\[[^\]]*\]/.test(text);
}
