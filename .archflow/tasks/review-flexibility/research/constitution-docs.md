# Research: constitution + docs + skills touch map for task `review-flexibility`

Repo: `/home/aroton/ArchflowV2.feature-review-override-flexibility` (branch `feature/review-override-flexibility`).
All paths below are relative to that root unless absolute. Line numbers are as of this working tree.

---

## 1. Constitution system

### 1.1 Where rules live

- Active repository constitution: `.archflow/constitution/` — four rule files + `README.md`.
  - `.archflow/constitution/00-process.md` — `explicit-human-authority`
  - `.archflow/constitution/10-architecture.md` — `approved-design-before-code`
  - `.archflow/constitution/20-data.md` — `task-and-evidence-isolation`
  - `.archflow/constitution/30-product.md` — `honest-human-centered-outcomes`
- Seed/shipped copy (identical, byte-for-byte, per `diff -r`): `assets/constitution/` — same four files + `README.md`. This is what `archflow-local init` scaffolds and what `test/unit/constitution.test.ts` validates. **Any amendment must decide whether `assets/constitution/` is also updated** (the shipped template) or whether the repo's active copy diverges from the seed.

### 1.2 File format and frontmatter

Format is defined by `src/contracts/constitution.ts`:

- `parseConstitutionRuleMarkdown` (lines 40–48): strict `---\n` YAML frontmatter, closing `\n---\n`, then trimmed prose body = `text`.
- `frontmatterSchema` (lines 17–23, strict): `id` (kebab-case regex), `version` (positive safe int), `status` (`active` | `deprecated`), optional `review_trigger` (non-empty), optional `enforced_by` (non-empty string list, min 1).
- `parseConstitutionRuleFiles` (60–62): files sorted by path, duplicate `id` across files throws.
- **Evolution rules — `validateConstitutionEvolution` (64–75)**:
  - An existing ID cannot be deleted or reused (line 68).
  - A deprecated rule cannot be reactivated (line 69).
  - Content change (`status`, `text`, `review_trigger`, `enforced_by`) requires `version > prior.version` (lines 70–71).
  - No content change requires the version to be retained exactly (line 72).

So amending `explicit-human-authority` means: keep the ID, bump `version: 1` → `2`, change the `review_trigger` and/or prose. There is **no separate commit rule** in the constitution — commit authority is expressed inside `explicit-human-authority`'s trigger and prose ("waives a gate, authorizes a commit"), and in CLAUDE.md's hard rules, not as a standalone rule. "Removing/narrowing the commit rule" = narrowing those phrases inside `explicit-human-authority` (v2).

### 1.3 Exact current rule texts (quotes)

`.archflow/constitution/00-process.md` (entire file, lines 1–7):

```md
---
id: explicit-human-authority
version: 1
status: active
review_trigger: Advancement, approval, review-gate, waiver, or commit authority is inferred rather than explicitly recorded by a human for the exact subject.
---
Required human decisions are explicit and bound to the exact artifact or code subject under review. Silence, elapsed time, agent prose, or a model verdict never supplies approval, waives a gate, authorizes a commit, or advances the workflow.
```

`.archflow/constitution/10-architecture.md` (lines 1–7):

```md
---
id: approved-design-before-code
version: 1
status: active
review_trigger: Implementation begins before the applicable phase design is approved, or implementation materially departs from approved architecture without updating and re-reviewing its governing plan.
---
Implementation starts only from an approved phase design. The PRD, architecture, and phase design remain truthful as work proceeds; material deviations update the governing documents and re-enter the applicable review boundary before dependent work advances.
```

`.archflow/constitution/20-data.md` (lines 1–10):

```md
---
id: task-and-evidence-isolation
version: 1
status: active
review_trigger: A task reads or mutates another task's files, or an approval, waiver, review, or result is used for bytes other than the subject it identifies.
enforced_by:
  - task-path-boundary-tests
  - subject-digest-validation
---
Tasks are isolated from one another. Durable decisions and evidence identify the exact task and subject bytes they govern; stale, mismatched, cross-task, malformed, or partial evidence fails closed and cannot authorize advancement.
```

`.archflow/constitution/30-product.md` (lines 1–7):

