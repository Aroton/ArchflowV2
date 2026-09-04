/**
 * The one rule that attributes a merged finding to the reviewer that raised it.
 *
 * A round with several rubric reviewers merges their findings into one evidence document, and
 * the only durable attribution is the prefix the server stamps on each finding id. The tag is a
 * function of the reviewer's model name and its position in the configured route list — never of
 * which subset of reviewers a round happened to dispatch — so a finding raised in round N still
 * names its reviewer when round N+1 asks who must confirm the fix.
 */
export function reviewerFindingTag(model: string, index: number): string {
  const modelSlug = model.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return modelSlug.includes("sol") ? "sol"
    : modelSlug.includes("fable") ? "fable"
    : modelSlug.includes("opus") ? "opus"
    : modelSlug.includes("sonnet") ? "sonnet"
    : modelSlug.includes("haiku") ? "haiku"
    : modelSlug.includes("flash") ? "flash"
    : modelSlug.includes("pro") ? "pro"
    : `r${index + 1}`;
}

/** Prefixes a reviewer-authored finding id with the reviewer's tag; a lone reviewer needs no prefix. */
export function taggedFindingId(tag: string, totalReviewers: number, findingId: string): string {
  if (totalReviewers <= 1) return findingId;
  return findingId.startsWith(`${tag}-`) ? findingId : `${tag}-${findingId}`;
}

/** Whether a merged finding id belongs to the reviewer with this tag. */
export function reviewerOwnsFinding(tag: string, totalReviewers: number, findingId: string): boolean {
  return totalReviewers <= 1 || findingId.startsWith(`${tag}-`);
}

const LEGACY_KEYWORD_TAGS = Object.freeze([
  "sol",
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "flash",
  "pro",
] as const);

/** The route facts durable reviewer runs can use to find their current assignment after resizing. */
export type ReviewerRosterEntry = Readonly<{
  reviewer_id: string;
  focus: "general" | "tests";
  routing_role: "counter-reviewer" | "test-reviewer";
  model: string;
  provider?: string;
}>;

/** Narrow archived-run shape consumed by ownership recovery. */
export type ArchivedReviewerRun = ReviewerRosterEntry & Readonly<{
  finding_ids: readonly string[];
  legacy_confirmations?: readonly Readonly<{ finding_id: string }>[];
}>;

/** Narrow finding shape: V3 attribution is present together or not at all. */
export type ArchivedFindingIdentity = Readonly<{
  finding_id: string;
  reviewer_id?: string;
  reviewer_focus?: "general" | "tests";
  routing_role?: "counter-reviewer" | "test-reviewer";
}>;

export type ReviewOwnershipFailure = Readonly<{
  reason:
    | "finding-absent"
    | "finding-attribution-invalid"
    | "finding-run-membership-invalid"
    | "finding-run-prefix-invalid"
    | "reviewer-id-unavailable"
    | "reviewer-route-unavailable"
    | "reviewer-route-ambiguous"
    | "legacy-alias-collision-unavailable"
    | "legacy-ordinal-unavailable";
  historical_position?: number;
}>;

export type ReviewOwnershipResolution =
  | Readonly<{ ok: true; owner: ReviewerRosterEntry }>
  | Readonly<{ ok: false; failure: ReviewOwnershipFailure }>;

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function sameRunTuple(run: ArchivedReviewerRun, current: ReviewerRosterEntry): boolean {
  return run.focus === current.focus &&
    run.routing_role === current.routing_role &&
    run.model === current.model &&
    sameOptionalString(run.provider, current.provider);
}

function runPrefixMatches(
  findingId: string,
  run: ArchivedReviewerRun,
  runCount: number,
): boolean {
  return runCount === 1 || findingId.startsWith(`${run.reviewer_id}-`) ||
    run.legacy_confirmations?.some((confirmation) => confirmation.finding_id === findingId) === true;
}

