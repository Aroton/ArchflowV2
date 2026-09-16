---
name: archflow-simple
description: Plan, review, implement, and review a small standalone ask in one session using MCP counter-review, test review, and constitution review, without initializing an ArchFlow workflow.
---

# Simple Task

Treat the arguments as the ask, optionally followed by `--counter-reviewer <model>:<effort>[@<provider>]`, `--test-reviewer <model>:<effort>[@<provider>]`, and `--adjudicator <model>:<effort>[@<provider>]`. A route is one shell-quoted value; split once at `:` and once at `@`. Reject duplicate flags, unknown flags, and missing or empty components. Normalize supplied routes into `review_routes` and keep them unchanged across the two reviews; omit unsupplied roles so repository routing applies.

This session owns the complete task: plan, triage, execution, fixes, and conversation. Use this skill for standalone work in the connected Git repository. Work belonging to an initialized task continues through its existing workflow; this skill is not a bypass. A request spanning multiple repositories needs a different scope or the full workflow, not a silently partial implementation.

Do not initialize a task, write workflow state or task documents, call workflow status/apply, select an implementation agent, or hand off to another skill. Keep the plan and review feedback in conversation. Repository initialization is unnecessary: the MCP reads existing repository configuration and constitution, or shipped defaults when absent. Review snapshots are temporary.

## Plan and review

Understand the ask and inspect relevant code and repository instructions. Record the initial full HEAD commit as `base_commit` and note pre-existing edits. Preserve those edits; explain when a declared output already contains unrelated work. Resolve missing information that materially affects the solution, then produce a concise plan covering intended behavior, implementation, and useful verification.

Call `archflow_review` with `schema_version:"1"`, `stage:"plan"`, the original `ask`, the plan text, `base_commit`, and repository-relative file `paths` the plan expects to change, plus optional `review_routes`. Paths may name planned new files; use file names rather than directories. The MCP runs counter-review, test-strategy review, and constitution review when active rules exist, with no effort review. It returns reports, constitution judgments, human-review reasons, and policy digests.

Read all reports and judgments. Investigate material concerns, correct supported defects in the plan, and dismiss disproved or non-material suggestions with reasons. Do not send the corrected plan for another review. Keep the returned `policy_digest` for implementation review.

Every returned `human_review_reasons` entry requires explicit human judgment. Present its substance and consequences conversationally; stop before dependent work and wait for an explicit answer. Silence is not approval. Resolve failing or uncertain constitution judgments through fixes or human judgment; they are not automatically waived by a reviewer report. These decisions live in conversation, not server gates. Explain any incompatibility between a custom policy and this standalone mode instead of ignoring the policy.

Normally continue directly into implementation after plan fixes. A missing required review, incomplete coverage, or unresolved material decision is a blocker, not a successful plan review.

## Execute and review

Implement the corrected plan and run relevant checks. Keep the plan truthful if implementation reveals a necessary adjustment; seek human input for a consequential unresolved scope change. Maintain affected project documentation.

Call `archflow_review` once with `stage:"implementation"`, the original ask, the current corrected plan, the same baseline and routes, all actual changed output file paths (including added and deleted files), and `verification` describing commands, results, and checks that could not run or were not applicable. Set `expected_policy_digest` to the plan review's returned digest. The MCP includes existing working-tree edits as context but reviews the declared outputs. A changed baseline or policy requires resolution with the user; never drop the expected digest to bypass the check.

Triage the counter-review, test review, and constitution judgments. Fix supported material defects and rerun relevant checks. Honor explicit human-review reasons before claiming completion. Do not iterate reviewers: each stage has one review pass followed by fixes, with no reviewer re-check of those fixes. Tests may be rerun as necessary. If a material issue cannot be resolved, explain the blocker rather than starting more review rounds or declaring success.

If dispatch fails, use available reports without claiming complete coverage. The MCP already retries classified transient failures on the same route. After exhaustion or a non-transient failure, explain the failed role and repair needed; no automatic route substitutions or repeated full passes. A user can explicitly request a fresh review after repair, which is a new call without durable resumption or reuse of earlier successes. If the tool is unavailable, report the blocker; do not substitute self-review or a local sub-agent for MCP review.

## Completion

Leave changes uncommitted unless the user separately requests a commit. Report delivered behavior, verification, material feedback and fixes, and unresolved limitations. Identify fixes made after review so the final bytes are not represented as independently re-reviewed. End with the result, not an implementation-agent recommendation or successor command.
