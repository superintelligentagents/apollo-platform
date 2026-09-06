import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.osworld_runner import run, run_queue


def task(task_id="v2/alice/internal/task-1", **overrides):
    value = {
        "task_id": task_id,
        "participant_id": "alice",
        "status": "approved",
        "signoff_action": "accepted",
        "signoff_at": "2026-08-28T12:00:00Z",
        "trajectory_count": 0,
        "content": {
            "task_content_hash": "a" * 64,
            "final": {
                "request": "Research the topic and summarize it.",
                "key_urls": ["https://example.com/start"],
                "site_scope": ["example.org"],
            },
            "rubrics": [{"rubric_id": "rubric-1", "final": "The summary cites the source."}],
        },
    }
    value.update(overrides)
    return value


class RubricOverlayTests(unittest.TestCase):
    """Clean rubric proposals replace what the judge scores, and nothing else."""

    def _overlay(self, **overrides):
        entry = {
            "task_id": "v2/alice/internal/task-1",
            "confirmed_task": "Research the topic and summarize it.",
            "rubrics": [{
                "rubric_id": "rubric-1",
                "requirement": "The summary reports the cited source's current figure.",
                "verification": "Open the source and compare.",
            }],
        }
        entry.update(overrides)
        return {"tasks": [entry]}

    def _apply(self, overlay_value, tasks=None):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "overlay.json"
            path.write_text(json.dumps(overlay_value), encoding="utf-8")
            overlay = run.load_rubric_overlay(path)
        return run.apply_rubric_overlay(tasks if tasks is not None else [task()], overlay)

    def test_the_clean_rubric_replaces_the_packaged_one(self):
        updated, rejected = self._apply(self._overlay())
        self.assertEqual(rejected, [])
        rubric = updated[0]["content"]["rubrics"][0]
        # The judge reads `requirement` first and `final` as a fallback, so both
        # must carry the clean text or the two paths would score different text.
        self.assertEqual(rubric["final"], "The summary reports the cited source's current figure.")
        self.assertEqual(rubric["requirement"], rubric["final"])
        self.assertEqual(rubric["verification"], "Open the source and compare.")
        # Approval provenance is untouched: the overlay never grants runnability.
        self.assertEqual(updated[0]["status"], "approved")
        self.assertEqual(updated[0]["content"]["task_content_hash"], "a" * 64)

    def test_the_overlay_restricts_the_run_to_the_tasks_it_names(self):
        other = task("v2/alice/internal/task-2")
        updated, _ = self._apply(self._overlay(), [task(), other])
        self.assertEqual([item["task_id"] for item in updated], ["v2/alice/internal/task-1"])

    def test_a_stale_overlay_is_dropped_rather_than_run(self):
        # Written against a request that has since been amended.
        updated, rejected = self._apply(self._overlay(confirmed_task="A different request."))
        self.assertEqual(updated, [])
        self.assertIn("prompt differs", rejected[0]["reason"])

        # Written against a rubric set the approved task no longer has.
        updated, rejected = self._apply(self._overlay(rubrics=[
            {"rubric_id": "rubric-9", "requirement": "Something nobody approved."},
        ]))
        self.assertEqual(updated, [])
        self.assertIn("rubric IDs differ", rejected[0]["reason"])

    def test_an_overlay_without_rubrics_is_refused_at_load(self):
        with self.assertRaises(run.BridgeError):
            self._apply(self._overlay(rubrics=[]))


