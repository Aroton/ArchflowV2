# Phase 6: Repository Identity, Paths, and Canonical Digests

**Status**: DESIGNED
**Task**: mcp-integration
**Goal**: Establish the repository/task identity, path safety, immutable task configuration pinning, and byte-stable digest contracts used by every mutation.
**Requirements completed**: none
**Requirements advanced**: REQ-04, REQ-05, REQ-13, REQ-26

**This phase completes no requirement, and says so deliberately.** REQ-04 requires that a task *records and enforces* immutable identity, base commit, workflow, constitution, and configuration inputs at task start — recording is durable-state work this phase excludes and Phase 7 owns. REQ-26 requires that *every tool* resolves the canonical root and rejects scope or identity violations before any read or child dispatch; this phase wires no production handler, so nothing is enforced end to end yet. What each requirement receives here is an exact contract slice: REQ-04 gets whole-file `config.yaml` digest pinning and the repository/task identity digests the manifest will bind; REQ-05 gets the pinning function and its mismatch producer, not workflow-graph validation, which Phase 1 already owns; REQ-13 gets the canonical request digest and declared-input fingerprint that later evidence-freshness comparisons depend on, not the fixed-point loop; REQ-26 gets the path claims, path classes, containment, and identity comparators the handlers will call. Completion is reserved for the phase that integrates and verifies the behaviour through all five tools.

`architecture.md` has been updated to define this phase and Phase 7 separately; its earlier Phase 6 requirement list — which included REQ-33, untouched by any interface or chunk here — is corrected there. Phase 7 carries the durable state and artifact schemas.

## Context

Phases 1–5 produced a foundation with no persistence and no environment coupling. Phase 1 established the ESM package, exact lockfile, recursive plain-JSON preflight, strict Ajv2020, the Zod-agreement harness, and branded phase-instance codecs. Phase 2 froze evidence, gate, triage, adjudication, and error contracts, including the 52 project error codes this phase finally supplies producers for. Phase 3 froze the five-tool catalogue and the SDK-free boundary; Phase 4 made the runtime real but inert; Phase 5 tracked a reproducible `dist/` payload with `release-manifest` and `release-legal-review` under JSON Schema authority plus a single semantic validator. The stale `.archflow/context/*` snapshots predate Phases 3–5 and are wrong about both the MCP entry point and `dist/`; live code is authoritative.

**This phase introduces the first filesystem and Git-subprocess code in `src/`.** Today `src/` contains zero `node:fs`, `node:path`, and `node:child_process` usage — all I/O is caller-supplied — and hashing appears at exactly three `createHash("sha256")` sites: two in `src/contracts/trust.ts` and one in `src/mcp/server.ts:196`, which digests an unknown tool name for `TOOL_NOT_FOUND`. There is no SHA-1 anywhere and no Git-OID computation anywhere. Three primitives this phase needs already exist only as plain JavaScript in `scripts/release-support.mjs`, which TypeScript cannot import: `canonicalJsonBytes`, `assertPortablePath` (lines 244–255), and the module-private `isInside` (lines 257–260) — the exact `path.relative` containment check re-derived here as containment step 6.

Phase 6 supplies contracts, identity, path safety, digest functions, and the secret-scan *result* contract. It explicitly does **not** implement any durable state or artifact schema, state mutation, the transaction kernel, locking, CAS, intent receipts, atomic writes, payload snapshot materialisation or restore, gate lifecycle, dispatch, sandbox, or the secret-scanning *engine*. It adds **no runtime dependency**.

## What We're Building

One coherent layer with a single directional rule: **pure computation lives in `src/contracts/`; everything that shells out to `git` or touches `node:fs` lives in a new `src/repository/` tree.** `src/repository/**` is never re-exported from `src/contracts/index.ts`, and `src/contracts/**` never imports from `src/repository/**`, so the contract layer stays testable without a repository on disk.

Four things make the layer safe rather than merely present, and each is a structural device rather than a convention:

- **Branded values, not strings.** `TaskSlug`, `PathSafeId`, `TaskPathClaim`, `RepositoryPathClaim`, `RawGitPath`, `GitOid`, and `ResolvedTaskPath` are distinct brands whose parsers are the only mints. Every public interface that carries one of these values is retyped to the brand, so a frame or width mismatch is a compile error rather than a wrong digest.
- **A root-bound runner.** Worktree discovery does not return a location for callers to remember; it returns a `RootBoundGitRunner` that carries its location. Every reader below discovery accepts only that type, so it is structurally impossible to run a repository query from an arbitrary cwd.
- **Caller-declared absence.** `git` exits 128 for a dozen unrelated fatal conditions. Every command declares which exit codes are data for *that* command, with the diagnostic that must accompany them; everything else is a failure.
- **Explicit error context.** Every reader and classifier takes a pinned `RepositoryOperationContext`, because the project error codes they promise require parameters no Git command returns.

Chunks are delegated to sub-agents with fresh context that never read each other's code, so the signatures below are the entire contract between them. Ordering is: **chunk 1 (canonical primitives) and chunk 2 (ID and path primitives) land first, in that order and alone**; chunk 3 (boundary retightening) consumes chunk 2's brands; chunk 5 consumes chunk 2's `TaskSlug` for `computeTaskIdentity` and chunk 4's runner; chunks 6–8 consume chunk 5's root-bound runner.

## Interfaces and Contracts

### Failure convention — stated once, applied everywhere

`ProjectResult<T>` is today purely a wire shape used at the tool boundary; nothing in `src/` returns it from an internal function, and internal failures use typed throws. This phase extends it inward under a three-way rule, and every signature below obeys it:

> **Parsers and assertion helpers throw.** `parseGitOid`, `parseSecretScanResult`, `assertArchflowIndexEntry`, and every `parse*` in `src/contracts/` reject by throwing, matching the existing contract-layer convention exactly.
> **Orchestrating readers return `ProjectResult<T>`** — the functions that run a Git command or touch the filesystem and must report to a caller. This is the rule `preflightGit` embodies: the runner throws, the reader translates.
> **Pure derivations return their value directly.** `computeTaskIdentity`, `computeRequestDigest`, `computeInputFingerprint`, `gitBlobOid`, and `canonicalJsonBytes` take already-parsed inputs and cannot fail meaningfully.

**One declared exception.** `SecretScanResult`'s `outcome: "unavailable"` is a third channel, deliberately: the scanner's absence is a *result state* Phase 8 must persist as evidence that a projection was never scanned, not a call failure. A `ProjectResult` error would be surfaced and discarded. No other bespoke channel is permitted.

### `src/contracts/canonical.ts` — chunk 1, lands first

```ts
import { z } from "zod";
import type { PlainJsonValue } from "./plain-json.js";
import type { Sha256Digest } from "./evidence.js";

declare const gitOidBrand: unique symbol;

/** Lowercase 40-character hexadecimal SHA-1 object name; blobs and commits share one brand. */
export type GitOid = string & { readonly [gitOidBrand]: true };

export const GIT_TREE_MODES = ["040000", "100644", "100755", "120000", "160000"] as const;
export type GitTreeMode = (typeof GIT_TREE_MODES)[number];
/** The only mode legal below `.archflow/**`. */
export type ArchflowTreeMode = "100644";

export const gitOidV1Schema: z.ZodType<GitOid>;         // /^[0-9a-f]{40}$/u
export const gitTreeModeV1Schema: z.ZodType<GitTreeMode>;
export function parseGitOid(value: unknown): GitOid;
export function parseGitTreeMode(value: unknown): GitTreeMode;
/** Normalises the raw-tree 5-character `40000` form to the displayed `040000` form. */
export function normalizeGitTreeMode(value: string): GitTreeMode;

export function canonicalJsonBytes(value: PlainJsonValue): Uint8Array;
export function sha256Bytes(bytes: Uint8Array): Sha256Digest;
export function canonicalJsonDigest(value: PlainJsonValue): Sha256Digest;
/** OID = SHA1("blob " + ASCII_decimal(content.byteLength) + "\0" + content). */
export function gitBlobOid(content: Uint8Array): GitOid;

/** Shared digest helpers so independent chunks construct identical error parameters. */
export function historyIdentityDigest(oid: GitOid): Sha256Digest;
export function repositoryCandidateDigest(absoluteCwd: string): Sha256Digest;

export interface CanonicalDocument<T extends PlainJsonValue> {
  readonly bytes: Uint8Array;
  readonly value: T;
  readonly digest: Sha256Digest;
}
export function canonicalDocument<T extends PlainJsonValue>(value: T): CanonicalDocument<T>;
export function parseCanonicalDocument<T extends PlainJsonValue>(
  bytes: Uint8Array,
  label?: string,
): CanonicalDocument<T>;
```

**`parseCanonicalDocument` is a byte-authority, and its contract is pinned exactly**, mirroring Phase 5's live implementation rather than merely re-rendering. In order: decode with `new TextDecoder("utf-8", { fatal: true })`, so malformed UTF-8 throws rather than producing replacement characters; `JSON.parse`; `assertPlainJson`, which already rejects non-plain prototypes, symbol keys, accessor properties, non-finite numbers, and the dangerous own keys `__proto__`, `prototype`, `constructor`; re-render with `canonicalJsonBytes` and **byte-compare against the input**, rejecting any noncanonical form — wrong key order, non-two-space indent, a missing or extra trailing newline, or any other whitespace difference. `digest` is `sha256Bytes` over the **original** input bytes, which by that point are proven byte-identical to the re-rendered canonical form, so the two possible readings coincide by construction. Duplicate object keys need no special rule: `JSON.parse` keeps the last, so a duplicate-key input re-renders shorter and fails the byte comparison. Fixtures must cover malformed UTF-8, duplicate keys, permuted key order, two-versus-four-space indent, and missing/extra trailing newline.

**The parity test needs a declaration file to typecheck.** `tsconfig.json` sets no `allowJs` and `skipLibCheck: false`, so importing `scripts/release-support.mjs` from a `.test.ts` fails with `TS7016: Could not find a declaration file`. Vitest would run it happily; `tsc --noEmit` would not, and `npm run check` runs typecheck first — so chunk 1 as written would break the aggregate at its first step. Chunk 1 therefore adds a hand-written `scripts/release-support.d.mts` declaring exactly the three exported symbols the test needs (`canonicalJsonBytes`, `sha256`, `assertPortablePath`). Note `sortCanonical` and `isInside` are **module-private and not exported**, so parity for the containment predicate is asserted behaviourally, not by direct call. The fallback is the subprocess pattern already used in `test/integration/release-offline.test.ts`.

### `src/contracts/evidence.ts` and `src/contracts/path-claims.ts` — chunk 2

Chunk 2 publishes primitives and changes no consumer; chunk 3 does that. **Every schema below yields a branded value**, not `string`, using the `as unknown as z.ZodType<Brand>` pattern `trust.ts:140-141` already establishes. Without this, a parsed `task_id` could not be passed to `computeTaskIdentity` or `toRepositoryPathClaim` without an undocumented cast at every call site.

```ts
// src/contracts/evidence.ts — ADDED alongside the existing safeId, which is unchanged
declare const pathSafeIdBrand: unique symbol;
export type PathSafeId = string & { readonly [pathSafeIdBrand]: true };
export const pathSafeIdV1Schema: z.ZodType<PathSafeId>;  // /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
export function parsePathSafeId(value: unknown): PathSafeId;

