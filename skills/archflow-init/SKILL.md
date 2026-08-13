---
name: archflow-init
description: Initialize ArchFlow's repository assets and project-scoped Claude Code and Codex MCP registrations. Use when setting up ArchFlow in a repository for the first time, repairing an incomplete initialization, or checking initialization diagnostics after an install or host configuration change.
---

# Initialize ArchFlow

Run `archflow-local init` from the repository root. Translate its result into a short, conversational summary: what was initialized, anything the human must approve or trust, and the next action. Explain failures in plain language with the safe recovery action. Do not relay raw output or expose IDs, digests, JSON, internal managed-policy paths, or protocol codes unless the user explicitly asks for diagnostics or audit detail.

If the MCP server is unavailable after initialization, run read-only `archflow-local manual-status --task <task>`, report its position, and create no task milestone — there is no offline recording path; the server records all progress once restored. If `archflow-local` is also unavailable, reinstall with `./install.sh`, then rerun `archflow-local init` and `manual-status`. Do not infer initialization or recovery authority from files while the executables are unavailable.

Do not claim that initialization passed a host's human approval/trust boundary. Do not describe ArchFlow's best-effort dispatch context hygiene as an enforced isolation boundary.

Initialization creates no task state and no commit. It scaffolds `.archflow/.gitignore` with the single rule `/runtime/`, reports whether that nested ignore file was created or already present, and diagnoses both whether `.archflow/runtime/` is ignored and whether any path below it is already tracked. It never edits the project root `.gitignore`. Ask the human conversationally to review and commit the scaffolded policy and host-registration files before starting a task; summarize their purpose instead of dumping an internal path inventory, while retaining that inventory for an explicitly requested diagnostic report.
