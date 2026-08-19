# Phase 2 exploration: skill prose insertion points, contract pins, dist loop

Task `review-flexibility`, phase 2 preparation. All paths absolute under the repo root
`/home/aroton/ArchflowV2.feature-review-override-flexibility`. Read-only exploration; this file is the only write.

## 1. The five skill files: structure and insertion points

### skills/archflow-prd/SKILL.md (56 lines)

Headings: `# Product Requirements Document` (line 6), `## Degraded operation` (14), `## Production and review` (18), `## Triage and revision` (40), `## Human gates and hand-off` (46).

Counter-review dispatch is described twice:

- Line 12: "The server identifies the producer family from the initialize handshake of the connected client and dispatches the configured counter-review (opposite-family by default), plus the constitution review when the repository has active constitution rules; you never perform, spawn, or simulate either."
- Line 38 (end of `## Production and review`) — **the natural insertion point** for the outage paragraph:

> "Submit the finished bytes through the current offer with `{\"kind\":\"work-result\",\"outcome\":\"succeeded\"}` (or the offered failed form with a concrete reason). Do not supply paths, policy, routing, digests, revisions, or other server-owned facts. Apply the next no-submission `review` offer. The server selects the independent configured rubric and constitution review (opposite-family by default) from the returned `review_context`; never perform, spawn, simulate, or replace that review."

Note the direct tension to resolve in wording: "Do not supply paths, policy, routing, digests..." — the new prose must carve out the human-authorized `route_override` as the one routing fact the submission carries.

- Line 16 (Degraded operation) defines *tool* unavailability: "If either semantic workflow tool is unavailable, run read-only `archflow-local manual-status --task <task>`, report its position, and stop." The outage paragraph must distinguish reviewer-route failure (server reachable) from this stop rule.

### skills/archflow-design/SKILL.md (48 lines)

Headings: `# Task Design` (6), `## Degraded operation` (14), `## Production and independent review` (18), `## Triage and revision` (26), `## Human decision, Git, and successor` (34).

- Line 12: same dispatch paragraph as prd ("dispatches the configured counter-review (opposite-family by default)... you never perform, spawn, or simulate either") plus "the counter-review dispatch runs in the background while any same-side review sub-agents run."
- Line 24 — **insertion point**, end of `## Production and independent review`:

> "For a same-side review, use the returned `review_context.rubric` verbatim and its active rules; never author durable review policy. Then submit the completed bytes with `{\"kind\":\"work-result\",\"outcome\":\"succeeded\"}`. Do not submit paths, routing, policy, fingerprints, digests, or revisions. Apply the offered no-submission `review` action. The server derives and runs the configured rubric and constitution review (opposite-family by default); never perform, spawn, simulate, or replace it."

### skills/archflow-phase-design/SKILL.md (48 lines)

Headings: `# Phase Design` (6), `## Degraded operation` (14), `## Production and independent review` (18), `## Triage and revision` (26), `## Human decision, Git, and hand-off` (34).

- Line 12: same dispatch paragraph as design.
- Line 24 — **insertion point**, end of `## Production and independent review`:

> "For same-side review use `review_context.rubric` verbatim and its active rules; never author durable review policy. Submit the completed current artifact and any parent updates with `{\"kind\":\"work-result\",\"outcome\":\"succeeded\"}`. Do not name paths or author routing, policy, fingerprint, digest, or revision fields. Apply the offered no-submission `review`; the server derives and runs the configured rubric and constitution review (opposite-family by default). Never perform, spawn, simulate, or replace that independent review."

### skills/archflow-phase-impl/SKILL.md (52 lines)

Headings: `# Phase Implementation` (6), `## Degraded operation` (14), `## Production and verification` (18), `## Review and triage` (28), `## Commit authorization and the commit itself` (38), `## Completion and hand-off` (46).

