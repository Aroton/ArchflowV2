#!/bin/bash
# Install the verified ArchFlow bundle, the archflow-local launcher, and the shared skills, and
# remove what earlier installs left for the retired MCP server wherever it is provably ArchFlow's.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SOURCE_DIR="$SCRIPT_DIR/skills"
CLAUDE_TARGET_DIR="$HOME/.claude/skills"
CODEX_TARGET_DIR="$HOME/.agents/skills"
ANTIGRAVITY_TARGET_DIR="$HOME/.gemini/config/skills"
ARCHFLOW_ROOT="${ARCHFLOW_HOME:-$HOME/.archflow}"
ARCHFLOW_BIN_DIR="${ARCHFLOW_BIN:-$HOME/.local/bin}"
BUNDLE_DIR="$ARCHFLOW_ROOT/bundle"
# Skills earlier releases installed and this one no longer ships.
RETIRED_SKILLS=(
  archflow-phase
  archflow-prd
  archflow-design
  archflow-phase-design
  archflow-phase-impl
  archflow-status
  archflow-upgrade
  archflow-simple
)

install_claude=true
install_codex=true
install_antigravity=true

case "${1:-}" in
  "") ;;
  --claude) install_codex=false; install_antigravity=false ;;
  --codex) install_claude=false; install_antigravity=false ;;
  --antigravity|--agy) install_claude=false; install_codex=false ;;
  --help|-h)
    echo "Usage: ./install.sh [--claude|--codex|--antigravity|--agy]"
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: ./install.sh [--claude|--codex|--antigravity|--agy]" >&2
    exit 1
    ;;
esac

if [ "$#" -gt 1 ]; then
  echo "Unexpected extra arguments: $*" >&2
  echo "Usage: ./install.sh [--claude|--codex|--antigravity|--agy]" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ArchFlow requires Node $(node -p 'require(process.argv[1]).engines.node' "$SCRIPT_DIR/package.json" 2>/dev/null || echo '^24.15.0'); node was not found on PATH." >&2
  exit 1
fi

node -e '
const { readFileSync } = require("node:fs");
const packagePath = process.argv[1];
const required = JSON.parse(readFileSync(packagePath, "utf8")).engines.node;
const observed = process.versions.node;
const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(required);
const actual = /^(\d+)\.(\d+)\.(\d+)/.exec(observed);
if (!match || !actual) {
  console.error(`Unable to compare Node ${observed} with required range ${required}.`);
  process.exit(1);
}
const minimum = match.slice(1).map(Number);
const version = actual.slice(1).map(Number);
const supported = version[0] === minimum[0] && (
  version[1] > minimum[1] ||
  (version[1] === minimum[1] && version[2] >= minimum[2])
);
if (!supported) {
  console.error(`ArchFlow requires Node ${required}; observed ${observed}.`);
  process.exit(1);
}
' "$SCRIPT_DIR/package.json"

verify_payload() {
  node -e '
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const root = resolve(process.argv[1]);
const manifest = JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8"));
const records = [
  ...manifest.artifacts.filter((record) => record.path !== "manifest.json").map((record) => ({ ...record, source: join("dist", record.path) })),
  ...(manifest.runtime_assets ?? []).map((record) => ({ ...record, source: record.path })),
];
if (!Array.isArray(manifest.runtime_assets) || manifest.runtime_assets.length === 0) {
  throw new Error("release manifest has no runtime asset records");
}
for (const record of records) {
  if (typeof record.path !== "string" || typeof record.digest !== "string" || !Number.isSafeInteger(record.size)) {
    throw new Error(`incomplete manifest record for ${String(record.path)}`);
  }
  const target = resolve(root, record.source);
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`manifest path escapes checkout: ${record.path}`);
  const bytes = readFileSync(target);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (statSync(target).size !== record.size || digest !== record.digest) {
    throw new Error(`payload verification failed for ${record.path}`);
  }
}
' "$SCRIPT_DIR"
}

