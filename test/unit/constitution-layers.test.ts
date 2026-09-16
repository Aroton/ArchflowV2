import { describe, expect, it } from "vitest";

import { parseConstitutionRuleFiles } from "../../src/contracts/constitution.js";

const rule = (id: string, version = 1, extra = "", body = "Preserve the invariant.") =>
  `---\nid: ${id}\nversion: ${version}\nstatus: active\n${extra}---\n${body}\n`;

describe("constitution layers", () => {
  it("replaces the complete default by ID, regardless of filename or refreshed default version", () => {
    const files = {
      ".archflow/constitution/default/10-contract.md": rule("contract", 4, "review_trigger: A contract changes.\n"),
      ".archflow/constitution/custom/90-local.md": rule("contract", 2),
      ".archflow/constitution/custom/95-billing.md": rule("billing", 1, "review_trigger: Billing changes.\n"),
    };
    const effective = parseConstitutionRuleFiles(files);
    expect(effective.size).toBe(2);
    expect(effective.get("contract")).toMatchObject({ version: 2, status: "active" });
    expect(effective.get("contract")?.review_trigger).toBeUndefined();
    expect(effective.get("billing")?.review_trigger).toBe("Billing changes.");
  });

  it("retains a deprecated custom replacement instead of falling back to its active default", () => {
    const effective = parseConstitutionRuleFiles({
      "default/10-contract.md": rule("contract"),
      "custom/10-contract.md": rule("contract", 2).replace("status: active", "status: deprecated"),
    });
    expect(effective.get("contract")?.status).toBe("deprecated");
  });

  it.each(["default", "custom"])("rejects duplicate IDs within %s even when overridden", (layer) => {
    expect(() => parseConstitutionRuleFiles({
      [`${layer}/10-one.md`]: rule("duplicate"),
      [`${layer}/20-two.md`]: rule("duplicate", 2),
      [`${layer === "default" ? "custom" : "default"}/30-other.md`]: rule("duplicate", 3),
    })).toThrow(/Duplicate constitution rule id/);
  });

  it("rejects mixed layouts rather than hiding flat rules", () => {
    expect(() => parseConstitutionRuleFiles({
      ".archflow/constitution/10-old.md": rule("old"),
      ".archflow/constitution/default/20-new.md": rule("new"),
    })).toThrow(/Mixed flat and split.*init --force/);
  });
});
