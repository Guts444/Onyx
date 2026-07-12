#!/usr/bin/env python3
"""Regression tests for scan-repository-secrets.py."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("scan-repository-secrets.py")
SPEC = importlib.util.spec_from_file_location("secret_scanner", SCRIPT)
assert SPEC and SPEC.loader
scanner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scanner
SPEC.loader.exec_module(scanner)


class SecretScannerTests(unittest.TestCase):
    def scan(self, name: str, content: str):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / name
            path.write_text(content, encoding="utf-8")
            return scanner.findings([path], root)

    def test_structured_github_token_containing_fake_is_detected(self):
        token = "ghp_" + "A" * 10 + "fake" + "B" * 22
        self.assertEqual(self.scan("fixture.txt", token), [("fixture.txt", "github-token", 1)])

    def test_assignment_containing_example_is_detected(self):
        value = "correct-horse-" + "example-battery-staple"
        self.assertEqual(
            self.scan("settings.txt", f'password = "{value}"'),
            [("settings.txt", "secret-assignment", 1)],
        )

    def test_exact_assignment_placeholder_is_allowed(self):
        self.assertEqual(
            self.scan("settings.txt", 'api_key = "example-placeholder-not-a-secret"'),
            [],
        )

    def test_reserved_host_credential_url_is_allowed_only_in_test_file(self):
        fixture = "https://" + "fixture-user:fixture-password@service.invalid/feed"
        self.assertEqual(self.scan("client.test.ts", fixture), [])
        self.assertEqual(
            self.scan("production.ts", fixture),
            [("production.ts", "credential-url", 1)],
        )

    def test_exact_url_credentials_are_allowed_only_in_test_file(self):
        fixture = "https://" + "viewer:super-secret@provider.example/feed"
        self.assertEqual(self.scan("client.test.ts", fixture), [])
        self.assertEqual(
            self.scan("production.ts", fixture),
            [("production.ts", "credential-url", 1)],
        )

    def test_real_host_credential_url_is_detected_even_in_test_file(self):
        fixture = "https://" + "fixture-user:fixture-password@api.example.com/feed"
        self.assertEqual(
            self.scan("client.test.ts", fixture),
            [("client.test.ts", "credential-url", 1)],
        )

    def test_subprocess_report_does_not_reveal_secret_value(self):
        sensitive_value = "correct-horse-" + "example-battery-staple"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "settings.txt"
            fixture.write_text(f'password = "{sensitive_value}"', encoding="utf-8")
            subprocess.run(
                ["git", "init", "-q"], cwd=root, check=True, capture_output=True, text=True
            )
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--no-tracked", str(fixture)],
                cwd=root,
                check=False,
                capture_output=True,
                text=True,
            )

        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1)
        self.assertIn("potential secret (secret-assignment)", output)
        self.assertNotIn(sensitive_value, output)
        self.assertIn("value suppressed", output)


if __name__ == "__main__":
    unittest.main()
