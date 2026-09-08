const fmt = (value) => value === null || value === undefined ? "N/A" : value.toFixed(3);
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

const FEATURED_TASK_IDS = {
  "gpt-5.6-sol": {
    lower: [
      "v2/shahzan-t-turing-com/internal/task-d46b56f0-20260813T114702",
      "v2/olmir-n-turing-com/internal/task-cd916902-20260817T220649",
      "v2/olmir-n-turing-com/internal/task-f4065cc6-20260817T221239",
      "v2/lucas-b4-turing-com/internal/task-e65e9fc3-20260814T211730",
    ],
    strong: [
      "v2/panwaranubhav07-gmail-com/internal/task-a254d056-20260815T153522",
      "v2/panwaranubhav07-gmail-com/internal/task-611aacfe-20260818T184711",
      "v2/emmanuel-r1-turing-com/internal/task-b853c070-20260817T195059",
      "v2/lucas-b4-turing-com/internal/task-f2557462-20260814T225918",
    ],
  },
  "claude-opus-5": {
    lower: [
      "v2/onkar-y-turing-com/internal/task-3bf797b1-20260818T090144",
      "v2/sufiyan-k-turing-com/internal/task-2ef32c40-20260818T093351",
      "v2/felipe-p1-turing-com/internal/task-f7adbfe4-20260817T151330",
      "v2/lucas-b4-turing-com/internal/task-0eb0453c-20260817T223339",
    ],
    strong: [
      "v2/panwaranubhav07-gmail-com/internal/task-019806cd-20260817T183415",
      "v2/mukund-m1-turing-com/internal/task-b31f013b-20260817T090858",
      "v2/olmir-n-turing-com/internal/task-94f94f83-20260828T203954",
      "v2/onkar-y-turing-com/internal/task-38ea1f2e-20260813T055511",
    ],
  },
};

let tasks = [];
let dataset;
let visibleLimit = 24;
let sort = { key: "title", direction: 1 };
let featuredTasks = [];
let featuredTask;
let featuredModel = "gpt-5.6-sol";
let featuredOutcome = "lower";
let featuredRun;
let featuredRubricProgress = [];
let featuredRubricMilestones = [];
let featuredStepIndex = 0;
let featuredRunLoadId = 0;
let featuredImageLoadId = 0;
let featuredPlaying = false;
let featuredTimer;
let featuredInView = false;
let featuredUserPaused = false;

const featuredElements = {
  section: document.getElementById("examples"),
  list: document.getElementById("featuredTaskList"),
  select: document.getElementById("featuredTaskSelect"),
  category: document.getElementById("featuredCategory"),
  title: document.getElementById("featuredTitle"),
  modelTabs: document.getElementById("featuredModelTabs"),
  outcomeTabs: document.getElementById("featuredOutcomeTabs"),
  agent: document.getElementById("featuredAgent"),
  outcome: document.getElementById("featuredOutcome"),
  frame: document.getElementById("featuredFrame"),
  loading: document.getElementById("featuredLoading"),
  image: document.getElementById("featuredImage"),
  error: document.getElementById("featuredError"),
  position: document.getElementById("featuredPosition"),
  action: document.getElementById("featuredAction"),
  score: document.getElementById("featuredScore"),
  rubrics: document.getElementById("featuredRubrics"),
  evidenceScore: document.getElementById("featuredEvidenceScore"),
  finalScore: document.getElementById("featuredFinalScore"),
  scoreTimeline: document.getElementById("featuredScoreTimeline"),
  rubricMeta: document.getElementById("featuredRubricMeta"),
  rubricList: document.getElementById("featuredRubricList"),
  play: document.getElementById("featuredPlay"),
  previous: document.getElementById("featuredPrevious"),
  next: document.getElementById("featuredNext"),
  scrubber: document.getElementById("featuredScrubber"),
  open: document.getElementById("featuredOpen"),
};

