#!/usr/bin/env python3
"""Regression tests for set-release-version.py."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("set-release-version.py")
SPEC = importlib.util.spec_from_file_location("set_release_version", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SetReleaseVersionTests(unittest.TestCase):
    def make_repo(self, *, cargo_lock: str | None = None) -> Path:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "scripts").mkdir()
        (root / "src-tauri").mkdir()
        (root / "package.json").write_text('{"name":"onyx","version":"0.5.10"}\n', encoding="utf-8")
        (root / "package-lock.json").write_text(
            json.dumps({"name": "onyx", "version": "0.5.10", "packages": {"": {"version": "0.5.10"}}}),
            encoding="utf-8",
        )
        (root / "src-tauri" / "tauri.conf.json").write_text('{"version":"0.5.10"}\n', encoding="utf-8")
        (root / "src-tauri" / "Cargo.toml").write_text(
            '[package]\nname = "onyx"\nversion = "0.5.10"\n\n[dependencies]\nserde = "1"\n',
            encoding="utf-8",
        )
        (root / "src-tauri" / "Cargo.lock").write_text(
            cargo_lock
            or (
                '[[package]]\nname = "dependency"\nversion = "0.5.10"\n\n'
                '[[package]]\nname = "onyx"\nversion = "0.5.10"\n'
            ),
            encoding="utf-8",
        )
        (root / "scripts" / "verify-release-version.py").write_text(
            "import json,sys,tomllib\n"
            "from pathlib import Path\n"
            "v=sys.argv[1]; r=Path(sys.argv[3])\n"
            "p=json.loads((r/'package.json').read_text())['version']\n"
            "t=json.loads((r/'src-tauri/tauri.conf.json').read_text())['version']\n"
            "c=tomllib.loads((r/'src-tauri/Cargo.toml').read_text())['package']['version']\n"
            "lock=tomllib.loads((r/'src-tauri/Cargo.lock').read_text())\n"
            "matches=[pkg for pkg in lock.get('package', []) if pkg.get('name') == 'onyx']\n"
            "raise SystemExit(0 if p == t == c == v and len(matches) == 1 and matches[0].get('version') == v else 1)\n",
            encoding="utf-8",
        )
        return root

    def test_synchronize_updates_all_version_sources(self):
        root = self.make_repo()
        MODULE.synchronize(root, "0.5.11")
        self.assertEqual(json.loads((root / "package.json").read_text())["version"], "0.5.11")
        lock = json.loads((root / "package-lock.json").read_text())
        self.assertEqual(lock["version"], "0.5.11")
        self.assertEqual(lock["packages"][""]["version"], "0.5.11")
        self.assertIn('version = "0.5.11"', (root / "src-tauri" / "Cargo.toml").read_text())
        cargo_lock = (root / "src-tauri" / "Cargo.lock").read_text()
        self.assertIn('name = "dependency"\nversion = "0.5.10"', cargo_lock)
        self.assertIn('name = "onyx"\nversion = "0.5.11"', cargo_lock)

    def test_prerelease_version_is_rejected_for_store_compatibility(self):
        with self.assertRaises(ValueError):
            MODULE.synchronize(self.make_repo(), "0.5.11-beta.1")

    def test_store_major_overflow_is_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.synchronize(self.make_repo(), "65535.0.0")

    def test_store_component_overflow_is_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.synchronize(self.make_repo(), "0.65536.0")

    def test_failed_verification_rolls_back_partial_writes(self):
        root = self.make_repo(
            cargo_lock='[[package]]\nname = "dependency"\nversion = "0.5.10"\n'
        )
        before = {
            path: path.read_text(encoding="utf-8")
            for path in (
                root / "package.json",
                root / "package-lock.json",
                root / "src-tauri" / "tauri.conf.json",
                root / "src-tauri" / "Cargo.toml",
                root / "src-tauri" / "Cargo.lock",
            )
        }
        with self.assertRaises(ValueError):
            MODULE.synchronize(root, "0.5.11")
        after = {
            path: path.read_text(encoding="utf-8")
            for path in before
        }
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
