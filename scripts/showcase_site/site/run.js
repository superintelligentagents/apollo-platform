const runSlug = new URLSearchParams(location.search).get("id");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[character]));

let run;
let dataset;
let currentTask;
let stepIndex = 0;
let imageLoadId = 0;
let playing = false;
let playbackTimer;
let rubricProgress = [];
const preloadedShots = new Set();

const elements = {
  workbench: document.getElementById("workbench"),
  error: document.getElementById("runError"),
  errorMessage: document.getElementById("runErrorMessage"),
  screenshot: document.getElementById("screenshot"),
  noScreenshot: document.getElementById("noScreenshot"),
  shotLoading: document.getElementById("shotLoading"),
  shotStage: document.getElementById("shotStage"),
  fullSize: document.getElementById("fullSize"),
  position: document.getElementById("stepPosition"),
  progress: document.getElementById("trajectoryProgress"),
  previous: document.getElementById("previousStep"),
  next: document.getElementById("nextStep"),
  stepTitle: document.getElementById("stepTitle"),
  action: document.getElementById("stepAction"),
  response: document.getElementById("stepResponse"),
  scrubber: document.getElementById("stepScrubber"),
  playPause: document.getElementById("playPause"),
  speed: document.getElementById("playbackSpeed"),
  taskPicker: document.getElementById("taskPicker"),
  modelPicker: document.getElementById("modelPicker"),
  scoreAtStep: document.getElementById("scoreAtStep"),
  progressRubrics: document.getElementById("progressRubrics"),
  scoreTimeline: document.getElementById("scoreTimeline"),
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

function screenshotUrl(step) {
  return `/api/shot?key=${encodeURIComponent(step.screenshot_key)}`;
}

function stepFromHash() {
  const match = location.hash.match(/^#step-(\d+)$/);
  if (!match || !run?.trajectory.length) return 0;
  const requestedStep = Number(match[1]);
  const exactIndex = run.trajectory.findIndex((step) => Number(step.step) === requestedStep);
  return exactIndex >= 0 ? exactIndex : 0;
}

function preloadNearby() {
  [stepIndex - 1, stepIndex + 1].forEach((index) => {
    const step = run.trajectory[index];
    if (!step?.screenshot_key) return;
    const url = screenshotUrl(step);
    if (preloadedShots.has(url)) return;
    preloadedShots.add(url);
    const image = new Image();
    image.src = url;
  });
}

function updatePlayButton() {
  elements.playPause.innerHTML = playing ? "Ⅱ <span>Pause</span>" : "▶ <span>Play</span>";
  elements.playPause.setAttribute("aria-label", playing ? "Pause trajectory" : "Play trajectory");
  elements.playPause.classList.toggle("playing", playing);
}

function pausePlayback() {
  playing = false;
  clearTimeout(playbackTimer);
  updatePlayButton();
}

function scheduleNext() {
  clearTimeout(playbackTimer);
  if (!playing) return;
  if (stepIndex >= run.trajectory.length - 1) {
    pausePlayback();
    return;
  }
  playbackTimer = setTimeout(() => {
    stepIndex += 1;
    drawStep();
  }, Number(elements.speed.value));
}

function togglePlayback() {
  if (playing) {
    pausePlayback();
    return;
  }
  if (stepIndex >= run.trajectory.length - 1) stepIndex = 0;
  playing = true;
  updatePlayButton();
  drawStep();
}

function loadScreenshot(step) {
  imageLoadId += 1;
  const thisLoad = imageLoadId;
  clearTimeout(playbackTimer);
  elements.screenshot.hidden = true;
  elements.noScreenshot.hidden = true;
  elements.fullSize.hidden = true;

  if (!step.screenshot_key) {
    elements.shotLoading.hidden = true;
    elements.noScreenshot.hidden = false;
    elements.shotStage.setAttribute("aria-busy", "false");
    scheduleNext();
    return;
  }

  const url = screenshotUrl(step);
  elements.shotLoading.hidden = false;
  elements.shotStage.setAttribute("aria-busy", "true");
  elements.screenshot.onload = () => {
    if (thisLoad !== imageLoadId) return;
    elements.shotLoading.hidden = true;
    elements.screenshot.hidden = false;
    elements.fullSize.hidden = false;
    elements.shotStage.setAttribute("aria-busy", "false");
    preloadNearby();
    scheduleNext();
  };
  elements.screenshot.onerror = () => {
    if (thisLoad !== imageLoadId) return;
    elements.shotLoading.hidden = true;
    elements.noScreenshot.textContent = "The screenshot could not be loaded. Move away and back to retry.";
    elements.noScreenshot.hidden = false;
    elements.shotStage.setAttribute("aria-busy", "false");
    scheduleNext();
  };
  elements.screenshot.alt = `Recorded browser state at trajectory step ${step.step}`;
  elements.screenshot.src = url;
  elements.fullSize.href = url;
}

function drawStep() {
  const step = run.trajectory[stepIndex];
  if (!step) return;

  elements.position.textContent = `${stepIndex + 1} / ${run.trajectory.length}`;
  elements.stepTitle.textContent = `Step ${step.step}`;
  elements.action.textContent = step.action || "No action recorded.";
  elements.response.textContent = step.response || "No agent response recorded.";
  elements.previous.disabled = stepIndex === 0;
  elements.next.disabled = stepIndex === run.trajectory.length - 1;
  elements.scrubber.value = String(stepIndex + 1);
  elements.scrubber.setAttribute("aria-valuetext", `Step ${stepIndex + 1} of ${run.trajectory.length}`);
  elements.progress.style.width = `${((stepIndex + 1) / run.trajectory.length) * 100}%`;
  history.replaceState(null, "", `${location.pathname}${location.search}#step-${step.step}`);
  updateRubricProgress();
  loadScreenshot(step);
}

function moveStep(delta) {
  const nextIndex = Math.max(0, Math.min(run.trajectory.length - 1, stepIndex + delta));
  if (nextIndex === stepIndex) return;
  stepIndex = nextIndex;
  drawStep();
}

function renderRubrics() {
  let openedFailure = false;
  document.getElementById("rubricTitle").textContent = `${run.rubrics_passed} of ${run.rubrics_scored} passed`;
  document.getElementById("rubricTab").textContent = `Rubrics ${run.rubrics_passed}/${run.rubrics_scored}`;
  document.getElementById("rubrics").innerHTML = run.grades.map((grade) => {
    const success = grade.status === "SUCCESS";
    const shouldOpen = !success && !openedFailure;
    if (shouldOpen) openedFailure = true;
    return `<details class="rubric-row ${success ? "success" : "failure"}"${shouldOpen ? " open" : ""}>
      <summary>
        <span class="verdict-mark" aria-hidden="true">${success ? "✓" : "×"}</span>
        <span>${escapeHtml(grade.rubric_id)}</span>
        <strong>${success ? "Pass" : "Fail"}</strong>
      </summary>
      <div><p>${escapeHtml(grade.requirement)}</p><small>${escapeHtml(grade.reasoning || "No judge reasoning recorded.")}</small></div>
    </details>`;
  }).join("");
}

function buildRubricProgress() {
  const finalStep = Number(run.trajectory[run.trajectory.length - 1]?.step || run.steps || 1);
  const milestones = run.grades.filter((grade) => grade.status === "SUCCESS").map((grade) => {
    const citedSteps = [...String(grade.reasoning || "").matchAll(/\b(?:steps?|screenshots?)\s*#?\s*(\d+)/gi)]
      .map((match) => Number(match[1]))
      .filter((step) => step >= 1 && step <= finalStep);
    return citedSteps.length ? Math.min(...citedSteps) : finalStep;
  });
  rubricProgress = run.trajectory.map((step) => {
    const passed = milestones.filter((milestone) => milestone <= Number(step.step)).length;
    return { passed, score: run.rubrics_scored ? passed / run.rubrics_scored : 0 };
  });

  const width = 300;
  const height = 58;
  const pad = 5;
  const pointFor = (item, index) => ({
    x: pad + (index / Math.max(1, rubricProgress.length - 1)) * (width - pad * 2),
    y: height - pad - item.score * (height - pad * 2),
  });
  const points = rubricProgress.map(pointFor);
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const area = points.length ? `${line} L${points[points.length - 1].x.toFixed(2)},${height - pad} L${pad},${height - pad} Z` : "";
  elements.scoreTimeline.innerHTML = `
    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="timeline-axis"></line>
    <line x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}" class="timeline-guide"></line>
    <path d="${area}" class="timeline-area"></path>
    <path d="${line}" class="timeline-line"></path>
    <circle id="scoreTimelineMarker" r="4" class="timeline-marker"></circle>`;
  document.getElementById("finalRubricScore").textContent = `final ${run.score.toFixed(3)}`;
}

function updateRubricProgress() {
  const item = rubricProgress[stepIndex];
  if (!item) return;
  const width = 300;
  const height = 58;
  const pad = 5;
  const x = pad + (stepIndex / Math.max(1, rubricProgress.length - 1)) * (width - pad * 2);
  const y = height - pad - item.score * (height - pad * 2);
  const marker = document.getElementById("scoreTimelineMarker");
  marker?.setAttribute("cx", x.toFixed(2));
  marker?.setAttribute("cy", y.toFixed(2));
  elements.scoreAtStep.value = item.score.toFixed(3);
  elements.progressRubrics.textContent = `${item.passed}/${run.rubrics_scored} supported by step ${run.trajectory[stepIndex].step}`;
}

function showInspector(mode) {
  const showingStep = mode === "step";
  document.getElementById("stepPanel").hidden = !showingStep;
  document.getElementById("rubricPanel").hidden = showingStep;
  document.getElementById("stepTab").classList.toggle("active", showingStep);
  document.getElementById("rubricTab").classList.toggle("active", !showingStep);
  document.getElementById("stepTab").setAttribute("aria-selected", String(showingStep));
  document.getElementById("rubricTab").setAttribute("aria-selected", String(!showingStep));
}

function trajectoryFor(task, preferredModel) {
  return task.runs[preferredModel] || Object.values(task.runs)[0];
}

function renderPickers() {
  elements.taskPicker.innerHTML = dataset.tasks.map((task, index) =>
    `<option value="${escapeHtml(task.task_id)}"${task.task_id === run.task_id ? " selected" : ""}>${index + 1}. ${escapeHtml(task.title || task.task_id)}</option>`
  ).join("");
  elements.modelPicker.innerHTML = Object.entries(dataset.models)
    .filter(([model]) => currentTask?.runs[model])
    .map(([model, label]) => `<option value="${escapeHtml(model)}"${model === run.model ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");

  elements.taskPicker.addEventListener("change", () => {
    const task = dataset.tasks.find((candidate) => candidate.task_id === elements.taskPicker.value);
    const target = task && trajectoryFor(task, run.model);
    if (target) location.href = `/run?id=${encodeURIComponent(target.run)}`;
  });
  elements.modelPicker.addEventListener("change", () => {
    const target = currentTask?.runs[elements.modelPicker.value];
    if (target) location.href = `/run?id=${encodeURIComponent(target.run)}`;
  });
}

function showError(error) {
  pausePlayback();
  elements.workbench.hidden = true;
  document.getElementById("runPicker").hidden = true;
  document.getElementById("taskReference").hidden = true;
  document.getElementById("meta").hidden = true;
  elements.errorMessage.textContent = error.message;
  elements.error.hidden = false;
  document.getElementById("title").textContent = "Trajectory unavailable";
}

async function init() {
  try {
    if (!runSlug) throw new Error("No run ID was provided.");
    [dataset, run] = await Promise.all([
      fetchJson("/data/index.json"),
      fetchJson(`/data/runs/${encodeURIComponent(runSlug)}.json`),
    ]);
    currentTask = dataset.tasks.find((candidate) => candidate.task_id === run.task_id);
    const modelLabel = dataset.models[run.model] || run.model;
    const taskTitle = currentTask?.title || run.task_id;

    document.title = `${modelLabel} trajectory | OdysseysMega`;
    document.getElementById("back").href = `/task?id=${encodeURIComponent(run.task_id)}`;
    document.getElementById("back").innerHTML = `<span aria-hidden="true">←</span> Back to task`;
    document.getElementById("title").textContent = modelLabel;
    document.getElementById("taskTitle").textContent = taskTitle;
    document.getElementById("meta").innerHTML = `
      <div class="summary-score"><strong>${run.score.toFixed(3)}</strong><span>rubric score</span></div>
      <div><strong>${run.rubrics_passed}/${run.rubrics_scored}</strong><span>rubrics passed</span></div>
      <div><strong>${run.steps}</strong><span>steps${run.truncated ? " · cap" : ""}</span></div>`;
    document.getElementById("prompt").textContent = currentTask?.request || "Task prompt unavailable.";
    document.getElementById("promptPreview").textContent = currentTask?.request
      ? `${currentTask.request.replace(/\s+/g, " ").slice(0, 150)}${currentTask.request.length > 150 ? "…" : ""}`
      : taskTitle;

    renderPickers();
    renderRubrics();
    buildRubricProgress();
    elements.scrubber.max = String(run.trajectory.length);
    stepIndex = stepFromHash();
    drawStep();

    elements.previous.addEventListener("click", () => moveStep(-1));
    elements.next.addEventListener("click", () => moveStep(1));
    elements.playPause.addEventListener("click", togglePlayback);
    elements.scrubber.addEventListener("input", (event) => {
      pausePlayback();
      stepIndex = Number(event.target.value) - 1;
      drawStep();
    });
    elements.speed.addEventListener("change", () => {
      if (playing) scheduleNext();
    });
    document.getElementById("stepTab").addEventListener("click", () => showInspector("step"));
    document.getElementById("rubricTab").addEventListener("click", () => showInspector("rubric"));
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") { moveStep(-1); event.preventDefault(); }
      if (event.key === "ArrowRight") { moveStep(1); event.preventDefault(); }
      if (event.key === "Home") { stepIndex = 0; drawStep(); event.preventDefault(); }
      if (event.key === "End") { stepIndex = run.trajectory.length - 1; drawStep(); event.preventDefault(); }
      if (event.code === "Space") { togglePlayback(); event.preventDefault(); }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pausePlayback();
    });
    document.getElementById("main").focus({ preventScroll: true });
  } catch (error) {
    showError(error);
  }
}

init();
