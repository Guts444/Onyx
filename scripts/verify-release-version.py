#!/usr/bin/env python3
"""Verify that a requested release version matches every release metadata source."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

VERSION_PATTERN = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
def canonicalize(requested: str) -> str:
    version = requested[1:] if requested.startswith("v") else requested
    if VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError(f"invalid release version: {requested!r}")
    return version


def load_versions(root: Path) -> dict[str, str]:
    package_path = root / "package.json"
    package_lock_path = root / "package-lock.json"
    cargo_path = root / "src-tauri" / "Cargo.toml"
    cargo_lock_path = root / "src-tauri" / "Cargo.lock"
    tauri_path = root / "src-tauri" / "tauri.conf.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package_lock = json.loads(package_lock_path.read_text(encoding="utf-8"))
    with cargo_path.open("rb") as handle:
        cargo = tomllib.load(handle)
    with cargo_lock_path.open("rb") as handle:
        cargo_lock = tomllib.load(handle)
    tauri = json.loads(tauri_path.read_text(encoding="utf-8"))
    root_lock_package = package_lock.get("packages", {}).get("", {})
    cargo_lock_matches = [
        entry for entry in cargo_lock.get("package", []) if entry.get("name") == "onyx"
    ]
    if len(cargo_lock_matches) != 1:
        raise ValueError(
            f"src-tauri/Cargo.lock must contain exactly one Onyx package, found {len(cargo_lock_matches)}"
        )
    return {
        "package.json": str(package.get("version", "")),
        "package-lock.json": str(package_lock.get("version", "")),
        "package-lock.json root package": str(root_lock_package.get("version", "")),
        "src-tauri/Cargo.toml": str(cargo.get("package", {}).get("version", "")),
        "src-tauri/Cargo.lock": str(cargo_lock_matches[0].get("version", "")),
        "src-tauri/tauri.conf.json": str(tauri.get("version", "")),
    }


def verify(requested: str, root: Path) -> str:
    canonical = canonicalize(requested)
    versions = load_versions(root)
    mismatches = {source: value for source, value in versions.items() if value != canonical}
    if mismatches:
        details = ", ".join(f"{source}={value!r}" for source, value in mismatches.items())
        raise ValueError(f"release version {canonical!r} does not match {details}")
    return canonical


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="release version or tag (for example, v0.5.8)")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    try:
        canonical = verify(args.version, args.root.resolve())
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError, tomllib.TOMLDecodeError) as error:
        print(f"Release version verification failed: {error}", file=sys.stderr)
        return 1
    print(canonical)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
