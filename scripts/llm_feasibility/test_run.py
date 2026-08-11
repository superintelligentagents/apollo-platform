from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.llm_feasibility import run as pipeline


def possible_review(task_id: str, rubric_id: str) -> dict:
    return {
        "schema_version": pipeline.RUBRIC_SCHEMA_VERSION,
        "task_id": task_id,
        "rubric_id": rubric_id,
        "verdict": "POSSIBLE",
        "confidence": 0.9,
        "tested_at_utc": "2026-08-09T00:00:00Z",
        "summary": "The required public evidence path was inspected.",
        "evidence": [
            {
                "url": "https://example.com/public-record",
                "title": "Public record",
                "observed_at_utc": "2026-08-09T00:00:00Z",
                "access_status": "OK",
                "authority_role": "VERIFICATION",
                "supports": "The requested field is publicly visible.",
                "fact_or_inference": "FACT",
                "limitations": "The value can change and must be observed at task time.",
            }
        ],
        "access_constraints": [],
        "blockers": [],
        "safety_notes": "Read-only public access.",
        "rubric_feedback": None,
        "browser_verification": {
            "needed": False,
            "limitation_only": False,
            "reason": None,
            "target_urls": [],
            "safe_actions": [],
        },
    }


def feasibility_manager_review(task: pipeline.Task, disposition: str = "FEASIBLE") -> dict:
    return {
        "schema_version": pipeline.FEASIBILITY_MANAGER_SCHEMA_VERSION,
        "task_id": task.task_id,
        "disposition": disposition,
        "confidence": 0.9,
        "reviewed_at_utc": "2026-08-09T00:01:00Z",
        "summary": "The complete task has a workable public-web path.",
        "rubric_assessments": [
            {
                "rubric_id": rubric.rubric_id,
                "accepted_worker_verdict": "POSSIBLE",
                "manager_note": "The checked public page supports this step.",
            }
            for rubric in task.rubrics
        ],
        "cross_rubric_conflicts": [],
        "task_level_risks": [],
        "task_feedback": None,
    }


def evergreen_review(task: pipeline.Task) -> dict:
    return {
        "schema_version": pipeline.EVERGREEN_SCHEMA_VERSION,
        "task_id": task.task_id,
        "verdict": "EVERGREEN",
        "confidence": 0.9,
        "reviewed_at_utc": "2026-08-09T00:01:00Z",
        "summary": "The task remains runnable and judgeable later.",
        "concerns": [],
    }


def quality_review(task: pipeline.Task, overall: str = "PASS") -> dict:
    axis_verdict = "PASS" if overall == "PASS" else overall
    return {
        "schema_version": pipeline.QUALITY_SCHEMA_VERSION,
        "task_id": task.task_id,
        "overall_verdict": overall,
        "confidence": 0.9,
        "reviewed_at_utc": "2026-08-09T00:01:00Z",
        "summary": "The task is coherent and high quality, and every step fits the request.",
        "task_coherence": {
            "verdict": axis_verdict,
            "summary": "The request has a consistent goal and flow.",
            "concerns": [] if overall == "PASS" else ["Needs human inspection."],
        },
        "rubric_assessments": [
            {
                "rubric_id": rubric.rubric_id,
                "verdict": "PASS",
                "summary": "This step is in scope and fair to evaluate.",
                "issues": [],
            }
            for rubric in task.rubrics
        ],
    }


def manager_review(task: pipeline.Task, disposition: str = "FEASIBLE") -> dict:
    core = feasibility_manager_review(task, disposition)
    temporal = evergreen_review(task)
    return {
        **core,
        "schema_version": pipeline.MANAGER_SCHEMA_VERSION,
        "evergreen_review": {
            "verdict": temporal["verdict"],
            "summary": temporal["summary"],
            "concerns": temporal["concerns"],
        },
        "quality_review": quality_review(task),
    }


def browser_review(task_id: str, rubric_id: str) -> dict:
    return {
        "schema_version": pipeline.BROWSER_SCHEMA_VERSION,
        "task_id": task_id,
        "rubric_id": rubric_id,
        "verdict": "POSSIBLE",
        "confidence": 0.9,
        "tested_at_utc": "2026-08-09T00:00:30Z",
        "summary": "The rendered controls and result were safely verified.",
        "evidence": [{
            "url": "https://example.com/dynamic",
            "title": "Dynamic lookup",
            "observed_at_utc": "2026-08-09T00:00:30Z",
            "actions": ["Opened the lookup", "Selected the public filter"],
            "observations": "The expected public result rendered without authentication.",
            "side_effects": "NONE",
        }],
        "access_constraints": [],
        "blockers": [],
        "safety_notes": "No persistent action was performed.",
        "rubric_feedback": None,
        "limitation_kind": "NONE",
        "task_blocker": False,
    }


def repair_verification(task_id: str, rubric_id: str, verdict: str = "POSSIBLE") -> dict:
    return {
        "schema_version": pipeline.RUBRIC_REPAIR_VERIFICATION_SCHEMA_VERSION,
        "task_id": task_id,
        "rubric_id": rubric_id,
        "verdict": verdict,
        "quality_verdict": "PASS",
        "quality_summary": "The proposed step remains aligned and fair to evaluate.",
        "confidence": 0.9,
        "tested_at_utc": "2026-08-09T00:03:00Z",
        "summary": "The exact proposed step has a workable public-web path.",
        "evidence": [{
            "url": "https://new.example.test",
            "title": "Independent live source",
            "observed_at_utc": "2026-08-09T00:03:00Z",
            "supports": "The proposed source provides the required public lookup.",
        }] if verdict == "POSSIBLE" else [],
        "blockers": [] if verdict == "POSSIBLE" else ["The complete proposed path was not established."],
    }


def outcome(review: dict) -> dict:
    return {
        "rubric_id": review["rubric_id"],
        "status": "COMPLETED",
        "review": review,
        "browser_review": {"status": "NOT_RUN", "review": None, "error": None},
        "effective_verdict": review["verdict"],
        "error": None,
    }


class FakeRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.config = mock.Mock(browser_escalation=True)

    def run_json(self, prompt: str, schema_path: Path, output_path: Path, web_search: bool, browser: bool = False):
        self.calls.append(schema_path.name)
        payload = json.loads(prompt[prompt.index("{") :])
        if schema_path.name == "rubric_review.schema.json":
            self.assert_web(web_search)
            return possible_review(payload["task_id"], payload["rubric"]["rubric_id"])
        if schema_path.name == "feasibility_manager.schema.json":
            if web_search:
                raise AssertionError("manager must not browse or redo worker research")
            task = pipeline.Task(
                payload["task_id"],
                payload["full_task_prompt"],
                tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
            )
            return feasibility_manager_review(task)
        if schema_path.name == "evergreen_review.schema.json":
            if web_search:
                raise AssertionError("evergreen manager must not browse")
            task = pipeline.Task(
                payload["task_id"],
                payload["full_task_prompt"],
                tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
            )
            return evergreen_review(task)
        if schema_path.name == "quality_review.schema.json":
            if web_search:
                raise AssertionError("quality manager must not browse")
            task = pipeline.Task(
                payload["task_id"],
                payload["full_task_prompt"],
                tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
            )
            return quality_review(task)
        if schema_path.name == "browser_review.schema.json":
            if not browser:
                raise AssertionError("browser escalation must enable the browser MCP")
            return browser_review(payload["task_id"], payload["rubric"]["rubric_id"])
        raise AssertionError(f"unexpected schema {schema_path}")

    @staticmethod
    def assert_web(web_search: bool) -> None:
        if not web_search:
            raise AssertionError("rubric worker must have live-web search enabled")


