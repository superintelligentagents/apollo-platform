import { describe, expect, it } from "vitest";
import {
  clusterFingerprint,
  clusterVisitsHeuristic,
  filterSensitiveClusters,
  mergeClustersByOverlap,
  normalizeClusters,
  prepareJourneys,
  sanitizeHistoryUrl,
  squashConsecutiveDuplicates,
} from "../src/clustering";
import { chromeTimeToIso } from "../src/chrome-time";
import { cluster, visit } from "./fixtures";

describe("chromeTimeToIso", () => {
  it("converts Chrome microseconds since 1601 to ISO", () => {
    // 2020-01-01T00:00:00Z in Chrome time: (2020 epoch ms - 1601 epoch ms) * 1000
    const chromeUs = (Date.UTC(2020, 0, 1) - Date.UTC(1601, 0, 1)) * 1000;
    expect(chromeTimeToIso(chromeUs)).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("filterSensitiveClusters", () => {
  it("drops prolific/gusto visits and empty clusters", () => {
    const clusters = [
      cluster(1, [
        visit("https://app.prolific.com/studies", "2026-01-01T00:00:00.000Z"),
        visit("https://example.com/a", "2026-01-01T00:01:00.000Z"),
      ]),
      cluster(2, [visit("https://gusto.com/payroll", "2026-01-01T00:02:00.000Z")]),
    ];
    const result = filterSensitiveClusters(clusters);
    expect(result).toHaveLength(1);
    expect(result[0].visits.map((v) => v.url)).toEqual(["https://example.com/a"]);
  });
});

describe("sanitizeHistoryUrl", () => {
  it("removes credentials, fragments, and secret parameters while preserving useful queries", () => {
    const clean = sanitizeHistoryUrl(
      "https://user:pass@example.com/search?q=seoul+hotels&access_token=abc123&X-Amz-Signature=deadbeef#private"
    );
    expect(clean).toBe("https://example.com/search?q=seoul+hotels");
  });

  it("drops sensitive and non-web destinations", () => {
    expect(sanitizeHistoryUrl("https://app.prolific.com/studies?id=4")).toBeNull();
    expect(sanitizeHistoryUrl("chrome://extensions")).toBeNull();
  });
});

describe("squashConsecutiveDuplicates", () => {
  it("collapses same-URL visits within 5 seconds", () => {
    const c = cluster(1, [
      visit("https://example.com/a", "2026-01-01T00:00:00.000Z"),
      visit("https://example.com/a?utm=x", "2026-01-01T00:00:03.000Z"),
      visit("https://example.com/a", "2026-01-01T00:01:00.000Z"),
    ]);
    const result = squashConsecutiveDuplicates(c);
    expect(result.visits).toHaveLength(2);
  });
});

describe("mergeClustersByOverlap", () => {
  it("merges clusters sharing an identical visit", () => {
    const shared = visit("https://example.com/shared", "2026-01-01T00:05:00.000Z");
    const clusters = [
      cluster(1, [visit("https://example.com/a", "2026-01-01T00:00:00.000Z"), shared]),
      cluster(2, [{ ...shared }, visit("https://example.com/b", "2026-01-01T00:10:00.000Z")]),
      cluster(3, [visit("https://other.com/c", "2026-01-02T00:00:00.000Z")]),
    ];
    const result = mergeClustersByOverlap(clusters);
    expect(result).toHaveLength(2);
    const merged = result.find((c) => c.visits.length === 3);
    expect(merged).toBeDefined();
    // deduped and sorted chronologically
    expect(merged!.visits.map((v) => v.url)).toEqual([
      "https://example.com/a",
      "https://example.com/shared",
      "https://example.com/b",
    ]);
  });
});

describe("normalizeClusters", () => {
  it("drops clusters with fewer than 3 visits", () => {
    const clusters = [
      cluster(1, [
        visit("https://example.com/a", "2026-01-01T00:00:00.000Z"),
        visit("https://example.com/b", "2026-01-01T00:01:00.000Z"),
      ]),
      cluster(2, [
        visit("https://example.com/c", "2026-01-02T00:00:00.000Z"),
        visit("https://example.com/d", "2026-01-02T00:01:00.000Z"),
        visit("https://example.com/e", "2026-01-02T00:02:00.000Z"),
      ]),
    ];
    const result = normalizeClusters(clusters);
    expect(result).toHaveLength(1);
    expect(result[0].cluster_id).toBe(2);
  });
});

describe("clusterFingerprint", () => {
  it("is stable for identical visit sequences and distinct otherwise", () => {
    const a = cluster(1, [
      visit("https://example.com/a", "2026-01-01T00:00:00.000Z"),
      visit("https://example.com/b", "2026-01-01T00:01:00.000Z"),
    ]);
    const b = cluster(99, [
      { ...a.visits[0] },
      { ...a.visits[1] },
    ]);
    expect(clusterFingerprint(a)).toBe(clusterFingerprint(b));
    const c = cluster(1, [visit("https://example.com/z", "2026-01-01T00:00:00.000Z")]);
    expect(clusterFingerprint(a)).not.toBe(clusterFingerprint(c));
  });
});

describe("clusterVisitsHeuristic", () => {
  it("splits visits separated by more than 30 minutes", () => {
    const visits = [
      visit("https://example.com/a", "2026-01-01T00:00:00.000Z"),
      visit("https://example.com/b", "2026-01-01T00:10:00.000Z"),
      visit("https://other.org/c", "2026-01-01T02:00:00.000Z"),
      visit("https://other.org/d", "2026-01-01T02:05:00.000Z"),
    ];
    const clusters = clusterVisitsHeuristic(visits);
    expect(clusters).toHaveLength(2);
    // newest-first ordering
    expect(clusters[0].visits[0].url).toBe("https://other.org/c");
  });

  it("links visits sharing a search term within an hour", () => {
    const visits = [
      visit("https://shop.com/results", "2026-01-01T00:00:00.000Z", "results", "red shoes"),
      visit("https://elsewhere.com/x", "2026-01-01T00:45:00.000Z", "", ""),
      visit("https://shop.com/results?page=2", "2026-01-01T00:50:00.000Z", "results", "red shoes"),
    ];
    const clusters = clusterVisitsHeuristic(visits);
    expect(clusters).toHaveLength(2);
    const linked = clusters.find((c) => c.visits.length === 2);
    expect(linked?.visits.every((v) => v.search_term === "red shoes")).toBe(true);
  });

  it("does not chain unrelated topics merely because they occur within 30 minutes", () => {
    const visits = [
      visit("https://flights.example/seoul", "2026-01-01T00:00:00.000Z", "Flights and hotels for a Seoul vacation"),
      visit("https://fidelity.example/retirement", "2026-01-01T00:08:00.000Z", "Retirement portfolio allocation funds"),
      visit("https://arxiv.example/agents", "2026-01-01T00:16:00.000Z", "Agent evaluation benchmark research paper"),
    ];
    expect(clusterVisitsHeuristic(visits)).toHaveLength(3);
  });

  it("does not merge unrelated ChatGPT conversations merely because the domain and timing match", () => {
    const visits = [
      visit("https://chatgpt.com/c/travel", "2026-01-01T00:00:00.000Z", "Plan a Seoul hotel itinerary"),
      visit("https://chatgpt.com/c/finance", "2026-01-01T00:05:00.000Z", "Analyze retirement fund allocation"),
    ];
    expect(clusterVisitsHeuristic(visits)).toHaveLength(2);
  });

  it("joins nearby cross-site visits with a shared project topic", () => {
    const visits = [
      visit("https://search.example/?q=seoul+hotels", "2026-01-01T00:00:00.000Z", "Seoul hotel search"),
      visit("https://booking.example/seoul", "2026-01-01T00:08:00.000Z", "Seoul hotels and guest rooms"),
      visit("https://maps.example/seoul", "2026-01-01T00:16:00.000Z", "Seoul neighborhoods near hotels"),
    ];
    expect(clusterVisitsHeuristic(visits)).toHaveLength(1);
  });
});

describe("prepareJourneys", () => {
  it("filters, normalizes, fingerprints, and dedupes against processed set", () => {
    const raw = [
      cluster(1, [
        visit("https://example.com/a", "2026-01-01T00:00:00.000Z"),
        visit("https://example.com/b", "2026-01-01T00:01:00.000Z"),
        visit("https://example.com/c", "2026-01-01T00:02:00.000Z"),
      ]),
      cluster(2, [
        visit("https://example.com/d", "2026-01-02T00:00:00.000Z"),
        visit("https://example.com/e", "2026-01-02T00:01:00.000Z"),
        visit("https://example.com/f", "2026-01-02T00:02:00.000Z"),
      ]),
    ];
    const first = prepareJourneys(raw, new Set());
    expect(first).toHaveLength(2);
    expect(first.every((c) => typeof c.fingerprint === "string" && c.fingerprint.length > 0)).toBe(true);

    const processed = new Set([first[0].fingerprint!]);
    const second = prepareJourneys(raw, processed);
    expect(second).toHaveLength(1);
    expect(second[0].fingerprint).toBe(first[1].fingerprint);
  });
});
