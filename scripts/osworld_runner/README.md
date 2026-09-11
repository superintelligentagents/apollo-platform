# Apollo OSWorld runner

This bridge runs only Apollo tasks that are both human-approved and explicitly
accepted or amended by their author. It reads those final tasks from the
read-only reporting API, generates path-safe OSWorld configs under the ignored
`.work/` directory, uses the OSWorld checkout in `/home/jykoh/OSWorld`, judges
the completed trajectories, and publishes the immutable packages to Apollo's
S3 trajectory inbox.

The desktop run uses OSWorld's native `MuseSparkAgent` from the upstream
`xlang-ai/OSWorld` repository, pinned by commit and SHA-256 under the ignored
job directory. It calls `https://api.ai.meta.com/v1` with `super_nova_ext` and
the required `x-session-id`. Only the scoped `MUSE_SPARK_API_KEY` is forwarded
to the OSWorld child; the Apollo reporting token and AWS environment credentials
are stripped. The rubric judge uses the same Meta model through a loopback proxy
so it never receives the Meta key. It evaluates the complete action history and
12 evenly sampled chronological screenshots spanning the whole run, staying
within Meta's request limits and practical latency bounds. The native desktop
agent uses high reasoning effort; the two-line rubric evaluator uses low effort
with a larger output allowance so reasoning cannot crowd out its verdict.
Generated task text, screenshots, and logs are private local artifacts and must
never be committed.

## One-task pilot

Authenticate AWS first, then inject both secrets through the process
environment. Do not put them on the command line or in this repository.

```bash
aws login
export APOLLO_REPORTING_TOKEN='retrieve-from-the-approved-secret-store'
export MUSE_SPARK_API_KEY='retrieve-from-the-approved-meta-secret-store'

python3 scripts/osworld_runner/run.py \
  --stage all \
  --queue v2 \
  --limit 1 \
  --s3-bucket journeys-prolific
```

Apollo PC runs additionally require `--pc-context-config-dir`. The directory is
private and contains one file per task named with that task's `apollo_b64_…`
run ID. Each file uses this contract:

```json
{
  "schema_version": "apollo-pc-osworld-context-v1",
  "task_id": "pc_task-id",
  "config": [{ "type": "launch", "parameters": { "command": ["approved-context-app"] } }],
  "related_apps": ["approved-context-app"]
}
```

`config` contains the OSWorld setup actions that provision that task's
redacted personal context in its disposable VM. These files can contain private
data, must stay outside Git (the ignored `.work/` tree is suitable), and must be
produced by an approved context provisioner. The included provisioner reads only
the selected task's bundle, verifies every referenced part hash, keeps only the
email, calendar, or document record IDs the author attached to that task, and
emits a mode-0600 setup file:

```bash
node scripts/osworld_runner/prepare_pc_context.mjs \
  --task-id 'pc_task-id' \
  --creator-pid 'protected-author-id' \
  --output-dir '.work/pc-context'

python3 scripts/osworld_runner/run.py \
  --stage all \
  --queue pc \
  --pc-context-config-dir '.work/pc-context' \
  --limit 1
```

Use a separate, short-lived read role for the provisioning command; its minimal
policy is in `aws/pc-context-reader-policy.json`. Keep the trajectory runner's
AWS role publish-only. The runner fails closed when a PC task has no exact
matching context config; it never substitutes an empty Chrome session and
publishes an invalid trajectory.

The default run uses one Docker/KVM environment with the existing
`/home/ljang/osworld_src/docker_vm_data/Ubuntu.qcow2` image,
`super_nova_ext`, OSWorld's batched Muse Spark computer tools, and at most 100
agent steps. Desktop-agent Meta calls have a 600-second per-request timeout and
at most three SDK retries, configurable with `--request-timeout` and
`--max-retries`. Use
`--provider-name vmware --path-to-vm /path/to/Ubuntu.vmx` when the invoking
account owns that VM. Tasks with any existing trajectory are skipped unless
`--include-existing-trajectories` is set. Pin a specific task with repeatable
`--task-id` arguments. Override the gateway session label with
`--meta-session-id`; it is not a credential.

Before task recording, each disposable Ubuntu VM verifies the native agent's
`xclip` dependency and installs `xclip`/`xsel` when absent. This setup action
uses OSWorld's `{CLIENT_PASSWORD}` substitution, runs before Chrome starts, and
does not add the password or package-install action to the trajectory.

For an inspectable staged run:

```bash
python3 scripts/osworld_runner/run.py --stage fetch --limit 1
python3 scripts/osworld_runner/run.py --stage run
python3 scripts/osworld_runner/run.py --stage publish --plan
python3 scripts/osworld_runner/run.py --stage publish
```

`--stage publish --plan` validates run/task assignment and AWS access without a
model call or write. Successful publication creates objects only below
`v2-review/trajectory-runs/` and `v2-review/trajectory-inbox/` (or the matching
`pc-review/` prefixes with `--queue pc`). It never writes task or final-gold
objects.

Increase parallelism in small canaries by keeping the selected task count and
environment count equal, for example `--limit 2 --num-envs 2`. Match
`--judge-workers` only after the desktop runs have proven stable. Check host
disk headroom between batches because each live Docker/KVM environment creates
a transient writable layer even though the shared QCOW base is mounted
read-only.

The resumable queue accepts successful trajectories from a partially failed
parallel batch, records the failed task IDs for retry, and continues. On
restart it also verifies and accounts for any batch that finished publishing
before the queue worker exited.

For the production queue, `launch_queue.sh` retrieves the scoped Meta key and
Apollo reporting token directly from AWS, defaults to six environments, and
stops before disk space falls below 100 GiB. Secret values are exported only to
the worker process and are never placed in command arguments or local files.

## Tests

```bash
python3 -m unittest scripts.osworld_runner.test_run
node --test scripts/osworld_runner/prepare_pc_context.test.mjs
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'
```
