"""Tests for audit.py. Run: python3 -m unittest discover -s tests"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import audit  # noqa: E402

TABLE_HEADER = "| # | Milestone | Outcome | Status | Plan |\n|---|---|---|---|---|\n"


def prd(rows, footer=""):
    body = "".join(f"| {r[0]} | {r[1]} | x | {r[2]} | {r[3]} |\n" for r in rows)
    return f"# PRD\n\n## Delivery Milestones\n{TABLE_HEADER}{body}\n{footer}\n"


class AuditTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def codes(self):
        return sorted({f.code for f in audit.run_audit(self.root)})


class TestStatusValues(AuditTestCase):
    def test_flags_non_standard_status(self):
        self.write(".claude/plans/a.plan.md", "**Source PRD**: `.claude/prds/m.prd.md`\n")
        self.write(".claude/prds/m.prd.md", prd([("1", "a", "TO BE DONE", "`.claude/plans/a.plan.md`")]))
        self.assertIn("invalid-status", self.codes())

    def test_clean_project_has_no_errors(self):
        self.write(".claude/plans/a.plan.md", "**Source PRD**: `.claude/prds/m.prd.md`\n")
        self.write(".claude/prds/m.prd.md", prd([("1", "a", "complete", "`.claude/plans/a.plan.md`")]))
        errors = [f for f in audit.run_audit(self.root) if f.level == "ERROR"]
        self.assertEqual(errors, [])


class TestPaths(AuditTestCase):
    def test_missing_plan_suggests_archived_copy(self):
        self.write(".claude/PRPs/plans/completed/a.plan.md", "**Source PRD**: `.claude/prds/m.prd.md`\n")
        self.write(".claude/prds/m.prd.md", prd([("1", "a", "complete", "`.claude/PRPs/plans/a.plan.md`")]))
        findings = [f for f in audit.run_audit(self.root) if f.code == "missing-path"]
        self.assertEqual(len(findings), 1)
        self.assertIn("completed/a.plan.md", findings[0].message)

    def test_orphan_plan_is_reported(self):
        self.write(".claude/plans/lonely.plan.md", "**Source PRD**: `.claude/prds/m.prd.md`\n")
        self.write(".claude/prds/m.prd.md", prd([("1", "a", "pending", "—")]))
        self.assertIn("orphan-plan", self.codes())

    def test_plan_with_missing_source_prd(self):
        self.write(".claude/plans/a.plan.md", "**Source PRD**: `.claude/prds/gone.prd.md`\n")
        self.write(".claude/prds/m.prd.md", prd([("1", "a", "in-progress", "`.claude/plans/a.plan.md`")]))
        self.assertIn("missing-source-prd", self.codes())


class TestParentChildDrift(AuditTestCase):
    def test_parent_pending_while_child_in_progress(self):
        self.write(".claude/plans/c.plan.md", "**Source PRD**: `.claude/prds/child.prd.md`\n")
        self.write(".claude/prds/child.prd.md", prd([("2.1", "c", "in-progress", "`.claude/plans/c.plan.md`")]))
        self.write(".claude/prds/top.prd.md", prd([("2", "child", "pending", "`.claude/prds/child.prd.md`")]))
        drift = [f for f in audit.run_audit(self.root) if f.code == "status-drift"]
        self.assertEqual(len(drift), 1)
        self.assertIn("in-progress", drift[0].message)

    def test_parent_matches_child_aggregate(self):
        self.write(".claude/plans/c.plan.md", "**Source PRD**: `.claude/prds/child.prd.md`\n")
        self.write(".claude/prds/child.prd.md", prd([("2.1", "c", "complete", "`.claude/plans/c.plan.md`")]))
        self.write(".claude/prds/top.prd.md", prd([("2", "child", "complete", "`.claude/prds/child.prd.md`")]))
        self.assertNotIn("status-drift", self.codes())


class TestLocalizedHeader(AuditTestCase):
    def test_chinese_status_column_is_parsed(self):
        self.write(".claude/plans/c.plan.md", "**Source PRD**: `.claude/prds/child.prd.md`\n")
        self.write(".claude/prds/child.prd.md", prd([("2.1", "c", "in-progress", "`.claude/plans/c.plan.md`")]))
        top = ("# 总 PRD\n\n## Delivery Milestones\n| # | 里程碑 | 结果 | 状态 | Plan |\n|---|---|---|---|---|\n"
               "| 2 | 子 | x | pending | `.claude/prds/child.prd.md` |\n")
        self.write(".claude/prds/top.prd.md", top)
        self.assertIn("status-drift", self.codes())


class TestAggregate(unittest.TestCase):
    def test_aggregate_rules(self):
        self.assertEqual(audit.aggregate_status(["complete", "complete"]), "complete")
        self.assertEqual(audit.aggregate_status(["pending", "pending"]), "pending")
        self.assertEqual(audit.aggregate_status(["complete", "pending"]), "in-progress")
        self.assertIsNone(audit.aggregate_status(["complete", "TO BE DONE"]))


class TestStaleFooter(AuditTestCase):
    def test_flags_stale_pending_footer(self):
        self.write(".claude/plans/a.plan.md", "**Source PRD**: `.claude/prds/m.prd.md`\n")
        footer = "*Status: DRAFT — requirements only. Implementation planning pending via /plan.*"
        self.write(".claude/prds/m.prd.md", prd([("1", "a", "complete", "`.claude/plans/a.plan.md`")], footer))
        self.assertIn("stale-footer", self.codes())


if __name__ == "__main__":
    unittest.main()
