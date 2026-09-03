import argparse
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.trajectory_review import canonical_judge, run


class RunnerTests(unittest.TestCase):
    def test_judge_command_contains_no_credentials(self):
        args = argparse.Namespace(
            runs_dir=Path("/runs"), task_source_json=Path("/tasks.json"),
            provider="openai", model="test-model", num_workers=3,
            max_images=0, max_steps=0, max_history_chars=1000,
            env_file=None, include_incomplete=False, plan=True,
        )
        command = run.judge_command(args, Path("/out/eval.json"))
        joined = " ".join(command)
        self.assertIn("--plan", command)
        self.assertNotIn("API_KEY", joined)
        self.assertNotIn("secret", joined.lower())

    def test_aws_environment_uses_profile_and_region_without_keys(self):
        args = argparse.Namespace(aws_profile="trajectory-prod", aws_region="us-east-1")
        with patch.dict(run.os.environ, {"PATH": "/bin"}, clear=True):
            environment = run.aws_environment(args)
        self.assertEqual(environment["AWS_PROFILE"], "trajectory-prod")
        self.assertEqual(environment["AWS_REGION"], "us-east-1")
        self.assertNotIn("AWS_ACCESS_KEY_ID", environment)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)

    def test_prepare_command_routes_pc_runs_to_pc_queue(self):
        args = argparse.Namespace(
            runs_dir=Path("/runs"), output_dir=Path("/out"),
            aws_cli="aws", queue="pc", agent="OSWorld", model="gemini-test",
            run_model="Llama-test", run_label="pilot", task_id=["pc_task-1"],
            limit=1, creator_map=Path("/creator-map.json"),
        )
        command = run.prepare_command(args, Path("/out/eval.json"), "bucket")
        self.assertIn("--queue", command)
        self.assertEqual(command[command.index("--queue") + 1], "pc")
        self.assertEqual(command[command.index("--creator-map") + 1], "/creator-map.json")
        self.assertEqual(command[command.index("--agent") + 1], "OSWorld")
        self.assertEqual(command[command.index("--model") + 1], "Llama-test")
        self.assertEqual(command[command.index("--run-label") + 1], "pilot")
        self.assertEqual(command[command.index("--task-id") + 1], "pc_task-1")
        self.assertEqual(command[command.index("--limit") + 1], "1")

    def test_judge_plan_queue_validation_rejects_cross_app_tasks(self):
        run.validate_judge_plan_queue({"task_ids": ["pc_task-1"]}, "pc")
        run.validate_judge_plan_queue({"task_ids": ["v2/alice/internal/task-1"]}, "v2")
        with self.assertRaises(run.RunnerError):
            run.validate_judge_plan_queue({"task_ids": ["pc_task-1"]}, "v2")
        with self.assertRaises(run.RunnerError):
            run.validate_judge_plan_queue({"task_ids": ["v2/alice/internal/task-1"]}, "pc")

    def test_judge_plan_requires_task_ids(self):
        with self.assertRaises(run.RunnerError):
            run.validate_judge_plan_queue({}, "v2")



class CanonicalJudgeTests(unittest.TestCase):
    def test_selects_the_canonical_odysseys_judge(self):
        args = argparse.Namespace(
            runs_dir=Path("/runs"), task_source_json=Path("/tasks.json"),
            provider="openai", model="gpt-5.6-luna", num_workers=4,
            max_images=0, max_steps=0, max_history_chars=1000,
            env_file=None, include_incomplete=False, plan=False,
            judge_impl="canonical",
        )
        command = run.judge_command(args, Path("/out/eval.json"))
        self.assertIn("canonical_judge.py", " ".join(command))
        # The canonical file has no provider/history flags of its own.
        self.assertNotIn("--provider", command)
        self.assertNotIn("--max-history-chars", command)
        self.assertEqual(command[command.index("--max-images") + 1], "0")

    def test_repo_judge_remains_the_explicit_alternative(self):
        args = argparse.Namespace(
            runs_dir=Path("/runs"), task_source_json=Path("/tasks.json"),
            provider="meta", model="super_nova_ext", num_workers=1,
            max_images=12, max_steps=0, max_history_chars=1000,
            env_file=None, include_incomplete=False, plan=False,
            judge_impl="repo",
        )
        command = run.judge_command(args, Path("/out/eval.json"))
        self.assertIn("judge.py", " ".join(command))
        self.assertIn("--provider", command)

    def test_judge_errors_stay_separate_from_agent_failures(self):
        # The canonical judge records a provider failure as success=False;
        # Apollo must not read that as the agent failing the rubric.
        payload = {"tasks": [{"task_id": "t", "run_dir": "/x", "rubric_results": [
            {"rubric_id": "R1", "score": 1, "success": True, "final_reasoning": "Step 3 proves it."},
            {"rubric_id": "R2", "score": 0, "success": False,
             "final_reasoning": "Error judging rubric R2: 429 rate limit"},
            {"rubric_id": "R3", "score": 0, "success": False, "final_reasoning": "Never saved the file."},
        ]}]}
        task = canonical_judge.restore_judge_status(payload, "gpt-5.6-luna")["tasks"][0]
        statuses = {r["rubric_id"]: r["judge_status"] for r in task["rubric_results"]}
        self.assertEqual(statuses, {"R1": "SUCCESS", "R2": "ERROR", "R3": "FAILURE"})
        errored = next(r for r in task["rubric_results"] if r["rubric_id"] == "R2")
        self.assertIsNone(errored["score"])
        # 1 pass / 1 fail; the unjudged rubric is excluded from the denominator.
        self.assertEqual(task["average_rubric_score"], 0.5)
        self.assertEqual(task["judge_errors"], 1)
        self.assertFalse(task["perfect"])

    def test_perfect_requires_every_rubric_to_be_judged(self):
        payload = {"tasks": [{"task_id": "t", "run_dir": "/x", "rubric_results": [
            {"rubric_id": "R1", "score": 1, "success": True, "final_reasoning": "ok"},
            {"rubric_id": "R2", "score": 0, "success": False,
             "final_reasoning": "Error judging rubric R2: timeout"},
        ]}]}
        task = canonical_judge.restore_judge_status(payload, "m")["tasks"][0]
        self.assertEqual(task["average_rubric_score"], 1.0)
        self.assertFalse(task["perfect"])  # a 1.0 that rests on one of two rubrics

if __name__ == "__main__":
    unittest.main()
