import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chatlog_replay as replay  # noqa: E402

TS = "2026-10-23T07:30:12.000Z"
PLAIN = replay.Style.make(False)

EVENTS = [
    {"v": 1, "kind": "session", "ts": TS, "action": "resume", "sessionId": "abcdef1234567890", "cwd": "/w"},
    {"v": 1, "kind": "user", "ts": TS, "text": "list files"},
    {"v": 1, "kind": "tool", "ts": TS, "id": "t1", "name": "Bash", "summary": "ls"},
    {"v": 1, "kind": "result", "ts": TS, "id": "t1", "isError": False, "preview": ["a", "b", "c"], "totalLines": 7},
    {"v": 1, "kind": "assistant", "ts": TS, "text": "## Files\nThere is **a**.\n```\ncode\n```"},
    {"v": 1, "kind": "turn", "ts": TS, "reason": "aborted", "durationMs": 3},
    {"v": 1, "kind": "end", "ts": TS, "reason": "prompt_input_exit"},
]


def rendered(event: dict) -> str:
    return "\n".join(replay.render_event(event, 80, PLAIN))


class RenderTest(unittest.TestCase):
    def test_draws_each_event_like_the_terminal(self):
        self.assertIn("session resumed · abcdef12", rendered(EVENTS[0]))
        self.assertIn("> list files", rendered(EVENTS[1]))
        self.assertIn("⏺ Bash(ls)", rendered(EVENTS[2]))
        self.assertIn("⎿  a", rendered(EVENTS[3]))
        self.assertIn("… +4 lines", rendered(EVENTS[3]))
        self.assertIn("⎿  Interrupted by user", rendered(EVENTS[5]))
        self.assertIn("session ended (prompt_input_exit)", rendered(EVENTS[6]))

    def test_renders_markdown_without_fences(self):
        text = rendered(EVENTS[4])
        self.assertIn("⏺ Files", text)
        self.assertIn("There is a.", text)
        self.assertNotIn("```", text)

    def test_an_answered_turn_draws_nothing(self):
        self.assertEqual(replay.render_event({"kind": "turn", "ts": TS, "reason": "answer"}, 80, PLAIN), [])

    def test_skips_broken_lines(self):
        self.assertEqual(len(replay.parse_events('{"kind":"note","ts":"x"}\nnot json\n\n[1]\n')), 1)

    def test_color_adds_ansi_only_when_enabled(self):
        colored = "\n".join(replay.render_event(EVENTS[2], 80, replay.Style.make(True)))
        self.assertIn("\033[32m", colored)
        self.assertNotIn("\033[", rendered(EVENTS[2]))


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.older = self.folder / "2026-10-22_090000_aaaaaaaa.jsonl"
        self.newer = self.folder / "2026-10-23_090000_bbbbbbbb.jsonl"
        for index, path in enumerate([self.older, self.newer]):
            path.write_text("\n".join(json.dumps(e) for e in EVENTS), encoding="utf-8")
            stamp = time.time() - 100 + index * 10
            os.utime(path, (stamp, stamp))

    def tearDown(self):
        self.tmp.cleanup()

    def test_numbers_count_from_the_most_recent(self):
        self.assertEqual(replay.resolve(None, self.folder), self.newer)
        self.assertEqual(replay.resolve("2", self.folder), self.older)

    def test_finds_by_name_or_sibling_file(self):
        self.assertEqual(replay.resolve("aaaaaaaa", self.folder), self.older)
        self.assertEqual(replay.resolve(str(self.older.with_suffix(".md")), self.folder), self.older)

    def test_unknown_log_exits_with_a_message(self):
        with self.assertRaises(SystemExit):
            replay.resolve("9", self.folder)

    def test_main_prints_a_plain_replay(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = replay.main(["1", "--dir", str(self.folder), "--no-color"])
        self.assertEqual(code, 0)
        self.assertIn("> list files", out.getvalue())
        self.assertIn("⏺ Bash(ls)", out.getvalue())


if __name__ == "__main__":
    unittest.main()
