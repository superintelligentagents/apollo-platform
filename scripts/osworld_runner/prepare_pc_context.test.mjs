import test from "node:test";
import assert from "node:assert/strict";
import { buildContextConfig, buildContextHtml, selectContextRecords } from "./prepare_pc_context.mjs";

test("selects only the task's referenced redacted records", () => {
  const records = selectContextRecords([{ records: [
    { record: { id: "keep", source: "email", subject: "Selected" } },
    { record: { id: "drop", source: "email", subject: "Private unselected" } },
  ] }], ["keep"]);
  assert.deepEqual(records.map((record) => record.id), ["keep"]);
  const html = buildContextHtml("pc_fixture", { task_title: "Fixture", agent_request: "Use the record." }, records);
  assert.match(html, /Selected/);
  assert.doesNotMatch(html, /Private unselected/);
});

test("creates bounded setup commands and a task-matched private file URL", () => {
  const config = buildContextConfig("pc_fixture", buildContextHtml("pc_fixture", {}, [{ id: "a", body_text: "x".repeat(200_000) }]));
  assert.equal(config.task_id, "pc_fixture");
  assert.match(config.start_urls[0], /^file:\/\/\/tmp\/apollo-pc-context-[a-f0-9]{16}\.html$/);
  assert.ok(config.config.every((step) => String(step.parameters.command).length < 50_000));
  assert.equal(config.related_apps[0], "chrome");
});
