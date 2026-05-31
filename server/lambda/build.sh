#!/usr/bin/env bash
#
# Package the processing Lambda into a deployable zip.
#
# We can't simply zip server/lambda/processor/ because it `require()`s files
# from the wider server/ tree (config/db.js, models/, utils/, workers/handler.js).
# So we stage a fresh build directory that mirrors the relative paths the code
# expects, then run `npm install --omit=dev` inside it, then zip the result.
#
# Output: dist/lambda.zip   (referenced by infra/template.yaml)
#
# Usage:
#   bash server/lambda/build.sh
#
# Requirements: bash, npm, zip.  Works on macOS/Linux/WSL/Git Bash on Windows.
set -euo pipefail

# Resolve paths from THIS script's location, not from the caller's CWD.
#   $0                                = server/lambda/build.sh
#   dirname $0                        = server/lambda
#   $(dirname $0)/..                  = server          ← SERVER_DIR
#   $(dirname $0)/../..               = ai-interview/   ← PROJECT_ROOT
#
# The previous version walked one extra "..", which placed PROJECT_ROOT
# outside the project (e.g. arena4/ on Windows) and made every relative `cp`
# fail with "No such file or directory".
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"          # → ai-interview/server/lambda
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"           # → ai-interview/server
PROJECT_ROOT="$(cd "$SERVER_DIR/.." && pwd)"         # → ai-interview/

BUILD_DIR="$PROJECT_ROOT/dist/lambda-build"
OUT_ZIP="$PROJECT_ROOT/dist/lambda.zip"

echo "[lambda-build] SERVER_DIR   = $SERVER_DIR"
echo "[lambda-build] PROJECT_ROOT = $PROJECT_ROOT"
echo "[lambda-build] BUILD_DIR    = $BUILD_DIR"

# Fail loudly if the expected source files aren't where we think they are —
# saves you from cryptic `cp` errors mid-build.
for required in \
  "$SERVER_DIR/lambda/processor/index.js" \
  "$SERVER_DIR/lambda/processor/package.json" \
  "$SERVER_DIR/config/db.js" \
  "$SERVER_DIR/models/index.js" \
  "$SERVER_DIR/utils/s3.js" \
  "$SERVER_DIR/utils/logger.js" \
  "$SERVER_DIR/workers/handler.js"
do
  if [ ! -f "$required" ]; then
    echo "[lambda-build] ERROR: required source file missing: $required" >&2
    exit 1
  fi
done

echo "[lambda-build] cleaning $BUILD_DIR"
rm -rf "$BUILD_DIR" "$OUT_ZIP"
mkdir -p "$BUILD_DIR"

# Layout inside the zip (everything flat at the root):
#   index.js                  ← Lambda handler entrypoint
#   config/db.js
#   models/index.js
#   utils/{s3.js,logger.js}
#   workers/handler.js
#   package.json
#   node_modules/...          ← prod deps
echo "[lambda-build] staging source files"
cp "$SERVER_DIR/lambda/processor/index.js"     "$BUILD_DIR/index.js"
cp "$SERVER_DIR/lambda/processor/package.json" "$BUILD_DIR/package.json"

# Adjust require paths: index.js was written assuming server/lambda/processor/
# layout (../../config, ../../workers, etc). Inside the zip everything is flat
# at the root (./config, ./workers, ...). Rewrite once during the copy.
sed -i.bak "s|require('\.\./\.\./config/|require('./config/|g;
            s|require('\.\./\.\./workers/|require('./workers/|g;
            s|require('\.\./\.\./utils/|require('./utils/|g;
            s|require('\.\./\.\./models|require('./models|g" "$BUILD_DIR/index.js"
rm -f "$BUILD_DIR/index.js.bak"

mkdir -p "$BUILD_DIR/config" "$BUILD_DIR/models" "$BUILD_DIR/utils" "$BUILD_DIR/workers"
cp "$SERVER_DIR/config/db.js"                  "$BUILD_DIR/config/db.js"
cp "$SERVER_DIR/models/index.js"               "$BUILD_DIR/models/index.js"
cp "$SERVER_DIR/utils/s3.js"                   "$BUILD_DIR/utils/s3.js"
cp "$SERVER_DIR/utils/logger.js"               "$BUILD_DIR/utils/logger.js"
cp "$SERVER_DIR/workers/handler.js"            "$BUILD_DIR/workers/handler.js"

echo "[lambda-build] installing production dependencies"
( cd "$BUILD_DIR" && npm install --omit=dev --no-audit --no-fund --silent )

echo "[lambda-build] creating zip → $OUT_ZIP"

# Cross-platform zip:
#   - prefer `zip` (Linux, macOS, WSL, Git Bash with zip installed)
#   - else fall back to PowerShell's Compress-Archive (default on Windows)
#   - else error with an actionable message
#
# IMPORTANT for Lambda: the zip MUST contain `index.js` at the ROOT of the
# archive, NOT nested inside a `lambda-build/` folder. Both branches below
# zip the *contents* of BUILD_DIR (not the directory itself).
if command -v zip >/dev/null 2>&1; then
  ( cd "$BUILD_DIR" && zip -qr "$OUT_ZIP" . )
elif command -v powershell.exe >/dev/null 2>&1; then
  echo "[lambda-build] (zip not found, using PowerShell Compress-Archive)"
  # Convert MSYS/Git-Bash paths (/f/Dev/...) to Windows paths (F:\Dev\...) so
  # PowerShell can find them. cygpath ships with Git Bash.
  WIN_BUILD_DIR="$(cygpath -w "$BUILD_DIR")"
  WIN_OUT_ZIP="$(cygpath -w "$OUT_ZIP")"
  # -Force overwrites any leftover file; the `\*` glob zips the *contents* of
  # BUILD_DIR so index.js ends up at the archive root (required by Lambda).
  powershell.exe -NoProfile -Command \
    "Compress-Archive -Force -Path '${WIN_BUILD_DIR}\*' -DestinationPath '${WIN_OUT_ZIP}'"
else
  echo "[lambda-build] ERROR: neither 'zip' nor 'powershell.exe' is available." >&2
  echo "[lambda-build]   Install one of:" >&2
  echo "[lambda-build]     - Git Bash users: pacman -S zip   (in MSYS2),   OR" >&2
  echo "[lambda-build]                       choco install zip,            OR" >&2
  echo "[lambda-build]                       run this script from WSL instead." >&2
  exit 1
fi

SIZE=$(du -h "$OUT_ZIP" | cut -f1)
echo "[lambda-build] done — $OUT_ZIP ($SIZE)"
echo "[lambda-build] next: cd infra && sam deploy   (or attach the zip to your existing function)"
