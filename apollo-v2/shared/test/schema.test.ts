import { describe, expect, it } from "vitest";
import {
  buildLongTask,
  buildTaskId,
  derivePrimaryDomains,
  deriveSiteScope,
  deriveTimeSpan,
  estimatePayloadBytes,
  sourceJourneyFromCluster,
  truncateForUpload,
  validateLongTask,
} from "../src/schema";
import { MAX_UPLOAD_BYTES } from "../src/config";
import { MAX_SUBJECTS, REGION_GLOBAL, SUBJECTS } from "../src/taxonomy";
import { sanitizeAttachedUrl } from "../src/ui/pending";
import { prepareJourneys } from "../src/clustering";
import type { LongTask, ParticipantIdentity, SourceJourney } from "../src/types";
import { cluster, themedClusters, visit } from "./fixtures";

const internal: ParticipantIdentity = {
  kind: "internal",
  participantId: "",
  name: "Lawrence",
  email: "lj@example.com",
  consent: { version: "2026-07-24", accepted_at: "2026-07-24T00:00:00.000Z" },
};

function sampleJourneys(count = 2): SourceJourney[] {
  const journeys = prepareJourneys(themedClusters(), new Set());
  return journeys.slice(0, count).map((c, i) => sourceJourneyFromCluster(c, i, [c.visits[c.visits.length - 1].url]));
}

function validTask(mode: LongTask["mode"] = "compose"): LongTask {
  const journeys = mode === "freeform" ? [] : sampleJourneys();
  return buildLongTask({
    identity: internal,
    mode,
    platform: "tauri",
    task: {
      task_title: "Plan an MLB stadium vacation",
      agent_request:
        "Plan a week-long trip visiting three MLB stadiums on the east coast, including game tickets, hotels near each stadium, and travel between cities.",
      task_summary: null,
      difficulty: "high",
      site_scope: ["mlb.com", "expedia.com"],
      success_criteria: ["An itinerary covering three stadiums with dates and tickets"],
      must_visit_or_reach: journeys.length ? journeys[0].key_urls : [],
      required_outputs: [],
      notes: null,
      time_span: deriveTimeSpan(journeys),
      metadata: {
        region: "US",
        subjects: ["Travel and Tourism > Accommodation and Hotels", "Sports > Baseball"],
      },
    },
    sourceJourneys: journeys,
    themeSuggestion:
      mode === "theme"
        ? {
            theme_id: "theme-1",
            score: 0.9,
            shared_tokens: ["stadium"],
            site_families: ["mlb.com"],
            accepted_journey_fingerprints: journeys.map((j) => j.fingerprint),
            removed_journey_fingerprints: [],
          }
        : null,
    attachedUrls: [],
  });
}

describe("buildTaskId", () => {
  it("uses the internal segment and email slug for internal annotators", () => {
    const id = buildTaskId(internal, "2026-07-19T12:00:00.000Z");
    expect(id.startsWith("v2/lj-example-com/internal/task-")).toBe(true);
  });
});

describe("validateLongTask", () => {
  it("accepts a well-formed compose task", () => {
    const result = validateLongTask(validTask("compose"));
    expect(result.errors).toEqual({});
    expect(result.valid).toBe(true);
    expect(validTask("compose").participant.consent).toEqual(internal.consent);
  });

  it("accepts a well-formed theme and freeform task", () => {
    expect(validateLongTask(validTask("theme")).valid).toBe(true);
    expect(validateLongTask(validTask("freeform")).valid).toBe(true);
  });

  it("rejects a task without recorded sign-in consent", () => {
    const task = validTask();
    task.participant.consent.accepted_at = "";
    expect(validateLongTask(task).errors.consent).toBeDefined();
  });

  it("rejects only truly-too-short requests; titles are optional", () => {
    const task = validTask();
    task.task.task_title = "";
    task.task.agent_request = "Plan a trip.";
    const result = validateLongTask(task);
    expect(result.valid).toBe(false);
    expect(result.errors.agent_request).toBeDefined();
    expect(result.errors.task_title).toBeUndefined();
  });

  it("accepts a single-journey history task without key URLs (soft gates)", () => {
    const task = validTask("compose");
    task.provenance.source_journeys = task.provenance.source_journeys.slice(0, 1);
    task.task.must_visit_or_reach = [];
    expect(validateLongTask(task).valid).toBe(true);
  });

  it("still requires at least one journey for history modes", () => {
    const task = validTask("compose");
    task.provenance.source_journeys = [];
    expect(validateLongTask(task).errors.source_journeys).toBeDefined();
  });

  it("does not require journeys or key URLs for freeform", () => {
    const task = validTask("freeform");
    task.task.must_visit_or_reach = [];
    expect(validateLongTask(task).valid).toBe(true);
  });

  it("treats success criteria as optional (offline pipeline drafts them)", () => {
    const task = validTask();
    task.task.success_criteria = [];
    expect(validateLongTask(task).valid).toBe(true);
  });

  it("requires country and subject metadata for every new task", () => {
    const task = validTask();
    delete task.task.metadata;
    expect(validateLongTask(task).errors.metadata).toBeDefined();
  });

  it("accepts an ISO country or the location-agnostic choice", () => {
    const task = validTask();
    task.task.metadata!.region = "not-a-country";
    expect(validateLongTask(task).errors.region).toBeDefined();
    task.task.metadata!.region = REGION_GLOBAL;
    expect(validateLongTask(task).valid).toBe(true);
  });

  it("requires one to three known subjects", () => {
    const task = validTask();
    task.task.metadata!.subjects = [];
    expect(validateLongTask(task).errors.subjects).toBeDefined();
    task.task.metadata!.subjects = SUBJECTS.slice(0, MAX_SUBJECTS + 1);
    expect(validateLongTask(task).errors.subjects).toBeDefined();
    task.task.metadata!.subjects = [SUBJECTS[0]];
    expect(validateLongTask(task).valid).toBe(true);
  });

});

