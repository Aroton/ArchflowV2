import bundledDocuments from "../../assets/review-documents.yaml";
import { z } from "zod";
import { parseSingleYamlDocument } from "../contracts/yaml.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { ProduceUpstreamBinding } from "../state/produce-subject.js";

const ids = z.enum(["prd", "task-design", "phase-design"]);
const entry = z.object({ path: z.string().min(1), filename: z.string().regex(/^[a-z-]+\.md$/u), description: z.string().min(1), use: z.string().min(1) }).strict();
const phaseDocuments = z.object({ primary: z.enum(["prd", "task-design", "phase-design", "implementation"]), review: z.string().min(1), governing: z.array(ids) }).strict();
const schema = z.object({ schema_version: z.literal("1"), version: z.string().min(1), documents: z.object({ prd: entry, "task-design": entry, "phase-design": entry }).strict(), phases: z.object({ prd: phaseDocuments, design: phaseDocuments, "phase-design": phaseDocuments, "phase-impl": phaseDocuments }).strict() }).strict();
export function loadReviewDocumentConfiguration() {
  const config = schema.parse(parseSingleYamlDocument(bundledDocuments, "assets/review-documents.yaml"));
  // The catalog names the existing authoritative document kinds, not arbitrary task paths.
  if (config.documents.prd.path !== "prd.md" || config.documents["task-design"].path !== "design.md" || config.documents["phase-design"].path !== "phases/{phase}/design.md") throw new TypeError("Governing document paths must name canonical task documents");
  return config;
}
export function governingReviewBindings(instance: PhaseInstanceId): readonly ProduceUpstreamBinding[] {
  const phase = decodePhaseInstance(instance);
  const config = loadReviewDocumentConfiguration();
  return config.phases[phase.kind].governing.map(id => {
    if (id === "phase-design" && phase.kind !== "phase-impl") throw new TypeError("A phase design governs only its implementation phase");
    const path = config.documents[id].path.replace("{phase}", "phase" in phase ? String(phase.phase) : "");
    return { path: parseTaskPathClaim(path), phase_instance: (id === "task-design" ? "design" : id === "phase-design" ? `phase-design-${"phase" in phase ? phase.phase : ""}` : "prd") as PhaseInstanceId, artifact_kind: id === "task-design" ? "design" : id };
  });
}
