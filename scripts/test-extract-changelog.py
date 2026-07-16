#!/usr/bin/env python3
"""Regression tests for extract-changelog.py."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("extract-changelog.py")
SPEC = importlib.util.spec_from_file_location("extract_changelog", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExtractChangelogTests(unittest.TestCase):
    def test_extracts_only_requested_section_with_crlf_input(self):
        changelog = (
            "# Changelog\r\n\r\n"
            "## v0.5.11 - 2026-07-20\r\n\r\n- New fix.\r\n\r\n"
            "## v0.5.10 - 2026-07-15\r\n\r\n- Store release.\r\n"
        )
        self.assertEqual(MODULE.extract(changelog, "0.5.11"), "- New fix.\n")

    def test_missing_version_fails_closed(self):
        with self.assertRaises(ValueError):
            MODULE.extract("# Changelog\n", "0.5.11")

    def test_empty_section_fails_closed(self):
        with self.assertRaises(ValueError):
            MODULE.extract("## v0.5.11\n\n## v0.5.10\n- Older\n", "0.5.11")

    def test_duplicate_sections_fail_closed(self):
        with self.assertRaises(ValueError):
            MODULE.extract(
                "## v0.5.11\n- First\n\n## v0.5.11\n- Second\n\n## v0.5.10\n- Older\n",
                "0.5.11",
            )


if __name__ == "__main__":
    unittest.main()
