import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { DISPATCH_USAGE_RETENTION_MS, installedDispatchUsageDirectory,
  writeDispatchUsageRecord, type DispatchUsageRecord } from "../../src/dispatch/usage-log.js";

const roots: string[] = [];
const now = Date.parse("2026-09-16T20:00:00Z");
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "archflow-usage-log-")); roots.push(directory); return directory;
}
const record = (): DispatchUsageRecord => ({
  schema_version: "1", dispatch_id: randomUUID(), started_at: new Date(now - 1000).toISOString(),
  completed_at: new Date(now).toISOString(), duration_ms: 1000, repository: "/example/repository",
  adapter: "claude-cli", model: "claude-opus-5", effort: "medium", result_kind: "review",
  envelope_digest: "a".repeat(64), input_byte_count: 100, status: "succeeded",
  usage: { output_tokens: 100, thinking_tokens: 80, num_turns: 3, total_cost_usd: 0.01 },
});
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("central dispatch usage log", () => {
  it("resolves default and custom install homes without writing source-checkout state", () => {
    expect(installedDispatchUsageDirectory(pathToFileURL("/home/person/.archflow/bundle/dist/archflow-mcp.mjs").href))
      .toBe("/home/person/.archflow/usage");
    expect(installedDispatchUsageDirectory(pathToFileURL("/custom install/bundle/dist/archflow-local.mjs").href))
      .toBe("/custom install/usage");
    expect(installedDispatchUsageDirectory(pathToFileURL("/checkout/dist/archflow-mcp.mjs").href)).toBeUndefined();
    expect(installedDispatchUsageDirectory()).toBeUndefined();
  });

  it("writes private, independently readable records safely across concurrent dispatches", async () => {
    const directory = join(await root(), "usage");
    const records = Array.from({ length: 12 }, record);
    await Promise.all(records.map(value => writeDispatchUsageRecord(value, directory, now)));
    const files = await readdir(directory);
    expect(files).toHaveLength(records.length);
    const read = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
    expect(new Set(read.map(value => value.dispatch_id))).toEqual(new Set(records.map(value => value.dispatch_id)));
    expect(read[0]).toMatchObject({ usage: { output_tokens: 100, thinking_tokens: 80 } });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    await writeDispatchUsageRecord(records[0]!, directory, now);
    expect(await readdir(directory)).toHaveLength(records.length);
  });

  it("cleans only its regular records older than seven days when another dispatch completes", async () => {
    const directory = await root();
    const filename = (timestamp: number) => `${timestamp}-${randomUUID()}.json`;
    const old = filename(now - DISPATCH_USAGE_RETENTION_MS - 1);
    const boundary = filename(now - DISPATCH_USAGE_RETENTION_MS);
    const oldDirectory = filename(now - DISPATCH_USAGE_RETENTION_MS - 2);
    const link = filename(now - DISPATCH_USAGE_RETENTION_MS - 3);
    await writeFile(join(directory, old), "{}");
    await writeFile(join(directory, boundary), "{}");
    await writeFile(join(directory, "notes.json"), "keep unrelated data");
    await mkdir(join(directory, oldDirectory));
    await symlink(join(directory, "notes.json"), join(directory, link));
    await writeDispatchUsageRecord(record(), directory, now);
    const files = await readdir(directory);
    expect(files).not.toContain(old);
    expect(files).toEqual(expect.arrayContaining([boundary, oldDirectory, link, "notes.json"]));
  });

  it("does not turn a logging failure into a review failure", async () => {
    const notDirectory = join(await root(), "file");
    await writeFile(notDirectory, "keep");
    await expect(writeDispatchUsageRecord(record(), notDirectory, now)).resolves.toBeUndefined();
    expect(await readFile(notDirectory, "utf8")).toBe("keep");
  });

  it("uses the installed bundle's location by default and survives bundle replacement", async () => {
    const home = await root();
    const bundle = join(home, "bundle");
    const entry = join(bundle, "dist", "archflow-mcp.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../../src/dispatch/usage-log.ts", import.meta.url))],
      outfile: entry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const installed = await import(pathToFileURL(entry).href);
    const value = record();
    await installed.writeDispatchUsageRecord(value, undefined, now);
    await rm(bundle, { recursive: true });
    const files = await readdir(join(home, "usage"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(home, "usage", files[0]!), "utf8"))).toEqual(value);
  });
});
