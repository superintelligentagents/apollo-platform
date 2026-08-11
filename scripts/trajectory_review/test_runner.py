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


if __name__ == "__main__":
    unittest.main()