```md
---
id: honest-human-centered-outcomes
version: 1
status: active
review_trigger: A failure, cancellation, unavailable reviewer, uncertain policy result, or missing evidence is represented as success or silently bypassed.
---
ArchFlow reports uncertainty and failure honestly and preserves human control. Automation performs the labor it can, but unavailable capabilities, inconclusive adjudication, missing evidence, and exhausted attempts remain visible non-success states with a safe next action.
```

`.archflow/constitution/README.md` (line 3, 5):

> "Rule IDs are append-only across approved revisions: change content or status only with a higher version, deprecate instead of deleting, and never reactivate a deprecated ID."
> "Tasks pin these files from an immutable, human-approved policy-base commit. A task branch cannot amend its own governing constitution."

### 1.4 How the policy base is pinned

`src/state/constitution.ts`:

- `CONSTITUTION_DIRECTORY = ".archflow/constitution"` (line 37); `RULE_FILE` regex `^\.\archflow\/constitution\/[0-9]{2}-[A-Za-z0-9][A-Za-z0-9._-]*\.md$` (line 38) — only `NN-name.md` files count; `README.md` is not a rule.
- `resolvePinnedConstitution(runner, policyBaseCommit, context)` (lines 122–159): reads rule files **exclusively from the immutable policy-base commit tree** (never HEAD/worktree), parses them, computes `digest = computePinnedConstitutionDigest(selected)` (path+blob-oid membership), freezes the registry. Empty or unparsable → `POLICY_BASE_INVALID`.
- `detectTaskLocalConstitutionEdit` (lines 165–212): detects worktree/index and committed task-branch edits to `.archflow/constitution/` since `policyBaseCommit`, producing a `constitution-edit` gate context. **Its only current caller is `src/init/legacy-upgrade.ts:265`** (upgrade preview). Per `docs/workflow/LIFECYCLE.md:105` the gate is "legacy compatibility … current counter-review does not emit this gate because task policy is already pinned immutably."
- Task state pins both: `state.json` carries `policy_base_commit: "6549da8a…"` (current HEAD), `constitution_digest`, and `config_digest` (see `.archflow/tasks/review-flexibility/state.json`). The active task's constitution-review child judges against the **pinned** v1 rules even after a task-branch amendment — an amendment on this branch governs only future tasks whose approved base includes it (`docs/review/COUNTER-REVIEW.md:108`).

### 1.5 Amendment procedure today

Codified in `skills/archflow-constitution/SKILL.md` (50 lines):

- Format and fields explained at lines 14–26.
- Configure-rules rules at lines 28–44: read all rules first; smallest durable rule set; new file needs unused two-digit prefix; for an existing ID "preserve its file and identity. If its text, status, trigger, or enforcement list changes, increment the positive integer version" (line 42); deprecate-don't-delete; after editing, inspect for duplicate IDs / invalid filenames / frontmatter / empty prose / evolution violations; show the user the diff (line 44).
- "Preserve policy authority" (lines 46–50): "Prefer constitution maintenance on the repository's policy or base branch before starting affected tasks. A task branch may also carry a constitution change as an ordinary reviewed output, but the active task remains governed by its pinned policy-base commit… Never claim that an existing task adopted the new rule merely because the file changed." And: "Before any commit, summarize the rules added, revised, or deprecated and obtain explicit approval for the exact change."

Mechanically there is **no dedicated tool path for amending**: the constitution skill is documentation-only (enforced: `test/contracts/skill-contract-canonical.test.ts:135-143` asserts the skill names no `archflow-local` command and no `archflow_` tool). An amendment is:

1. Edit the `NN-name.md` files (version bump, append-only IDs) — either on the base branch or as a reviewed task-branch output traveling through the normal phase-impl pipeline.
2. The edit itself does not automatically open a gate on ordinary tasks (the `constitution-edit` gate is legacy; the live detection is only in legacy-upgrade preview). What *does* happen: the task keeps operating on its pinned policy base; an unresolved task-local constitution edit blocks legacy `upgrade preview` (`skills/archflow-upgrade/SKILL.md:14`, `src/init/legacy-upgrade.ts:265`).
3. Version-bump semantics are enforced only where `validateConstitutionEvolution` is applied — it is exported from `src/contracts/constitution.ts:64` and exercised in `test/unit/constitution.test.ts` ("constitution evolution" describe, lines ~56–75) but grep shows **no production caller**: it is a contract-level guarantee for tooling/tests, plus the skill's instructed self-check.

### 1.6 Gate kinds involving constitution and approval