function analysisForDisplay() {
  const source = dataset.analysis || FALLBACK_ANALYSIS;
  const modelStats = Object.fromEntries(Object.keys(dataset.models).map((model) => {
    const recorded = tasks.filter((task) => task.runs[model]);
    const missingRuns = tasks.length - recorded.length;
    const scores = tasks.map((task) => task.runs[model]?.score ?? 0);
    return [model, {
      ...(source.model_stats?.[model] || {}),
      runs: recorded.length,
      missing_runs: missingRuns,
      counted_tasks: tasks.length,
      mean_score: mean(scores),
      zero_score_runs: recorded.filter((task) => task.runs[model].score === 0).length + missingRuns,
    }];
  }));

  let solWins = 0;
  let opusWins = 0;
  let ties = 0;
  let recordedPairs = 0;
  tasks.forEach((task) => {
    const solRun = task.runs["gpt-5.6-sol"];
    const opusRun = task.runs["claude-opus-5"];
    if (solRun && opusRun) recordedPairs += 1;
    const solScore = solRun?.score ?? 0;
    const opusScore = opusRun?.score ?? 0;
    if (solScore > opusScore) solWins += 1;
    else if (opusScore > solScore) opusWins += 1;
    else ties += 1;
  });

  return {
    ...source,
    model_stats: modelStats,
    head_to_head: {
      counted_tasks: tasks.length,
      recorded_pairs: recordedPairs,
      shared_tasks: recordedPairs,
      sol_wins: solWins,
      opus_wins: opusWins,
      ties,
    },
  };
}