declare const taskSlugBrand: unique symbol;
export type TaskSlug = string & { readonly [taskSlugBrand]: true };
export const taskSlugV1Schema: z.ZodType<TaskSlug>;      // /^[a-z0-9][a-z0-9._-]{0,63}$/u
export function parseTaskSlug(value: unknown): TaskSlug;

// src/contracts/path-claims.ts
export type TaskPathClaim = string & { readonly [taskPathClaimBrand]: true };  // brand unchanged
export const taskPathClaimV1Schema: z.ZodType<TaskPathClaim>;
export function parseTaskPathClaim(value: unknown): TaskPathClaim;

declare const repositoryPathClaimBrand: unique symbol;
/** Same lexical rules as TaskPathClaim; different frame — rooted at the worktree, not the task. */
export type RepositoryPathClaim = string & { readonly [repositoryPathClaimBrand]: true };
export const repositoryPathClaimV1Schema: z.ZodType<RepositoryPathClaim>;
export function parseRepositoryPathClaim(value: unknown): RepositoryPathClaim;
export function toRepositoryPathClaim(taskId: TaskSlug, claim: TaskPathClaim): RepositoryPathClaim;

declare const rawGitPathBrand: unique symbol;
/** A path exactly as Git emitted it. Total constructor; carries no lexical guarantee at all. */
export type RawGitPath = string & { readonly [rawGitPathBrand]: true };
export function rawGitPath(value: string): RawGitPath;
/** The sole promotion path from untrusted Git output to a branded claim. */
export function tryRepositoryPathClaim(value: RawGitPath): RepositoryPathClaim | undefined;

export const TASK_PATH_CLASSES = [
  "task-config", "task-state", "gate-interface", "document", "review",
  "decision", "result-manifest", "result-payload", "intent", "attempt",
  "manual-checkpoint", "maintenance-record", "import",
] as const;
export const REPOSITORY_PATH_CLASSES = [
  "shared-workflow", "shared-constitution", "task-branch-constitution", "repository-source",
] as const;
export const PATH_CLASSES = [...TASK_PATH_CLASSES, ...REPOSITORY_PATH_CLASSES] as const;
export type TaskPathClass = (typeof TASK_PATH_CLASSES)[number];
export type RepositoryPathClass = (typeof REPOSITORY_PATH_CLASSES)[number];
export type PathClass = (typeof PATH_CLASSES)[number];
export const READ_ONLY_PATH_CLASSES: readonly PathClass[];  // shared-workflow, shared-constitution
export function parsePathClass(value: unknown): PathClass;
```

**Three path representations, because one type cannot honestly carry three guarantees.** `TaskPathClaim` is rooted at the task directory; `RepositoryPathClaim` is rooted at the worktree; `RawGitPath` is whatever Git printed. The first two share one lexical schema — `path-claim.schema.json` remains the sole authority, and `primitives.schema.json` gains `repositoryPathClaim` as `{ "$ref": "urn:archflow:schema:v1:path-claim" }`, the same aliasing pattern `mcp-tools.schema.json:8` already uses for `"id"`. Only the frame differs, and since these paths feed digest-bound manifests, a frame mix-up produces a *wrong digest* rather than an error — exactly the failure class brands exist to catch.

`RawGitPath` exists because **not every path a valid repository contains can be branded.** A user's repository may legitimately hold a conflicted file whose name has a colon, a trailing dot, non-NFC text, a reserved device name, or a newline; `git diff --diff-filter=U -z` emits it raw. Typing that list as `RepositoryPathClaim[]` would force either a throw while merely *checking* for unrelated conflicts, or an unsafe cast. `rawGitPath` is total and asserts nothing; `tryRepositoryPathClaim` is the sole promotion, and it returns `undefined` rather than throwing so a caller can count what it cannot represent.

**Lexical rules, extended.** The existing `taskPathClaimV1Schema` rejects empty/`.`/`..` segments, leading `/`, drive and UNC prefixes, backslashes, control characters, and anything over 1024 UTF-8 bytes. Chunk 2 adds: reject `:` anywhere; reject Git pathspec metacharacters `*`, `?`, `[`, `]`; reject the remaining Windows-illegal characters `<`, `>`, `|`; reject segments matching `/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i`; reject segments with a trailing `.` or space; require every segment to be already NFC. The pathspec metacharacters are a correctness rule, not only a portability one: without them a single claimed path can select multiple files in any `git` invocation that takes a pathspec.

**NFC needs a custom Ajv keyword**, because it is not expressible as a `pattern`. `path-claim.schema.json` is a pure `pattern` schema; an NFD sample would make Zod reject while Ajv accepts, failing `assertZodAgreement`. The repository already solved this class of problem — `x-archflow-max-utf8-bytes` at `src/contracts/validators.ts:178` is a custom keyword for the same reason. Chunk 2 adds a fifth keyword, `x-archflow-nfc`.

**`PathSafeId` exists because `safeId` permits `:` and the repository's own corpus proves the collision.** `src/contracts/evidence.ts:23` is `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u`, and `test/contracts/shared-primitives-schema-agreement.test.ts:20` uses `"task-1:phase"` as a canonical **valid** safeId sample. `src/contracts/mcp-tools.ts:30` validates `intent_id: safeId`, so a caller may legally send `intent_id: "retry:3"`; the `intent` path-class template then produces `intents/retry:3.json`, which chunk 2's own tightened claim schema rejects.

**`TaskSlug` lives in `src/contracts/`, not `src/repository/`.** Its pattern is a pure lexical predicate with no Git or filesystem dependency, but `task_id` is validated at the MCP boundary in `mcp-tools.ts:30` as `safeId`, and contracts may not import repository. Left in the repository layer the rule could never be applied where it matters, and the two vocabularies disagree — `safeId` permits uppercase, `_`, `:`, and 128 characters, so a task named `My_Task` would pass `archflow_state` and then fail path resolution deep inside.

`PATH_CLASSES` lives in `path-claims.ts` because `src/contracts/secret-scan.ts` references `PathClass` and contracts cannot import repository.

### The boundary retightening — chunk 3, one atomic change

Zod and JSON Schema are compared by `assertZodAgreement`, so **every Zod edit and its JSON Schema counterpart are a single indivisible change**. Retightening one side alone fails the agreement tests on the first colon or uppercase sample.

**Read this before using the list below.** This inventory has been found incomplete three times across successive reviews. **It is a cross-check, not an authority.** The implementing chunk must **regenerate it mechanically** — grep every occurrence of each logical ID name across all Zod modules in `src/contracts/`, every exported TypeScript interface, all 24 normative JSON Schemas, the advertised-schema closure, and every fixture under `test/` — then reconcile the generated set against the prose list. **Any difference is a design defect to report back, not something to silently absorb**, in either direction: a site the list omits, and a site the list names that no longer exists.

Retightening is **global per logical ID**. There are no per-site exceptions:

| Logical ID | Becomes | Scope |
|---|---|---|
| `task_id` | `taskSlugV1Schema` → `TaskSlug` | **every** occurrence, everywhere |
| `intent_id` | `pathSafeIdV1Schema` → `PathSafeId` | **every** occurrence, everywhere |
| `gate_id`, `prior_gate_id`, `superseded_gate_id`, `origin_gate_id`, `waiver_gate_id` | `pathSafeIdV1Schema` → `PathSafeId` | **every** occurrence, everywhere |
| `rule_id`, `result_id`, `receipt_id`, `invocation_id`, `connection_id`, `decision_event_id`, `helper_invocation_id`, `detector_id`, `input_id` | unchanged `safeId` | **no** occurrence changes |

Known sites, to be reconciled against the mechanical sweep:

- `src/contracts/mcp-tools.ts` — `task_id`/`intent_id` at `:30` and `:128`; `superseded_gate_id` `:58`; `origin_gate_id` + `task_id` `:60`; `origin_gate_id`/`waiver_gate_id`/`task_id` `:80`. `rule_id` (`:27`, `:80`) and `result_id` (`:128`) stay `safeId`.
- `src/contracts/gates.ts` — `gate_id` and `task_id` on the decision envelope base at `:120`. `connection_id` and `decision_event_id` (`:117`) stay.
- `src/contracts/trust.ts` — `:157` parses `current_evidence.slots[*].gate_id` with the module-local `idSchema`; also the `gate_id` on `ObservationBindingByKind["review"]`.
- `src/contracts/supplemental.ts` — `:7` `SupplementalGateRef.prior_gate_id` and `task_id`; `:9` `GateSupersessionRef.superseded_gate_id`; `:21` `gateShape`; `:23` `gateCounterSlotSchema.gate_id`.
- `src/contracts/schemas/v1/mcp-tools.schema.json` — line 8 defines one local `"id": { "$ref": "…primitives#/$defs/safeId" }` that **every** id field points at: `task_id`/`intent_id` at 63–64, 98–99, 158–159, 208–209, 266–267, 371–372, plus `superseded_gate_id:283`, `origin_gate_id:390,421`, `waiver_gate_id:422`. Add `#/$defs/taskSlug` and `#/$defs/pathSafeId` and repoint each site individually — a global rename would be wrong, because `rule_id` and `result_id` must keep `safeId`.
- `src/contracts/schemas/v1/gate-decision.schema.json:107-112` — `gate_id` and `task_id`, currently `#/$defs/safeId`.
- `src/contracts/schemas/v1/result-expectation.schema.json:35-36` — `task_id` and `intent_id`, currently `#/$defs/id`, mirroring `mcp-tools.ts:128`.
- `src/contracts/schemas/v1/evidence-slots.schema.json:12` — `gateCounter.gate_id`, currently `#/$defs/id` (line 9, the colon-permitting pattern).
- `src/contracts/schemas/v1/supplemental-review.schema.json` and the authority-link contracts — the same logical gate and task IDs.
- `src/contracts/schemas/v1/project-error.schema.json:109,1434,1527` — `path_class`, only if chunk 3 takes the optional `z.enum(PATH_CLASSES)` narrowing; skipping the JSON side breaks `test/contracts/gate-error-schema-agreement.test.ts`.

**Branded public interfaces.** Retyping the schemas is not enough — the exported interfaces must carry the brands too, or every downstream call needs a cast. `CommonToolInput`, `StateInput`/`CounterReviewInput`/`AdjudicateInput`/`GateInput`/`WaiverInput`, `ResultIdentityPayload`, `WaiverDecisionBinding`, `GateDecisionEnvelopeBase`, `GateSupersessionRef`, and `SupplementalGateRef` all change `task_id: string` to `task_id: TaskSlug` and the gate/intent fields to `PathSafeId`. A compile-time test asserts that a plain `string` is not assignable to any of them.

