#!/usr/bin/env bash
set -euo pipefail

umask 077

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="${OSWORLD_WORK_ROOT:-$workspace_root/.work/osworld_runner/queue-v2-c3-20260829}"
concurrency="${OSWORLD_CONCURRENCY:-6}"
min_free_gib="${OSWORLD_MIN_FREE_GIB:-100}"
osworld_root="${OSWORLD_ROOT:-/home/jykoh/OSWorld}"
vm_path="${OSWORLD_VM_PATH:-/home/ljang/osworld_src/docker_vm_data/Ubuntu.qcow2}"
provider_name="${OSWORLD_PROVIDER_NAME:-docker}"
python_bin="${OSWORLD_PYTHON:-python3}"
shard_count="${OSWORLD_SHARD_COUNT:-1}"
shard_index="${OSWORLD_SHARD_INDEX:-0}"
meta_secret_id="${OSWORLD_META_SECRET_ID:-MetaSecret-5u6l3xwWXGqj}"
reporting_secret_id="${OSWORLD_REPORTING_SECRET_ID:-apollo/osworld/reporting}"

MUSE_SPARK_API_KEY="$(
  aws secretsmanager get-secret-value \
    --secret-id "$meta_secret_id" \
    --query SecretString \
    --output text | jq -r '.apiKey // empty'
)"
APOLLO_REPORTING_TOKEN="$(
  aws secretsmanager get-secret-value \
    --secret-id "$reporting_secret_id" \
    --query SecretString \
    --output text | jq -r '.reportingKey // empty'
)"

if [[ -z "$MUSE_SPARK_API_KEY" || "$MUSE_SPARK_API_KEY" == "null" ]]; then
  echo "Meta API key is unavailable" >&2
  exit 1
fi
if [[ -z "$APOLLO_REPORTING_TOKEN" || "$APOLLO_REPORTING_TOKEN" == "null" ]]; then
  echo "Apollo reporting token is unavailable" >&2
  exit 1
fi

export MUSE_SPARK_API_KEY APOLLO_REPORTING_TOKEN
cd "$workspace_root"
exec "$python_bin" scripts/osworld_runner/run_queue.py \
  --queue v2 \
  --batch-size "$concurrency" \
  --num-envs "$concurrency" \
  --judge-workers "$concurrency" \
  --max-steps 120 \
  --max-trajectory-length 120 \
  --min-free-gib "$min_free_gib" \
  --osworld-root "$osworld_root" \
  --provider-name "$provider_name" \
  --path-to-vm "$vm_path" \
  --shard-count "$shard_count" \
  --shard-index "$shard_index" \
  --work-root "$work_root"
