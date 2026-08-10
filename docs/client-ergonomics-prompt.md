# Prompt: client ergonomics — what the driving agent needs from the helper and tool surface

Copy everything below the line into a fresh planning session. The voice is deliberately the *client's*:
the agent session that runs a phase skill and has to drive `archflow-local` plus the five MCP tools to
completion. Everything in the problem section was observed in one real skill-driven run of the
`mcp-e2e-test` PRD phase on 2026-08-10, at HEAD `8d8e804`.

---

I am the client of this system. I run a phase skill, and to advance one step I drive `archflow-local`
and the five MCP tools. This session plans how that surface should behave. Produce a phased
implementation plan; do not write code in this session.

**Verify what actually landed before planning.** Read `src/state/next-action.ts`,
`src/state/request-templates.ts`, `src/state/status.ts`, the `envelope` and `build-document` commands in
`src/local/`, and the current skill prose in `skills/archflow-prd/SKILL.md`. Build on that state, not on
the description below.

## What I hit in one run

Recording a single PRD produce step took six commands and three full manual transcriptions of a ~1 KB
JSON request. Three separate defects surfaced in under ten minutes:

1. **A prefilled template the server rejects.** `status` returned `next_action.code: "run-step"` with a
   template carrying `status: "running"`, `step: "produce"`, `expected_revision: 1`. State was already
   `produce-running`. Running the template verbatim returned `TRANSITION_INVALID`
   (`produce-running` → `produce-running`). `next-action.ts:183` selects `run-step` whenever no
   authoritative produce *result* exists — exactly the state a mid-produce agent occupies — and
   `request-templates.ts:133` hardcodes `status: "running"` for every `run-step` template. During
   produce, `status` always emits a request the server always rejects.
2. **A prefilled fingerprint that `envelope` contradicts.** At revision 2 the template carried
   `input_fingerprint: f7a396…`; `envelope` over that same request returned `3eb35d…`. The skill tells me
   the envelope is the authority, so I recovered — but the template presented an authoritative-looking
   value that was wrong, in the same phase where its `status` field was also wrong.
3. **A value the skill requires from `status` that `status` does not expose.** The self-review artifact
   requires `subject_digest`. The skill says to take it from `status`. `status` has no such field. I read
   `state.json` and then `src/state/produce-subject.ts` to work out that a document produce's subject is
   the document's `content_digest`. That breaks the property the whole helper exists to establish: every
   server-checked value comes from the helper, never from inspecting durable state by hand.

Separately, nothing composes. `build-document` returns an artifact; I hand-wrap it into an
`archflow_state` request, retyping four digests. `envelope` returns a different fingerprint; I hand-
substitute it into two places, then re-run `envelope`. Then I retype the entire request a third time as
MCP tool arguments. `envelope` wants `{"tool":…,"input":…}` while `status` emits `{"tool":…,"template":…}`,
so even the shapes don't line up — my first `envelope` call failed on exactly that.

## What is already good — do not regress it

- **Error messages name the safe next action.** `envelope`'s shape error printed the exact expected
  wrapper; `TRANSITION_INVALID` carried `next_action: "select-valid-transition"`. Both let me recover
  without guessing. This is the standard the rest of the surface should meet.
- **`ok` in the payload rather than exit-code-only** works and the skill relies on it.
- **Fail-closed digest binding is the point of the system.** Nothing below asks to relax a check.

## The framing I want the plan to adopt

Every hand-copied digest is a transcription risk that the digest system exists to eliminate. Today the
client copies four to six digests per step by hand. **Removing transcription is an integrity
improvement, not a convenience feature** — that framing should decide the tradeoffs, not "developer
experience."

## What I want as the client

1. **One canonical request shape end to end.** What `status` hands me is what `envelope` accepts is what
   the tool accepts. If `next_action.request` and `envelope`'s payload differ, one of them is wrong. Pick
   `{"tool":…,"input":…}` or something better, and use it everywhere.
2. **A prefilled template is executable from the state it was derived in, or it is not emitted.** Decide
   the rule: either every template round-trips through the server's own transition validation before it
   is printed, or templates carry only fields the client cannot derive and omit the rest. A field that is
   authoritative-looking and wrong is worse than an absent field. Cover this with a test that executes
   derived actions against a real server rather than asserting template shape.
3. **Commands compose: the output of one is the input of the next, unedited.** `build-document` knows
   everything needed to emit the finished `archflow_state` request. It should emit it. Consider one
   command that takes intent plus document path and returns the exact, fingerprint-resolved tool
   arguments — the current six-step dance collapsed to one.
4. **Fingerprint resolution is internal.** The substitute-and-rehash pass is the helper's job. I should
   never see a fingerprint that a later command will contradict, and never hand-copy one between
   commands. If the two-pass rule must remain visible in the skill prose, explain why in the plan.
5. **`status` prints every value the skills instruct me to take from `status`.** Audit the skill prose
   against the actual `status` output and close the gaps — `subject_digest` is the one I hit; there may be
   others. Treat any value a skill sources from `state.json`, a source file, or conversation as a defect
   in `status`.
6. **A transcription-free handoff to the MCP tools.** Retyping an authenticated request as tool arguments
   is the last place a digest can be corrupted by hand. Decide whether the client passes a request
   reference, or whether the helper's output is structured so the tool call is a mechanical copy with no
   re-authoring. Note the constraint honestly: an MCP tool call's arguments come from the model, so this
   may be a "make the copy trivially verifiable" problem rather than an "eliminate the copy" problem.
7. **Payload size at the call site.** The skill forbids scratch files and requires stdin, so kilobyte
   JSON blobs get inlined into shell commands. If (3) and (4) land, most of this disappears; check
   whether any payload command still needs a large hand-authored body and, if so, whether referencing an
   already-written repository artifact is the better contract.
8. **Advertised tool schemas cost client context.** `archflow_state`'s advertised input schema is several
   thousand lines of `$defs` graph that lands in my context before I can call anything. `b47b5d7` already
   trimmed to ref-reachable subtrees. Assess whether more is safely trimmable, and treat this as a
   measurable budget rather than an afterthought — but do not weaken closed-schema validation to get it.

## Constraints

- Open-source prototype: simplest design that meets the requirement (see `CLAUDE.md` engineering
  priorities). No registries, compatibility layers, or generalized request builders beyond what these
  eight items need.
- The human trust boundaries in `CLAUDE.md` are non-negotiable. Nothing here asks to infer approval,
  soften a gate, or let the client author a server-checked fact.
- Skill prose changes are in scope: if a rule exists only to work around a helper gap, closing the gap
  should delete the rule rather than document it better.

## Relationship to `mcp-e2e-test`

The `mcp-e2e-test` PRD (drafted the same session) covers *test coverage* gaps — R1 asks for a test that
executes derived next actions, R2 for a test that executes a skill's instruction path, R12 for legible
readiness. It does not cover the ergonomics above. Decide explicitly whether this work is folded into
that task, sequenced before it, or run as its own task; the two overlap at R1 and should not both own it.
