#!/usr/bin/env python3
"""Regression tests for verify-release-version.py."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("verify-release-version.py")


class ReleaseVersionTests(unittest.TestCase):
    def make_repo(self, version: str = "0.5.8") -> Path:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "src-tauri").mkdir()
        (root / "package.json").write_text(f'{{"version":"{version}"}}', encoding="utf-8")
        (root / "src-tauri" / "Cargo.toml").write_text(
            f'[package]\nname = "onyx"\nversion = "{version}"\n', encoding="utf-8"
        )
        (root / "src-tauri" / "tauri.conf.json").write_text(
            f'{{"version":"{version}"}}', encoding="utf-8"
        )
        (root / "Build Onyx Release.cmd").write_text(
            f'@echo off\nset "VERSION={version}"\n', encoding="utf-8"
        )
        return root

    def run_script(self, requested: str, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), requested, "--root", str(root)],
            capture_output=True,
            text=True,
        )

    def test_leading_v_is_stripped_and_canonical_version_is_printed(self):
        result = self.run_script("v0.5.8", self.make_repo())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0.5.8")

    def test_metadata_mismatch_fails(self):
        root = self.make_repo()
        (root / "src-tauri" / "tauri.conf.json").write_text('{"version":"0.5.7"}', encoding="utf-8")
        result = self.run_script("0.5.8", root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tauri.conf.json", result.stderr)

    def test_shell_metacharacters_are_rejected(self):
        result = self.run_script("0.5.8;Write-Host-pwned", self.make_repo())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid release version", result.stderr.lower())

    def test_duplicate_build_script_versions_fail(self):
        root = self.make_repo()
        (root / "Build Onyx Release.cmd").write_text(
            '@echo off\nset "VERSION=0.5.8"\nset "VERSION=0.5.8"\n', encoding="utf-8"
        )
        result = self.run_script("0.5.8", root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Build Onyx Release.cmd", result.stderr)

    def test_missing_build_script_version_fails(self):
        root = self.make_repo()
        (root / "Build Onyx Release.cmd").write_text("@echo off\n", encoding="utf-8")
        result = self.run_script("0.5.8", root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Build Onyx Release.cmd", result.stderr)


if __name__ == "__main__":
    unittest.main()
