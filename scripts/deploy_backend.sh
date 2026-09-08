#!/usr/bin/env bash
#
# Deploy backend/lambda_presign.js to both production Lambdas.
#
# The deployed package is the live one with a single file replaced: the zip
# checked into the repo is historical and must never be shipped. Both functions
# must end on identical code and keep their own role, APP_SCOPE, and
# REVIEW_PREFIX -- that split is the boundary keeping V2 and PC uploads apart,
# so the script verifies it rather than trusting it.
#
#   scripts/deploy_backend.sh --plan     # report the live state, change nothing
#   scripts/deploy_backend.sh
#
set -euo pipefail

V2_FN=journeys-presign
PC_FN=journeys-pc-presign
SOURCE=backend/lambda_presign.js
PLAN=0
[[ "${1:-}" == "--plan" ]] && PLAN=1

cd "$(dirname "$0")/.."
[[ -f "$SOURCE" ]] || { echo "run from a checkout: $SOURCE not found" >&2; exit 1; }

aws lambda get-function --function-name "$V2_FN" >/dev/null || {
  echo "no Lambda access. Authenticate first: aws login --profile root" >&2; exit 1; }

state() {  # function name -> code sha, role, scope, prefix
  aws lambda get-function --function-name "$1" --output text \
    --query 'Configuration.[CodeSha256,Role,Environment.Variables.APP_SCOPE,Environment.Variables.REVIEW_PREFIX]'
}

echo "=== live before"
printf '%-22s %s\n' "$V2_FN" "$(state "$V2_FN")"
printf '%-22s %s\n' "$PC_FN" "$(state "$PC_FN")"

WORK=$(mktemp -d)
trap '[[ -n "${KEEP_WORK:-}" ]] || rm -rf "$WORK"' EXIT

echo "=== downloading the live $V2_FN package"
URL=$(aws lambda get-function --function-name "$V2_FN" --query 'Code.Location' --output text)
curl -sS -o "$WORK/live.zip" "$URL"
mkdir -p "$WORK/pkg"
unzip -q "$WORK/live.zip" -d "$WORK/pkg"
[[ -f "$WORK/pkg/lambda_presign.js" ]] || { echo "live package has no lambda_presign.js" >&2; exit 1; }

if ! diff -q "$WORK/pkg/lambda_presign.js" "$SOURCE" >/dev/null; then
  echo "    handler differs from the checkout by $(diff "$WORK/pkg/lambda_presign.js" "$SOURCE" | grep -c '^[<>]') lines"
else
  echo "    live handler already matches the checkout; deploying is a no-op"
fi

LIVE_FILES=$(unzip -l "$WORK/live.zip" | tail -1 | awk '{print $2}')
cp "$SOURCE" "$WORK/pkg/lambda_presign.js"
( cd "$WORK/pkg" && zip -qrX "$WORK/deploy.zip" . )

# A truncated package deploys cleanly and then fails every request at runtime,
# so refuse to ship one that lost files or the bundled dependencies.
BUILT_FILES=$(unzip -l "$WORK/deploy.zip" | tail -1 | awk '{print $2}')
# stat, not du: du reports allocated blocks, and a freshly written file on
# this filesystem reads as 1K until allocation settles. grep -c, not grep -q:
# -q closes the pipe on its first match, and the SIGPIPE that kills unzip
# becomes a failed pipeline under `set -o pipefail`.
BUILT_DEPS=$(unzip -l "$WORK/deploy.zip" | grep -c 'node_modules/' || true)
echo "=== built $WORK/deploy.zip ($(stat -c %s "$WORK/deploy.zip") bytes, $BUILT_FILES entries vs $LIVE_FILES live, $BUILT_DEPS bundled deps)"
[[ "$BUILT_FILES" == "$LIVE_FILES" ]] || { echo "FAIL: rebuilt package has $BUILT_FILES entries, live has $LIVE_FILES" >&2; exit 1; }
[[ "$BUILT_DEPS" -gt 100 ]] || { echo "FAIL: rebuilt package has no bundled dependencies" >&2; exit 1; }
diff -q <(unzip -p "$WORK/deploy.zip" lambda_presign.js) "$SOURCE" >/dev/null \
  || { echo "FAIL: rebuilt package does not carry the checkout's handler" >&2; exit 1; }

if [[ $PLAN == 1 ]]; then echo "--plan: nothing deployed"; exit 0; fi

for FN in "$V2_FN" "$PC_FN"; do
  echo "=== updating $FN"
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$WORK/deploy.zip" \
    --query '[FunctionName,CodeSha256]' --output text
  aws lambda wait function-updated --function-name "$FN"
done

echo "=== live after"
V2_STATE=$(state "$V2_FN"); PC_STATE=$(state "$PC_FN")
printf '%-22s %s\n' "$V2_FN" "$V2_STATE"
printf '%-22s %s\n' "$PC_FN" "$PC_STATE"

read -r V2_SHA V2_ROLE V2_SCOPE V2_PREFIX <<<"$V2_STATE"
read -r PC_SHA PC_ROLE PC_SCOPE PC_PREFIX <<<"$PC_STATE"
fail=0
[[ "$V2_SHA" == "$PC_SHA" ]] || { echo "FAIL: the two functions are on different code" >&2; fail=1; }
[[ "$V2_ROLE" != "$PC_ROLE" ]] || { echo "FAIL: shared IAM role" >&2; fail=1; }
[[ "$V2_SCOPE" != "$PC_SCOPE" ]] || { echo "FAIL: shared APP_SCOPE" >&2; fail=1; }
[[ "$V2_PREFIX" != "$PC_PREFIX" ]] || { echo "FAIL: shared REVIEW_PREFIX" >&2; fail=1; }
[[ $fail == 0 ]] && echo "OK: identical code, separate role/scope/prefix"
exit $fail
