> **Design lineage:** This is the preserved originating design for the MCP integration. The approved [product requirements](../.archflow/tasks/mcp-integration/prd.md) and [architecture](../.archflow/tasks/mcp-integration/architecture.md) are normative wherever they differ from this document.

# Archflow — Detailed Design

**Scope:** what changes in the skills, what the constitution looks like, and what the bundled MCP server does.
**Constraint:** Archflow must be fully usable with nothing but a terminal and a coding agent. Archforge is an optimization, never a dependency.

---

## 1. Repo layout

The Archflow folder is scaffolded into every repo it operates on. The skills themselves install to the agent's skills directory (`~/.claude/skills/`, `~/.agents/skills/`) and are not part of the repo.

```
<repo>/
  .archflow/
    workflow.yaml              # phase graph — the machine-readable workflow definition
    constitution/
      README.md
      00-process.md
      10-architecture.md
      20-data.md
      30-product.md
    <existing global documents>       # conventions, stack, glossary
    tasks/
      <task>/
        config.yaml            # model routing; written by human or Archforge
        state.json             # current phase/step/status
        gate.json              # present only while a gate is open
        gate.decision          # written by human or Archforge to resolve a gate
        prd.md
        design.md
        phases/<n>/design.md
        phases/<n>/impl-notes.md
        reviews/
          <phase>.self.md
          <phase>.counter.md
          <phase>.triage.md
          <phase>.adjudication.md
```

### 1.1 `workflow.yaml`

Archflow owns the phase graph and publishes it so that anything driving the workflow — a human reading it, or Archforge — knows what comes next without hardcoding.

```yaml
phases:
  - id: explore
    skill: archflow-explore
    pipeline: [produce]
    gate: never
    optional: true
  - id: prd
    skill: archflow-prd
    pipeline: [produce, self_review, counter_review, triage, adjudicate]
    gate: always
  - id: design
    skill: archflow-design
    requires: [prd]
    pipeline: [produce, self_review, counter_review, triage, adjudicate]
    gate: always
  - id: phase-design
    skill: archflow-phase-design
    requires: [design]
    iterates: per_phase
    pipeline: [produce, self_review, counter_review, triage, adjudicate]
    gate: on_trigger
  - id: phase-impl
    skill: archflow-phase-impl
    requires: [phase-design]
    iterates: per_phase
    pipeline: [produce, self_review, counter_review, triage, adjudicate]
    gate: on_trigger
```

`gate: on_trigger` means a human is involved only if a constitution `review_trigger` fires, drift is material, adjudication fails, or attempts are exhausted.

---

## 2. Skills become marshallers

### 2.1 The pipeline

Every phase skill runs the same sequence. What varies is the rubric and the artifact.

```
1. PRODUCE      author the artifact, with constitution injected as constraints
2. SELF REVIEW  in-session subagent, craft rubric
3. COUNTER      MCP dispatch to the other model family, fresh context
4. TRIAGE       reconcile findings; accept or reject each with a reason
5. ADJUDICATE   constitution compliance + drift against approved upstream docs
6. GATE         raise if required by workflow.yaml or by a trigger; otherwise advance
```

Each step calls `archflow_state` on entry and exit. Each step writes a file. Nothing is passed only in conversation.

### 2.2 What changes in each existing skill

| Skill | Change |
|---|---|
| `archflow-explore` | Produce only. No review pipeline, no gate. Output is disposable. |
| `archflow-prd` | Add pipeline steps 2–6. Gate always. |
| `archflow-design` | Add pipeline steps 2–6. Gate always. |
| `archflow-phase-design` | Add pipeline steps 2–6. Gate on trigger. Drift measured against `design.md`. |
| `archflow-phase-impl` | Add pipeline steps 2–6. Gate on trigger. Drift measured against `phases/<n>/design.md` and `design.md`. |
| `archflow-status` | Read `state.json` instead of inferring from artifacts. |
| *(new)* `archflow-init` | Scaffold `.archflow/` into a repo: workflow.yaml, constitution templates, globals. |

### 2.3 Rubrics

Step 2's rubric is bound per phase:

- **Artifact phases (prd, design, phase-design)** — completeness, internal consistency, unstated assumptions, testability of requirements, does this answer the brief.
- **Implementation phases (phase-impl)** — DRY, simplicity, matches the phase design, dead code, error handling, does each abstraction earn its keep.

Step 3 uses the same rubric but with an adversarial framing and fresh context: *find what's wrong with this*, not *polish this*.

### 2.4 Hard requirements on skill behavior

