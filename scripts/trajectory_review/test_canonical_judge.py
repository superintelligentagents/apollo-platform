import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.trajectory_review import canonical_judge, run as review_run


class CanonicalJudgePlanTests(unittest.TestCase):
    """The plan is a contract with run.py, not just an operator's preview."""

    def _plan(self, task_ids):
        source = {"tasks": [
            {
                "task_id": task_id,
                "confirmed_task": "Do the thing and report it.",
                "rubrics": [{"rubric_id": "rubric-1", "requirement": "It was reported."}],
            }
            for task_id in task_ids
        ]}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "tasks.json").write_text(json.dumps(source), encoding="utf-8")
            with patch.object(canonical_judge, "fetch_canonical_judge", return_value=root / "judge.py"), \
                 patch("builtins.print") as printed:
                code = canonical_judge.main([
                    "--runs-dir", str(root), "--task-source-json", str(root / "tasks.json"),
                    "--output", str(root / "eval.json"), "--model", "gpt-5.6-luna", "--plan",
                ])
        self.assertEqual(code, 0)
        return json.loads(printed.call_args[0][0])

    def test_the_plan_names_the_tasks_it_would_judge(self):
        # run.py refuses a plan without task_ids, so omitting them does not
        # merely skip the queue check -- it makes the canonical judge unusable.
        plan = self._plan(["v2/alice/internal/task-1", "v2/bob/internal/task-2"])
        self.assertEqual(
            plan["task_ids"],
            ["v2/alice/internal/task-1", "v2/bob/internal/task-2"],
        )
        self.assertEqual(plan["tasks"], 2)
        review_run.validate_judge_plan_queue(plan, "v2")

    def test_the_plan_still_fails_a_cross_queue_batch(self):
        plan = self._plan(["pc/alice/internal/bundle-1"])
        with self.assertRaises(review_run.RunnerError):
            review_run.validate_judge_plan_queue(plan, "v2")


if __name__ == "__main__":
    unittest.main()


class ImageBudgetTests(unittest.TestCase):
    """A run too big to send must be thinned, never silently zeroed."""

    def _runs(self, root, shots, size):
        run = root / "pyautogui" / "screenshot" / "m" / "d" / "task"
        run.mkdir(parents=True, exist_ok=True)
        (run / "traj.jsonl").write_text("{}\n", encoding="utf-8")
        for index in range(shots):
            (run / f"{index:05d}.png").write_bytes(b"x" * size)
        return root

    def test_a_run_that_fits_keeps_every_screenshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self._runs(Path(temp), shots=20, size=1000)
            self.assertEqual(canonical_judge.image_cap_for(root, 0), 0)
            self.assertEqual(canonical_judge.image_cap_for(root, 12), 12)

    def test_an_oversized_run_is_thinned_to_fit(self):
        with tempfile.TemporaryDirectory() as temp:
            # 100 shots x 1MB -> ~133MB base64, well over a 40MB budget.
            root = self._runs(Path(temp), shots=100, size=1_000_000)
            cap = canonical_judge.image_cap_for(root, 0)
            self.assertGreater(cap, 0)
            self.assertLess(cap, 100)
            # The cap must actually bring the payload under budget.
            self.assertLessEqual(cap * 1_000_000 * 4 // 3, canonical_judge.IMAGE_PAYLOAD_BUDGET_BYTES)

    def test_an_explicit_smaller_cap_still_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self._runs(Path(temp), shots=100, size=1_000_000)
            self.assertEqual(canonical_judge.image_cap_for(root, 5), 5)

    def test_no_screenshots_leaves_the_request_alone(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(canonical_judge.image_cap_for(Path(temp), 0), 0)


class JpegViewTests(unittest.TestCase):
    """The judge reads a re-encoded copy; the published originals stay lossless."""

    def _run(self, root, shots=3):
        from PIL import Image
        run = root / "pyautogui" / "screenshot" / "m" / "d" / "task"
        run.mkdir(parents=True)
        names = []
        for index in range(shots):
            name = f"{index:05d}.png"
            Image.new("RGB", (64, 48), (index * 40 % 255, 10, 200)).save(run / name)
            names.append(name)
        (run / "traj.jsonl").write_text("".join(
            json.dumps({"step_num": i, "screenshot": n, "action": "click"}) + "\n"
            for i, n in enumerate(names)), encoding="utf-8")
        (run / "result.txt").write_text("0.0\n", encoding="utf-8")
        return run

    def test_screenshots_are_reencoded_and_the_trajectory_follows(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "runs"
            run = self._run(root)
            view = canonical_judge.jpeg_view(root, Path(temp) / "view")
            mirrored = view / run.relative_to(root)
            self.assertEqual(sorted(p.name for p in mirrored.glob("*.jpg")),
                             ["00000.jpg", "00001.jpg", "00002.jpg"])
            self.assertEqual(list(mirrored.glob("*.png")), [])
            # The judge resolves the screenshot by the name in the trajectory,
            # so a view whose trajectory still says .png would find nothing.
            rows = [json.loads(line) for line in
                    (mirrored / "traj.jsonl").read_text().splitlines() if line.strip()]
            self.assertEqual([r["screenshot"] for r in rows],
                             ["00000.jpg", "00001.jpg", "00002.jpg"])
            for row in rows:
                self.assertTrue((mirrored / row["screenshot"]).is_file())
            # Non-image files the judge needs are carried over.
            self.assertTrue((mirrored / "result.txt").is_file())

    def test_the_originals_are_left_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "runs"
            run = self._run(root)
            before = {p.name: p.read_bytes() for p in run.glob("*.png")}
            canonical_judge.jpeg_view(root, Path(temp) / "view")
            after = {p.name: p.read_bytes() for p in run.glob("*.png")}
            self.assertEqual(before, after)
            self.assertIn("00000.png", after)

    def test_a_run_with_no_screenshots_still_copies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "runs"
            run = root / "a" / "task"
            run.mkdir(parents=True)
            (run / "traj.jsonl").write_text(json.dumps({"step_num": 0, "action": "click"}) + "\n")
            view = canonical_judge.jpeg_view(root, Path(temp) / "view")
            self.assertTrue((view / run.relative_to(root) / "traj.jsonl").is_file())