- Line 12: same dispatch paragraph; "the counter-review dispatch runs in the background while any same-side review sub-agents run."
- Line 24 already covers one dispatch failure mode (a precedent for failure-specific guidance): "When a counter-review fails with ENVELOPE_OVERFLOW, diagnose compact output declarations and mandatory pinned evidence; do not infer from source-file size that the approved phase must be split, and never trim authenticated evidence to evade the cap."
- Line 30 — **insertion point**, top of `## Review and triage`:

> "Apply the offered no-submission `review`. The server derives the subject from durable authority, pins the transcript, and dispatches the configured rubric review plus the constitution review when active rules exist; never perform, spawn, simulate, or replace it. A dispatch may legitimately run many minutes, so run the call in the background rather than assuming a hang."

### skills/archflow-init/SKILL.md (14 lines)

Headings: `# Initialize ArchFlow` (6) only; no sub-headings. Body is five paragraphs (lines 8, 10, 12, 14).

- **Insertion point**: a new paragraph after line 14 (or between 12 and 14). Line 14 is the scaffolding paragraph — the natural anchor for config routing guidance:

> "Initialization creates no task state and no commit. It scaffolds `.archflow/.gitignore` with the single rule `/runtime/`, reports whether that nested ignore file was created or already present, and diagnoses both whether `.archflow/runtime/` is ignored and whether any path below it is already tracked. It also reports generated ArchFlow policy or MCP registration files hidden by an ancestor ignore rule. It never edits the project root `.gitignore`; ask the human to review that rule and explicitly add only the intended generated files. Ask the human conversationally to review and commit the scaffolded policy and host-registration files before starting a task; summarize their purpose instead of dumping an internal path inventory, while retaining that inventory for an explicitly requested diagnostic report."

The init skill currently never mentions `config.yaml`, routing, or roles at all — the new paragraph is wholly new ground. Schema to reference: `configOverridesSchema` at `src/contracts/config.ts:27`:

```ts
export const configOverridesSchema = z.object({
  explore: configRolesSchema.optional(),
  prd: configRolesSchema.optional(),
  design: configRolesSchema.optional(),
  "phase-design": configRolesSchema.optional(),
  "phase-impl": configRolesSchema.optional(),
}).strict();
```

Roles shape (`src/contracts/config.ts:22-25`): `counter-reviewer` and `adjudicator` routes (`ROUTING_ROLES`, line 6), each `configRouteSchema` = `{ model, effort, provider? }` (lines 9-15; `provider` is an optional cc-switch provider id, claude routes only; efforts are `low|medium|high|xhigh|max|ultra`, line 7). The `overrides` key sits on `configV1Schema` (line 38). `assets/config.template.yaml` already documents exactly this (see §7 below) — init prose should agree with the template, not restate a different shape.

## 2. Grep of skills/ for overlap terms (override, outage, unavailable, substitution, route, counter-reviewer, adjudicator, provider, model, effort)

Zero hits anywhere in skills/ for: `outage`, `substitut*`, `route_override`, `provider` (as a config field), and `counter-reviewer`/`adjudicator` (the routing role names appear nowhere in any skill). "Routing" appears only as a *prohibited submission field* (prd:38, design:24, phase-design:24: "Do not supply/submit... routing..."). No skill describes a reviewer-route failure today — the new prose is greenfield.

Existing uses that interact:

