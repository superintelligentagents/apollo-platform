const fmt = (value) => value === null || value === undefined ? "—" : value.toFixed(3);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[character]));

// The checked-in export predates aggregate story metrics. A future dataset rebuild
// writes this same shape from export_dataset.py, so the narrative stays reproducible.
const FALLBACK_ANALYSIS = {
  total_runs: 195,
  total_rubrics: 1866,
  failed_rubrics: 827,
  model_stats: {
    "claude-opus-5": {
      runs: 100, mean_score: 0.554, mean_steps: 100.8, cap_runs: 55,
      rubrics_passed: 494, rubrics_scored: 959, rubric_pass_rate: 0.5151,
      zero_score_runs: 15, perfect_runs: 15,
    },
    "gpt-5.6-sol": {
      runs: 95, mean_score: 0.5782, mean_steps: 32.7, cap_runs: 0,
      rubrics_passed: 545, rubrics_scored: 907, rubric_pass_rate: 0.6009,
      zero_score_runs: 4, perfect_runs: 16,
    },
  },
  head_to_head: { shared_tasks: 95, sol_wins: 42, opus_wins: 44, ties: 9 },
  opus_cap_comparison: {
    capped: { failed: 394, scored: 615, rate: 0.6407 },
    uncapped: { failed: 71, scored: 344, rate: 0.2064 },
  },
  failure_modes: {
    unfinished_outcome: 303,
    missing_details: 119,
    weak_verification: 40,
    access_failure: 40,
  },
};

let tasks = [];
let dataset;
let visibleLimit = 24;
let sort = { key: "title", direction: 1 };

function modelScores(model) {
  return tasks.filter((task) => task.runs[model]).map((task) => task.runs[model].score);
}

