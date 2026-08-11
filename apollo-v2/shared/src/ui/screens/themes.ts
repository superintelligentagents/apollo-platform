import type { Ctx } from "../context";
import { chip, el, fmtDayYear } from "../components/helpers";

export function renderThemes(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen themes-screen" });

  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "Recurring threads in your history"),
      el("p", { class: "screen-sub" }, "Apollo compares repeated sites, distinctive words, and timing to suggest possible hour-long or multi-day projects. Suggestions are a starting point—not ground truth. Choose a project you remember, then remove unrelated journeys.")
    )
  );

  const suggestions = state.suggestions ?? [];
  if (!suggestions.length) {
    root.append(
      el(
        "div",
        { class: "card empty-card" },
        el("p", null, "No multi-day threads found in this history."),
        el(
          "div",
          { class: "empty-actions" },
          el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.startMode("compose") }, "Pick journeys by hand"),
          el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto(ctx.state.identity?.kind === "internal" ? "submit" : "home") }, "Back")
        )
      )
    );
    return root;
  }

  const themeCard = (t: (typeof suggestions)[number]) => {
    const families = t.site_families.slice(0, 3);
    const headline = families.length ? families.join(" · ") : t.shared_tokens.slice(0, 3).join(" · ") || "Recurring thread";
    const match = matchLabel(t.algo);
    const tokens = t.shared_tokens.slice(0, 6);
    return el(
      "article",
      { class: "theme-card card" },
      el(
        "div",
        {
          class: `theme-match ${match.tone}`,
          title: `${ALGO_LABELS[t.algo] ?? t.algo} · score ${t.score.toFixed(2)}`,
        },
        el("span", { class: "theme-match-dot" }),
        match.text
      ),
      el("h3", null, headline),
      tokens.length
        ? el("div", { class: "theme-chips" }, ...tokens.map((tok) => chip(tok, "tag")))
        : null,
      el(
        "p",
        { class: "theme-meta mono" },
        `${t.cluster_fingerprints.length} journeys · ${fmtDayYear(t.start)} → ${fmtDayYear(t.end)}`
      ),
      el(
        "div",
        { class: "theme-actions" },
        el(
          "button",
          {
            class: "btn ghost",
            type: "button",
            onclick: () => {
              state.suggestions = (state.suggestions ?? []).filter((candidate) => candidate.theme_id !== t.theme_id);
              ctx.rerender();
            },
          },
          "Not one project"
        ),
        el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.pickTheme(t) }, "Start from this")
      )
    );
  };

  // Group related themes (same thread_group) into meta-project sections.
  const byGroup = new Map<number, typeof suggestions>();
  for (const t of suggestions) {
    if (!byGroup.has(t.thread_group)) byGroup.set(t.thread_group, []);
    byGroup.get(t.thread_group)!.push(t);
  }
  const groups = [...byGroup.values()].sort((a, b) => b[0].score - a[0].score);

  for (const group of groups) {
    if (group.length === 1) continue;
    const fingerprints = [...new Set(group.flatMap((t) => t.cluster_fingerprints))];
    const families = [...new Set(group.flatMap((t) => t.site_families))].slice(0, 5);
    const tokens = [...new Set(group.flatMap((t) => t.shared_tokens))].slice(0, 5);
    const starts = group.map((t) => t.start).filter(Boolean).sort() as string[];
    const ends = group.map((t) => t.end).filter(Boolean).sort() as string[];
    const combined = {
      ...group[0],
      theme_id: `thread-group-${group[0].thread_group}`,
      shared_tokens: tokens,
      site_families: families,
      cluster_fingerprints: fingerprints,
      start: starts[0] ?? null,
      end: ends[ends.length - 1] ?? null,
    };
    root.append(
      el(
        "section",
        { class: "thread-group" },
        el(
          "div",
          { class: "thread-group-head" },
          el(
            "div",
            null,
            el("span", { class: "eyebrow mono" }, "ONE BIGGER PROJECT?"),
            el("p", { class: "thread-group-sub" }, "These threads may be one project. Dismiss any suggestion that mixes unrelated work.")
          ),
          el(
            "button",
            { class: "btn ghost", type: "button", onclick: () => ctx.actions.pickTheme(combined) },
            `Start from all ${fingerprints.length} journeys`
          )
        ),
        el("div", { class: "theme-grid" }, ...group.map(themeCard))
      )
    );
  }

  const singles = groups.filter((g) => g.length === 1).map((g) => g[0]);
  if (singles.length) {
    root.append(el("div", { class: "theme-grid" }, ...singles.map(themeCard)));
  }
  root.append(
    el(
      "div",
      { class: "screen-foot" },
      el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto(ctx.state.identity?.kind === "internal" ? "submit" : "home") }, "Back")
    )
  );
  return root;
}

const ALGO_LABELS: Record<string, string> = {
  cohesion: "TIGHT CLUSTER",
  topic: "RECURRING TOPIC",
  site: "RECURRING SITE",
  burst: "SAME-WEEK ARC",
};

function matchLabel(algo: keyof typeof ALGO_LABELS): { text: string; tone: "strong" | "clear" | "loose" } {
  if (algo === "cohesion") return { text: "shared sites + topic", tone: "strong" };
  if (algo === "topic") return { text: "shared topic", tone: "clear" };
  if (algo === "site") return { text: "same-site pattern", tone: "clear" };
  return { text: "same-week pattern", tone: "loose" };
}
