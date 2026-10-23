# ECC document formats

The ECC planning artifacts both lancekit plugins read. Checked against ECC 2.2.3;
re-check after an ECC upgrade, then update `plugins/ecc-progress/hooks/parse.ts`
and `plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py` together.

## PRDs

| Command | Path | Table heading | Columns |
|---|---|---|---|
| `/plan-prd` | `.claude/prds/{name}.prd.md` | `Delivery Milestones` | `# \| Milestone \| Outcome \| Status \| Plan` |
| `/prp-prd` | `.claude/PRPs/prds/{name}.prd.md` | `Implementation Phases` | `# \| Phase \| Description \| Status \| Parallel \| Depends \| PRP Plan` |

Status values: `pending | in-progress | complete`. `/prp-implement` sets a phase
from `in-progress` to `complete` and adds the report path when it finishes.

## Plans

- `/prp-plan` writes `.claude/PRPs/plans/{name}.plan.md`; `/plan` writes under `.claude/plans/`.
- Tasks are headings: `### Task N: {name}` under `## Step-by-Step Tasks`.
- `/prp-implement` archives a finished plan to `.claude/PRPs/plans/completed/` and
  writes `.claude/PRPs/reports/{name}-report.md`.

## Progress signals during `/prp-implement`

- Phases: DETECT, LOAD, PREPARE, EXECUTE, VALIDATE, REPORT, OUTPUT.
- Per task it only logs `[done] Task N: {name} — complete` to the conversation;
  nothing per task is written to disk.

## Who reads what

| Plugin | Reads |
|---|---|
| ecc-progress | newest PRD table, active plan's task headings, `completed/` archive, `[done] Task N` log lines |
| ecc-doc-check | all PRDs and plans in both layouts, plan links, `Source PRD`, reports, git log |
