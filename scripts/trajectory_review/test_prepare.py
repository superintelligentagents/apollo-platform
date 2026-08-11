import json
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from scripts.trajectory_review.prepare import PackageError, load_steps, prepare_one, put_object_if_absent, select_task_results, validate_manifest


class PrepareTrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _result(self, run_dir: Path):
        return {
            "run_dir": str(run_dir),
            "task_id": "v2/alice/internal/task-12345678",
            "task": "Find the public evidence and produce the requested artifact.",
            "rubric_results": [{
                "rubric_id": "R1",
                "requirement": "The final artifact contains the cited finding.",
                "verification": "Inspect the final artifact and source page.",
                "score": 1,
                "success": True,
                "final_reasoning": "Step 2 shows the source and the finished artifact.",
            }],
        }

    def test_packages_steps_jsonl_actions_and_screenshots(self):
        run_dir = self.root / "run"
        run_dir.mkdir()
        (run_dir / "shot.png").write_bytes(b"png")
        rows = [
            {"step_num": 1, "action": "click", "arguments": {"x": 10}, "screenshot": "shot.png"},
            {"step_num": 1, "response": "Opened the page"},
            {"step_num": 2, "action_line": "type the answer", "final": True},
        ]
        (run_dir / "steps.jsonl").write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        eval_path = self.root / "eval.json"
        eval_path.write_text("{}", encoding="utf-8")

        manifest_path, manifest = prepare_one(self._result(run_dir), eval_path, self.root / "out")

        self.assertEqual(manifest["schema_version"], "apollo-trajectory-review-package-v1")
        self.assertEqual(manifest["metrics"]["num_steps"], 2)
        self.assertEqual(manifest["metrics"]["num_screenshots"], 1)
        self.assertEqual(manifest["metrics"]["judge_errors"], 0)
        self.assertEqual(manifest["rubrics"][0]["llm_status"], "SUCCESS")
        self.assertIn('click {"x": 10}', manifest["steps"][0]["action"])
        self.assertEqual(manifest["steps"][0]["response"], "Opened the page")
        self.assertEqual(manifest["steps"][1]["action"], "type the answer")
        self.assertTrue((manifest_path.parent / manifest["steps"][0]["screenshot_path"]).is_file())

    def test_preserves_judge_errors_without_calling_them_failures(self):
        run_dir = self.root / "run-error"
        run_dir.mkdir()
        (run_dir / "steps.jsonl").write_text(
            json.dumps({"step_num": 1, "action": "open page"}) + "\n",
            encoding="utf-8",
        )
        result = self._result(run_dir)
        result["rubric_results"][0].update({
            "judge_status": "ERROR",
            "score": None,
            "success": None,
            "final_reasoning": "Judge error: provider unavailable",
        })
        eval_path = self.root / "eval-error.json"
        eval_path.write_text("{}", encoding="utf-8")
        _, manifest = prepare_one(result, eval_path, self.root / "out-error")
        self.assertEqual(manifest["rubrics"][0]["llm_status"], "ERROR")
        self.assertIsNone(manifest["rubrics"][0]["llm_score"])
        self.assertIsNone(manifest["rubrics"][0]["llm_success"])
        self.assertEqual(manifest["metrics"]["judge_errors"], 1)
        self.assertFalse(manifest["metrics"]["perfect"])

    def test_supports_traj_jsonl_shape(self):
        run_dir = self.root / "run"
        run_dir.mkdir()
        rows = [
            {"step_num": 1, "action": {"command": "open browser"}},
            {"step_num": 1, "action": {"input": {"action": "screenshot"}, "action": "screenshot"}},
        ]
        (run_dir / "traj.jsonl").write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        steps, source = load_steps(run_dir)
        self.assertEqual(source.name, "traj.jsonl")
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["actions"], ["open browser"])

    def test_run_id_is_stable_across_worker_mount_paths(self):
        run_a = self.root / "worker-a" / "same-run"
        run_b = self.root / "worker-b" / "same-run"
        run_a.mkdir(parents=True)
        run_b.mkdir(parents=True)
        row = json.dumps({"step_num": 1, "action": "open page"}) + "\n"
        (run_a / "steps.jsonl").write_text(row, encoding="utf-8")
        (run_b / "steps.jsonl").write_text(row, encoding="utf-8")
        eval_path = self.root / "eval-stable.json"
        eval_path.write_text("{}", encoding="utf-8")
        _, manifest_a = prepare_one(self._result(run_a), eval_path, self.root / "out-a")
        _, manifest_b = prepare_one(self._result(run_b), eval_path, self.root / "out-b")
        self.assertEqual(manifest_a["run_id"], manifest_b["run_id"])

    def test_run_metadata_is_visible_and_part_of_package_identity(self):
        run_dir = self.root / "named-run"
        run_dir.mkdir()
        (run_dir / "steps.jsonl").write_text(
            json.dumps({"step_num": 1, "action": "open page"}) + "\n",
            encoding="utf-8",
        )
        eval_path = self.root / "eval-metadata.json"
        eval_path.write_text("{}", encoding="utf-8")
        _, named = prepare_one(
            self._result(run_dir), eval_path, self.root / "named-out",
            agent="Skyvern", model="Claude Opus 5", run_label="official judge pilot",
        )
        _, unnamed = prepare_one(self._result(run_dir), eval_path, self.root / "unnamed-out")
        self.assertEqual(named["source"]["agent"], "Skyvern")
        self.assertEqual(named["source"]["model"], "Claude Opus 5")
        self.assertEqual(named["source"]["run_label"], "official judge pilot")
        self.assertNotEqual(named["run_id"], unnamed["run_id"])

    def test_rejects_unsafe_asset_paths_and_missing_rubrics(self):
        with self.assertRaises(PackageError):
            validate_manifest({
                "schema_version": "apollo-trajectory-review-package-v1",
                "run_id": "run",
                "task_id": "task",
                "task_prompt": "prompt",
                "rubrics": [{"rubric_id": "R1"}],
                "steps": [{"index": 0, "screenshot_path": "../secret.png"}],
            })

    def test_selects_repeatable_experiment_batch_without_editing_source(self):
        tasks = [{"task_id": "a"}, {"task_id": "b"}, {"task_id": "c"}]
        self.assertEqual(select_task_results(tasks, ["c", "a"]), [tasks[0], tasks[2]])
        self.assertEqual(select_task_results(tasks, limit=2), tasks[:2])
        with self.assertRaisesRegex(PackageError, "not found"):
            select_task_results(tasks, ["missing"])
        with self.assertRaisesRegex(PackageError, "at least 1"):
            select_task_results(tasks, limit=0)

    def test_manifest_upload_is_create_only_and_idempotent(self):
        source = self.root / "manifest.json"
        source.write_text("{}", encoding="utf-8")
        with patch("scripts.trajectory_review.prepare.subprocess.run") as run:
            run.return_value = CompletedProcess([], 0, "", "")
            self.assertTrue(put_object_if_absent(source, "bucket", "manifest.json", content_type="application/json"))
            self.assertIn("--if-none-match", run.call_args.args[0])
        with patch("scripts.trajectory_review.prepare.subprocess.run") as run:
            run.return_value = CompletedProcess([], 255, "", "PreconditionFailed (412)")
            self.assertFalse(put_object_if_absent(source, "bucket", "manifest.json", content_type="application/json"))


if __name__ == "__main__":
    unittest.main()
