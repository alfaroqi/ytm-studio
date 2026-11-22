#!/usr/bin/env bash
set -euo pipefail

# Build script for YTM Studio (Themes, Synced Lyrics & Adblock for YouTube Music)
# Produces browser-specific packages in ./dist:
#   - Chrome / Edge / Brave (.zip)
#   - Firefox (.xpi)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DIST_DIR="$SCRIPT_DIR/dist"
STAGE_DIR="$DIST_DIR/.stage"

# Detect Python (used for JSON manipulation & cross-platform zipping)
if command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON="python"
else
  echo "[ERROR] Python 3 is required to run this build script." >&2
  exit 1
fi

# Optional JS syntax validation & unit tests if Node.js is installed
if command -v node >/dev/null 2>&1; then
  echo "[1/4] Checking JavaScript syntax & running unit tests..."
  node --check adblock-main.js
  node --check background.js
  node --check content.js
  node --check popup.js
  if [ -f "tests/extension.test.js" ]; then
    node --test tests/extension.test.js
  fi
else
  echo "[1/4] Node.js not found; skipping JS syntax check and unit tests."
fi

VERSION="$("$PYTHON" -c 'import json; print(json.load(open("manifest.json"))["version"])')"
echo "[2/4] Preparing dist/ for version v${VERSION}..."
rm -rf "$DIST_DIR"
mkdir -p "$STAGE_DIR/chrome" "$STAGE_DIR/firefox"

FILES=(
  "adblock-main.js"
  "background.js"
  "content.js"
  "popup.html"
  "popup.js"
  "styles.css"
)

copy_assets() {
  local target="$1"
  for f in "${FILES[@]}"; do
    cp "$f" "$target/"
  done
  cp -r icons "$target/icons"
  cp -r rules "$target/rules"
}

copy_assets "$STAGE_DIR/chrome"
copy_assets "$STAGE_DIR/firefox"

echo "[3/4] Generating browser-specific manifests..."
"$PYTHON" - "$STAGE_DIR" <<'PYEOF'
import json, os, sys

stage = sys.argv[1]
with open("manifest.json", "r", encoding="utf-8") as f:
    base = json.load(f)

# Chrome MV3 manifest (service_worker only, no Gecko keys)
chrome_manifest = json.loads(json.dumps(base))
chrome_manifest.pop("browser_specific_settings", None)
if "background" in chrome_manifest:
    chrome_manifest["background"].pop("scripts", None)

with open(os.path.join(stage, "chrome", "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(chrome_manifest, f, indent=2)
    f.write("\n")

# Firefox MV3 manifest (injects background.scripts + gecko settings)
firefox_manifest = json.loads(json.dumps(base))
firefox_manifest["background"] = {"scripts": ["background.js"]}
firefox_manifest["browser_specific_settings"] = {
    "gecko": {
        "id": "ytm-studio@local.dev",
        "strict_min_version": "128.0",
    }
}

with open(os.path.join(stage, "firefox", "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(firefox_manifest, f, indent=2)
    f.write("\n")
PYEOF

echo "[4/4] Packaging archives..."
CHROME_OUT="$DIST_DIR/ytm-studio-chrome-v${VERSION}.zip"
FIREFOX_OUT="$DIST_DIR/ytm-studio-firefox-v${VERSION}.xpi"

"$PYTHON" - "$STAGE_DIR/chrome" "$CHROME_OUT" "$STAGE_DIR/firefox" "$FIREFOX_OUT" <<'PYEOF'
import os, sys, zipfile

def zip_dir(src_dir, out_file):
    with zipfile.ZipFile(out_file, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, _, files in os.walk(src_dir):
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src_dir).replace("\\", "/")
                zf.write(full, rel)

zip_dir(sys.argv[1], sys.argv[2])
zip_dir(sys.argv[3], sys.argv[4])
PYEOF

rm -rf "$STAGE_DIR"

echo ""
echo "Build complete!"
echo "  Chrome  : $CHROME_OUT"
echo "  Firefox : $FIREFOX_OUT"