# Copies exactly the runtime assets the verified release manifest lists into the staged bundle.
stage_runtime_assets() {
  node -e '
const { cpSync, mkdirSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const [root, staging] = process.argv.slice(1);
const manifest = JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8"));
for (const record of manifest.runtime_assets) {
  const target = join(staging, record.path);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, record.path), target);
}
' "$SCRIPT_DIR" "$1"
}

# Exits 0 only when $1 is a regular file holding exactly the two-line archflow-mcp launcher
# earlier installers wrote: `#!/bin/sh` and `exec node "<bundle>/dist/archflow-mcp.mjs" "$@"`.
is_installed_mcp_launcher() {
  node -e '
const { lstatSync, readFileSync } = require("node:fs");
const stats = lstatSync(process.argv[1]);
if (!stats.isFile() || stats.size > 4096) process.exit(1);
const launcher = /^#!\/bin\/sh\nexec node "\/[^"\n]*\/dist\/archflow-mcp\.mjs" "\$@"\n$/;
process.exit(launcher.test(readFileSync(process.argv[1], "utf8")) ? 0 : 1);
' "$1"
}

remove_mcp_launcher() {
  local launcher="$ARCHFLOW_BIN_DIR/archflow-mcp"
  [ -e "$launcher" ] || [ -L "$launcher" ] || return 0
  if is_installed_mcp_launcher "$launcher"; then
    rm -f "$launcher"
    echo "Removed the retired archflow-mcp launcher from $ARCHFLOW_BIN_DIR/"
  else
    echo "Kept $launcher: it is not the archflow-mcp launcher an earlier ArchFlow install wrote." >&2
  fi
}

# Prints the `name:` value from the YAML frontmatter of the SKILL.md at $1, or nothing.
skill_name() {
  awk '
    NR == 1 { if ($0 != "---") exit; next }
    /^---[[:space:]]*$/ { exit }
    /^name:/ {
      sub(/^name:[[:space:]]*/, "")
      sub(/[[:space:]]+$/, "")
      gsub(/^["\047]|["\047]$/, "")
      print
      exit
    }
  ' "$1"
}

# Removes a retired skill directory only when its SKILL.md names that skill, so a directory a
# person owns under the same name in a shared skills location is kept. A symbolic link is never
# removed or followed.
remove_retired_skills() {
  local target_dir="$1"
  local skill skill_dir name
  local removed=()
  for skill in "${RETIRED_SKILLS[@]}"; do
    skill_dir="$target_dir/$skill"
    [ -e "$skill_dir" ] || [ -L "$skill_dir" ] || continue
    if [ -L "$skill_dir" ]; then
      echo "Kept $skill_dir: it is a symbolic link, so the installer does not remove it or anything it points to." >&2
    elif [ ! -d "$skill_dir" ]; then
      echo "Kept $skill_dir: it is not a directory, so it is not the retired ArchFlow skill $skill." >&2
    elif [ -L "$skill_dir/SKILL.md" ] || [ ! -f "$skill_dir/SKILL.md" ]; then
      echo "Kept $skill_dir: it holds files but no SKILL.md naming the retired ArchFlow skill $skill, so they are not provably ArchFlow's." >&2
    else
      name="$(skill_name "$skill_dir/SKILL.md")"
      if [ "$name" = "$skill" ]; then
        rm -rf "${skill_dir:?}"
        removed+=("$skill")
      elif [ -z "$name" ]; then
        echo "Kept $skill_dir: its SKILL.md has no name:, so it is not provably the retired ArchFlow skill $skill." >&2
      else
        echo "Kept $skill_dir: its SKILL.md names \"$name\", not the retired ArchFlow skill $skill." >&2
      fi
    fi
  done
  if [ "${#removed[@]}" -gt 0 ]; then
    echo "Removed retired ArchFlow skills from $target_dir/: ${removed[*]}"
  fi
}