`src/contracts/gates.ts:80` — `GATE_KINDS = ["artifact-approval", "design-approval", "constitution-review", "material-drift", "attempts-exhausted", "constitution-edit", "commit-authorization", "restore-collision", "baseline-adoption", "migration-audit"]` (ten kinds).

`constitution-edit` decision vocabulary (`gates.ts:273`, `src/state/gate-core.ts:47`): `revert-edit | start-base-amendment | abort` (+ `cancel` in the request arm, `gate-core.ts:47`).

---

## 2. Other active rules vs the planned change

- **`approved-design-before-code`** (10-architecture.md): "Implementation starts only from an approved phase design." Under the trigger model, "approved" may no longer always mean a human gate (e.g. a per-project ruleset may not gate design approval, only PRD + architecture review per the default ruleset). The rule's *substance* (plan stays truthful; deviations re-enter review) is orthogonal and can survive; but the word "approved" ties it to the human-gate model. Options: leave v1 (if design approval stays a human gate by default ruleset) or bump to v2 wording ("reviewed" instead of "approved") if gates become ruleset-driven. Note CLAUDE.md's hard rule "Never write code before phase-design approval" and LIFECYCLE.md's boundary list echo it — those are tool-side, not constitution-side, but the design must keep tool behavior and rule text aligned.
- **`task-and-evidence-isolation`** (20-data.md): unaffected in substance. It constrains evidence identity, not who approves. The `enforced_by` labels (`task-path-boundary-tests`, `subject-digest-validation`) remain accurate. No change needed unless the change-reporting model renames digest-based subject binding.
- **`honest-human-centered-outcomes`** (30-product.md): "preserves human control… exhausted attempts remain visible non-success states." Compatible with declarative triggers — indeed the trigger model *is* the "uncertain policy result" made explicit. Likely no change; the phrase "preserves human control" is generic enough.
- **`explicit-human-authority`** (00-process.md): the main target. Current text implies *every* gate and every commit is human-approved ("waives a gate, authorizes a commit"). Narrowing to: human authority is required where the project's declarative trigger rules (or the remaining built-in trust boundaries) demand it; silence/agent verdict still never supplies approval *where a gate applies*. Version bump to 2 mandatory (text + review_trigger change).

Also relevant outside the constitution: `CLAUDE.md` hard rules ("Never commit or pass a review gate without explicit user approval") and the mirrored `AGENTS.md` (kept byte-identical by `test/contracts/skill-contract-canonical.test.ts:367-370`). The project's own CLAUDE.md is ArchFlow-tool documentation; the design must decide whether those hard-rule statements are the *tool's default ruleset* description (then they change with the feature) or the *repo's own policy* (then they narrow with the constitution amendment).

---

## 3. Docs inventory — sections to update

Refresh model: every maintained page carries a stamp under its title, e.g.
`**Explored:** 2026-08-16 · **Commit:** `d60da73` · **Covers:** `assets/workflow.yaml`, `src/contracts/workflow.ts`, …`.
`/archflow-explore` (skills/archflow-explore/SKILL.md:25-30) refreshes only pages whose `Covers` paths changed since the stamped commit (`git diff --name-only <stamped-commit>..HEAD`). A change touching `src/contracts/gates.ts`, `src/state/semantic-*.ts`, `skills/`, `src/contracts/config.ts`, and `.archflow/constitution/` will dirty nearly every page's Covers set; stamps must be bumped on each edited page. `docs/validation/` is point-in-time evidence, not maintained.

Per page, the sections that describe the four target behaviors:

### docs/OVERVIEW.md (stamp line 3; Covers: whole repository)
- L5: "…survive an adversarial review dispatched to an independent reviewer CLI… and then stop and ask a human" — the always-human-gate premise.
- L46: "Git also remains client-owned… under `requires_human_confirmation`…" — commit-authorization model.
- L52–71 "The evidence pipeline": pipeline diagram gate node (L60 "Human gate"), L64 constitution verdict handling, L66 "Human gates are deliberately not protocol consoles", L68 "Approval and advancement are intentionally separate durable facts… Implementation `commit-authorization` likewise resolves…" — the entire approval-gate narrative needs rewriting under trigger rules.
- L74–82 "Why each subsystem exists" bullets referencing gates/human decision points.
- Glossary L88 ("Gate — … Nine kinds exist" — also stale vs ten), L92–94 (Constitution, Waiver, Degraded mode "never a shortcut around gates").
- Config pinning: not described here beyond digests; the L70 "Editing the artifact changes its digest" paragraph stays.

