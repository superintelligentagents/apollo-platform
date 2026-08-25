#!/usr/bin/env bash
# Emergency prebuilt deploy for apollo-v2-site. Normal production deploys come
# from the Git-connected Vercel project after a merge to main. Run this fallback
# from apollo-v2/web; it requires AWS access to fetch the review key and a linked
# .vercel/project.json.
set -euo pipefail
cd "$(dirname "$0")"
VITE_REVIEW_KEY="$(aws lambda get-function-configuration --function-name journeys-presign \
  --query 'Environment.Variables.REVIEW_KEY' --output text)"
[ -n "$VITE_REVIEW_KEY" ] && [ "$VITE_REVIEW_KEY" != "None" ] || { echo "REVIEW_KEY lookup failed" >&2; exit 1; }
export VITE_REVIEW_KEY
npm run build
rm -rf .vercel/output/static
mkdir -p .vercel/output/static
cp -R dist/. .vercel/output/static/
# config.json (immutable asset caching) is tracked in-place; verify it exists.
grep -q 'immutable' .vercel/output/config.json || { echo "config.json missing immutable headers" >&2; exit 1; }
# rootDirectory workaround: the Vercel project expects an apollo-v2/ prefix.
rm -rf apollo-v2
mkdir -p apollo-v2/.vercel
cp -R .vercel/output apollo-v2/.vercel/output
cp .vercel/project.json apollo-v2/.vercel/project.json
npx vercel deploy --prebuilt --prod --yes
rm -rf apollo-v2
