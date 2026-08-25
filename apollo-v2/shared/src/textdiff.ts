// Word-level inline diff (LCS over whitespace-delimited tokens, separators
// preserved) used to show reviewer edits to a trainer's own task on the
// Grade screen. Small inputs only (requests/rubrics); O(n*m) is fine here.

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

function tokenize(text: string): string[] {
  // Keep whitespace runs as their own tokens so the rendered diff preserves
  // the author's spacing and line breaks.
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export function diffWords(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (!a.length) return b.length ? [{ type: "insert", text: after }] : [];
  if (!b.length) return [{ type: "delete", text: before }];
  // Guard pathological sizes: fall back to a whole-block replacement.
  if (a.length * b.length > 4_000_000) {
    return [{ type: "delete", text: before }, { type: "insert", text: after }];
  }
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] = a[i] === b[j]
        ? table[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("equal", a[i]); i += 1; j += 1; }
    else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) { push("delete", a[i]); i += 1; }
    else { push("insert", b[j]); j += 1; }
  }
  while (i < n) { push("delete", a[i]); i += 1; }
  while (j < m) { push("insert", b[j]); j += 1; }
  return tidy(ops);
}

// Readability passes. Contract: concatenating the non-delete ops always
// reproduces `after` exactly (that is the text the agent actually ran);
// `before` is reproduced up to whitespace (struck text is for orientation).
// 1. Whitespace-only changes are noise: inserted whitespace becomes plain
//    text, deleted whitespace disappears.
// 2. Whitespace the LCS happened to match between two inserted (or two
//    deleted) words splits one phrase into many spans — rejoin them.
function tidy(ops: DiffOp[]): DiffOp[] {
  const push = (acc: DiffOp[], type: DiffOp["type"], text: string) => {
    if (!text) return;
    const last = acc[acc.length - 1];
    if (last && last.type === type) last.text += text;
    else acc.push({ type, text });
  };
  const folded: DiffOp[] = [];
  for (const op of ops) {
    if (op.type === "delete" && !op.text.trim()) continue;
    push(folded, op.type === "insert" && !op.text.trim() ? "equal" : op.type, op.text);
  }
  const out: DiffOp[] = [];
  for (let index = 0; index < folded.length; index += 1) {
    const op = folded[index];
    const prev = out[out.length - 1];
    const next = folded[index + 1];
    if (op.type === "equal" && !op.text.trim() && prev && prev.type !== "equal" && next && next.type === prev.type) {
      // [ins "a", eq " ", ins "b"] → ins "a b"; for deletes the matched
      // whitespace must survive in `after`, so it is re-emitted as equal.
      if (prev.type === "insert") {
        prev.text += op.text + next.text;
      } else {
        prev.text += op.text + next.text;
        out.push({ type: "equal", text: op.text });
      }
      index += 1;
      continue;
    }
    push(out, op.type, op.text);
  }
  // Edge whitespace on a changed span renders as an odd highlighted gap:
  // move it out of inserts (into equal text) and drop it from deletes.
  const trimmed: DiffOp[] = [];
  for (const op of out) {
    if (op.type === "equal") { push(trimmed, "equal", op.text); continue; }
    const lead = op.text.match(/^\s*/)?.[0] ?? "";
    const trail = op.text.match(/\s*$/)?.[0] ?? "";
    const core = op.text.slice(lead.length, op.text.length - trail.length);
    if (op.type === "insert") push(trimmed, "equal", lead);
    push(trimmed, op.type, core);
    if (op.type === "insert") push(trimmed, "equal", trail);
  }
  return trimmed;
}

export function diffSummary(ops: DiffOp[]): { inserted: number; deleted: number } {
  let inserted = 0;
  let deleted = 0;
  for (const op of ops) {
    const words = op.text.split(/\s+/).filter(Boolean).length;
    if (op.type === "insert") inserted += words;
    if (op.type === "delete") deleted += words;
  }
  return { inserted, deleted };
}