1. **"override"** appears only as `human_revision.user_override` (revision-classification override, a different concept) in prd:44, design:32, phase-design:32, phase-impl:36, upgrade:38. Risk: word collision. The new prose should always say "route override" / `route_override` and never bare "override" near the revision sentences.
2. **"unavailable"** appears in every skill's Degraded operation section (init:10, prd:16, design:16, phase-design:16, phase-impl:16, upgrade:53, status:26/32) — always about MCP tool/helper unavailability with a hard stop. The new outage paragraph must be scoped to "the configured reviewer route is unavailable/failing while the workflow tools are up" or it will read as contradicting the stop rule (and vice versa).
3. **`archflow-status` line 30** (see §7) treats "routing, model, or effort change" as a config-mismatch remediation topic. The new per-dispatch override is not a config edit; prose must not imply editing `config.yaml` mid-gate or the status skill's current "distinct new task or explicit upgrade workflow" remediation would contradict it.
4. **archflow-constitution** (lines 8, 12, 40), **archflow-explore**, **archflow-upgrade** (line 38 revision override, line 53 unavailability): no route/outage content; nothing to duplicate or contradict. Explore and constitution are untouched by phase 2.
5. **CLAUDE.md hard rule** (repo root): "The server-dispatched counter-review (opposite client family by default) runs automatically before a human gate. There is no optional review at the end of a gate." The override must be framed as parameters of the same automatic dispatch, never as choosing whether to review.

## 3. Contract pins on the skills

### Mechanism

**Substring/regex assertions against the live `skills/` files — no canonical copies, no stored fixtures, no byte-compare.** `test/contracts/skill-contract-canonical.test.ts:50-52`:

```ts
function skill(name: typeof skillNames[number]): string {
  return readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");
}
```

then hundreds of `expect(source).toContain("...")` / `toMatch(/.../u)` checks. Same pattern in `skill-contract-upgrade.test.ts` (upgrade only) and `skill-contract-server-outage.test.ts` (which enumerates every directory under `skills/` via `readdirSync`, line 18). The only byte-compare in the canonical suite is `CLAUDE.md` vs `AGENTS.md` (lines 367-370). `canonical-parity.test.ts` is unrelated to skills (release-support.mjs primitive parity).

### Constraints that bite when editing the five files

From `skill-contract-canonical.test.ts`:

- Lines 86-98: every `archflow-local <cmd>` must be in `LOCAL_COMMANDS`; every `archflow_[a-z_]+` token must be in `ADVERTISED_TOOL_NAMES` (exactly `archflow_status`, `archflow_apply`); **every SCREAMING_SNAKE word (regex `\b[A-Z][A-Z_]+\b` with an underscore) must be a key in `PROJECT_ERROR_DEFINITIONS`** — do not invent new ALL_CAPS identifiers in the new prose (lowercase `route_override`, `counter-reviewer` are safe).
- Lines 100-109 + outage test 31-40: banned strings `manual-next`, `manual-handoff`, `archflow-local checkpoint`, and **the word "checkpoint" in any skill** (`/\bcheckpoint/iu`, outage test line 38) — the outage paragraph must not say "checkpoint".
- Lines 111-117: frontmatter must have exactly the keys `description` and `name`.
- Lines 118-133: `normalPhaseSkills` (prd, design, phase-design, phase-impl, status) must keep "Claude:" and "Codex:"; producer skills keep `` `review_context.rubric` ``, `` `resources` ``, `{role,path,access}` etc.
- Additive paragraphs do not disturb any `toContain` pin — the pins require presence of existing strings, never full-file equality.

### Update order when the five skills are edited

1. Edit `skills/*/SKILL.md` (any order; independent files).
2. Run `npx vitest run test/contracts/skill-contract-canonical.test.ts test/contracts/skill-contract-server-outage.test.ts` — they read the live files, so they pass immediately if the additive prose avoids the banned vocabulary; nothing else must be regenerated for the skill prose itself.
3. If phase 2 wants to *pin* the new outage/override prose, add new `toContain` assertions to `skill-contract-server-outage.test.ts` (natural home; its doc comment frames the outage contract) or the canonical test — in the same change, after the prose text is final.
4. No fixture or canonical-copy step exists. `skill-contract-upgrade.test.ts` is unaffected (it pins `skills/archflow-upgrade/SKILL.md` only, plus presence of "archflow-upgrade" in install.sh/CLAUDE.md/AGENTS.md/README.md).
5. If CLAUDE.md's hard-rule prose is touched (not required by the task description), mirror byte-identically into AGENTS.md (canonical test 367-370).

