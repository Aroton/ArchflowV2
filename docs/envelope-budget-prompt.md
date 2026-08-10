# Prompt: envelope budget policy and phase sizing (run AFTER the counter-review redesign)

Copy everything below the line into a fresh planning session, after the counter-review context redesign (sealed-but-richer envelopes, unverifiable-claims rubrics) has landed.

---

A prior session redesigned ArchFlow's counter-review context: envelopes stay sealed and digest-bound, but pin richer evidence (upstream documents, interface excerpts, verification transcripts), and every rubric gained a non-blocking `unverifiable-claims` criterion that turns missing evidence into named findings. **Verify what actually landed before planning — read the current `renderProduceReviewMaterial` in `src/state/produce-subject.ts`, the envelope construction in `src/review/envelopes.ts`, and the stable rubrics in the skills — and build on that state, not on this description.**

This session plans the follow-up: how the envelope spends its byte budget, and how phases are kept small enough to review in one pass. Produce a phased implementation plan; do not write code in this session.

## The problem

The review envelope has a 1 MiB cap (`REVIEW_ENVELOPE_BYTE_CAP`, `src/review/envelopes.ts`). Implementation review material embeds complete before AND after bytes for every changed file. Two consequences:

1. **Degenerate content blows the cap with zero review signal.** One `dist/archflow-mcp.mjs` rebuild is ~2.7 MB alone; lockfile churn is hundreds of KB. Any phase that touches generated artifacts overflows instantly.
2. **Large hand-written change sets dilute review quality before they hit the cap.** 1 MiB is ~300k tokens — at or past the input window of the reviewing models, and attention degrades well before that. A change set that genuinely fills the cap (~40–70 typical files, both sides) has outgrown single-pass review as a concept.

For calibration in this repo: average `src/` file ~12 KB, median ~7 KB; a well-scoped phase touching 5–15 files lands around 100–350 KB both-sides, which is the comfortable quality zone.

## Design decisions already made (treat as the brief, not open questions)

1. **The 1 MiB cap stays.** It is effectively the model context window in disguise; raising it converts envelope overflow into timeouts and worse reviews. Handle size in the renderer, not the cap.
2. **Tiered rendering, language-agnostic.** Whole before/after bytes for files under a threshold (~32 KB covers ~95% of this repo's files); unified diff with generous context (30–50 lines per hunk) above the threshold; `path + digest only` for generated/excluded content (dist bundles, lockfiles, and a configurable exclusion list). Rationale for keeping whole files when small: full-file context is where diff-invisible findings come from — unreachable new branches, newly duplicated helpers, orphaned dead code, broken file conventions. The goal is to stop shipping *big* files whole, not to stop shipping files.
3. **No AST/function-level extraction.** Expanding hunks to enclosing functions requires a parser per language forever (ArchFlow reviews any repo) for marginal gain over a wide-context diff. Rejected as speculative machinery.
4. **Every elision is declared inside the envelope.** The renderer lists what was diffed-instead-of-embedded and what was excluded (path + digest + reason), so the reviewer reports reduced visibility under the `unverifiable-claims` criterion instead of silently reviewing less. Silent truncation is the failure mode this whole design exists to prevent.
5. **Phase sizing is enforced at design time, not impl time.** Extend the phase-plan-soundness rubric criterion (architecture and phase-design reviews) so single-pass reviewability is part of "well-scoped": a phase whose expected change set cannot be attested in one sealed pass — typically ~10–15 files of hand-written change — is split at design review, when splitting is cheap. Use "typically" calibration language per the repo's design principles, never hard numeric "must".
6. **Envelope overflow becomes the hard backstop with an actionable error.** When the assembled envelope still exceeds the cap, the error must tell the producer what to do (split the phase; check for generated files that belong on the exclusion list) and name the largest contributors — not merely report a byte count.
7. **No chunked multi-dispatch review.** Splitting one subject across several sealed reviews and merging findings breaks the one-subject-one-attestation property and adds machinery nothing currently needs. If a phase cannot fit, the phase is wrong, not the dispatch count.

## Where the machinery lives

- `src/state/produce-subject.ts` — `renderProduceReviewMaterial` (the renderer this work mostly changes).
- `src/review/envelopes.ts` — envelope construction and the byte cap.
- `src/mcp/handlers/counter-review.ts` — handler wiring.
- Skills carrying phase-plan rubric criteria: `skills/archflow-design/SKILL.md`, `skills/archflow-phase-design/SKILL.md`.
- Digest/trust conventions in `CLAUDE.md` apply: elided content still identified by digest; the envelope remains canonical and digest-bound.

## What I want from this session

A phased plan, sequenced so each phase is independently shippable and testable:

1. **Exclusion + declaration**: generated-content exclusion (path + digest + reason lines in the envelope), since this is the only overflow anyone hits today. Decide where the exclusion list lives (task config vs repository config) and justify the choice.
2. **Tiered rendering**: the size threshold, diff-with-context rendering for large files, and the elision declarations. Include how before/after digests remain verifiable for diffed files.
3. **Rubric + skill text**: phase-plan-soundness extension for single-pass reviewability; renderer-elision awareness in the unverifiable-claims flow if the landed rubrics need wording adjustments.
4. **Actionable overflow error**: largest-contributor reporting and producer guidance.

Constraints: open-source prototype — simplest design that meets the requirement (see CLAUDE.md engineering priorities). The sealed-envelope trust boundary is non-negotiable. Where the prior redesign already built equivalent machinery (e.g., prioritized evidence assembly), reuse it rather than adding a parallel mechanism.
