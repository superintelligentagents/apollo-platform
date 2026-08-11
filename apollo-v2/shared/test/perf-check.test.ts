import { it, expect } from "vitest";
import { suggestThemes } from "../src/themes";
import type { Cluster } from "../src/types";

it("ensemble stays fast on a large history (800 clusters / 6 months)", () => {
  const families = Array.from({ length: 60 }, (_, i) => `site${i}.com`);
  const topics = Array.from({ length: 40 }, (_, i) => `topic${i}word alphaterm${i} betaterm${i}`);
  const clusters: Cluster[] = [];
  let vid = 1;
  const base = Date.UTC(2026, 0, 5);
  for (let c = 0; c < 800; c++) {
    const day = Math.floor((c / 800) * 180);
    const fam = families[c % families.length];
    const topic = topics[c % topics.length];
    const t0 = base + day * 86400000 + (c % 12) * 3600000;
    const visits = Array.from({ length: 4 }, (_, v) => ({
      id: vid++,
      url: `https://www.${fam}/page/${c}/${v}`,
      title: `${topic} session ${c} item ${v}`,
      visited_at: new Date(t0 + v * 60000).toISOString(),
      from_visit: 0,
      domain: `www.${fam}`,
    }));
    clusters.push({ cluster_id: c, visits, fingerprint: `fp-${c}` });
  }
  const start = performance.now();
  const suggestions = suggestThemes(clusters);
  const ms = performance.now() - start;
  console.log(`800 clusters -> ${suggestions.length} suggestions in ${Math.round(ms)}ms`);
  expect(ms).toBeLessThan(3000);
  expect(suggestions.length).toBeGreaterThan(0);
});