class CampaignDedupTests(unittest.TestCase):
    def test_only_this_campaign_s_trajectories_count_as_done(self):
        page = {"trajectories": [
            {"task_id": "v2/alice/internal/task-1", "model": "gpt-5.6-luna",
             "run_label": "Apollo author-approved OpenAI production shard 1/14 batch 000001"},
            {"task_id": "v2/alice/internal/task-2", "model": "gpt-5.6-luna",
             "run_label": "Apollo cleaned-rubric OpenAI production shard 1/5 batch 000001"},
        ], "page": {"next_offset": None}}
        with patch.object(run, "get_json", return_value=page):
            # Without the prefix a re-run campaign would see every task as done.
            self.assertEqual(
                run.fetch_trajectory_task_ids("https://api.test/reporting/tasks", "secret",
                                              model="gpt-5.6-luna"),
                {"v2/alice/internal/task-1", "v2/alice/internal/task-2"},
            )
            self.assertEqual(
                run.fetch_trajectory_task_ids("https://api.test/reporting/tasks", "secret",
                                              model="gpt-5.6-luna",
                                              run_label_prefix="Apollo cleaned-rubric"),
                {"v2/alice/internal/task-2"},
            )


class OSWorldBridgeTests(unittest.TestCase):
    def test_run_id_round_trip_is_path_safe(self):
        task_id = "v2/alice/internal/task-1"
        encoded = run.encode_run_id(task_id)
        self.assertNotIn("/", encoded)
        self.assertEqual(run.decode_run_id(encoded), task_id)
        self.assertIsNone(run.decode_run_id(encoded + "bad"))

    def test_selects_only_author_signed_tasks_without_trajectories(self):
        selected, skipped = run.select_tasks([
            task(),
            task("v2/bob/internal/task-2", signoff_action=""),
            task("v2/cyd/internal/task-3", trajectory_count=1),
        ], queue="v2", limit=10, existing_task_ids={"v2/cyd/internal/task-3"})
        self.assertEqual([item["task_id"] for item in selected], ["v2/alice/internal/task-1"])
        self.assertEqual({item["reason"] for item in skipped}, {
            "awaiting author sign-off", "already has a trajectory",
        })

    def test_authored_journey_count_does_not_block_a_new_model_run(self):
        selected, skipped = run.select_tasks([
            task(trajectory_count=3),
        ], queue="v2", limit=1)
        self.assertEqual([item["task_id"] for item in selected], ["v2/alice/internal/task-1"])
        self.assertEqual(skipped, [])

    def test_shards_are_disjoint_and_cover_all_runnable_tasks(self):
        tasks = [task(f"v2/alice/internal/task-{index}") for index in range(40)]
        shards = []
        for shard_index in range(4):
            selected, _ = run.select_tasks(
                tasks,
                queue="v2",
                limit=len(tasks),
                shard_count=4,
                shard_index=shard_index,
            )
            shards.append({item["task_id"] for item in selected})
        self.assertEqual(set.union(*shards), {item["task_id"] for item in tasks})
        for left in range(4):
            for right in range(left + 1, 4):
                self.assertFalse(shards[left] & shards[right])

    def test_requested_task_outside_shard_fails_closed(self):
        item = task()
        assigned = int.from_bytes(
            run.hashlib.sha256(item["task_id"].encode()).digest()[:8], "big"
        ) % 2
        with self.assertRaisesRegex(run.BridgeError, "assigned to shard"):
            run.select_tasks(
                [item],
                queue="v2",
                wanted_ids=[item["task_id"]],
                shard_count=2,
                shard_index=1 - assigned,
            )

    def test_requested_blocked_task_fails_closed(self):
        with self.assertRaisesRegex(run.BridgeError, "awaiting author sign-off"):
            run.select_tasks(
                [task(signoff_action="")],
                queue="v2",
                wanted_ids=["v2/alice/internal/task-1"],
                limit=1,
            )

    def test_osworld_config_uses_final_request_and_google_start_by_default(self):
        config = run.osworld_config(task(), "apollo_chrome")
        self.assertEqual(config["instruction"], "Research the topic and summarize it.")
        self.assertEqual(config["config"][0]["type"], "command")
        self.assertIn("command -v xclip", config["config"][0]["parameters"]["command"])
        self.assertEqual(config["config"][1]["type"], "execute_with_verification")
        # Default: the agent starts on a blank search page and has to find its
        # own sources, as most Odysseys configs do.
        tabs = config["config"][-1]["parameters"]["urls_to_open"]
        self.assertEqual(tabs, ["https://www.google.com/"])
        self.assertEqual(config["metadata"]["apollo_task_id"], "v2/alice/internal/task-1")

    def test_osworld_config_can_preopen_authored_site_scope(self):
        config = run.osworld_config(task(), "apollo_chrome", "site_scope")
        tabs = config["config"][-1]["parameters"]["urls_to_open"]
        self.assertEqual(tabs, ["https://example.com/start", "https://example.org/"])

    def test_existing_job_gets_muse_spark_vm_prerequisite_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = run.job_paths(Path(temporary))
            run.prepare_job([task()], paths, "apollo_chrome")
            config_path = next((paths.configs / "examples/apollo_chrome").glob("*.json"))
            config = json.loads(config_path.read_text())
            config["config"] = config["config"][2:]
            run.write_private_json(config_path, config)

            run.ensure_muse_spark_vm_prerequisite(paths)
            run.ensure_muse_spark_vm_prerequisite(paths)

            config = json.loads(config_path.read_text())
            matching = [
                item for item in config["config"]
                if run._is_muse_spark_vm_prerequisite(item)
            ]
            self.assertEqual(len(matching), 2)

    def test_prepare_job_keeps_sensitive_task_content_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = run.job_paths(Path(temporary))
            manifest = run.prepare_job([task()], paths, "apollo_chrome")
            self.assertEqual(manifest["task_count"], 1)
            self.assertEqual(paths.tasks.stat().st_mode & 0o777, 0o600)
            self.assertEqual(paths.meta.stat().st_mode & 0o777, 0o600)
            config_path = next((paths.configs / "examples/apollo_chrome").glob("*.json"))
            self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("LLAMA", json.dumps(manifest))

    def test_reporting_paging_follows_next_offset(self):
        pages = [
            {"items": [task()], "page": {"next_offset": 150}},
            {"items": [task("v2/bob/internal/task-2")], "page": {"next_offset": None}},
        ]
        with patch.object(run, "get_json", side_effect=pages) as get_json:
            tasks = run.fetch_reporting_tasks("https://api.test/reporting/tasks", "secret")
        self.assertEqual(len(tasks), 2)
        self.assertIn("offset=150", get_json.call_args_list[1].args[0])

    def test_reporting_fetch_accepts_deployed_tasks_envelope(self):
        with patch.object(
            run,
            "get_json",
            return_value={"tasks": [task()], "page": {}},
        ):
            tasks = run.fetch_reporting_tasks("https://api.test/reporting/tasks", "secret")
        self.assertEqual([item["task_id"] for item in tasks], ["v2/alice/internal/task-1"])

    def test_trajectory_reporting_collects_task_ids_across_pages(self):
        pages = [
            {"trajectories": [{"task_id": "task-a"}], "page": {"next_offset": 1}},
            {"trajectories": [{"task_id": "task-b"}], "page": {}},
        ]
        with patch.object(run, "get_json", side_effect=pages) as get_json:
            task_ids = run.fetch_trajectory_task_ids("https://api.test/reporting/tasks", "secret")
        self.assertEqual(task_ids, {"task-a", "task-b"})
        self.assertIn("/reporting/trajectories?", get_json.call_args_list[0].args[0])
        self.assertIn("offset=1", get_json.call_args_list[1].args[0])

    def test_meta_payload_translates_chat_messages_to_responses_input(self):
        payload = run.meta_payload({
            "model": run.OSWORLD_MODEL_ALIAS,
            "max_tokens": 123,
            "messages": [
                {"role": "system", "content": "Judge the evidence."},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What next?"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc", "detail": "high"}},
                    ],
                },
            ],
        }, "meta-model")
        self.assertEqual(payload["model"], "meta-model")
        self.assertEqual(payload["max_output_tokens"], 16_384)
        self.assertEqual(payload["instructions"], "Judge the evidence.")
        self.assertEqual(payload["reasoning"], {"effort": "low", "summary": "auto"})
        self.assertEqual(payload["input"][0]["content"][1], {
            "type": "input_image",
            "image_url": "data:image/png;base64,abc",
            "detail": "high",
        })

    def test_child_environment_does_not_forward_deployment_or_provider_secrets(self):
        with patch.dict(run.os.environ, {
            "PATH": "/bin",
            "LLAMA_API_KEY": "meta-secret",
            "APOLLO_REPORTING_TOKEN": "reporting-secret",
            "AWS_SESSION_TOKEN": "aws-secret",
        }, clear=True):
            environment = run.child_environment("http://127.0.0.1:123/v1")
        self.assertEqual(environment["OPENAI_API_KEY"], "local-meta-proxy")
        self.assertNotIn("LLAMA_API_KEY", environment)
        self.assertNotIn("APOLLO_REPORTING_TOKEN", environment)
        self.assertNotIn("AWS_SESSION_TOKEN", environment)

    def test_meta_key_prefers_scoped_muse_spark_environment_name(self):
        with patch.dict(run.os.environ, {
            "MUSE_SPARK_API_KEY": "scoped-meta",
            "META_API_KEY": "generic-meta",
            "LLAMA_API_KEY": "legacy-meta",
        }, clear=True):
            self.assertEqual(run.require_meta_key(), "scoped-meta")

    def test_muse_environment_forwards_only_the_scoped_model_key(self):
        args = SimpleNamespace(
            osworld_root=Path("/home/jykoh/OSWorld"),
            meta_session_id="terminal-bench-2.1--test",
        )
        runner = Path("/tmp/job/upstream/commit/scripts/python/run_multienv_muse_spark.py")
        with patch.dict(run.os.environ, {
            "PATH": "/bin",
            "LLAMA_API_KEY": "parent-secret",
            "APOLLO_REPORTING_TOKEN": "reporting-secret",
            "AWS_SESSION_TOKEN": "aws-secret",
        }, clear=True):
            environment = run.muse_child_environment(args, "scoped-secret", runner)
        self.assertEqual(environment["MUSE_SPARK_API_KEY"], "scoped-secret")
        self.assertEqual(environment["MUSE_SPARK_SESSION_ID"], "terminal-bench-2.1--test")
        self.assertNotIn("LLAMA_API_KEY", environment)
        self.assertNotIn("APOLLO_REPORTING_TOKEN", environment)
        self.assertNotIn("AWS_SESSION_TOKEN", environment)

    def test_osworld_command_uses_native_muse_spark_launcher(self):
        args = run.parser().parse_args([
            "--stage", "run",
            "--path-to-vm", "/tmp/Ubuntu.qcow2",
        ])
        paths = run.job_paths(Path("/tmp/job"), model=args.meta_model)
        command = run.osworld_command(args, paths)
        self.assertTrue(command[1].endswith("muse_spark_launcher.py"))
        self.assertIn("super_nova_ext", command)
        self.assertIn("https://api.ai.meta.com/v1", command)
        self.assertIn("MUSE_SPARK_API_KEY", command)
        timeout_index = command.index("--request_timeout")
        self.assertEqual(command[timeout_index + 1], "600.0")
        retries_index = command.index("--max_retries")
        self.assertEqual(command[retries_index + 1], "3")

    def test_trajectory_judge_is_labeled_meta_and_judges_whole_trajectory(self):
        args = run.parser().parse_args(["--stage", "publish"])
        paths = run.job_paths(Path("/tmp/job"), model=args.meta_model)
        command = run.trajectory_command(args, paths, plan=False)
        self.assertIn("meta", command)
        # 0 = every screenshot, matching the canonical Odysseys judge; sampling
        # a subset could hide the frame that proves a rubric.
        index = command.index("--max-images")
        self.assertEqual(command[index + 1], "0")

    def test_trajectory_judge_image_limit_is_overridable(self):
        args = run.parser().parse_args(["--stage", "publish", "--judge-max-images", "12"])
        paths = run.job_paths(Path("/tmp/job"), model=args.meta_model)
        command = run.trajectory_command(args, paths, plan=False)
        index = command.index("--max-images")
        self.assertEqual(command[index + 1], "12")

    def test_queue_verifies_a_successful_subset_of_a_parallel_batch(self):
        with tempfile.TemporaryDirectory() as temporary:
            batch = Path(temporary)
            requested = ["task-a", "task-b", "task-c"]
            run.write_private_json(batch / "job.json", {"task_ids": requested})
            prepared = []
            reporting = []
            for task_id in requested[:2]:
                manifest_path = batch / task_id / "manifest.json"
                run.write_private_json(manifest_path, {
                    "metrics": {
                        "num_steps": 0,
                        "average_rubric_score": 1.0,
                        "judge_errors": 0,
                    },
                })
                prepared.append({
                    "task_id": task_id,
                    "run_id": f"run-{task_id}",
                    "manifest_key": f"prefix/{task_id}/manifest.json",
                    "creator_pid": "alice",
                    "manifest_path": str(manifest_path),
                })
                reporting.append({"task_id": task_id, "run_id": f"run-{task_id}"})
            run.write_private_json(
                batch / "trajectory_review/prepare-summary.json",
                {"prepared": prepared},
            )

            with (
                patch.object(run_queue, "aws_json", return_value={"Contents": [{}]}),
                patch.object(run_queue.subprocess, "run"),
                patch.object(run_queue, "reporting_rows", return_value=reporting),
            ):
                verified = run_queue.verify_batch(
                    batch,
                    bucket="bucket",
                    queue="v2",
                    token="token",
                    reporting_attempts=1,
                    reporting_delay=0,
                )

            self.assertEqual([item["task_id"] for item in verified], requested[:2])
            record = run_queue.batch_verification_record(batch, verified)
            self.assertEqual(record["failed_task_ids"], ["task-c"])