**`SNAPSHOT_LIMIT.offending_paths` is retyped, not excepted.** The previous revision left it `taskPathClaimV1Schema` on the grounds that both brands erase to the same wire schema. That was wrong: the paths it reports are declared outputs, which are repository-relative, so leaving it task-branded forces a cast across frames at the one place a caller assembles the diagnostic. It becomes `z.array(repositoryPathClaimV1Schema)` in `errors.ts`, its `project-error.schema.json` `$ref` repoints to the `repositoryPathClaim` alias — the same lexical authority, so no wire change — and its fixtures update.

**`task-branch-constitution` stays a literal, sourced from the enum.** `gates.ts:34` declares the field as the literal type and `gates.ts:93` parses `z.literal("task-branch-constitution")`; `gate-contract.schema.json:259` is `"const"`. Substituting `z.enum(PATH_CLASSES)` would let the `constitution-edit` gate accept `"repository-source"` or `"document"` when exactly one value is ever legal — and `parseGateContext` (`gates.ts:150`) ends in `contexts[kind].parse(value) as GateContext<K>`, an unchecked cast, so a widened runtime result would be silently cast to a 1-value declared type with `tsc` never noticing. The fix removes only the duplication: `z.literal("task-branch-constitution" satisfies PathClass)`. The JSON Schema `const` is untouched.

**Test corpus chunk 3 must update.** The fixtures are saturated with the exact strings being outlawed: `test/unit/mcp-tools.test.ts:124,139` (`task_id: "Task:1"`, `intent_id: "Intent:1"`) and `:244` (`task_id: "Task_1"` — the very string this design uses as its motivating counter-example is a live passing fixture); `test/contracts/mcp-advertised-schema.test.ts:118` (`COMMON`, feeding every advertised-schema case); `test/contracts/gate-error-schema-agreement.test.ts:38` (`task_id: "Task_1"`, `gate_id: "Gate:1"`); `test/contracts/mcp-contract-agreement.test.ts:50,85,97`; `test/unit/trust.test.ts` and `test/unit/supplemental.test.ts`, plus the gate/supplemental exhaustive fixtures, which currently accept `Gate:1` and `Task_1`. The JSON fixtures under `test/fixtures/` use `task-1`/`intent-1` and are safe. `test:mcp-runtime` is a **separate `npm run check` step** and also fails until `mcp-tools.test.ts` is updated. In `test/contracts/shared-primitives-schema-agreement.test.ts`, **append two rows to the `it.each` table at line 18** — one for `pathSafeId`, one for `taskSlug`; the existing `"task-1:phase"` row is unchanged, and that table is explicit rather than `$defs`-derived, so new `primitives.schema.json` entries neither break it nor gain coverage automatically.

### `src/repository/git.ts` — chunk 4

```ts
export type GitFailureKind =
  | "not-installed" | "not-executable" | "timeout" | "output-overflow"
  | "spawn-failed" | "command-failed";
export class GitInvocationError extends Error {
  readonly kind: GitFailureKind;
  readonly operation: SafeCode;
  readonly argv: readonly string[];
  readonly code?: number;
  readonly stderr?: string;
}

/** Absence is command-specific and caller-declared; never inferred from exit 128 alone. */
export interface ExpectedAbsence {
  readonly code: number;
  readonly stderrIncludes: string;
}
export interface GitCommandSpec {
  readonly argv: readonly string[];
  readonly operation: SafeCode;          // e.g. "git-ls-files", "git-check-attr", "git-status"
  readonly expectedAbsence?: readonly ExpectedAbsence[];
  readonly maxBuffer?: number;           // default 8 MiB
  readonly timeoutMs?: number;           // default 30_000
}
export interface GitInvocationResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly absent: boolean;              // true only via a matched ExpectedAbsence
}
export interface GitRunner {
  readonly cwd: string;
  readonly run: (spec: GitCommandSpec) => Promise<GitInvocationResult>;
  readonly runText: (spec: GitCommandSpec) => Promise<string>;
  readonly runNulFields: (spec: GitCommandSpec) => Promise<readonly string[]>;
}
export function createGitRunner(options: {
  readonly cwd: string;
  readonly gitPath?: string;
  readonly maxBuffer?: number;
  readonly timeoutMs?: number;
}): GitRunner;

export interface GitEnvironment {
  readonly version: SafeVersion;
  readonly object_format: "sha1";
}
export function preflightGit(
  runner: GitRunner,
  context: RepositoryOperationContext,
): Promise<ProjectResult<GitEnvironment>>;
```

**`exit 128 ⇒ absent` is withdrawn as unsafe.** Git returns 128 for dubious ownership, corrupt objects, a corrupt repository, invalid revision syntax, and many other fatal conditions — treating all of them as "the object is not there" turns a broken repository into a silent empty answer. Each command declares its own `expectedAbsence` entries, and a nonzero exit is classified as absence **only** when both the exact code and the accompanying diagnostic substring match. Everything else nonzero throws `GitInvocationError` with `kind: "command-failed"`.

**The three methods behave identically on failure**, so chunks 5–8 cannot each invent a convention:

| Outcome | `run` | `runText` | `runNulFields` |
|---|---|---|---|
| exit 0 | result, `absent: false` | UTF-8 decoded, single trailing LF stripped | NUL-split, trailing empty field dropped |
| nonzero matching an `expectedAbsence` | result, `absent: true` | `""` | `[]` |
| any other nonzero | throws `command-failed` | throws | throws |
| spawn `ENOENT` / `EACCES` | throws `not-installed` / `not-executable` | throws | throws |
| past `timeoutMs` | throws `timeout` | throws | throws |
| past `maxBuffer` | throws `output-overflow` | throws | throws |

`runText` decodes with fatal UTF-8; `runNulFields` returns raw fields without decoding assumptions beyond fatal UTF-8, and never strips or interprets `\t`.

### Error context and the complete failure map — chunk 4 publishes, all readers consume

Every project error this phase promises requires parameters no Git command returns. The context is therefore an explicit argument, not something readers invent.

```ts
export interface RepositoryOperationContext {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly operation: SafeCode;     // the logical operation, e.g. "startup-check", "handoff-check"
  readonly attempt: SafeInteger;
}
```

Every failure branch in this phase maps to exactly one code with exactly these parameters:

| Branch | Code | Parameters |
|---|---|---|
| `git` missing / not executable | `REPOSITORY_NOT_FOUND` | `{repository_candidate_digest: repositoryCandidateDigest(runner.cwd)}` |
| not inside a work tree; bare repo; inside `.git/` | `REPOSITORY_NOT_FOUND` | same |
| timeout, overflow, spawn failure, `command-failed` | `IO_ERROR` | `{operation: context.operation, attempt: context.attempt}` |
| Git below the ~2.25 floor | `RUNTIME_VERSION_UNSUPPORTED` | `{component: "git", version}` |
| `--show-object-format` is `sha256` | `RUNTIME_VERSION_UNSUPPORTED` | `{component: "git-object-format", version: "sha256"}` |
| shallow clone; unborn HEAD; submodule | `REPOSITORY_NOT_FOUND` | `{repository_candidate_digest}` |
| recorded identity ≠ observed | `REPOSITORY_MISMATCH` | `{expected_digest, observed_digest}` — both repository identity digests |
| claim fails the lexical schema | `PATH_INVALID` | `{task_id, path_class}` |
| containment rejects the resolved path | `PATH_ESCAPE` | `{task_id, path_class}` |
| claim resolves outside the active task | `TASK_SCOPE_VIOLATION` | `{task_id, path_class}` |
| `.archflow/**` index mode ≠ `100644`, or mode `160000` anywhere | `TASK_INVALID` | `{task_id, issue_code: "archflow-tree-mode-illegal"}` |
| `check-attr` reports anything but `text: unset` / `merge: binary` | `TASK_INVALID` | `{task_id, issue_code: "archflow-attributes-missing"}` |
| a returned path ≠ the requested claim | `TASK_INVALID` | `{task_id, issue_code: "git-path-mismatch"}` |
| conflicted `.archflow/` path present | `GIT_CONFLICT` | `{operation: context.operation}` |
| upstream tracked and ahead ≠ 0 and behind ≠ 0 | `GIT_DIVERGED` | `{expected_digest: historyIdentityDigest(upstreamOid), observed_digest: historyIdentityDigest(headOid)}` |
| any in-progress operation present | `HANDOFF_REQUIRED` | `{phase_instance: context.phase_instance}` |
| `config.yaml` bytes ≠ pinned digest | `PINNED_CONFIG_MISMATCH` | `{expected_digest, observed_digest}` |

`historyIdentityDigest` and `repositoryCandidateDigest` are pinned in chunk 1 precisely so two chunks cannot construct the same error with different digests. `GIT_DIVERGED`'s parameters are `sha256` digests, not raw OIDs, because `PROJECT_PARAMETER_SCHEMAS` requires `/^[0-9a-f]{64}$/`; hashing the OID through the shared helper satisfies that without inventing a per-chunk encoding.

### `src/repository/identity.ts` — chunk 5

```ts
export interface WorktreeLocation {
  readonly worktreeRoot: string;   // absolute realpath; where .archflow/ lives
  readonly gitDir: string;         // absolute, per-worktree
  readonly gitCommonDir: string;   // absolute, shared across linked worktrees
  readonly linked: boolean;
}

declare const rootBoundBrand: unique symbol;
/** A runner whose cwd is provably the worktree root. Only discovery can mint one. */
export interface RootBoundGitRunner extends GitRunner {
  readonly location: WorktreeLocation;
  readonly [rootBoundBrand]: true;
}
/** Returns the runner, not just the location: there is no way to keep using the unbound one. */
export function discoverWorktree(
  runner: GitRunner,
  context: RepositoryOperationContext,
): Promise<ProjectResult<RootBoundGitRunner>>;

export interface RepositoryIdentity {
  readonly schema_version: "1";
  readonly object_format: "sha1";
  readonly root_commits: readonly GitOid[];  // ordinal-sorted, one entry per root
  readonly digest: Sha256Digest;             // sha256(canonicalJsonBytes({object_format, root_commits}))
}
export function resolveRepositoryIdentity(
  runner: RootBoundGitRunner,
  environment: GitEnvironment,
  context: RepositoryOperationContext,
): Promise<ProjectResult<RepositoryIdentity>>;
export function verifyRepositoryIdentity(
  expected: Sha256Digest,
  observed: RepositoryIdentity,
): ProjectResult<RepositoryIdentity>;

export interface TaskIdentity {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly digest: Sha256Digest;
}
/** Bare return: a pure derivation over already-parsed inputs, per the failure convention. */
export function computeTaskIdentity(taskId: TaskSlug, repository: RepositoryIdentity): TaskIdentity;
```

