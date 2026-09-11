import type { Ctx } from "../context";
import { reviewFinishedList } from "../../review-client";
import { MYPCBENCH_APPS, recommendApps } from "../../app-catalog";
import { BENCHMARK_EXAMPLES, RESUME_LOCKEDIN_EXAMPLE } from "../../examples";
import { el } from "../components/helpers";

const SECTIONS = [
  { level: "low", label: "Easy", blurb: "About an hour — focused web work with a clear finish." },
  { level: "medium", label: "Medium", blurb: "An afternoon — a few sites, real comparisons." },
  { level: "high", label: "Hard", blurb: "A real project — days of work, constraints, a deliverable." },
] as const;

export function renderExamples(ctx: Ctx): HTMLElement {
  const root = el("section", { class: "screen examples-screen" });
  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "Reference tasks"),
      el("p", { class: "screen-sub" }, "These are long-horizon web requests: Easy usually fits an hour, Medium an afternoon, and Hard may span days. Notice how each gives an agent a real goal, constraints, sources to inspect, decisions to make, and a clear final result.")
    )
  );

  root.append(resumeWorkflowExample(ctx));

  // Accepted tasks — the team's own finished set (internal + key only).
  if (ctx.state.identity?.kind === "internal" && ctx.state.reviewKey) {
    const section = el("section", { class: "accepted-section" });
    section.append(
      el(
        "div",
        { class: "example-section-head" },
        el("h3", null, "Accepted by our reviewers"),
        el("span", { class: "rail-hint mono" }, "scroll to browse →")
      )
    );
    const slot = el(
      "div",
      { class: "accepted-cards horizontal-task-rail", role: "list", tabindex: "0", "aria-label": "Accepted tasks" },
      el("p", { class: "muted" }, "Loading accepted tasks…")
    );
    section.append(slot);
    root.append(section);
    void reviewFinishedList(ctx.state.reviewKey)
      .then((items) => {
        if (!items.length) {
          slot.replaceChildren(el("p", { class: "muted" }, "Nothing accepted yet — approved tasks will appear here."));
          return;
        }
        slot.replaceChildren(
          ...items.map((it) => {
            const body = el("p", { class: "example-text clamped" }, it.request);
            const btn = el(
              "button",
              {
                class: "btn ghost small",
                type: "button",
                onclick: () => {
                  const open = body.classList.toggle("clamped");
                  btn.textContent = open ? "Read the whole task" : "Show less";
                },
              },
              "Read the whole task"
            );
            return el(
              "article",
              { class: "example-card card", role: "listitem" },
              el("span", { class: "badge difficulty-badge" }, difficultyLabel(it.difficulty)),
              el("h4", null, it.title || "(untitled)"),
              el("p", { class: "accepted-meta mono" }, `accepted · ${it.reviewed_by || "reviewer"} · ${it.finished_at.slice(0, 10)}`),
              body,
              btn
            );
          })
        );
      })
      .catch(() => {
        slot.replaceChildren(el("p", { class: "muted" }, "Couldn't load accepted tasks right now."));
      });
  }

  for (const section of SECTIONS) {
    const examples = BENCHMARK_EXAMPLES.filter((e) => e.level === section.level && e !== RESUME_LOCKEDIN_EXAMPLE);
    if (!examples.length) continue;
    root.append(
      el(
        "div",
        { class: "example-section" },
        el(
          "div",
          { class: "example-section-head" },
          el("h3", null, section.label),
          el("span", { class: "muted" }, section.blurb),
          el("span", { class: "rail-hint mono" }, "scroll →")
        ),
        el(
          "div",
          {
            class: "example-grid horizontal-task-rail",
            role: "list",
            tabindex: "0",
            "aria-label": `${section.label} reference tasks`,
          },
          ...examples.map((e) => {
            const body = el("p", { class: "example-text clamped" }, e.text);
            const toggle = el(
              "button",
              {
                class: "btn ghost small",
                type: "button",
                onclick: () => {
                  const clamped = body.classList.toggle("clamped");
                  toggle.textContent = clamped ? "Read the whole task" : "Collapse";
                },
              },
              "Read the whole task"
            );
            return el("article", { class: "example-card card", role: "listitem" }, el("h4", null, e.title), body, toggle);
          })
        )
      )
    );
  }

  root.append(
    el(
      "div",
      { class: "screen-foot" },
      el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.goto(ctx.state.identity?.kind === "internal" ? "tasks" : "home") }, "Got it — make mine")
    )
  );
  return root;
}

function resumeWorkflowExample(ctx: Ctx): HTMLElement {
  const records = [...ctx.state.records.values()].filter((record) => ctx.actions.isIncluded(record));
  const recommendation = recommendApps(records, MYPCBENCH_APPS.length).find((item) => item.app.id === "lockedin");
  const hasResume = Boolean(recommendation?.recordIds.some((id) => ctx.state.records.get(id)?.source === "documents"));
  const start = () => {
    if (recommendation && hasResume) {
      ctx.actions.startRecommendedTask(recommendation);
      return;
    }
    ctx.state.filters.source = "documents";
    ctx.state.filters.status = "all";
    ctx.state.filters.page = 0;
    ctx.actions.goto("items");
  };
  return el(
    "section",
    { class: "resume-workflow-example card", "data-testid": "resume-workflow-example" },
    el(
      "div",
      { class: "resume-workflow-copy" },
      el("p", { class: "section-label" }, "START WITH A DOCUMENT"),
      el("h3", null, "Upload a resume and build a connected task"),
      el("p", { class: "resume-workflow-path mono" }, "RESUME → LOCKEDIN → HOOLIMAIL → HOOLICALENDAR"),
      el("p", { class: "example-text clamped" }, RESUME_LOCKEDIN_EXAMPLE.text),
    ),
    el(
      "ol",
      { class: "resume-workflow-steps" },
      el("li", null, el("strong", null, "Upload"), el("span", null, "Apollo extracts the resume locally and lets you review the text.")),
      el("li", null, el("strong", null, "Ground"), el("span", null, "The draft attaches matching career mail, calendar events, and the resume.")),
      el("li", null, el("strong", null, "Run"), el("span", null, "Use current logged-in app state, make supported changes, and verify the result.")),
    ),
    el(
      "div",
      { class: "resume-workflow-actions" },
      el("button", { class: "btn primary", type: "button", "data-testid": "resume-example-start", onclick: start }, hasResume ? "Build from my resume →" : "Upload a resume →"),
      el("a", { class: "btn ghost", href: "https://lockedin.mypcbench.app/profile?_autologin=1", target: "_blank", rel: "noreferrer" }, "Open LockedIn ↗"),
    ),
  );
}

function difficultyLabel(level: string): string {
  return level === "low" ? "Easy" : level === "medium" ? "Medium" : "Hard";
}
