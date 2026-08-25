#!/usr/bin/env bash
# Backfill v2-review/inbox/ markers for v2 submissions that predate the inbox
# index (uploaded before 2026-07-23). Safe to re-run — markers are idempotent.
set -euo pipefail
BUCKET="${BUCKET:-journeys-prolific}"
count=0
aws s3 ls "s3://$BUCKET/prolific/journeys/" --recursive \
  | awk '{print $4}' | grep "/v2/" | grep "long_task.json$" | while read -r KEY; do
    MARKER=$(python3 -c "import base64,sys;print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip('='))" "$KEY")
    printf '%s' "$KEY" | aws s3 cp - "s3://$BUCKET/v2-review/inbox/$MARKER" --content-type text/plain >/dev/null
    echo "marker: $KEY"
    count=$((count+1))
done
echo "done."
