#!/usr/bin/env python3
"""Low-noise secret scanner for tracked files and generated package artifacts."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

MAX_FILE_BYTES = 8 * 1024 * 1024
TEXT_SUFFIXES = {
    ".c", ".conf", ".config", ".css", ".csv", ".env", ".h", ".html", ".ini",
    ".js", ".json", ".jsx", ".log", ".md", ".mjs", ".ps1", ".py", ".rs",
    ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
DEFAULT_GENERATED = ("dist", "config", "state", "cache")
PLACEHOLDER_WORDS = (
    ".example", ".invalid", ".test", "@[", "@tv", "changeme", "dummy", "example", "fake", "marker",
    "placeholder", "plain-text", "redacted", "sample", "sentinel", "test-only", "top-secret",
    "your_", "your-", "xxxx",
)


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]


RULES = (
    Rule("private-key", re.compile(r"-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----")),
    Rule("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b")),
    Rule("github-fine-grained-token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,255}\b")),
    Rule("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    Rule("google-api-key", re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b")),
    Rule("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    Rule("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    Rule("stripe-live-key", re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b")),
    Rule("credential-url", re.compile(r"\b(?:https?|rtsp)://[^\s/'\"<>:@]{1,128}:[^\s/'\"<>@]{4,128}@[^\s/'\"<>:]+", re.IGNORECASE)),
    Rule(
        "secret-assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|client[_-]?secret|password|passwd|secret|access[_-]?token)\b"
            r"\s*[:=]\s*['\"]([^'\"\r\n]{20,})['\"]"
        ),
    ),
)


def repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True
    )
    return Path(result.stdout.strip()).resolve()


def tracked_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
    )
    return [root / name.decode("utf-8", "surrogateescape") for name in result.stdout.split(b"\0") if name]


def expand_paths(paths: Iterable[Path]) -> Iterable[Path]:
    seen: set[Path] = set()
    for path in paths:
        path = path.resolve()
        candidates = path.rglob("*") if path.is_dir() else (path,)
        for candidate in candidates:
            if candidate.is_file() and candidate not in seen:
                seen.add(candidate)
                yield candidate


def read_text(path: Path) -> str | None:
    try:
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            return None
        data = path.read_bytes()
    except OSError as error:
        print(f"error: cannot read {path}: {error}", file=sys.stderr)
        return None
    if b"\0" in data[:8192]:
        return None
    if path.suffix.lower() not in TEXT_SUFFIXES:
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return None
    return data.decode("utf-8", errors="replace")


def is_placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(word in lowered for word in PLACEHOLDER_WORDS) or len(set(value)) < 5


def findings(paths: Iterable[Path], display_root: Path) -> list[tuple[str, str, int]]:
    found: list[tuple[str, str, int]] = []
    for path in expand_paths(paths):
        text = read_text(path)
        if text is None:
            continue
        try:
            display = path.relative_to(display_root).as_posix()
        except ValueError:
            display = path.name
        for line_number, line in enumerate(text.splitlines(), 1):
            for rule in RULES:
                for match in rule.pattern.finditer(line):
                    candidate = match.group(1) if rule.name == "secret-assignment" else match.group(0)
                    if is_placeholder(candidate):
                        continue
                    found.append((display, rule.name, line_number))
                    break
    return sorted(set(found))


def self_test() -> int:
    pieces = {
        "key": "-----BEGIN " + "PRIVATE KEY-----\nnot-a-real-key\n",
        "token": "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        "url": "https://build-user:" + "SyntheticPassphrase42" + "@scan-fixture.localhost/feed",
        "safe": "api_key = 'example-placeholder-not-a-secret'\nhttps://example.invalid/feed\n",
    }
    with tempfile.TemporaryDirectory(prefix="onyx-secret-scan-") as directory:
        root = Path(directory)
        for name, value in pieces.items():
            (root / f"{name}.txt").write_text(value, encoding="utf-8")
        detected = findings(root.glob("*.txt"), root)
    rules = {rule for _, rule, _ in detected}
    expected = {"private-key", "github-token", "credential-url"}
    if rules != expected or any(path == "safe.txt" for path, _, _ in detected):
        print("Secret scanner self-test failed (fixture values suppressed).", file=sys.stderr)
        return 1
    print("Secret scanner self-test passed (3 synthetic leak classes detected; values suppressed).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="additional files/directories to scan")
    parser.add_argument("--no-tracked", action="store_true", help="do not scan Git-tracked files")
    parser.add_argument("--self-test", action="store_true", help="run safe synthetic regression fixtures")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    root = repo_root()
    requested: list[Path] = [] if args.no_tracked else tracked_files(root)
    for generated in DEFAULT_GENERATED:
        candidate = root / generated
        if candidate.exists():
            requested.append(candidate)
    requested.extend((root / path if not Path(path).is_absolute() else Path(path)) for path in args.paths)
    detected = findings(requested, root)
    if detected:
        for path, rule, line in detected:
            print(f"{path}:{line}: potential secret ({rule}); value suppressed", file=sys.stderr)
        print(f"Secret scan failed with {len(detected)} finding(s).", file=sys.stderr)
        return 1
    print(f"Secret scan passed ({len(list(expand_paths(requested)))} candidate files; binary/large files skipped).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