function renderOverview() {
  const analysis = analysisForDisplay();
  const bestMean = Math.max(...Object.values(analysis.model_stats).map((stats) => stats.mean_score));
  const categories = [...new Set(tasks.map((task) => task.category).filter(Boolean))].sort();

  document.getElementById("sub").textContent =
    `${tasks.length} screened, long-horizon tasks test whether agents can research, compare, and act across real websites. ` +
    `Each agent receives the same interaction budget. A separate judge scores every requirement against the complete visual record.`;
  document.getElementById("heroMetric").innerHTML = `
    <strong>${fmt(bestMean)}</strong>
    <span>best mean rubric score</span>`;
  document.getElementById("stats").innerHTML = `
    <div><strong>${tasks.length}</strong><span>tasks in sample set</span></div>
    <div><strong>${Object.keys(dataset.models).length}</strong><span>frontier agents</span></div>
    <div><strong>${analysis.total_rubrics.toLocaleString()}</strong><span>scored rubrics</span></div>
    <div><strong>${categories.length}</strong><span>task categories</span></div>`;

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
      note: `${tasks.length} tasks · ${analysis.model_stats["gpt-5.6-sol"].missing_runs} missing run counted as zero`,
      score: analysis.model_stats["gpt-5.6-sol"].mean_score,
    },
    {
      label: dataset.models["claude-opus-5"],
      note: `${tasks.length} tasks · ${tasks.filter((task) => task.runs["claude-opus-5"]?.truncated).length} reached the cap`,
      score: analysis.model_stats["claude-opus-5"].mean_score,
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
  const analysis = analysisForDisplay();
  const opus = analysis.model_stats["claude-opus-5"];
  const sol = analysis.model_stats["gpt-5.6-sol"];
  const head = analysis.head_to_head;
  const cap = analysis.opus_cap_comparison;
  const modes = analysis.failure_modes;

  document.getElementById("resultsProse").textContent =
    `The average scores are close. sol averages ${fmt(sol.mean_score)} and Opus 5 averages ${fmt(opus.mean_score)}. ` +
    `The missing sol run counts as zero rather than being dropped. Across all ${head.counted_tasks} tasks, ` +
    `Opus 5 wins ${head.opus_wins}, sol wins ${head.sol_wins}, and ${head.ties} tie. ` +
    `The result varies with the kind of work in the task.`;

  document.getElementById("failureLead").textContent =
    `Across the ${tasks.length} tasks, the judge scored ${analysis.total_rubrics.toLocaleString()} rubrics and found that ` +
    `${analysis.failed_rubrics} requirements failed. The judge explanations point most often to incomplete ` +
    `deliverables and missing synthesis, even when the browser history shows substantial research.`;

  const findings = [
    {
      value: `${head.opus_wins} to ${head.sol_wins}`,
      label: "Opus 5 vs sol wins",
      note: `${head.ties} ties across ${head.counted_tasks} tasks`,
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

function compactCopy(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const breakAt = text.lastIndexOf(" ", limit);
  return `${text.slice(0, breakAt > limit * 0.7 ? breakAt : limit)}…`;
}

function featuredLabel(model) {
  return model === "claude-opus-5" ? "Opus 5" : "sol";
}

function setFeaturedPlaying(value, userAction = false) {
  featuredPlaying = value;
  clearTimeout(featuredTimer);
  if (userAction) featuredUserPaused = !value;
  featuredElements.play.innerHTML = value ? "Ⅱ <span>Pause</span>" : "▶ <span>Play</span>";
  featuredElements.play.setAttribute("aria-label", value ? "Pause trajectory" : "Play trajectory");
}

function scheduleFeaturedStep() {
  clearTimeout(featuredTimer);
  if (!featuredPlaying || !featuredRun?.trajectory.length) return;
  featuredTimer = setTimeout(() => {
    featuredStepIndex = (featuredStepIndex + 1) % featuredRun.trajectory.length;
    drawFeaturedStep();
  }, 2300);
}

function preloadFeaturedNext() {
  if (!featuredRun?.trajectory.length) return;
  const next = featuredRun.trajectory[(featuredStepIndex + 1) % featuredRun.trajectory.length];
  if (!next?.screenshot_key) return;
  const image = new Image();
  image.src = `/api/shot?key=${encodeURIComponent(next.screenshot_key)}`;
}

function buildFeaturedRubricProgress() {
  const scoredGrades = featuredRun.grades.filter((grade) => ["SUCCESS", "FAILURE"].includes(grade.status));
  const finalStep = Number(featuredRun.trajectory.at(-1)?.step || featuredRun.steps || 1);
  featuredRubricMilestones = scoredGrades.map((grade) => {
    if (grade.status !== "SUCCESS") return { grade, milestone: null };
    const citedSteps = [...String(grade.reasoning || "").matchAll(/\b(?:steps?|screenshots?)\s*#?\s*(\d+)/gi)]
      .map((match) => Number(match[1]))
      .filter((step) => step >= 1 && step <= finalStep);
    return { grade, milestone: citedSteps.length ? Math.min(...citedSteps) : finalStep };
  });
  featuredRubricProgress = featuredRun.trajectory.map((step) => {
    const supported = featuredRubricMilestones.filter((item) =>
      item.grade.status === "SUCCESS" && item.milestone <= Number(step.step)).length;
    return { supported, score: scoredGrades.length ? supported / scoredGrades.length : 0 };
  });

  const width = 300;
  const height = 58;
  const pad = 5;
  const points = featuredRubricProgress.map((item, index) => ({
    x: pad + (index / Math.max(1, featuredRubricProgress.length - 1)) * (width - pad * 2),
    y: height - pad - item.score * (height - pad * 2),
  }));
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const area = points.length
    ? `${line} L${points.at(-1).x.toFixed(2)},${height - pad} L${pad},${height - pad} Z`
    : "";
  featuredElements.scoreTimeline.innerHTML = `
    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="featured-timeline-axis"></line>
    <line x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}" class="featured-timeline-guide"></line>
    <path d="${area}" class="featured-timeline-area"></path>
    <path d="${line}" class="featured-timeline-line"></path>
    <circle id="featuredScoreTimelineMarker" r="4" class="featured-timeline-marker"></circle>`;
  featuredElements.finalScore.textContent = `Final ${featuredRun.score.toFixed(3)}`;
}

function updateFeaturedRubricProgress() {
  const item = featuredRubricProgress[featuredStepIndex];
  const step = featuredRun.trajectory[featuredStepIndex];
  if (!item || !step) return;
  const width = 300;
  const height = 58;
  const pad = 5;
  const x = pad + (featuredStepIndex / Math.max(1, featuredRubricProgress.length - 1)) * (width - pad * 2);
  const y = height - pad - item.score * (height - pad * 2);
  const marker = document.getElementById("featuredScoreTimelineMarker");
  marker?.setAttribute("cx", x.toFixed(2));
  marker?.setAttribute("cy", y.toFixed(2));
  featuredElements.evidenceScore.textContent = item.score.toFixed(3);
  featuredElements.rubricMeta.textContent = `${item.supported} of ${featuredRun.rubrics_scored} supported by this frame`;
  featuredElements.rubricList.innerHTML = featuredRubricMilestones.map(({ grade, milestone }) => {
    const supported = grade.status === "SUCCESS" && milestone <= Number(step.step);
    const failed = grade.status === "FAILURE";
    const state = supported ? "supported" : failed ? "failure" : "pending";
    const icon = supported ? "✓" : failed ? "×" : "·";
    const label = supported ? "Cited by this frame" : failed ? "Final fail" : "Not yet cited";
    return `<div class="featured-rubric-row ${state}">
      <span class="featured-rubric-icon" aria-hidden="true">${icon}</span>
      <div><p>${escapeHtml(compactCopy(grade.requirement, 115))}</p><small>${label}</small></div>
    </div>`;
  }).join("");
}

function drawFeaturedStep() {
  const step = featuredRun?.trajectory[featuredStepIndex];
  if (!step) return;

  featuredElements.position.textContent = `Frame ${featuredStepIndex + 1}`;
  featuredElements.action.textContent = compactCopy(step.action || step.response || "No action was recorded for this frame.");
  featuredElements.previous.disabled = featuredStepIndex === 0;
  featuredElements.next.disabled = featuredStepIndex === featuredRun.trajectory.length - 1;
  featuredElements.scrubber.value = String(featuredStepIndex + 1);
  featuredElements.scrubber.setAttribute("aria-valuetext", `Frame ${featuredStepIndex + 1}`);
  updateFeaturedRubricProgress();
  featuredImageLoadId += 1;
  const thisLoad = featuredImageLoadId;
  featuredElements.image.hidden = true;
  featuredElements.error.hidden = true;
  featuredElements.loading.hidden = false;
  featuredElements.frame.setAttribute("aria-busy", "true");

  if (!step.screenshot_key) {
    featuredElements.loading.hidden = true;
    featuredElements.error.hidden = false;
    featuredElements.frame.setAttribute("aria-busy", "false");
    scheduleFeaturedStep();
    return;
  }

  featuredElements.image.onload = () => {
    if (thisLoad !== featuredImageLoadId) return;
    featuredElements.loading.hidden = true;
    featuredElements.image.hidden = false;
    featuredElements.frame.setAttribute("aria-busy", "false");
    preloadFeaturedNext();
    scheduleFeaturedStep();
  };
  featuredElements.image.onerror = () => {
    if (thisLoad !== featuredImageLoadId) return;
    featuredElements.loading.hidden = true;
    featuredElements.error.hidden = false;
    featuredElements.frame.setAttribute("aria-busy", "false");
    scheduleFeaturedStep();
  };
  featuredElements.image.alt = `Recorded browser state from ${featuredLabel(featuredModel)} at frame ${featuredStepIndex + 1}`;
  featuredElements.image.src = `/api/shot?key=${encodeURIComponent(step.screenshot_key)}`;
}

function updateFeaturedTaskPicker() {
  featuredElements.list.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.taskId === featuredTask?.task_id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  featuredElements.select.value = featuredTask?.task_id || "";
}

function renderFeaturedModelTabs() {
  featuredElements.modelTabs.innerHTML = Object.keys(dataset.models)
    .map((model) => `<button type="button" data-featured-model="${escapeHtml(model)}" class="${model === featuredModel ? "active" : ""}" aria-pressed="${model === featuredModel}">${escapeHtml(featuredLabel(model))}</button>`)
    .join("");
}

function renderFeaturedOutcomeTabs() {
  featuredElements.outcomeTabs.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.featuredOutcome === featuredOutcome;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function pickFeaturedTasks() {
  const ids = FEATURED_TASK_IDS[featuredModel]?.[featuredOutcome] || [];
  const selected = ids.map((taskId) => tasks.find((task) => task.task_id === taskId))
    .filter((task) => task?.runs[featuredModel]);
  const isMatch = (task) => {
    const run = task.runs[featuredModel];
    return featuredOutcome === "lower" ? run?.score <= 0.35 && run.steps >= 20 : run?.score >= 0.85;
  };
  const fallback = tasks.filter((task) => isMatch(task) && !selected.includes(task))
    .sort((left, right) => {
      const delta = left.runs[featuredModel].score - right.runs[featuredModel].score;
      return featuredOutcome === "lower" ? delta : -delta;
    });
  const usedCategories = new Set(selected.map((task) => task.category));
  for (const task of fallback) {
    if (selected.length >= 4) break;
    if (usedCategories.has(task.category)) continue;
    selected.push(task);
    usedCategories.add(task.category);
  }
  for (const task of fallback) {
    if (selected.length >= 4) break;
    if (!selected.includes(task)) selected.push(task);
  }
  return selected.slice(0, 4);
}

function renderFeaturedTaskOptions() {
  featuredElements.list.innerHTML = featuredTasks.map((task, index) => {
    const run = task.runs[featuredModel];
    return `<button type="button" data-task-id="${escapeHtml(task.task_id)}" aria-pressed="false">
      <span>${String(index + 1).padStart(2, "0")} · ${escapeHtml(task.category || "Web research")}</span>
      <strong>${escapeHtml(compactCopy(task.title || task.request, 88))}</strong>
      <small><b>${run.score.toFixed(3)}</b> score · ${escapeHtml(run.rubrics_passed.replace("/", " of "))} rubrics</small>
    </button>`;
  }).join("");
  featuredElements.select.innerHTML = featuredTasks.map((task) => {
    const run = task.runs[featuredModel];
    return `<option value="${escapeHtml(task.task_id)}">${run.score.toFixed(3)} · ${escapeHtml(task.category || "Web research")} · ${escapeHtml(compactCopy(task.title || task.request, 64))}</option>`;
  }).join("");
}

function refreshFeaturedTasks() {
  featuredTasks = pickFeaturedTasks();
  renderFeaturedModelTabs();
  renderFeaturedOutcomeTabs();
  renderFeaturedTaskOptions();
  featuredElements.agent.textContent = featuredLabel(featuredModel);
  featuredElements.outcome.textContent = featuredOutcome === "lower" ? "Task failure" : "Strong run";
  if (featuredTasks.length) selectFeaturedTask(featuredTasks[0].task_id);
}

async function loadFeaturedRun() {
  const reference = featuredTask.runs[featuredModel];
  const thisLoad = ++featuredRunLoadId;
  featuredImageLoadId += 1;
  setFeaturedPlaying(false);
  featuredRun = undefined;
  featuredStepIndex = 0;
  featuredElements.play.disabled = true;
  featuredElements.previous.disabled = true;
  featuredElements.next.disabled = true;
  featuredElements.scrubber.disabled = true;
  featuredElements.image.hidden = true;
  featuredElements.error.hidden = true;
  featuredElements.loading.hidden = false;
  featuredElements.frame.setAttribute("aria-busy", "true");
  featuredElements.position.textContent = "Loading trajectory";
  featuredElements.action.textContent = "Loading the recorded actions";
  featuredElements.score.textContent = reference.score.toFixed(3);
  featuredElements.rubrics.textContent = reference.rubrics_passed.replace("/", " of ");
  featuredElements.evidenceScore.textContent = "0.000";
  featuredElements.finalScore.textContent = `Final ${reference.score.toFixed(3)}`;
  featuredElements.rubricMeta.textContent = "Loading rubric evidence";
  featuredElements.rubricList.innerHTML = '<div class="featured-rubric-loading">Loading final rubric verdicts</div>';
  featuredElements.scoreTimeline.innerHTML = "";
  featuredElements.open.href = `/run?id=${encodeURIComponent(reference.run)}`;

  try {
    const response = await fetch(`/data/runs/${encodeURIComponent(reference.run)}.json`);
    if (!response.ok) throw new Error(`Run request failed (${response.status})`);
    const loadedRun = await response.json();
    if (thisLoad !== featuredRunLoadId) return;
    featuredRun = loadedRun;
    buildFeaturedRubricProgress();
    featuredElements.scrubber.max = String(featuredRun.trajectory.length);
    featuredElements.play.disabled = false;
    featuredElements.scrubber.disabled = false;
    drawFeaturedStep();
    if (featuredInView && !featuredUserPaused && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFeaturedPlaying(true);
      scheduleFeaturedStep();
    }
  } catch (error) {
    if (thisLoad !== featuredRunLoadId) return;
    featuredElements.loading.hidden = true;
    featuredElements.error.hidden = false;
    featuredElements.error.textContent = "This trajectory could not be loaded";
    featuredElements.frame.setAttribute("aria-busy", "false");
  }
}

async function selectFeaturedTask(taskId) {
  const nextTask = featuredTasks.find((task) => task.task_id === taskId);
  if (!nextTask) return;
  featuredTask = nextTask;
  featuredElements.category.textContent = featuredTask.category || "Web research";
  featuredElements.title.textContent = compactCopy(featuredTask.title || featuredTask.request, 150);
  updateFeaturedTaskPicker();
  await loadFeaturedRun();
}

function initTrajectoryShowcase() {
  featuredElements.list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-task-id]");
    if (button) selectFeaturedTask(button.dataset.taskId);
  });
  featuredElements.select.addEventListener("change", (event) => selectFeaturedTask(event.target.value));
  featuredElements.modelTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-featured-model]");
    if (!button || button.dataset.featuredModel === featuredModel) return;
    featuredModel = button.dataset.featuredModel;
    featuredUserPaused = false;
    refreshFeaturedTasks();
  });
  featuredElements.outcomeTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-featured-outcome]");
    if (!button || button.dataset.featuredOutcome === featuredOutcome) return;
    featuredOutcome = button.dataset.featuredOutcome;
    featuredUserPaused = false;
    refreshFeaturedTasks();
  });
  featuredElements.previous.addEventListener("click", () => {
    if (!featuredRun) return;
    setFeaturedPlaying(false, true);
    featuredStepIndex = Math.max(0, featuredStepIndex - 1);
    drawFeaturedStep();
  });
  featuredElements.next.addEventListener("click", () => {
    if (!featuredRun) return;
    setFeaturedPlaying(false, true);
    featuredStepIndex = Math.min(featuredRun.trajectory.length - 1, featuredStepIndex + 1);
    drawFeaturedStep();
  });
  featuredElements.play.addEventListener("click", () => {
    if (!featuredRun) return;
    setFeaturedPlaying(!featuredPlaying, true);
    if (featuredPlaying) scheduleFeaturedStep();
  });
  featuredElements.scrubber.addEventListener("input", (event) => {
    setFeaturedPlaying(false, true);
    featuredStepIndex = Number(event.target.value) - 1;
    drawFeaturedStep();
  });

  const observer = new IntersectionObserver(([entry]) => {
    featuredInView = entry.isIntersecting;
    if (!featuredRun) return;
    if (featuredInView && !featuredUserPaused && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFeaturedPlaying(true);
      scheduleFeaturedStep();
    } else if (!featuredInView) {
      setFeaturedPlaying(false);
    }
  }, { threshold: 0.3 });
  observer.observe(featuredElements.section);
  refreshFeaturedTasks();
}

function sortValue(task, key) {
  if (key === "opus") return task.runs["claude-opus-5"]?.score ?? -1;
  if (key === "sol") return task.runs["gpt-5.6-sol"]?.score ?? -1;
  return (task.title || task.task_id).toLowerCase();
}

function scoreItem(task, model, shortLabel) {
  const run = task.runs[model];
  if (!run) return `<div class="task-score empty" title="No run was published. This outcome counts as zero in benchmark results."><span>${shortLabel}</span><strong>0.000</strong><small>Missing run · counted as failure</small></div>`;
  const cap = run.truncated ? `<em title="Reached the shared interaction limit">cap</em>` : "";
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
    initTrajectoryShowcase();
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
