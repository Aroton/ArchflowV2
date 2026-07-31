import { createProjectError, parseProjectError, type ProjectError, type ProjectResult } from "../../contracts/errors.js";
import type { ToolSuccess } from "../../contracts/mcp-tools.js";
import type { ToolName } from "../../contracts/tool-names.js";
import { CliAdapterError } from "../../dispatch/cli.js";
import { DispatchProcessError } from "../../dispatch/process.js";
import { DispatchRoutingError } from "../../dispatch/routing.js";
import { AdjudicationServiceError } from "../../review/adjudication.js";
import { ReviewEnvelopeError } from "../../review/envelopes.js";

type TypedProjectError =
  | DispatchRoutingError
  | CliAdapterError
  | DispatchProcessError
  | AdjudicationServiceError
  | ReviewEnvelopeError;

function carried(error: unknown): ProjectError | undefined {
  if (
    error instanceof DispatchRoutingError ||
    error instanceof CliAdapterError ||
    error instanceof DispatchProcessError ||
    error instanceof AdjudicationServiceError ||
    error instanceof ReviewEnvelopeError
  ) return error.project_error;
  try {
    return parseProjectError(error);
  } catch {
    return undefined;
  }
}

export async function mapHandlerErrors<K extends ToolName>(
  correlationId: string,
  run: () => Promise<ProjectResult<ToolSuccess<K>>>,
): Promise<ProjectResult<ToolSuccess<K>>> {
  try {
    return await run();
  } catch (error) {
    const projectError = carried(error);
    if (projectError !== undefined) {
      return Object.freeze({ schema_version: "1", ok: false, error: projectError });
    }
    if (error instanceof TypeError) throw error;
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("INTERNAL_ERROR", { correlation_id: correlationId }),
    });
  }
}

export type { TypedProjectError };
