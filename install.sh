#!/bin/bash
# Install the verified ArchFlow bundle, launchers, and shared skills.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SOURCE_DIR="$SCRIPT_DIR/skills"
CLAUDE_TARGET_DIR="$HOME/.claude/skills"
CODEX_TARGET_DIR="$HOME/.agents/skills"
ARCHFLOW_ROOT="${ARCHFLOW_HOME:-$HOME/.archflow}"
ARCHFLOW_BIN_DIR="${ARCHFLOW_BIN:-$HOME/.local/bin}"
BUNDLE_DIR="$ARCHFLOW_ROOT/bundle"

install_claude=true
install_codex=true

case "${1:-}" in
  "") ;;
  --claude) install_codex=false ;;
  --codex) install_claude=false ;;
  --help|-h)
    echo "Usage: ./install.sh [--claude|--codex]"
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: ./install.sh [--claude|--codex]" >&2
    exit 1
    ;;
esac

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

install_skills() {
  local target_dir="$1"
  local owner_manifest="$target_dir/.archflow-installed"
  local next_manifest
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
        rm -f "$target_dir/$owned_path"
      fi
    done < "$owner_manifest"
  else
    rm -rf "$target_dir/archflow-phase"
  fi
  cp -R "$SKILLS_SOURCE_DIR/." "$target_dir/"
  mv "$next_manifest" "$owner_manifest"
}

verify_payload

mkdir -p "$ARCHFLOW_ROOT"
staging_dir="$(mktemp -d "$ARCHFLOW_ROOT/.bundle.new.XXXXXX")"
cp -R "$SCRIPT_DIR/dist" "$staging_dir/dist"
cp -R "$SCRIPT_DIR/assets" "$staging_dir/assets"
if [ -e "$BUNDLE_DIR" ]; then
  rm -rf "$BUNDLE_DIR"
fi
mv "$staging_dir" "$BUNDLE_DIR"

mkdir -p "$ARCHFLOW_BIN_DIR"
resolved_bundle_dir="$(cd "$BUNDLE_DIR" && pwd)"
for executable in archflow-mcp archflow-local; do
  launcher="$ARCHFLOW_BIN_DIR/$executable"
  printf '#!/bin/sh\nexec node "%s/dist/%s.mjs" "$@"\n' "$resolved_bundle_dir" "$executable" > "$launcher"
  chmod 755 "$launcher"
done

case ":$PATH:" in
  *:"$ARCHFLOW_BIN_DIR":*) ;;
  *)
    echo "ArchFlow launchers were installed, but $ARCHFLOW_BIN_DIR is not on PATH." >&2
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

echo "ArchFlow bundle installed to $BUNDLE_DIR/"
echo "ArchFlow launchers installed to $ARCHFLOW_BIN_DIR/"
echo ""
if [ "$install_claude" = true ]; then
  echo "Claude Code: /archflow-init, /archflow-upgrade, /archflow-explore, /archflow-prd, /archflow-design, /archflow-phase-design, /archflow-phase-impl, /archflow-status"
fi
if [ "$install_codex" = true ]; then
  echo 'Codex: $archflow-init, $archflow-upgrade, $archflow-explore, $archflow-prd, $archflow-design, $archflow-phase-design, $archflow-phase-impl, $archflow-status'
  echo "Restart Codex if the skills do not appear immediately."
fi
