---
name: archflow-init
description: Initialize ArchFlow's repository assets and project-scoped Claude Code and Codex MCP registrations. Use when setting up ArchFlow in a repository for the first time, repairing an incomplete initialization, or checking initialization diagnostics after an install or host configuration change.
---

# Initialize ArchFlow

Run `archflow-local init` from the repository root. Relay its complete report, including any recovery command, host approval or trust step, managed-policy path, collision, authentication problem, or unsupported-version diagnostic.

If the MCP server is unavailable after initialization, run read-only `archflow-local manual-status --task <task>`, report its position, and create no task milestone — there is no offline recording path; the server records all progress once restored. If `archflow-local` is also unavailable, reinstall with `./install.sh`, then rerun `archflow-local init` and `manual-status`. Do not infer initialization or recovery authority from files while the executables are unavailable.

Do not claim that initialization passed a host's human approval/trust boundary. Do not describe ArchFlow's best-effort dispatch context hygiene as an enforced isolation boundary.

Initialization creates no task state and no commit. It scaffolds `.archflow/.gitignore` with the single rule `/runtime/`, reports whether that nested ignore file was created or already present, and diagnoses both whether `.archflow/runtime/` is ignored and whether any path below it is already tracked. It never edits the project root `.gitignore`. Ask the human to review and commit the scaffolded `.archflow/.gitignore`, `.archflow/workflow.yaml`, `.archflow/constitution/`, `.archflow/config.yaml`, `.gitattributes`, `.mcp.json`, and `.codex/config.toml` changes before starting a task.
