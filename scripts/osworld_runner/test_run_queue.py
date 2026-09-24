import sys
import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import patch

from scripts.osworld_runner import run_queue


def _batch(temp):
    b = Path(temp) / "batch-000001"
    (b / "results").mkdir(parents=True); (b / "results" / "step_1.png").write_bytes(b"png")
    (b / "logs").mkdir(); (b / "command.log").write_text("log")
    (b / "trajectory_review" / "x" / "y" / "screens").mkdir(parents=True)
    (b / "job.json").write_text("{}")
    return b


class CompactBatchTest(unittest.TestCase):
    def test_default_deletes_the_bulk_artifacts_but_keeps_the_record(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"OSWORLD_KEEP_RESULTS": ""}):
            b = _batch(temp); run_queue.compact_batch(b)
            self.assertFalse((b / "results").exists()); self.assertFalse((b / "command.log").exists())
            self.assertTrue((b / "job.json").exists())

    def test_keep_results_leaves_the_full_resolution_trajectory_on_disk(self):
        """The S3 package carries JPEGs; with this set the PNGs survive on /data."""
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"OSWORLD_KEEP_RESULTS": "1"}):
            b = _batch(temp); run_queue.compact_batch(b)
            self.assertTrue((b / "results" / "step_1.png").exists())
            self.assertTrue((b / "command.log").exists())
            self.assertTrue((b / "trajectory_review" / "x" / "y" / "screens").exists())

    def test_explicit_off_values_still_compact(self):
        for value in ("0", "false", "no"):
            with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"OSWORLD_KEEP_RESULTS": value}):
                b = _batch(temp); run_queue.compact_batch(b)
                self.assertFalse((b / "results").exists(), value)


class RunCommandTests(unittest.TestCase):
    def test_the_child_runs_in_its_own_session_so_its_group_signals_stay_there(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / "command.log"
            run_queue.run_command([sys.executable, "-c", "import os; print(os.getsid(0))"], log)
            child_sid = int(log.read_text().splitlines()[-1])
        self.assertNotEqual(child_sid, os.getsid(0))

    def test_a_failing_child_still_raises_with_the_log_path(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / "command.log"
            with self.assertRaises(run_queue.QueueRunError):
                run_queue.run_command([sys.executable, "-c", "raise SystemExit(3)"], log)


if __name__ == "__main__":
    unittest.main()


class RecoverRepublishTests(unittest.TestCase):
    """A batch whose runs were judged but whose uploads failed is published
    again on restart instead of being written off (which re-runs its tasks)."""

    def make_batch(self, root, prepared):
        batch = root / "batch-000001"
        (batch / "trajectory_review").mkdir(parents=True)
        (batch / "job.json").write_text(json.dumps({"task_ids": ["v2/x/internal/task-1"], "task_count": 1}))
        (batch / "trajectory_review/eval_results_full_traj_per_rubric.json").write_text("{}")
        (batch / "trajectory_review/prepare-summary.json").write_text(json.dumps({"prepared": prepared, "skipped": []}))
        return batch

    def test_a_judged_batch_with_failed_uploads_is_published_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); batch = self.make_batch(root, prepared=[])
            calls = []
            def republish(batch_dir):
                calls.append(batch_dir)
                (batch_dir / "trajectory_review/prepare-summary.json").write_text(json.dumps({"prepared": [{"task_id": "v2/x/internal/task-1"}], "skipped": []}))
                return None
            state = {"batches_completed": 0, "tasks_published": 0, "runs": []}
            with mock.patch.object(run_queue, "verify_batch", return_value=[{"task_id": "v2/x/internal/task-1"}]), \
                 mock.patch.object(run_queue, "batch_verification_record", return_value={"requested_task_count": 1, "published_task_count": 1, "runs": []}), \
                 mock.patch.object(run_queue, "record_completed_batch"), mock.patch.object(run_queue, "compact_batch"):
                run_queue.recover_published_batches(root, state, bucket="b", queue="v2", token="t", reporting_attempts=1, reporting_delay=0, republish=republish)
            self.assertEqual(calls, [batch])
            self.assertTrue((batch / "verified.json").exists())
            self.assertFalse((batch / "failed.json").exists())

    def test_a_second_failure_still_writes_the_batch_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); batch = self.make_batch(root, prepared=[])
            state = {"batches_completed": 0, "tasks_published": 0, "runs": []}
            with mock.patch.object(run_queue, "compact_batch"):
                run_queue.recover_published_batches(root, state, bucket="b", queue="v2", token="t", reporting_attempts=1, reporting_delay=0,
                                                    republish=lambda d: run_queue.QueueRunError("still failing"))
            self.assertTrue((batch / "failed.json").exists())

    def test_a_batch_that_already_published_is_not_republished(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); batch = self.make_batch(root, prepared=[{"task_id": "v2/x/internal/task-1"}])
            state = {"batches_completed": 0, "tasks_published": 0, "runs": []}
            calls = []
            with mock.patch.object(run_queue, "verify_batch", return_value=[]), \
                 mock.patch.object(run_queue, "batch_verification_record", return_value={"requested_task_count": 1, "published_task_count": 0, "runs": []}), \
                 mock.patch.object(run_queue, "record_completed_batch"), mock.patch.object(run_queue, "compact_batch"):
                run_queue.recover_published_batches(root, state, bucket="b", queue="v2", token="t", reporting_attempts=1, reporting_delay=0,
                                                    republish=lambda d: calls.append(d))
            self.assertEqual(calls, [])
