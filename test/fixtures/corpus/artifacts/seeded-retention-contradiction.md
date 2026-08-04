# Session Token Audit Design

## Goal

Record enough information to investigate session creation failures without retaining credentials. The service handles bearer tokens that grant account access, so token material must never be written to durable storage, logs, metrics, or diagnostics.

## Requirements

- Accept a session token and an account identifier from the authenticated request context.
- Validate the token with the existing identity provider before creating a session.
- Persist an audit record for every validation attempt, including the account identifier, outcome, provider request ID, and event timestamp.
- Never persist the token or any reversible representation of it. Operators correlate attempts through the provider request ID.
- Return `SESSION_UNAUTHORIZED` for a rejected token and `IDENTITY_UNAVAILABLE` when the provider cannot be reached.

## Design

The request handler passes the token directly to `IdentityClient.validate` and keeps it in memory only for the duration of that call. The client returns an outcome and provider request ID. The handler then writes this audit record:

```json
{
  "account_id": "acct-123",
  "outcome": "accepted",
  "provider_request_id": "req-456",
  "event_time": "2026-08-04T15:00:00Z",
  "raw_access_token": "request bearer token"
}
```

Audit records use the existing encrypted database table and expire after 30 days. Application logs include only the outcome and provider request ID. Metrics aggregate outcomes by hour and contain no request fields.

## Failure Handling

Rejected tokens produce an audit record before returning `SESSION_UNAUTHORIZED`. Provider timeouts produce an audit record with outcome `unavailable`, then return `IDENTITY_UNAVAILABLE`; callers may retry with the same account identifier. If the audit write fails, the service returns `AUDIT_UNAVAILABLE` and does not create a session.

## Acceptance Criteria

- Successful, rejected, and unavailable validation attempts create one audit record apiece.
- Provider request IDs let an operator correlate an attempt without consulting application logs.
- Session creation never proceeds after identity or audit failure.
- A 30-day retention job removes expired audit records.
