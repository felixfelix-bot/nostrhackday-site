#!/usr/bin/env python3
"""Normalise a vendored esm.sh tree for static hosting.

Two problems with raw esm.sh mirror filenames:

1. esm.sh URL paths such as `/@noble/hashes@^2.2.0/sha2` are not URL-safe in a
   path segment (`^`) and the file has no JS extension, so static hosts may
   serve it with the wrong MIME type and the browser refuses to execute it.
2. Every importer refers to those files by the old name.

This pass renames offending files (`^` -> `_`, extensionless -> `.js`) and
rewrites every relative import specifier that pointed at an old name, so the
tree stays a self-consistent, offline import graph.

Usage: fixup_vendor.py <vendor-tree-root>
Prints one line per renamed file plus a summary.
"""
import os
import re
import sys

SAFE = re.compile(r"^[A-Za-z0-9@._-]+$")
HAS_EXT = re.compile(r"\.(mjs|js|cjs)$")
SPEC = re.compile(r"""(["'])(\.{1,2}/[^"']+)\1""")


def sanitize_segments(parts):
    """Only the filename gets an extension; `^` is replaced in every segment
    (esm.sh emits directories such as `@noble/hashes@^2.2.0`)."""
    dirs = [p.replace("^", "_") for p in parts[:-1]]
    last = parts[-1].replace("^", "_")
    if not HAS_EXT.search(last):
        last += ".js"
    return dirs + [last]


def main() -> int:
    root = os.path.abspath(sys.argv[1])
    files = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            files.append(os.path.join(dirpath, fn))

    renames = {}
    for old in files:
        rel = os.path.relpath(old, root)
        parts = rel.split(os.sep)
        new_parts = sanitize_segments(parts)
        new = os.path.join(root, *new_parts)
        if new != old:
            renames[old] = new

    for old, new in renames.items():
        os.makedirs(os.path.dirname(new), exist_ok=True)
        os.rename(old, new)
        print(f"renamed {os.path.relpath(old, root)} -> {os.path.relpath(new, root)}")

    # rewrite specifiers in every text file
    changed = 0
    all_files = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            all_files.append(os.path.join(dirpath, fn))

    for path in all_files:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except (UnicodeDecodeError, IsADirectoryError):
            continue
        original = text
        for old, new in renames.items():
            for variant_old, variant_new in ((old, new),):
                old_spec = os.path.relpath(variant_old, os.path.dirname(path))
                new_spec = os.path.relpath(variant_new, os.path.dirname(path))
                if not old_spec.startswith("."):
                    old_spec = "./" + old_spec
                if not new_spec.startswith("."):
                    new_spec = "./" + new_spec
                for quote in ('"', "'"):
                    text = text.replace(f"{quote}{old_spec}{quote}", f"{quote}{new_spec}{quote}")
        if text != original:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            changed += 1
    print(f"rewrote specifiers in {changed} file(s); {len(renames)} rename(s)")

    # sanity: no unsafe path segment left
    bad = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            for part in rel.split(os.sep):
                if not SAFE.match(part):
                    bad.append(rel)
    if bad:
        print("UNSAFE REMAINING:", bad)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
