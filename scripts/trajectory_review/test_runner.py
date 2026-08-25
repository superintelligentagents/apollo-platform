import argparse
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.trajectory_review import run


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
            aws_cli="aws", queue="pc", agent="", model="gemini-test",
            run_label="", task_id=[], limit=None, creator_map=Path("/creator-map.json"),
        )
        command = run.prepare_command(args, Path("/out/eval.json"), "bucket")
        self.assertIn("--queue", command)
        self.assertEqual(command[command.index("--queue") + 1], "pc")
        self.assertEqual(command[command.index("--creator-map") + 1], "/creator-map.json")

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


if __name__ == "__main__":
    unittest.main()
