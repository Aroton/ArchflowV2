# LIMITATIONS

**Explored:** 2026-11-11 · **Commit:** `f1fe689` · **Covers:** `src/dispatch/`, `src/review/`, `src/init/`, `src/local/`, `src/contracts/config.ts`, `src/contracts/dispatch-failure.ts`, `src/contracts/errors.ts`, `assets/config.template.yaml`, `install.sh`, `skills/archflow-run/`

ArchFlow is a local developer-workflow prototype, not a security sandbox. This page lists what it does *not* guarantee, so a human auditing the system does not have to find out by reading source. Each entry says what is not provided, what mitigates it, and why that trade was accepted. A planted canary that never shows up in a reviewer's output is evidence about that run; it is not proof the reviewer could not read it.

## What a review does and does not claim

### Review judgment is generative

A review reports what other models found when they read the supplied bytes. **Not provided:** proof that every real defect was found, that a reported concern is real, or that fixes made afterward are correct. A clean `no_issues_found` from two reviewers is not a certification, and a family of models can share a blind spot.

**Existing mitigation:** the result names every reviewer's role, route (adapter, family, model, effort) and report, so a caller sees who looked; reviewer output must satisfy a closed schema; and the constitution reviewer, which judges the repository's written rules, is a separate call.

**Why accepted:** review is a second opinion for the working agent and its human, who decide what to act on. Nothing in the CLI approves, blocks or advances work.

### `human_review_reasons` are advice

A matched `approval_rules` entry or constitution `review_trigger` adds a reason to the result. **Not provided:** enforcement. The CLI cannot stop a caller from ignoring a reason; the `archflow-run` skill and the human at its STOPs are what honor it. A skill that skips the question skips the human.

### Reports describe one snapshot

There is no stored state, resume cursor or approval archive: a lost response cannot be recovered, and a new call spends a fresh review. Before returning, the review re-reads the working-tree files, `HEAD`, branch and policy digest and fails with `SUBJECT_CHANGED` if any moved, but edits made after the result is returned are not covered, and nothing certifies a later fix.

The input contract is narrow: one git repository with an existing `HEAD` that must still equal the payload's `base_commit` (`BASELINE_CHANGED` otherwise); declared paths are files, not directories; a path that traverses a symlinked parent, or names a directory or other non-file entry, is refused; a path that is itself a symlink is reviewed as a symlink (its link text), never followed; changed bytes are capped at 25 MiB (`INPUT_TOO_LARGE`); a nested repository (an agent worktree inside the checkout) is never part of the subject. Every dirty and untracked file is included as context, so the caller must tell its own outputs from edits that were already there, and reviewers are told that unrelated changes are not findings.

An implementation review can carry the plan review's `policy_digest` as `expected_policy_digest`; the check happens only if the caller passes it.

## The reviewer children

### Child repository reads

**Not protected:** a dispatched `claude` or `codex` process is not stopped by the operating system from finding and reading the repository. It runs from a temporary directory outside the repository holding two `git archive` checkouts (the work, and the baseline commit), with the committed `.archflow/constitution/` removed from the work view (uncommitted constitution files are part of the reviewed subject and therefore appear in it); this keeps the real repository path and the committed constitution out of the intended view, but it is context hygiene, and the child may read elsewhere on the machine.

**Existing mitigation:** a temporary working directory, an explicit environment allowlist, and CLI flags that suppress project instructions, user configuration, skills and tools. Planted-canary tests detect values reaching child output, including a leaking negative control that proves the scanner works.

**Why accepted:** the tool is run by a developer on their own workstation, and the goal is an independent second opinion, not confinement of hostile code.

### Canonical home and credentials

**Not protected:** the child receives the developer's real `HOME` and is not blocked from the CLI's credential store. ArchFlow never reads or copies credential values, drops API keys and provider variables from the child's environment, and passes only the authentication-location variables.

**Why accepted:** using the first-party CLI's existing subscription login is the point. Authentication is mutable (an OAuth refresh replaces the credential file atomically), and a disposable copy or symlink could capture a refresh in a temporary directory and strand the real login. Keeping it canonical matches ordinary interactive use.

### Managed context

**Not protected:** system-managed or server-delivered settings (managed hooks, an `apiKeyHelper`, an enterprise Codex bundle) can still reach a child even when repository and user configuration are suppressed; Claude managed hooks run without model tools.

**Existing mitigation:** preflight records the managed-policy paths it can find, `init` reports the best-effort limitation, and review output is parsed against a strict schema, so managed context alone cannot turn into an approval.

### Codex tool surface

