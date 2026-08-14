# Offline Configuration Validation

## Goal

Validate project configuration before any local command mutates workspace state, including on air-gapped workstations.

## Constraints

- Validation performs no network access.
- Identical repository and installed-package bytes produce identical results.
- The repository's pinned `config_schema_version` selects the accepted shape.
- The implementation uses only existing runtime dependencies.

## Design

Supported JSON Schemas ship inside the installed package under versioned filenames. At startup, the validator reads `config_schema_version`, resolves it through a closed in-package version map, and loads those bytes without consulting user caches or remote services. The schema is compiled with the existing JSON Schema validator, then the configuration is checked before command dispatch.

Diagnostics contain the repository-relative configuration path, JSON pointer, and validation keyword. They omit rejected values because configuration can contain local credentials. Diagnostics are sorted by pointer and keyword before being returned. A valid configuration is passed to the command as an immutable parsed value.

## Failure Handling

An absent or unsupported version returns `CONFIG_VERSION_UNSUPPORTED`. Missing packaged schema bytes return `INSTALLATION_INVALID`; the command does not fall back to a network source. An invalid document returns `CONFIG_INVALID` with all diagnostics. Every failure occurs before command dispatch or workspace writes.

## Acceptance Criteria

- Validation succeeds with network interfaces disabled.
- Invalid configuration prevents all workspace mutation.
- Repeated validation of identical bytes returns diagnostics in stable order.
- Unsupported versions and damaged installations fail before command dispatch.
- Diagnostics identify invalid fields without copying their values.
