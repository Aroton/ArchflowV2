# Phase 20 Implementation Counter-Review

- **blocker — Gate-restore secret propagation remains unexecuted.** `test/unit/secret-rejection-phase20.test.ts` calls `prepareProjectionPlan` directly with the injected production scanner and executes no `src/state/gates.ts` restore path. Exercise `runDurableGate` through the existing restore fixture and assert `SECRET_DETECTED`, no projection write, unchanged target/state, an open gate, and no receipt.
- **major — The file-kind SIGKILL case does not exercise ArchFlow's projection writer.** Its inline `writeFile`/`rename` callback and after-callback cut cannot fail in response to an ArchFlow atomic-writer change. Route it through `createProjectionWriter()` on real binary bytes or cite the transaction crash coverage instead.
- **major — Shutdown completion ordering and SIGKILL escalation are overclaimed.** The MCP shutdown test waits for process exit only after `close()` resolves, so it does not establish that shutdown waited for child termination; the limitations document also claims SIGKILL escalation without exercising it. Probe liveness immediately after `close()` and record the actual outcome without redesigning termination in this phase.
- **major — Host-config replacement inherits ambient umask.** `replaceHostConfig` opens its temporary file without an explicit mode, potentially changing an existing user configuration from `0644` to `0664`. Create the temporary file with mode `0o644` and cover the mode contract.

## Triage

Triaged 2026-08-04. All four findings are accepted.

- **Gate-restore secret propagation — accepted.** Scanner injection identity is already covered elsewhere and does not prove propagation. Replace the direct seam test with a real `runDurableGate` restore decision using the existing Phase 12 harness. Because the immutable decision archive precedes replanning, the required postcondition is no state advance, no success receipt, no projection write, unchanged target bytes, and the gate remaining open; it is not zero durable writes.
- **File-kind SIGKILL case — accepted.** A hand-written writer cannot regress with `src/state/atomic.ts`. Route the fixture through `createProjectionWriter()` and retain the binary completeness assertion across the real process cut, without adding a new fault framework.
- **Shutdown ordering and escalation claim — accepted.** Add an immediate post-`close()` liveness observation. If the child remains alive, record it as a scoped follow-up at the human gate instead of changing the termination design. Correct the limitations prose to distinguish observed process-group reaping from unexercised SIGKILL escalation.
- **Host-config file mode — accepted.** Use explicit `0o644`, matching the repository's temp-write convention and avoiding umask-dependent widening. Add a regression assertion without building a general metadata-preservation subsystem.

The two non-findings require no change: quoted bundle literals match esbuild's realistic output, and the helper's deliberate `src/**` exception is documented locally as the approved design requested.

### Resolution Verification

- The real `runDurableGate` discard-and-restore path now returns `SECRET_DETECTED`; it performs no projection write, leaves target/state/approvals/receipt unchanged, keeps the gate open, and retains only the permitted immutable decision archive.
- The binary crash matrix now loads `src/state/atomic.ts`, wraps `createProjectionWriter()`, and proves complete prior/next generations at both before and after cuts.
- Immediate liveness probes show `runtime.handle.close()` currently resolves while the child and in-group grandchild remain alive; both are reaped shortly afterward. The test and limitations document now state that exact result, and awaiting in-flight termination remains a scoped follow-up rather than an unplanned Phase 20 redesign.
- Host-config temporary files are created with explicit mode `0o644`; the regression test observes that mode under a permissive `0o002` umask before the injected rename fault.
- Post-triage typecheck passed, the six affected suites passed 71/71 tests, and the complete non-release suite passed 152 files / 1,678 tests.
