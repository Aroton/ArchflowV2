---
id: human-approval-for-public-contracts
version: 1
status: active
review_trigger: >-
  The change adds, removes, or changes a truly externally consumed contract: an HTTP endpoint, published wire format or schema, supported CLI or MCP interface, or a library package's primary exposed interface. This includes compatible additions and changes already described in the plan. Identify the external consumer and the actual contract or observable behavior that changes. A public method on an internal class, internal module exports, tests, and refactors that preserve the external contract do not match merely because they use public visibility.
---
External consumers rely on the supported entrypoints, inputs, outputs, errors, and behavior a project exposes. Changes to those contracts require an explicit human decision over the reviewed result. The reviewer must name the external surface, its consumers, and what changes; language-level visibility alone is not evidence that a contract is externally consumed. Review unchanged external behavior as context, not as a reason to request approval.
