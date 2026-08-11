// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "../src/types";
import { initialState, type Ctx } from "../src/ui/context";
import { renderEntities } from "../src/ui/screens/entities";

function entity(index: number, patch: Partial<Entity> = {}): Entity {
  return {
    entityId: `entity-${index}`,
    category: index === 0 ? "self" : "person",
    realNames: [`Person ${index}`],
    realEmails: [`person-${index}@example.com`],
    realPhones: [],
    alias: `Alias ${index}`,
    aliasEmail: `alias-${index}@personamail.test`,
    aliasPhone: null,
    keepReal: false,
    occurrences: { email: 1 },
    mergedFrom: [],
    ...patch,
  };
}

function ctxWithEntities(count: number): Ctx {
  const state = initialState();
  state.entities = Array.from({ length: count }, (_, index) => entity(index));
  return {
    state,
    rerender: vi.fn(),
    actions: {
      updateEntity: vi.fn(),
      addRule: vi.fn(),
      removeRule: vi.fn(),
    },
  } as unknown as Ctx;
}

describe("large entity review", () => {
  afterEach(() => vi.useRealTimers());

  it("mounts only 100 of 10k entities and pages through the local result", () => {
    const ctx = ctxWithEntities(10_000);
    const first = renderEntities(ctx);
    expect(first.querySelectorAll(".entity-row")).toHaveLength(100);
    expect(first.textContent).toContain("10,000 people · showing 1–100");
    expect(first.textContent).toContain("Page 1 of 100");

    const next = [...first.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Next →")!;
    next.click();
    expect(ctx.state.entityPage).toBe(1);
    const second = renderEntities(ctx);
    expect(second.textContent).toContain("Person 100");
    expect(second.textContent).not.toContain("Person 1person-1@example.com");
  });

  it("debounces search without losing the complete typed query", () => {
    vi.useFakeTimers();
    const ctx = ctxWithEntities(10_000);
    const root = renderEntities(ctx);
    const search = root.querySelector<HTMLInputElement>('[data-testid="entity-search"]')!;
    search.value = "person-9876@example.com";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ctx.rerender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(ctx.rerender).toHaveBeenCalledTimes(1);

    const filtered = renderEntities(ctx);
    expect(filtered.querySelectorAll(".entity-row")).toHaveLength(1);
    expect(filtered.textContent).toContain("Person 9876");
  });

  it("defaults to active people and keeps services in a separate view", () => {
    const ctx = ctxWithEntities(0);
    ctx.state.entities = [
      entity(0),
      entity(1),
      entity(2, { category: "org", keepReal: true, realNames: ["Piazza Team"], realEmails: ["no-reply@piazza.com"] }),
      entity(3, { category: "merchant", keepReal: true, realNames: ["Strava"], realEmails: ["no-reply@strava.com"] }),
      entity(4, { realNames: ["Computer Use E2E"], occurrences: {} }),
    ];

    const people = renderEntities(ctx);
    expect(people.querySelectorAll(".entity-row")).toHaveLength(2);
    expect(people.textContent).toContain("People & PII 2");
    expect(people.textContent).toContain("Organizations/services 2");
    expect(people.textContent).not.toContain("Piazza Team");
    expect(people.textContent).not.toContain("Computer Use E2E");

    people.querySelector<HTMLButtonElement>('[data-testid="entity-scope-services"]')!.click();
    expect(ctx.state.entityScope).toBe("services");
    const services = renderEntities(ctx);
    expect(services.querySelectorAll(".entity-row")).toHaveLength(2);
    expect(services.textContent).toContain("Piazza Team");
    expect(services.textContent).toContain("Strava");
    expect(services.textContent).not.toContain("Computer Use E2E");
  });

  it("does not expose stale rows while classifications are refreshing", () => {
    const ctx = ctxWithEntities(2);
    ctx.state.entityIndexing = true;
    const root = renderEntities(ctx);
    expect(root.textContent).toContain("Updating privacy classifications");
    expect(root.querySelectorAll(".entity-row")).toHaveLength(0);
  });
});
