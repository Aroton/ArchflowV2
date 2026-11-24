# ArchFlow Workflow Action List

Open improvement items surfaced by `/archflow-retro`, tracked here so changes are not forgotten and can be verified before/after on the next retro (`npm run metrics -- --compare <before> <after>`).

## Open

*(None currently open — items 1–6 below are shipped and awaiting next-retro verification.)*

## Shipped (awaiting next-retro verification)

| # | Status | Change (target file) | Evidence / Problem | Expected Impact (`PURPOSE.md`) | Trust boundary / Cost | How to verify next retro |
|---|---|---|---|---|---|---|
| 1 | Shipped | **Route minor test-backed fix-verifies to `sonnet` (`high`)** (`skills/archflow-run/PROTOCOL.md`, `docs/workflow/SKILLS.md`) | 89–97% of fix-verify spawns ran on Opus across all 4 measured runs (`174/185` = $118 in `3d-model-tool`, exceeding the $108 cost of fixing the bugs). Keep Opus for critical/major, rework, `opus` fixes, or `reading`-only verifies. | Cuts fix-verify cost ~40–50% (~$50/run); moves `Review/Write` ratio from `1.5×` toward `~1.1×`. | No trust boundary (independent fresh reviewer kept); slight risk of weaker regression catch on minor fixes. | `Fix-verify Opus share` drops to ≤ 65%; `Review/Write` drops; `Gate escapes` stays flat. |
| 2 | Shipped | **Archive finished milestones' `Task log` entries to `HISTORY.md`** (`skills/archflow-run/PROTOCOL.md`, `skills/archflow-run/templates/PROGRESS.md`, `docs/workflow/SKILLS.md`) | `PROGRESS.md` bloated to 66.7 KB (`3d-model-tool`, 54 KB task log), 50.8 KB (`stage-missing-features`), and 36.8 KB (`stage-templates`), re-read on every orchestrator turn. | Cuts orchestrator context bloat & 300k handoff churn; saves ~$15–$25/run. | No trust boundary; zero extra spawns (shell move at milestone end). | `PROGRESS.md live-state hygiene` stays ≤ 20 KB across multi-milestone runs. |
| 3 | Shipped | **Codify orchestrator-folded small counter-reviews (≤ 2 short points)** (`skills/archflow-run/PROTOCOL.md`, `docs/workflow/SKILLS.md`) | The `3d-model-tool` orchestrator already bypassed ~100 merge-mode spawns manually because spawning a fresh agent for 1–2 short points was pure overhead. | Saves ~60–100 spawns and ~$12–$20/run; fewer orchestrator turns. | No trust boundary (every point still decided and logged in the review file). | `review_merge` spawns drop; `Cost / task` drops with no drop in `Signal %`. |
| 4 | Shipped | **Require explicit provider + dollar cap before any paid external API spend** (`skills/archflow-run/SKILL.md`) | Session 11 of `3d-model-tool` misread an ambiguous human reply and spent $1.08 cash on OpenAI direct priority tier instead of Bedrock credits (`M2-Q1c`). | Protects the "spends money" human trust boundary; prevents surprise cash spend. | Hard human trust boundary; negligible prompt cost. | Zero unapproved provider-spend incidents in `STOP-*.md` / `HISTORY.md`. |
| 5 | Shipped | **Recommend a 1–2 task vertical spike before large speculative M1s** (`skills/archflow-run/PLANNING.md`) | `3d-model-tool` built 31 M1 tasks on primitive boxes before STOP 1 showed quality was insufficient (~$225 sunk across M1 + M2 replan). | Prevents whole-milestone throwaways on high-uncertainty product bets. | No trust boundary; conditional on high-uncertainty asks only. | Lower `Plan revisions` share of total cost (< 5%) on exploratory runs. |
| 6 | Shipped | **Capture Codex CLI token usage in `result.json` & metrics** (`src/dispatch/usage.ts`, `src/dispatch/coordinator.ts`, `scripts/measure-run.mjs`, `docs/cli/COMMANDS.md`, `dist/`) | Cross-model `gpt-6.2-sol` cost was invisible in `result.json` (only call counts and `issues_found` rates were tracked). | Closes the remaining cost blind spot in `METRICS.md` and `~/.archflow/usage/`. | Code change in `src/` with `dist/` regenerated via `release:*`. | Next run's `METRICS.md` includes measured Codex token & USD spend alongside Claude spend. |

## Verified / Closed

*(Move shipped items here on the next `/archflow-retro` once a post-change run confirms the before/after `--compare` delta.)*
