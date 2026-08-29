import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import {
  safeIntegerV1Schema,
  sha256DigestV1Schema,
  taskSlugV1Schema,
  type SafeInteger,
  type Sha256Digest,
} from "../contracts/evidence.js";
import { phaseInstanceIdV1Schema, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import {
  ADAPTER_IDS,
  EFFORT_VALUES,
  MODEL_FAMILIES,
  routeSourceRecordSchema,
  type RouteSourceRecord,
} from "../contracts/review.js";
import { parseWorkspacePathClaim, resolveTaskWorkspacePath } from "../repository/paths.js";
import type { TransactionAuthority } from "../state/authority.js";
import { ensureAttemptDirectory } from "../state/layout.js";
import type { TransactionDependencies } from "../state/transaction.js";
import type { DispatchCoordinatorResult } from "./coordinator.js";
import type { DispatchRoute, SelectedDispatchRoute } from "./routing.js";

/**
 * Retained child outputs of one review round.
 *
 * A round dispatches several children (every rubric counter-reviewer plus the constitution
 * child) against envelopes sealed from durable authority. When one child fails, the others'
 * validated outputs are kept here, under ignored runtime, so the retry of the same round
 * re-dispatches only the children that failed. A record is reused only for the exact envelope
 * digest, role, route, and route provenance it was produced under, and its bytes go through the
 * same output validation as a fresh dispatch. The store never changes state or authorizes
 * anything: losing it costs one re-dispatch, never workflow progress.
 */

export type RetainedChildRole = "counter-reviewer" | "test-reviewer" | "adjudicator";

export type RetainedChildOutputBinding = Readonly<{
  envelope_digest: Sha256Digest;
  role: RetainedChildRole;
  selection: SelectedDispatchRoute;
}>;

export type RetainedChildOutputStore = Readonly<{
  /** The retained output for exactly this binding, or `undefined` when none is usable. */
  read: (binding: RetainedChildOutputBinding) => Promise<DispatchCoordinatorResult | undefined>;
  /** Best-effort retention of one validated child output; never throws. */
  write: (binding: RetainedChildOutputBinding, result: DispatchCoordinatorResult) => Promise<void>;
  /** Best-effort removal of every record the round with this envelope digest retained. */
  discard: (envelopeDigest: Sha256Digest) => Promise<void>;
}>;

export type RetainedChildOutputContext = Readonly<{
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  phase_instance: PhaseInstanceId;
  attempt: SafeInteger;
}>;

const nonBlank = z.string().min(1);

const retainedRouteSchema = z.object({
  adapter: z.enum(ADAPTER_IDS),
  family: z.enum(MODEL_FAMILIES),
  model: nonBlank,
  effort: z.enum(EFFORT_VALUES),
  provider: nonBlank.optional(),
}).strict();

const retainedChildOutputSchema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.literal("counter_review"),
  attempt: safeIntegerV1Schema,
  role: z.enum(["counter-reviewer", "test-reviewer", "adjudicator"]),
  envelope_digest: sha256DigestV1Schema,
  route: retainedRouteSchema,
  route_source: routeSourceRecordSchema,
  cli_version: nonBlank,
  output_base64: z.string().min(1),
  observed_output_digest: sha256DigestV1Schema,
}).strict();

type LooseRoute = Readonly<{
  adapter: DispatchRoute["adapter"];
  family: DispatchRoute["family"];
  model: string;
  effort: DispatchRoute["effort"];
  provider?: string | undefined;
}>;

type LooseSource = Readonly<{
  provenance: RouteSourceRecord["provenance"];
  displaced?: Readonly<{
    source: NonNullable<RouteSourceRecord["displaced"]>["source"];
    model: string;
    effort: DispatchRoute["effort"];
    provider?: string | undefined;
  }> | undefined;
}>;

/** One plain-JSON shape for a route whether it arrives branded or freshly parsed. */
function plainRoute(route: LooseRoute): PlainJsonValue {
  return {
    adapter: route.adapter,
    family: route.family,
    model: route.model,
    effort: route.effort,
    ...(route.provider === undefined ? {} : { provider: route.provider }),
  };
}

function plainSource(source: LooseSource): PlainJsonValue {
  const displaced = source.displaced;
  return {
    provenance: source.provenance,
    ...(displaced === undefined ? {} : {
      displaced: {
        source: displaced.source,
        model: displaced.model,
        effort: displaced.effort,
        ...(displaced.provider === undefined ? {} : { provider: displaced.provider }),
      },
    }),
  };
}

