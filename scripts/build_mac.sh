#!/usr/bin/env bash
set -euo pipefail

# Build, sign, notarize, and staple the macOS app/DMG for Apollo.
# Requirements:
#  - Developer ID Application cert installed (IDENTITY env var set)
#  - notarytool profile configured (NOTARY_PROFILE env var set)
#  - DMG creation:
#      - Prefers `create-dmg` if installed, otherwise falls back to `hdiutil`.
#      - If `create-dmg` errors due to a Node ABI mismatch, reinstall it (e.g. `npm i -g create-dmg`) or let the script fall back.
# Usage:
#   IDENTITY="Developer ID Application: Lawrence Jang (DXYJ578DD4)" NOTARY_PROFILE="notarytool-profile" ./scripts/build_mac.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/journeys-helper-tauri/src-tauri/target/release/bundle/macos"
DMG_DIR="$ROOT_DIR/journeys-helper-tauri/src-tauri/target/release/bundle/dmg"
APP_NAME="Apollo.app"
S3_BUCKET="${S3_BUCKET:-journey-collector-downloads-lj-20241206}"
S3_PREFIX="${S3_PREFIX:-}"
SKIP_S3_UPLOAD="${SKIP_S3_UPLOAD:-0}"

: "${IDENTITY:?Set IDENTITY to your Developer ID Application certificate name}"
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE to your notarytool profile name}"

DMG_TMP_DIR=""
cleanup_dmg_tmp() {
  if [[ -n "${DMG_TMP_DIR:-}" && -d "${DMG_TMP_DIR:-}" ]]; then
    rm -rf -- "$DMG_TMP_DIR"
  fi
}
trap cleanup_dmg_tmp EXIT

create_dmg_hdiutil() {
  local app_path="$1"
  local dmg_path="$2"
  local vol_name="$3"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  # Used by the global EXIT trap above.
  DMG_TMP_DIR="$tmp_dir"

  mkdir -p "$tmp_dir/stage"
  cp -R "$app_path" "$tmp_dir/stage/"
  ln -s /Applications "$tmp_dir/stage/Applications"

  # Build a simple compressed DMG (no custom window layout).
  hdiutil create \
    -volname "$vol_name" \
    -srcfolder "$tmp_dir/stage" \
    -ov \
    -format UDZO \
    "$dmg_path"
}

echo "==> Building Tauri app (app bundle only)"
cd "$ROOT_DIR/journeys-helper-tauri"
npm run tauri build -- --bundles app

APP_PATH="$APP_DIR/$APP_NAME"

echo "==> Signing app: $APP_PATH"
codesign --force --deep --options runtime --timestamp \
  --sign "$IDENTITY" \
  "$APP_PATH"

echo "==> Verifying signature"
codesign -vvv --deep --strict "$APP_PATH"

echo "==> Rebuilding DMG from signed app"
mkdir -p "$DMG_DIR"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
APP_DISPLAY_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Print :CFBundleName" "$INFO_PLIST" 2>/dev/null || true)
APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST" 2>/dev/null || true)
: "${BUILD_DATE:=$(date +%Y%m%d)}"
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  ARCH="aarch64"
fi

if [[ -z "${APP_DISPLAY_NAME:-}" || -z "${APP_VERSION:-}" ]]; then
  echo "Unable to read app name/version from Info.plist at $INFO_PLIST"
  exit 1
fi

DEFAULT_DMG_PATH="$DMG_DIR/${APP_DISPLAY_NAME} ${APP_VERSION}.dmg"
DMG_NAME="Apollo_${APP_VERSION}_${BUILD_DATE}_${ARCH}.dmg"
DMG_PATH="$DMG_DIR/$DMG_NAME"

rm -f "$DMG_PATH" "$DEFAULT_DMG_PATH"

if [[ "${SKIP_CREATE_DMG:-}" != "1" ]] && command -v create-dmg >/dev/null 2>&1; then
  echo "==> Creating DMG via create-dmg"
  # Use the installed create-dmg (Sindre Sorhus) CLI which expects the .app path.
  if create-dmg --overwrite \
    --dmg-title "$APP_DISPLAY_NAME" \
    --identity "$IDENTITY" \
    "$APP_PATH" "$DMG_DIR"; then
    if [[ ! -f "$DEFAULT_DMG_PATH" ]]; then
      echo "create-dmg did not produce expected file at $DEFAULT_DMG_PATH"
      exit 1
    fi

    # Keep the historical filename that includes version/date/architecture.
    if [[ "$DEFAULT_DMG_PATH" != "$DMG_PATH" ]]; then
      mv "$DEFAULT_DMG_PATH" "$DMG_PATH"
    fi
  else
    echo "create-dmg failed; falling back to hdiutil DMG creation."
  fi
else
  if [[ "${SKIP_CREATE_DMG:-}" == "1" ]]; then
    echo "==> SKIP_CREATE_DMG=1; using hdiutil"
  else
    echo "==> create-dmg not found; using hdiutil"
  fi
fi

if [[ ! -f "$DMG_PATH" ]]; then
  echo "==> Creating DMG via hdiutil"
  create_dmg_hdiutil "$APP_PATH" "$DMG_PATH" "$APP_DISPLAY_NAME"
fi

echo "==> Signing DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG_PATH"

echo "==> Submitting for notarization"
SUBMIT_OUTPUT=$(xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait)
echo "$SUBMIT_OUTPUT"

echo "==> Stapling ticket"
xcrun stapler staple "$DMG_PATH"

LATEST_DMG_PATH="$DMG_DIR/Apollo_latest_${ARCH}.dmg"
cp -f "$DMG_PATH" "$LATEST_DMG_PATH"

S3_KEY_VERSIONED="${S3_PREFIX:+$S3_PREFIX/}$DMG_NAME"
S3_KEY_LATEST="${S3_PREFIX:+$S3_PREFIX/}Apollo_latest_${ARCH}.dmg"
PUBLIC_VERSIONED_URL="https://${S3_BUCKET}.s3.amazonaws.com/${S3_KEY_VERSIONED}"

if [[ "$SKIP_S3_UPLOAD" != "1" ]]; then
  if command -v aws >/dev/null 2>&1; then
    echo "==> Uploading versioned DMG to s3://$S3_BUCKET/$S3_KEY_VERSIONED"
    aws s3 cp "$DMG_PATH" "s3://$S3_BUCKET/$S3_KEY_VERSIONED"
    echo "==> Uploading latest DMG to s3://$S3_BUCKET/$S3_KEY_LATEST"
    aws s3 cp "$LATEST_DMG_PATH" "s3://$S3_BUCKET/$S3_KEY_LATEST"
  else
    echo "aws CLI not found; skipping S3 upload."
  fi
fi

echo "==> Updating landing page links to $PUBLIC_VERSIONED_URL"
python3 - <<PY
import pathlib, re
root = pathlib.Path("$ROOT_DIR")
new_url = "$PUBLIC_VERSIONED_URL"
pattern = re.compile(r"https://journey-collector-downloads-lj-20241206\\.s3\\.amazonaws\\.com/(Journey_Collector|Apollo)_[^\"']*aarch64\\.dmg")
for rel in ["web_app/index.html", "web_app/download.html"]:
    path = root / rel
    if not path.exists():
        continue
    text = path.read_text()
    new_text = pattern.sub(new_url, text)
    if text != new_text:
        path.write_text(new_text)
        print(f"Updated {path}")
    else:
        print(f"No change needed for {path}")
PY

echo "Done."
echo "Versioned DMG ready at: $DMG_PATH"
echo "Latest DMG ready at:   $LATEST_DMG_PATH"
