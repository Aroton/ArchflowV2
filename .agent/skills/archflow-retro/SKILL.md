---
name: archflow-retro
description: >-
  Audit an /archflow-run checkout and its Claude session transcripts, compare before/after
  workflow changes against PURPOSE.md and metrics/history.json, refresh METRICS.md, and
  propose evidence-backed improvements. Repo-local maintainer skill for ArchflowV2.
---

# ArchFlow Workflow Retro

Evaluate whether `/archflow-run` is getting better against `PURPOSE.md` ("the best automated code for the least compute") using deterministic metrics from `scripts/measure-run.mjs` plus targeted qualitative inspection of the run's markdown record.

Treat arguments as `<run-dir> [--since YYYY-MM-DD] [--compare <before-id>] [--note "<change summary>"]`. If the user does not pass a run directory, ask which run to audit (or list the runs already recorded in `metrics/history.json`).

## Hard boundaries

- **Read `PURPOSE.md` first** before recommending or making any change to a skill or workflow. Every proposed change must answer its six "Judging a change" questions.
- **Never run `install.sh`** or write to machine-global locations (`~/.claude/`, `~/.agents/`, `~/.gemini/`, `~/.archflow/`, `~/.local/bin/`) unless the user explicitly asks in the current turn.
- **Never modify `skills/` or `src/` without the user agreeing** to the specific changes you recommend. Recording metrics into `metrics/history.json` and refreshing `METRICS.md` is authorized when the user asks to record or update the dashboard.
- **Never hand-estimate token or dollar totals.** Always compute them with `npm run metrics`.

## Procedure

### 1. Measure the run deterministically

Run the metrics script from this repository root:

```bash
# Inspect without writing
npm run metrics -- --run <run-dir> [--since <YYYY-MM-DD>] [--repo <extra-repo>]

# Record into metrics/history.json and regenerate METRICS.md (when updating the dashboard)
npm run metrics -- --run <run-dir> [--since <YYYY-MM-DD>] [--id <slug>] [--note "<what changed>"] --record --render
```

- Use `--since <YYYY-MM-DD>` and a distinct `--id` (for example `<run>-post-<date>`) when evaluating a workflow tweak mid-run so post-change sessions are not blended with pre-change milestones.
- Companion repositories named in `PLAN.md` are auto-detected; pass `--repo <path>` if another repo is not listed there.

### 2. Compare before vs. after

Compare the measured run against the baseline (`baseline-2026-11-18`) or the prior snapshot:

```bash
npm run metrics -- --compare <before-id> <after-id>
```

Focus on whether **both** sides of `PURPOSE.md` moved in the right direction:
- **Cost:** `$/task`, `$/1k LOC`, strongest-model (`fable`) share, `Review/Write` ratio, planning vs. plan-revision spend, orchestrator context & `PROGRESS.md` size.
- **Quality:** serious defects (critical + major) caught before merge per task, serious defects escaped to milestone gates, review signal rate (acted on vs. dismissed), no-decision review row share, cross-model-only catch rate, and structure findings per task.

### 3. Investigate the *why* (targeted reads only)

Numbers show *what* moved; inspect the run's files selectively to explain *why* — never load `HISTORY.md` whole:

- Check every `ACTION` or `WATCH` health check printed by `npm run metrics`.
- Read `metrics/actions.md` (when it exists) to see which prior workflow changes were shipped since the last retro and whether their target metrics moved.
- Read the `## Gate log` in `<run-dir>/PROGRESS.md` and any `reviews/gate-*.md` file that reported a critical or major escape.
- Check `<run-dir>/reviews/STOP-*.md` and the tail of `<run-dir>/HISTORY.md` (`tail -n 120` or `grep -n '^## '`) for plan pivots, halts, wasted spawns, or trust-boundary incidents.
- Check `<run-dir>/DEFERRED.md` for findings that piled up unowned or stalled.

Separate **one-off product pivots** (requirements changing at a STOP) from **systemic workflow leaks** (patterns repeating across multiple milestones or runs, such as Opus fix-verify overuse or `PROGRESS.md` bloat).

### 4. Report and produce a ranked Action List

Present a concise, plain-language retro:
1. **Verdict:** did the workflow improve, hold steady, or regress relative to baseline / prior run? Give the before-vs-after numbers and close out any previously shipped items from `metrics/actions.md` with their observed result.
2. **What worked well:** the parts earning their compute.
3. **Action List:** a numbered table of concrete proposed changes ranked by impact and confidence, using this shape:

   | # | Change (target file) | Evidence / Problem | Expected Impact (`PURPOSE.md` measure) | Trust boundary / Cost | How to verify next retro |
   |---|---|---|---|---|---|

   Every row must pass `PURPOSE.md`'s six "Judging a change" questions: name the measure it moves, cite measured evidence (not speculation), state what it costs, flag any human trust boundary it touches, and name the exact metric to check on the next `--compare` run.
4. **Persist & ask:** offer to record the snapshot into `metrics/history.json` / `METRICS.md`, write or update the open items in `metrics/actions.md` so nothing is lost between retros, and ask which numbered actions to implement next.
