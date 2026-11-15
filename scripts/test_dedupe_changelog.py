"""Tests for dedupe_changelog.py. Run with: python3 -m unittest discover -s scripts"""

import unittest

from dedupe_changelog import dedupe

URL = "https://github.com/zollo/azure-devops-vsce/commit/"


def entry(text: str, sha: str) -> str:
    return f"* {text} ([{sha[:7]}]({URL}{sha}))"


class DedupeTest(unittest.TestCase):
    def test_drops_merge_commit_duplicate_and_keeps_first(self):
        content = "\r\n".join([
            "## [0.5.0](https://example/compare) (2026-11-14)",
            "",
            "### Added",
            "",
            entry("show What's New", "e7cfd2e3d65c1a41f7b4522a832fe5445147d1f5"),
            entry("show What's New", "8d1a2d6e4e29cac22f744fb91e6b5db36fb4ce1b"),
            "",
            "### Fixed",
            "",
            entry("**ci:** don't fail", "a19f9405c9a72c348c6f19aba9ef2a8666ec89c7"),
            entry("**ci:** don't fail", "1d85980ee69649cf4a853c3bc8b432f96c77dfb6"),
            entry("honour the requested view", "49108f3045bd94cc77bd5ca506f2293fbd2ee6b3"),
            "",
        ])
        result, dropped = dedupe(content)
        self.assertEqual(dropped, 2)
        self.assertIn("e7cfd2e", result)
        self.assertNotIn("8d1a2d6", result)
        self.assertIn("a19f940", result)
        self.assertNotIn("1d85980", result)
        self.assertIn("49108f3", result)
        self.assertNotIn("\n", result.replace("\r\n", ""))  # CRLF kept

    def test_same_text_in_other_section_or_version_is_kept(self):
        content = "\n".join([
            "## [0.2.0]",
            "### Added",
            entry("thing", "1111111aaaaaaa"),
            "### Fixed",
            entry("thing", "2222222bbbbbbb"),
            "## [0.1.0]",
            "### Fixed",
            entry("thing", "3333333ccccccc"),
            "",
        ])
        result, dropped = dedupe(content)
        self.assertEqual(dropped, 0)
        self.assertEqual(result, content)

    def test_hand_written_entries_and_text_are_untouched(self):
        content = "### Added\n- same\n- same\nplain\nplain\n"
        self.assertEqual(dedupe(content), (content, 0))

    def test_different_scopes_are_different_entries(self):
        content = "### Fixed\n" + entry("**a:** x", "1111111") + "\n" + entry("**b:** x", "2222222") + "\n"
        self.assertEqual(dedupe(content)[1], 0)

    def test_entries_differing_only_by_case_are_kept(self):
        content = "### Fixed\n" + entry("handle System.State", "1111111") + "\n" + entry("handle system.state", "2222222") + "\n"
        self.assertEqual(dedupe(content)[1], 0)


if __name__ == "__main__":
    unittest.main()
