# Sized Connection Credit Budget Design

## Goal

Carry terminal attachments, the state subscription, and the project snapshot over one multiplexed connection so that a stalled consumer delays only itself, and a reconnecting desktop always reaches `Current`.

## Requirements

- Each attachment, the subscription, and the snapshot is an independent flow-controlled stream on one connection.
- A consumer that stops reading one attachment must not delay any other stream.
- Reconnect must reach `Current` — snapshot applied, subscription live — with any number of attachments open or stalled.
- Credit is released only when a record has been applied.

## Background

Flow control is per stream and per connection. A stream can hold at most its stream window of unreleased bytes; the connection can hold at most its connection window, and exhausting it blocks every stream. The snapshot is one stream applied in full before `Current`; the largest snapshot measured on the staging fleet is 7.5 MiB, and the measurement is repeated before each release.

## Design

Each stream keeps one record in flight. The desktop drains the transport into a bounded per-stream receive buffer and releases stream and connection credit after the reconciler has applied the record. When unreleased attachment bytes reach `ATTACH_CREDIT_BUDGET`, the desktop resets the longest-stalled attachment and reattaches it later from retained output, so attachment credit can never exceed the budget even if every attachment is stalled.

The snapshot never competes with attachments for credit: `RECONCILE_RESERVE` is sized from the measured snapshot, and the reserve is recomputed if a release measurement exceeds it.

### Constants

| Constant | Value | Rationale |
|---|---|---|
| `STREAM_WINDOW` | 1 MiB | Larger than the largest record (256 KiB). |
| `MAX_ATTACHMENTS` | 12 | Product limit on simultaneously open terminals. |
| `ATTACH_CREDIT_BUDGET` | 12 MiB | `MAX_ATTACHMENTS × STREAM_WINDOW`: every attachment fully stalled at once. |
| `MAX_SNAPSHOT_BYTES` | 8 MiB | Measured 7.5 MiB largest snapshot rounded up; re-measured before each release, and a measurement above this value raises the reserve before ship. |
| `RECONCILE_RESERVE` | 10 MiB | `MAX_SNAPSHOT_BYTES + STREAM_WINDOW` for the subscription `+ STREAM_WINDOW` for in-flight requests. |
| `CONNECTION_WINDOW` | 22 MiB | `ATTACH_CREDIT_BUDGET + RECONCILE_RESERVE`. |

## Verification

- A stalled attachment does not delay a sibling attachment's delivery.
- With twelve attachments fully stalled, an 8 MiB snapshot completes and the connection reaches `Current`.
- The desktop drains the transport while a consumer is stalled: transport-level receive buffers stay below `STREAM_WINDOW` per stream while the application-level receive buffer holds the unapplied bytes.
- Credit is released on apply, not on receipt.
- Resetting the longest-stalled attachment restores attachment credit and the attachment reattaches from retained output.

## Acceptance Criteria

- Sibling stalls never delay other streams.
- Reconnect reaches `Current` with any number of open or stalled attachments and the largest measured snapshot.
- Credit accounting matches the constants table under simulation.
