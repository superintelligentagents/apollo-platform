import { describe, expect, it } from "vitest";
import { MIN_TASKS_FOR_GUIDANCE, summarizeDistribution } from "../src/distribution";
import { REGION_GLOBAL } from "../src/taxonomy";

const TRAVEL = "Travel and Tourism > Air Travel";
const HOTELS = "Travel and Tourism > Accommodation and Hotels";

describe("task distribution", () => {
  it("counts subject groups once per task", () => {
    const summary = summarizeDistribution([{ region: "US", subjects: [TRAVEL, HOTELS] }]);
    expect(summary.subjects).toHaveLength(1);
    expect(summary.subjects[0]).toMatchObject({ key: "Travel and Tourism", count: 1, share: 1 });
  });

  it("keeps older unlabelled tasks out of percentage denominators", () => {
    const summary = summarizeDistribution([
      { region: "IN", subjects: [TRAVEL] },
      { region: REGION_GLOBAL, subjects: ["Health > Medicine"] },
      {},
    ]);
    expect(summary.labelled).toBe(2);
    expect(summary.unlabelled).toBe(1);
    expect(summary.globalShare).toBe(0.5);
  });

  it("waits for enough tasks before offering guidance", () => {
    const summary = summarizeDistribution(
      Array.from({ length: MIN_TASKS_FOR_GUIDANCE - 1 }, () => ({ region: "IN", subjects: [TRAVEL] }))
    );
    expect(summary.advice).toBeNull();
  });
});
