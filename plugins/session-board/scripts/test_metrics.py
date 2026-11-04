import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board  # noqa: E402
import metrics  # noqa: E402

T0 = board.parse_time("2026-11-05T09:00:00.000Z")


def at(seconds: float) -> str:
    return board.format_time(T0 + seconds)


def line(sid="s1", host="mac", ts=0.0, to="working", delay=0.1, wait=None, frm=None) -> dict:
    row = {"ts": at(ts), "sessionId": sid, "host": host, "project": "app", "from": frm, "to": to,
           "since": at(ts), "sentAt": at(ts), "receivedAt": at(ts), "reportDelayS": delay}
    if wait is not None:
        row["waitS"] = wait
    return row


class RecordFolder(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.folder = Path(self._folder.name)

    def tearDown(self):
        self._folder.cleanup()

    def write(self, rows, extra: str = "") -> Path:
        path = self.folder / "states.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows) + extra, encoding="utf-8")
        return path


class PercentileTest(unittest.TestCase):
    def test_nearest_rank(self):
        self.assertEqual(metrics.percentile([5], 50), 5)
        self.assertEqual(metrics.percentile([4, 1, 3, 2], 50), 2)
        self.assertEqual(metrics.percentile(list(range(1, 101)), 95), 95)
        self.assertEqual(metrics.percentile([1, 2, 3], 100), 3)
        self.assertIsNone(metrics.percentile([], 50))


class SummaryTest(unittest.TestCase):
    def test_approval_median_at_the_target_passes(self):
        rows = [line(wait=w, frm="needs-approval") for w in (30, 60, 90)]
        result = metrics.summarize(rows)["approval"]
        self.assertEqual((result["count"], result["median"], result["max"]), (3, 60, 90))
        self.assertEqual(result["result"], "pass")

    def test_approval_median_over_the_target_fails(self):
        self.assertEqual(metrics.summarize([line(wait=61, frm="needs-approval")])["approval"]["result"], "fail")

    def test_report_delay_uses_p95_and_counts_slow_reports(self):
        result = metrics.summarize([line(delay=d, frm="working") for d in (0.0, 0.4, 1.8)])["reportDelay"]
        self.assertEqual(result["p95"], 1.8)
        self.assertEqual(result["overTarget"], 1)
        self.assertEqual(result["result"], "fail")
        fast = metrics.summarize([line(delay=0.2, frm="working")] * 40 + [line(delay=2.5, frm="working")])["reportDelay"]
        self.assertEqual(fast["result"], "pass", "one slow report in 41 is within the 5% allowance")

    def test_peak_counts_overlapping_sessions_and_their_hosts(self):
        rows = [
            line("a", "mac", 0), line("a", "mac", 100, to="ended"),
            line("b", "mac", 10), line("b", "mac", 50),
            line("c", "book", 20), line("c", "book", 200),
            line("d", "book", 150), line("d", "book", 300),  # starts after a and b are gone
        ]
        peak = metrics.peak_concurrency(rows)
        self.assertEqual((peak["sessions"], peak["hosts"], peak["at"]), (3, 2, T0 + 20))

    def test_peak_meets_the_target_with_ten_sessions_on_two_hosts(self):
        rows = [line(f"s{i}", "mac" if i % 2 else "book", ts) for i in range(10) for ts in (i, 100 + i)]
        result = metrics.summarize(rows)["peak"]
        self.assertEqual((result["sessions"], result["hosts"], result["result"]), (10, 2, "pass"))

    def test_peak_below_the_target_is_left_to_the_eye(self):
        rows = [line(f"s{i}", "mac", ts) for i in range(10) for ts in (i, 100 + i)]
        summary = metrics.summarize(rows)
        self.assertIsNone(summary["peak"]["result"], "a lower bound below the target proves nothing")
        self.assertIn("目测核对", metrics.render(summary))

    def test_first_reports_are_not_counted_as_delay(self):
        rows = [line("a", delay=900.0), line("a", ts=60, delay=0.3, frm="working")]
        result = metrics.summarize(rows)["reportDelay"]
        self.assertEqual((result["count"], result["max"]), (1, 0.3))

    def test_no_data_is_neither_pass_nor_fail(self):
        summary = metrics.summarize([])
        self.assertIsNone(summary["approval"]["result"])
        self.assertIsNone(summary["reportDelay"]["result"])
        self.assertIsNone(summary["peak"]["result"])
        self.assertIn("没有数据", metrics.render(summary))

    def test_render_shows_minutes_for_long_waits(self):
        text = metrics.render(metrics.summarize([line(wait=546, frm="needs-approval")]))
        self.assertIn("最长 9.1 分钟", text)


class FileTest(RecordFolder):
    def test_bad_lines_are_skipped_and_counted(self):
        extra = 'not json\n{"ts": "yesterday", "sessionId": "x"}\n[1]\n{"ts": "%s"}\n\n' % at(0)
        lines, bad = metrics.load(self.write([line()], extra))
        self.assertEqual((len(lines), bad), (1, 4))

    def test_json_output_parses(self):
        path = self.write([line(wait=12.0, frm="needs-approval")])
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(metrics.main([str(path), "--json"]), 0)
        self.assertEqual(json.loads(out.getvalue())["approval"]["median"], 12.0)

    def test_missing_file_exits_2(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(metrics.main([str(self.folder / "missing.jsonl")]), 2)
        self.assertIn("cannot read", err.getvalue())

    def test_reads_what_the_board_writes(self):
        path = self.folder / "states.jsonl"
        record = board.RecordFile(path)
        clock = [T0]
        b = board.Board(clock=lambda: clock[0], record=record)

        def report(state: str, since: float, sent: float) -> None:
            clock[0] = T0 + sent
            body = {"v": 1, "host": "mac", "cwd": "/w/app", "project": "app",
                    "state": state, "since": at(since), "sentAt": at(sent)}
            b.accept("s1", board.parse_report(json.dumps(body).encode()))

        report("working", 0, 0.2)
        report("working", 0, 5.2)  # heartbeat: not recorded
        report("needs-approval", 10, 10.3)
        report("working", 55, 55.1)
        record.close()

        summary = metrics.summarize(*metrics.load(path))
        self.assertEqual(summary["changes"], 3)
        self.assertEqual(summary["approval"]["median"], 45.0)
        self.assertEqual(summary["reportDelay"]["max"], 0.3)
        self.assertEqual(summary["approval"]["result"], "pass")


if __name__ == "__main__":
    unittest.main()
