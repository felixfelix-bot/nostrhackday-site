#!/usr/bin/env bash
# Deploy nostrhackday-site as an nsite (nsite protocol).
set -euo pipefail
export PATH="$HOME/.deno/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

NSEC=$(nak encode nsec "$(cat "$HOME/.hermes/state/nostrhackday-nsec.key")")
nsyte deploy . --sec "$NSEC" --force --skip-secrets-scan --non-interactive
