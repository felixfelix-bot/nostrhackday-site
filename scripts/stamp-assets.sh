#!/usr/bin/env bash
# Stamp the build token onto every local JS/CSS URL in the site.
#
# Why: the nsite gateway serves with `cache-control: public, max-age=3600` and
# GitHub Pages with `max-age=600`, and browsers key ES modules by URL. Without a
# token a deploy can be served as NEW html + HOUR-OLD js — which is how the
# pulled fingerprint grid came back for one visitor (2026-09-17).
#
# The token is derived from the CONTENT of the local assets, so it changes
# exactly when something changes and needs no commit-sha bookkeeping.
#
#   scripts/stamp-assets.sh            # stamp (idempotent)
#   scripts/stamp-assets.sh --check    # exit 1 when the tree is stale
set -euo pipefail
cd "$(dirname "$0")/.."

exec python3 scripts/stamp_assets.py "$@"
