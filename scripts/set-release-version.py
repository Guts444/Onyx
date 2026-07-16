#!/usr/bin/env python3
"""Synchronize every authoritative Onyx release-version source."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

VERSION_PATTERN = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
MAX_STORE_COMPONENT = 65535
MAX_STORE_MAJOR = MAX_STORE_COMPONENT - 1  # Store mapping increments SemVer major by 1.


def parse_version(version: str) -> tuple[int, int, int]:
    if VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError("version must use numeric major.minor.patch format")
    major, minor, patch = (int(part) for part in version.split("."))
    if major > MAX_STORE_MAJOR:
        raise ValueError(
            f"major version {major} cannot map to a Store package version "
            f"(maximum major is {MAX_STORE_MAJOR})"
        )
    if minor > MAX_STORE_COMPONENT or patch > MAX_STORE_COMPONENT:
        raise ValueError(
            f"minor and patch components must be <= {MAX_STORE_COMPONENT} for Store packaging"
        )
    return major, minor, patch


def replace_json_version(path: Path, version: str, *, lockfile: bool = False) -> str:
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["version"] = version
    if lockfile:
        packages = payload.get("packages")
        if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
            raise ValueError(f"{path.name} does not contain a root package entry")
        packages[""]["version"] = version
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def replace_toml_package_version(path: Path, version: str, *, array_table: bool) -> str:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    header = "[[package]]" if array_table else "[package]"
    block_starts = [index for index, line in enumerate(lines) if line.strip() == header]
    block_starts.append(len(lines))
    matches: list[int] = []

    for start, end in zip(block_starts, block_starts[1:]):
        if start == len(lines):
            continue
        block = lines[start:end]
        if array_table and not any(line.strip() == 'name = "onyx"' for line in block):
            continue
        for index in range(start + 1, end):
            if re.fullmatch(r'\s*version\s*=\s*"[^"]+"\s*', lines[index].rstrip("\r\n")):
                matches.append(index)
                break
        if not array_table:
            break

    if len(matches) != 1:
        raise ValueError(f"expected exactly one Onyx package version in {path}, found {len(matches)}")

    newline = "\r\n" if lines[matches[0]].endswith("\r\n") else "\n"
    lines[matches[0]] = f'version = "{version}"{newline}'
    return "".join(lines)


def synchronize(root: Path, version: str) -> None:
    parse_version(version)

    updates = {
        root / "package.json": replace_json_version(root / "package.json", version),
        root / "package-lock.json": replace_json_version(
            root / "package-lock.json", version, lockfile=True
        ),
        root / "src-tauri" / "tauri.conf.json": replace_json_version(
            root / "src-tauri" / "tauri.conf.json", version
        ),
        root / "src-tauri" / "Cargo.toml": replace_toml_package_version(
            root / "src-tauri" / "Cargo.toml", version, array_table=False
        ),
        root / "src-tauri" / "Cargo.lock": replace_toml_package_version(
            root / "src-tauri" / "Cargo.lock", version, array_table=True
        ),
    }

    originals = {path: path.read_bytes() for path in updates}
    written: list[Path] = []
    try:
        for path, content in updates.items():
            path.write_text(content, encoding="utf-8", newline="")
            written.append(path)

        verifier = root / "scripts" / "verify-release-version.py"
        result = subprocess.run(
            [sys.executable, str(verifier), version, "--root", str(root)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise ValueError(result.stderr.strip() or "release metadata verification failed")
    except Exception:
        for path in written:
            path.write_bytes(originals[path])
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="new numeric SemVer version, for example 0.5.11")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    try:
        synchronize(args.root.resolve(), args.version)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Release version update failed: {error}", file=sys.stderr)
        return 1
    print(f"Synchronized Onyx release metadata to {args.version}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
