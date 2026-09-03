#!/bin/bash
#SBATCH --job-name=apollo-osworld
#SBATCH --cpus-per-task=32
#SBATCH --mem=96G
#SBATCH --gres=gpu:1
#SBATCH --time=2-00:00:00
#SBATCH --requeue
#SBATCH --signal=B:TERM@1800
#SBATCH --mail-type=NONE
#SBATCH --output=/data/user_data/ljang/apollo-osworld/logs/%x-%j.out
#
# One resumable Apollo OSWorld queue shard on babel (apptainer + qemu/KVM).
# Submit with:
#   sbatch $(scripts/babel/_kvm_exclude.sh) --partition=<general|russ-lab> [--qos=russ_lab_qos] \
#     --export=ALL,OSWORLD_SHARD_COUNT=<N>,OSWORLD_SHARD_INDEX=<i> \
#     scripts/osworld_runner/babel_queue.sbatch
# The queue publishes each verified batch to S3 before starting the next, so a
# requeue (walltime, node failure, bad-KVM node) resumes without losing work.
set -uo pipefail

DATA=/data/user_data/ljang
SCRATCH=/scratch/ljang
KVM_DENYLIST=$DATA/kvm_nodes/denylist.txt

# --- KVM preflight: denylist the node and requeue instead of failing the shard ---
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  mkdir -p "$(dirname "$KVM_DENYLIST")"
  grep -qxF "$(hostname)" "$KVM_DENYLIST" 2>/dev/null || echo "$(hostname)" >> "$KVM_DENYLIST"
  echo "no usable /dev/kvm on $(hostname); denylisted and requeueing"
  scontrol requeue "$SLURM_JOB_ID" || true
  sleep 15
  exit 75
fi

# --- requeue ourselves when SLURM signals the approaching walltime ---
requeue_self() {
  echo "TERM near walltime; requeueing shard $OSWORLD_SHARD_INDEX"
  scontrol requeue "$SLURM_JOB_ID" || true
  exit 0
}
trap requeue_self TERM

# --- stage the base VM image to node-local scratch under a shared lock ---
mkdir -p "$SCRATCH/osworld_vms" "$SCRATCH/osworld_apptainer/run" \
  "$SCRATCH/osworld_apptainer/overlays/$SLURM_JOB_ID" \
  "$SCRATCH/apptainer-cache" "$SCRATCH/apptainer-tmp" \
  "$SCRATCH/tmp/$SLURM_JOB_ID"
# Some nodes have a broken or exhausted per-job /tmp, which kills Playwright's
# mkdtemp during Chrome setup — keep all tempfiles on node-local scratch.
export TMPDIR=$SCRATCH/tmp/$SLURM_JOB_ID
flock "$SCRATCH/osworld_vms/.stage.lock" bash -c "
  [[ -s $SCRATCH/osworld_vms/Ubuntu.qcow2 ]] || {
    rsync -a $DATA/osworld_vms/Ubuntu.qcow2 $SCRATCH/osworld_vms/.staging.qcow2 &&
    mv $SCRATCH/osworld_vms/.staging.qcow2 $SCRATCH/osworld_vms/Ubuntu.qcow2
  }
"
cleanup_overlays() { rm -rf "$SCRATCH/osworld_apptainer/overlays/$SLURM_JOB_ID" "$SCRATCH/tmp/$SLURM_JOB_ID"; }
trap cleanup_overlays EXIT

# --- apptainer provider contract (read by the odysseys OSWorld fork) ---
export OSWORLD_APPTAINER_SIF=$DATA/apptainer/images/osworld-docker.sif
export OSWORLD_APPTAINER_VMS_DIR=$SCRATCH/osworld_vms
export OSWORLD_APPTAINER_OVERLAY_DIR=$SCRATCH/osworld_apptainer/overlays/$SLURM_JOB_ID
export OSWORLD_APPTAINER_RUN_DIR=$SCRATCH/osworld_apptainer/run
export OSWORLD_APPTAINER_CPUS=${OSWORLD_APPTAINER_CPUS:-4}
export OSWORLD_APPTAINER_RAM=${OSWORLD_APPTAINER_RAM:-6G}
export OSWORLD_APPTAINER_BOOT_TIMEOUT=${OSWORLD_APPTAINER_BOOT_TIMEOUT:-300}
export APPTAINER_CACHEDIR=$SCRATCH/apptainer-cache
export APPTAINER_TMPDIR=$SCRATCH/apptainer-tmp

# --- orchestration environment for launch_queue.sh ---
VENV=$DATA/apollo-osworld/venv
export PATH=$DATA/apollo-osworld/bin:$VENV/bin:$PATH   # aws CLI v2 + venv python
export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1
export OSWORLD_PYTHON=$VENV/bin/python
export OSWORLD_ROOT=/home/ljang/odysseys/osworld_runner
export OSWORLD_PROVIDER_NAME=apptainer
export OSWORLD_VM_PATH=$SCRATCH/osworld_vms/Ubuntu.qcow2   # ignored by the apptainer path
export OSWORLD_SHARD_COUNT=${OSWORLD_SHARD_COUNT:?set via --export}
export OSWORLD_SHARD_INDEX=${OSWORLD_SHARD_INDEX:?set via --export}
# Work-root prefix separates independent runs (e.g. a bounded OpenAI test)
# from the main Meta queue state, whose shard-count differs.
export OSWORLD_WORK_ROOT=$DATA/apollo-osworld/${OSWORLD_WORK_ROOT_PREFIX:-queue-v2}-s${OSWORLD_SHARD_INDEX}
export OSWORLD_CONCURRENCY=${OSWORLD_CONCURRENCY:-4}
export OSWORLD_MIN_FREE_GIB=${OSWORLD_MIN_FREE_GIB:-20}
# Fleet-wide kill switch: any agent that sees a 403 user_blocked from Meta
# writes this file, and every shard stops calling the API until an operator
# removes it. Also skip tasks known to trip the content filter.
export OSWORLD_META_BLOCK_MARKER=$DATA/apollo-osworld/META_BLOCKED
export OSWORLD_EXCLUDE_TASKS_FILE=$DATA/apollo-osworld/excluded-tasks.txt
# Agent backend: muse-spark (Meta) or openai (upstream GPT-5.4-style agent).
export OSWORLD_AGENT_BACKEND=${OSWORLD_AGENT_BACKEND:-muse-spark}
export OSWORLD_OPENAI_ENV_FILE=${OSWORLD_OPENAI_ENV_FILE:-$DATA/apollo-osworld/openai.env}
export OSWORLD_OPENAI_MODEL=${OSWORLD_OPENAI_MODEL:-gpt-5.6-luna}
export OSWORLD_OPENAI_REASONING_EFFORT=${OSWORLD_OPENAI_REASONING_EFFORT:-medium}
export OSWORLD_JUDGE_MODEL=${OSWORLD_JUDGE_MODEL:-gpt-5.4-mini}
# Multi-model coverage: skip a task only when THIS model already ran it.
export OSWORLD_DEDUPE_BY_MODEL=${OSWORLD_DEDUPE_BY_MODEL:-}
if [[ "$OSWORLD_AGENT_BACKEND" != "openai" && -e "$OSWORLD_META_BLOCK_MARKER" ]]; then
  echo "Meta block marker present ($OSWORLD_META_BLOCK_MARKER); not starting"
  exit 0
fi

# Background + wait so the TERM trap can fire while the queue runs.
bash /home/ljang/apollo-platform/scripts/osworld_runner/launch_queue.sh &
wait $!
