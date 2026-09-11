import { describe, expect, it } from "vitest";
import { MIN_STEP_LENGTH, PC_TEMPLATES, shortTouchedSteps, substantiveSteps } from "../src/templates";

describe("task templates", () => {
  it("uses one coherent, verifiable MLB trip example throughout the free-form workflow", () => {
    const template = PC_TEMPLATES.find((candidate) => candidate.id === "free-form-long-horizon");

    expect(template?.steps.map((step) => step.title)).toEqual([
      "Choose the games",
      "Plan the route",
      "Find places to stay",
      "Check the budget",
      "Build the itinerary",
    ]);

    const examples = template?.steps.map((step) => step.placeholder).join(" ") ?? "";
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

  it("uses the Apollo v2 rubric sentence floor", () => {
    expect(MIN_STEP_LENGTH).toBe(15);
    const steps = [
      { order: 0, title: "Short", description: "12345678901234" },
      { order: 1, title: "Complete", description: "123456789012345" },
    ];
    expect(shortTouchedSteps(steps)).toEqual([steps[0]]);
    expect(substantiveSteps(steps)).toEqual([{ order: 0, title: "Complete", description: "123456789012345" }]);
  });
});