**The root-bound runner closes a silent-wrong-answer hole, reproduced.** From a subdirectory `repo/sub`, `git ls-files -s -- .archflow/…` returns **nothing** and `git check-attr text merge -- .archflow/…` returns `text: auto` / `merge: unspecified` — no error in either case, just the wrong answer. Spelling it `../.archflow/…` finds the file but emits a path that can never be a valid `RepositoryPathClaim`. Making every reader below discovery accept only `RootBoundGitRunner` removes the possibility structurally rather than by convention. All pathspecs are top-anchored and literal — `:(top,literal)<claim>` with `--literal-pathspecs` — and every reader **asserts that each returned path is exactly equal to the requested claim**, producing `TASK_INVALID{issue_code:"git-path-mismatch"}` otherwise.

### `src/repository/paths.ts` — chunk 6

```ts
import type { FileHandle } from "node:fs/promises";

declare const resolvedTaskPathBrand: unique symbol;
/** A path proven contained under the worktree root by realpath at resolution time. */
export type ResolvedTaskPath = string & { readonly [resolvedTaskPathBrand]: true };

export interface ResolvedPath {
  readonly path_class: PathClass;
  readonly repositoryRelative: RepositoryPathClaim;
  readonly absolute: ResolvedTaskPath;
}

export function classifyTaskPath(
  taskId: TaskSlug, claim: TaskPathClaim,
): ProjectResult<TaskPathClass>;
export function classifyRepositoryPath(
  claim: RepositoryPathClaim,
): ProjectResult<RepositoryPathClass>;

export function resolveTaskPath(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly claim: TaskPathClaim;                 // rooted at .archflow/tasks/<taskId>/
  readonly expectedClass?: TaskPathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedPath>>;

export function resolveRepositoryPath(options: {
  readonly runner: RootBoundGitRunner;
  readonly claim: RepositoryPathClaim;           // rooted at the worktree
  readonly expectedClass?: RepositoryPathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedPath>>;

/** Throws; failure here is an environment fault with no caller-facing project code. */
export function openResolved(path: ResolvedTaskPath, flags: number): Promise<FileHandle>;
```

**Two resolvers, because one cannot represent all seventeen classes.** `toRepositoryPathClaim(taskId, claim)` necessarily places its result below `.archflow/tasks/<task>/`, yet `shared-workflow`, `shared-constitution`, `task-branch-constitution`, and `repository-source` are rooted at the worktree — `repository-source` is not under `.archflow/` at all. Splitting the API and partitioning the class enum makes the wrong call unrepresentable rather than merely discouraged.

**Every class, its template, and its required identifiers.** Task-scoped classes resolve relative to `.archflow/tasks/<task-id>/`; repository-scoped classes relative to the worktree root.

| Class | Scope | Template | Required identifiers |
|---|---|---|---|
| `task-config` | task | `config.yaml` | — |
| `task-state` | task | `state.json` | — |
| `gate-interface` | task | `gate.json` \| `gate.decision` | — |
| `document` | task | `prd.md` \| `design.md` \| `phases/<n>/design.md` \| `phases/<n>/impl-notes.md` | positive phase number |
| `review` | task | `reviews/<phase-instance>.{self,counter,triage,adjudication}.md` \| `reviews/<phase-instance>.gate-counter.<gate-id>.md` | phase instance; gate ID for the last form |
| `decision` | task | `decisions/<gate-id>/request.json` \| `decisions/<gate-id>/decision.json` | gate ID |
| `result-manifest` | task | `results/sha256/<result-digest>/manifest.json` | result digest |
| `result-payload` | task | `results/sha256/<result-digest>/payload/<declared-output-path>` | result digest; declared output claim |
| `intent` | task | `intents/<intent-id>.json` | intent ID |
| `attempt` | task | `attempts/<phase-instance>/<attempt-id>.json` | phase instance; attempt ID |
| `manual-checkpoint` | task | `manual/checkpoints/<revision>-<checkpoint-digest>.json` | revision; checkpoint digest |
| `maintenance-record` | task | `maintenance/<maintenance-id>.json` | maintenance ID |
| `import` | task | `imports/<import-digest>/manifest.json` \| `imports/<import-digest>/payload/<legacy-relative-path>` | import digest; legacy claim |
| `shared-workflow` | repository | `.archflow/workflow.yaml` | — (read-only) |
| `shared-constitution` | repository | `.archflow/constitution/<name>.md` | name (read-only) |
| `task-branch-constitution` | repository | `.archflow/constitution/<name>.md` | name |
| `repository-source` | repository | any repository claim **not** under `.archflow/` | — |

Every identifier is a `PathSafeId` except phase instances (`PhaseInstanceId`), digests (`Sha256Digest`, already a strict subset of `PathSafeId`), phase numbers (`PositiveSafePhaseNumber`), and revisions (`SafeInteger`). `attempt-id` and `maintenance-id` have zero occurrences in `src/` today; they are template placeholders here and must be declared `PathSafeId` at birth in Phase 7 or later, never retrofitted. `shared-constitution` and `task-branch-constitution` share one template deliberately: they name the same file and are distinguished by *operation* — reading pinned policy versus detecting a task-branch edit — so `classifyRepositoryPath` returns `shared-constitution` and the caller narrows to `task-branch-constitution` when the operation is the constitution-edit check. That is stated rather than hidden because a path alone cannot decide it.

**Containment is seven steps, in this exact order**: (1) reject NUL, `path.isAbsolute(input)`, or a win32 drive letter *before* resolving; (2) `candidate = path.resolve(root, input)`; (3) `realRoot = await realpath(root)`; (4) `realCand = await realpath(candidate)`, and on `ENOENT` realpath the nearest existing ancestor and re-append the missing tail; (5) `rel = path.relative(realRoot, realCand)`; (6) accept only if `rel === "" || (!rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))`; (7) on the real open, OR in `(fs.constants.O_NOFOLLOW ?? 0)`.

### `src/repository/attributes.ts` and `src/repository/index-entries.ts` — chunk 7

```ts
export const ARCHFLOW_GITATTRIBUTES_RULE = ".archflow/** -text merge=binary";
export interface AttributeCheck {
  readonly path: RepositoryPathClaim;
  readonly text: string;   // must be "unset"
  readonly merge: string;  // must be "binary"
}
export function checkArchflowAttributes(
  runner: RootBoundGitRunner,
  paths: readonly RepositoryPathClaim[],
  context: RepositoryOperationContext,
): Promise<ProjectResult<readonly AttributeCheck[]>>;

export interface IndexEntry {
  readonly path: RepositoryPathClaim;
  readonly mode: GitTreeMode;
  readonly oid: GitOid;
  readonly stage: 0 | 1 | 2 | 3;
}
export function readIndexEntries(
  runner: RootBoundGitRunner,
  paths: readonly RepositoryPathClaim[],
  context: RepositoryOperationContext,
): Promise<ProjectResult<readonly IndexEntry[]>>;
/** Throws; readIndexEntries translates to TASK_INVALID{issue_code:"archflow-tree-mode-illegal"}. */
export function assertArchflowIndexEntry(
  entry: IndexEntry,
): asserts entry is IndexEntry & { readonly mode: ArchflowTreeMode };
```

**Both readers are `-z`, and the cardinality is pinned.** Without `-z`, both `git ls-files -s` and `git check-attr` C-quote non-ASCII filenames — reproduced with `.archflow/ü space.json` — so a caller would have to implement C-style unquoting to recover a name it already knows. With `-z`:

- `git ls-files -s -z --literal-pathspecs -- :(top,literal)<claim>…` emits, per entry, one NUL-terminated field of the form `<mode> <oid> <stage>\t<path>`. Split on NUL first, then on the single `\t`; never split the path on whitespace.
- `git check-attr -z text merge --literal-pathspecs -- <claim>…` emits **NUL triplets, not lines**: `<path>\0<attribute>\0<value>\0`, one triplet per (path, attribute) pair. For N paths and the two attributes requested, that is exactly **2N triplets, i.e. 6N NUL-terminated fields**. Any other count is `TASK_INVALID{issue_code:"git-path-mismatch"}` rather than a best-effort parse.

Both readers assert every returned path is byte-equal to the requested claim, and both reject `160000` outright.

### `src/repository/history.ts` and the barrel — chunk 8

```ts
export type UpstreamState =
  | Readonly<{ kind: "no-upstream" }>
  | Readonly<{ kind: "tracked"; upstream: string; ahead: number; behind: number; upstreamOid: GitOid }>;

export const IN_PROGRESS_OPERATIONS = [
  "merge", "rebase-merge", "rebase-apply", "cherry-pick", "revert",
] as const;
export type InProgressOperation = (typeof IN_PROGRESS_OPERATIONS)[number];

export interface WorktreeHistoryStatus {
  readonly head: GitOid | undefined;        // undefined only for unborn HEAD
  readonly branch: string | "(detached)";
  readonly upstream: UpstreamState;
  readonly inProgress: readonly InProgressOperation[];
  /** Validated: an unrepresentable `.archflow/` name is a TASK_INVALID, since we own that tree. */
  readonly conflictedArchflowPaths: readonly RepositoryPathClaim[];
  /** Raw: a valid repository may legitimately contain names ArchFlow claims cannot express. */
  readonly conflictedOtherPaths: readonly RawGitPath[];
  readonly unrepresentableOtherConflicts: SafeInteger;
}
export function readHistoryStatus(
  runner: RootBoundGitRunner,
  context: RepositoryOperationContext,
): Promise<ProjectResult<WorktreeHistoryStatus>>;
/** ProjectResult<void>, not a third shape: success carries no value, failure carries the code. */
export function classifyMutationReadiness(
  status: WorktreeHistoryStatus,
  context: RepositoryOperationContext,
): ProjectResult<void>;
```

`classifyMutationReadiness` takes the context because none of `GIT_CONFLICT`, `GIT_DIVERGED`, or `HANDOFF_REQUIRED` can be constructed from `WorktreeHistoryStatus` alone: they need `operation`, a digest pair, and `phase_instance` respectively. `UpstreamState.tracked` carries `upstreamOid` for the same reason — the divergence digests are derived from it through `historyIdentityDigest`.

Chunk 8 is the last repository chunk and therefore **owns `src/repository/index.ts`**, creating it once with the exports of chunks 4, 5, 6, 7, and 8. No earlier repository chunk touches the barrel.

### `src/contracts/fingerprints.ts` — chunk 9

