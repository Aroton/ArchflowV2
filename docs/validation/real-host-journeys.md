# Real-host operator journeys

These journeys validate behavior that the automated suite cannot honestly simulate: a real
Claude Code or Codex session, real MCP registration, human decisions, and Git commits made only
after authorization. Run all three in disposable Git repositories **outside this ArchFlow source
checkout**. Do not use this repository as a journey target.

The operator, not the agent, owns every human boundary:

- Never let an agent choose, write, or infer a gate decision. At a gate, inspect the live request
  and templates, then explicitly choose the template yourself.
- Never let an agent infer commit authorization. Inspect the preview's exact retained diff, paths,
  and proposed message, then explicitly authorize or deny once. After authorization, the resulting
  nonhuman local commit action runs without a second prompt; verify its exact commit proof.
- Do not edit `state.json`, checkpoints, receipts, requests, decisions, or digests by hand. Use only
  the live skill, MCP tool, and `archflow-local` outputs.
- Stop and record a blocked journey if a command, resolved configuration, or durable next action
  differs from this runbook. Do not repair it by inventing JSON.

## Evidence and prerequisites

The checkout containing this document is the evidence repository. Set its absolute path, verify
that both installed launchers resolve, and capture help/version output before creating any scratch
repository:

```bash
export ARCHFLOW_SOURCE=/absolute/path/to/mcp-server
test -f "$ARCHFLOW_SOURCE/docs/real-host-journeys.md"
command -v archflow-local
command -v archflow-mcp
archflow-local --help
claude --version
codex --version
claude auth status >/dev/null
codex login status
```

`claude auth status` can print email and organization identifiers. The redirection above is
intentional: record only its exit status as `logged in`, never its raw output.

## Observe real MCP negotiation without recording payloads

The ordinary `claude mcp get` and `codex mcp get` commands show resolved configuration; they do not
show the protocol era or identity actually delivered on the wire. Before the VAL-01 journeys, run
one connection from each real client in an existing checkout the operator already trusts, with
process-scoped MCP configuration. Never approve or persist project trust for a temporary probe
directory: a path written during this run is not durable authority for unrelated future contents.
This procedure
records only process IDs, timestamps, method names, negotiated protocol versions, and the
client/server name and version fields. It never records request arguments, environment variables,
auth output, stderr, or arbitrary `_meta` content.

Create only a disposable log directory and resolve the trusted source checkout explicitly:

```bash
export MCP_PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/archflow-mcp-wire-log.XXXXXX")"
export ARCHFLOW_MCP_REAL="$(command -v archflow-mcp)"
export MCP_PROBE_SOURCE="$(git rev-parse --show-toplevel)"
test -n "$MCP_PROBE_SOURCE"
```

Create `$MCP_PROBE_DIR/observe-mcp.mjs` with these exact contents and make it owner-executable:

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [server] = process.argv.slice(2);
const log = process.env.ARCHFLOW_MCP_OBSERVATION_LOG;
if (!server || !log) process.exit(64);

const child = spawn(server, [], { stdio: ["pipe", "pipe", "inherit"] });
const record = (value) => appendFileSync(log, `${JSON.stringify(value)}\n`, { mode: 0o600 });
record({ event: "spawn", time: new Date().toISOString(), wrapper_pid: process.pid, server_pid: child.pid });

function selected(direction, line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object") return;
  if (direction === "client" && message.method === "initialize") {
    record({
      event: "initialize-request",
      method: "initialize",
      protocol_version: message.params?.protocolVersion ?? null,
      client_name: message.params?.clientInfo?.name ?? null,
      client_version: message.params?.clientInfo?.version ?? null,
    });
    return;
  }
  if (direction === "client" && message.params?._meta?.clientInfo) {
    record({
      event: "request-meta",
      method: typeof message.method === "string" ? message.method : null,
      protocol_version: message.params._meta.protocolVersion ?? null,
      client_name: message.params._meta.clientInfo.name ?? null,
      client_version: message.params._meta.clientInfo.version ?? null,
    });
    return;
  }
  if (direction === "server" && message.result?.protocolVersion) {
    record({
      event: "initialize-response",
      protocol_version: message.result.protocolVersion,
      server_name: message.result.serverInfo?.name ?? null,
      server_version: message.result.serverInfo?.version ?? null,
    });
  }
}