Other pins found: `test/integration/install-script.test.ts` and `test/integration/dispatch-plumbing.test.ts` reference `skills/` only as copied fixtures/directories (behavioral install tests, no prose pins). `test/real-host/terminal-journey.test.ts` and `host-selection.test.ts` reference installed skill directories for digest trees (unrunnable in this environment — pre-existing; see impl-notes line 26). No other test in `test/` reads the five SKILL.md files.

## 4. skill-contract-server-outage.test.ts TODAY

Its doc comment (lines 9-15) states the current outage contract — entirely about **MCP server** unavailability, not reviewer routes:

> "The server-outage contract: when the MCP server is unavailable the skills stop, report the read-only classified position, and wait — there is no offline recording path. The retired manual workflow (manual-next, manual-handoff, checkpoint files) must not resurface in any skill, and archflow-status must drive read-only archflow_status as its primary path, keep manual-status as its only fallback helper, and document the classification modes with wait guidance."

Current assertions:

- Line 23-29: `LOCAL_COMMANDS` contains `manual-status` and not `manual-next`/`manual-handoff`/`checkpoint`/`import`.
- Lines 31-40: **every** skill (readdir over `skills/`) contains no `manual-next`, no `manual-handoff`, no `archflow-local checkpoint`, and no `/checkpoint/i` at all.
- Lines 42-49: status skill drives read-only semantic status, `manual-status` fallback.
- Lines 51-59: staged-legacy-import classification before recommending initialization.
- Lines 61-65: status never applies; `` `archflow_apply` `` appears exactly once.
- Lines 67-73: status documents `normal`, `degraded`, `repair-required`, `upgrade-staged`, `upgrade-restart-required` with "workflow must wait for the server", "there is no offline recording", "Do not reconstruct a status while both server and helper are unavailable".
- Lines 75-92: status names no retired tools/choreography.

Nothing today covers reviewer-route outage or route overrides. Phase 2's paragraph **extends** this file's subject matter without violating any current expectation, provided it introduces no banned vocabulary ("checkpoint" especially) and does not frame route failure as a reason to stop/record offline (that remains the server-unavailable rule).

## 5. skills → dist → install flow