```ts
export interface DeclaredInputRef {
  readonly input_id: SafeId;
  readonly digest: Sha256Digest;
}
export interface GitIdentityRef {
  readonly path: RepositoryPathClaim;
  readonly mode: GitTreeMode;
  readonly oid: GitOid;
}

export interface InputFingerprintSubject {
  readonly schema_version: "1";
  readonly workflow_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;
  readonly constitution_digest: Sha256Digest;
  readonly artifact_identities: readonly GitIdentityRef[];   // SET — sorted and deduped internally
  readonly upstream_identities: readonly GitIdentityRef[];   // SET — sorted and deduped internally
  readonly rubric_digest: Sha256Digest;
  readonly phase_instance: PhaseInstanceId;
  readonly declared_inputs: readonly DeclaredInputRef[];     // SET — sorted and deduped internally
}
export function computeInputFingerprint(subject: InputFingerprintSubject): Sha256Digest;

export interface RequestDigestSubject {
  readonly schema_version: "1";
  readonly tool: ToolName;
  readonly repository_identity_digest: Sha256Digest;
  readonly task_identity_digest: Sha256Digest;
  readonly operation: SafeCode;
  readonly operation_fields: PlainJsonObject;
  readonly input_fingerprint: Sha256Digest;
}
export function computeRequestDigest(subject: RequestDigestSubject): Sha256Digest;

/** Names that may never appear in `operation_fields`; asserted, not filtered. */
export const EXCLUDED_REQUEST_DIGEST_FIELDS: readonly string[];

export function computePinnedConfigDigest(configBytes: Uint8Array): Sha256Digest;
export function verifyPinnedConfig(
  expected: Sha256Digest,
  observedBytes: Uint8Array,
): ProjectResult<Sha256Digest>;
```

**All three collections are sets, and that is what makes the fingerprint deterministic.** `canonicalJsonBytes` sorts object keys but deliberately preserves array order, so an unsorted collection lets two callers hash identical logical inputs to different fingerprints — a silent divergence that would surface much later as a spurious `INPUT_FINGERPRINT_MISMATCH`. `InputFingerprintSubject` contains **no semantic sequences**. `computeInputFingerprint` therefore sorts before hashing: `artifact_identities` and `upstream_identities` by `path` ordinal, `declared_inputs` by `input_id` ordinal. A duplicate key in any of the three **throws** rather than being deduplicated, because two entries claiming the same path with different OIDs is a caller bug, not something to silently resolve. Permutation tests must prove that shuffling any collection yields an identical digest, and duplicate tests that a repeated key is rejected. `operation_fields` needs no rule — it is a plain object whose keys canonical JSON already sorts.

### `src/contracts/secret-scan.ts` — chunk 9

```ts
export interface SecretScanCandidate {
  readonly virtual_path: RepositoryPathClaim;   // never a filesystem path, never raw Git output
  readonly path_class: PathClass;
  readonly content: string;
}
export interface SecretFinding {
  readonly detector_id: SafeId;
  readonly path_class: PathClass;
  readonly virtual_path: RepositoryPathClaim;
  readonly line: SafeInteger;             // .min(1); 1-based, matching editor and secretlint convention
  readonly column: SafeInteger;           // .min(1)
}
export type SecretScanResult =
  | Readonly<{ schema_version: "1"; outcome: "clean"; detector_set_id: SafeId; scanned_paths: readonly RepositoryPathClaim[] }>
  | Readonly<{ schema_version: "1"; outcome: "detected"; detector_set_id: SafeId; findings: readonly SecretFinding[] }>
  | Readonly<{ schema_version: "1"; outcome: "unavailable"; reason: SafeCode }>;

export const secretScanResultV1Schema: z.ZodType<SecretScanResult>;
export function parseSecretScanResult(value: unknown): SecretScanResult;   // throws, per the convention
/** Interface Phase 8 implements. This phase ships the contract and no implementation. */
export interface SecretScanner {
  readonly scan: (candidates: readonly SecretScanCandidate[]) => Promise<SecretScanResult>;
}
```

**The path fields are `RepositoryPathClaim` and that is provable, not assumed.** Secret-scan candidates are always *declared* paths — a candidate projection ArchFlow itself generates under `.archflow/`, or a declared implementation output the caller supplied and the claim schema already validated. They are never raw Git output, so no unrepresentable name can reach this contract. A compile-time test asserts a `RawGitPath` is not assignable to `virtual_path`, making the provenance invariant enforced rather than documented.

`SecretFinding` carries no matched text, no surrounding context, and no redacted excerpt. The existing `SECRET_DETECTED` error takes exactly `{path_class, detector_id}`, which is the correct shape. `SafeInteger` permits `0`, so `line` and `column` carry `.min(1)` rather than leaving the base-index question to the implementing agent.

**Safety note for whoever adapts an engine in Phase 8:** secretlint puts the **matched secret into `message`** — verified output reads `"found GitHub Token…: ghp_16C7e"`. The adapter must **explicitly drop `message`**, not merely omit it from the TypeScript type, or the value survives into logs through a stray object spread. `loc.start.line` and `loc.start.column` map cleanly onto this contract, and `ruleId` maps onto `detector_id`.

## Files

| Action | File | Chunk | Purpose |
|--------|------|-------|---------|
| Create | `src/contracts/canonical.ts`, `test/unit/canonical.test.ts` | 1 | Canonical JSON, SHA-256, Git blob OID, tree modes, shared error-digest helpers. |
| Create | `scripts/release-support.d.mts` | 1 | Hand-written declarations so the parity test passes `tsc --noEmit`. |
| Create | `test/contracts/canonical-parity.test.ts` | 1 | Prove the TypeScript and `.mjs` primitives agree over a shared corpus. |
| Modify | `.gitattributes` | 1 | Append `.archflow/** -text merge=binary` after the existing `* text=auto`. |
| Modify | `src/contracts/validators.ts` | 2 | Add the fifth custom Ajv keyword `x-archflow-nfc`. |
| Modify | `src/contracts/evidence.ts`, `src/contracts/schemas/v1/primitives.schema.json` | 2 | `PathSafeId`, `TaskSlug`, `repositoryPathClaim` `$defs`, all branded. |
| Modify | `src/contracts/path-claims.ts`, `src/contracts/schemas/v1/path-claim.schema.json` | 2 | Lexical hardening, `RepositoryPathClaim`, `RawGitPath`, the two class enums. |
| Modify | `src/contracts/mcp-tools.ts` + `mcp-tools.schema.json`; `gates.ts` + `gate-decision.schema.json`; `trust.ts`; `supplemental.ts` + `supplemental-review.schema.json`; `errors.ts` + `project-error.schema.json`; `result-expectation.schema.json`; `evidence-slots.schema.json` | 3 | The mechanically regenerated ID inventory, applied atomically across Zod and JSON Schema. |
| Modify | `test/unit/mcp-tools.test.ts`, `test/unit/trust.test.ts`, `test/unit/supplemental.test.ts`, `test/unit/path-claims.test.ts`, `test/contracts/mcp-advertised-schema.test.ts`, `test/contracts/mcp-contract-agreement.test.ts`, `test/contracts/gate-error-schema-agreement.test.ts`, `test/contracts/gate-error-supplemental-exhaustive.test.ts`, `test/contracts/shared-primitives-schema-agreement.test.ts` | 3 | Replace colon/underscore ID fixtures; append two `it.each` rows. |
| Create | `src/repository/git.ts`, `test/unit/repository-git.test.ts` | 4 | Runner, per-command absence, typed failure channel, `RepositoryOperationContext`. |
| Create | `src/repository/identity.ts`, `test/unit/repository-identity.test.ts` | 5 | Discovery, the root-bound runner, repository and task identity. |
| Create | `src/repository/paths.ts`, `test/unit/repository-paths.test.ts` | 6 | Two resolvers, the class table, containment, `ResolvedTaskPath`. |
| Create | `src/repository/attributes.ts`, `src/repository/index-entries.ts`, `test/unit/repository-index.test.ts` | 7 | `-z` `check-attr` triplets and `ls-files -s`, top-anchored literal pathspecs. |
| Create | `src/repository/history.ts`, `test/unit/repository-history.test.ts`, `src/repository/index.ts` | 8 | Porcelain v2 parsing, raw conflict paths, and the sole repository barrel. |
| Create | `src/contracts/fingerprints.ts`, `src/contracts/secret-scan.ts`, `src/contracts/schemas/v1/secret-scan-result.schema.json`, their tests and fixtures | 9 | Digests, set ordering, config pinning, secret-scan result contract. |
| Modify | `src/contracts/versions.ts`, `test/contracts/schema-registry.test.ts`, `src/contracts/index.ts` | 1–9 | Append-only registration, in strict chunk order. |
| Create | `test/integration/repository-git-matrix.test.ts` plus repository fixture helpers | 10 | Real temporary repositories covering the claims actually under test. |

`package.json` and `.github/workflows/ci.yml` are deliberately **not** modified. `vitest.config.ts` already includes `test/**/*.test.ts`, so bare `npm test` — already the fourth step of `npm run check` and of CI — picks up the new integration suite automatically. Adding a `test:repository` script and wiring it into `check` would run the phase's most expensive suite twice.

Registration files are shared and **append-only in strict numeric chunk order**. This is safe because `test/contracts/schema-registry.test.ts:31` is `as const satisfies Record<keyof typeof SCHEMA_IDS, string>`: appending to `SCHEMA_IDS` without the matching `SCHEMA_FILES` row fails `tsc --noEmit`, so each chunk's registry edits are necessarily atomic. New `$id` values use `urn:archflow:schema:v1:<kebab-name>`, matching the 22-of-24 majority; the two `https://archflow.dev/...` IDs are legacy and are not a precedent.

## Contract and Digest Rules