function renderOverview() {
  const opusScores = modelScores("claude-opus-5");
  const solScores = modelScores("gpt-5.6-sol");
  const totalRuns = opusScores.length + solScores.length;
  const bestMean = Math.max(mean(opusScores), mean(solScores));

  document.getElementById("sub").textContent =
    `${tasks.length} screened, long-horizon tasks test whether agents can research, compare, and act across real websites. ` +
    `Each agent receives the same ${dataset.max_steps}-step budget. A separate judge scores every requirement against the complete visual record.`;
  document.getElementById("heroMetric").innerHTML = `
    <strong>${fmt(bestMean)}</strong>
    <span>best mean rubric score</span>`;
  document.getElementById("stats").innerHTML = `
    <div><strong>${tasks.length}</strong><span>hard tasks</span></div>
    <div><strong>${Object.keys(dataset.models).length}</strong><span>frontier agents</span></div>
    <div><strong>${totalRuns}</strong><span>recorded runs</span></div>
    <div><strong>${dataset.max_steps}</strong><span>steps / run</span></div>`;

  const categories = [...new Set(tasks.map((task) => task.category).filter(Boolean))].sort();
  document.getElementById("categoryCount").textContent = `${categories.length} categories`;
  document.getElementById("cat").insertAdjacentHTML("beforeend",
    categories.map((category) => `<option>${escapeHtml(category)}</option>`).join(""));

  const distribution = categories.map((category) => ({
    category,
    count: tasks.filter((task) => task.category === category).length,
  })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const largestCategory = Math.max(...distribution.map((item) => item.count));
  document.getElementById("distribution").innerHTML = distribution.map((item) => `
    <div class="distribution-row">
      <div class="distribution-label"><span>${escapeHtml(item.category)}</span><strong>${item.count}</strong></div>
      <div class="distribution-track"><span style="width:${(item.count / largestCategory) * 100}%"></span></div>
    </div>`).join("");

  const agents = [
    {
      label: dataset.models["gpt-5.6-sol"],
      note: `${solScores.length} runs · ${tasks.filter((task) => task.runs["gpt-5.6-sol"]?.truncated).length} reached the cap`,
      score: mean(solScores),
    },
    {
      label: dataset.models["claude-opus-5"],
      note: `${opusScores.length} runs · ${tasks.filter((task) => task.runs["claude-opus-5"]?.truncated).length} reached the cap`,
      score: mean(opusScores),
    },
  ];
  document.getElementById("agentList").innerHTML = agents.map((agent) => `
    <div class="agent-row">
      <div><strong>${escapeHtml(agent.label)}</strong><span>${escapeHtml(agent.note)}</span></div>
      <b>${fmt(agent.score)}</b>
      <div class="agent-track"><span style="width:${agent.score * 100}%"></span></div>
    </div>`).join("");
}

function renderNarrative() {
  const analysis = dataset.analysis || FALLBACK_ANALYSIS;
  const opus = analysis.model_stats["claude-opus-5"];
  const sol = analysis.model_stats["gpt-5.6-sol"];
  const head = analysis.head_to_head;
  const cap = analysis.opus_cap_comparison;
  const modes = analysis.failure_modes;

  document.getElementById("resultsProse").textContent =
    `The aggregate result is close: sol averages ${fmt(sol.mean_score)} and Opus 5 averages ${fmt(opus.mean_score)}. ` +
    `On the ${head.shared_tasks} tasks both agents attempted, Opus 5 wins ${head.opus_wins}, sol wins ${head.sol_wins}, ` +
    `and ${head.ties} tie—evidence that success depends on the kind of work, not a single universally stronger agent.`;

  document.getElementById("failureLead").textContent =
    `Across ${analysis.total_runs} trajectories and ${analysis.total_rubrics.toLocaleString()} scored rubrics, ` +
    `${analysis.failed_rubrics} requirements failed. The judge explanations point most often to incomplete ` +
    `deliverables and missing synthesis, even when the browser history shows substantial research.`;

  const findings = [
    {
      value: `${head.opus_wins}–${head.sol_wins}`,
      label: "Opus 5 vs sol wins",
      note: `${head.ties} ties across ${head.shared_tasks} shared tasks`,
    },
    {
      value: `${Math.round((opus.cap_runs / opus.runs) * 100)}%`,
      label: "of Opus 5 runs reached the step cap",
      note: `${Math.round(cap.capped.rate * 100)}% failed-rubric rate when capped vs ${Math.round(cap.uncapped.rate * 100)}% when uncapped`,
    },
    {
      value: modes.unfinished_outcome.toLocaleString(),
      label: "failed rubrics signal unfinished output",
      note: `Compared with ${modes.access_failure} that mention navigation or access trouble`,
    },
  ];
  document.getElementById("findingGrid").innerHTML = findings.map((finding) => `
    <article class="finding-card">
      <strong>${escapeHtml(finding.value)}</strong>
      <h3>${escapeHtml(finding.label)}</h3>
      <p>${escapeHtml(finding.note)}</p>
    </article>`).join("");

  const failureLabels = {
    unfinished_outcome: ["Unfinished output or synthesis", "The requested artifact, comparison, or final answer was not completed."],
    missing_details: ["Missing required details", "A result was present, but required fields or coverage were incomplete."],
    weak_verification: ["Weak source verification", "Claims lacked the requested authoritative source or evidence."],
    access_failure: ["Navigation or access", "The trajectory records a load, login, paywall, or access problem."],
  };
  const maxMode = Math.max(...Object.values(modes));
  document.getElementById("failureTotal").textContent = `${analysis.failed_rubrics} failed rubrics`;
  document.getElementById("failureModes").innerHTML = Object.entries(failureLabels).map(([key, [label, note]]) => `
    <div class="failure-mode">
      <div class="failure-mode-head">
        <span>${escapeHtml(label)}</span>
        <strong>${modes[key].toLocaleString()}</strong>
      </div>
      <div class="failure-track"><span style="width:${(modes[key] / maxMode) * 100}%"></span></div>
      <p>${escapeHtml(note)}</p>
    </div>`).join("");
}

function sortValue(task, key) {
  if (key === "opus") return task.runs["claude-opus-5"]?.score ?? -1;
  if (key === "sol") return task.runs["gpt-5.6-sol"]?.score ?? -1;
  return (task.title || task.task_id).toLowerCase();
}

function scoreItem(task, model, shortLabel) {
  const run = task.runs[model];
  if (!run) return `<div class="task-score empty"><span>${shortLabel}</span><strong>—</strong><small>No run</small></div>`;
  const cap = run.truncated ? `<em title="Stopped at the ${dataset.max_steps}-step limit">cap</em>` : "";
  return `<a class="task-score" href="/run?id=${encodeURIComponent(run.run)}" aria-label="Watch ${escapeHtml(dataset.models[model])} trajectory, score ${run.score.toFixed(3)}">
    <span>${escapeHtml(shortLabel)} ${cap}</span>
    <strong>${run.score.toFixed(3)}</strong>
    <small>Watch trajectory →</small>
  </a>`;
}

function renderTasks({ resetLimit = false } = {}) {
  if (resetLimit) visibleLimit = 24;
  const query = document.getElementById("q").value.trim().toLowerCase();
  const category = document.getElementById("cat").value;
  const visibleTasks = tasks.filter((task) =>
    (!query || `${task.title} ${task.task_id} ${task.category}`.toLowerCase().includes(query)) &&
    (!category || task.category === category)
  ).sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    return (left < right ? -1 : left > right ? 1 : 0) * sort.direction;
  });
  const shownTasks = visibleTasks.slice(0, visibleLimit);

  document.getElementById("resultCount").textContent = visibleTasks.length > shownTasks.length
    ? `${shownTasks.length} shown · ${visibleTasks.length} matches`
    : `${visibleTasks.length} task${visibleTasks.length === 1 ? "" : "s"}`;
  document.getElementById("rows").innerHTML = shownTasks.map((task) => `
    <article class="task-card">
      <div class="task-card-meta"><span>${escapeHtml(task.category || "Uncategorized")}</span><span>${task.rubric_count} rubrics</span></div>
      <h3><a class="task-link" href="/task?id=${encodeURIComponent(task.task_id)}">${escapeHtml(task.title || task.task_id)}</a></h3>
      <div class="task-scores">
        ${scoreItem(task, "claude-opus-5", "Opus 5")}
        ${scoreItem(task, "gpt-5.6-sol", "sol")}
      </div>
      <a class="task-detail-link" href="/task?id=${encodeURIComponent(task.task_id)}">Task prompt and rubrics <span aria-hidden="true">→</span></a>
    </article>`).join("") || `<div class="table-state">No tasks match these filters.</div>`;

  const hasMore = shownTasks.length < visibleTasks.length;
  document.getElementById("loadMoreWrap").hidden = !hasMore;
  document.getElementById("showMore").textContent = hasMore
    ? `Show ${Math.min(24, visibleTasks.length - shownTasks.length)} more tasks`
    : "Show more tasks";
}

async function init() {
  try {
    const response = await fetch("/data/index.json");
    if (!response.ok) throw new Error(`Dataset request failed (${response.status})`);
    dataset = await response.json();
    tasks = dataset.tasks;
    renderOverview();
    renderNarrative();
    renderTasks();

    ["q", "cat"].forEach((id) => document.getElementById(id).addEventListener("input", () => renderTasks({ resetLimit: true })));
    document.getElementById("sortBy").addEventListener("change", (event) => {
      sort = { key: event.target.value, direction: event.target.value === "title" ? 1 : -1 };
      renderTasks({ resetLimit: true });
    });
    document.getElementById("showMore").addEventListener("click", () => {
      visibleLimit += 24;
      renderTasks();
    });
  } catch (error) {
    document.getElementById("sub").textContent = "The dataset could not be loaded. Refresh the page to try again.";
    document.getElementById("stats").innerHTML = "";
    document.getElementById("rows").innerHTML = `<div class="table-state error">${escapeHtml(error.message)}</div>`;
  }
}

init();