class NormalizeTests(unittest.TestCase):
    def test_prior_artifact_is_a_read_only_rerun_source(self) -> None:
        row = {
            "schema_version": "apollo-llm-feasibility-artifact-v4",
            "task_id": "task-prior",
            "task_content_hash": "a" * 64,
            "source": {
                "effective_task": {"request": "Inspect the public source."},
                "prompt": "Inspect the public source.",
                "rubrics": [
                    {
                        "rubric_id": "R1",
                        "criterion": "Confirm the source is reachable.",
                        "critical": True,
                    }
                ],
            },
            "feedback": {"task": "This must not become authored task content."},
        }

        task = pipeline.normalize_task(row)

        self.assertEqual(task.task_id, "task-prior")
        self.assertEqual(task.task_content_hash, "a" * 64)
        self.assertEqual(task.prompt, "Inspect the public source.")
        self.assertEqual(task.rubrics[0].criterion, "Confirm the source is reachable.")
        self.assertNotIn("feedback", task.effective_task)

    def test_normalizes_expanded_reporting_api_and_copies_hash(self) -> None:
        api_hash = "a" * 64
        row = {
            "task_id": "v2/reviewer/task-1",
            "llm_review_status": "not_reviewed",
            "content": {
                "task_content_hash": api_hash,
                "original": {"request": "Original prompt", "steps": []},
                "final": {"request": "Human-reviewed full prompt", "steps": []},
                "rubrics": [
                    {
                        "rubric_id": "rubric-1",
                        "title": "Find the source",
                        "original": "Old text",
                        "final": "Verify the current public source.",
                    }
                ],
                "human_review": {"evergreen_verified": True},
            },
        }
        task = pipeline.normalize_task(row)
        self.assertEqual(task.prompt, "Human-reviewed full prompt")
        self.assertEqual(task.rubrics[0].criterion, "Verify the current public source.")
        self.assertEqual(task.task_content_hash, api_hash)
        self.assertEqual(task.workflow_status, None)
        self.assertEqual(task.source_dict()["effective_task"]["request"], "Human-reviewed full prompt")

    def test_normalizes_pending_workflow_status_for_pre_qc(self) -> None:
        row = {
            "task_id": "pending-task",
            "status": "pending",
            "content": {
                "task_content_hash": "f" * 64,
                "original": {"request": "Inspect a public record."},
                "rubrics": [{"rubric_id": "R1", "final": "Verify the public record."}],
            },
        }
        task = pipeline.normalize_task(row)
        self.assertEqual(task.workflow_status, "pending")

    def test_normalizes_reviewed_task_steps_as_rubrics(self) -> None:
        row = {
            "task_id": "task/a",
            "task": {
                "agent_request": "Compare two public options.",
                "steps": [
                    {"title": "Find options", "description": "Locate both options on the public web."},
                    {"title": "Compare", "description": "Compare their published specifications."},
                ],
            },
        }
        task = pipeline.normalize_task(row)
        self.assertEqual(task.task_id, "task/a")
        self.assertEqual([rubric.rubric_id for rubric in task.rubrics], ["R1", "R2"])
        self.assertEqual(task.rubrics[0].criterion, "Find options: Locate both options on the public web.")

    def test_explicit_rubrics_take_precedence(self) -> None:
        row = {
            "content": {
                "task_id": "task-b",
                "task": {"agent_request": "Research a public record.", "steps": [{"description": "Ignored step"}]},
                "rubrics": {"check-a": {"requirement": "Verify the official record.", "critical": False}},
            }
        }
        task = pipeline.normalize_task(row)
        self.assertEqual(task.rubrics, (pipeline.Rubric("check-a", "Verify the official record.", False),))

    def test_task_content_hash_is_stable_and_content_sensitive(self) -> None:
        first = pipeline.Task("id", "Prompt", (pipeline.Rubric("R1", "Check one"),))
        same = pipeline.Task("id", "Prompt", (pipeline.Rubric("R1", "Check one"),))
        changed = pipeline.Task("id", "Prompt", (pipeline.Rubric("R1", "Check two"),))
        self.assertEqual(first.task_content_hash, same.task_content_hash)
        self.assertNotEqual(first.task_content_hash, changed.task_content_hash)
        self.assertRegex(first.task_content_hash, r"^[a-f0-9]{64}$")

    def test_reporting_page_next_offset_is_detected(self) -> None:
        items, next_value, next_parameter = pipeline._items_from_payload(
            {"tasks": [{"task_id": "one"}], "page": {"next_offset": 7}}
        )
        self.assertEqual(items, [{"task_id": "one"}])
        self.assertEqual((next_value, next_parameter), ("7", "offset"))

    def test_fetch_api_pages_follows_next_offset_and_preserves_query(self) -> None:
        class Response:
            def __init__(self, payload: dict) -> None:
                self.body = json.dumps(payload).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self) -> bytes:
                return self.body

        responses = [
            Response({"tasks": [{"task_id": "one"}], "page": {"next_offset": 1}}),
            Response({"tasks": [{"task_id": "two"}], "page": {"next_offset": None}}),
        ]
        seen_urls: list[str] = []

        def fake_urlopen(request, timeout):
            seen_urls.append(request.full_url)
            return responses.pop(0)

        url = "https://api.example.test/reporting/tasks?status=approved&include=content&limit=1&offset=0"
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            rows = pipeline.fetch_api_pages(url, "private-token", 30)
        self.assertEqual([row["task_id"] for row in rows], ["one", "two"])
        self.assertIn("status=approved", seen_urls[1])
        self.assertIn("include=content", seen_urls[1])
        self.assertIn("offset=1", seen_urls[1])

    def test_reviewed_rows_are_skipped_by_default(self) -> None:
        row = {
            "task_id": "done",
            "llm_review_status": "passed",
            "content": {
                "task_content_hash": "b" * 64,
                "final": {"request": "Prompt"},
                "rubrics": [{"rubric_id": "R1", "final": "Criterion"}],
            },
        }
        self.assertEqual(pipeline.normalize_tasks([row]), [])
        self.assertEqual(len(pipeline.normalize_tasks([row], include_reviewed=True)), 1)


