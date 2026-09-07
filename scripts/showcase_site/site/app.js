const fmt = (value) => value === null || value === undefined ? "—" : value.toFixed(3);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[character]));

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
