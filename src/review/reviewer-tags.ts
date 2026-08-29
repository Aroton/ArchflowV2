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
