# Review file-reference probes

Observed 2026-09-16 on this checkout's host, using temporary fixture files and narrowly scoped noninteractive invocations. No broad review benchmark or global installation was run.

| CLI | Invocation conditions | Observed loading |
| --- | --- | --- |
| Claude 2.1.273 | `-p`, `--safe-mode`, `Read,Grep,Glob`, explicit input-directory grant, empty strict MCP configuration, disabled slash commands, no session persistence, empty setting sources, empty stdin | Before tool calls, reported the direct small-file markers, including the tail of a 2,201-line whitespace fixture. The nested reference was not expanded; an explicit Read retrieved it. Nearby and root instruction markers were absent. A separate roughly 404 KB whitespace fixture was omitted from initial context, with no omission notice reported by the model. |
| Codex 0.154.0 | `exec`, ephemeral, ignored user config/rules, strict config, read-only sandbox, project instruction budget zero, skills instructions disabled, existing feature suppressions, shell readers enabled, empty stdin | Before tool calls, reported no file markers. Tool events then read the referenced files and nested target, including the tail. Root/nearby instruction markers were not initially loaded; the model explicitly read instruction files during investigation. |
| Antigravity (`agy`) 1.2.4 | `-p`, disabled slash commands, existing permission bypass, `gemini-3.8-flash-high`/high, empty stdin | Reported no initially visible markers. Tool investigation retrieved direct and nested files and the tail. No nearby/root instruction markers were reported initially; this does not establish general instruction isolation. |

These are marker-based behavioral observations, supported by model responses and available tool traces, not an API request capture or universal size-threshold guarantee. Claude's approximately 12 KB wide-line fixture retained both markers. The larger omission shows that `@file` cannot promise complete immediate inclusion even on the CLI that expands direct references.

The implementation therefore supplies direct references with per-file usage guidance, keeps complete files readable, and asks reviewers to read anything the CLI did not already include. The working directory is the review sandbox; all supplied references are under `review-inputs/`, with repository snapshots under `repositories/`. Automated offline adapter tests check those local paths, permissions, schema transport, empty stdin, and bounded argv without consuming subscriptions.

Official references checked during the investigation: [Claude file references](https://code.claude.com/docs/en/common-workflows#reference-files-and-directories), [Codex CLI reference](https://developers.openai.com/codex/cli/reference), and [Antigravity headless mode](https://antigravity.google/docs/cli/headless/). Observed noninteractive behavior takes precedence over assuming that interactive syntax is interchangeable.
