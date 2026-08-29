# Output Record Chunking and Control Latency Design

## Goal

Deliver terminal output records over a shared multiplexed connection while keeping control records — resize, input receipts, lease renewal — responsive no matter how much bulk output is flowing.

## Requirements

- Control records must not queue behind bulk output for longer than one chunk transmission time per active stream.
- Output records are the unit of daemon-side retention; a retained record is resent byte-identically on reattach.
- The transport is handed data in fixed-size units so that a single stream cannot monopolize the link.

## Design

The scheduler runs in turns. On each turn it visits every active stream once. Bulk output and control records travel on different streams of the same connection, and the transport interleaves streams at the granularity of the units it is handed.

### Scheduling rules

1. No unit handed to the transport is larger than `DATA_CHUNK`.
2. An attachment sends at most one output record per scheduler turn.
3. Each stream keeps at most one unit inside the transport at any time; the next unit is handed over only after the previous one is acknowledged as sent.

Because rules 1 and 3 hold, a control record arriving during a turn waits behind at most one `DATA_CHUNK` per active stream. With twelve active streams at 100 Mbit/s that bound is `12 × 16 KiB / 12.5 MiB/s ≈ 15 ms`, and at the constrained 64 KiB/s downlink it is `12 × 16 KiB / 64 KiB/s = 3 s`, which is the acceptance bound in the constrained profile.

### Constants

| Constant | Value | Rationale |
|---|---|---|
| `DATA_CHUNK` | 16 KiB | Transport default maximum unit; the control-latency bound is derived from it. |
| `OUTPUT_RECORD` | ≤ 32 KiB | Unchanged retention chunk size; one retained record equals one wire record so reattach resends exact bytes. |
| `MAX_ACTIVE_STREAMS` | 12 | Product limit on simultaneously open terminals. |
| `CONTROL_LATENCY_BOUND` (constrained profile) | 3 s | `MAX_ACTIVE_STREAMS × DATA_CHUNK / 64 KiB/s`. |

## Retention

The daemon retains output as records of up to `OUTPUT_RECORD` bytes. On reattach it replays retained records from the consumer's confirmed sequence; a record is never split or re-chunked between retention and the wire.

## Verification

- A control record issued while twelve streams are streaming bulk output is delivered within `CONTROL_LATENCY_BOUND` in the constrained profile.
- A retained record replayed after reattach is byte-identical to the record first delivered.
- No unit larger than `DATA_CHUNK` is ever observed at the transport boundary.

## Acceptance Criteria

- Control latency stays within the stated bound under full bulk load.
- Reattach replay is exact.
- Transport units never exceed `DATA_CHUNK`.