1. **Deterministic overwrite.** Re-running a phase on a dirty worktree produces the same result as running it clean. No appending, no "I see a partial PRD exists." This is what makes retries safe.
2. **Structured verdict headers.** Every review artifact opens with frontmatter that can be parsed without reading prose:
   ```yaml
   ---
   phase: prd
   step: counter_review
   verdict: pass | fail | advisory
   blocking_count: 2
   review_triggers: [DATA-3]
   model: <model string>
   ---
   ```
3. **No host branching.** Skills contain zero logic keyed on whether they're running in Claude Code or Codex. If a skill needs to know, the decision is in the wrong layer.
4. **Degrade cleanly.** If the MCP server is unreachable, each tool has a documented fallback (§4.4). The skill still completes; it just asks more of the human.

---

## 3. The constitution

### 3.1 Placement and scope

One constitution per repo, at the top level of `.archflow/`, applying to every task in that repo. Different repos legitimately differ. There is no per-task or per-branch scope.

**Invariants:**

1. **Tasks consume, never author.** A task cites, fails, or requests a waiver against a rule. It cannot add or edit one.
2. **A waiver is not an amendment.** Waivers are per-task, recorded in `state.json`, and expire with the task.
3. **Stable rule IDs.** `DATA-3`, not "the migration one." Append and deprecate; never renumber or reuse.
4. **Versioned with the repo.** Amendments go through normal code review on the base branch.

### 3.2 The worktree hazard

The constitution is a file in a repo the agent can write to. A producer can edit the rule blocking it — this is a realistic agent shortcut, not a paranoid edge case. Two required mitigations:

1. **Adjudication reads the constitution from the base ref.** `git show <base>:.archflow/constitution/...`, never `cat`. A task is judged against the rules that existed when it started. The skill does this directly; no MCP tool needed.
2. **Any diff touching `.archflow/constitution/` in a task branch is an unconditional gate**, regardless of phase or verdict.

### 3.3 Rule format

```markdown
## DATA-3 — Schema changes require human review
Any change that adds, alters, or drops a table, column, index, or constraint
must be reviewed by a human before the phase advances.

review_trigger: artifact adds or modifies a migration
rationale: schema changes are expensive to reverse and easy to get subtly wrong
```

```markdown
## STACK-2 — No new runtime dependencies without approval
enforced_by: lint rule `no-unapproved-deps`
review_trigger: dependency manifest modified
```

`review_trigger` is what makes a phase stop even when it passes. `enforced_by` tells the adjudicator a rule is checked mechanically so it doesn't spend attention re-deriving it.

### 3.4 Constitution as input, not just check

Applicable rules are injected into the producer's context at step 1. The adjudicator is a **backstop confirming compliance**, not a discovery mechanism. If adjudication routinely finds violations, the injection is broken — fix the input, not the check.

Rules mechanically enforced still belong in the constitution. The constitution is the single source of truth for what's mandatory; the linter is an implementation detail of how some rules get checked. A rule that lives only in lint config becomes tribal knowledge.

### 3.5 Drift

Adjudication returns two independent verdicts. The second asks: **does this still live inside the PRD and architecture that were approved?**

- `aligned` — proceed.
- `incidental` — small clarifications that don't change intent. Recorded, no stop.
- `material` — contradicts, expands, or invalidates something approved. Gate. Resolution is usually to amend the upstream document and re-gate it, not to bend the phase back into shape.

Keep `material` narrow or the automation goal dies. Guidance: material means *a reader of the approved document would be surprised* — a new external dependency, a changed contract, a dropped requirement, a different data model. Adding a helper is not material. Silently choosing a different library than the architecture named is.

---

## 4. The MCP server

Bundled with Archflow. Runs locally, spawned by the host over stdio. Its job is to give the agent workflow capabilities that a prompt cannot provide: spawning another model, persisting structured state, and blocking on a human.

### 4.1 Tools

| Tool | Signature (shape) | Effect |
|---|---|---|
| `archflow_state` | `(phase, step, status, artifact?)` | Write `state.json`. Cheap, called at every step boundary. |
| `archflow_counter_review` | `(artifact_path, rubric)` → `{path, verdict, blocking_count}` | Spawn the other model family with fresh context; write `reviews/<phase>.counter.md`; return the parsed verdict. |
| `archflow_adjudicate` | `(artifact_path, upstream_paths[])` → `{constitution, drift, triggers[]}` | Spawn adjudicator with the base-ref constitution and approved upstream docs; write `reviews/<phase>.adjudication.md`. |
| `archflow_gate` | `(phase, summary, context)` → `{decision, notes}` | Write `gate.json`, block until `gate.decision` appears, return it. |
| `archflow_waiver` | `(rule_id, rationale)` → `{granted, notes}` | Same blocking mechanism as gate; records to `state.json` on grant. |