### docs/workflow/LIFECYCLE.md (stamp L3; Covers: assets/workflow.yaml, src/contracts/workflow.ts, src/contracts/gates.ts, src/state/semantic-*.ts, src/mcp/handlers/semantic.ts, skills/)
The heaviest touch:
- L9: "five phases… and the gate policy" — `gate: on_trigger` wording (L15–16, L21) currently means *constitution* triggers; under the new model `on_trigger` becomes per-project declarative rules. L21 "every phase ends at one final human decision" must be rewritten.
- L25: **config pinning / mismatch paragraph** — "The workflow file's bytes are digest-pinned into each task… Tasks pinned to the retired four-step workflow digest… status reports `restore-pinned-config`… `pinned-config-schema-unsupported` with an `upgrade-tooling`". Under change-reporting this whole remediation story changes.
- L29–37 stage table: "Human approval" column (`artifact-approval`, always; `design-approval`; `commit-authorization`) — becomes ruleset-derived.
- L43–66 pipeline: L52 constitution gate derivation; L56 attempt cap; L62–66 editorial path (gate presentation language).
- L68–72 "Human revisions after a gate" (classification model stays; gate references adapt).
- L74–84 transition edges: L82 "Design boundaries re-verify `design-approval`… commit-authorization flow".
- L92–115 "Gates: where humans decide": the ten-gate table (L96–107) — gate kinds list itself changes if `artifact-approval`/`design-approval`/`commit-authorization` become trigger-driven rather than built-in; `constitution-edit` row (L105) may finally lose its "legacy" framing or be removed if the gate is retired.
- L116–126 "Hard trust boundaries": L120 "Nothing is approved until a human explicitly decides"; L122 "Every commit has one human lock… Implementation `commit-authorization` binds…" — direct restatements of `explicit-human-authority`; must be rewritten in step with the amended rule.
- L127–138 "Merging main into a task branch": L129 pins paragraph ("every pin reads either the task's own files or the immutable `policy_base_commit` tree") — changes if config pinning is replaced by change reporting.
- L140–142 "Where this is heading".

### docs/workflow/SKILLS.md (stamp L3; Covers: skills/, src/init/, src/mcp/handlers/semantic.ts, src/state/semantic-*.ts, assets/)
- L26–28 archflow-init: "The human's commit of the scaffolded files is the policy approval — that commit becomes each task's `policy_base_commit`" — stays, but the constitution-pinning narrative around it may need adjusting.
- L30–34 archflow-constitution section: describes append-only IDs, version bumps, "A task branch may carry a reviewed constitution edit for future tasks" — needs a note about this repo's own amendment once made (or stays generic).
- L44 archflow-prd: "Ends at a mandatory `artifact-approval` gate" — mandatory becomes ruleset-derived.
- L50 archflow-design / L56 archflow-phase-design: "The phase ends at one `design-approval`… Approval also authorizes the exact recoverable task-local milestone commit" — trigger-model rewrite.
- L60–66 archflow-phase-impl: L64 "Commit authorization is the durable human lock… the mandatory `commit-authorization` presentation… `requires_human_confirmation: true`" — core rewrite target.
- L80–90 "Shared conventions across skills": L84 "One approval, then the authorized commit or hand-off… PRD keeps `artifact-approval`; phase implementation's `commit-authorization`…" — rewrite; L85–86 gate/revision conventions adapt.

### docs/mcp/SERVER.md (stamp L3; Covers: src/main.ts, src/mcp/, src/state/semantic-*.ts)
- L24: "The gate composer covers every approval kind an offered gate can name — artifact and design approval, commit authorization, attempts exhaustion, and the `migration-audit` approval" — gate-kind enumeration changes.
- L26: gate projection description ("Combined design approval also projects each policy conflict or trigger") — trigger language may survive but the *sources* of triggers change (declarative ruleset, not constitution only).
- L34: "commit-bearing gates bind the exact authorized Git facts" — stays if commit gates survive in some form; rewrite if commit-authorization becomes trigger-conditional.
- L77: "config pin check" in the handler skeleton; retired-key tolerance prose — update when pinning becomes change reporting.

