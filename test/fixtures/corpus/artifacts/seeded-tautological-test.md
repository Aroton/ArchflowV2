# Session Quota Check

## Goal

Enforce a per-session request quota so a single session cannot exhaust shared capacity.

## Contract

Each request carries a session ID. The service computes the session's quota from its plan limits and the current window, and rejects requests beyond the quota with `QUOTA_EXCEEDED`. Quotas reset at the window boundary.

## Acceptance Criteria

- The quota check fails if the quota computation ever regresses.
- The test suite detects a quota computed from the wrong inputs (wrong window, wrong plan limits, or wrong counting).

## Test Plan

The quota test recomputes the expected quota with the same formula the service uses and asserts equality against the service's answer. Both sides import the one shared formula module, so the test can only fail if the service and the test are changed together.

## Observability

Rejected requests emit a `quota.exceeded` event carrying the session ID, plan, and window so operators can attribute load.
