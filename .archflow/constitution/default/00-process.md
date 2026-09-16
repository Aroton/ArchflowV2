---
id: explicit-human-authority
version: 4
status: active
---
In an initialized workflow, required human decisions are explicit and bound to the exact artifact or code subject at gates opened by an approval rule or safety condition. Silence, elapsed time, agent prose, or a model verdict never supplies approval, waives a gate, or advances the workflow. Commits are not human-gated by default. The workflow server enforces this at its gates; an artifact complies unless it asserts, records, or relies on a human decision the workflow did not record. For a standalone simple task, explicit decisions are made in conversation for the presented work and reasons; no durable gate is required.
