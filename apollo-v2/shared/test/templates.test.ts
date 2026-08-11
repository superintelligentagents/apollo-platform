import { describe, expect, it } from "vitest";
import { BLANK_TEMPLATE, JOURNEYS_TEMPLATE } from "../src/templates";

describe("blank task template", () => {
  it("uses one coherent, quantity-specific MLB trip example", () => {
    expect(BLANK_TEMPLATE.intro_placeholder).toContain("exactly three games");
    expect(BLANK_TEMPLATE.intro_placeholder).toContain("six total nights");
    expect(BLANK_TEMPLATE.intro_placeholder).toContain("exactly seven dated daily entries");

    expect(BLANK_TEMPLATE.steps.map((step) => step.title)).toEqual([
      "Choose the games",
      "Plan the route",
      "Find places to stay",
      "Check the budget",
      "Build the itinerary",
    ]);

    const examples = BLANK_TEMPLATE.steps.map((step) => step.placeholder).join(" ");
    expect(examples).toContain("exactly three games");
    expect(examples).toContain("two intercity legs");
    expect(examples).toContain("at least two");
    expect(examples).toContain("total of six nights");
    expect(examples).toContain("at least 8/10");
    expect(examples).toContain("within 30 minutes");
    expect(examples).toContain("under $2,500");
    expect(examples).toContain("exactly seven dated daily entries");
    expect(examples).toContain("do not purchase");
  });

  it("keeps journey-backed task steps neutral", () => {
    expect(JOURNEYS_TEMPLATE.steps).toHaveLength(1);
    expect(JOURNEYS_TEMPLATE.steps[0]?.title).toBe("Step 1");
    expect(JOURNEYS_TEMPLATE.steps[0]?.placeholder).not.toContain("MLB");
  });

});
