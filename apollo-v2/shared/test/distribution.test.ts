import { describe, expect, it } from "vitest";
import {
  MIN_TASKS_FOR_GUIDANCE,
  pct,
  summarizeDistribution,
  type DistributionInput,
} from "../src/distribution";
import { REGION_GLOBAL } from "../src/taxonomy";

const IN = "Ecommerce & Shopping > Price Comparison";
const TRAVEL = "Travel and Tourism > Air Travel";
const HOTELS = "Travel and Tourism > Accommodation and Hotels";

function tasks(spec: Array<[string, string[]]>): DistributionInput[] {
  return spec.map(([region, subjects]) => ({ region, subjects }));
}

function repeat(n: number, region: string, subjects: string[] = [IN]): DistributionInput[] {
  return Array.from({ length: n }, () => ({ region, subjects }));
}

describe("summarizeDistribution", () => {
  it("counts shares over labelled tasks only", () => {
    const summary = summarizeDistribution([
      ...tasks([["IN", [IN]], ["IN", [IN]], [REGION_GLOBAL, [TRAVEL]]]),
      {}, // authored before the fields existed
      {},
    ]);

    expect(summary.labelled).toBe(3);
    expect(summary.unlabelled).toBe(2);
    expect(summary.regions.map((r) => [r.key, r.count])).toEqual([
      ["IN", 2],
      [REGION_GLOBAL, 1],
    ]);
    expect(summary.regions[0].share).toBeCloseTo(2 / 3);
    expect(summary.globalShare).toBeCloseTo(1 / 3);
  });

  it("names the largest country, not the location-agnostic bucket", () => {
    const summary = summarizeDistribution(repeat(5, REGION_GLOBAL).concat(repeat(2, "BR")));
    // GLOBAL is the biggest bucket, but it is not a country and is the thing we
    // want more of — reporting it as the concentration would be backwards.
    expect(summary.regions[0].key).toBe(REGION_GLOBAL);
    expect(summary.topRegion?.key).toBe("BR");
  });

  it("counts a subject group once even when two of its leaves are picked", () => {
    const summary = summarizeDistribution([{ region: "US", subjects: [TRAVEL, HOTELS] }]);
    expect(summary.subjects).toHaveLength(1);
    expect(summary.subjects[0]).toMatchObject({ key: "Travel and Tourism", count: 1, share: 1 });
  });

  it("ignores subjects outside the vocabulary", () => {
    const summary = summarizeDistribution([{ region: "US", subjects: ["Cricket > IPL"] }]);
    expect(summary.labelled).toBe(1); // region alone still labels it
    expect(summary.subjects).toEqual([]);
  });

  it("resolves a bare top-level subject label", () => {
    const summary = summarizeDistribution([{ subjects: ["News & Media Publishers"] }]);
    expect(summary.subjects[0].key).toBe("News & Media Publishers");
  });

  it("labels regions with their country name", () => {
    const summary = summarizeDistribution([{ region: "IN", subjects: [IN] }]);
    expect(summary.regions[0].label).toBe("India");
  });

  it("returns empty, not NaN, with nothing to summarize", () => {
    const summary = summarizeDistribution([]);
    expect(summary).toMatchObject({ labelled: 0, unlabelled: 0, globalShare: 0, topRegion: null, advice: null });
    expect(summary.regions).toEqual([]);
  });
});

describe("distribution advice", () => {
  it("stays quiet until there are enough tasks for a share to mean anything", () => {
    // Everything in one country, but too few to draw a conclusion from.
    const few = repeat(MIN_TASKS_FOR_GUIDANCE - 1, "IN");
    expect(summarizeDistribution(few).advice).toBeNull();
  });

  it("flags a single country over a third", () => {
    const summary = summarizeDistribution(repeat(7, "IN").concat(repeat(3, REGION_GLOBAL)));
    expect(summary.advice).toContain("India");
    expect(summary.advice).toContain("70%");
  });

  it("flags too few location-agnostic tasks once no country dominates", () => {
    // Spread across countries, so no single region trips the first rule.
    const summary = summarizeDistribution(
      repeat(3, "IN").concat(repeat(3, "BR"), repeat(3, "US"), repeat(1, REGION_GLOBAL))
    );
    expect(summary.topRegion!.share).toBeLessThanOrEqual(1 / 3);
    expect(summary.advice).toContain("no specific country");
  });

  it("flags a dominant subject once places are balanced", () => {
    const summary = summarizeDistribution(
      repeat(3, "IN", [IN]).concat(repeat(3, "BR", [IN]), repeat(4, REGION_GLOBAL, [IN]))
    );
    expect(summary.advice).toContain("Ecommerce & Shopping");
  });

  it("says nothing when the spread is healthy", () => {
    const summary = summarizeDistribution([
      ...repeat(2, "IN", [IN]),
      ...repeat(2, "BR", [TRAVEL]),
      ...repeat(2, "US", ["Health > Medicine"]),
      ...repeat(4, REGION_GLOBAL, ["Finance > Insurance"]),
    ]);
    expect(summary.topRegion!.share).toBeLessThanOrEqual(1 / 3);
    expect(summary.globalShare).toBeGreaterThanOrEqual(1 / 3);
    expect(summary.advice).toBeNull();
  });
});

describe("pct", () => {
  it("rounds to whole percentages", () => {
    expect(pct(0)).toBe("0%");
    expect(pct(1 / 3)).toBe("33%");
    expect(pct(1)).toBe("100%");
  });
});
