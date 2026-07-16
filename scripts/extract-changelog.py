#!/usr/bin/env python3
"""Extract one version's curated GitHub release notes from CHANGELOG.md."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def extract(changelog: str, version: str) -> str:
    heading = re.compile(rf"^## v{re.escape(version)}(?:\s+-[^\r\n]*)?\s*$", re.MULTILINE)
    matches = list(heading.finditer(changelog))
    if not matches:
        raise ValueError(f"CHANGELOG.md has no v{version} section")
    if len(matches) != 1:
        raise ValueError(f"CHANGELOG.md has {len(matches)} v{version} sections; expected exactly one")
    match = matches[0]
    next_heading = re.search(r"^## \S.*$", changelog[match.end() :], re.MULTILINE)
    end = match.end() + next_heading.start() if next_heading else len(changelog)
    notes = changelog[match.end() : end].strip()
    if not notes:
        raise ValueError(f"CHANGELOG.md v{version} section is empty")
    return notes + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="numeric version without the leading v")
    parser.add_argument("--changelog", type=Path, default=Path("CHANGELOG.md"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        notes = extract(args.changelog.read_text(encoding="utf-8"), args.version)
        if args.output:
            args.output.write_text(notes, encoding="utf-8")
        else:
            sys.stdout.write(notes)
    except (OSError, ValueError) as error:
        print(f"Release-note extraction failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