**Not protected:** repository-backed Codex reviews expose shell execution so reviewers can read files. Codex has no disable-all-tools switch and cannot report the tools it will use, so ArchFlow's suppression is a denylist against a registry that can change between versions, and `-s read-only` constrains generated commands, not the Codex parent process.

**Existing mitigation:** a minimum tested CLI version, strict configuration, skills and project docs disabled, read-only mode, and fixtures pinning the exact invocation. Any support claim stronger than this would need an inspectable allowlist or OS containment.

### No sandbox or OS containment

**Not protected:** there is no filesystem namespace, credential boundary, network boundary or OS-enforced containment around a reviewer. Scrubbed environments, flags and output scanning are hygiene, and dispatch does not fail closed merely because isolation cannot be proved.

**Existing mitigation:** children are launched without a shell, with explicit argv, bounded input and output, a timeout and cancellation, and a temporary working directory.

**Why accepted:** a partially effective sandbox would be a misleading claim and a lot of platform machinery. The trusted-machine assumption is stated instead.

### Descendants that escape the process group

**Not protected:** on non-Windows systems the child's process group gets SIGTERM and then SIGKILL on cancel or timeout, but a descendant that calls `setsid()` leaves the group and survives. A grandchild that stays in the group is reaped (an integration test covers it).

**Why accepted:** the supported first-party CLIs keep their descendants in the group; stronger coverage would need cgroups, job objects or another containment provider.

### Path check-to-use window

**Not protected:** `safeParents` checks each parent directory with `lstat` before the file is opened, so a component can change between check and use. Node does not expose a directory-relative open that makes resolve and open one operation. `O_NOFOLLOW` protects the final path component on platforms that provide it, not every intermediate one.

**Why accepted:** the checks reliably reject malformed and pre-existing escapes; the model assumes no other process of the same user rewrites the repository adversarially during a review.

### Antigravity workspace binding

A 2026-09-11 real-host run observed `agy` advertising the temporary snapshot as its working directory while its `run_command` tool actually started in a global scratch directory; the reviewer searched outside the snapshot and read the answer from a source fixture. A passing real-host assertion on that route is therefore weaker evidence of an independent review. Passing a working directory and disabling slash commands do not isolate Antigravity's tool execution.

### Antigravity recovery depends on native events

A clean exit is not proof a review completed: Antigravity can retain a recovered Gemini capacity (503) error in its terminal status. The adapter accepts that case only when the error is the native format, the exit was clean, the stream shows one coherent turn ending in a completed `finish`, and the structured output is present; any other shape disables the exception. A changed CLI event format will turn this into a visible failure, not a silent pass.

### File references are not immediate inclusion

Claude preloaded small referenced files, did not expand nested references and omitted a file of about 400 KB; Codex and Antigravity required tool reads. ArchFlow supplies complete files with usage guidance and read instructions but does not claim a CLI or model consumed every byte immediately.

### Third-party interface claims

A reviewer sees the repository at `HEAD` without dependency sources (`git archive` carries no `node_modules/`) and with no network, so a claim about a library's API can be checked only against what the plan or code states. Recording the gap honestly is proportional for a prototype.

## Routing

### Route declarations are not authorization

A route given in a payload's `review_routes` is validated like a configured one (known family, supported effort, safe model name, no cc-switch provider on a non-Claude model) but not authenticated as having come from a human. The connected model builds the payload. The skills tell the agent to report an outage and ask rather than substitute; that instruction is the only enforcement.

### Same-family and low-effort routes are legal

"The other model family" describes the shipped template: a Claude producer is reviewed by GPT, a Codex producer by Claude, an Antigravity producer by both. Nothing checks it: a repository may route any role to the producer's own family or a low effort, and the template's own test reviewer is `gpt-6.1-sol` at low effort for every producer. Each report carries its route, so a human relying on a review can see who gave it. A same-family or low-effort reviewer is a legitimate operator choice (outages, cost, domain fit), and enforcing a family rule would recreate the outage dead end an explicit override exists to avoid.

### The dispatch timeout is fixed

Every reviewer child gets the same 15 minutes (`DISPATCH_TIMEOUT_MS`), regardless of input size or effort. A high-effort review of a large subject can exceed it and returns a classified `TIMEOUT` failure with the role and route, and the other reviewers' reports are kept. In one recorded case the same envelope timed out at the highest effort and finished in about seven minutes at `high`. The remedy is a lower effort, supplied for one call through `review_routes` or in config; nothing is downgraded silently. A per-size budget would be a guess presented as policy.

### Retries cover only transient failures