Five tools. Resist adding more — anything the skill can do with `git` or file reads should not be a tool.

### 4.2 Host detection

The MCP `initialize` handshake carries `clientInfo: {name, version}`. The server reads it and knows definitively which host it's serving. Skills never ask, and never rely on a model's self-report of its own identity — models misidentify their versions routinely, and host context in system prompts drifts between releases.

### 4.3 Model routing

Defaults ship with the server, keyed on `clientInfo`:

| Host | producer | self-review | counter-review | adjudicator |
|---|---|---|---|---|
| Claude Code | host model | host model, in-session subagent | Codex family | Codex family |
| Codex | host model | host model, in-session subagent | Claude family | Claude family |

**One rule, two bindings.** The author writes; a subagent on the same model does the cheap craft pass; the other family provides the adversarial pass. Self-review stays in-session deliberately — its value is being cheap and context-local, and dispatching a separate process for it spends counter-review budget on the least discriminating pass in the pipeline.

`tasks/<t>/config.yaml` overrides the defaults. Written by hand in manual mode, by Archforge in driven mode:

```yaml
roles:
  counter-reviewer: { model: <string>, reasoning: high }
  adjudicator:      { model: <string>, reasoning: high }
overrides:
  design:
    counter-reviewer: { model: <stronger model>, reasoning: high }
```

Model strings are configuration, never hardcoded in skills or server source.

**Dispatch flags.** For Codex the server uses `-m <model>` plus `-c model_reasoning_effort="<level>"`, or a named `--profile`. For Claude, `--model` plus thinking budget. Counter-review and adjudication run at higher reasoning effort than authoring — they're short, single-artifact calls where depth is cheap and being wrong is expensive.

*Constraint:* a resumed Codex session inherits the original model and reasoning effort; they cannot be overridden on resume. Any "retry with more effort" path must be a clean re-dispatch.

### 4.4 Invariants

1. **Counter-reviewer family ≠ producer family.** Validated at dispatch. Same-family is a hard error, not a warning — it looks like coverage and isn't.
2. **Counter-review context is fresh.** No producer session history, no triage output, no earlier findings. Artifact and rubric only.
3. **Rate-limit exhaustion fails loud.** If the counter-review family is unavailable, the step fails with a distinguishable error. It never silently falls back to same-family.
4. **Blocking tools are genuinely blocking.** `archflow_gate` waits on a file, with a long timeout. It does not poll-and-return, and it does not invent an approval.

### 4.5 Degraded operation

The server is bundled with Archflow, so its absence should be rare — but the skills document a fallback for each tool so the workflow survives a broken install:

| Tool | Fallback |
|---|---|
| `archflow_state` | Skip. Status is reconstructable from artifacts on disk. |
| `archflow_counter_review` | Emit a ready-to-paste cross-client prompt (current ArchflowV2 behavior) and stop. |
| `archflow_adjudicate` | Run as an in-session subagent against the base-ref constitution. Weaker (same model) but functional. |
| `archflow_gate` | Print the decision summary and stop. |
| `archflow_waiver` | Print the request and stop. |

### 4.6 Implementation notes

- **Language:** Node/TypeScript for distribution ease (`npx`, no runtime install for most developers). Rust is defensible if you later want Archforge to embed the server in-process, but separate processes keep the standalone story simple and the coupling honest.
- **Transport:** stdio. Local only. No network listener.
- **Registration:** `archflow-init` writes the server into `.mcp.json` (Claude Code) and `~/.codex/config.toml` (Codex).
- **Sub-dispatch:** counter-review and adjudication spawn short-lived non-interactive CLI processes (`claude -p`, `codex exec`) under the user's existing subscription auth. Never require API keys. Never export `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` into the child environment — they shadow subscription auth and silently switch to metered billing.

---

## 5. Validation criteria before starting Archforge

Archflow is done when, using only a terminal:

1. A feature goes from PRD to merged implementation through every phase.
2. Counter-reviews produce findings the producer actually had to act on — if they come back with restatements and nitpicks, the premise of the whole design is wrong and Archforge shouldn't be built on it.
3. A constitution violation is caught, and the waiver path works.
4. A material drift is caught at phase-impl and correctly escalates.
5. Re-running a phase on a dirty worktree produces a clean, identical result.
6. `state.json` accurately reflects position at every point, verified by killing a session mid-phase and reading the file.

Item 2 is the one that matters. The rest is mechanics.