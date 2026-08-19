import type { TransactionAuthority } from "../../src/state/authority.js";
import { parsePathSafeId, parseSha256Digest, type PathSafeId, type Sha256Digest } from "../../src/contracts/evidence.js";
import {
  resolveDurableGate,
  settleDirectSemanticGateDecision,
  type GateLifecycleDependencies,
} from "../../src/state/gates.js";

/**
 * Completes a workspace-interface gate decision through the retained exported resolution
 * services — the replacement for the retired `runDurableGate` waiting flow. The durable
 * resolver archives the `gate.decision` bytes; an advancing decision is then finished by the
 * direct-decision settlement step, which installs the success receipt the resolver itself
 * refuses to manufacture. Local-channel provenance (the channel every interface-written
 * decision carries) settles without an operation-digest binding, so one fixed operation
 * stands in for the semantic call the interface path predates.
 */
export async function resolveInterfaceGateDecision(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
  inputFingerprint?: Sha256Digest,
) {
  const resolved = await resolveDurableGate(dependencies, authority, gateId, inputFingerprint);
  if (resolved.ok || resolved.error.code !== "STATE_INVALID") return resolved;
  const operation = parseSha256Digest("f".repeat(64));
  return settleDirectSemanticGateDecision(dependencies, {
    authority,
    operation_digest: operation,
    intent_id: parsePathSafeId(`afop-${operation}-decision-settle`),
  });
}
