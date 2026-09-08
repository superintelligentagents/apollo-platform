const taskId = new URLSearchParams(location.search).get("id");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[character]));

function shortTitle(task) {
  const firstSentence = (task.request || "").split(/(?<=\.)\s/)[0] || task.title || task.task_id;
  if (firstSentence.length <= 138) return firstSentence;
  const breakAt = firstSentence.lastIndexOf(" ", 138);
  return `${firstSentence.slice(0, breakAt > 96 ? breakAt : 138)}…`;
}

function gradeMarkup(grade) {
  const success = grade.status === "SUCCESS";
  return `<details class="grade-row ${success ? "success" : "failure"}">
    <summary>
      <span class="verdict-mark" aria-hidden="true">${success ? "✓" : "×"}</span>
      <span>${escapeHtml(grade.requirement)}</span>
      <strong>${success ? "Pass" : "Fail"}</strong>
    </summary>
    <p>${escapeHtml(grade.reasoning || "No judge reasoning recorded.")}</p>
  </details>`;
}

function runMarkup(run, label, maxSteps, runSlug, playerId) {
  const capped = run.truncated ? `<span class="cap">step cap</span>` : `<span class="complete-mark">within budget</span>`;
  return `<article class="run-card">
    <header class="run-card-head">
      <div><p class="eyebrow">Evaluated agent</p><h3>${escapeHtml(label)}</h3></div>
      <div class="score-block"><strong>${run.score.toFixed(3)}</strong><span>rubric score</span></div>
    </header>
    <div class="run-facts">
      <span><strong>${run.rubrics_passed}/${run.rubrics_scored}</strong> rubrics passed</span>
      <span><strong>${run.steps}</strong> steps</span>
      ${capped}
    </div>
    ${run.truncated ? `<p class="cap-note">This run stopped at the shared ${maxSteps}-step budget. Read low scores with that limit in mind.</p>` : ""}
    <section class="inline-player" data-player="${playerId}" aria-label="${escapeHtml(label)} trajectory slideshow">
      <header class="inline-player-head">
        <button type="button" data-prev aria-label="Previous ${escapeHtml(label)} step">←</button>
        <output data-position aria-live="polite">1 / ${run.trajectory.length}</output>
        <button type="button" data-next aria-label="Next ${escapeHtml(label)} step">→</button>
      </header>
      <div class="inline-shot-stage" data-stage aria-busy="true">
        <div class="inline-shot-loading" data-loading><span></span> Signing frame…</div>
        <img data-image alt="" hidden>
        <div class="inline-shot-error" data-error hidden>Screenshot unavailable.</div>
      </div>
      <div class="inline-playback">
        <button class="inline-play" type="button" data-play aria-label="Play ${escapeHtml(label)} trajectory">▶ <span>Play</span></button>
        <label><span class="visually-hidden">${escapeHtml(label)} trajectory step</span><input data-scrubber type="range" min="1" max="${run.trajectory.length}" value="1"></label>
      </div>
    </section>
    <a class="button primary" href="/run?id=${encodeURIComponent(runSlug)}">Open focused viewer <span aria-hidden="true">→</span></a>
    <div class="grade-list">
      <div class="grade-list-head"><h4>Rubric verdicts</h4><span>Open for judge reasoning</span></div>
      ${run.grades.map(gradeMarkup).join("")}
    </div>
  </article>`;
}

