# Known issues

## `/prp-prd` phase tables are not parsed

**Found:** 2026-11-03, while auditing `.claude/PRPs/prds/session-board.prd.md`.
**Status:** open. Fix after session-board ships.

### Symptom

The audit reads no rows from any PRD written by `/ecc:prp-prd`. Such a PRD gets no `status-drift`, `invalid-status`, `missing-path` or `no-plan` checks. A plan linked from it is reported as `orphan-plan` even though the PRD links it.

Reproduce from the repository root:

```bash
python3 -c "import sys; sys.path.insert(0, 'plugins/ecc-doc-check/skills/prd-plan-audit/scripts'); import audit; from pathlib import Path; print(audit.parse_prd(Path('.claude/PRPs/prds/session-board.prd.md')))"
# prints () — expected 4 rows
```

The same happens with the ai-video-platform PRD (0 rows).

### Cause 1: a multi-line HTML comment ends the table early

The `/prp-prd` template puts a comment block between the `## Implementation Phases` heading and the table:

```markdown
## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: ...
-->

| # | Phase | ... |
```

`parse_table` in `skills/prd-plan-audit/scripts/audit.py` (line 75) drops only the lines that start with `<!--`. The next line, `  STATUS: ...`, does not start with `|`, so the loop at line 78 stops before reaching the table, and `parse_table` returns `()`.

**Fix direction:** strip whole `<!-- ... -->` blocks, including multi-line ones, before scanning for the table. Add a test with the `/prp-prd` template layout.

### Cause 2: relative markdown links are not recognised

`MD_PATH` (line 23) matches `` `path.md` `` and bare `.claude/...md` paths, but not links like `[plan](../plans/x.plan.md)`. ECC's own PRDs write plan links that way, so even after Cause 1 is fixed those rows would look like they link nothing.

**Fix direction:** also match `](<relative>.md)` link targets and resolve them against the PRD's folder. Add a test.

### Workaround

Write the plan link as a path from the project root, for example `.claude/PRPs/plans/x.plan.md`. This only helps once Cause 1 is fixed.
