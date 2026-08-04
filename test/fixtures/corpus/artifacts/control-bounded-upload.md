# Bounded Document Upload

## Goal

Accept PDF documents up to 10 MiB while bounding memory use and ensuring rejected content never becomes visible to readers.

## Design

The handler streams the request into a uniquely named file in the service's staging directory. It counts bytes while writing and computes a SHA-256 digest incrementally. If the count exceeds 10 MiB, the handler closes and removes the staging file before returning `UPLOAD_TOO_LARGE`.

After the stream ends, the handler verifies the PDF signature and parses metadata using the existing bounded parser. It then atomically renames the staging file into content-addressed storage under its digest. A database transaction records the document ID, digest, byte count, and owner. If the digest already exists, the storage rename is treated as idempotent and the new database record may reference the existing bytes.

## Failure Handling

Client cancellation closes and removes the staging file. Signature or parser failure returns `DOCUMENT_INVALID` after cleanup. A storage failure removes any staging file and returns `UPLOAD_STORAGE_FAILED`. If the database transaction fails after the content-addressed file is installed, a periodic sweeper removes unreferenced files after a grace period; an installed file is never served without a committed owner record.

## Acceptance Criteria

- Resident memory does not scale with uploaded document size.
- A byte over the limit returns `UPLOAD_TOO_LARGE` and leaves no staging file.
- Cancellation and invalid PDFs leave neither a database record nor a durable served artifact.
- Retrying identical bytes is safe and does not duplicate content storage.
