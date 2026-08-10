# Review Envelope Context Contract

The dispatched counter-review runs the opposite-family CLI in an empty temp workspace with only a
digest-bound envelope on stdin. Accuracy comes from pinning both sides of every comparison the
rubric asks for, never from opening the repository to the reviewer.

## What the envelope pins today

| Review | Pinned context (`context` entries, by kind) |
|---|---|
| PRD | `user-ask` — verbatim `ask.md` bytes, authenticated against the digest the PRD declared |
| Architecture / phase design | `approved-upstream` (the phase's exact canonical upstream documents, each requiring a durable artifact approval) · `interface-excerpt` for backtick-mentioned repository paths at the HEAD commit · `repo-map` of the mentioned directories · `conventions` (`CLAUDE.md`) |
| Implementation | `approved-upstream` (phase design + design) · `verification-transcript` (`phases/N/verification.txt` lifted from the change set) · `interface-excerpt` for unchanged files the changed code imports, read at the pinned `base_commit` · `conventions` |

Every entry is assembled mechanically (`src/review/pinned-context.ts`) and carries a `status`:
`pinned`, `truncated` (bounded head, full-file digest recorded), `unavailable` (named gap), or
`omitted-cap` (dropped to fit the 1 MiB envelope cap, digest retained). Approved upstreams and the
user ask are never droppable; drops start from the lowest cap priority (`repo-map` first).

Fail-closed versus reviewable: absence that contradicts durable authority fails closed (missing or
unapproved upstream, declared `ask.md` that drifted); everything else stays reviewable with an
`unavailable` entry the rubric's `unverifiable-claims` criterion turns into a named finding.

## How the contract grows

`unverifiable-*` findings are the feedback loop. Triage rejects them with rationale and evidence
beginning `envelope-gap: <missing evidence>` — they are contract gaps, not producer defects, and
accepting one would force produce re-entry for a non-defect. The human gate lists them as an
"Envelope gaps" section. A gap that recurs across tasks is the trigger for a new pinned entry
kind: add it to `PINNED_CONTEXT_KINDS`, write its mechanical producer, and slot its cap priority —
deliberately, one kind at a time, never speculatively.

## Known limitations

- **Verification transcripts are agent-written.** Nothing prevents a determined agent fabricating
  `phases/N/verification.txt`; the rubric judges the transcript's content against the phase design,
  which catches sloppy fabrication only. A server-attested runner is the named upgrade path.
- **Rubric swaps do not mix mid-phase.** A self-review recorded under an old rubric digest plus a
  counter-review under a new one fails evidence-set formation; the server fails closed. Swap skills
  between phases, or re-run the self-review after upgrading. `input_fingerprint` is unaffected by
  rubric text; `request_digest` changes, so pre-swap replays simply stop matching.
- **`CLAUDE.md` conventions are worktree bytes**, digest-recorded at review time but not task-pinned
  authority; mid-task drift is accepted prototype behavior.