if __name__ == "__main__":
    unittest.main()


class AnthropicBackendTests(unittest.TestCase):
    def _args(self, **overrides):
        value = {
            "agent_backend": "anthropic", "anthropic_model": "claude-opus-5",
            "anthropic_effort": "high", "anthropic_max_tokens": 16_000,
            "openai_model": "gpt-5.6-luna", "meta_model": "super_nova_ext",
            "judge_model": "gpt-5.6-luna", "provider_name": "apptainer",
            "max_steps": 120, "max_trajectory_length": 120, "num_envs": 2,
            "sleep_after_execution": 2.0, "domain": "apollo_chrome",
            "client_password": "password", "aws_region": "us-east-1",
            "osworld_root": Path("/osworld"), "path_to_vm": Path("/vm.qcow2"),
        }
        value.update(overrides)
        return SimpleNamespace(**value)

    def test_the_claude_agent_is_launched_with_its_own_model(self):
        paths = run.job_paths(Path("/work"), model="claude-opus-5")
        command = run.anthropic_osworld_command(self._args(), paths)
        self.assertIn("--model", command)
        self.assertEqual(command[command.index("--model") + 1], "claude-opus-5")
        self.assertEqual(command[command.index("--effort") + 1], "high")
        # Driven through the shim, which is what teaches upstream's pinned
        # runner about the fork's apptainer provider.
        self.assertTrue(command[1].endswith("muse_spark_launcher.py"))
        self.assertEqual(command[command.index("--provider_name") + 1], "apptainer")

    def test_trajectories_are_published_under_the_claude_model(self):
        args = self._args()
        self.assertEqual(run.agent_model(args), "claude-opus-5")
        self.assertEqual(run.agent_label(args), "OSWorld AnthropicAgent")

    def test_only_the_anthropic_key_reaches_the_agent(self):
        environment = run.anthropic_child_environment(
            "sk-ant-test", Path("/osworld/scripts/python/run_multienv_claude.py"), Path("/osworld"),
        )
        self.assertEqual(environment["ANTHROPIC_API_KEY"], "sk-ant-test")
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("APOLLO_REPORTING_TOKEN", environment)
        # The checkout's own agent must win; an overlay ahead of it on the path
        # would silently swap in a different Claude implementation.
        self.assertEqual(environment["PYTHONPATH"].split(":")[0], "/osworld")

    def test_the_claude_runner_comes_from_the_checkout(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(run.BridgeError):
                run.claude_runner(root)   # fail loudly rather than run something else
            target = root / "scripts" / "python"
            target.mkdir(parents=True)
            (target / "run_multienv_claude.py").write_text("")
            self.assertEqual(run.claude_runner(root), target / "run_multienv_claude.py")

    def test_a_claude_run_is_still_judged_by_the_openai_judge(self):
        # Swapping the agent must not silently swap the judge, or the new
        # model's scores stop being comparable with the baseline corpus.
        args = self._args(judge_impl="canonical", judge_workers=1, judge_max_images=0,
                          queue="v2", run_label="x", s3_bucket="b", aws_profile=None)
        paths = run.job_paths(Path("/work"), model="claude-opus-5")
        command = run.trajectory_command(args, paths, plan=False)
        self.assertEqual(command[command.index("--provider") + 1], "openai")
        self.assertEqual(command[command.index("--model") + 1], "gpt-5.6-luna")
        self.assertEqual(command[command.index("--run-model") + 1], "claude-opus-5")

    def test_the_judge_key_and_the_agent_key_are_different_secrets(self):
        args = self._args()
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-ant", "OPENAI_API_KEY": "sk-oai"}):
            self.assertEqual(run.require_agent_key(args), "sk-ant")
            self.assertEqual(run.require_judge_key(args), "sk-oai")


class RequiredKeyTests(unittest.TestCase):
    def test_each_backend_asks_for_the_keys_it_actually_uses(self):
        self.assertEqual(run_queue.required_keys("openai", "gpt-5.6-luna"), ("OPENAI_API_KEY",))
        self.assertEqual(run_queue.required_keys("muse-spark"), ("MUSE_SPARK_API_KEY",))
        # A Claude run needs both: Anthropic drives the agent, the judge its own.
        self.assertEqual(run_queue.required_keys("anthropic", "gpt-5.6-luna"),
                         ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"))

    def test_a_gemini_judge_asks_for_a_gemini_key(self):
        # The judge is chosen independently of the agent, so demanding the
        # agent's provider key would fail a shard that never needed it.
        self.assertEqual(run_queue.required_keys("openai", "gemini-3.1-flash-lite-preview"),
                         ("OPENAI_API_KEY", "GEMINI_API_KEY"))
        self.assertEqual(run_queue.required_keys("anthropic", "gemini-3.1-flash-lite-preview"),
                         ("ANTHROPIC_API_KEY", "GEMINI_API_KEY"))

    def test_a_backend_never_demands_another_backend_s_key(self):
        for backend in ("openai", "anthropic", "muse-spark"):
            keys = run_queue.required_keys(backend, "gpt-5.6-luna")
            if backend != "muse-spark":
                self.assertNotIn("MUSE_SPARK_API_KEY", keys)
            if backend == "openai":
                self.assertNotIn("ANTHROPIC_API_KEY", keys)


def _launcher():
    """Import the launcher without the OSWorld venv's third-party deps.

    It runs inside the OSWorld child, so it imports docker/httpx/openai at
    module level; the orchestration venv has none of them. Stub them rather
    than skip -- the helpers under test are pure, and a skipped test here
    would protect nothing.
    """
    import sys as _sys
    import types as _types
    for name in ("docker", "docker.models", "docker.models.containers", "httpx", "openai"):
        if name not in _sys.modules:
            _sys.modules[name] = _types.ModuleType(name)
    _sys.modules["docker.models.containers"].Container = type("Container", (), {"remove": lambda self: None})
    _sys.modules["openai"].OpenAI = object
    _sys.modules["httpx"].post = lambda *a, **k: None
    from scripts.osworld_runner import muse_spark_launcher as launcher
    return launcher


class UnconditionalAwsImportTests(unittest.TestCase):
    def test_the_stub_stands_in_only_off_aws(self):
        import sys as _sys
        launcher = _launcher()
        name = "desktop_env.providers.aws.manager"
        _sys.modules.pop(name, None)
        try:
            # On AWS the real module must be the one that loads.
            launcher._satisfy_unconditional_aws_import("aws")
            self.assertNotIn(name, _sys.modules)
            # Anywhere else, the import upstream makes before it checks the
            # provider has to succeed or every env process dies at startup.
            launcher._satisfy_unconditional_aws_import("apptainer")
            self.assertIn(name, _sys.modules)
            image_map = _sys.modules[name].IMAGE_ID_MAP
            self.assertEqual(image_map["us-east-1"][(1920, 1080)], "unused-off-aws")
            self.assertEqual(image_map["any-region"].get((1280, 720), "fallback"), "fallback")
        finally:
            _sys.modules.pop(name, None)

    def test_the_provider_is_read_from_the_child_argv(self):
        launcher = _launcher()
        self.assertEqual(launcher._provider_from_argv(["x", "--provider_name", "apptainer"]), "apptainer")
        self.assertEqual(launcher._provider_from_argv(["x"]), "")
        self.assertEqual(launcher._provider_from_argv(["x", "--provider_name"]), "")


class RunnerFlagContractTests(unittest.TestCase):
    """Every flag we send must be one the checkout's runner accepts.

    The Claude runner in this project's checkout differs from upstream's -- it
    takes --effort where upstream takes --thinking -- and argparse rejects an
    unknown flag with exit 2, killing the shard after the VMs have booted. A
    mismatch is cheap to catch here and expensive to catch there.
    """

    CHECKOUT = Path("/home/ljang/odysseys/osworld_runner")

    def _accepted(self, runner: Path) -> set[str]:
        import re
        return set(re.findall(r'add_argument\(\s*"(--[^"]+)"', runner.read_text(encoding="utf-8")))

    def _emitted(self, command):
        return {part for part in command if isinstance(part, str) and part.startswith("--")}

    def test_the_claude_command_uses_only_accepted_flags(self):
        runner = self.CHECKOUT / run.CLAUDE_RUNNER_PATH
        if not runner.is_file():
            self.skipTest("OSWorld checkout not present")
        args = SimpleNamespace(
            agent_backend="anthropic", anthropic_model="claude-opus-5", anthropic_effort="high",
            anthropic_max_tokens=16_000, provider_name="apptainer", max_steps=120,
            max_trajectory_length=120, num_envs=5, sleep_after_execution=2.0,
            domain="apollo_chrome", client_password="password", aws_region="us-east-1",
            osworld_root=self.CHECKOUT, path_to_vm=Path("/vm.qcow2"),
        )
        command = run.anthropic_osworld_command(args, run.job_paths(Path("/work"), model="claude-opus-5"))
        unknown = self._emitted(command) - self._accepted(runner)
        self.assertEqual(unknown, set(), f"runner would reject: {sorted(unknown)}")


class EmptyBatchDetectionTests(unittest.TestCase):
    def _log(self, text):
        import tempfile
        handle = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False)
        handle.write(text); handle.close()
        return Path(handle.name)

    def test_both_judges_all_failed_wording_is_recognised(self):
        # Matching only the in-tree judge's phrasing killed a shard whose VMs
        # had all died, instead of recording an empty batch and carrying on.
        self.assertTrue(run_queue.batch_ran_empty(
            self._log("error: no eligible trajectory runs found\n")))
        self.assertTrue(run_queue.batch_ran_empty(
            self._log("No completed runs found in: /work/trajectory_review/jpeg_runs\n")))

    def test_a_real_failure_is_not_mistaken_for_an_empty_batch(self):
        self.assertFalse(run_queue.batch_ran_empty(
            self._log("error: judge exited 1\nTraceback...\n")))
        self.assertFalse(run_queue.batch_ran_empty(Path("/nonexistent/x.log")))
