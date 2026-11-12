#!/usr/bin/env bash
# Deploys the landing page (this folder only) to the Vercel project nearprivacyrings-site.
# It copies the folder outside the git repo first: run from inside the repo, the Vercel CLI
# uploads the whole repository and builds it with the root vercel.json (the app).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$here"/index.html "$here"/poster.jpg "$here"/walkthrough.mp4 "$here"/vercel.json "$tmp"/
mkdir -p "$tmp/.vercel" && cp "$here/.vercel/project.json" "$tmp/.vercel/"
cd "$tmp" && npx --yes vercel@65.14.0 deploy --prod --yes
