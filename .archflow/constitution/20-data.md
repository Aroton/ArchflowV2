---
id: task-and-evidence-isolation
version: 1
status: active
review_trigger: A task reads or mutates another task's files, or an approval, waiver, review, or result is used for bytes other than the subject it identifies.
enforced_by:
  - task-path-boundary-tests
  - subject-digest-validation
---
Tasks are isolated from one another. Durable decisions and evidence identify the exact task and subject bytes they govern; stale, mismatched, cross-task, malformed, or partial evidence fails closed and cannot authorize advancement.
