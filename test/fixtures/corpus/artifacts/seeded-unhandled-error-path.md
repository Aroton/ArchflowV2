# Export Job Lease Renewal

## Goal

Allow a worker to renew its lease while producing a large export, preventing a second worker from claiming the same job.

## Contract

`POST /exports/{job_id}/lease` accepts the worker ID and current lease revision. A successful response returns a new expiry time and increments the revision.

The endpoint has three named failures:

- `JOB_NOT_FOUND` when the job does not exist.
- `WORKER_MISMATCH` when another worker owns the current lease.
- `LEASE_EXPIRED` when the request arrives after the current expiry; the worker must stop uploading chunks and leave the job resumable.

## Worker Flow

The worker renews at half of the lease interval. On success it stores the returned revision in memory and schedules the next renewal. An interrupted worker may restart, reload its last committed chunk index, claim a new lease, and continue without duplicating output.

## Error Handling

On `JOB_NOT_FOUND`, the worker deletes its local scratch output and exits because there is no durable job to resume. On `WORKER_MISMATCH`, it stops immediately, retains scratch output until its normal cleanup deadline, and emits an ownership-conflict event for operators. Transient transport failures use exponential backoff bounded by the remaining lease duration.

## Storage

Lease owner, revision, and expiry are updated in one conditional database statement. Export chunks are committed independently and keyed by job ID plus chunk index. A new owner can therefore resume only from committed chunks; partial scratch data never becomes visible.

## Acceptance Criteria

- Two workers racing the same revision yield one renewal and one `WORKER_MISMATCH`.
- A successful renewal increments the lease revision exactly once.
- A restarted worker resumes at the first uncommitted chunk.
- Transport retry stops before the lease deadline instead of extending work without authority.
