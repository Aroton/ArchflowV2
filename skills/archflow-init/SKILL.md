---
name: archflow-init
description: Initialize ArchFlow's repository assets and project-scoped Claude Code and Codex MCP registrations. Use when setting up ArchFlow in a repository for the first time, repairing an incomplete initialization, or checking initialization diagnostics after an install or host configuration change.
---

# Initialize ArchFlow

Run `archflow-local init` from the repository root. Relay its complete report, including any recovery command, host approval or trust step, managed-policy path, collision, authentication problem, or unsupported-version diagnostic.

If the MCP server is unavailable after initialization, run input-free `archflow-local manual-status --task <task>` before any task mutation and follow its one `next_action`. Use `archflow-local manual-next --task <task>` or `archflow-local manual-handoff --task <task>` only with the complete plain-JSON input emitted or requested by that result — piped directly on stdin when it is small generated JSON, or written to a file and passed with `--input <json-file>` when it carries authored prose or quotes, since shell quoting silently corrupts such payloads; never author checkpoint anchors, digests, approvals, attempts, retained-result references, or gate authority. If `archflow-local` is also unavailable, stop without creating a task milestone and reinstall with `./install.sh`, then rerun `archflow-local init` and `manual-status`. Do not infer initialization or recovery authority from files while both executables are unavailable.

Do not claim that initialization passed a host's human approval/trust boundary. Do not describe ArchFlow's best-effort dispatch context hygiene as an enforced isolation boundary.

Initialization creates no task state and no commit. Ask the human to review and commit the scaffolded `.archflow/workflow.yaml`, `.archflow/constitution/`, `.archflow/config.yaml`, `.gitattributes`, `.mcp.json`, and `.codex/config.toml` changes before starting a task.
