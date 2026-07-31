---
name: archflow-init
description: Initialize ArchFlow's repository assets and project-scoped Claude Code and Codex MCP registrations. Use when setting up ArchFlow in a repository for the first time, repairing an incomplete initialization, or checking initialization diagnostics after an install or host configuration change.
---

# Initialize ArchFlow

Run `archflow-local init` from the repository root. Relay its complete report, including any recovery command, host approval or trust step, managed-policy path, collision, authentication problem, or unsupported-version diagnostic.

Do not claim that initialization passed a host's human approval/trust boundary. Do not describe ArchFlow's best-effort dispatch context hygiene as an enforced isolation boundary.

Initialization creates no task state and no commit. Ask the human to review and commit the scaffolded `.archflow/workflow.yaml`, `.archflow/constitution/`, `.archflow/config.yaml`, `.gitattributes`, `.mcp.json`, and `.codex/config.toml` changes before starting a task.
