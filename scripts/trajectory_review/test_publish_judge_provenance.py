import unittest

from scripts.trajectory_review.publish_judge_provenance import registry_document


class JudgeProvenanceTests(unittest.TestCase):
    def test_registry_only_includes_the_selected_run_model(self):
        document = registry_document(
            [
                {"manifest_key": "v2-review/trajectory-runs/a/r1/manifest.json", "model": "gpt-5.6-sol"},
                {"manifest_key": "v2-review/trajectory-runs/b/r2/manifest.json", "model": "claude-opus-5"},
            ],
            run_model="gpt-5.6-sol",
            judge_model="gemini-3.1-flash-lite-preview",
        )
        self.assertEqual(document["schema_version"], "apollo-trajectory-judge-provenance-v1")
        self.assertEqual(len(document["entries"]), 1)
        self.assertEqual(document["entries"][0]["judge"]["model"], "gemini-3.1-flash-lite-preview")
        self.assertIsNone(document["entries"][0]["judge"]["commit"])


if __name__ == "__main__":
    unittest.main()
