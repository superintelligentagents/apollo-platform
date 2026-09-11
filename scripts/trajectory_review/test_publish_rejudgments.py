import unittest

from scripts.trajectory_review.publish_rejudgments import rejudgment_document, sidecar_key


class RejudgmentDocumentTests(unittest.TestCase):
    def _task(self, statuses):
        return {
            "task_id": "v2/alice/internal/task-12345678",
            "created_at_utc": "2026-09-03T22:00:00Z",
            "rubric_results": [
                {
                    "rubric_id": f"R{index}",
                    "requirement": "does the thing",
                    "verification": "look at it",
                    "judge_status": status,
                    "final_reasoning": "because",
                }
                for index, status in enumerate(statuses, start=1)
            ],
        }

    def test_verdicts_and_metrics_come_from_the_judge_status(self):
        document = rejudgment_document(self._task(["SUCCESS", "FAILURE"]), "gpt-5.6-luna")
        self.assertEqual(document["schema_version"], "apollo-trajectory-rejudgment-v1")
        self.assertEqual([r["llm_score"] for r in document["rubrics"]], [1, 0])
        self.assertEqual(document["metrics"]["average_rubric_score"], 0.5)
        self.assertFalse(document["metrics"]["perfect"])
        self.assertEqual(document["metrics"]["rubrics_scored"], 2)

    def test_an_errored_rubric_leaves_the_average_denominator(self):
        # An ERROR is a judge failure, not an agent failure, so it must not be
        # scored as a zero -- and a run carrying one is never 'perfect'.
        document = rejudgment_document(self._task(["SUCCESS", "ERROR"]), "gpt-5.6-luna")
        self.assertIsNone(document["rubrics"][1]["llm_score"])
        self.assertIsNone(document["rubrics"][1]["llm_success"])
        self.assertEqual(document["metrics"]["average_rubric_score"], 1.0)
        self.assertEqual(document["metrics"]["judge_errors"], 1)
        self.assertEqual(document["metrics"]["rubrics_scored"], 1)
        self.assertFalse(document["metrics"]["perfect"])

    def test_provenance_records_the_pinned_canonical_judge(self):
        document = rejudgment_document(self._task(["SUCCESS"]), "gpt-5.6-luna")
        self.assertEqual(document["judge"]["model"], "gpt-5.6-luna")
        self.assertEqual(document["judge"]["screenshots"], "all")
        self.assertEqual(len(document["judge"]["sha256"]), 64)
        self.assertTrue(document["judge"]["commit"])
        self.assertTrue(document["metrics"]["perfect"])

    def test_a_countable_screenshot_budget_is_recorded_verbatim(self):
        document = rejudgment_document(self._task(["SUCCESS"]), "gpt-5.6-luna", screenshots=12)
        self.assertEqual(document["judge"]["screenshots"], 12)

    def test_the_sidecar_sits_beside_its_manifest(self):
        self.assertEqual(
            sidecar_key("v2-review/trajectory-runs/abc/run1/manifest.json"),
            "v2-review/trajectory-runs/abc/run1/rejudgment.json",
        )


if __name__ == "__main__":
    unittest.main()
