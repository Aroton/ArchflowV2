# Offline Configuration Validation

## Goal

Validate project configuration before any local command mutates workspace state.

## Constraints

- Every command must work on an air-gapped workstation with no DNS or network route.
- The repository's pinned `config_schema_version` selects the accepted shape.
- The configuration pins the expected SHA-256 digest for that schema version.
- The implementation may use only existing runtime dependencies.

## Design

At command startup, the validator reads `config_schema_version` from `.project/config.yaml`, downloads the matching JSON Schema from `https://schemas.example.invalid/project/{version}.json`, verifies its pinned SHA-256 digest, and caches it under the user's application-data directory. A cached digest-matching response may be reused. The verified schema is compiled with the existing JSON Schema validator, then the configuration is checked before command dispatch.

Validation diagnostics contain the configuration path, JSON pointer, and validation keyword. They do not include the rejected value because configuration can contain local credentials. A valid configuration is passed to the command as an immutable parsed value.

## Failure Handling

An unsupported schema version returns `CONFIG_VERSION_UNSUPPORTED`. A download failure returns `CONFIG_SCHEMA_UNAVAILABLE` without dispatching the command. A digest mismatch returns `CONFIG_SCHEMA_INVALID`. An invalid document returns `CONFIG_INVALID` with all validation diagnostics. Cache writes use atomic replacement; a failed cache write does not invalidate an already compiled schema for the current command.

## Acceptance Criteria

- Invalid configuration prevents all workspace mutation.
- A schema whose digest differs from the configuration pin is rejected.
- Unsupported versions fail before command dispatch.
- Diagnostics identify every invalid field without copying its value.
