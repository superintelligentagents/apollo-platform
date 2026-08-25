import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from scripts.trajectory_review import judge


class _FakeCompletions:
    def __init__(self, text: str):
        self.text = text

    async def create(self, **_kwargs):
        message = SimpleNamespace(content=self.text)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class _FakeOpenAI:
    def __init__(self, text: str):
        self.chat = SimpleNamespace(completions=_FakeCompletions(text))


class JudgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_normalizes_odysseys_and_apollo_task_shapes(self):
        odysseys = judge.normalize_task({
            "task_id": "abc",
            "confirmed_task": "Inspect the page.",
            "level": "high",
            "rubrics": {"R1": {"requirement": "Report the title.", "verification": "Read it."}},
        })
        self.assertEqual(odysseys.rubrics[0]["id"], "R1")

        apollo = judge.normalize_task({
            "participant_id": "user",
            "task_id": "v2/user/internal/task-1",
            "content": {
                "final": {"request": "Inspect the page.", "difficulty": "high"},
                "rubrics": [{"rubric_id": "rubric-1", "final": "Report the title."}],
            },
        })
        self.assertEqual(apollo.prompt, "Inspect the page.")
        self.assertEqual(apollo.rubrics[0]["requirement"], "Report the title.")
        self.assertEqual(apollo.creator_pid, "user")

    def test_pc_reporting_participant_is_preserved_for_creator_assigned_grade(self):
        task = judge.normalize_task({
            "task_id": "pc_task-123",
            "participant_id": "pc-author",
            "content": {
                "final": {"request": "Use the selected records.", "difficulty": "high"},
                "rubrics": [{"rubric_id": "rubric-1", "final": "Create the requested output."}],
            },
        })
        self.assertEqual(task.creator_pid, "pc-author")

    def test_assignment_hash_includes_referenced_screenshot_bytes(self):
        run_dir = self.root / "abc"
        run_dir.mkdir()
        (run_dir / "shot.png").write_bytes(b"first")
        (run_dir / "steps.jsonl").write_text(json.dumps({
            "step_num": 1, "action": "open", "screenshot": "shot.png",
        }) + "\n", encoding="utf-8")
        task = judge.TaskSpec("abc", "Prompt", ({"id": "R1", "requirement": "Check.", "verification": ""},), "high")
        first = judge.assignment_hash(run_dir, task)
        (run_dir / "shot.png").write_bytes(b"second")
        self.assertNotEqual(first, judge.assignment_hash(run_dir, task))

    def test_evaluates_each_rubric_and_emits_compatible_result(self):
        run_dir = self.root / "abc"
        run_dir.mkdir()
        (run_dir / "steps.jsonl").write_text("\n".join([
            json.dumps({"step_num": 1, "action": "open page"}),
            json.dumps({"step_num": 2, "response": "Title is Example"}),
        ]) + "\n", encoding="utf-8")
        task = judge.TaskSpec("abc", "Inspect the page.", (
            {"id": "R1", "requirement": "Report the title.", "verification": "Read the final answer."},
        ), "high")
        result = asyncio.run(judge.evaluate_run(
            run_dir, task, _FakeOpenAI('Evidence: Step 2 reports the title.\nStatus: "success"'),
            "openai", "test-model", 0, 0, 10_000, "a" * 64,
        ))
        self.assertEqual(result["rubric_results"][0]["judge_status"], "SUCCESS")
        self.assertEqual(result["rubric_scores"], {"R1": 1})
        self.assertTrue(result["perfect"])

    def test_unparseable_model_output_is_an_error_not_a_failure(self):
        run_dir = self.root / "abc"
        run_dir.mkdir()
        (run_dir / "steps.jsonl").write_text(json.dumps({"step_num": 1, "action": "open"}) + "\n", encoding="utf-8")
        task = judge.TaskSpec("abc", "Prompt", (
            {"id": "R1", "requirement": "Check.", "verification": ""},
        ), "high")
        result = asyncio.run(judge.evaluate_run(
            run_dir, task, _FakeOpenAI("ambiguous response"),
            "openai", "test-model", 0, 0, 10_000, "b" * 64,
        ))
        self.assertEqual(result["rubric_results"][0]["judge_status"], "ERROR")
        self.assertEqual(result["rubric_scores"], {})
        self.assertIsNone(result["average_rubric_score"])


if __name__ == "__main__":
    unittest.main()