# Prints the first directory between the skills root $1 and the relative path $2 that is a
# symbolic link, or nothing.
symlinked_component() {
  local target_dir="$1"
  local rest="$2"
  local prefix=""
  while [ "${rest#*/}" != "$rest" ]; do
    prefix="${prefix:+$prefix/}${rest%%/*}"
    rest="${rest#*/}"
    if [ -L "$target_dir/$prefix" ]; then
      printf '%s\n' "$target_dir/$prefix"
      return
    fi
  done
}

# Removes the now-empty directories above a pruned skill file, stopping at the skills root.
remove_empty_parents() {
  local target_dir="$1"
  local parent
  parent="$(dirname "$2")"
  while [ "$parent" != "." ] && [ "$parent" != "/" ]; do
    rmdir "$target_dir/$parent" 2>/dev/null || break
    parent="$(dirname "$parent")"
  done
}

# Earlier versions of `archflow-local init` registered the MCP server for Antigravity in this
# machine-global file. Remove that `archflow` entry only when its command is the archflow-mcp
# launcher; keep every other server and setting, and leave a symlinked or unreadable file alone.
remove_antigravity_registration() {
  node -e '
const { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const path = process.argv[1];
const manual = "Remove its \"archflow\" MCP server entry by hand if it runs archflow-mcp.";
const leave = (reason) => {
  console.error(`Left ${path} alone: ${reason}. ${manual}`);
  process.exit(0);
};
let temporary;
let command;
try {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") process.exit(0);
    throw error;
  }
  if (stats.isSymbolicLink()) leave("it is a symbolic link");
  if (!stats.isFile()) leave("it is not a regular file");
  const source = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    leave("it is not valid JSON");
  }
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers) || !Object.hasOwn(parsed.mcpServers, "archflow")) process.exit(0);
  const entry = parsed.mcpServers.archflow;
  command = isRecord(entry) && typeof entry.command === "string" ? entry.command : undefined;
  if (command === undefined || basename(command) !== "archflow-mcp") {
    console.error(`Kept the "archflow" MCP server entry in ${path}: its command is not the archflow-mcp launcher ArchFlow registered.`);
    process.exit(0);
  }
  delete parsed.mcpServers.archflow;
  const candidate = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const descriptor = openSync(candidate, "wx", stats.mode & 0o777);
  temporary = candidate;
  fchmodSync(descriptor, stats.mode & 0o777);
  writeSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`);
  fsyncSync(descriptor);
  closeSync(descriptor);
  renameSync(temporary, path);
  temporary = undefined;
} catch (error) {
  // Any failure leaves the config as it was; only a temporary file this run created is removed.
  if (temporary !== undefined) {
    try { unlinkSync(temporary); } catch {}
  }
  leave(error instanceof Error ? error.message : String(error));
}
console.log(`Removed the retired "archflow" MCP server entry (command ${command}) from ${path}; its other servers and settings were kept.`);
' "$HOME/.gemini/config/mcp_config.json"
}

install_skills() {
  local target_dir="$1"
  local owner_manifest="$target_dir/.archflow-installed"
  local next_manifest link skill skill_source
  local kept_links=""
  next_manifest="$(mktemp)"
  (
    cd "$SKILLS_SOURCE_DIR"
    find . -type f -print | sed 's#^./##' | LC_ALL=C sort > "$next_manifest"
  )
  mkdir -p "$target_dir"
  if [ -f "$owner_manifest" ]; then
    while IFS= read -r owned_path; do
      [ -n "$owned_path" ] || continue
      case "$owned_path" in
        /*|../*|*/../*|*/..) echo "Invalid owned skill path: $owned_path" >&2; rm -f "$next_manifest"; exit 1 ;;
      esac
      if ! grep -Fqx "$owned_path" "$next_manifest"; then
        link="$(symlinked_component "$target_dir" "$owned_path")"
        if [ -n "$link" ]; then
          case "$kept_links" in
            *"|$link|"*) ;;
            *)
              kept_links="$kept_links|$link|"
              echo "Kept the files an earlier install put under $link: it is a symbolic link, so the installer does not remove anything through it." >&2
              ;;
          esac
          continue
        fi
        rm -f "$target_dir/$owned_path"
        remove_empty_parents "$target_dir" "$owned_path"
      fi
    done < "$owner_manifest"
  fi
  remove_retired_skills "$target_dir"
  for skill_source in "$SKILLS_SOURCE_DIR"/* "$SKILLS_SOURCE_DIR"/.[!.]*; do
    [ -e "$skill_source" ] || continue
    skill="$(basename "$skill_source")"
    if [ -L "$target_dir/$skill" ]; then
      echo "Skipped installing $skill into $target_dir/$skill: it is a symbolic link, so the installer does not write through it. Replace it with a directory to install this skill." >&2
      awk -v prefix="$skill/" 'index($0, prefix) != 1' "$next_manifest" > "$next_manifest.kept"
      mv "$next_manifest.kept" "$next_manifest"
      continue
    fi
    cp -R "$skill_source" "$target_dir/"
  done
  mv "$next_manifest" "$owner_manifest"
}

verify_payload

mkdir -p "$ARCHFLOW_ROOT"
staging_dir="$(mktemp -d "$ARCHFLOW_ROOT/.bundle.new.XXXXXX")"
cp -R "$SCRIPT_DIR/dist" "$staging_dir/dist"
stage_runtime_assets "$staging_dir"
if [ -e "$BUNDLE_DIR" ]; then
  rm -rf "$BUNDLE_DIR"
fi
mv "$staging_dir" "$BUNDLE_DIR"

mkdir -p "$ARCHFLOW_BIN_DIR"
resolved_bundle_dir="$(cd "$BUNDLE_DIR" && pwd)"
for executable in archflow-local; do
  launcher="$ARCHFLOW_BIN_DIR/$executable"
  printf '#!/bin/sh\nexec node "%s/dist/%s.mjs" "$@"\n' "$resolved_bundle_dir" "$executable" > "$launcher"
  chmod 755 "$launcher"
done
remove_mcp_launcher

case ":$PATH:" in
  *:"$ARCHFLOW_BIN_DIR":*) ;;
  *)
    echo "The ArchFlow launcher was installed, but $ARCHFLOW_BIN_DIR is not on PATH." >&2
    printf "Add this line to your shell profile, open a new terminal, and re-run the installer:\nexport PATH=\"%s:\$PATH\"\n" "$ARCHFLOW_BIN_DIR" >&2
    exit 1
    ;;
esac

if [ "$install_claude" = true ]; then
  install_skills "$CLAUDE_TARGET_DIR"
  echo "ArchFlow Claude Code skills installed to $CLAUDE_TARGET_DIR/"
fi

if [ "$install_codex" = true ]; then
  install_skills "$CODEX_TARGET_DIR"
  echo "ArchFlow Codex skills installed to $CODEX_TARGET_DIR/"
fi

if [ "$install_antigravity" = true ]; then
  install_skills "$ANTIGRAVITY_TARGET_DIR"
  echo "ArchFlow Antigravity skills installed to $ANTIGRAVITY_TARGET_DIR/"
  remove_antigravity_registration
fi

echo "ArchFlow bundle installed to $BUNDLE_DIR/"
echo "ArchFlow launcher installed to $ARCHFLOW_BIN_DIR/archflow-local"
echo ""
if [ "$install_claude" = true ]; then
  echo "Claude Code: /archflow-init, /archflow-constitution, /archflow-explore, /archflow-run"
fi
if [ "$install_codex" = true ]; then
  echo 'Codex: $archflow-init, $archflow-constitution, $archflow-explore'
  echo "Restart Codex if the skills do not appear immediately."
fi
if [ "$install_antigravity" = true ]; then
  echo "Antigravity: /archflow-init, /archflow-constitution, /archflow-explore"
fi
