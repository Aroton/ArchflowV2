import { parseConfigYaml, type ConfigV1 } from "../../contracts/config.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseSafeCode, parseSafeInteger } from "../../contracts/evidence.js";
import type { ParsedToolCall } from "../../contracts/mcp-tools.js";
import { decodePhaseInstance } from "../../contracts/phase-instance.js";
import type { HostIdentity } from "../../contracts/hosts.js";
import type { ModelFamily } from "../../contracts/review.js";
import type { RoutingPhaseKind } from "../../dispatch/routing.js";
import { createProductionServices, type ProductionServices } from "../../state/production.js";
import { readStagedLegacyConfig } from "../../state/legacy-stage.js";

export type HandlerSession = Readonly<{
  services: ProductionServices;
  config: ConfigV1;
  host: HostIdentity;
  producer_family: ModelFamily;
  phase_kind: RoutingPhaseKind;
  measured_at_revision: ReturnType<typeof parseSafeInteger>;
}>;

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

export async function openHandlerSession(
  call: ParsedToolCall,
  context: InvocationContext,
): Promise<ProjectResult<HandlerSession>> {
  const suppliedPhase = call.name === "archflow_state" || call.name === "archflow_gate"
    ? call.input.phase_instance
    : undefined;
  const services = await createProductionServices({
    working_directory: context.connection.startup_repository_candidate.working_directory,
    task_id: call.input.task_id,
    operation: parseSafeCode(call.name),
    ...(suppliedPhase === undefined ? {} : { phase_instance: suppliedPhase }),
  });
  if (!services.ok) return services;
  const state = services.value.state?.value;
  if (state === undefined && call.name !== "archflow_state") {
    return fail(createProjectError("STATE_MISSING", {
      phase_instance: suppliedPhase ?? "prd",
    }));
  }
  let configRead = await services.value.dependencies.read_config(services.value.authority.config);
  if (
    configRead.kind === "missing" && state === undefined && call.name === "archflow_state" &&
    call.input.operation !== "planning_restart" && call.input.artifact?.artifact_kind === "legacy-import-initialization"
  ) {
    const staged = await readStagedLegacyConfig(services.value.authority, call.input.artifact);
    if (staged !== undefined) configRead = Object.freeze({ kind: "valid", snapshot: staged });
  }
  if (configRead.kind !== "valid") {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: `config-${configRead.kind}` }));
  }
  if (state !== undefined && state.config_digest !== configRead.snapshot.digest) {
    return fail(createProjectError("PINNED_CONFIG_MISMATCH", {
      expected_digest: state.config_digest,
      observed_digest: configRead.snapshot.digest,
    }));
  }
  const host = context.connection.initialization_candidates.host;
  if (host === "unknown") return fail(createProjectError("UNSUPPORTED_HOST", { host }));
  const phaseInstance = state?.phase_instance ?? suppliedPhase;
  if (phaseInstance === undefined) throw new TypeError("phase instance is unavailable");
  const phase_kind = decodePhaseInstance(phaseInstance).kind as RoutingPhaseKind;
  let config: ConfigV1;
  try {
    config = parseConfigYaml(new TextDecoder("utf-8", { fatal: true }).decode(configRead.snapshot.bytes));
  } catch {
    // The read above already parsed these bytes but discards the parsed value; this parse obtains
    // the typed config and stays as a fail-closed guard (e.g. future schema evolution or an
    // unexpected staged-legacy shape), surfacing a repairable config error instead of an internal one.
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "config-unparseable" }));
  }
  return Object.freeze({
    schema_version: "1",
    ok: true,
    value: Object.freeze({
      services: services.value,
      config,
      host,
      producer_family: host,
      phase_kind,
      measured_at_revision: parseSafeInteger(state?.revision ?? 0),
    }),
  });
}
