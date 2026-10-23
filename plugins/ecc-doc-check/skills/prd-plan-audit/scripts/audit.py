#!/usr/bin/env python3
"""Read-only consistency audit for ECC PRD and plan artifacts.

Checks plan-prd (.claude/prds, "Delivery Milestones") and prp-prd
(.claude/PRPs/prds, "Implementation Phases") documents together with the
plans they reference. Never writes to the repository.

Usage: audit.py --root <repo> [--json]
Exit code: 1 when any ERROR finding exists, otherwise 0.
"""
import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

VALID_STATUSES = ("pending", "in-progress", "complete")
STATUS_HEADERS = ("status", "状态", "狀態")
PRD_GLOBS = (".claude/prds/**/*.prd.md", ".claude/PRPs/prds/**/*.prd.md")
PLAN_GLOBS = (".claude/plans/**/*.plan.md", ".claude/PRPs/plans/**/*.plan.md")
TABLE_HEADING = re.compile(r"^#{2,}\s*(Delivery Milestones|Implementation Phases)\b", re.I)
MD_PATH = re.compile(r"`([^`\s]+\.md)`|(?<![\w/`])(\.claude/[^\s|`)]+\.md)")
SOURCE_PRD = re.compile(r"Source PRD\**\s*[:：]\s*(.+)", re.I)
STALE_FOOTER = re.compile(r"Implementation planning pending via /plan", re.I)


@dataclass(frozen=True)
class Finding:
    level: str  # ERROR | WARN | INFO
    code: str
    location: str
    message: str


@dataclass(frozen=True)
class Row:
    prd: Path
    line: int
    milestone: str
    status: str
    paths: tuple


def rel(root, path):
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def collect(root, globs):
    found = {p.resolve() for g in globs for p in root.glob(g) if p.is_file()}
    return tuple(sorted(found))


def extract_paths(text):
    return tuple(a or b for a, b in MD_PATH.findall(text))


def split_cells(line):
    return tuple(c.strip() for c in line.strip().strip("|").split("|"))


def find_column(header, *names):
    for index, cell in enumerate(header):
        if any(name in cell.lower() for name in names):
            return index
    return None


def parse_table(prd, lines, start):
    """Parse the markdown table following the milestone heading at `start`."""
    table = [(i, l) for i, l in enumerate(lines[start + 1:], start + 1) if l.strip()]
    table = [(i, l) for i, l in table if not l.lstrip().startswith("<!--")]
    rows_src = []
    for i, line in table:
        if not line.lstrip().startswith("|"):
            break
        rows_src.append((i, line))
    if len(rows_src) < 3:
        return ()
    header = split_cells(rows_src[0][1])
    status_col = find_column(header, *STATUS_HEADERS)
    if status_col is None:
        return ()
    rows = []
    for i, line in rows_src[2:]:
        cells = split_cells(line)
        name = " ".join(cells[:2]) if len(cells) > 1 else cells[0]
        status = cells[status_col] if status_col < len(cells) else ""
        rows.append(Row(prd, i + 1, name, status, extract_paths(line)))
    return tuple(rows)


def parse_prd(prd):
    lines = prd.read_text(encoding="utf-8").splitlines()
    starts = [i for i, l in enumerate(lines) if TABLE_HEADING.match(l)]
    return tuple(r for s in starts for r in parse_table(prd, lines, s))


def aggregate_status(statuses):
    normalized = [s.strip().lower() for s in statuses]
    if not normalized or any(s not in VALID_STATUSES for s in normalized):
        return None
    if all(s == "complete" for s in normalized):
        return "complete"
    if all(s == "pending" for s in normalized):
        return "pending"
    return "in-progress"


def resolve(root, prd, ref):
    for base in (root, prd.parent):
        candidate = (base / ref).resolve()
        if candidate.exists():
            return candidate
    return None


def suggest_moved(root, ref):
    name = Path(ref).name
    matches = sorted(p for p in (root / ".claude").rglob(name) if p.is_file())
    return [rel(root, p) for p in matches]


