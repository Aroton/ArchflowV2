---
id: human-approval-for-crypto-and-secrets
version: 1
status: active
review_trigger: The change adds or alters cryptographic primitives, key or credential generation, storage, transmission, or comparison, or moves secret material to a new location.
---
Cryptography and credential handling fail silently, because incorrect use can look correct while destroying confidentiality or authenticity. Work that changes cryptographic primitives, key or credential handling, or secret storage must be judged against the reviewed repository snapshot before it advances; a result complies when its changed handling uses well-established primitives and libraries as its approved documents describe and never weakens an existing secrecy or authenticity guarantee.
