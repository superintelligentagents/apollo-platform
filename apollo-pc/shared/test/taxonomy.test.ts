import { describe, expect, it } from "vitest";
import {
  dedupeDomains,
  isRegionCode,
  isSubject,
  MAX_PRIMARY_DOMAINS,
  MAX_SUBJECTS,
  normalizeDomain,
  normalizeSubject,
  REGION_CODES,
  REGION_GLOBAL,
  regionLabel,
  regionOptions,
  SUBJECT_GROUPS,
  SUBJECTS,
  subjectSub,
  subjectTop,
} from "../src/taxonomy";

// A sample of the `categories` values in the published dataset
// (github.com/ljang0/Odysseys, data/odysseys.json), copied verbatim. Newly
// collected tasks are meant to pool with those 200 without a remapping step,
// so a leaf that stops matching character-for-character is a real break.
const PUBLISHED_LABELS = [
  "Arts & Entertainment > Streaming & Online TV",
  "Reference Materials > Dictionaries and Encyclopedias",
  "Community and Society > Community and Society - Other",
  "Travel and Tourism > Accommodation and Hotels",
  "Food and Drink > Restaurants and Delivery",
  "Food and Drink > Cooking and Recipes",
  "Ecommerce & Shopping > Ecommerce and Shopping - Other",
  "Home and Garden > Home Improvement and Maintenance",
  "Lifestyle > Fashion and Apparel",
  "Law and Government > Government",
  "Finance > Insurance",
  "Science and Education > Universities and Colleges",
  "Computers Electronics and Technology > Programming and Developer Software",
  "Health > Nutrition Diets and Fitness",
  "Sports > Baseball",
  "Jobs and Career > Jobs and Employment",
  "Vehicles > Makes and Models",
  "Business and Consumer Services > Real Estate",
  "Hobbies and Leisure > Photography",
  "Games > Video Games Consoles and Accessories",
  "Heavy Industry and Engineering > Construction and Maintenance",
  // Two published tasks name only the top-level group, with no leaf.
  "News & Media Publishers",
];

describe("subject vocabulary", () => {
  it("accepts the category labels used by the published Odysseys dataset", () => {
    for (const label of PUBLISHED_LABELS) {
      expect(isSubject(label), label).toBe(true);
    }
  });

  it("gives every group an escape hatch, so no author is forced into a wrong leaf", () => {
    for (const group of SUBJECT_GROUPS) {
      expect(group.subs.some((s) => s.endsWith("- Other")), group.top).toBe(true);
    }
  });

  it("has no duplicate leaves", () => {
    expect(new Set(SUBJECTS).size).toBe(SUBJECTS.length);
  });

  it("round-trips a leaf through its group and sub parts", () => {
    for (const subject of SUBJECTS) {
      expect(`${subjectTop(subject)} > ${subjectSub(subject)}`).toBe(subject);
    }
  });

  it("resolves a bare top-level label onto that group's '- Other' leaf", () => {
    expect(normalizeSubject("News & Media Publishers")).toBe(
      "News & Media Publishers > News & Media Publishers - Other"
    );
    expect(normalizeSubject("Finance")).toBe("Finance > Finance - Other");
    // A canonical leaf normalizes to itself.
    expect(normalizeSubject("Sports > Baseball")).toBe("Sports > Baseball");
    expect(normalizeSubject("  Sports > Baseball  ")).toBe("Sports > Baseball");
    expect(normalizeSubject("Cricket")).toBeNull();
    expect(normalizeSubject(42)).toBeNull();
  });

  it("rejects unknown and near-miss labels", () => {
    expect(isSubject("Sports > Cricket")).toBe(false);
    // Right leaf, wrong group.
    expect(isSubject("Health > Baseball")).toBe(false);
    // Right text, wrong separator.
    expect(isSubject("Sports>Baseball")).toBe(false);
    expect(isSubject("")).toBe(false);
    expect(isSubject(undefined)).toBe(false);
  });

  it("caps subjects low enough that the field stays a classification", () => {
    expect(MAX_SUBJECTS).toBeLessThanOrEqual(3);
  });
});

describe("region vocabulary", () => {
  it("accepts ISO alpha-2 codes and the location-agnostic sentinel", () => {
    expect(isRegionCode("IN")).toBe(true);
    expect(isRegionCode("BR")).toBe(true);
    expect(isRegionCode("US")).toBe(true);
    expect(isRegionCode(REGION_GLOBAL)).toBe(true);
  });

  it("rejects names, lowercase codes, and free text", () => {
    expect(isRegionCode("India")).toBe(false);
    expect(isRegionCode("in")).toBe(false);
    expect(isRegionCode("")).toBe(false);
    expect(isRegionCode("XX")).toBe(false);
    expect(isRegionCode(null)).toBe(false);
  });

  it("covers the countries the cohort actually works from", () => {
    for (const code of ["IN", "BR", "US", "GB", "CA", "PK", "NG", "PH", "UA"]) {
      expect(REGION_CODES).toContain(code);
    }
  });

  it("labels codes without shipping a name table, and never renders a bare code", () => {
    // Intl supplies the names; the fallback is the code itself, which is why
    // this asserts on shape rather than on an exact string.
    expect(regionLabel("IN").length).toBeGreaterThan(2);
    expect(regionLabel(REGION_GLOBAL)).toMatch(/location-agnostic/);
    expect(regionLabel("XX")).toBe("XX");
  });

  it("puts the location-agnostic option first, then sorts by label", () => {
    const options = regionOptions();
    expect(options[0].code).toBe(REGION_GLOBAL);
    expect(options).toHaveLength(REGION_CODES.length + 1);
    const labels = options.slice(1).map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en")));
  });
});

describe("normalizeDomain / dedupeDomains", () => {
  it("reduces the ways a person might write a site to one value", () => {
    for (const input of [
      "wikipedia.org",
      "www.wikipedia.org",
      "WWW.Wikipedia.ORG",
      "  wikipedia.org  ",
      "https://www.wikipedia.org/wiki/Main_Page",
      "wikipedia.org/wiki/Main_Page",
      "wikipedia.org:443",
    ]) {
      expect(normalizeDomain(input), input).toBe("wikipedia.org");
    }
  });

  it("rejects values that are not domains", () => {
    for (const input of ["", "   ", "localhost", "not a domain", "wikipedia", "mailto:a@b.com", "192.168.0.1"]) {
      expect(normalizeDomain(input), input).toBe("");
    }
  });

  it("dedupes, drops unusable entries, and preserves first-seen order", () => {
    expect(dedupeDomains(["www.mlb.com", "bogus", "expedia.com", "mlb.com", ""])).toEqual([
      "mlb.com",
      "expedia.com",
    ]);
  });

  it("caps the list so one task cannot claim the whole web", () => {
    const many = Array.from({ length: MAX_PRIMARY_DOMAINS + 5 }, (_, i) => `site${i}.com`);
    expect(dedupeDomains(many)).toHaveLength(MAX_PRIMARY_DOMAINS);
  });
});
