#!/usr/bin/env python3
"""Low-noise secret scanner for tracked files and generated package artifacts."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
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
ASSIGNMENT_PLACEHOLDERS = frozenset({
    "changeme-changeme-changeme",
    "example-placeholder-not-a-secret",
    "placeholder-placeholder",
    "plain-text-password-marker",
    "redacted-redacted-redacted",
    "https://provider.test/guide.xml?token=top-secret",
    "https://" "user:password@provider.test/guide.xml?token=top-secret",
    "your_api_key_goes_here",
    "your-password-goes-here",
})
URL_PLACEHOLDER_CREDENTIALS = frozenset({
    "http://" "alice:s3cret@tv.example",
    "http://" "alice:secret@tv",
    "https://" "${redacted}:${redacted}@provider.example",
    "https://" "art-user:art-pass@provider.example",
    "https://" "new-login:new-userinfo-secret@provider.example",
    "https://" "new:secret@example.com",
    "https://" "old-login:old-userinfo-secret@provider.example",
    "https://" "old-user:old-pass@provider.example",
    "https://" "stream-user:stream-pass@provider.example",
    "https://" "user:p%40ss@provider.example",
    "https://" "user:pass@legacy.example",
    "https://" "user:password@[",
    "https://" "user:password@example.com",
    "https://" "user:password@secret.example",
    "https://" "viewer:secret@provider.example",
    "https://" "viewer:super-secret@provider.example",
})
STRUCTURED_RULES = frozenset({
    "private-key", "github-token", "github-fine-grained-token", "npm-token",
    "google-api-key", "aws-access-key", "slack-token", "stripe-live-key",
})


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


def normalized_placeholder(value: str) -> str:
    return value.strip().lower()


def is_test_file(path: Path) -> bool:
    lowered = path.as_posix().lower()
    name = path.name.lower()
    return (
        "/test/" in f"/{lowered}/"
        or "/tests/" in f"/{lowered}/"
        or "/fixtures/" in f"/{lowered}/"
        or name.startswith("test_")
        or ".test." in name
        or ".spec." in name
    )


def credential_parts(candidate: str) -> tuple[str, str, str]:
    try:
        parsed = urlsplit(candidate)
        return parsed.username or "", parsed.password or "", (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        match = re.match(r"^[A-Za-z]+://([^:@/]+):([^@/]+)@", candidate)
        return (match.group(1), match.group(2), "") if match else ("", "", "")


def suppress_finding(rule: Rule, candidate: str, fixture_context: bool) -> bool:
    if rule.name in STRUCTURED_RULES:
        return False
    if rule.name == "secret-assignment":
        return normalized_placeholder(candidate) in ASSIGNMENT_PLACEHOLDERS
    if rule.name == "credential-url" and fixture_context:
        _, _, hostname = credential_parts(candidate)
        reserved_host = hostname.endswith(".invalid") or hostname.endswith(".test")
        exact_placeholder = candidate.lower() in URL_PLACEHOLDER_CREDENTIALS
        return reserved_host or exact_placeholder
    return False


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
        lines = text.splitlines()
        rust_test_start = next(
            (number for number, source_line in enumerate(lines, 1) if source_line.strip() == "#[cfg(test)]"),
            None,
        ) if path.suffix.lower() == ".rs" else None
        for line_number, line in enumerate(lines, 1):
            fixture_context = is_test_file(path) or (
                rust_test_start is not None and line_number > rust_test_start
            )
            for rule in RULES:
                for match in rule.pattern.finditer(line):
                    candidate = match.group(1) if rule.name == "secret-assignment" else match.group(0)
                    if suppress_finding(rule, candidate, fixture_context):
                        continue
                    found.append((display, rule.name, line_number))
                    break
    return sorted(set(found))


def report_findings(detected: Iterable[tuple[str, str, int]]) -> None:
    for path, rule, line in detected:
        print(f"{path}:{line}: potential secret ({rule}); value suppressed", file=sys.stderr)


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
        report_findings(detected)
        print(f"Secret scan failed with {len(detected)} finding(s).", file=sys.stderr)
        return 1
    print(f"Secret scan passed ({len(list(expand_paths(requested)))} candidate files; binary/large files skipped).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