describe("derivePrimaryDomains", () => {
  it("derives and deduplicates sites from stored task fields", () => {
    expect(derivePrimaryDomains({
      siteScope: ["WWW.MLB.com"],
      keyUrls: ["https://www.mlb.com/tickets", "https://www.expedia.com/hotels"],
    })).toEqual(["mlb.com", "expedia.com"]);
  });
});

describe("deriveSiteScope / deriveTimeSpan", () => {
  it("ranks non-generic site families and spans journey times", () => {
    const journeys = sampleJourneys(3);
    const scope = deriveSiteScope(journeys);
    expect(scope).toContain("mlb.com");
    expect(scope).toContain("expedia.com");
    expect(scope).not.toContain("google.com");

    const span = deriveTimeSpan(journeys);
    expect(span.start).toBe("2026-06-01T18:00:00.000Z");
    expect(span.end).toBe("2026-06-09T17:30:00.000Z");
  });
});

describe("sanitizeAttachedUrl", () => {
  it("accepts http(s), adds a scheme when missing, strips credentials", () => {
    expect(sanitizeAttachedUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(sanitizeAttachedUrl("example.com/path")).toBe("https://example.com/path");
    expect(sanitizeAttachedUrl("https://user:secret@example.com/x")).toBe("https://example.com/x");
  });

  it("rejects non-http schemes, sensitive destinations, and blanks", () => {
    expect(sanitizeAttachedUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeAttachedUrl("mailto:user@example.com")).toBeNull();
    expect(sanitizeAttachedUrl("tel:+15551234567")).toBeNull();
    expect(sanitizeAttachedUrl("https://app.prolific.com/studies/1")).toBeNull();
    expect(sanitizeAttachedUrl("   ")).toBeNull();
  });
});

describe("sourceJourneyFromCluster", () => {
  it("sanitizes uploaded visits, key URLs, and the public fingerprint", () => {
    const raw = cluster(55, [
      visit(
        "https://user:pass@example.com/search?q=seoul&token=private#secret",
        "2026-06-01T10:00:00.000Z",
        "Seoul search"
      ),
      visit("https://example.com/result?session_id=private&hotel=lotte", "2026-06-01T10:05:00.000Z", "Hotel result"),
    ]);
    raw.fingerprint = "local::https://example.com/?token=private";
    const journey = sourceJourneyFromCluster(raw, 0, [raw.visits[0].url]);
    expect(journey.visits[0].url).toBe("https://example.com/search?q=seoul");
    expect(journey.visits[1].url).toBe("https://example.com/result?hotel=lotte");
    expect(journey.key_urls).toEqual(["https://example.com/search?q=seoul"]);
    expect(journey.fingerprint).toMatch(/^journey-[a-f0-9]{8}$/);
    expect(JSON.stringify(journey)).not.toContain("private");
  });
});

describe("truncateForUpload", () => {
  it("leaves small payloads untouched", () => {
    const task = validTask();
    const { task: out, truncated } = truncateForUpload(task);
    expect(truncated).toBe(false);
    expect(out).toBe(task);
  });

  it("trims oversized journeys to head+tail and flags them", () => {
    const bigVisits = Array.from({ length: 20000 }, (_, i) =>
      visit(`https://example.com/page/${i}?padding=${"x".repeat(200)}`, new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), `Page ${i}`)
    );
    const big = cluster(1, bigVisits);
    const task = validTask();
    task.provenance.source_journeys = [
      sourceJourneyFromCluster(big, 0, [bigVisits[bigVisits.length - 1].url]),
      task.provenance.source_journeys[0],
    ];
    expect(estimatePayloadBytes(task)).toBeGreaterThan(MAX_UPLOAD_BYTES);

    const { task: out, truncated } = truncateForUpload(task);
    expect(truncated).toBe(true);
    const trimmed = out.provenance.source_journeys[0];
    expect(trimmed.visits).toHaveLength(300);
    expect(trimmed.visits_truncated).toBe(true);
    // head and tail preserved
    expect(trimmed.visits[0].url).toBe("https://example.com/page/0");
    expect(trimmed.visits[299].url).toBe("https://example.com/page/19999");
    expect(estimatePayloadBytes(out)).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });
});