function relay(source, destination, direction) {
  let pending = "";
  source.on("data", (chunk) => {
    destination.write(chunk);
    pending += chunk.toString("utf8");
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      selected(direction, pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  source.on("end", () => destination.end());
}

relay(process.stdin, child.stdin, "client");
relay(child.stdout, process.stdout, "server");
child.on("exit", (code, signal) => {
  record({ event: "exit", time: new Date().toISOString(), code, signal });
  process.exitCode = code ?? 1;
});
```

```bash
chmod 700 "$MCP_PROBE_DIR/observe-mcp.mjs"
```

Create a process-scoped Claude configuration in the disposable log directory. Do not edit the
trusted checkout's `.mcp.json`, `.codex/config.toml`, or either client's remembered project state:

```bash
export MCP_PROBE_WRAPPER="$MCP_PROBE_DIR/observe-mcp.mjs"
export MCP_PROBE_NODE="$(command -v node)"
node <<'NODE'
const fs = require("node:fs");
const value = { mcpServers: { archflow: {
  type: "stdio",
  command: process.execPath,
  args: [process.env.MCP_PROBE_WRAPPER, process.env.ARCHFLOW_MCP_REAL],
} } };
fs.writeFileSync(`${process.env.MCP_PROBE_DIR}/claude-probe.json`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
NODE
```

Launch each client once with a separate empty log. In each interactive client, open its built-in
MCP status UI (`/mcp` where supported), select `archflow`, wait for the connection result, and exit
without asking the model to inspect repository content or calling a workflow tool:

```bash
: > "$MCP_PROBE_DIR/claude-wire.jsonl"
chmod 600 "$MCP_PROBE_DIR/claude-wire.jsonl"
cd "$MCP_PROBE_SOURCE"
ARCHFLOW_MCP_OBSERVATION_LOG="$MCP_PROBE_DIR/claude-wire.jsonl" \
  claude --strict-mcp-config --mcp-config "$MCP_PROBE_DIR/claude-probe.json"

: > "$MCP_PROBE_DIR/codex-wire.jsonl"
chmod 600 "$MCP_PROBE_DIR/codex-wire.jsonl"
codex -C "$MCP_PROBE_SOURCE" \
  -c "mcp_servers.archflow.command=\"$MCP_PROBE_NODE\"" \
  -c "mcp_servers.archflow.args=[\"$MCP_PROBE_WRAPPER\",\"$ARCHFLOW_MCP_REAL\"]" \
  -c 'mcp_servers.archflow.startup_timeout_sec=30' \
  -c 'mcp_servers.archflow.tool_timeout_sec=3600' \
  -c "mcp_servers.archflow.env={ARCHFLOW_MCP_OBSERVATION_LOG=\"$MCP_PROBE_DIR/codex-wire.jsonl\"}"
```

For each log, record in the applicable journey evidence file:

- the count of `spawn` records for that one client connection attempt;
- the client initialize `protocol_version`, delivered `client_name`, and corresponding server
  initialize-response version, if present;
- otherwise, the first `request-meta` protocol version and client name, which is the stateless-era
  observation;
- a literal `absent` for any field the client did not deliver—never infer a name or era from its
  executable name or configuration.

If the installed client has no status action that initiates a connection without a model turn, or
if neither an initialize record nor a request `_meta.clientInfo` record appears, retain the
sanitized log, record the practical limitation, and leave the negotiation criterion unmet. Do not
enable debug logging or capture raw wire messages as a workaround. Delete the disposable log
directory after copying only the selected observations into the evidence file. This procedure must
create no remembered project-trust entry.

Record the completed journeys in these files; they are evidence outputs, not inputs to a journey:

- `docs/validation/journey-val01-claude.md`
- `docs/validation/journey-val01-codex.md`
- `docs/validation/journey-val12-manual.md`

Do not create an evidence file until its journey has actually run. Each record must include the
UTC start/end times, scratch repository path, host and launcher versions, task id, producer family,
commands run, observed `ok`/error results, every gate kind and ID, the operator's explicit decision,
every commit-authorization and resulting nonhuman local commit action, final `archflow-local status` output,
`git status --short`, `git log --oneline --decorate`, and any deviation or blocker. Link or quote
only sanitized transcript excerpts; never copy credentials, auth output, environment values, or
other secrets.

Use this small target in every journey: create a `notes.txt` file with one line in phase 1 and add a
second line in phase 2. The PRD and design must define exactly those two implementation phases. This
keeps the exercise focused on workflow behavior rather than application complexity.

## VAL-01: Claude producer, Codex reviewer

Create a fresh repository under the system temporary directory. `mktemp` guarantees that the
target is outside this source checkout; the explicit comparison fails closed if that assumption is
violated.

```bash
export CLAUDE_JOURNEY_REPO="$(mktemp -d "${TMPDIR:-/tmp}/archflow-val01-claude.XXXXXX")"
export CLAUDE_JOURNEY_LOG="$(mktemp -d "${TMPDIR:-/tmp}/archflow-val01-claude-log.XXXXXX")"
case "$CLAUDE_JOURNEY_REPO/" in "$ARCHFLOW_SOURCE/"*) exit 1 ;; esac
cd "$CLAUDE_JOURNEY_REPO"
git init -q -b main
git config user.name "ArchFlow Journey Operator"
git config user.email "archflow-journey@example.invalid"
printf '# ArchFlow VAL-01 Claude journey\n' > README.md
git add -- README.md
git commit -q -m 'Initialize VAL-01 Claude journey'
archflow-local init | tee "$CLAUDE_JOURNEY_LOG/init-report.json"
```

Inspect `$CLAUDE_JOURNEY_LOG/init-report.json` and the scaffolded files. The active
`.archflow/config.yaml` document must have Claude producer/self-reviewer routes and Codex
counter-reviewer/adjudicator routes. [Correction: the config roles are exactly
`producer`/`counter-reviewer`/`adjudicator` — there is no `self-reviewer` role, and declaring one
fails `CONFIG_INVALID`.] Verify and commit the policy base yourself:

```bash
sed -n '1,120p' .archflow/config.yaml
git diff -- .gitattributes .archflow/workflow.yaml .archflow/constitution .archflow/config.yaml .mcp.json .codex/config.toml
git add -- .gitattributes .archflow/workflow.yaml .archflow/constitution .archflow/config.yaml .mcp.json .codex/config.toml
git commit -m 'Approve ArchFlow journey policy'
claude mcp get archflow | tee "$CLAUDE_JOURNEY_LOG/claude-mcp-get.txt"
node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(".mcp.json","utf8")); console.log(v.mcpServers.archflow.timeout)'
```

The last command must print `3600000`. Do not approve remembered workspace trust for this temporary
path. Run each skill as a non-interactive, non-persisted invocation; Claude documents that print
mode skips the workspace-trust dialog, so this relies only on the operator's current-session trust
in the scratch bytes:

```bash
claude -p --no-session-persistence --permission-mode auto --output-format stream-json --verbose \
  --model claude-opus-5 --effort high $'/archflow-prd val01-claude\n\nCreate a two-phase validation task. Phase 1 creates notes.txt containing phase one; phase 2 appends phase two. No other product behavior is in scope.'
```

The initial prompt includes the complete brief because a non-interactive invocation cannot ask the
operator for it later. Run a fresh non-persisted invocation with the exact skill and arguments returned by durable
status (`/archflow-design val01-claude`, then phase-design and phase-impl for phases 1 and 2). At
every gate, require the agent to show the human-readable preview and its labeled choices, then
choose the decision yourself. Record that the decision-bearing `archflow_gate` or `archflow_waiver`
call returns in the same invocation without polling or a second terminal. At each
commit-authorization, inspect the preview's exact message and file list and authorize or deny once;
after approval the nonhuman `archflow-local commit` action must run without a second confirmation.
Confirm afterwards that the temporary path is absent from
Claude's remembered project state; if the client wrote one despite print mode, purge that exact
path before continuing.

### VAL-09 Claude bounded-gate observation

For one non-commit gate, record the start time immediately before submitting the already-chosen
decision and the end time when the tool returns:

```bash
cd "$CLAUDE_JOURNEY_REPO"
date -u +%Y-%m-%dT%H:%M:%SZ
date +%s
node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(".mcp.json","utf8")); console.log(v.mcpServers.archflow.timeout)'
```

Record the end time with the same two `date` commands and calculate `end_epoch - start_epoch`.
The call must archive the connected-host decision and return normally, comfortably before the
configured `timeout=3600000` milliseconds, without creating or polling a decision from another
terminal. Record the elapsed duration and final gate outcome. If it times out or asks for an
out-of-band decision, mark VAL-09 failed and preserve the exact observed behavior.

Finish by recording these read-only observations:

```bash
cd "$CLAUDE_JOURNEY_REPO"
archflow-local status --task val01-claude | tee "$CLAUDE_JOURNEY_LOG/final-status.json"
git status --short
git log --oneline --decorate
cat notes.txt
```

The final status must be terminal only after both phase commits are individually authorized and
committed through their nonhuman follow-up actions. `notes.txt` must contain both ordered lines.

## VAL-01: Codex producer, Claude reviewer

Create a second independent repository and initialize it before changing routing:

```bash
export CODEX_JOURNEY_REPO="$(mktemp -d "${TMPDIR:-/tmp}/archflow-val01-codex.XXXXXX")"
export CODEX_JOURNEY_LOG="$(mktemp -d "${TMPDIR:-/tmp}/archflow-val01-codex-log.XXXXXX")"
case "$CODEX_JOURNEY_REPO/" in "$ARCHFLOW_SOURCE/"*) exit 1 ;; esac
cd "$CODEX_JOURNEY_REPO"
git init -q -b main
git config user.name "ArchFlow Journey Operator"
git config user.email "archflow-journey@example.invalid"
printf '# ArchFlow VAL-01 Codex journey\n' > README.md
git add -- README.md
git commit -q -m 'Initialize VAL-01 Codex journey'
archflow-local init | tee "$CODEX_JOURNEY_LOG/init-report.json"
```

Before the policy-base commit, replace `.archflow/config.yaml` with the exact Codex-producer block
printed in the comment at the bottom of the scaffolded template: Codex produces and self-reviews;
Claude counter-reviews and adjudicates. Remove the old active document and all leading comment
markers from the replacement. [Correction: the block below includes a `self-reviewer` role that the
config contract does not accept — the roles are exactly `producer`/`counter-reviewer`/`adjudicator`,
and a `self-reviewer` entry fails `CONFIG_INVALID`; omit it.] Inspect the complete file and commit
it with the other scaffolded policy files only after operator review:

```bash
printf '%s\n' \
  'schema_version: "1"' \
  'roles:' \
  '  producer:' \
  '    model: gpt-5.6-sol' \
  '    effort: xhigh' \
  '  self-reviewer:' \
  '    model: gpt-5.6-sol' \
  '    effort: xhigh' \
  '  counter-reviewer:' \
  '    model: claude-opus-5' \
  '    effort: high' \
  '  adjudicator:' \
  '    model: claude-opus-5' \
  '    effort: high' > .archflow/config.yaml
