import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { AdapterId } from "../contracts/review.js";

export type DispatchWorkspace = Readonly<{
  root: string;
  home: string;
  env: Readonly<NodeJS.ProcessEnv>;
  dispose: () => Promise<void>;
}>;

const FORWARDED_ENVIRONMENT = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const);

function isInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function credentialPaths(adapter: AdapterId, sourceHome: string, generatedHome: string): Readonly<{
  source: string;
  destination: string;
}> {
  if (adapter === "claude-cli") {
    return {
      source: join(sourceHome, ".claude", ".credentials.json"),
      destination: join(generatedHome, ".claude", ".credentials.json"),
    };
  }
  return {
    source: join(sourceHome, ".codex", "auth.json"),
    destination: join(generatedHome, ".codex", "auth.json"),
  };
}

/**
 * Creates disposable best-effort dispatch context hygiene. The generated home links only the
 * selected first-party CLI credential file; no other state from the caller's home is admitted.
 */
export async function createDispatchWorkspace(
  adapter: AdapterId,
  repositoryRoot: string = process.cwd(),
): Promise<DispatchWorkspace> {
  const [realTemporaryRoot, realRepositoryRoot] = await Promise.all([
    realpath(tmpdir()),
    realpath(repositoryRoot),
  ]);
  if (isInside(realRepositoryRoot, realTemporaryRoot)) {
    throw new Error("dispatch temporary directory must be outside the repository");
  }

  const root = await mkdtemp(join(realTemporaryRoot, "archflow-dispatch-"));
  try {
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    const sourceHome = resolve(process.env.HOME ?? homedir());
    const credential = credentialPaths(adapter, sourceHome, home);

    await mkdir(resolve(credential.destination, ".."), { recursive: true });
    await symlink(credential.source, credential.destination, "file");

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      TMPDIR: root,
      CODEX_HOME: codexHome,
    };
    for (const name of FORWARDED_ENVIRONMENT) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }

    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposal ??= rm(root, { recursive: true, force: true });
      return disposal;
    };
    return Object.freeze({ root, home, env: Object.freeze(env), dispose });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
