const fmt = (v) => (v === null || v === undefined ? "—" : v.toFixed(3));
const data = await (await fetch("/data/index.json")).json();
const tasks = data.tasks;

document.getElementById("sub").textContent =
  `100 tasks where a weak agent scored below 0.35, screened for fairness and spread across the ` +
  `SimilarWeb taxonomy. Both models run on their own upstream prompt with a ${data.max_steps}-step ` +
  `budget, judged by ${data.judge} on every screenshot.`;

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const scores = (m) => tasks.filter((t) => t.runs[m]).map((t) => t.runs[m].score);
const both = tasks.filter((t) => t.runs["claude-opus-5"] && t.runs["gpt-5.6-sol"]);
document.getElementById("stats").innerHTML = `
  <div><b>${fmt(mean(scores("claude-opus-5")))}</b>Opus 5 · ${scores("claude-opus-5").length} runs</div>
  <div><b>${fmt(mean(scores("gpt-5.6-sol")))}</b>sol · ${scores("gpt-5.6-sol").length} runs</div>
  <div><b>${fmt(mean(tasks.map((t) => t.baseline_luna ?? 0)))}</b>luna baseline</div>
  <div><b>${both.filter((t) => t.runs["claude-opus-5"].truncated).length}</b>of ${both.length} truncated at the cap</div>`;

const cats = [...new Set(tasks.map((t) => t.category).filter(Boolean))].sort();
document.getElementById("cat").insertAdjacentHTML("beforeend",
  cats.map((c) => `<option>${c}</option>`).join(""));

let sort = { k: "title", dir: 1 };
const val = (t, k) => k === "opus" ? (t.runs["claude-opus-5"]?.score ?? -1)
  : k === "sol" ? (t.runs["gpt-5.6-sol"]?.score ?? -1)
  : k === "baseline_luna" ? (t.baseline_luna ?? -1) : (t.title || "").toLowerCase();

function cell(t, m) {
  const r = t.runs[m];
  if (!r) return `<td class="n mut">—</td>`;
  // The cap is why a low score may not be a low capability, so it is shown
  // beside the number rather than buried in the run page.
  // The badge sits in a fixed slot so the numbers stay in one column whether
  // or not a run was truncated.
  const cap = r.truncated ? `<span class="cap" title="stopped at the step cap">cap</span>` : "";
  return `<td class="n"><a href="/run?id=${r.run}">${r.score.toFixed(3)}</a><i class="capslot">${cap}</i></td>`;
}

function render() {
  const q = document.getElementById("q").value.toLowerCase();
  const c = document.getElementById("cat").value;
  const f = document.getElementById("filt").value;
  const rows = tasks.filter((t) =>
    (!q || (t.title + t.task_id).toLowerCase().includes(q)) &&
    (!c || t.category === c) &&
    (!f || (f === "cap" ? t.runs["claude-opus-5"]?.truncated : t.runs["claude-opus-5"] && !t.runs["claude-opus-5"].truncated))
  ).sort((a, b) => {
    const x = val(a, sort.k), y = val(b, sort.k);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  document.getElementById("rows").innerHTML = rows.map((t) => `
    <tr>
      <td><a href="/task?id=${encodeURIComponent(t.task_id)}">${t.title || t.task_id}</a>
        <div class="mut" style="font-size:12px">${t.category || ""}</div></td>
      <td class="n mut">${fmt(t.baseline_luna)}</td>
      ${cell(t, "claude-opus-5")}${cell(t, "gpt-5.6-sol")}
    </tr>`).join("") || `<tr><td colspan="4" class="mut">No tasks match.</td></tr>`;
}
document.querySelectorAll("th[data-k]").forEach((th) => th.onclick = () => {
  const k = th.dataset.k;
  sort = { k, dir: sort.k === k ? -sort.dir : (k === "title" ? 1 : -1) };
  render();
});
["q", "cat", "filt"].forEach((id) => document.getElementById(id).oninput = render);
render();
