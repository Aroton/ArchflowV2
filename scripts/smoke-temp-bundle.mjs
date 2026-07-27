import assert from "node:assert/strict";

const contracts = await import(new URL("../.tmp/archflow-contracts.mjs", import.meta.url));

assert.deepEqual(
  contracts.parseSingleYamlDocument("name: archflow\nenabled: true\n", "bundle-smoke.yaml"),
  { name: "archflow", enabled: true }
);

const validator = contracts.createJsonSchemaValidator({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["id", "uri"],
  properties: {
    id: { type: "integer", minimum: 1 },
    uri: { type: "string", format: "uri" }
  }
});
assert.deepEqual(validator.assert({ id: 1, uri: "https://example.test/contract" }, "bundle-smoke"), {
  id: 1,
  uri: "https://example.test/contract"
});
assert.throws(() => validator.assert({ id: 0, uri: "not a URI" }, "bundle-smoke"));
assert.equal(contracts.parsePositiveSafePhaseNumber(1), 1);

console.log(`Temporary contract bundle loaded and exercised under ${process.version}.`);
