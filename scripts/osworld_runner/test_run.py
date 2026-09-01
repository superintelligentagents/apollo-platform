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

    def test_osworld_config_uses_final_request_and_public_start_urls(self):
        config = run.osworld_config(task(), "apollo_chrome")
        self.assertEqual(config["instruction"], "Research the topic and summarize it.")
        self.assertEqual(config["config"][0]["type"], "command")
        self.assertIn("command -v xclip", config["config"][0]["parameters"]["command"])
        self.assertEqual(config["config"][1]["type"], "execute_with_verification")
        tabs = config["config"][-1]["parameters"]["urls_to_open"]
        self.assertEqual(tabs, ["https://example.com/start", "https://example.org/"])
        self.assertEqual(config["metadata"]["apollo_task_id"], "v2/alice/internal/task-1")

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

    def test_trajectory_judge_is_labeled_meta_and_respects_image_limit(self):
        args = run.parser().parse_args(["--stage", "publish"])
        paths = run.job_paths(Path("/tmp/job"), model=args.meta_model)
        command = run.trajectory_command(args, paths, plan=False)
        self.assertIn("meta", command)
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
