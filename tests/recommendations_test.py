import contextlib
import io
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest.mock import patch


class RecommendationsTest(unittest.TestCase):
    def setUp(self):
        with patch.dict(sys.modules, {"yt_dlp": types.ModuleType("yt_dlp")}):
            self.pages = runpy.run_path(str(Path(__file__).parents[1] / "scripts/recommendations.py"))["pages"]

    def test_reads_only_requested_pages_without_draining_continuation(self):
        consumed = []
        calls = []

        def entries():
            for i in range(50):
                consumed.append(i)
                yield {"id": str(i), "title": "Video"}

        def extract_info(url, **options):
            self.assertFalse(options["process"])
            calls.append(url)
            return {"entries": entries()}

        def commands():
            yield "next\n"
            self.assertEqual(len(consumed), 24)
            yield "next\n"
            self.assertEqual(len(consumed), 48)
            yield "next\n"
            self.assertEqual(len(consumed), 50)

        output = io.StringIO()
        with patch.object(sys, "stdin", commands()), contextlib.redirect_stdout(output):
            self.pages(types.SimpleNamespace(extract_info=extract_info))
        import json
        pages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([len(p["videos"]) for p in pages], [24, 24, 2])
        self.assertEqual([p["hasMore"] for p in pages], [True, True, False])
        self.assertEqual(len(calls), 1)

    def test_extractor_errors_do_not_expose_details(self):
        def extract_info(*args, **kwargs):
            raise ValueError("private extractor details")
        output = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO("next\n")), contextlib.redirect_stdout(output):
            self.pages(types.SimpleNamespace(extract_info=extract_info))
        self.assertIn("Couldn't load recommendations", output.getvalue())
        self.assertNotIn("private extractor details", output.getvalue())


if __name__ == "__main__":
    unittest.main()
