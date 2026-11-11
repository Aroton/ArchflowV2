# PATTERNS

**Explored:** 2026-11-11 · **Commit:** `f1fe689` · **Covers:** `src/`, `test/helpers/`, `tsconfig.json`, `vitest.config.ts`, `CLAUDE.md`

The idioms the surviving code actually uses, with the file that shows each one, and the reason it exists. Most are small defenses against a failure that really happened; read the reason before bending the rule. `CLAUDE.md` holds the standing conventions; this page shows them in the code.

## Language and module conventions

- **Strict TypeScript, ES modules.** `tsconfig.json` turns on `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, with `NodeNext` resolution, so relative imports end in `.js` and type-only imports say `import type`. The `!` after an index (`slots[index]!` in `src/review/simple-review.ts`) is the visible cost of `noUncheckedIndexedAccess`: the code has just proven the index exists.
- **Optional fields are spread in, not assigned `undefined`.** Under `exactOptionalPropertyTypes`, `{ x: undefined }` is not `{}`. The pattern is `...(value === undefined ? {} : { value })` (`src/local/main.ts`, `src/dispatch/coordinator.ts`). It also keeps absent fields out of canonical JSON.
- **Frozen results.** Values that cross a module boundary are `Object.freeze`d (`src/dispatch/routing.ts`, `src/init/assets.ts`), and read-only shapes are `Readonly<{…}>` or `readonly` arrays.
- **Style.** Two-space indent, double quotes, semicolons; a comment explains *why* a rule exists (often citing the failure that taught it) rather than restating the code.

## Naming

- **Files, types and tests are named for the behavior they cover, never the workflow phase that produced them** (`legacy-registration-cleanup.ts`, `local-cli-stdin-discipline.test.ts`). Finding the right file must not require project history.
- **Versioned shapes carry a suffix and a field.** Schemas and parsers read `configV1Schema`, `parseConfigV1`, `RubricV1`; the JSON has `schema_version: "1"` (`src/contracts/config.ts`, `rubric.ts`, `simple-review.ts`). Reviewer adjudication output is `"2"` (`adjudication.ts`).
- **JSON field names are `snake_case`; TypeScript identifiers are `camelCase`.** The payload a caller writes by hand (`base_commit`, `review_routes`) matches the schema, not local style.
- **Some old names survive on purpose.** `phase-design`/`phase-impl` route keys and `Simple*` type names remain because repositories' `config.yaml` files and an in-flight branch use them; see [COMPLEXITY.md](COMPLEXITY.md).

## Type and contract conventions

- **Data shapes are `type` aliases, not `interface`s.** A type reachable from a persisted or schema-generated root must be an alias: TypeScript gives index-signature compatibility only to aliases, so an `interface` nested inside fails the plain-JSON constraint with a misleading error about index signatures. Aliases also close declaration merging, so a shape is exactly what its schema says. The remaining `interface`s are behavioral contracts and in-process records (for example `CliAdapter` in `src/dispatch/cli.ts` and `GitRunner` in `src/repository/git.ts`), the recursive `PlainJsonObject`, and the parsed-from-file `RubricV1` and `ConstitutionRuleV1`. Do not copy the pattern for a persisted shape: `RubricV1` does reach the review envelope, but only through an `unknown` parameter that `assertPlainJson` re-checks, which is why it compiles; it should become a type alias.
- **Branded strings for validated values.** `GitOid`, `Sha256Digest`, `SafeCode`, `RepositoryPathClaim` are `string & { [brand]: true }` with a module-private `unique symbol` (`src/contracts/canonical.ts`, `evidence.ts`, `path-claims.ts`). Only a `parse…` function mints one, so "this digest was checked" is carried by the type. `RootBoundGitRunner` (`src/repository/identity.ts`) applies the same trick to a runner proven to be at the worktree root.
- **Closed objects.** Every zod object is `.strict()`; unknown keys are rejected, so a misspelled field in a hand-built payload fails with the field's path instead of being ignored (`src/contracts/simple-review.ts`). The one exception is deliberate: config accepts retired keys with `z.unknown().optional()` and ignores them, so existing repositories keep reviewing (`src/contracts/config.ts`).
- **Exhaustive tables keyed by a union.** `LOCAL_COMMAND_CONTRACTS` and the handler table are `Record<LocalCommand, …>` (`src/local/commands.ts`), so adding a command without its contract is a compile error. `INPUT_FREE_COMMANDS` is *derived* from that table rather than listed again.
- **Honest failure shapes.** A review returns `{ ok, value?, error? }` with a plain `{ code, message, retryable }` error. Init and the lower layers return `ProjectResult<T>` with a registry error (`createProjectError` in `src/contracts/errors.ts`: owner, retryable, strict parameters, a `next_action`). Both are `ok`-discriminated unions, not thrown exceptions, for anything a caller can act on.

## Validation of caller-owned objects

Payloads and config are caller-owned: a getter or a mutation can show one value to a validation pass and another to a hashing pass.

- **Plain JSON preflight** (`assertPlainJson`, `src/contracts/plain-json.ts`). Before anything is validated or hashed, the value is walked once and rejected if it holds accessors, non-enumerable properties, symbol keys, sparse arrays, `__proto__`/`constructor`/`prototype` keys, cycles, non-finite numbers, or if it mutates while being inspected.
- **Require `enumerable` as well as `value` when reading a descriptor.** Rejecting accessors prevents a value being read twice differently; rejecting non-enumerable *data* properties prevents a field that `JSON.stringify` (and so a digest) cannot see from being treated as present. They guard different hazards.
- **Materialize once.** Validate, then `structuredClone`, then use only the clone: `parseSimpleReviewInput` (`src/contracts/simple-review.ts`), `sealDispatchInput` (`src/review/envelopes.ts`), and the config digest in `loadSimplePolicy` (`src/review/simple-context.ts`). Otherwise an enumerable getter could satisfy validation and then feed hashing something else.
- **Canonical JSON for digests** (`canonicalJsonBytes`, `canonicalJsonDigest` in `src/contracts/canonical.ts`): object keys sorted by code-unit order, arrays left in order (their order is meaningful), two-space indent, one trailing newline, UTF-8, then SHA-256. The subject, config, constitution and policy digests are all built this way, so equal content has one identity.
- **Reject, don't repair, caller paths.** Declared paths are lexical claims (`src/contracts/path-claims.ts`: no `..`, drive or UNC prefixes, reserved Windows names, control characters); reading them then refuses symlink parents and uses `O_NOFOLLOW` (`safeParents` and `regular` in `src/review/simple-context.ts`). A rejection names the field so a person writing the payload can fix it.

## Error handling

- **Classify what is safe to say; log the rest.** A reviewer failure becomes a public code and fixed message through `classifiedDispatchFailure` (`src/dispatch/failure-classification.ts`). An unclassified exception while dispatching a reviewer returns a generic message, and its stack goes to stderr and an ignored log file under a correlation id (`reportInternalError`, `src/review/internal-error-log.ts`); a failure while preparing the review returns `REVIEW_FAILED` with a generic message and no logged stack. Raw exceptions, paths and child output never reach the result.
- **Retry only positively transient failures** (`isTransientDispatchFailure`): up to three attempts with 1 s and 4 s waits in `src/review/simple-review.ts`. A generic process error, bad auth or a schema failure is not retried.
- **Settle every sibling before cleanup, and keep what succeeded.** One review runs its children together; a failure in one does not discard the others' reports, and the shared workspace is disposed in a `finally` only after all have ended.
- **Last-resort boundary.** `src/local/main.ts` catches anything that escapes, prints a `CONTRACT_INVALID` JSON document, truncates the message to 256 characters in the document and 512 on stderr, and sets a non-zero exit code.

## CLI and process conventions

- **An input-free command never reads stdin.** A parent often leaves stdin open, so waiting for EOF would hang. `main.ts` parses first, rejects `--input` for such commands, and reads stdin only when the command table says it takes a payload. A TTY with no `--input` is an error, not a wait.
- **stdout is one canonical JSON document; stderr is for humans.** Exit code `1` whenever the result says `ok: false`.
- **Cancel by signal.** SIGINT and SIGTERM abort one `AbortController` that reaches every child and the workspace cleanup.
- **Never spawn through a shell and never put an unbounded payload in one argv element.** Children get explicit argv, the payload on stdin or in a workspace file, and a guard at `MAX_ARGV_ELEMENT_BYTES` (`src/dispatch/process.ts`), because Linux rejects a single 128 KiB argument as a bare `E2BIG`. Children run in their own process group, are stopped with SIGTERM then SIGKILL, and have output and time caps.
- **A scrubbed environment.** Children get a short allowlist (`FORWARDED_ENVIRONMENT` in `src/dispatch/workspace.ts`) and the canonical home, not the parent's environment.
- **Git calls.** Review shells out with `git -C <root>`; `git archive | tar -x` makes the read-only checkouts, chosen over `git worktree add` so a reviewer's view has no link back to the object database (`src/dispatch/workspace.ts`). Never pass `--literal-pathspecs` together with a `:(top,literal)` pathspec: the flag turns the magic prefix into a literal filename and the command silently selects nothing.

## Dependency seams in production code

Production functions take their effects as optional parameters so tests can substitute them without module mocking: `SimpleReviewDependencies { dispatch, wait }` (`src/review/simple-review.ts`), `observeAttempt` and `usage_directory` on `createReviewDispatcher` (`src/dispatch/coordinator.ts`), `resetMemoizedCliPreflight` (`src/dispatch/cli.ts`). Each is documented as a test seam, so it is not mistaken for an extension point.

## Test conventions

See [TESTING.md](TESTING.md) for the layout. The idioms:

- **Fake CLIs, not mocks, for process behavior.** `test/fixtures/dispatch/*.mjs` are real scripts on `PATH`, so argv, stdin, exit codes and process groups are exercised for real.
- **Temporary repositories come from helpers** (`test/helpers/temp-repository.ts`, `review-repository.ts`), run with the ambient git configuration neutralized so a developer's `core.autocrlf` cannot change a result. Anything that spawns `git` is an integration test.
- **A scratch `HOME`.** Install and init tests stub `HOME` to a directory inside the temporary repository; nothing writes to the developer's `~/.claude`, `~/.agents`, `~/.archflow` or `~/.local/bin`.
- **Prompts are fixtures.** `test/fixtures/review-prompts/` holds the rendered prompt for each role and stage; `ARCHFLOW_WRITE_PROMPT_SNAPSHOTS=1` rewrites them so a prompt change shows up as a reviewable diff.
- **Pin the failing window, not every permutation.** Tests cover a representative success and failure for each boundary; a limitation that cannot be fixed in code is written in [LIMITATIONS.md](LIMITATIONS.md) instead of kept as a permanent test.

## Documentation conventions

Each caps-named page opens with `**Explored:** <date> · **Commit:** <hash> · **Covers:** <paths>`, so a refresh can diff since that commit and re-explore only pages whose covered paths changed. Pages explain the *why* in plain language for a human auditor, use mermaid where a picture helps, and link only to pages that exist. A change that alters behavior a page describes updates that page in the same change.

## High-risk checklist

Before changing code in these areas, re-read the matching section above:

- A new payload or config field: `.strict()`, plain-JSON preflight, materialize once.
- A new hash or digest: canonical JSON over validated, cloned input.
- A new child-process argument: no shell, no large argv element, scrubbed environment.
- A new path read from a payload: lexical claim, symlink-parent refusal, `O_NOFOLLOW`.
- A new error: classified public message; raw detail to the internal log only.
- A new command: add it to the contract table; decide explicitly whether it reads stdin.
