import os
import tempfile
import unittest
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