def check_row_paths(root, row):
    findings, resolved = [], []
    for ref in row.paths:
        target = resolve(root, row.prd, ref)
        if target:
            resolved.append(target)
            continue
        moved = suggest_moved(root, ref)
        hint = f"; found at {', '.join(moved)}" if moved else ""
        findings.append(Finding("ERROR", "missing-path", f"{rel(root, row.prd)}:{row.line}",
                                f"{row.milestone}: referenced file `{ref}` does not exist{hint}"))
    return findings, resolved


def check_row_status(root, row, rows_by_prd, resolved):
    loc = f"{rel(root, row.prd)}:{row.line}"
    status = row.status.strip().lower()
    if status not in VALID_STATUSES:
        return [Finding("ERROR", "invalid-status", loc,
                        f"{row.milestone}: status `{row.status}` is not one of {', '.join(VALID_STATUSES)}")]
    findings = []
    if status != "pending" and not resolved and not row.paths:
        findings.append(Finding("WARN", "no-plan", loc, f"{row.milestone}: `{status}` but no plan or PRD is linked"))
    children = [p for p in resolved if p != row.prd and p in rows_by_prd and rows_by_prd[p]]
    for child in children:
        expected = aggregate_status([r.status for r in rows_by_prd[child]])
        if expected and expected != status:
            findings.append(Finding("ERROR", "status-drift", loc,
                                    f"{row.milestone}: `{status}` but child PRD {rel(root, child)} "
                                    f"aggregates to `{expected}`"))
    return findings


def check_footer(root, prd, rows):
    text = prd.read_text(encoding="utf-8")
    if STALE_FOOTER.search(text) and any(r.status.strip().lower() != "pending" for r in rows):
        return [Finding("INFO", "stale-footer", rel(root, prd),
                        "footer still says planning is pending via /plan although milestones have started")]
    return []


def check_plans(root, plans, referenced):
    findings = []
    for plan in plans:
        loc = rel(root, plan)
        match = SOURCE_PRD.search(plan.read_text(encoding="utf-8"))
        sources = extract_paths(match.group(1)) if match else ()
        missing = [s for s in sources if not resolve(root, plan, s)]
        for source in missing:
            findings.append(Finding("ERROR", "missing-source-prd", loc, f"Source PRD `{source}` does not exist"))
        if plan in referenced:
            continue
        if sources:
            findings.append(Finding("WARN", "orphan-plan", loc, "plan names a Source PRD but no PRD row links to it"))
        else:
            findings.append(Finding("INFO", "standalone-plan", loc, "plan has no Source PRD and no PRD links to it"))
    return findings


def run_audit(root):
    root = Path(root).resolve()
    prds = collect(root, PRD_GLOBS)
    rows_by_prd = {p: parse_prd(p) for p in prds}
    findings, referenced = [], set()
    for prd, rows in rows_by_prd.items():
        for row in rows:
            path_findings, resolved = check_row_paths(root, row)
            referenced.update(resolved)
            findings += path_findings + check_row_status(root, row, rows_by_prd, resolved)
        findings += check_footer(root, prd, rows)
    findings += check_plans(root, collect(root, PLAN_GLOBS), referenced)
    order = {"ERROR": 0, "WARN": 1, "INFO": 2}
    return tuple(sorted(findings, key=lambda f: (order[f.level], f.location)))


def print_report(root, findings):
    if not findings:
        print(f"✓ No PRD/plan consistency issues found in {root}")
        return
    for f in findings:
        print(f"{f.level:5} {f.code:18} {f.location}\n      {f.message}")
    counts = {lvl: sum(1 for f in findings if f.level == lvl) for lvl in ("ERROR", "WARN", "INFO")}
    print(f"\nSummary: {counts['ERROR']} error(s), {counts['WARN']} warning(s), {counts['INFO']} info")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".", help="repository root (default: cwd)")
    parser.add_argument("--json", action="store_true", help="emit findings as JSON")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    if not (root / ".claude").is_dir():
        print(f"error: {root} has no .claude/ directory", file=sys.stderr)
        return 2
    findings = run_audit(root)
    if args.json:
        print(json.dumps([asdict(f) for f in findings], ensure_ascii=False, indent=2))
    else:
        print_report(root, findings)
    return 1 if any(f.level == "ERROR" for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
