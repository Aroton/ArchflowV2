import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/contracts/canonical.js";
import type { RepositoryName } from "../../src/contracts/config.js";
import type { ProjectionDigestRef } from "../../src/contracts/durable-primitives.js";
import type { BaselineAdoptionRecord } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeInteger } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { adoptedProduceProjectionDrift } from "../../src/state/produce-subject.js";

const projection = (bytes: string, repository?: string): ProjectionDigestRef => ({
  path: parseRepositoryPathClaim("src/shared.ts"), content_digest: sha256Bytes(Buffer.from(bytes)),
  ...(repository === undefined ? {} : { repository: repository as RepositoryName }),
});
const adoption = (revision: number, ...projections: ProjectionDigestRef[]): BaselineAdoptionRecord => ({
  gate_id: parsePathSafeId(`adoption-${revision}`), adopted_at_revision: parseSafeInteger(revision),
  adopted_projections: projections,
});

describe("adopted production subject recovery", () => {
  it("detects changed adoption metadata without loading rejected retained payloads", () => {
    expect(adoptedProduceProjectionDrift([adoption(12, projection("corrected"))], [projection("original")], 10))
      .toEqual(["src/shared.ts"]);
  });
  it("does not revive an adoption superseded by fresh production", () => {
    expect(adoptedProduceProjectionDrift([adoption(12, projection("corrected"))], [projection("new work")], 14))
      .toEqual([]);
  });
  it("uses revision order even when gate identifiers sort differently", () => {
    expect(adoptedProduceProjectionDrift([
      adoption(14, projection("original")), adoption(12, projection("corrected")),
    ], [projection("original")], 10)).toEqual([]);
  });
  it("keeps primary and secondary projections with the same path distinct", () => {
    const records = [adoption(12, projection("corrected", "api"))];
    expect(adoptedProduceProjectionDrift(records, [projection("original")], 10)).toEqual([]);
    expect(adoptedProduceProjectionDrift(records, [projection("original"), projection("original", "api")], 10))
      .toEqual(["api:src/shared.ts"]);
  });
  it("ignores unrelated and unchanged adoptions", () => {
    expect(adoptedProduceProjectionDrift(undefined, [projection("original")], 10)).toEqual([]);
    expect(adoptedProduceProjectionDrift([adoption(12, projection("original"))], [projection("original")], 10)).toEqual([]);
  });
});