- **Blob OID formula.** `OID = SHA1("blob " + ASCII_decimal(byteLength) + "\0" + contentBytes)`, where `byteLength` counts the content only. Verified: `printf 'hello\n' | git hash-object --stdin` and `printf 'blob 6\0hello\n' | sha1sum` both yield `ce013625030ba8dba906f756967f9e9ca394464a`. Computed in-process with `node:crypto`; no subprocess, no shell-escaping surface, trivially unit-testable.
- **`.archflow/** -text merge=binary`, at the repository root.** This is the highest-leverage line in the phase. With `-text` in force the attribute overrides `core.autocrlf` and `core.eol` entirely, so the blob OID becomes a pure function of the file's bytes, independent of every EOL-related config and of the platform. Measured: with no attribute, `autocrlf=false` hashes to `c30dea8a…` while `autocrlf=true` and `input` hash to `422c2b7a…`; with `-text` in force all three collapse to `c30dea8a…`. That collapse is what licenses in-process hashing. Use `merge=binary` — one of the three built-in low-level merge drivers (`text`, `binary`, `union`) — not the `binary` macro (`-diff -merge -text`), because the macro also kills diffs and readable `git diff` on state files is a real reviewer benefit.
- **Both attribute claims have now been independently reproduced by a second reviewer**, on a fresh repository: `git check-attr text merge` on an `.archflow/` path reports exactly `text: unset` and `merge: binary`, and a forced modify/modify conflict left the JSON **parseable with zero conflict markers** while `git status --porcelain=v2` and `git diff --name-only --diff-filter=U -z` both still reported the path unmerged. Conflict detection and file parseability are genuinely independent, which is the property the whole design leans on.
- **Ordering and renormalization.** `.gitattributes` already begins with `* text=auto`, and Git applies the **last** matching rule, so the new line is appended after it, never before. Because `.archflow/` is already tracked here with content, and changing attributes does not rewrite existing index blobs, a Windows checkout with `autocrlf=true` will show every `.archflow/` file as modified until someone runs `git add --renormalize .`. Invisible on Linux; a one-time cost, recorded rather than engineered around.
- **The attribute is verified at runtime, never assumed** — with the precedence stated correctly. Verified order: `$GIT_DIR/info/attributes` > in-tree `.gitattributes` > `core.attributesFile` > system. **Only `info/attributes` can override the repository file**; a global or system attributes file cannot.
- **Somebody has to create `.gitattributes` in the user's repository, and it is not this phase.** The `.gitattributes` change above modifies *this* repository; the server operates on the user's, and this phase implements no mutation. **Task initialization owns it** in Phase 7 or later, and until then `checkArchflowAttributes` is exercised entirely against temporary-repository fixtures. The `TASK_INVALID{issue_code:"archflow-attributes-missing"}` diagnostic must carry the remediation verbatim — *"add `.archflow/** -text merge=binary` to the repository root `.gitattributes`, commit it, then run `git add --renormalize .archflow`"* — because a bare failure is worthless to the user.
- **Legal tree modes** are `100644`, `100755`, `120000`, `160000`, `040000`. Raw tree objects store `40000` unpadded while `ls-tree`/`ls-files` display `040000`; normalise to the 6-character form.
- **Below `.archflow/**`, only mode `100644` is legal.** No executables, symlinks, or gitlinks. This single rule removes the entire `core.fileMode` / `core.symlinks` problem space for our own files.
- **For tracked repository outputs, mode and OID come from the index, never the filesystem** — `git ls-files -s`. `-s` is preferred over `--format`, which needs Git ≥2.38 and would raise the floor for no gain. `core.fileMode=false` makes Git ignore the filesystem executable bit and reuse the index mode; porcelain v2's three modes are `<mH> <mI> <mW>` and only `<mI>` may be trusted. Mode `160000` is rejected outright.
- Symlink-incapable checkouts need no special case. Git stores a symlink as a blob whose content is the target path with **no** trailing newline, and the index still records `120000`, so index-sourced mode plus content-derived OID is already stable across `core.symlinks=true/false`.
- **Object format fails closed on `sha256`.** `git rev-parse --show-object-format` is the detection command; reading `extensions.objectFormat` is wrong because that key is absent in a SHA-1 repository. SHA-1 remains the default in current Git — 2.55.0, released 2026-06-29 — and the SHA-256 flip is an unscheduled Git 3.0 item with no interoperability path.
- **One Git version floor: approximately 2.25**, from `--show-object-format`, absent in v2.24.0 and present in v2.25.0. The design avoids the two higher floors — `ls-files --format` (~2.38) and `rev-parse --path-format` (~2.31) — but does not reach zero.
- **Repository identity** = `sha256(canonicalJsonBytes({ object_format, root_commits }))`, where `root_commits` is the ordinal-sorted output of `git rev-list --max-parents=0 HEAD`. It contains no filesystem path, so it survives relocation and is shared by all linked worktrees. A generated UUID in a tracked `.archflow/repo-id` file was rejected: it survives more, but it introduces a tracked-file authority the architecture does not define and that repository initialization would have to create.
- **Canonical JSON** mirrors `scripts/release-support.mjs`: recursive key sort by ordinal comparison, 2-space indent, one trailing newline, UTF-8, arrays keep source order, `undefined` and non-finite numbers rejected. The script is `.mjs` and cannot import TypeScript, so the duplication is deliberate — and it is **three** primitives: `canonicalJsonBytes`, `assertPortablePath`, and the containment predicate. One divergence is recorded rather than removed: `release-support.mjs`'s private `isInside` requires `rel !== ""`, rejecting the root itself, because a release payload path is always a strict sub-path; containment step 6 here accepts `rel === ""` because a path class may legitimately resolve to the task root.
- **The request digest has one closed field list**: contract/schema version, logical tool name, canonical repository identity, canonical task identity, operation tag, that operation's request-specific semantic fields, and the recomputed declared-input fingerprint. Nothing else participates. The exclusions are the security property and are asserted, not filtered: `intent_id` identifies the receipt but is not self-hashed; `expected_revision`, connection/transport identifiers, timestamps, attempt counters, timeout/cancellation state, and retry metadata are all excluded. A retry after `SUPPLEMENTAL_REVIEW_REQUIRED` reuses the same digest with a refreshed `expected_revision`.
- **The declared-input fingerprint** hashes the versioned workflow digest, the immutable whole-config digest, the pinned constitution digest, canonical artifact and upstream Git identities, the rubric digest, the phase instance, and explicitly declared inputs — with the set-ordering rules above applied before hashing. The caller's `input_fingerprint` is an assertion, never authority; the server always recomputes.
- **Config pinning is `sha256` over the exact whole `config.yaml` bytes.** There is no in-task amendment and no re-pin schema: an intentional routing, model, or effort change requires a distinct task or the explicit upgrade flow, which is why whole-config binding can never cause partial in-task evidence invalidation. Any byte difference produces `PINNED_CONFIG_MISMATCH` with `{expected_digest, observed_digest}` and **no config content**. That code already exists with exactly that parameter pair and currently has zero producers; this phase gives it one. No `config.yaml` exists anywhere in the repository — only test fixtures — so this phase adds the pinning function and its fixtures, not a shipped config file.
- **Error catalogue: no new code.** Every code in the failure map already exists. If one were ever required it would be three coordinated edits in `src/contracts/errors.ts` — the `ProjectErrorCode` union, `PROJECT_PARAMETER_SCHEMAS` (typed `as const satisfies Record<ProjectErrorCode, …>`, so a gap is a compile error), and `PROJECT_ERROR_DEFINITIONS` — plus two exhaustiveness assertions: `test/unit/errors.test.ts` asserts exactly 52 project codes and `test/contracts/gate-error-supplemental-exhaustive.test.ts` asserts exactly 56 total rows.
- **`SCHEMA_IDS` is `as const`, not `Object.freeze`** — immutability is a type-level guarantee only. The real enforcement is the registry bijection test plus the `satisfies` constraint on `SCHEMA_FILES`.

## Path, Git, and Runtime Boundaries