### docs/mcp/DISPATCH.md (stamp L3; Covers: src/dispatch/, src/mcp/handlers/counter-review.ts, src/state/semantic-actions.ts, src/state/workspace-cleanup.ts)
- L18 routing.ts bullet — **the reviewer-routing section**: "One counter-review call may also carry a `route_override` that substitutes the route for that dispatch alone — the outage escape hatch… It is validated through the same path as a pinned route, never amends the pinned config" — wiring per-dispatch overrides "through the semantic tools" (instead of the counter-review low-level request field) changes this paragraph and the referenced COUNTER-REVIEW section. "never amends the pinned config" also changes if pinning is dropped.
- The rest of DISPATCH.md (workspace, cli, process, coordinator) is routing-agnostic.

### docs/cli/COMMANDS.md (stamp L3; Covers: src/local/, src/state/request-composition.ts, src/init/, install.sh)
- L7: "Git stays client-owned; the semantic view returns the exact authorized commit facts" — survives in shape, but "authorized" provenance becomes ruleset-derived.
- L58: "The human approvals are the preview approval before `stage` and the migration-audit decision" — upgrade flow approvals; mostly unchanged.
- No config-mismatch remediation prose here (that lives in LIFECYCLE/DURABLE-STATE/status skill) — minor touches only.

### docs/review/COUNTER-REVIEW.md (stamp L3; Covers: src/review/, src/mcp/handlers/counter-review.ts, src/state/semantic-actions.ts, src/state/produce-subject.ts, src/state/evidence-results.ts)
- L5: "the producer's opposite model family by default… either family by explicit config" — routing defaults; extend for semantic-surface override wiring.
- L76–95 "The flow, end to end": step 4 route override mention ("the call may carry a **route override** (see below)"); step 5 constitution dispatch ("only when the pinned constitution has active rules"); step 8 human decision ("one `design-approval`… other phases retain their own gate sequence").
- L82–93 "Route overrides, for outages" — **whole section**: "The task's routing is byte-pinned at task creation and cannot be amended (see `../state/DURABLE-STATE.md`)" (opening sentence changes with un-pinning); "one counter-review call may carry a `route_override`" becomes a semantic `review` submission field; the disclosure-at-approval-gate paragraph adapts if approval gates become conditional.
- L97–118 "Constitution review": L101–107 lists the four shipped rules with one-line summaries — **update the `explicit-human-authority` summary to the amended v2 text**; L108 task-branch-edit paragraph stays.
- L120–140 "What the verdict opens": gate derivation after triage (`constitution-review` gate, `design-approval` folding) — trigger-rule interaction needs a paragraph (declarative subject/file-path triggers deciding whether a human gate opens at all).
- L142–148 waivers; L150–158 durable decisions / human-facing gates — presentation model survives, gate kinds adapt.

### docs/contracts/CONTRACTS.md (stamp L3; Covers: src/contracts/)
- L21 "Fingerprints and digests": "an `input_fingerprint` names everything a step depended on (workflow, config, constitution, rubric, upstream document identities) — with one deliberate exception: a counter-review `route_override` substitutes the dispatched route for a single call **without changing the fingerprint**…" — if config pinning is replaced by change reporting, the fingerprint's config input and this exception's framing change.
- L49 "Tool contracts & errors": "`design-approval` is a distinct durable union arm… `commit-authorization` additionally binds its target ref, baseline, deterministic message, sorted paths, and implementation diff" — gate-context contract descriptions change with the gate-model change.
- L54: schema generation note — new trigger-ruleset config shape joins the generated set.

### docs/state/DURABLE-STATE.md (stamp L3; Covers: src/state/, src/repository/, src/init/, src/local/, src/mcp/handlers/semantic.ts)
- L10–32 layout tree: `config.yaml` under task root ("pinned configuration") — comment-level change.
- L117 "State machine, gates, and Git boundary": "after `commit-authorization` settles, status returns the exact commit facts with `requires_human_confirmation: true`, the durable authorization stays the sole durable gate…" — core commit-model paragraph to rewrite.
- L127 "Document boundaries fail closed. A transition out of `prd` re-reads `artifact-approval`; transitions out of `design` and `phase-design-N` re-read `design-approval`" — approval re-verification model changes if those gates become trigger-conditional.
- L133: **config honesty paragraph** — "Retired config keys are accepted on read… pinned bytes that no longer parse under the installed tooling surface as `pinned-config-schema-unsupported` with an `upgrade-tooling` action instead of `restore-pinned-config`, because the pin compares bytes…" — the pinning/mismatch section that must be replaced by change-reporting semantics.
- L15 constitution/ under the authority tree (structural, stays).