class ValidationTests(unittest.TestCase):
    def test_coherence_and_rubric_compatibility_gate_the_llm_pass_set(self) -> None:
        task = pipeline.Task("quality-task", "Inspect the public record.", (pipeline.Rubric("R1", "Report its date."),))
        review = quality_review(task, "FAIL")
        pipeline.validate_quality_review(review, task)
        manager = manager_review(task)
        manager["quality_review"] = review
        self.assertEqual(
            pipeline.deterministic_status([outcome(possible_review(task.task_id, "R1"))], manager),
            "LLM_FAIL",
        )

    def test_quality_failure_can_receive_only_an_independently_checked_minimal_revision(self) -> None:
        task = pipeline.Task("quality-repair", "Inspect the public record.", (pipeline.Rubric("R1", "Report the record date."),))
        candidate = pipeline.validate_rubric_repair({
            "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
            "task_id": task.task_id,
            "rubric_id": "R1",
            "effective_verdict": "POSSIBLE",
            "quality_verdict": "FAIL",
            "repair_kind": "CLARIFY_REQUIREMENT",
            "confidence": 0.9,
            "reason": "The verifier does not name the objective field to report.",
            "edit_operations": [{
                "operation": "REPLACE",
                "old_text": "record date",
                "new_text": "publication date",
            }],
            "verified_replacement_urls": [],
            "human_input_needed": None,
            "preserves_intent": True,
        }, task, task.rubrics[0], "POSSIBLE", "FAIL")
        final = pipeline.finalize_verified_rubric_repair(
            task,
            task.rubrics[0],
            candidate,
            {"status": "COMPLETED", "review": repair_verification(task.task_id, "R1"), "error": None},
        )
        self.assertTrue(final["verified_possible"])
        self.assertEqual(final["suggested_rubric_text"], "Report the publication date.")

    def test_worker_routing_ids_are_bound_by_the_orchestrator(self) -> None:
        review = possible_review("wrong-task", "wrong-rubric")
        bound = pipeline.bind_worker_assignment_ids(review, "assigned-task", "assigned-rubric")
        self.assertEqual(bound["task_id"], "assigned-task")
        self.assertEqual(bound["rubric_id"], "assigned-rubric")
        self.assertEqual(bound["summary"], review["summary"])
        self.assertEqual(review["task_id"], "wrong-task", "the raw worker response must remain unchanged")

    def test_inactive_browser_request_fields_are_cleared_without_touching_review_content(self) -> None:
        review = possible_review("task", "rubric")
        review["browser_verification"] = {
            "needed": False,
            "limitation_only": True,
            "reason": "Stale model text",
            "target_urls": ["https://example.com/stale"],
            "safe_actions": ["Stale action"],
        }
        normalized = pipeline.normalize_rubric_worker_output(review, "task", "rubric")
        self.assertEqual(normalized["browser_verification"], {
            "needed": False,
            "limitation_only": False,
            "reason": None,
            "target_urls": [],
            "safe_actions": [],
        })
        self.assertEqual(normalized["evidence"], review["evidence"])
        self.assertEqual(normalized["verdict"], review["verdict"])
        self.assertEqual(review["browser_verification"]["reason"], "Stale model text")

    def test_structured_output_schemas_type_every_const_and_close_objects(self) -> None:
        def walk(node, path: str) -> None:
            if isinstance(node, dict):
                if "const" in node:
                    self.assertIn("type", node, f"{path} has const without type")
                if node.get("type") == "object" and isinstance(node.get("properties"), dict):
                    self.assertIs(node.get("additionalProperties"), False, f"{path} must reject extra properties")
                    self.assertEqual(
                        set(node.get("required", [])),
                        set(node["properties"]),
                        f"{path} must require every structured-output property",
                    )
                for key, value in node.items():
                    walk(value, f"{path}.{key}")
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    walk(value, f"{path}[{index}]")

        for filename in (
            "rubric_review.schema.json",
            "browser_review.schema.json",
            "feasibility_manager.schema.json",
            "evergreen_review.schema.json",
            "quality_review.schema.json",
            "manager_review.schema.json",
            "rubric_repair.schema.json",
            "rubric_repair_verification.schema.json",
            "task_repair_manager.schema.json",
            "final_artifact.schema.json",
        ):
            walk(json.loads((pipeline.SCHEMA_DIR / filename).read_text(encoding="utf-8")), filename)

    def test_possible_requires_direct_evidence(self) -> None:
        value = possible_review("task", "R1")
        value["evidence"] = []
        with self.assertRaisesRegex(pipeline.PipelineError, "must include direct evidence"):
            pipeline.validate_rubric_review(value, "task", "R1")

    def test_manager_must_cover_each_rubric_exactly_once(self) -> None:
        task = pipeline.Task(
            "task",
            "Prompt",
            (pipeline.Rubric("R1", "One"), pipeline.Rubric("R2", "Two")),
        )
        value = manager_review(task)
        value["rubric_assessments"] = value["rubric_assessments"][:1]
        with self.assertRaisesRegex(pipeline.PipelineError, "every rubric exactly once"):
            pipeline.validate_manager_review(value, task)

    def test_deterministic_gate_never_passes_shortfall_or_error(self) -> None:
        review = possible_review("task", "R1")
        pass_manager = {"disposition": "FEASIBLE", "evergreen_review": {"verdict": "EVERGREEN"}}
        review["verdict"] = "SHORTFALL"
        shortfall = [outcome(review)]
        self.assertEqual(pipeline.deterministic_status(shortfall, pass_manager), "NEEDS_HUMAN_REVIEW")
        error = [{
            "rubric_id": "R1",
            "status": "ERROR",
            "review": None,
            "browser_review": {"status": "NOT_RUN", "review": None, "error": None},
            "effective_verdict": "WORKER_ERROR",
            "error": "failed",
        }]
        self.assertEqual(pipeline.deterministic_status(error, pass_manager), "PIPELINE_ERROR")

    def test_impossible_step_needs_manager_confirmation_before_task_failure(self) -> None:
        task = pipeline.Task(
            "alternate-source-check",
            "Find average wait information for a future park visit.",
            (pipeline.Rubric("R1", "Find average wait information for the rides."),),
        )
        review = possible_review(task.task_id, "R1")
        review["verdict"] = "IMPOSSIBLE"
        review["evidence"] = []
        impossible_outcome = outcome(review)

        uncertain = manager_review(task, "NEEDS_HUMAN_REVIEW")
        uncertain["rubric_assessments"][0]["accepted_worker_verdict"] = "IMPOSSIBLE"
        self.assertEqual(
            pipeline.deterministic_status([impossible_outcome], uncertain),
            "NEEDS_HUMAN_REVIEW",
        )

        confirmed = manager_review(task, "NOT_FEASIBLE")
        confirmed["rubric_assessments"][0]["accepted_worker_verdict"] = "IMPOSSIBLE"
        self.assertEqual(
            pipeline.deterministic_status([impossible_outcome], confirmed),
            "LLM_FAIL",
        )

    def test_legacy_evergreen_review_is_retained_but_does_not_block_pass(self) -> None:
        task = pipeline.Task("task", "Prompt", (pipeline.Rubric("R1", "One"),))
        review = manager_review(task)
        review["evergreen_review"]["verdict"] = "NOT_EVERGREEN"
        review["evergreen_review"]["summary"] = "The task depends on today's mutable result."
        review["evergreen_review"]["concerns"] = ["Uses an unspecified current value."]
        pipeline.validate_manager_review(review, task)
        outcomes = [outcome(possible_review("task", "R1"))]
        self.assertEqual(pipeline.deterministic_status(outcomes, review), "LLM_PASS")

        review["evergreen_review"]["verdict"] = "NEEDS_HUMAN_REVIEW"
        self.assertEqual(pipeline.deterministic_status(outcomes, review), "LLM_PASS")

        invalid = manager_review(task)
        del invalid["evergreen_review"]
        with self.assertRaisesRegex(pipeline.PipelineError, "missing.*evergreen_review"):
            pipeline.validate_manager_review(invalid, task)

    def test_manager_prompt_defines_evergreen_as_runnable_at_any_time(self) -> None:
        prompt = (pipeline.PROMPT_DIR / "evergreen_manager.md").read_text(encoding="utf-8")
        self.assertIn("whenever the task is attempted", prompt)
        self.assertIn("The answer does not need to stay the same over time", prompt)
        self.assertIn("do not by themselves make a task non-evergreen", prompt)
        self.assertIn("Do not require identical outputs across runs", prompt)

    def test_feasibility_prompts_allow_reasonable_agent_choices(self) -> None:
        worker = (pipeline.PROMPT_DIR / "rubric_worker.md").read_text(encoding="utf-8")
        manager = (pipeline.PROMPT_DIR / "manager.md").read_text(encoding="utf-8")
        self.assertIn("find, compare, recommend, choose, or plan", worker)
        self.assertIn("does not require the activity to occur on an exact date", worker)
        self.assertIn("A later rubric may consume", worker)
        self.assertIn("Do not add an unstated requirement", manager)
        self.assertIn("upcoming viable value", manager)

    def test_v19_uses_source_flexibility_and_thorpe_park_regression_rule(self) -> None:
        self.assertEqual(pipeline.PIPELINE_VERSION, "apollo-llm-feasibility-v19")
        worker = (pipeline.PROMPT_DIR / "rubric_worker.md").read_text(encoding="utf-8")
        manager = (pipeline.PROMPT_DIR / "manager.md").read_text(encoding="utf-8")
        verifier = (pipeline.PROMPT_DIR / "rubric_repair_verifier.md").read_text(encoding="utf-8")
        self.assertIn("Google or another compatible public source", worker)
        self.assertIn("Thorpe Park", worker)
        self.assertIn("Queue Times lacks future-day per-ride averages", worker)
        self.assertIn("average wait information", worker)
        self.assertIn("one failed website", manager)
        self.assertIn("one optional site lacks the data", verifier)

        task = pipeline.Task(
            "thorpe-park-planning",
            "Plan a future Thorpe Park visit using average wait information.",
            (pipeline.Rubric("R1", "Find average wait times for the rides and use them in the plan."),),
        )
        review = possible_review(task.task_id, "R1")
        review["evidence"][0].update({
            "url": "https://queue-times.com/parks/2/stats",
            "title": "Thorpe Park queue statistics",
            "supports": "The page publishes average queue time by ride for planning.",
        })
        pipeline.validate_rubric_review(review, task.task_id, "R1")
        self.assertEqual(
            pipeline.deterministic_status([outcome(review)], manager_review(task)),
            "LLM_PASS",
        )

    def test_google_maps_render_failure_does_not_block_supported_public_flow(self) -> None:
        task = pipeline.Task(
            "thorpe-maps-flow",
            "Plan a Thorpe Park visit using public travel, park, and dining information.",
            (pipeline.Rubric("R1", "Find a practical public travel route to Thorpe Park."),),
        )
        base = possible_review(task.task_id, "R1")
        base["verdict"] = "SHORTFALL"
        base["summary"] = "Official travel and park pages establish a public route; the isolated map did not render."
        base["evidence"] = [
            {
                **base["evidence"][0],
                "url": "https://www.thorpepark.com/plan-your-visit/before-you-visit/directions/",
                "title": "Thorpe Park directions",
                "supports": "The official park page publishes public travel directions.",
            },
            {
                **base["evidence"][0],
                "url": "https://www.thetrainline.com/",
                "title": "Trainline journey planner",
                "authority_role": "CORROBORATION",
                "supports": "The public planner provides rail journey information.",
            },
        ]
        base["browser_verification"] = {
            "needed": True,
            "limitation_only": True,
            "reason": "Confirm the ordinary map rendering path if the isolated browser can load it.",
            "target_urls": ["https://maps.google.com/"],
            "safe_actions": ["Open the public directions view"],
        }
        pipeline.validate_rubric_review(base, task.task_id, "R1")

        browser_error = {
            "rubric_id": "R1",
            "status": "COMPLETED",
            "review": base,
            "browser_review": {
                "status": "ERROR",
                "review": None,
                "error": "The isolated browser could not render Google Maps.",
            },
            "effective_verdict": "",
            "error": None,
        }
        browser_error["effective_verdict"] = pipeline.effective_rubric_verdict(browser_error)
        self.assertEqual(browser_error["effective_verdict"], "POSSIBLE")
        self.assertIn("could not render", browser_error["browser_review"]["error"])
        self.assertEqual(
            pipeline.deterministic_status([browser_error], manager_review(task)),
            "LLM_PASS",
        )

        tool_only = browser_review(task.task_id, "R1")
        tool_only.update({
            "verdict": "SHORTFALL",
            "summary": "The isolated map did not render, but the public route is documented.",
            "limitation_kind": "CHECKER_TOOL",
            "task_blocker": False,
        })
        pipeline.validate_browser_review(tool_only, task.task_id, "R1")
        completed = {
            **browser_error,
            "browser_review": {"status": "COMPLETED", "review": tool_only, "error": None},
        }
        self.assertEqual(pipeline.effective_rubric_verdict(completed), "POSSIBLE")

        access_gap = dict(tool_only)
        access_gap["limitation_kind"] = "ACCESS"
        completed["browser_review"] = {"status": "COMPLETED", "review": access_gap, "error": None}
        self.assertEqual(pipeline.effective_rubric_verdict(completed), "SHORTFALL")

    def test_quality_prompt_checks_only_task_quality_and_step_alignment(self) -> None:
        prompt = (pipeline.PROMPT_DIR / "quality_manager.md").read_text(encoding="utf-8")
        self.assertIn("coherent and high quality", prompt)
        self.assertIn("aligned with the original request", prompt)
        self.assertIn("asked for or is reasonably in scope", prompt)
        self.assertIn("fair to evaluate", prompt)
        self.assertNotIn("difficulty rating", prompt)

    def test_every_model_prompt_requires_plain_reviewer_language(self) -> None:
        prompt = pipeline.render_prompt("rubric_worker.md", {"task_id": "task", "rubric": {}})
        self.assertIn("busy human reviewer", prompt)
        self.assertIn("An agent can complete this step", prompt)
        self.assertIn("do not say rubric, live-web, worker, manager, shortfall", prompt)
        self.assertIn("no more than 360 characters", prompt)
        self.assertIn("Never say critical", prompt)
        self.assertIn("Do not write a dependency essay", prompt)
        self.assertIn('"task_id": "task"', prompt)

    def test_browser_request_is_allowed_only_for_shortfall(self) -> None:
        review = possible_review("task", "R1")
        review["browser_verification"] = {
            "needed": True,
            "limitation_only": False,
            "reason": "The public controls require rendered interaction.",
            "target_urls": ["https://example.com/dynamic"],
            "safe_actions": ["Open the public filter"],
        }
        with self.assertRaisesRegex(pipeline.PipelineError, "only for a SHORTFALL"):
            pipeline.validate_rubric_review(review, "task", "R1")
        review["verdict"] = "SHORTFALL"
        pipeline.validate_rubric_review(review, "task", "R1")

    def test_rubric_repair_changes_only_the_exact_wrong_source_fragment(self) -> None:
        original = "Find the filing on https://old.example.test and record its published date."
        task = pipeline.Task("repair-task", "Inspect the filing.", (pipeline.Rubric("R1", original),))
        repair = {
            "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
            "task_id": task.task_id,
            "rubric_id": "R1",
            "effective_verdict": "IMPOSSIBLE",
            "quality_verdict": "PASS",
            "repair_kind": "REPLACE_SOURCE",
            "confidence": 0.95,
            "reason": "The named source is dead and the official replacement is live.",
            "edit_operations": [{
                "operation": "REPLACE",
                "old_text": "https://old.example.test",
                "new_text": "https://new.example.test",
            }],
            "verified_replacement_urls": [{
                "url": "https://new.example.test",
                "title": "Official filing search",
                "supports": "The replacement exposes the same filing and publication date.",
            }],
            "human_input_needed": None,
            "preserves_intent": True,
        }
        validated = pipeline.validate_rubric_repair(repair, task, task.rubrics[0], "IMPOSSIBLE")
        self.assertEqual(
            validated["suggested_rubric_text"],
            "Find the filing on https://new.example.test and record its published date.",
        )
        self.assertEqual(task.rubrics[0].criterion, original)

    def test_repair_does_not_edit_for_tool_outage_or_invent_missing_input(self) -> None:
        task = pipeline.Task("repair-task", "Prompt", (pipeline.Rubric("R1", "Check the live source."),))
        retry = {
            "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
            "task_id": task.task_id,
            "rubric_id": "R1",
            "effective_verdict": "SHORTFALL",
            "quality_verdict": "PASS",
            "repair_kind": "RETRY_VERIFICATION",
            "confidence": 0.8,
            "reason": "The verifier browser timed out.",
            "edit_operations": [],
            "verified_replacement_urls": [],
            "human_input_needed": None,
            "preserves_intent": True,
        }
        self.assertIsNone(
            pipeline.validate_rubric_repair(retry, task, task.rubrics[0], "SHORTFALL")["suggested_rubric_text"]
        )
        invented = {**retry, "repair_kind": "HUMAN_INPUT_REQUIRED", "human_input_needed": None}
        with self.assertRaisesRegex(pipeline.PipelineError, "must state the missing input"):
            pipeline.validate_rubric_repair(invented, task, task.rubrics[0], "SHORTFALL")

        conflicted = {
            **retry,
            "repair_kind": "CLARIFY_REQUIREMENT",
            "human_input_needed": "Provide the delivery postcode.",
            "edit_operations": [{"operation": "APPEND", "old_text": None, "new_text": " Use SW1A 1AA."}],
        }
        normalized = pipeline.normalize_rubric_repair_output(conflicted, task.task_id, "R1")
        self.assertEqual(normalized["repair_kind"], "HUMAN_INPUT_REQUIRED")
        self.assertEqual(normalized["edit_operations"], [])
        self.assertEqual(normalized["verified_replacement_urls"], [])
        self.assertEqual(normalized["human_input_needed"], "Provide the delivery postcode.")