sed -n '1,160p' .archflow/config.yaml
git diff -- .gitattributes .archflow/workflow.yaml .archflow/constitution .archflow/config.yaml .mcp.json .codex/config.toml
git add -- .gitattributes .archflow/workflow.yaml .archflow/constitution .archflow/config.yaml .mcp.json .codex/config.toml
git commit -m 'Approve Codex-producer ArchFlow journey policy'
codex mcp get archflow --json | tee "$CODEX_JOURNEY_LOG/codex-mcp-get.json"
node -e 'const v=require(process.env.CODEX_JOURNEY_LOG+"/codex-mcp-get.json"); console.log(v.startup_timeout_sec, v.tool_timeout_sec)'
```

The last command must print `30 3600`. Do not accept or retain project trust for this temporary
path. Run each skill through an ephemeral non-interactive Codex invocation:

```bash
codex exec --ephemeral --skip-git-repo-check -s workspace-write -C "$CODEX_JOURNEY_REPO" \
  -m gpt-5.6-sol -c 'model_reasoning_effort="xhigh"' \
  $'$archflow-prd val01-codex\n\nCreate a two-phase validation task. Phase 1 creates notes.txt containing phase one; phase 2 appends phase two. No other product behavior is in scope.'
```

Use the same two-phase brief as the Claude journey. Run a fresh ephemeral invocation for each exact
`$archflow-design`, `$archflow-phase-design`, and `$archflow-phase-impl` action returned by durable
status until both phases are complete. Apply the same bounded human-gate and one-confirmation
commit rules: the agent previews and presents; the operator decides once; that decision returns
through one bounded MCP call; approval is followed by the nonhuman local commit action.

### VAL-09 Codex bounded-gate observation

For one non-commit gate, record these values immediately before submitting the already-chosen
decision:

```bash
cd "$CODEX_JOURNEY_REPO"
date -u +%Y-%m-%dT%H:%M:%SZ
date +%s
codex mcp get archflow --json | tee "$CODEX_JOURNEY_LOG/codex-mcp-timeout.json"
node -e 'const v=require(process.env.CODEX_JOURNEY_LOG+"/codex-mcp-timeout.json"); console.log(v.startup_timeout_sec, v.tool_timeout_sec)'
```

Record the end timestamps when Codex returns and calculate the elapsed seconds. The decision-bearing
call must return normally before `tool_timeout_sec=3600`, archive connected-host provenance, and
require neither a pending-call poll nor a second terminal. Record the duration and the resolved
timeouts. If it times out or asks for an out-of-band decision, mark VAL-09 failed and preserve the
actual observation.

Finish with:

```bash
cd "$CODEX_JOURNEY_REPO"
archflow-local status --task val01-codex | tee "$CODEX_JOURNEY_LOG/final-status.json"
git status --short
git log --oneline --decorate
cat notes.txt
```

## VAL-12: fully server-absent manual journey and recovery

This journey uses Claude Code with an explicitly empty, strict MCP configuration. The installed
`archflow-local` remains on `PATH`; `archflow-mcp` must not be registered in the session. Create a
third repository and approve its policy base before disabling the server:

```bash
export MANUAL_JOURNEY_REPO="$(mktemp -d "${TMPDIR:-/tmp}/archflow-val12-manual.XXXXXX")"
export MANUAL_JOURNEY_LOG="$(mktemp -d "${TMPDIR:-/tmp}/archflow-val12-manual-log.XXXXXX")"
case "$MANUAL_JOURNEY_REPO/" in "$ARCHFLOW_SOURCE/"*) exit 1 ;; esac
cd "$MANUAL_JOURNEY_REPO"
git init -q -b main
git config user.name "ArchFlow Journey Operator"
git config user.email "archflow-journey@example.invalid"
printf '# ArchFlow VAL-12 manual journey\n' > README.md
git add -- README.md
git commit -q -m 'Initialize VAL-12 manual journey'
archflow-local init | tee "$MANUAL_JOURNEY_LOG/init-report.json"
git diff -- .gitattributes .archflow/workflow.yaml .archflow/constitution .archflow/config.yaml .mcp.json .codex/config.toml
git add -- .gitattributes .archflow/workflow.yaml .archflow/constitution .archflow/config.yaml .mcp.json .codex/config.toml
git commit -m 'Approve ArchFlow manual journey policy'
claude --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model claude-opus-5 --effort high '/archflow-prd val12-manual'
```

In the session, first ask Claude to list its MCP tools and record that no `archflow_*` tool is
available. Give it the same two-phase brief. Require it to use input-free
`archflow-local manual-status --task val12-manual`, perform exactly the returned `next_action`, pass
only complete requested JSON to `archflow-local manual-next --task val12-manual`, and rerun manual
status after every milestone.

To exercise the waiver path, add this explicit scratch-only proposal to the brief: “The phase 1
plan proposes that a material change to the required first line may proceed without updating and
re-reviewing its approved plan; this proposal exists only to test constitutional adjudication and
must not be acted on.” The normal review/adjudication pipeline must decide whether that proposal
opens a waiver-eligible gate. Do not manufacture a gate, finding, eligible rule, or waiver if it
does not. If no live waiver-eligible gate appears, stop and record VAL-12 as blocked rather than
changing durable files or violating the approved-design-before-code boundary.

Run the complete PRD and design pipelines and explicitly approve their current artifacts. Complete
both phase-design and phase-implementation pipelines, so the chain contains decisions for at least
two distinct phases. During one eligible non-commit gate, the operator must choose the live
`waiver-requested` template; then inspect the separately published waiver request and explicitly
choose a live `granted: true` waiver template. Record both gate IDs and both archived outcomes.
Do not describe the original gate as approved by the waiver request itself.

For each implementation phase, require the distinct commit-authorization gate and choose
`authorize-commit` only after reviewing its preview-bound diff, artifact digests, message, and paths.
That is the sole commit confirmation: record the resulting nonhuman local commit action and fail the
journey if it asks again. Never let Claude answer the gate decision on the operator's behalf. Before
recovery, verify that the manual authority is a unique closed chain:

```bash
cd "$MANUAL_JOURNEY_REPO"
archflow-local manual-status --task val12-manual | tee "$MANUAL_JOURNEY_LOG/manual-final-status.json"
find .archflow/tasks/val12-manual/manual/checkpoints -maxdepth 1 -type f -print | LC_ALL=C sort | tee "$MANUAL_JOURNEY_LOG/checkpoints-before.txt"
find .archflow/tasks/val12-manual/decisions -type f -print | LC_ALL=C sort | tee "$MANUAL_JOURNEY_LOG/decisions-before.txt"
git status --short
git log --oneline --decorate | tee "$MANUAL_JOURNEY_LOG/git-log-before.txt"
```

The chain must include PRD approval, design approval, both phases' decisions, the granted waiver,
both commit authorizations, and committed-tree observations. Any open gate or repair-required status
blocks recovery.

### Separate server-enabled recovery/import/reconcile run

Exit the strict server-absent Claude session. Generate the import call from the authenticated chain;
do not edit the emitted call:

```bash
cd "$MANUAL_JOURNEY_REPO"
printf '%s\n' '{"schema_version":"1","operation":"import-call","intent_id":"val12-recovery-import"}' > "$MANUAL_JOURNEY_LOG/recovery-import-selector.json"
archflow-local manual-next --task val12-manual --input "$MANUAL_JOURNEY_LOG/recovery-import-selector.json" | tee "$MANUAL_JOURNEY_LOG/recovery-import-call.json"
node -e 'const v=require(process.env.MANUAL_JOURNEY_LOG+"/recovery-import-call.json"); if (!v.ok || v.value.kind!=="import-call") process.exit(1); console.log(JSON.stringify(v.value.call.input))'
```

Start a new ordinary Claude session, now with the project MCP registration enabled, and instruct it
to import exactly the generated call and observe reconciliation without replaying work:

```bash
claude --add-dir "$MANUAL_JOURNEY_LOG" --model claude-opus-5 --effort high 'Recovery only for task val12-manual. Read the recovery-import-call.json in the added log directory, call archflow_state once with exactly value.call.input, then run archflow-local status --task val12-manual. Do not recreate, repeat, or answer any resolved gate, waiver, phase decision, or commit authorization; do not commit.'
```

After that session exits, record the imported state and reconciliation projection:

```bash
cd "$MANUAL_JOURNEY_REPO"
archflow-local status --task val12-manual | tee "$MANUAL_JOURNEY_LOG/recovered-status.json"
archflow-local manual-status --task val12-manual | tee "$MANUAL_JOURNEY_LOG/recovered-manual-status.json"
find .archflow/tasks/val12-manual/decisions -type f -print | LC_ALL=C sort | tee "$MANUAL_JOURNEY_LOG/decisions-after.txt"
git status --short
git log --oneline --decorate | tee "$MANUAL_JOURNEY_LOG/git-log-after.txt"
diff -u "$MANUAL_JOURNEY_LOG/decisions-before.txt" "$MANUAL_JOURNEY_LOG/decisions-after.txt"
diff -u "$MANUAL_JOURNEY_LOG/git-log-before.txt" "$MANUAL_JOURNEY_LOG/git-log-after.txt"
```

Compare the decision-file list and Git history with the pre-recovery observations. Recovery passes
only if the complete chain imports, status reports reconciled non-conflicting authority at the same
conservative milestone, no resolved decision or retained result is duplicated, and no extra commit
appears. Record all observations in `docs/validation/journey-val12-manual.md`; if the host or helper
asks to repeat a resolved decision, stop and record the journey as blocked.
