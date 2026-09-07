const slug = new URLSearchParams(location.search).get("id");
const data = await (await fetch("/data/index.json")).json();
const run = await (await fetch(`/data/runs/${slug}.json`)).json();
const task = data.tasks.find((t) => t.task_id === run.task_id);

document.getElementById("back").href = `/task?id=${encodeURIComponent(run.task_id)}`;
document.getElementById("back").textContent = "← Back to the task";
document.getElementById("title").textContent = `${data.models[run.model]} — ${run.score.toFixed(3)}`;
document.getElementById("meta").textContent = [
  `${run.rubrics_passed}/${run.rubrics_scored} rubrics`,
  `${run.steps} steps${run.truncated ? ` (stopped at the ${data.max_steps}-step cap)` : ""}`,
  task ? task.title : run.task_id,
].join(" · ");

// Screenshots are signed one at a time, and only when scrolled to: a run holds
// up to 120 frames, and signing them all upfront would be ~120 requests before
// anything is visible.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); }
  }
}, { rootMargin: "600px" });

document.getElementById("steps").innerHTML = run.trajectory.map((s) => `
  <div class="step">
    <div class="h">Step ${s.step}</div>
    ${s.action ? `<pre>${escape(s.action)}</pre>` : ""}
    ${s.response ? `<pre class="mut">${escape(s.response)}</pre>` : ""}
    ${s.screenshot_key ? `<img loading="lazy" alt="Step ${s.step}"
        data-src="/api/shot?key=${encodeURIComponent(s.screenshot_key)}">` : ""}
  </div>`).join("");
document.querySelectorAll("img[data-src]").forEach((img) => io.observe(img));

function escape(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