Up to three attempts (waits of one and four seconds) for a classified rate limit, timeout, unavailable repository view or transient transport error. Authentication problems, schema failures and generic process errors fail at once, because retrying them hides the real fault.

## Configuration and policy

### Config is live, trusted and not migrated

`review` reads `.archflow/config.yaml` and `.archflow/constitution/` from the working tree on every call (falling back to the bundle's template and rules when the repository has none). Anyone with write access can lower an effort, change a route or remove an approval rule, and ArchFlow neither authorizes the edit nor judges whether it weakens policy; the config and constitution digests in the result record what ran. Configs written by older templates keep working: retired keys are accepted and ignored, but nothing migrates other shapes. Unknown or malformed fields fail as `CONFIG_INVALID` with a message pointing at the file to check, not as a guess.

### Content approval triggers are path heuristics

A `content` rule matches the *declared* `paths` of the payload (not every changed file the snapshot picked up) with case-sensitive whole-path globs: `*` and `?` stay inside one segment and `**` spans whole segments. It does not read bytes, language semantics or embedded SQL. The shipped default flags `**/*.sql`; the database constitution rule asks a reviewer model to catch embedded queries, ORM operations and migrations, which can miss or misclassify. Naming can under- or over-match, and an undeclared changed file never triggers a rule. Path globs are understandable repository policy; semantic analysis would be a language-specific engine out of proportion for the prototype.

## Installation and operation

### A missing installed-assets error reports `CONFIG_INVALID`

When the bundle has no `assets/` directory, `init` fails with error code `CONFIG_INVALID`, issue code `installed-assets-missing`, and the registry's next action for that code, `repair-config`. That is the wrong hint: the config is fine and the fix is to reinstall ArchFlow. The stderr line is right: it names every directory searched and says "Reinstall ArchFlow to restore them." A caller that acts only on the structured next action will be sent to repair a config that is not broken. `review` in the same situation does not use that code: with no assets directory it returns `REVIEW_FAILED` with a generic message while the same stderr line explains, and if the directory exists but a rubric file does not, it returns `CONFIG_INVALID` with "The installed review rubric is missing or invalid". Fixing this needs a separate error code or next action; until then, read stderr.

### Init diagnostics are partial

`init` probes `claude` and `codex` and the managed-policy files, but not `agy`. It cannot prove isolation (it says so), and the Antigravity route is checked only when a review first uses it.

### Usage accounting is best-effort

An installed bundle writes one private JSON file per dispatch to `<ARCHFLOW_HOME>/usage/` (duration, route, status, and the token and cost numbers a CLI reported) and deletes files older than seven days on the next dispatch; there is no idle cleanup. Claude's figures are the CLI's own estimates, interrupted calls and CLIs that do not report usage leave fields unknown, and a succeeded record means the dispatch completed, not that a review was sound. Source-checkout runs write nothing.

### Internal-error log

An unexpected failure while dispatching a reviewer appends a stack to `.archflow/runtime/diagnostics/internal-errors.log` (only when `.archflow/` exists) and to stderr, under a correlation id the result does not carry beyond a generic message. The write is swallowed on failure so diagnostics can never change a result. The file is ignored by the scaffolded `.archflow/.gitignore` but is otherwise never cleaned up. A failure while preparing the review (for example missing installed assets or a git spawn failure) returns `REVIEW_FAILED` with a generic message and logs no stack.

### Legacy cleanup is exact

`init` removes only an `archflow` server in `.mcp.json` whose command is exactly `archflow-mcp`, and only the marked block in `.codex/config.toml`. A different command, unmatched markers, a symlink, or an unparsable `.mcp.json` that mentions `archflow-mcp` are left alone and listed in the result's `legacy_registrations.left_alone` (on stderr if init then fails); an unparsable `.mcp.json` that never mentions it is ignored silently. Registrations in user-level host configuration are not touched by `init` at all.

### The installer rewrites the Antigravity MCP config

When `install.sh` removes the old Antigravity `archflow` MCP entry from `~/.gemini/config/mcp_config.json`, it rewrites that file with normalized JSON formatting. Other servers and keys are kept, but integers above 2^53 lose precision. The old `init` did the same when it wrote the entry.

## The orchestrated workflow

`archflow-run` is markdown and git, with no server holding its state, so its guarantees are the skill's: plan approval before code, declared STOPs, and a cross-family review per task are instructions an orchestrating session follows. It needs Claude Code as the orchestrator, `jq` and `bash` for its helper scripts, and an authenticated reviewer CLI of the other family. A session that deviates from the skill leaves no mechanical trace; the per-task commits and `.archflow/runs/<name>/` files are the audit trail.
