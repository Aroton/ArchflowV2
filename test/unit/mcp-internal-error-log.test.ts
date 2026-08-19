import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { reportInternalError } from "../../src/mcp/diagnostics.js";

const roots: string[] = [];
const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

const workingRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  process.chdir(root);
  return root;
};

const logPath = (root: string) =>
  join(root, ".archflow", "runtime", "diagnostics", "internal-errors.log");

describe("internal error diagnostics", () => {
  it("keeps the stack on disk so an opaque failure stays explainable after the response", () => {
    const root = workingRoot("archflow-internal-error-log-");
    mkdirSync(join(root, ".archflow"), { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    reportInternalError("request-5", new TypeError("declared output is server-owned"));

    expect(stderr).toHaveBeenCalledOnce();
    const written = readFileSync(logPath(root), "utf8");
    expect(written).toContain("correlation_id=request-5");
    expect(written).toContain("declared output is server-owned");
    // The correlation id on the wire is the only handle the operator has; the record must be
    // findable by it, and must carry the frames the wire error deliberately omits.
    expect(written).toContain("\n    at ");
  });

  it("appends rather than replacing, so a repeated failure keeps its history", () => {
    const root = workingRoot("archflow-internal-error-append-");
    mkdirSync(join(root, ".archflow"), { recursive: true });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    reportInternalError("request-5", new Error("first"));
    reportInternalError("request-7", new Error("second"));

    const written = readFileSync(logPath(root), "utf8");
    expect(written).toContain("correlation_id=request-5");
    expect(written).toContain("correlation_id=request-7");
  });

  it("writes nothing outside an ArchFlow repository", () => {
    const root = workingRoot("archflow-internal-error-bare-");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    reportInternalError("request-5", new Error("boom"));

    expect(readdirSync(root)).toEqual([]);
  });

  it("never lets a failed diagnostics write alter the response path", () => {
    const root = workingRoot("archflow-internal-error-readonly-");
    mkdirSync(join(root, ".archflow"), { recursive: true });
    chmodSync(root, 0o555);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => reportInternalError("request-5", new Error("boom"))).not.toThrow();
    expect(stderr).toHaveBeenCalledOnce();
  });

  it("stamps each record with a time so records can be matched to a session", () => {
    const root = workingRoot("archflow-internal-error-stamp-");
    mkdirSync(join(root, ".archflow"), { recursive: true });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    reportInternalError("request-5", "not an Error");

    expect(readFileSync(logPath(root), "utf8"))
      .toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z archflow INTERNAL_ERROR correlation_id=request-5\nnot an Error\n$/u);
  });
});
