const id = new URLSearchParams(location.search).get("id");
const data = await (await fetch("/data/index.json")).json();
const task = data.tasks.find((t) => t.task_id === id);
if (!task) {
  document.getElementById("title").textContent = "Task not found";
} else {
  // The full request is shown below, so the heading is just its opening
  // sentence rather than a truncated copy of the same text.
  const first = (task.request || "").split(/(?<=\.)\s/)[0] || task.title || task.task_id;
  document.getElementById("title").textContent =
    first.length > 120 ? first.slice(0, first.lastIndexOf(" ", 120)) + "…" : first;
  document.getElementById("meta").textContent =
    [task.category, `${task.rubric_count} rubrics`, `luna baseline ${(task.baseline_luna ?? 0).toFixed(3)}`,
     task.task_id].filter(Boolean).join(" · ");
  document.getElementById("req").textContent = task.request;

  const out = [];
  for (const [model, label] of Object.entries(data.models)) {
    const ref = task.runs[model];
    if (!ref) { out.push(`<h2>${label}</h2><p class="mut">No run published.</p>`); continue; }
    const run = await (await fetch(`/data/runs/${ref.run}.json`)).json();
    const cap = run.truncated
      ? ` · <span class="mut">stopped at the ${data.max_steps}-step cap</span>` : "";
    out.push(`<h2>${label} — ${run.score.toFixed(3)}
        <span class="mut" style="font-weight:400">(${run.rubrics_passed}/${run.rubrics_scored} rubrics,
        ${run.steps} steps${cap})</span></h2>
      <p><a href="/run?id=${ref.run}">View the trajectory →</a></p>
      ${run.grades.map((g) => `<div class="g">
          <div class="s ${g.status}">${g.status}</div>
          <div class="r">${escape(g.requirement)}</div>
          <div class="w">${escape(g.reasoning)}</div>
        </div>`).join("")}`);
  }
  document.getElementById("runs").innerHTML = out.join("");
}
function escape(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
