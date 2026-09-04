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