- `install.sh:7` `SKILLS_SOURCE_DIR="$SCRIPT_DIR/skills"`; `install_skills()` (lines 95-120) copies the checkout's `skills/` directly into `~/.claude/skills` and `~/.agents/skills` with an ownership manifest. The skills never pass through `dist/`.
- `dist/manifest.json` contains **zero** entries under `skills/` (grep count 0). `runtime_assets` = `assets/*` only; `artifacts` = the two executables, legal files, manifest, metafile; `release_control_inputs` = package files, scripts, src schemas, release tests — no skills paths.
- Therefore **editing skills/ alone requires no dist rebuild**. However phase 2 also edits `src/` (semantic `review` action gains `route_override`; the low-level plumbing already exists from #5: `src/contracts/mcp-tools.ts:76-81,188-197` `RouteOverrideDeclaration`/`routeOverrideSchema`, `src/contracts/review.ts:168,196`, `src/contracts/fingerprints.ts:76-259`, `src/dispatch/cli.ts`, `src/review/counter-review.ts`), and **any src change requires regenerating the tracked `dist/`** or `test/integration/release-offline.test.ts` fails: it runs `scripts/check-release.mjs --payload dist`, whose `scripts/release-support.mjs:642` throws `stale bundle input: ${record.key}` when a manifest `bundle_inputs` digest no longer matches the source bytes. (`release-contracts.test.ts` is a schema-shape test on a synthetic manifest — not the staleness guard.)
- Rebuild loop (confirmed by phase-1 impl-notes and `scripts/write-tracked-release.mjs` usage string): `npm run release:stage -- --output <tmpdir>` then `npm run release:write -- --stage <tmpdir>`. `npm run check:release` runs the full verification suite over `dist`.
- Reaching installed skills additionally needs `./install.sh` — machine-global write, **requires explicit per-action user request** (CLAUDE.md hard rule; memory note). Do not install as part of phase 2 unless the user asks.

## 6. Phase 1 impl-notes gotchas worth repeating (`.archflow/tasks/review-flexibility/phases/1/impl-notes.md`)

- Line 41 (Gotchas): "The tracked `dist/` bundle must be rebuilt after any src change or `release-offline` fails with 'stale bundle input' — `npm run release:stage -- --output <tmpdir>` then `npm run release:write -- --stage <tmpdir>`." — phase 2 must repeat this loop for its src edits (skill-prose-only edits would not need it).
- Line 36: name tests for behavior, not phase (`config-editing.test.ts` precedent) — any new contract pins should follow behavior naming (e.g. extend `skill-contract-server-outage.test.ts` rather than creating phase-named files).
- Line 25: tracked `dist/` rebuild listed as an ordinary part of the change set when src changes; `release-offline`/`install-script` verify the bundle against src inputs.
- Line 26/66: `test/real-host/terminal-journey.test.ts` is not runnable here (drives retired local-CLI commands; pre-existing failure at fixture setup) — do not treat its red state as caused by phase 2.
- Line 40: `createProductionServices` caches the state snapshot; fresh services instance after on-disk rewrites in tests.
- Line 42: a `z.json()` field in a schema-generated document needs the registered-def + hand-fragment pattern (`PLAIN_JSON_FRAGMENT` from `schema-generation-durable.ts`) — relevant if phase 2's review-submission schema changes regenerate schemas (`npm run generate:schemas` / `check:schemas` in the `check` chain).

## 7. archflow-status today (context only — owned by a later phase)

`skills/archflow-status/SKILL.md:30`:

> "When configuration is not verified, explain which kind of configuration changed and that an intentional routing, model, or effort change needs a distinct new task or the explicit upgrade workflow. When the next action is `upgrade-tooling`, nothing changed — the pinned bytes are exact but this installed ArchFlow cannot parse their schema, so say the task needs tooling that accepts its pinned configuration (or a restart under the current schema), never a config edit or restore. Keep the expected and observed digests available for diagnostics, but do not show them unless the user asks."

This sits in the degraded/fallback (helper-classified) path. Note the tension phase 2 should not worsen: since phase 1, `assets/config.template.yaml` says config is "an ordinary editable input: edit it at any point and the next workflow step uses the new values. Status reports field-level changes since the last state transaction — nothing blocks", while status:30 still carries the older "distinct new task or the explicit upgrade workflow" remediation for unverified config. The new init routing/overrides prose should follow the template's editable-input semantics; the status reconciliation is a later phase's job. Also relevant for consistency: `assets/config.template.yaml` already documents `overrides` and `provider` (lines 23-44) — quote-worthy anchor for init's new paragraph:

> "# Optional. Per-phase-kind role overrides on top of the default roles above. Each key is a phase kind (explore, prd, design, phase-design, phase-impl) and its value is the same roles shape, listing only the routes to override for that kind. The schema is `configOverridesSchema` in src/contracts/config.ts."

## Contradiction-risk summary

1. "Do not supply/submit ... routing ..." (prd:38, design:24, phase-design:24) vs submitting `route_override` — word the override as the single human-authorized exception carried with the review submission.
2. Degraded-operation stop rule (all four, line 16) vs route-outage continuation — scope the new paragraph to the server being reachable and only the reviewer route failing.
3. Bare "override" = revision classification (prd:44, design:32, phase-design:32, phase-impl:36) — always write "route override"/`route_override`.
4. status:30 config-mismatch remediation — do not imply a route override edits `config.yaml` or is a config change.
5. Contract vocabulary filters — no `archflow_*` tool names, no `archflow-local` commands, no SCREAMING_SNAKE tokens, no "checkpoint" anywhere in skills/.
6. CLAUDE.md hard rule "no optional review" — the override parameterizes the automatic dispatch; it must never read as opting out of review.