### docs/COMPLEXITY.md (stamp L3; whole repo)
- Mostly historical audit; add/update entries if the change retires machinery (config pinning checks, gate composer arms). L17 "current top target" section describes the semantic cutover; a new simplification entry for the trigger model would belong here. Gate-related resolved items (#2 gates.ts split) stay historical.

### docs/PATTERNS.md (stamp L3; Covers: src/, test/, scripts/, repository policy)
- L71–75 "Semantic views hide mechanics" — gate/offer conventions; update if the submission unions grow trigger-rule fields or lose gate kinds.
- L117-120 multiple authorities / generated schemas — new config shape note.
- "repository policy" is in its Covers list, so a constitution amendment technically dirties this page's stamp; likely no content change beyond stamp.

### docs/DEPENDENCIES.md (stamp L3; Covers: package.json, tsconfig.json, scripts/, src/init/, release tooling)
- No gate/config-pinning prose. Only stamp refresh if `src/init/` (config scaffolding) changes.

### docs/TESTING.md (stamp L3; Covers: test/, vitest.config.ts, package.json, scripts/smoke-release-bundle.mjs)
- L37 skill-contract suites description ("Skill text and workflow trust boundaries, including one design approval, automatic design milestone commit…") — update as the contract tests change.
- L21 state/gate coverage description, L35 gate fixture prose, L47–51 semantic journey descriptions (commit authorization, explicit confirmation) — update to match renamed/changed tests.
- Counts (unit 103/104 files etc.) will drift; refresh.

### docs/LIMITATIONS.md (stamp L3; Covers: src/dispatch/, src/review/, src/init/diagnostics.ts, src/mcp/, src/state/)
- L83–87 "A reviewer route override is not proof a human chose it" — **whole limitation entry**: framing ("a substitute reviewer the human asked for") and mitigations (request-digest binding, evidence recording, disclosure at the approval gate) change when overrides are wired through the semantic tools and approval gates become conditional.
- L91–93 "Config schema evolution without migration" — **whole entry**: the no-re-pin/no-migration stance is exactly what the task removes or reshapes.
- L94–100 "One-hop simple revisions that retain an accepted finding" — wedge description references exhaustion-gate revise settlement; unaffected unless gate set changes.
- L7, L13: general "human gates" references in the preamble/mitigations.

---

## 4. Skills inventory — passages to rewrite under the trigger model

Files (all `skills/<name>/SKILL.md`; only `archflow-constitution` has an `agents/openai.yaml` extra):

| Skill | Lines | Approval/commit/mismatch prose to touch |
|---|---|---|
| `archflow-constitution` | 50 | Whole skill is the amendment procedure (see §1.5). If the design changes how amendments interact with trigger rules or adds tooling, update; otherwise only the shipped-rule references. |
| `archflow-prd` | 56 | L3 description "obtain explicit approval"; L48–51 "Human gates and hand-off" section: `gate-summary` opening `artifact-approval`-class presentations, "Stop for explicit human judgment", waiver flow. Under trigger rules: gates open only when the ruleset fires (default ruleset: PRD review = human review of PRD). |
| `archflow-design` | 48 | L3 description; L34–42 "Human decision, Git, and successor": `design-approval` presentation, decision submission, milestone commit choreography (L40) — the default ruleset ("review architecture") maps here. |
| `archflow-phase-design` | 48 | L3 description ("before code may be written"); L34–42 same gate/decision/commit sections as design. |
| `archflow-phase-impl` | 52 | L3 description ("authorize"); L38–44 "Commit authorization and the commit itself": "This opens the mandatory nonblocking `commit-authorization` presentation even when no trigger gate opened" (L40) and the whole `authorize-commit` → `requires_human_confirmation: true` → client-held confirmation choreography (L44) — **the central commit-gate rewrite**; SQL-file trigger → approve is the new default path here. |
| `archflow-status` | 32 | L30 **config-mismatch remediation paragraph**: "When configuration is not verified, explain which kind of configuration changed and that an intentional routing, model, or effort change needs a distinct new task or the explicit upgrade workflow. When the next action is `upgrade-tooling`… pinned bytes are exact but this installed ArchFlow cannot parse their schema…" — replaced by change-reporting messaging. L14 gate-presentation prose adapts. |
| `archflow-upgrade` | 53 | L12 preview approval (conversational, stays); L36 migration-audit gate; L42 import-commit authority; L49 "Never infer acceptance, approval, a commit…" — adapt wording to trigger model; the local choreography stays. |
| `archflow-init` | 14 | L10 "Ask the human conversationally to review and commit the scaffolded policy" — policy-base creation; stays, minor wording. |
| `archflow-explore` | 64 | L44–52 review/commit gate for docs (conversational, not server gates) — unaffected; listed for completeness. |

Cross-cutting prose in every producer skill: the "There is no optional review at the end. (A `baseline-adoption` presentation is the exception…)" parenthetical (prd L48, design L36, phase-design L36, phase-impl L40), and "Stop for explicit human judgment…" blocks — these encode the built-in-gate model and need conditional language under trigger rules.

**Contract-test coupling**: `test/contracts/skill-contract-canonical.test.ts` pins exact substrings of all this prose. Assertions that will break and must be updated in the same change include (non-exhaustive):
- L186 `approval of the final bytes`, L189 `automatically runs a fresh (opposite-client )?counter-review plus constitution review` (revision classification — all four producer skills).
- L165–180 "keeps human gates conversational": `there is no optional`, `ask one direct question`.
- L221–243 phase-impl pin: `{"kind":"gate-summary","summary":<summary>}`, `separate no-submission `open-waiver``, `requires_human_confirmation: true`, `commit.paths`, `create the commit yourself`, `observes the commit proof`.
- L256–288 document-skill pin: gate-summary/decision/open-waiver substrings, `returned `commit` facts`.
- L318–336 upgrade pin: `one `migration-audit` gate instead of separate PRD and design approval gates`, `create the commit yourself`.
- L367–370 CLAUDE.md ≡ AGENTS.md byte-identity — any CLAUDE.md hard-rule narrowing must be mirrored.
Also `test/contracts/skill-contract-upgrade.test.ts` and `skill-contract-server-outage.test.ts` pin further prose.

---

## 5. Tests / release validating constitution text and docs consistency

- `test/unit/constitution.test.ts` — **pins the shipped rule set**: loads `assets/constitution/` and asserts the registry keys are exactly `["explicit-human-authority", "approved-design-before-code", "task-and-evidence-isolation", "honest-human-centered-outcomes"]` (first `it`, lines ~11–17). Text edits pass; ID changes or additions break it. Also covers frontmatter parsing, duplicate IDs, plain-JSON preflight, and `validateConstitutionEvolution` (version-bump / no-delete / no-reactivate semantics).
- `test/contracts/release-contracts.test.ts` L95–97 — `assets/constitution/00-process.md` and `README.md` are enumerated release payload; the release manifest (`scripts/release-support.mjs`) ships them, so an amended seed changes the tracked `dist/` payload and must go through the release checks (`npm run check:release`).
- `test/contracts/skill-contract-canonical.test.ts` — see above; also enforces the constitution skill stays documentation-only (L135–143) and CLAUDE.md≡AGENTS.md (L367–370).
- `test/integration/status-reentry-edit.test.ts` L62–76 — writes its own fixture constitution into a temp repo (deletes shipped rules, writes a `20-data.md` fixture); not text-coupled to the shipped rules.
- No test validates the maintained `docs/` set's content; only `docs/validation/*` digests are digest-bound (`test/real-host/host-selection.test.ts:560`, `review-benchmark.test.ts`). Docs currency is the explore-skill stamp mechanism plus the CLAUDE.md rule.
- Constitution-related production seams for the design: `src/state/constitution.ts` (resolve/detect, above), `src/contracts/fingerprints.ts` (`computePinnedConstitutionDigest`), `src/contracts/gates.ts` (gate kinds/contexts/decisions), `src/state/gate-core.ts:47` (constitution-edit decisions), `src/contracts/durable-gate.ts:234,290,372,392` (archive arms), `src/contracts/config.ts` (task config contract — pinning), `src/state/status.ts:750–751,1192` (`pinned-config-schema-unsupported`), `src/contracts/errors.ts:120` (`PINNED_CONFIG_MISMATCH` → `restore-pinned-config`; `POLICY_BASE_INVALID`; `WORKFLOW_MISMATCH` → `restore-pinned-workflow`), `src/state/next-action.ts:17,271` + `src/state/semantic-view.ts:246` (restore-pinned-config action projection).