class PipelineTests(unittest.TestCase):
    def test_cli_cannot_target_source_task_prefixes(self) -> None:
        args = pipeline.make_parser().parse_args([
            "--input", "fixture.json",
            "--no-upload",
            "--s3-pass-prefix", "prolific/journeys/finished",
        ])
        with self.assertRaisesRegex(pipeline.PipelineError, "source-task prefixes are never writable"):
            pipeline.validate_args(args)

    def test_worker_environment_removes_api_and_aws_secrets(self) -> None:
        scrubbed = pipeline.scrub_worker_environment(
            {
                "PATH": "/bin",
                "OPENAI_API_KEY": "codex-auth",
                "AWS_ACCESS_KEY_ID": "aws-secret",
                "AWS_SESSION_TOKEN": "aws-session",
                "APOLLO_REPORTING_TOKEN": "reporting-secret",
                "CUSTOM_REPORTING_KEY": "other-secret",
            }
        )
        self.assertEqual(scrubbed, {"PATH": "/bin", "OPENAI_API_KEY": "codex-auth"})

    def test_codex_worker_command_is_isolated_and_search_enabled(self) -> None:
        config = pipeline.Config(
            workdir=Path("unused"), workers=1, timeout_seconds=60, retries=0, model=None,
            codex_bin="codex", upload=False, s3_bucket=None,
            s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
            s3_claim_prefix="v2-review/llm_claims",
            aws_profile=None, aws_region=None, lock_stale_seconds=120, browser_escalation=True,
        )
        command = pipeline.CodexRunner(config)._command(
            Path("/schema.json"), Path("/output.json"), Path("/isolated-job"), web_search=True
        )
        self.assertEqual(command[:6], ["codex", "--ask-for-approval", "never", "--strict-config", "--search", "exec"])
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ignore-rules", command)
        self.assertIn("read-only", command)
        self.assertNotIn("web_search", command)

        browser_command = pipeline.CodexRunner(config)._command(
            Path("/schema.json"), Path("/output.json"), Path("/isolated-job"),
            web_search=False, browser=True,
        )
        self.assertIn('mcp_servers.playwright.command="npx"', browser_command)
        self.assertTrue(any(f"@playwright/mcp@{pipeline.PLAYWRIGHT_MCP_VERSION}" in arg for arg in browser_command))
        self.assertIn("--ignore-user-config", browser_command)

    def test_process_is_resumable_and_writes_pass_key(self) -> None:
        task = pipeline.Task(
            "task/with spaces",
            "Find and compare two public records.",
            (pipeline.Rubric("R1", "Verify the first public record."), pipeline.Rubric("R2", "Verify the second public record.")),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            config = pipeline.Config(
                workdir=Path(temp_dir),
                workers=2,
                timeout_seconds=60,
                retries=0,
                model=None,
                codex_bin="codex",
                upload=False,
                s3_bucket=None,
                s3_pass_prefix="v2-review/llm_pass",
                s3_fail_prefix="v2-review/llm_fail",
                s3_claim_prefix="v2-review/llm_claims",
                aws_profile=None,
                aws_region=None,
                lock_stale_seconds=120,
                browser_escalation=True,
            )
            runner = FakeRunner()
            first = pipeline.process_task(task, config, runner)
            self.assertEqual(first["status"], "LLM_PASS")
            self.assertTrue(first["passed"])
            self.assertEqual(first["task_content_hash"], task.task_content_hash)
            self.assertEqual(first["feedback"], {
                "task": None,
                "rubrics": [
                    {"rubric_id": "R1", "feedback": None},
                    {"rubric_id": "R2", "feedback": None},
                ],
            })
            self.assertEqual(sorted(runner.calls), [
                "feasibility_manager.schema.json",
                "quality_review.schema.json",
                "rubric_review.schema.json",
                "rubric_review.schema.json",
            ])

            second = pipeline.process_task(task, config, runner)
            self.assertEqual(second, first)
            self.assertEqual(len(runner.calls), 4, "validated cached outputs must be reused")

            key = pipeline.artifact_key(config, task, first["status"])
            self.assertEqual(
                key,
                f"v2-review/llm_pass/{pipeline.base64url(task.task_id)}.{task.task_content_hash}.{pipeline.PIPELINE_VERSION}.json",
            )

    def test_browser_escalation_can_resolve_interaction_only_shortfall(self) -> None:
        class BrowserRunner(FakeRunner):
            def run_json(self, prompt, schema_path, output_path, web_search, browser=False):
                if schema_path.name == "rubric_review.schema.json":
                    payload = json.loads(prompt[prompt.index("{") :])
                    review = possible_review(payload["task_id"], payload["rubric"]["rubric_id"])
                    review["verdict"] = "SHORTFALL"
                    review["browser_verification"] = {
                        "needed": True,
                        "limitation_only": False,
                        "reason": "The lookup controls require a rendered browser.",
                        "target_urls": ["https://example.com/dynamic"],
                        "safe_actions": ["Open and use the public lookup"],
                    }
                    self.calls.append(schema_path.name)
                    return review
                return super().run_json(prompt, schema_path, output_path, web_search, browser=browser)

        task = pipeline.Task("browser-task", "Use the public lookup.", (pipeline.Rubric("R1", "Verify the result."),))
        with tempfile.TemporaryDirectory() as temp_dir:
            config = pipeline.Config(
                workdir=Path(temp_dir), workers=1, timeout_seconds=60, retries=0, model=None,
                codex_bin="codex", upload=False, s3_bucket=None,
                s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
                s3_claim_prefix="v2-review/llm_claims", aws_profile=None, aws_region=None,
                lock_stale_seconds=120, browser_escalation=True,
            )
            runner = BrowserRunner()
            artifact = pipeline.process_task(task, config, runner)
        self.assertEqual(artifact["status"], "LLM_PASS")
        self.assertEqual(artifact["rubric_reviews"][0]["review"]["verdict"], "SHORTFALL")
        self.assertEqual(artifact["rubric_reviews"][0]["browser_review"]["status"], "COMPLETED")
        self.assertEqual(artifact["rubric_reviews"][0]["effective_verdict"], "POSSIBLE")
        self.assertIn("browser_review.schema.json", runner.calls)

    def test_process_passes_supported_flow_when_optional_browser_render_fails(self) -> None:
        class RenderFailureRunner(FakeRunner):
            def run_json(self, prompt, schema_path, output_path, web_search, browser=False):
                payload = json.loads(prompt[prompt.index("{") :])
                if schema_path.name == "rubric_review.schema.json":
                    review = possible_review(payload["task_id"], payload["rubric"]["rubric_id"])
                    review["verdict"] = "SHORTFALL"
                    review["summary"] = "Official pages establish the public route; the isolated map still needs rendering."
                    review["browser_verification"] = {
                        "needed": True,
                        "limitation_only": True,
                        "reason": "Try the ordinary public map view in the isolated browser.",
                        "target_urls": ["https://maps.google.com/"],
                        "safe_actions": ["Open the public directions view"],
                    }
                    return review
                if schema_path.name == "browser_review.schema.json":
                    raise pipeline.PipelineError("The isolated browser could not render Google Maps")
                if schema_path.name == "feasibility_manager.schema.json":
                    if payload["independent_reviews"][0]["effective_verdict"] != "POSSIBLE":
                        raise AssertionError("tool-only browser failure must preserve POSSIBLE")
                    if payload["independent_reviews"][0]["browser_review"]["status"] != "ERROR":
                        raise AssertionError("browser failure must remain logged")
                return super().run_json(prompt, schema_path, output_path, web_search, browser=browser)

        task = pipeline.Task(
            "browser-limit-pass",
            "Plan a public route to Thorpe Park.",
            (pipeline.Rubric("R1", "Find a practical public travel route."),),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            config = pipeline.Config(
                workdir=Path(temp_dir), workers=1, timeout_seconds=60, retries=0, model=None,
                codex_bin="codex", upload=False, s3_bucket=None,
                s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
                s3_claim_prefix="v2-review/llm_claims", aws_profile=None, aws_region=None,
                lock_stale_seconds=120, browser_escalation=True,
            )
            artifact = pipeline.process_task(task, config, RenderFailureRunner())
        self.assertEqual(artifact["status"], "LLM_PASS")
        self.assertEqual(artifact["rubric_reviews"][0]["browser_review"]["status"], "ERROR")
        self.assertEqual(artifact["rubric_reviews"][0]["effective_verdict"], "POSSIBLE")

    def test_review_is_feedback_only_and_never_mutates_source_task(self) -> None:
        effective_task = {
            "title": "Original title",
            "request": "Original prompt",
            "steps": [{"order": 1, "title": "Original step", "description": "Original rubric text"}],
        }
        task = pipeline.Task(
            "immutable-task",
            "Original prompt",
            (pipeline.Rubric("R1", "Original rubric text"),),
            effective_task=effective_task,
        )
        source_before = json.loads(json.dumps(task.source_dict()))
        with tempfile.TemporaryDirectory() as temp_dir:
            config = pipeline.Config(
                workdir=Path(temp_dir), workers=1, timeout_seconds=60, retries=0, model=None,
                codex_bin="codex", upload=False, s3_bucket=None,
                s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
                s3_claim_prefix="v2-review/llm_claims",
                aws_profile=None, aws_region=None, lock_stale_seconds=120, browser_escalation=True,
            )
            artifact = pipeline.process_task(task, config, FakeRunner())
        self.assertEqual(task.source_dict(), source_before)
        self.assertEqual(artifact["source"], source_before)
        self.assertNotIn("rewritten_task", artifact)
        self.assertNotIn("recommended_rubric_edit", json.dumps(artifact))

    def test_shortfall_gets_advisory_minimal_repair_without_mutating_source(self) -> None:
        class RepairRunner(FakeRunner):
            def run_json(self, prompt, schema_path, output_path, web_search, browser=False):
                payload = json.loads(prompt[prompt.index("{") :])
                self.calls.append(schema_path.name)
                if schema_path.name == "rubric_review.schema.json":
                    review = possible_review(payload["task_id"], payload["rubric"]["rubric_id"])
                    review["verdict"] = "SHORTFALL"
                    review["summary"] = "The named source is obsolete."
                    review["evidence"] = []
                    return review
                if schema_path.name == "feasibility_manager.schema.json":
                    task = pipeline.Task(
                        payload["task_id"],
                        payload["full_task_prompt"],
                        tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
                    )
                    projected = all(
                        item["effective_verdict"] == "POSSIBLE"
                        for item in payload["independent_reviews"]
                    )
                    review = feasibility_manager_review(
                        task, "FEASIBLE" if projected else "NEEDS_HUMAN_REVIEW"
                    )
                    if not projected:
                        review["rubric_assessments"][0]["accepted_worker_verdict"] = "SHORTFALL"
                        review["rubric_assessments"][0]["manager_note"] = "The obsolete source needs correction."
                    return review
                if schema_path.name == "evergreen_review.schema.json":
                    task = pipeline.Task(
                        payload["task_id"],
                        payload["full_task_prompt"],
                        tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
                    )
                    return evergreen_review(task)
                if schema_path.name == "quality_review.schema.json":
                    task = pipeline.Task(
                        payload["task_id"],
                        payload["full_task_prompt"],
                        tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
                    )
                    return quality_review(task)
                if schema_path.name == "rubric_repair.schema.json":
                    return {
                        "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
                        "task_id": payload["task_id"],
                        "rubric_id": payload["rubric"]["rubric_id"],
                        "effective_verdict": payload["validated_effective_verdict"],
                        "repair_kind": "REPLACE_SOURCE",
                        "confidence": 0.95,
                        "reason": "The official replacement provides the same lookup.",
                        "edit_operations": [{
                            "operation": "REPLACE",
                            "old_text": "https://old.example.test",
                            "new_text": "https://new.example.test",
                        }],
                        "verified_replacement_urls": [{
                            "url": "https://new.example.test",
                            "title": "Official replacement",
                            "supports": "Provides the same public lookup.",
                        }],
                        "human_input_needed": None,
                        "preserves_intent": True,
                    }
                if schema_path.name == "task_repair_manager.schema.json":
                    return {
                        "schema_version": pipeline.TASK_REPAIR_MANAGER_SCHEMA_VERSION,
                        "task_id": payload["task_id"],
                        "summary": "Only the obsolete rubric source should be replaced.",
                        "task_prompt_edit_operations": [],
                        "unresolved_rubric_ids": [],
                        "cross_rubric_notes": [],
                        "preserves_task_flow": True,
                    }
                if schema_path.name == "rubric_repair_verification.schema.json":
                    return repair_verification(payload["task_id"], payload["rubric_id"])
                raise AssertionError(f"unexpected schema {schema_path}")

        criterion = "Use https://old.example.test to inspect the public record."
        task = pipeline.Task("repair-e2e", "Inspect the public record.", (pipeline.Rubric("R1", criterion),))
        source_before = task.source_dict()
        with tempfile.TemporaryDirectory() as temp_dir:
            config = pipeline.Config(
                workdir=Path(temp_dir), workers=1, timeout_seconds=60, retries=0, model=None,
                codex_bin="codex", upload=False, s3_bucket=None,
                s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
                s3_claim_prefix="v2-review/llm_claims", aws_profile=None, aws_region=None,
                lock_stale_seconds=120, browser_escalation=False,
            )
            artifact = pipeline.process_task(task, config, RepairRunner())
        self.assertEqual(artifact["status"], "NEEDS_HUMAN_REVIEW")
        self.assertEqual(artifact["source"], source_before)
        self.assertFalse(artifact["repair_plan"]["applied_automatically"])
        self.assertFalse(artifact["repair_plan"]["source_changed"])
        self.assertEqual(
            artifact["repair_plan"]["rubric_repairs"][0]["suggested_rubric_text"],
            "Use https://new.example.test to inspect the public record.",
        )
        self.assertTrue(artifact["repair_plan"]["rubric_repairs"][0]["verified_possible"])
        self.assertEqual(
            artifact["repair_plan"]["rubric_repairs"][0]["verification"]["review"]["verdict"],
            "POSSIBLE",
        )
        self.assertEqual(artifact["repair_plan"]["projected_task_status"], "POSSIBLE")
        self.assertEqual(
            artifact["repair_plan"]["projected_feasibility_review"]["disposition"],
            "FEASIBLE",
        )

    def test_unverified_candidate_repair_is_suppressed(self) -> None:
        task = pipeline.Task(
            "suppressed-repair",
            "Inspect the record.",
            (pipeline.Rubric("R1", "Use https://old.example.test."),),
        )
        candidate = pipeline.validate_rubric_repair({
            "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
            "task_id": task.task_id,
            "rubric_id": "R1",
            "effective_verdict": "SHORTFALL",
            "quality_verdict": "PASS",
            "repair_kind": "REPLACE_SOURCE",
            "confidence": 0.8,
            "reason": "Candidate replacement.",
            "edit_operations": [{
                "operation": "REPLACE",
                "old_text": "https://old.example.test",
                "new_text": "https://new.example.test",
            }],
            "verified_replacement_urls": [{
                "url": "https://new.example.test",
                "title": "Candidate",
                "supports": "Claimed equivalent source.",
            }],
            "human_input_needed": None,
            "preserves_intent": True,
        }, task, task.rubrics[0], "SHORTFALL")
        verification = {
            "status": "COMPLETED",
            "review": repair_verification(task.task_id, "R1", "SHORTFALL"),
            "error": None,
        }
        final = pipeline.finalize_verified_rubric_repair(
            task, task.rubrics[0], candidate, verification
        )
        self.assertIsNone(final["suggested_rubric_text"])
        self.assertEqual(final["edit_operations"], [])
        self.assertFalse(final["verified_possible"])
        self.assertEqual(final["repair_kind"], "HUMAN_REVIEW_REQUIRED")

    def test_task_prompt_candidate_rechecks_every_rubric_and_falls_back_on_one_failure(self) -> None:
        class PromptRepairRunner(FakeRunner):
            def __init__(self) -> None:
                super().__init__()
                self.verified_assignments = []

            def run_json(self, prompt, schema_path, output_path, web_search, browser=False):
                payload = json.loads(prompt[prompt.index("{") :])
                if schema_path.name == "rubric_repair.schema.json":
                    return {
                        "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
                        "task_id": payload["task_id"],
                        "rubric_id": payload["rubric"]["rubric_id"],
                        "effective_verdict": "SHORTFALL",
                        "repair_kind": "CLARIFY_REQUIREMENT",
                        "confidence": 0.9,
                        "reason": "Clarify the result field.",
                        "edit_operations": [{
                            "operation": "APPEND", "old_text": None, "new_text": " Report the result."
                        }],
                        "verified_replacement_urls": [],
                        "human_input_needed": None,
                        "preserves_intent": True,
                    }
                if schema_path.name == "task_repair_manager.schema.json":
                    return {
                        "schema_version": pipeline.TASK_REPAIR_MANAGER_SCHEMA_VERSION,
                        "task_id": payload["task_id"],
                        "summary": "Add shared context.",
                        "task_prompt_edit_operations": [{
                            "operation": "APPEND", "old_text": None, "new_text": " Extra context."
                        }],
                        "unresolved_rubric_ids": [],
                        "cross_rubric_notes": [],
                        "preserves_task_flow": True,
                    }
                if schema_path.name == "rubric_repair_verification.schema.json":
                    self.verified_assignments.append((
                        payload["rubric_id"], payload["proposed_full_task_prompt"]
                    ))
                    verdict = (
                        "SHORTFALL"
                        if payload["rubric_id"] == "R2"
                        and payload["proposed_full_task_prompt"].endswith("Extra context.")
                        else "POSSIBLE"
                    )
                    return repair_verification(payload["task_id"], payload["rubric_id"], verdict)
                if schema_path.name == "evergreen_review.schema.json":
                    proposed = pipeline.Task(
                        payload["task_id"], payload["full_task_prompt"],
                        tuple(pipeline.Rubric(**rubric) for rubric in payload["rubrics"]),
                    )
                    return evergreen_review(proposed)
                raise AssertionError(f"unexpected schema {schema_path}")

        task = pipeline.Task(
            "prompt-context-gate",
            "Inspect the public records and report the requested results with direct source links.",
            (pipeline.Rubric("R1", "Check the record."), pipeline.Rubric("R2", "Confirm the total.")),
        )
        shortfall = possible_review(task.task_id, "R1")
        shortfall["verdict"] = "SHORTFALL"
        shortfall["evidence"] = []
        outcomes = [outcome(shortfall), outcome(possible_review(task.task_id, "R2"))]
        manager = manager_review(task, "NEEDS_HUMAN_REVIEW")
        manager["rubric_assessments"][0]["accepted_worker_verdict"] = "SHORTFALL"
        runner = PromptRepairRunner()
        with tempfile.TemporaryDirectory() as temp_dir:
            plan = pipeline.run_repair_plan(task, outcomes, manager, Path(temp_dir), runner, 2)
        self.assertIsNone(plan["suggested_task_prompt"])
        self.assertEqual(plan["task_prompt_edit_operations"], [])
        self.assertEqual(
            plan["rubric_repairs"][0]["suggested_rubric_text"],
            "Check the record. Report the result.",
        )
        self.assertTrue(plan["rubric_repairs"][1]["verified_possible"])
        self.assertNotIn("Add shared context", plan["summary"])
        self.assertIn("submitted task is unchanged", plan["summary"])
        self.assertTrue(all(
            "Extra context" not in note for note in plan["cross_rubric_notes"]
        ))
        self.assertIn((
            "R2",
            "Inspect the public records and report the requested results with direct source links. Extra context.",
        ), runner.verified_assignments)

    def test_orchestrator_preserves_mandatory_unresolved_ids_omitted_by_manager(self) -> None:
        class OmissionRunner(FakeRunner):
            def run_json(self, prompt, schema_path, output_path, web_search, browser=False):
                payload = json.loads(prompt[prompt.index("{") :])
                if schema_path.name == "rubric_repair.schema.json":
                    return {
                        "schema_version": pipeline.RUBRIC_REPAIR_SCHEMA_VERSION,
                        "task_id": payload["task_id"],
                        "rubric_id": payload["rubric"]["rubric_id"],
                        "effective_verdict": "SHORTFALL",
                        "repair_kind": "RETRY_VERIFICATION",
                        "confidence": 0.9,
                        "reason": "The verifier timed out; the rubric itself is unchanged.",
                        "edit_operations": [],
                        "verified_replacement_urls": [],
                        "human_input_needed": None,
                        "preserves_intent": True,
                    }
                if schema_path.name == "task_repair_manager.schema.json":
                    return {
                        "schema_version": pipeline.TASK_REPAIR_MANAGER_SCHEMA_VERSION,
                        "task_id": payload["task_id"],
                        "summary": "Retry the verifier without editing the task.",
                        "task_prompt_edit_operations": [],
                        "unresolved_rubric_ids": [],
                        "cross_rubric_notes": [],
                        "preserves_task_flow": True,
                    }
                raise AssertionError(f"unexpected schema {schema_path}")

        task = pipeline.Task("omission-task", "Prompt", (pipeline.Rubric("R1", "Check the public page."),))
        review = possible_review(task.task_id, "R1")
        review["verdict"] = "SHORTFALL"
        review["evidence"] = []
        rubric_outcome = outcome(review)
        manager = manager_review(task, "NEEDS_HUMAN_REVIEW")
        manager["rubric_assessments"][0]["accepted_worker_verdict"] = "SHORTFALL"
        with tempfile.TemporaryDirectory() as temp_dir:
            plan = pipeline.run_repair_plan(
                task, [rubric_outcome], manager, Path(temp_dir), OmissionRunner(), 1
            )
        self.assertEqual(plan["unresolved_rubric_ids"], ["R1"])

    def test_non_pass_uses_fail_prefix(self) -> None:
        task = pipeline.Task("failed-task", "Prompt", (pipeline.Rubric("R1", "Criterion"),))
        config = pipeline.Config(
            workdir=Path("unused"), workers=1, timeout_seconds=60, retries=0, model=None,
            codex_bin="codex", upload=False, s3_bucket=None,
            s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
            s3_claim_prefix="v2-review/llm_claims",
            aws_profile=None, aws_region=None, lock_stale_seconds=120, browser_escalation=True,
        )
        self.assertEqual(
            pipeline.artifact_key(config, task, "NEEDS_HUMAN_REVIEW"),
            f"v2-review/llm_fail/{pipeline.base64url(task.task_id)}.{task.task_content_hash}.{pipeline.PIPELINE_VERSION}.json",
        )

    def test_pre_qc_uses_isolated_cache_and_storage_prefixes(self) -> None:
        task = pipeline.Task(
            "pending-task",
            "Inspect a public record.",
            (pipeline.Rubric("R1", "Verify the public record."),),
            workflow_status="pending",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            config = pipeline.Config(
                workdir=Path(temp_dir), workers=1, timeout_seconds=60, retries=0, model=None,
                codex_bin="codex", upload=False, s3_bucket=None,
                s3_pass_prefix="v2-review/llm_pass", s3_fail_prefix="v2-review/llm_fail",
                s3_claim_prefix="v2-review/llm_claims",
                aws_profile=None, aws_region=None, lock_stale_seconds=120,
                browser_escalation=True, pre_qc=True,
            )
            artifact = pipeline.process_task(task, config, FakeRunner())
            artifact_path = (
                Path(temp_dir) / "tasks" / pipeline.safe_id(task.task_id) /
                pipeline.safe_id(pipeline.PIPELINE_VERSION) / "pre_qc" /
                task.task_content_hash / "artifact.json"
            )
            self.assertTrue(artifact_path.exists())
            self.assertEqual(
                pipeline.artifact_key(config, task, artifact["status"]),
                (
                    f"v2-review/llm_pre_qc_pass/{pipeline.base64url(task.task_id)}."
                    f"{task.task_content_hash}.{pipeline.PIPELINE_VERSION}.json"
                ),
            )

            attention_key = pipeline.artifact_key(config, task, "NEEDS_HUMAN_REVIEW")
            self.assertTrue(attention_key.startswith("v2-review/llm_pre_qc_attention/"))

    def test_pre_qc_rejects_approved_tasks_and_excess_concurrency(self) -> None:
        approved = {
            "task_id": "approved-task",
            "status": "approved",
            "content": {
                "task_content_hash": "e" * 64,
                "original": {"request": "Prompt"},
                "rubrics": [{"rubric_id": "R1", "final": "Criterion"}],
            },
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "approved.json"
            input_path.write_text(json.dumps(approved), encoding="utf-8")
            args = pipeline.make_parser().parse_args([
                "--input", str(input_path), "--pre-qc", "--plan", "--no-upload",
            ])
            with self.assertRaisesRegex(pipeline.PipelineError, "only pending or in_review"):
                pipeline.run(args)

        args = pipeline.make_parser().parse_args([
            "--input", "fixture.json", "--plan", "--no-upload",
            "--workers", "8", "--task-workers", "5",
        ])
        with self.assertRaisesRegex(pipeline.PipelineError, "must not exceed 32"):
            pipeline.validate_args(args)


if __name__ == "__main__":
    unittest.main()
