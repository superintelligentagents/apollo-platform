import json
import tempfile
import unittest
from pathlib import Path

from scripts.trajectory_review.export_osworld import ExportError, accepted_human_pass, osworld_task, select_latest_passes, write_export


def row(task_id="v2/alice/internal/task-123", run_id="run-1", outcome="YES", verdict="SUCCESS", reviewed_at="2026-08-15T00:00:00Z"):
    return {
        "manifest_key": f"review/trajectory-runs/{task_id}/{run_id}/manifest.json",
        "task_id": task_id,
        "run_id": run_id,
        "status": "reviewed",
        "reviewed_at": reviewed_at,
        "human_final_grade": outcome,
        "manifest": {
            "schema_version": "apollo-trajectory-review-package-v1",
            "task_id": task_id,
            "run_id": run_id,
            "creator_pid": "alice",
            "task_prompt": "Find the requested public evidence and report it.",
            "rubrics": [{
                "rubric_id": "R1",
                "requirement": "The final answer includes the evidence.",
                "verification": "Inspect the final answer.",
                "llm_status": "FAILURE",
                "llm_reasoning": "This must never be exported.",
            }],
        },
        "human_judgment": {
            "rubrics": [{"rubric_id": "R1", "human_verdict": verdict, "llm_judge_correct": False}],
            "trajectory": {"overall_outcome": outcome},
        },
    }


class ExportOsworldTests(unittest.TestCase):
    def test_requires_overall_yes_and_every_rubric_success(self):
        self.assertTrue(accepted_human_pass(row()))
        self.assertFalse(accepted_human_pass(row(outcome="NO")))
        self.assertFalse(accepted_human_pass(row(verdict="FAILURE")))
        incomplete = row()
        incomplete["human_judgment"]["rubrics"] = []
        self.assertFalse(accepted_human_pass(incomplete))

    def test_emits_stock_osworld_shape_without_llm_judgment(self):
        task = osworld_task(row())
        self.assertEqual(task["snapshot"], "chrome")
        self.assertEqual(task["source"], "Apollo")
        self.assertEqual(task["evaluator"]["func"], "is_expected_url_pattern_match")
        self.assertEqual(task["apollo"]["human_final_grade"], "YES")
        encoded = json.dumps(task)
        self.assertNotIn("llm_status", encoded)
        self.assertNotIn("This must never be exported", encoded)

    def test_rejects_non_passed_rows(self):
        with self.assertRaises(ExportError):
            osworld_task(row(outcome="EDIT_NEEDED"))

    def test_deduplicates_tasks_to_the_latest_accepted_run(self):
        older = row(run_id="run-a", reviewed_at="2026-08-14T00:00:00Z")
        newer = row(run_id="run-b", reviewed_at="2026-08-15T00:00:00Z")
        selected = select_latest_passes([newer, older])
        self.assertEqual([item["run_id"] for item in selected], ["run-b"])

    def test_writes_tasks_examples_and_stock_meta(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            summary = write_export([row()], output)
            self.assertEqual(summary["exported"], 1)
            tasks = json.loads((output / "tasks.json").read_text())
            meta = json.loads((output / "test_apollo.json").read_text())
            example = json.loads((output / "examples" / "chrome" / f"{tasks[0]['id']}.json").read_text())
            self.assertEqual(meta, {"chrome": [tasks[0]["id"]]})
            self.assertEqual(example, tasks[0])


if __name__ == "__main__":
    unittest.main()