- The single `:` rejection neutralises Windows drive-relative escapes, alternate data streams (`file.txt:stream`), and UNC in one check. The live precedent is CVE-2026-31802 / GHSA-9ppj-qmqm-q256 (CVSS 8.2, `node-tar` ≤7.5.10, fixed 7.5.11, published 2026-03-09): node-tar validated `..` against a path still carrying the `C:` prefix, then stripped the drive letter afterward, yielding arbitrary file overwrite. The lesson this design encodes everywhere: **validate containment on the final normalised path, never on an intermediate form.** Reserved device names match with any extension (`CON.txt` is still `CON`), and Win32 silently strips trailing dots and spaces so `a.` and `a` alias the same file.
- **NFC is required, not applied.** On Linux/ext4 NFC and NFD are genuinely different files; APFS is normalisation-insensitive but preserving, so the same two names are one file on macOS. That mismatch is a real bypass class — see the setuptools `MANIFEST.in` exclusion bypass, GHSA-h35f-9h28-mq5c. Normalising naively would be worse than not normalising: on Linux the normalised string names a file that does not exist. Since `.archflow/` names are slugs we generate, requiring NFC costs nothing. Task slugs are constrained rather than case-folded, because naive `toLowerCase()` is locale-hazardous (`'İ'.toLowerCase()` has length 2).
- Every containment step is load-bearing. Step 1 is not optional: an absolute second argument makes `path.resolve` discard the root entirely — `resolve('/srv/root', '/etc/passwd')` is `/etc/passwd`. Steps 3–4 are the whole control; without them this is a string check, not a security boundary. Step 6 uses `path.relative` rather than `startsWith` because `startsWith(root)` accepts `/srv/root-evil/x` and `/srv/rootx`, while `startsWith(root + sep)` rejects the root itself.
- **Step 7's `?? 0` is defensive clarity, not a correctness fix.** Bitwise OR applies `ToInt32`, so `flags | undefined` evaluates to `flags`, not `NaN`; the flag would simply be dropped silently. The real point is platform-specific: `O_NOFOLLOW` does not exist on Windows, so on Windows step 7 is a **no-op** and the symlink defence there rests entirely on steps 3–6. Note also that `fsPromises.realpath.native` is `undefined` even though `fs.realpath.native` and `fs.realpathSync.native` exist.
- **Containment is a check-then-use control with an inherent TOCTOU window, and the design says so rather than implying atomicity.** Node 24 has no `openat`-style API: no `O_PATH`, no `O_RESOLVE_BENEATH`, no dir-relative `fs` variants, and `FileHandle` cannot serve as a directory base. There is no Node equivalent of Go's `os.Root`. `O_NOFOLLOW` is defence-in-depth, not a substitute.
- **No dependency, and the evaluation is recorded so the choice is auditable.** `is-path-inside` (64.2M weekly downloads) disqualifies itself in its own bundled type definitions — "You should not use this as a security mechanism" — and does not resolve symlinks; `path-is-inside`, `resolve-path`, and `contains-path` are likewise lexical-only. The one genuinely correct implementation is **`@openclaw/fs-safe@0.5.0`** (MIT, `O_NOFOLLOW`, post-open fd identity verification, kernel-atomic `openBeneath()` on Linux). Its **primary disqualifier is licensing, not size**: it carries an optional dependency on `jszip@3.10.1`, which declares `(MIT OR GPL-3.0-or-later)`. npm installs optional dependencies by default, and `scripts/check-dependency-policy.mjs` matches license strings **exactly**, so `npm run check:dependencies` would fail on the disjunction — and a disjunction is a human legal election, never an automatic pass. Secondary grounds: ~17 MB unpacked with prebuilt native binaries for seven platforms, 22 export subpaths far beyond the need, and pre-1.0 churn — 21 versions between 2026-05-06 and 2026-07-28, with `0.5.0` shipping on 2026-07-28 carrying a breaking migration that removed the Python worker earlier versions required. Roughly thirty lines of our own code is the right call.
- **Git runner discipline** follows the established `scripts/release-support.mjs` style, now in TypeScript: `execFile` with an argv array and no shell, explicit `cwd`, `encoding: "buffer"` where bytes matter, explicit `maxBuffer` and `timeoutMs`. Every call site names its own argv; there is no dynamic command construction, and `--literal-pathspecs` plus `:(top,literal)` prefixes are mandatory wherever a pathspec appears.
- **Worktree discovery.** `--show-toplevel` gives the current worktree root, which is where `.archflow/` lives. `--git-dir` is per-worktree; `--git-common-dir` is shared across linked worktrees. The trap: both return the **relative** path `.git` at the top of the main worktree but an **absolute** path from a linked worktree, so raw output is never concatenated. Rather than adopt `--path-format=absolute` and its ~2.31 floor, resolve the result against the worktree root. Detection matrix: `--is-inside-work-tree`, `--is-bare-repository`, `--is-inside-git-dir`.
- **Refusal conditions, each handled explicitly rather than assumed away.** Multiple root commits are normal in repositories formed with `--allow-unrelated-histories`, so the whole sorted set is hashed and the first line is never taken alone. Shallow clones return the grafted boundary commit, which is not the true root and differs by clone depth — `git rev-parse --is-shallow-repository` gates this. Unborn HEAD fails the root-commit query. Submodules are refused: `git rev-parse --show-superproject-working-tree` prints the parent worktree and is empty otherwise but exits 0 either way, so the test is for empty output, not exit code.
- **Orphan branches are a documented limitation, not a compensated one.** Checking out an orphan branch changes HEAD's root set. Computing over `--all` instead would only trade one instability for another. Identity is recorded at task initialization and compared thereafter, so a change surfaces as `REPOSITORY_MISMATCH` with expected and observed digests — which is the correct behaviour.
- **Porcelain parsing rules.** Use `git status --porcelain=v2 --branch -z`. `-z` matters: without it, unusual paths are backslash-quoted per `core.quotePath`. One wrinkle: in `-z` mode the rename/copy `2` lines put the original path in a separate NUL-terminated field, so field counts differ by entry type. Parse defensively — split on NUL, dispatch on the first token (`1`, `2`, `u`, `?`, `!`, `#`), and ignore unrecognised header lines, because v2 is documented as an extensible set of optional headers while v1 carries the backward-compatibility guarantee. Porcelain v2 has existed since Git 2.11 (2016) and adds no floor of its own.
- **The critical porcelain gotcha:** with no upstream configured, `# branch.upstream` and `# branch.ab` are silently absent. A missing `branch.ab` must never be read as "0 ahead, 0 behind"; "no upstream" is a distinct state and, for a task branch that has never been pushed, the normal one, so it is handled first. `git rev-list --left-right --count '@{upstream}...HEAD'` (three dots required; left is behind, right is ahead) *fails* without an upstream and is a secondary source only.
- **Conflicts and in-progress operations.** `git diff --name-only --diff-filter=U -z` is the cleanest conflicted-path primitive; porcelain `u` lines carry all three stage OIDs and modes when richer data is wanted. Unmerged XY codes are `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`. In-progress markers live under the absolute git dir: `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`. `rebase-merge/` and `rebase-apply/` are **directories**, so the existence check must accept directories. During a rebase `# branch.head` reads `(detached)`, so branch-name logic silently breaks mid-rebase — the rebase is detected first.
- **Honesty constraint, repeated from the architecture:** this detects divergent history and conflicts. It explicitly does **not** claim to detect independent-clone concurrency before divergence. Locking and revision CAS coordinate only processes sharing one filesystem; Git is transport and history, not a distributed lock.
- **Secret scanning is a contract only.** No dependency is added. The Phase 8 candidate and its evidence are recorded so the later decision is cheap: `@secretlint/core@13.0.4` plus `@secretlint/secretlint-rule-preset-recommend@13.0.4`, MIT, published 2026-07-22, pure ESM, `engines: node >=22`, scanning a fully virtual `filePath` with nothing touching disk. That install set is **8 packages / 1.5 MB — MIT ×6 and BSD-2-Clause ×2, zero copyleft**, measured identically by two independent reviewers. The `@secretlint/node` and CLI closures are larger, but their **disqualifier is licensing, not size**: they pull roughly 21 off-allowlist license strings — Artistic-2.0 ×5, WTFPL, Python-2.0, CC0-1.0, CC-BY-3.0, BlueOak-1.0.0, `(MIT OR CC0-1.0)`, plus 14 packages declaring no `license` field — every one of which hard-fails `scripts/check-dependency-policy.mjs`'s exact-string match. (Package *counts* for those larger closures were measured inconsistently and are deliberately not quoted.) Secretlint's known limitation is provider-pattern rules only, with no generic high-entropy rule. Ruled out: `trufflehog` is AGPL-3.0, a poor fit for a network-delivered server; `detect-secrets` needs Python or Docker; the npm `gitleaks` and `trufflehog` packages are unrelated abandoned squats. The gitleaks *scanner* and its `config/gitleaks.toml` are MIT and legally vendorable, but consuming them from Node means a TOML parser plus an RE2→JS regex translation layer plus reimplemented allowlist semantics, which would silently drift from upstream.
- **Not implemented in this phase**: any durable state or artifact schema, state mutation, the transaction kernel, locks, revision CAS, intent receipts, atomic writes, payload snapshot materialisation or restore, gate lifecycle, dispatch, sandbox, the secret-scanning engine, and any new runtime dependency. `package.json` `engines.node` is already `>=24.15.0`; no engine change is needed.

## Work Breakdown

1. **Canonical primitives**: Implement `src/contracts/canonical.ts` against the pinned signatures, including `parseCanonicalDocument`'s full byte-authority contract and the two shared error-digest helpers. Append the `.gitattributes` rule. Add `scripts/release-support.d.mts` and the three-primitive parity test, and confirm it passes `tsc --noEmit` as well as Vitest. Lands alone and first.
2. **ID and path primitives**: Add `PathSafeId` and `TaskSlug` to `evidence.ts` with `primitives.schema.json` `$defs`; add `x-archflow-nfc` to `validators.ts`; extend the lexical claim schema and `path-claim.schema.json` in lockstep; add `RepositoryPathClaim`, `RawGitPath`, `tryRepositoryPathClaim`, `toRepositoryPathClaim`, and the two class enums. Every schema yields a branded value. Change no consumer.
3. **Boundary retightening**: Regenerate the ID inventory mechanically, reconcile it against the prose list, report any difference, then apply the global per-ID retightening atomically across all Zod modules, all JSON Schemas, the branded public interfaces, `SNAPSHOT_LIMIT.offending_paths`, the `z.literal(… satisfies PathClass)` gate fix, and all nine test files. `test:mcp-runtime` and `test:contracts` must both pass before this chunk closes.
4. **Git runner, absence policy, and error context**: Implement `src/repository/git.ts` with `execFile`, argv arrays, no shell, explicit `cwd`/`maxBuffer`/`timeoutMs`, per-command `expectedAbsence`, the six-kind `GitInvocationError`, the three-method behaviour table, and `RepositoryOperationContext`. Preflight the ~2.25 floor and `--show-object-format`, failing closed on `sha256`.
5. **Discovery, root binding, and identity**: Implement `src/repository/identity.ts` — the detection matrix, relative-versus-absolute git-dir resolution, the `RootBoundGitRunner` mint, sorted multi-root identity digest, refusals for bare, inside-`.git/`, shallow, unborn-HEAD, and submodule cases, task identity, and the `REPOSITORY_MISMATCH` comparator.
6. **Path classes and the two resolvers**: Implement `src/repository/paths.ts` with the seven-step containment sequence, the complete class → template → identifier table, both resolvers restricted to their class subsets, `ResolvedTaskPath`, and `openResolved`. Make the existing `@ts-expect-error` brand assertion real.
7. **Attributes and index entries**: Implement `-z` `check-attr` triplet parsing with exact 6N cardinality and `-z` `ls-files -s` field parsing, both top-anchored and literal, both asserting returned paths equal requested claims, with `160000` and non-`100644` `.archflow/` modes rejected through the pinned codes.
8. **History, conflicts, and the barrel**: Implement `src/repository/history.ts` — defensive porcelain v2 `-z` parsing, the distinct no-upstream state carrying `upstreamOid`, validated `.archflow/` conflict claims versus raw other-conflict paths with an unrepresentable count, in-progress detection with rebase first, and `classifyMutationReadiness` constructing all three codes from the context. Create `src/repository/index.ts` once.
9. **Fingerprints, config pinning, and the secret-scan contract**: Implement `src/contracts/fingerprints.ts` with the closed-field request digest, asserted exclusions, set sorting and duplicate rejection before hashing, and whole-file `config.yaml` pinning. Implement `src/contracts/secret-scan.ts` and its schema with no engine and no secret value in any field.
10. **Integration verification**: Build the temporary-repository harness and run the five-repository matrix, the subdirectory-cwd reproduction, Unicode and pathspec-metacharacter filenames, the invalid-name conflict fixture, linked worktree, relocation, `check-attr`, and the forced-conflict proof.

**Ten chunks, inside the 9–10 target.** The split from the previous fifteen-chunk single phase is what makes this fit: Phase 7 now carries every durable schema, and chunk 10 is a real integration chunk rather than verification borrowed from schema work. If it must shrink further, chunk 7 merges into chunk 6 — both are readers over the chunk-4 runner — for nine. Chunks 1 and 2 must stay isolated to be stable seams, and chunks 2 and 3 must **not** be re-merged: publishing primitives and retightening every consumer are separately reviewable, and merging them recreates a defect three successive reviews found.

## Success Criteria

