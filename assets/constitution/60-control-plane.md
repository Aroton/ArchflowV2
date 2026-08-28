---
id: human-approval-for-workflow-control-plane
version: 1
status: active
review_trigger: The change declares an output path of .archflow/workflow.yaml, .archflow/config.yaml, or any file under .archflow/constitution/, or otherwise edits the repository-wide policy those files define.
---
The workflow authority files are the trust boundary every task pins its policy from, and a change there alters what all future work must satisfy. A result that changes .archflow/workflow.yaml, .archflow/config.yaml, or .archflow/constitution/ complies only when the change is declared as a reviewed output of its phase and every governing document it amends is updated in the same result; a task never amends the pinned constitution that governs itself.
