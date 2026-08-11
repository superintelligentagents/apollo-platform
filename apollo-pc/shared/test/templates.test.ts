import { describe, expect, it } from "vitest";
import { PC_TEMPLATES } from "../src/templates";

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
});
