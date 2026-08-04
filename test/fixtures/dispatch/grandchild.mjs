#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const role = process.argv[2];
const root = process.cwd();

if (role === "heartbeat") {
  await writeFile(join(root, "grandchild-pid"), `${process.pid}\n`);
  setInterval(() => {
    void appendFile(join(root, "grandchild-heartbeat"), ".");
  }, 20);
} else {
  const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, "heartbeat"], {
    cwd: root,
    stdio: "ignore",
  });
  grandchild.unref();
  await writeFile(join(root, "child-pid"), `${process.pid}\n`);
  setInterval(() => undefined, 1_000);
}
