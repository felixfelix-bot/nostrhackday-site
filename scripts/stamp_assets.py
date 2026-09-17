#!/usr/bin/env python3
"""Put a CONTENT-DERIVED build token on every local asset URL.

Why a content hash and not a commit sha: the token must change exactly when the
assets change (so a deploy can never be served as new HTML + hour-old modules),
and it must be checkable without a chicken-and-egg commit. Hashing the token-free
bytes of the local assets gives both — `--check` recomputes it from disk.

    python3 scripts/stamp_assets.py            # stamp
    python3 scripts/stamp_assets.py --check    # exit 1 when the tree is stale
"""
import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# files that carry the token …
STAMPED = ("index.html", "js/signup.js", "js/pow-worker.js")
# … and everything whose bytes define it
ASSETS = (
    "index.html",
    "style.css",
    "js/signup.css",
    "js/signup.js",
    "js/viz.js",
    "js/pow-ratchet.js",
    "js/pow-worker.js",
)

# href="…", src="…", from '…', new Worker('…'  — LOCAL urls only (./x.js, js/x.css,
# style.css); vendor bundles are immutable and versioned by filename.
PATTERN = re.compile(
    r"""(?P<pre>(?:href="|src="|from '|new Worker\('))"""
    r"""(?P<url>(?:\./|js/|style)[^"'?>]*)"""
    r"""(?:\?v=[^"']*)?"""
    r"""(?P<post>["'])"""
)
TOKEN_RE = re.compile(r"\?v=([A-Za-z0-9._-]+)")


def unstamped(text: str) -> str:
    """The token-free form, so the hash does not depend on the token itself."""
    return TOKEN_RE.sub("", text)


def build_token() -> str:
    h = hashlib.sha256()
    for rel in sorted(ASSETS):
        raw = (ROOT / rel).read_text()
        h.update(rel.encode())
        h.update(b"\0")
        h.update(unstamped(raw).encode())
        h.update(b"\0")
    return h.hexdigest()[:10]


def stamped(text: str, token: str) -> str:
    return PATTERN.sub(lambda m: f"{m['pre']}{m['url']}?v={token}{m['post']}", unstamped(text))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    token = build_token()
    stale = []
    for rel in STAMPED:
        path = ROOT / rel
        current = path.read_text()
        wanted = stamped(current, token)
        if args.check:
            have = sorted(set(TOKEN_RE.findall(current)))
            if current != wanted:
                stale.append(f"{rel} (has: {', '.join(have) or 'no token'}, want: {token})")
            continue
        if current != wanted:
            path.write_text(wanted)
            print(f"stamped {rel} -> v={token}")

    if args.check:
        if stale:
            print("STALE build token — an asset changed without re-stamping; run scripts/stamp-assets.sh", file=sys.stderr)
            for line in stale:
                print(f"  {line}", file=sys.stderr)
            return 1
        print(f"build token is current: v={token}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
