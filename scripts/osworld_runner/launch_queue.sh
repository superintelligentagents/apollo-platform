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

agent_backend="${OSWORLD_AGENT_BACKEND:-muse-spark}"
openai_env_file="${OSWORLD_OPENAI_ENV_FILE:-}"
anthropic_env_file="${OSWORLD_ANTHROPIC_ENV_FILE:-}"
gemini_env_file="${OSWORLD_GEMINI_ENV_FILE:-}"
judge_model="${OSWORLD_JUDGE_MODEL:-gpt-5.4-mini}"

read_env_key() {  # file, variable -> value on stdout; never on a command line
  sed -n "s/^\(export \)\{0,1\}$2=//p" "$1" | head -1 | tr -d '"'"'"'"'
}

APOLLO_REPORTING_TOKEN="$(
  aws secretsmanager get-secret-value \
    --secret-id "$reporting_secret_id" \
    --query SecretString \
    --output text | jq -r '.reportingKey // empty'
)"
if [[ -z "$APOLLO_REPORTING_TOKEN" || "$APOLLO_REPORTING_TOKEN" == "null" ]]; then
  echo "Apollo reporting token is unavailable" >&2
  exit 1
fi
export APOLLO_REPORTING_TOKEN

if [[ "$agent_backend" == "openai" ]]; then
  # The OpenAI key lives in a mode-600 env file (KEY=value lines), never in argv.
  if [[ -z "$openai_env_file" || ! -r "$openai_env_file" ]]; then
    echo "OSWORLD_OPENAI_ENV_FILE must point to a readable env file" >&2
    exit 1
  fi
  OPENAI_API_KEY="$(sed -n 's/^\(export \)\{0,1\}OPENAI_API_KEY=//p' "$openai_env_file" | head -1 | tr -d '"'"'"'"')"
  if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "OPENAI_API_KEY is missing from $openai_env_file" >&2
    exit 1
  fi
  export OPENAI_API_KEY
elif [[ "$agent_backend" == "anthropic" ]]; then
  # The Claude agent needs its own key; the judge stays on OpenAI so scores
  # remain comparable with the baseline corpus, so both keys are required.
  if [[ -z "$anthropic_env_file" || ! -r "$anthropic_env_file" ]]; then
    echo "OSWORLD_ANTHROPIC_ENV_FILE must point to a readable env file" >&2
    exit 1
  fi
  ANTHROPIC_API_KEY="$(read_env_key "$anthropic_env_file" ANTHROPIC_API_KEY)"
  if [[ -z "$ANTHROPIC_API_KEY" ]]; then
    echo "ANTHROPIC_API_KEY is missing from $anthropic_env_file" >&2
    exit 1
  fi
  export ANTHROPIC_API_KEY
  if [[ -z "$openai_env_file" || ! -r "$openai_env_file" ]]; then
    echo "OSWORLD_OPENAI_ENV_FILE must also be set: the rubric judge runs on OpenAI" >&2
    exit 1
  fi
  OPENAI_API_KEY="$(read_env_key "$openai_env_file" OPENAI_API_KEY)"
  if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "OPENAI_API_KEY is missing from $openai_env_file" >&2
    exit 1
  fi
  export OPENAI_API_KEY
else
  MUSE_SPARK_API_KEY="$(
    aws secretsmanager get-secret-value \
      --secret-id "$meta_secret_id" \
      --query SecretString \
      --output text | jq -r '.apiKey // empty'
  )"
  if [[ -z "$MUSE_SPARK_API_KEY" || "$MUSE_SPARK_API_KEY" == "null" ]]; then
    echo "Meta API key is unavailable" >&2
    exit 1
  fi
  export MUSE_SPARK_API_KEY
fi
# The judge is chosen independently of the agent, so its key is loaded on its
# own terms: a Gemini judge needs a Gemini key whatever the agent is.
if [[ "$judge_model" == gemini* ]]; then
  if [[ -z "$gemini_env_file" || ! -r "$gemini_env_file" ]]; then
    echo "OSWORLD_GEMINI_ENV_FILE must point to a readable env file for a Gemini judge" >&2
    exit 1
  fi
  GEMINI_API_KEY="$(read_env_key "$gemini_env_file" GEMINI_API_KEY)"
  if [[ -z "$GEMINI_API_KEY" ]]; then
    echo "GEMINI_API_KEY is missing from $gemini_env_file" >&2
    exit 1
  fi
  export GEMINI_API_KEY
fi

cd "$workspace_root"
exec "$python_bin" scripts/osworld_runner/run_queue.py \
  --queue v2 \
  --batch-size "$concurrency" \
  --num-envs "$concurrency" \
  --judge-workers "$concurrency" \
  --max-steps "${OSWORLD_MAX_STEPS:-100}" \
  --max-trajectory-length "${OSWORLD_MAX_STEPS:-100}" \
  --max-retries "${OSWORLD_MAX_RETRIES:-3}" \
  --max-batches "${OSWORLD_MAX_BATCHES:-0}" \
  ${OSWORLD_DEDUPE_BY_MODEL:+--dedupe-by-model} \
  --agent-backend "$agent_backend" \
  --openai-model "${OSWORLD_OPENAI_MODEL:-gpt-5.6-luna}" \
  --openai-reasoning-effort "${OSWORLD_OPENAI_REASONING_EFFORT:-medium}" \
  --anthropic-model "${OSWORLD_ANTHROPIC_MODEL:-claude-opus-5}" \
  --anthropic-effort "${OSWORLD_ANTHROPIC_EFFORT:-high}" \
  --judge-model "$judge_model" \
  --judge-max-images "${OSWORLD_JUDGE_MAX_IMAGES:-0}" \
  --judge-impl "${OSWORLD_JUDGE_IMPL:-canonical}" \
  --start-url-mode "${OSWORLD_START_URL_MODE:-google}" \
  --screen-width "${OSWORLD_SCREEN_WIDTH:-1920}" \
  --screen-height "${OSWORLD_SCREEN_HEIGHT:-1080}" \
  ${OSWORLD_EXCLUDE_TASKS_FILE:+--exclude-task-ids-file "$OSWORLD_EXCLUDE_TASKS_FILE"} \
  ${OSWORLD_RUBRIC_OVERLAY_JSON:+--rubric-overlay-json "$OSWORLD_RUBRIC_OVERLAY_JSON"} \
  ${OSWORLD_DEDUPE_RUN_LABEL_PREFIX:+--dedupe-by-run-label-prefix "$OSWORLD_DEDUPE_RUN_LABEL_PREFIX"} \
  ${OSWORLD_RUN_LABEL_PREFIX:+--run-label-prefix "$OSWORLD_RUN_LABEL_PREFIX"} \
  ${OSWORLD_META_BLOCK_MARKER:+--block-marker "$OSWORLD_META_BLOCK_MARKER"} \
  --min-free-gib "$min_free_gib" \
  --osworld-root "$osworld_root" \
  --provider-name "$provider_name" \
  --path-to-vm "$vm_path" \
  --shard-count "$shard_count" \
  --shard-index "$shard_index" \
  --work-root "$work_root"
