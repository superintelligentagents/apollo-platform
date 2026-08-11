// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderReview } from "../src/ui/screens/review";
import { initialState, type Ctx } from "../src/ui/context";

describe("privacy gate review UI", () => {
  it("shows blocking counts without revealing the matched value", () => {
    const state = initialState();
    state.privacyAudit = {
      schema_version: "apollo_privacy_audit_v1",
      standard: "NIST-oriented direct-identifier baseline 2026.08",
      generated_at: "2026-08-12T00:00:00Z",
      status: "blocked",
      scanned_files: 3,
      scanned_values: 48,
      blocking_findings: 1,
      warnings: 2,
      kept_real_entities: 0,
      controls: {
        aliases_applied: true,
        hard_masks_applied: true,
        tasks_scanned: true,
        final_dlp_scan: true,
        raw_alias_mapping_local_only: true,
      },
      findings: [{
        code: "unmasked-pii",
        detector: "ssn",
        severity: "block",
        filename: "records_email.json",
        path: "$.records[0].body_text",
        count: 1,
        message: "A direct identifier or secret remains unmasked in the upload copy.",
      }],
    };
    const ctx = {
      state,
      rerender: vi.fn(),
      autosave: vi.fn(),
      actions: { isIncluded: () => false, goto: vi.fn(), submitBundle: vi.fn() },
    } as unknown as Ctx;

    const root = renderReview(ctx);
    const gate = root.querySelector('[data-testid="privacy-gate"]');
    expect(gate?.textContent).toContain("Upload is blocked");
    expect(gate?.textContent).toContain("1 blocking");
    expect(gate?.textContent).not.toContain("123-45-6789");
  });
});
