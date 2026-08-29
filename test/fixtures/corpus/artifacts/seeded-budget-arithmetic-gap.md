# Multiplexed Connection Credit Budget Design

## Goal

Carry every terminal attachment, the state subscription, the project snapshot, and request/response calls over one multiplexed connection without letting a stalled consumer delay any other stream. The desktop is the consumer; the daemon is the producer.

## Requirements

- Every logical stream — each attachment, the state subscription, the snapshot, and each request — is an independent flow-controlled stream on one connection.
- A consumer that stops reading one attachment must not delay delivery on any other stream. Only that attachment may stall.
- A reconnecting desktop must reach `Current` — snapshot applied, subscription live — regardless of how many attachments are open or stalled at the time.
- Credit is released only when the consumer has applied a record, never on receipt.

## Background

Flow control is per stream and per connection. A stream can hold at most its stream window of unreleased bytes; the connection as a whole can hold at most its connection window. A stream that fills its window blocks only itself; a connection that exhausts its window blocks every stream on it.

The project snapshot is sent as one stream and must be fully applied before the connection is `Current`. Snapshot size scales with project state: the smallest projects produce a few hundred kilobytes, and the largest project measured on the staging fleet produced a 7.5 MiB snapshot.

Attachments are output streams from long-running processes. At the measured worst-case output rate of 128 KiB/s per process, an attachment whose consumer has stopped reading fills a 1 MiB window in about eight seconds, so several attachments being fully stalled at once is the ordinary case, not a corner.

## Design

Each stream keeps at most one record in flight. The desktop drains the transport into a bounded per-stream receive buffer and releases stream and connection credit only after the reconciler has applied the record.

When the sum of unreleased attachment bytes reaches `ATTACH_CREDIT_BUDGET`, the desktop resets the longest-stalled attachment and later reattaches it from the daemon's retained output. That reset is what bounds attachment credit; the reserve above it is what keeps the connection itself from stalling.

### Constants

| Constant | Value | Rationale |
|---|---|---|
| `STREAM_WINDOW` | 1 MiB | Larger than the largest single record (256 KiB) so a per-stream stall never blocks its own producer mid-record. |
| `MAX_ATTACHMENTS` | 12 | Product limit on simultaneously open terminals per connection. |
| `ATTACH_CREDIT_BUDGET` | 12 MiB | `MAX_ATTACHMENTS × STREAM_WINDOW`: every attachment may be fully stalled at once. |
| `RECONCILE_RESERVE` | 4 MiB | Headroom for the subscription, the snapshot, and in-flight requests while attachments are stalled. |
| `CONNECTION_WINDOW` | 16 MiB | `ATTACH_CREDIT_BUDGET + RECONCILE_RESERVE`. |
| `CONSUMER_STALL_DEADLINE` | 120 s | An attachment unconfirmed for this long is reset as memory hygiene. |

## Reconnect

On reconnect the desktop opens the snapshot stream first, applies it, then opens the subscription and reports `Current`. Attachments reopen in parallel and may stall immediately if their terminals are hidden.

## Verification

- A stalled attachment does not delay a sibling attachment's delivery.
- With twelve attachments fully stalled, a thirteenth request stream still completes.
- Credit is released on apply, not on receipt, asserted by a consumer that receives without applying and observing no window growth.
- Resetting the longest-stalled attachment restores attachment credit and the attachment reattaches from retained output.

## Acceptance Criteria

- Sibling stalls never delay other streams.
- Reconnect reaches `Current` with any number of open or stalled attachments.
- Credit accounting matches the constants table under simulation.
