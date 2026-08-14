# Atomic Profile Update

## Goal

Update a user's display name and locale without exposing partially updated state to concurrent readers.

## Contract

`PATCH /profiles/{user_id}` accepts `display_name`, `locale`, and `expected_revision`. Both text fields are required and validated before storage. A successful response contains the complete profile and its incremented revision.

## Design

The service begins a database transaction and runs one conditional update of both fields and the revision, using profile ID plus `expected_revision` in the predicate and returning the complete row. If no row is returned, it checks profile existence inside the transaction to distinguish a missing profile from a stale revision. The transaction commits before the response is rendered. Readers use the same primary database and therefore observe either the prior profile or the complete new profile.

The update emits an outbox event in the same transaction. A background publisher sends committed events to the search index and marks them delivered. Event identity is the profile ID plus revision, making publisher retries idempotent.

## Failure Handling

Missing profiles return `PROFILE_NOT_FOUND`. A stale revision returns `REVISION_CONFLICT` with the current revision but no profile fields. Validation errors return `PROFILE_INVALID` before opening a transaction. If the transaction or outbox insert fails, the transaction rolls back and the endpoint returns `PROFILE_WRITE_FAILED`; it never reports success.

## Acceptance Criteria

- Concurrent updates with one expected revision produce exactly one success.
- Readers never observe a new display name paired with the previous locale.
- Every committed revision has exactly one logical outbox event, including after publisher retries.
- Invalid input and failed writes leave the profile and outbox unchanged.
