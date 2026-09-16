#!/usr/bin/env python3
"""Fetch-time vendoring of esm.sh modules into a self-contained, offline tree.

Not a bundler: it mirrors esm.sh's own pre-bundled output (`.bundle.mjs`) and
rewrites every module specifier to a relative local path, so the result is
plain ESM with no network dependency at runtime.

Handles two specifier shapes esm.sh emits:
  * absolute server paths:  "/nostr-tools@2.23.3/es2022/pure.bundle.mjs"
  * bare sibling files in its /node/* shims:  "events.mjs"

Usage: python3 vendor_esm.py /out/dir <server-path> [<server-path> ...]
"""
import os
import re
import sys
import urllib.request
import pathlib

BASE = "https://esm.sh"
# absolute esm.sh module paths (skips "/" alone, regexes, data urls)
ABS_SPEC = re.compile(r'(["\'])(/[A-Za-z0-9@][A-Za-z0-9@._^~/?=&%-]*)\1')
# bare sibling module specifiers, e.g. inside esm.sh's /node/process.mjs
BARE_SPEC = re.compile(r'(["\'`])([A-Za-z0-9._-]+\.mjs)\1')


def main():
    root = pathlib.Path(sys.argv[1]).resolve()
    entries = sys.argv[2:]
    fetched, seen, failed = [], set(), []

    def local_for(url_path: str) -> pathlib.Path:
        return root / url_path.lstrip("/").split("?")[0]

    def fetch(url_path: str) -> pathlib.Path:
        p = local_for(url_path)
        if url_path in seen:
            return p
        seen.add(url_path)
        try:
            with urllib.request.urlopen(BASE + url_path, timeout=90) as r:
                text = r.read().decode("utf-8")
        except Exception as e:  # pragma: no cover
            failed.append((url_path, str(e)))
            print(f"  !! FAILED {BASE + url_path}: {e}")
            return p

        base_dir = url_path.rsplit("/", 1)[0] if "/" in url_path else ""

        def resolve(spec: str) -> str:
            return spec if spec.startswith("/") else f"{base_dir}/{spec}"

        deps = {m.group(2) for m in ABS_SPEC.finditer(text)}
        deps |= {resolve(m.group(2)) for m in BARE_SPEC.finditer(text) if not m.group(2).startswith(".")}

        for rx in (ABS_SPEC, BARE_SPEC):
            def repl(m, rx=rx):
                spec = m.group(2)
                if not spec.startswith("/") and spec.startswith("."):
                    return m.group(0)
                rel = os.path.relpath(local_for(resolve(spec)), p.parent)
                if not rel.startswith("."):
                    rel = "./" + rel
                return f"{m.group(1)}{rel}{m.group(1)}"
            text = rx.sub(repl, text)

        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        fetched.append((url_path, len(text)))
        for d in sorted(deps):
            fetch(d)
        return p

    for e in entries:
        fetch(e)

    print(f"fetched {len(fetched)} files into {root}; {len(failed)} failed")
    for url_path, size in sorted(fetched, key=lambda x: -x[1]):
        print(f"  {size:>9}  {url_path}")


if __name__ == "__main__":
    main()
