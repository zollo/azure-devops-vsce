#!/usr/bin/env python3
"""Drop duplicate release-please entries from a changelog.

Pull requests merged with a merge commit show up twice in release-please output: once for
the PR's own commit and once for the merge commit, whose body is the PR title. Both lines
have the same text and differ only in the commit link, for example:

    * add Get Started onboarding wizard ([a59d5ca](https://.../commit/a59d5ca...))
    * add Get Started onboarding wizard ([6c79169](https://.../commit/6c79169...))

This keeps the first of each set of entries whose text (without the trailing commit links)
is the same within one section ("### Added" under one version). Entries in different
versions or sections are left alone, and so is everything that isn't a "* " bullet.

Usage:
    dedupe_changelog.py FILE [FILE ...]   rewrite files in place (line endings kept)
    dedupe_changelog.py -                 filter stdin to stdout
    dedupe_changelog.py --check FILE ...  exit 1 if any file has duplicates
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# One or more trailing release-please commit links: " ([abc1234](https://...))".
_COMMIT_LINKS = re.compile(r"(?:\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\))+\s*$")
_BULLET = re.compile(r"^\*\s+(?P<text>.*)$")


def _entry_key(text: str) -> str:
    # Only the commit links differ between duplicates; compare the rest exactly.
    return _COMMIT_LINKS.sub("", text).rstrip()


def dedupe(content: str) -> tuple[str, int]:
    """Return the content without duplicate entries, and how many lines were dropped."""
    lines = content.splitlines(keepends=True)
    out: list[str] = []
    seen: set[str] = set()
    dropped = 0
    for line in lines:
        body = line.rstrip("\r\n")
        if body.startswith("#"):
            # A new version ("## ") or section ("### ") starts a new scope.
            seen = set()
            out.append(line)
            continue
        match = _BULLET.match(body)
        if match:
            key = _entry_key(match.group("text"))
            if key in seen:
                dropped += 1
                continue
            seen.add(key)
        out.append(line)
    return "".join(out), dropped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", help="changelog files, or - for stdin")
    parser.add_argument("--check", action="store_true", help="report duplicates, don't write")
    args = parser.parse_args(argv)

    found = 0
    for name in args.files:
        if name == "-":
            text, dropped = dedupe(sys.stdin.read())
            sys.stdout.write(text)
            found += dropped
            continue
        path = Path(name)
        # newline="" keeps CRLF line endings as they are.
        with path.open(encoding="utf-8", newline="") as f:
            original = f.read()
        text, dropped = dedupe(original)
        found += dropped
        if dropped:
            print(f"{name}: {dropped} duplicate entr{'y' if dropped == 1 else 'ies'}", file=sys.stderr)
            if not args.check:
                with path.open("w", encoding="utf-8", newline="") as f:
                    f.write(text)
    return 1 if args.check and found else 0


if __name__ == "__main__":
    sys.exit(main())