- [ ] Every schema in `evidence.ts` and `path-claims.ts` yields a **branded** value, and `CommonToolInput`, the five tool inputs, `ResultIdentityPayload`, `WaiverDecisionBinding`, `GateDecisionEnvelopeBase`, `GateSupersessionRef`, and `SupplementalGateRef` all carry `TaskSlug`/`PathSafeId` fields. A compile-time test proves a plain `string` is not assignable to any of them.
- [ ] The ID inventory was regenerated mechanically before being applied, reconciled against the document's prose list, and any difference reported rather than absorbed. `task_id`, `intent_id`, and all five gate-ID names are retightened **globally**; `rule_id`, `result_id`, `receipt_id`, `invocation_id`, `connection_id`, `decision_event_id`, `helper_invocation_id`, `detector_id`, and `input_id` are unchanged **everywhere**.
- [ ] Every Zod retightening has its JSON Schema counterpart in the same chunk — `mcp-tools.schema.json`, `gate-decision.schema.json`, `result-expectation.schema.json`, `evidence-slots.schema.json`, `supplemental-review.schema.json`, and `project-error.schema.json` — and `assertZodAgreement` passes across the whole corpus with `test:mcp-runtime` and `test:contracts` green.
- [ ] `SNAPSHOT_LIMIT.offending_paths` is repository-relative in Zod, JSON Schema, and fixtures; no frame cast exists anywhere.
- [ ] `gate-contract.schema.json:259` remains `"const": "task-branch-constitution"` and `gates.ts` still parses a single literal sourced from the enum via `satisfies PathClass`.
- [ ] `TaskPathClaim`, `RepositoryPathClaim`, and `RawGitPath` are three distinct brands. `tryRepositoryPathClaim` is the only promotion from Git output to a claim, and a `RawGitPath` is not assignable to any claim field, including the secret-scan contract's.
- [ ] The lexical schema rejects `:`, `*`, `?`, `[`, `]`, `<`, `>`, `|`, reserved device names, trailing dot/space segments, and non-NFC segments; `x-archflow-nfc` makes Ajv and Zod agree on the NFD cases.
- [ ] Every reader below discovery accepts only a `RootBoundGitRunner`; holding an unrooted runner after discovery is a type error. All pathspecs are `:(top,literal)` under `--literal-pathspecs`, and every returned path is asserted byte-equal to the requested claim.
- [ ] Running any reader from a repository subdirectory produces the same answer as from the root — the reproduced `ls-files` empty result and `check-attr text: auto` wrong answer are both impossible to express.
- [ ] `git ls-files -s` and `git check-attr` are both `-z`; a filename containing spaces and non-ASCII text round-trips unquoted; `check-attr -z` output is validated at exactly 6N NUL fields for N paths and two attributes, and any other count fails rather than being best-effort parsed.
- [ ] Absence is command-specific: no code path treats a bare exit 128 as absence, and a dubious-ownership or corrupt-repository 128 produces `IO_ERROR`, not an empty result. The three-method behaviour table holds for every outcome.
- [ ] Every failure branch in the failure map constructs its exact code with its exact parameters from `RepositoryOperationContext` plus the two shared digest helpers; no reader invents a parameter and no promised error is unconstructible from its own signature.
- [ ] `resolveTaskPath` and `resolveRepositoryPath` are separate, each restricted to its class subset, and every one of the seventeen classes has a template and required identifiers that the resolver can actually produce.
- [ ] `conflictedOtherPaths` is `RawGitPath[]`; a repository containing a conflicted file whose name has a colon, trailing dot, non-NFC text, or newline is reported with an accurate `unrepresentableOtherConflicts` count and never throws while checking unrelated conflicts.
- [ ] `computeInputFingerprint` sorts all three collections before hashing and rejects duplicate keys; shuffling any collection yields an identical digest, and a repeated `path` or `input_id` throws.
- [ ] `parseCanonicalDocument` rejects malformed UTF-8, duplicate keys, permuted key order, wrong indent, and missing or extra trailing newline; `digest` covers the original bytes, proven byte-identical to the re-rendered canonical form.
- [ ] A single tracked file yields identical canonical blob OID and tree mode across the three `core.autocrlf` values, `core.fileMode` on and off, and symlink-capable and symlink-incapable checkouts; the in-process OID matches `git hash-object` in every case exercised.
- [ ] `git check-attr text merge` reports exactly `text: unset` / `merge: binary`; a removed rule and an overriding `$GIT_DIR/info/attributes` rule each produce `TASK_INVALID{issue_code:"archflow-attributes-missing"}` carrying the verbatim remediation.
- [ ] A forced conflict on a `.archflow/` JSON file leaves zero conflict markers and a parseable file while porcelain v2 and `--diff-filter=U -z` both report it unmerged.
- [ ] Multiple root commits, a shallow clone, an unborn HEAD, a submodule, a bare repository, and a cwd inside `.git/` each produce the exact intended outcome; a branch with no upstream is the distinct `no-upstream` state and never "0 ahead, 0 behind".
- [ ] `src/contracts/**` contains no import from `src/repository/**`, `src/contracts/index.ts` exports no repository module, `src/repository/index.ts` exists exactly once, no new error code is added, the 52/56 assertions hold, and `package.json` is unchanged in both `dependencies` and `scripts`.
- [ ] No durable state or artifact schema, no state mutation, no payload restore, no secret-scanning engine, and no runtime dependency is introduced; the full aggregate passes on Node `24.15.0` and `24.18.0`.

## Verification Steps

Steps 1–2 and 7–13 are platform-independent. **Steps 3–6 run on Linux only**, which is all CI provides — `.github/workflows/ci.yml` is `ubuntu-latest` only. `core.autocrlf`, `core.fileMode`, and `core.symlinks=false` are faithfully simulable there, but the Windows-specific rules this design spends the most prose on — trailing-dot and trailing-space stripping, reserved device names as real filesystem aliases, and `O_NOFOLLOW`'s absence — are **verified lexically only**, never against a real Win32 filesystem. That limitation is recorded rather than papered over, and "cross-platform" is not claimed for them.

1. Run the canonical parity suite through both Vitest **and** `tsc --noEmit`: hash a corpus containing nested objects with keys requiring ordinal (not locale) sort, arrays whose order is semantic, empty objects and arrays, deep nesting, non-ASCII strings, and boundary numbers through both `canonicalJsonBytes` implementations, asserting byte equality. Do the same for `assertPortablePath`. Assert the containment predicate matches `isInside` except for `rel === ""`. Then exercise `parseCanonicalDocument` against malformed UTF-8, duplicate keys, permuted key order, four-space indent, a missing trailing newline, and an extra trailing newline, asserting each is rejected and that a valid document's `digest` equals `sha256Bytes` of the input bytes.
2. Verify the blob OID against `git hash-object` for empty content, content without a trailing newline, content with CRLF, binary content containing NUL, and content over 1 MiB. Confirm `printf 'hello\n'` yields `ce013625030ba8dba906f756967f9e9ca394464a`.
3. Build **five** temporary repositories — not a 24-cell cross-product, because this design's own central claim is that `-text` collapses the EOL configurations to one answer, so most cells are provably identical by that very argument and buy no confidence. The five that each test a distinct claim: one repository each at `core.autocrlf` `false`, `true`, and `input` over the same CRLF-containing file; one at `core.fileMode=false` with the executable bit toggled on disk; one at `core.symlinks=false` containing a symlink. In each, assert the in-process OID equals the index OID and that the mode is index-sourced.
4. **Run every reader from a subdirectory as well as the root**, asserting identical results. Construct the reproduced failure explicitly: confirm that an unbound runner in `repo/sub` would return nothing from `ls-files` and `text: auto` from `check-attr`, and that the `RootBoundGitRunner` type makes that call unwritable.
5. Create `.archflow/ü space.json` and a file whose name contains `*`, `?`, and `[`. Assert `-z` output round-trips both unquoted, that the metacharacter name is rejected by the claim schema before any Git call, and that `check-attr -z` yields exactly 6N fields for N paths.
6. Assert `git check-attr text merge` reports exactly `text: unset` / `merge: binary`. Then mutate **two** ways — delete the `.gitattributes` line, and add a conflicting rule in `$GIT_DIR/info/attributes` — and confirm each produces `TASK_INVALID{issue_code:"archflow-attributes-missing"}` with the verbatim remediation. A global or system attributes override is deliberately **not** tested: verified precedence is `info/attributes` > in-tree > `core.attributesFile` > system, so it could never produce the required error.
7. Force a conflict on a `.archflow/` JSON file, on a control file without the attribute, and on **a file outside `.archflow/` whose name is invalid under ArchFlow claims** (a colon, a trailing dot, and a non-NFC name). Assert the `.archflow/` file has zero markers and parses, the control file has markers, both appear unmerged in porcelain v2 and `--diff-filter=U -z`, and the invalid-named conflict appears in `conflictedOtherPaths` as a `RawGitPath` with `unrepresentableOtherConflicts` incremented and no throw.
8. Exercise a linked worktree created with `git worktree add` — asserting `--git-dir` and `--git-common-dir` return relative `.git` from the main worktree and absolute paths from the linked one — plus a relocated repository directory and paths containing spaces and Unicode.
9. Construct every identity failure mode: two roots merged with `--allow-unrelated-histories` (assert sorted multi-root hashing and that taking the first line alone would differ), a `--depth=1` clone, a fresh `git init` with unborn HEAD, a submodule checkout (assert refusal on empty-versus-non-empty `--show-superproject-working-tree` output, not exit code), a bare repository, and a cwd inside `.git/`. Separately, stub the runner to raise `ENOENT`, `EACCES`, a timeout, a `maxBuffer` overflow, an undeclared nonzero exit, a **128 with a dubious-ownership diagnostic**, and a 128 matching a declared `expectedAbsence`, asserting the exact code and parameters from the failure map in each case.
10. Exercise the path matrix through both resolvers: `../escape`, `a/../../etc/passwd`, `/etc/passwd`, `C:foo`, `D:..\x`, `\\?\C:\x`, `\\server\share\y`, `file.txt:stream`, `CON`, `CON.txt`, `a.`, `a ` (trailing space), an NFD segment, `a*b`, `a?b`, `a[b]`, `a<b`, `a|b`, a symlink inside the root pointing outside it, a symlink whose target is created after validation (named in the test to make the TOCTOU window explicit), a not-yet-existing path whose nearest ancestor exists, `/srv/root-evil/x` and `/srv/rootx` sibling-prefix cases, and the root itself. Assert a `RepositoryPathClaim` is not assignable where a `TaskPathClaim` is required, and that every one of the seventeen classes resolves through the resolver that owns it and is rejected by the other. For containment step 7, stub `fs.constants.O_NOFOLLOW` as `undefined` and assert `openResolved` still opens with the flag simply absent.
11. Drive history detection against: a branch with no upstream, a branch diverged by one commit in each direction (asserting `GIT_DIVERGED` carries `historyIdentityDigest` of the upstream and head OIDs), an in-progress conflicted merge, an in-progress conflicted rebase (assert `(detached)` is handled and `rebase-merge/` is detected as a directory), a cherry-pick, and a revert. Parse a porcelain stream containing rename lines under `-z` and an unrecognised `#` header, asserting the unrecognised header is ignored rather than fatal.
12. Compute a request digest twice with a changed `expected_revision`, timestamp, attempt counter, and connection identifier, asserting the digest is unchanged, then assert that placing any of those names inside `operation_fields` is rejected. Shuffle `artifact_identities`, `upstream_identities`, and `declared_inputs` and assert an identical fingerprint; repeat a `path` and an `input_id` and assert each throws. Pin a `config.yaml` fixture, perturb it by one byte, a trailing newline, and key reordering, and assert `PINNED_CONFIG_MISMATCH` with digests and no config content.
13. Confirm the registry and boundary invariants: `SCHEMA_IDS`/`SCHEMA_FILES` bijection, each new `$id` matching and compiling against all others, the 52-code and 56-row error assertions, no `src/contracts/**` import of `src/repository/**`, exactly one `src/repository/index.ts`, `gate-contract.schema.json` still `"const"`, and `package.json` byte-identical to its pre-phase state. Run `npm run check` and the CI step list, **invoking the exact `24.15.0` and `24.18.0` binaries explicitly** — the ambient developer Node here is `24.11.1`, below the project's `>=24.15.0` floor, and Phase 5's implementation log recorded the same trap. Note that `npm run check` and the CI step list are close but **not** a strict step-for-step mirror: CI adds `release:stage -- --output`, `release:check -- --compare`, and `test ! -e .tmp`.

**Follow-up, outside this phase:** `docs/dependency-upgrades.md` still documents the MCP pin as `2.0.0-beta.5` while the project ships stable `2.0.0` (published 2026-07-27). Recorded here, not fixed here.

---
*Designed: 2026-07-28*
