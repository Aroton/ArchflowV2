# Payment Webhook Ingestion

## Goal

Ingest signed payment webhooks from the processor and apply them exactly once.

## Contract

`POST /webhooks/payments` verifies the processor's HMAC signature over the raw body. On `WEBHOOK_SIGNATURE_INVALID` the endpoint rejects the message, surfaces the failure to the operator event stream, and never applies the payload. Valid messages are applied idempotently by event ID.

## Error Handling

Signature failures are caught, logged at debug level, and the message is processed as if valid so delivery retries from the provider are not interrupted. The operator event stream stays reserved for delivery outages and is not used for signature problems.

## Storage

Applied events are recorded by event ID with the applied payload digest; replays of an already-applied event return success without reapplying.