/** Binds a retained output to the exact envelope, role, route, and route provenance it answered. */
export function retainedChildOutputKey(binding: RetainedChildOutputBinding): Sha256Digest {
  return canonicalJsonDigest({
    digest_kind: "retained-child-output",
    envelope_digest: binding.envelope_digest,
    role: binding.role,
    route: plainRoute(binding.selection.route),
    source: plainSource(binding.selection.source),
  });
}

function roundPrefix(envelopeDigest: Sha256Digest): string {
  return `round-${envelopeDigest.slice(0, 16)}-`;
}

function recordClaim(phaseInstance: PhaseInstanceId, binding: RetainedChildOutputBinding) {
  const key = retainedChildOutputKey(binding);
  return parseWorkspacePathClaim(
    `diagnostics/attempts/${phaseInstance}/${roundPrefix(binding.envelope_digest)}${binding.role}-${key.slice(0, 16)}.json`,
  );
}

async function resolveRecord(context: RetainedChildOutputContext, claim: ReturnType<typeof parseWorkspacePathClaim>) {
  return resolveTaskWorkspacePath({
    runner: context.dependencies.runner,
    taskId: context.authority.task_id,
    claim,
    expectedClass: "workspace-attempt",
    context: context.authority.context,
  });
}

/**
 * Creates the round's retained-output store, or `undefined` when the dependencies cannot write
 * ignored runtime files (the same guard the failure observer applies).
 */
export function createRetainedChildOutputStore(
  context: RetainedChildOutputContext,
): RetainedChildOutputStore | undefined {
  const writer = context.dependencies.projection_writer;
  if (writer === undefined) return undefined;

  const matches = (
    record: z.infer<typeof retainedChildOutputSchema>,
    binding: RetainedChildOutputBinding,
  ): boolean =>
    record.task_id === context.authority.task_id &&
    record.phase_instance === context.phase_instance &&
    record.attempt === context.attempt &&
    record.role === binding.role &&
    record.envelope_digest === binding.envelope_digest &&
    canonicalJsonDigest(plainRoute(record.route)) === canonicalJsonDigest(plainRoute(binding.selection.route)) &&
    canonicalJsonDigest(plainSource(record.route_source)) ===
      canonicalJsonDigest(plainSource(binding.selection.source));

  return Object.freeze({
    async read(binding) {
      let target;
      try {
        target = await resolveRecord(context, recordClaim(context.phase_instance, binding));
        if (!target.ok) return undefined;
        const record = retainedChildOutputSchema.parse(JSON.parse(await readFile(target.value.absolute, "utf8")));
        const bytes = new Uint8Array(Buffer.from(record.output_base64, "base64"));
        if (matches(record, binding) && sha256Bytes(bytes) === record.observed_output_digest) {
          return Object.freeze({ cli_version: record.cli_version, extracted_output_bytes: bytes });
        }
      } catch {
        // Missing, malformed, or foreign bytes are a miss, never a failure.
      }
      // A record that exists but does not bind to this request is useless: drop it so a later
      // read does not keep re-parsing it.
      if (target?.ok) await writer.remove(target.value).catch(() => undefined);
      return undefined;
    },
    async write(binding, result) {
      try {
        await ensureAttemptDirectory(context.authority, context.phase_instance);
        const target = await resolveRecord(context, recordClaim(context.phase_instance, binding));
        if (!target.ok) return;
        const record = retainedChildOutputSchema.parse({
          schema_version: "1",
          task_id: context.authority.task_id,
          phase_instance: context.phase_instance,
          step: "counter_review",
          attempt: context.attempt,
          role: binding.role,
          envelope_digest: binding.envelope_digest,
          route: plainRoute(binding.selection.route),
          route_source: plainSource(binding.selection.source),
          cli_version: result.cli_version,
          output_base64: Buffer.from(result.extracted_output_bytes).toString("base64"),
          observed_output_digest: sha256Bytes(result.extracted_output_bytes),
        });
        await writer.replaceRegular(target.value, canonicalJsonBytes(record as PlainJsonValue), false);
      } catch {
        // Retention is a convenience for the retry; it must never fail the round that produced the output.
      }
    },
    async discard(envelopeDigest) {
      try {
        const directory = join(context.authority.workspace_root, "diagnostics", "attempts", context.phase_instance);
        const prefix = roundPrefix(envelopeDigest);
        for (const name of await readdir(directory)) {
          if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
          const target = await resolveRecord(
            context,
            parseWorkspacePathClaim(`diagnostics/attempts/${context.phase_instance}/${name}`),
          );
          if (target.ok) await writer.remove(target.value).catch(() => undefined);
        }
      } catch {
        // A round that committed no longer needs its records; leftovers are swept with the phase.
      }
    },
  });
}
