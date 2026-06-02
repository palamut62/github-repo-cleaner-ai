#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Release workflow for GitHub Repo Organizer
# Runs the full post-change pipeline in one shot:
#   1. Commit + push the main repo
#   2. Build the Windows installer (electron-builder)
#   3. (Re)create the GitHub release and upload assets
#   4. Update + push the web page (changelog) -> triggers Vercel redeploy
#   5. Launch the freshly built installer so you can install it
#
# Usage:
#   ./release.sh <version> "<commit message>"
#   ./release.sh 2.6.1 "fix: unified status bar"
#
# Notes:
#   - Pass the SAME version that is in package.json. If you bumped the version,
#     update package.json first, then run this.
#   - Re-releasing an existing version deletes the old release + tag first.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VERSION="${1:?Usage: ./release.sh <version> \"<commit message>\"}"
MSG="${2:?Usage: ./release.sh <version> \"<commit message>\"}"

APP_DIR="C:/Users/umuti/Projects/github-repo-cleaner-ai"
WEB_DIR="C:/Users/umuti/Projects/github-repo-cleaner-ai_web_page"
EXE="dist/GitHub Repo Organizer Setup ${VERSION}.exe"

cd "$APP_DIR"

echo "==> [1/5] Commit + push main repo"
git add -A
git commit -m "$MSG" || echo "(nothing to commit)"
git push origin main

echo "==> [2/5] Build Windows installer (v${VERSION})"
npm run build

if [ ! -f "$EXE" ]; then
  echo "ERROR: expected installer not found: $EXE"
  echo "Make sure package.json version matches '${VERSION}'."
  exit 1
fi

echo "==> [3/5] (Re)create GitHub release v${VERSION}"
gh release delete "v${VERSION}" --yes --cleanup-tag 2>/dev/null || true
git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
gh release create "v${VERSION}" \
  "$EXE" \
  "${EXE}.blockmap" \
  "dist/latest.yml" \
  --target main \
  --title "v${VERSION}" \
  --notes "$MSG"

echo "==> [4/5] Update + push web page (changelog)"
# Bump the version string shown on the site if it exists, then push.
cd "$WEB_DIR"
git add -A
git commit -m "docs: sync site for v${VERSION}" || echo "(web: nothing to commit)"
git push origin main

echo "==> [5/5] Launch installer"
cd "$APP_DIR"
cmd.exe /c start "" "GitHub Repo Organizer Setup ${VERSION}.exe"

echo "✅ Release v${VERSION} complete: push, build, release, web, install."
