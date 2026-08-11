// Cross-source correlation hints — the property that makes MyPCBench-style
// environments feel real (one life event echoes across sources). Mined
// receipts are born linked; task-attached record pairs from different sources
// add authored links.

import type { CorrelationHint, PCTask, SourceRecord } from "./types";

export function buildCorrelationHints(records: SourceRecord[], tasks: PCTask[]): CorrelationHint[] {
  const hints: CorrelationHint[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, relation: CorrelationHint["relation"], confidence: number) => {
    const key = a < b ? `${a}|${b}|${relation}` : `${b}|${a}|${relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ a, b, relation, confidence });
  };

  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    if (r.source === "orders" || r.source === "transactions") {
      for (const rel of r.relatedRecordIds) {
        if (byId.has(rel)) add(rel, r.id, "confirms", 0.95);
      }
    }
  }

  // Any pair of task-attached records from different sources is an authored
  // correlation — the participant said these belong to one story.
  for (const task of tasks) {
    const attached = task.referenced_record_ids
      .map((id) => byId.get(id))
      .filter((r): r is SourceRecord => !!r);
    for (let i = 0; i < attached.length; i++) {
      for (let j = i + 1; j < attached.length; j++) {
        if (attached[i].source !== attached[j].source) {
          add(attached[i].id, attached[j].id, "same_event", 0.7);
        }
      }
    }
  }
  return hints;
}
