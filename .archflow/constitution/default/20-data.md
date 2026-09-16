---
id: task-and-evidence-isolation
version: 2
status: active
enforced_by:
  - task-path-boundary-tests
  - subject-digest-validation
---
Tasks are isolated from one another. Durable decisions and evidence identify the exact task and subject bytes they govern; stale, mismatched, cross-task, malformed, or partial evidence fails closed and cannot authorize advancement.
