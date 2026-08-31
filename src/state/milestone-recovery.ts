import { parsePathSafeId, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";

const SEMANTIC_RECOVERY_INTENT = /^afop-([0-9a-f]{64})-recover-milestone-authority$/u;

export function semanticMilestoneRecoveryId(intentId: string): PathSafeId | undefined {
  const match = SEMANTIC_RECOVERY_INTENT.exec(intentId);
  return match === null ? undefined : parsePathSafeId(`milestone-recovery-${match[1]!.slice(0, 32)}`);
}

export function milestoneRecoveryId(requestDigest: Sha256Digest, intentId?: string): PathSafeId {
  return intentId === undefined
    ? parsePathSafeId(`milestone-recovery-${requestDigest.slice(0, 32)}`)
    : semanticMilestoneRecoveryId(intentId) ?? parsePathSafeId(`milestone-recovery-${requestDigest.slice(0, 32)}`);
}
