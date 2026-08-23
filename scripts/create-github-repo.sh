#!/usr/bin/env bash
set -euo pipefail
# Push j-rides to GitHub (run locally with gh auth or GIT token)

REPO="${1:-sagasinsert3a/j-rides}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git init -b main 2>/dev/null || git checkout -B main
git add -A
git commit -m "J Rides booking site — Stripe, alerts, VistaPrint cards" || true
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$REPO.git"
git push -u origin main --force
