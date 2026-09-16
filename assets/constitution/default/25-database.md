---
id: human-approval-for-database-behavior
version: 1
status: active
review_trigger: >-
  The implementation adds, removes, or changes SQL-backed database behavior through SQL statements, embedded queries, ORM reads or writes, schema definitions, or schema/data migrations in any writable repository. Identify the changed path, operation, and its effect on queried results, persisted data, or database structure. Match actual implementation changes even when already described in an approved plan. Documentation-only mentions, planning artifacts, test-only changes, and refactors that preserve database behavior do not match. Unchanged database code in the review context is not a trigger. Report uncertain only when concrete changed database code and the supplied evidence leave its behavioral effect unresolved; name the missing evidence.
---
Database reads, writes, and schema changes must implement the governing requirements, preserve data integrity, and use safe query construction and transaction behavior appropriate to the operation. Review the changed operation and its consequences against the supplied repository snapshot. The trigger requests human review of database behavior; compliance judges correctness, not whether a workflow approval has already happened. Deterministic SQL-file approval in project configuration applies independently, including to edits that preserve behavior.