function resolveRecordedRun(
  finding: ArchivedFindingIdentity,
  runs: readonly ArchivedReviewerRun[],
  roster: readonly ReviewerRosterEntry[],
): ReviewOwnershipResolution {
  const owningRuns = runs.filter((run) => run.finding_ids.includes(finding.finding_id));
  if (owningRuns.length !== 1) {
    return Object.freeze({ ok: false, failure: Object.freeze({ reason: "finding-run-membership-invalid" }) });
  }
  const run = owningRuns[0]!;
  if (!runPrefixMatches(finding.finding_id, run, runs.length)) {
    return Object.freeze({ ok: false, failure: Object.freeze({ reason: "finding-run-prefix-invalid" }) });
  }
  const exact = roster.filter((entry) => entry.reviewer_id === run.reviewer_id);
  if (exact.length === 1) return Object.freeze({ ok: true, owner: exact[0]! });
  if (exact.length > 1) {
    return Object.freeze({ ok: false, failure: Object.freeze({ reason: "reviewer-id-unavailable" }) });
  }
  const tuple = roster.filter((entry) => sameRunTuple(run, entry));
  if (tuple.length === 1) return Object.freeze({ ok: true, owner: tuple[0]! });
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ reason: tuple.length === 0 ? "reviewer-route-unavailable" : "reviewer-route-ambiguous" }),
  });
}

function resolveV3(
  finding: ArchivedFindingIdentity,
  runs: readonly ArchivedReviewerRun[] | undefined,
  roster: readonly ReviewerRosterEntry[],
): ReviewOwnershipResolution {
  const completeAttribution = finding.reviewer_id !== undefined &&
    finding.reviewer_focus !== undefined && finding.routing_role !== undefined;
  if (!completeAttribution || runs === undefined) {
    return Object.freeze({ ok: false, failure: Object.freeze({ reason: "finding-attribution-invalid" }) });
  }
  const runOwners = runs.filter((run) => run.finding_ids.includes(finding.finding_id));
  if (runOwners.length !== 1) {
    return Object.freeze({ ok: false, failure: Object.freeze({ reason: "finding-run-membership-invalid" }) });
  }
  const run = runOwners[0]!;
  if (
    run.reviewer_id !== finding.reviewer_id ||
    run.focus !== finding.reviewer_focus ||
    run.routing_role !== finding.routing_role ||
    !runPrefixMatches(finding.finding_id, run, runs.length)
  ) {
    return Object.freeze({ ok: false, failure: Object.freeze({ reason: "finding-attribution-invalid" }) });
  }
  return resolveRecordedRun(finding, runs, roster);
}

function resolveRunlessV2(
  findingId: string,
  roster: readonly ReviewerRosterEntry[],
): ReviewOwnershipResolution {
  const ordinal = /^r([1-9][0-9]*)-/u.exec(findingId);
  if (ordinal !== null) {
    return Object.freeze({
      ok: false,
      failure: Object.freeze({
        reason: "legacy-ordinal-unavailable",
        historical_position: Number(ordinal[1]),
      }),
    });
  }
  const alias = LEGACY_KEYWORD_TAGS.find((tag) => findingId.startsWith(`${tag}-`));
  if (alias !== undefined) {
    return Object.freeze({
      ok: false,
      failure: Object.freeze({ reason: "legacy-alias-collision-unavailable" }),
    });
  }
  const primary = roster.filter((entry) => entry.focus === "general")[0];
  return primary === undefined
    ? Object.freeze({ ok: false, failure: Object.freeze({ reason: "reviewer-route-unavailable" }) })
    : Object.freeze({ ok: true, owner: primary });
}

/**
 * Resolves one accepted occurrence without borrowing current route order as historical authority.
 * Run membership is exhaustive when present. Native V1 and run-less V2 then use their one exact
 * historical rule; V3 requires its server-stamped attribution and exact current stable ID.
 */
export function resolveReviewFindingOwner(input: Readonly<{
  schema_version: "1" | "2" | "3";
  finding: ArchivedFindingIdentity;
  reviewer_runs?: readonly ArchivedReviewerRun[];
  roster: readonly ReviewerRosterEntry[];
}>): ReviewOwnershipResolution {
  if (input.schema_version === "3") {
    return resolveV3(input.finding, input.reviewer_runs, input.roster);
  }
  if (input.reviewer_runs !== undefined) {
    return resolveRecordedRun(input.finding, input.reviewer_runs, input.roster);
  }
  if (input.schema_version === "1") {
    const primary = input.roster.filter((entry) => entry.focus === "general")[0];
    return primary === undefined
      ? Object.freeze({ ok: false, failure: Object.freeze({ reason: "reviewer-route-unavailable" }) })
      : Object.freeze({ ok: true, owner: primary });
  }
  return resolveRunlessV2(input.finding.finding_id, input.roster);
}