function createRunPreview(root, run) {
  let index = 0;
  let loadId = 0;
  let playing = false;
  let timer;
  const image = root.querySelector("[data-image]");
  const loading = root.querySelector("[data-loading]");
  const error = root.querySelector("[data-error]");
  const stage = root.querySelector("[data-stage]");
  const position = root.querySelector("[data-position]");
  const previous = root.querySelector("[data-prev]");
  const next = root.querySelector("[data-next]");
  const play = root.querySelector("[data-play]");
  const scrubber = root.querySelector("[data-scrubber]");

  const setPlaying = (value) => {
    playing = value;
    clearTimeout(timer);
    play.innerHTML = playing ? "Ⅱ <span>Pause</span>" : "▶ <span>Play</span>";
    play.setAttribute("aria-label", `${playing ? "Pause" : "Play"} trajectory`);
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!playing) return;
    if (index >= run.trajectory.length - 1) {
      setPlaying(false);
      return;
    }
    timer = setTimeout(() => {
      index += 1;
      draw();
    }, 1800);
  };

  const draw = () => {
    const step = run.trajectory[index];
    loadId += 1;
    const thisLoad = loadId;
    clearTimeout(timer);
    position.textContent = `${index + 1} / ${run.trajectory.length}`;
    previous.disabled = index === 0;
    next.disabled = index === run.trajectory.length - 1;
    scrubber.value = String(index + 1);
    image.hidden = true;
    error.hidden = true;
    loading.hidden = false;
    stage.setAttribute("aria-busy", "true");

    if (!step?.screenshot_key) {
      loading.hidden = true;
      error.hidden = false;
      stage.setAttribute("aria-busy", "false");
      schedule();
      return;
    }
    const url = `/api/shot?key=${encodeURIComponent(step.screenshot_key)}`;
    image.onload = () => {
      if (loadId !== thisLoad) return;
      loading.hidden = true;
      image.hidden = false;
      stage.setAttribute("aria-busy", "false");
      schedule();
    };
    image.onerror = () => {
      if (loadId !== thisLoad) return;
      loading.hidden = true;
      error.hidden = false;
      stage.setAttribute("aria-busy", "false");
      schedule();
    };
    image.alt = `Recorded browser state at ${run.model} trajectory step ${step.step}`;
    image.src = url;
  };

  previous.addEventListener("click", () => { setPlaying(false); index = Math.max(0, index - 1); draw(); });
  next.addEventListener("click", () => { setPlaying(false); index = Math.min(run.trajectory.length - 1, index + 1); draw(); });
  play.addEventListener("click", () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (index >= run.trajectory.length - 1) index = 0;
    setPlaying(true);
    draw();
  });
  scrubber.addEventListener("input", (event) => {
    setPlaying(false);
    index = Number(event.target.value) - 1;
    draw();
  });
  draw();
}

async function init() {
  try {
    if (!taskId) throw new Error("No task ID was provided.");
    const indexResponse = await fetch("/data/index.json");
    if (!indexResponse.ok) throw new Error(`Dataset request failed (${indexResponse.status})`);
    const data = await indexResponse.json();
    const task = data.tasks.find((candidate) => candidate.task_id === taskId);
    if (!task) throw new Error("This task is not present in the published dataset.");

    const title = shortTitle(task);
    document.title = `${title} | OdysseysMega`;
    document.getElementById("title").textContent = title;
    document.getElementById("meta").innerHTML = [
      task.category,
      `${task.rubric_count} rubrics`,
    ].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    document.getElementById("req").textContent = task.request;

    const entries = Object.entries(data.models);
    const results = await Promise.all(entries.map(async ([model, label], playerId) => {
      const reference = task.runs[model];
      if (!reference) return {
        markup: `<article class="run-card empty">
          <header class="run-card-head">
            <div><p class="eyebrow">Evaluated agent</p><h3>${escapeHtml(label)}</h3></div>
            <div class="score-block"><strong>0.000</strong><span>benchmark score</span></div>
          </header>
          <p>No run was published for this task. It counts as zero in the benchmark results, and there is no trajectory to show.</p>
        </article>`,
      };
      try {
        const response = await fetch(`/data/runs/${encodeURIComponent(reference.run)}.json`);
        if (!response.ok) throw new Error(`Run request failed (${response.status})`);
        const run = await response.json();
        return { playerId, run, markup: runMarkup(run, label, data.max_steps, reference.run, playerId) };
      } catch (error) {
        return {
          markup: `<article class="run-card empty"><p class="eyebrow">Evaluated agent</p><h3>${escapeHtml(label)}</h3><p>${escapeHtml(error.message)}</p></article>`,
        };
      }
    }));
    document.getElementById("runs").innerHTML = results.map((result) => result.markup).join("");
    results.filter((result) => result.run).forEach((result) => {
      createRunPreview(document.querySelector(`[data-player="${result.playerId}"]`), result.run);
    });
  } catch (error) {
    document.getElementById("title").textContent = "Task unavailable";
    document.getElementById("meta").innerHTML = "";
    document.getElementById("req").textContent = error.message;
    document.getElementById("runs").innerHTML = "";
  }
}

init();
