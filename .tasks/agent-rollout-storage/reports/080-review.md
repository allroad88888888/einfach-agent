# 080 independent review

VERDICT: FAIL

## Findings

### Critical — CLI root rollout is never enabled

`apps/cli/src/runtime.ts:131-139` creates and injects only `agentRollout`. A root rollout is not
written directly from that dependency: `packages/agent-core/src/runtime/persistenceBridge.ts:97-101`
creates the `RecoveryWriter` (and therefore its `AgentRolloutCoordinator`) only when both
`recovery` and `recoveryStore` are configured. A fresh CLI process configures neither. Consequently
`persistRecovery()` is a no-op for root runs while child recording can still fetch the injected
driver from `core.persistence.dependencies()`. The result is a split history in which CLI children
are durable but their root conversation has no rollout.

Required repair:

- Assemble the CLI recovery dependencies against the same Node SQLite executor/database and provide
  `recoveryStore`/`historyFor` for `defaultCore`, or introduce an equivalent core-supported root
  capture assembly that does not silently disable root recording.
- Add an integration-style CLI test which starts a root execution boundary and proves the injected
  rollout driver's `append` happens before the model request. Merely calling `reconcile()` during
  assembly is insufficient evidence.

This repair likely needs owner expansion to the CLI package manifest and/or the SQLite persistence
assembly; it cannot be completed honestly inside the current 080 owner list alone.

### Critical — source corruption does not block Web or CLI startup

The comments in `apps/web/src/main.tsx:139-144` and `apps/cli/src/runtime.ts:137-139` claim that
corruption rejects reconciliation. The actual driver does the opposite:
`packages/host-node/src/rollout/service.ts:156-170` catches every identity, codec, ordinal, file-read,
and projector error and returns it as a history warning. Unterminated JSONL is also returned directly
as `ROLLOUT_PARTIAL_LINE` by the projector. Web logs every warning and proceeds; CLI discards the
entire reconcile result and proceeds.

This violates the explicit execution fence. It also means a corrupt source can coexist with new
agent execution; corruption before an otherwise valid tail may be followed by further appends because
the append pre-reconcile failure is downgraded to a projection warning.

Required repair:

- Give reconcile failures a machine-readable source-vs-projection classification. Source identity,
  malformed/oversized/unterminated JSONL, ordinal gaps, and source I/O must be fatal; a derived SQLite
  projection failure may remain a reportable warning.
- Make both Web and CLI reject startup on the fatal class, while retaining/reporting projection-only
  warnings.
- Add Web and CLI startup tests for both branches: fatal source corruption prevents hydrate/new
  session/model execution; projection-only warning permits startup.

This requires reopening/expanding the 050 service owner; parsing warning message text in 080 is not an
acceptable protocol.

### Important — normal CLI completion does not await registered disposers

Signal shutdown does await all registered disposers, but it is the only drain path.
`apps/cli/src/shutdown.ts:84-89,144-146` exposes registration only, and
`apps/cli/src/bootstrap.ts:86-99` returns from print/REPL mode after only unsubscribing the renderer.
No disposer or rollout `flush()` is awaited on normal completion. This matters because `run_end` is
emitted synchronously when terminal state is patched, before some final fire-and-forget recovery
writes necessarily settle.

Required repair:

- Expose one idempotent orderly drain from the CLI shutdown owner and await it in the normal
  `bootstrap.ts` `finally`, while retaining the bounded signal path.
- Test both normal return and signal shutdown with a pending rollout flush.

This needs owner expansion to `apps/cli/src/bootstrap.ts`, `apps/cli/src/shutdown.ts`, and their tests.

### Important — CLI constructs two Node rollout services for the same files

`configureCliHostBridge()` calls `createNodeHostInvoke()`, whose route assembly constructs a rollout
driver at `packages/host-node/src/createNodeHostInvoke.ts:135-142`. The CLI then constructs a second
direct driver at `apps/cli/src/runtime.ts:128-135`. They have separate queues/stores but point at the
same JSONL root and SQLite executor. The changed test explicitly codifies three disposers
(`apps/cli/src/runtime.test.ts:106-115`): MCP plus two rollout flushers.

The cross-process lock/dedupe makes immediate duplicate writes unlikely, and root/child currently use
the direct instance, but dual ownership is unnecessary and makes command-path and direct-path
lifecycle/reconcile state diverge. Construct one direct driver and inject that same instance into both
the host rollout routes and core, or allow CLI host assembly to omit rollout routes if they are truly
unreachable. Add an identity/count assertion proving one rollout service/disposer.

This also requires a small 050 host assembly owner change.

### Important — the new CLI tests are not isolated from real user data and do not test the acceptance ordering

`apps/cli/src/runtime.test.ts:35-49` supplies only a temporary workspace. Production assembly resolves
SQLite from the real `homedir()` (`runtime.ts:127-133`), opens that database, and reconciles the real
application-data rollout tree in every test. Cleanup resets only the host bridge and workspace; it
does not reset core persistence, flush the created rollout instances, or close the SQLite connection.
The tests can therefore mutate a developer's projection, fail because of their local source state, and
leak singleton state within the file.

The Web entry test also mocks `createHostPersistenceDrivers()` as `{}`
(`apps/web/src/main.serverHost.test.tsx:39-40`), so it never proves reconcile-before-hydrate or the
corruption fence. The CLI test proves only host bridge behavior and that three arbitrary disposers can
be called; it never observes reconcile relative to agent execution or identifies the rollout flush.

Required repair:

- Add an injectable absolute database/app-data path or driver factory for assembly tests and keep all
  files under a per-test temporary directory.
- Dispose/reset core persistence and all created resources after each test.
- Replace count-only assertions with ordered probes for reconcile -> execution and execution -> flush.
- Add the relevant Web entry test file to the 080 owner list so the startup fence is actually covered.

## Acceptance assessment

- ✅ Server adapter preserves append/reconcile payloads/results and host rejection.
- ✅ Server Web creates one browser adapter; root/child resolve the same core-injected dependency.
- ❌ CLI root and child do not both use rollout because root recording is disabled.
- ❌ Source corruption does not block Web/CLI execution.
- ❌ CLI tests do not prove reconcile-before-execution or normal shutdown flush.
- ✅ Static persistence bundle has no rollout driver and leaves IndexedDB recovery selection intact.
- ✅ HTTP driver `flush()` as a no-op is valid: each HTTP append already awaits the server-side durable
  operation, and the Node server registers its actual rollout driver's flush disposer.
- ✅ Directed tests pass: 10/10.
- ✅ Additional lifecycle/main/service tests pass: 21/21.
- ✅ `pnpm exec tsc -b`, `pnpm check:boundaries`, and `git diff --check` pass.
- ✅ All 080 owner files are under 300 physical lines; the largest is `main.tsx` at 241 lines.

Passing tests do not clear the findings above because the missing assertions and real-user-data setup
are exactly why the defective lifecycle paths stay green.

---

## R1 independent review

VERDICT: FAIL

R1 correctly fixes four of the five original product defects: the CLI now creates a real
`RecoveryWriter`, Web/CLI block typed source warnings while allowing projection warnings, host routes
and core share one driver, and runtime tests use a temporary absolute database with reset/close
cleanup. The remaining shutdown implementation is not a reliable durability boundary.

### Important — `CliShutdown.drain()` silently loses failures and late registrations

`apps/cli/src/shutdown.ts:111-114` snapshots the disposer array on the first call, wraps it in
`Promise.allSettled()`, discards every rejection, and permanently caches the fulfilled `Promise<void>`.
Two consequences were reproduced directly against the implementation:

```text
register A -> drain -> register B -> drain: B calls = 0
register rejecting flush -> drain: rejected = false
```

Thus normal CLI completion can exit successfully after a rollout/recovery flush failure, and a
disposer registered after draining begins is silently accepted but never run. Signal shutdown needs
to continue exiting after cleanup errors, but that does not justify hiding the same errors from the
normal `await shutdown.drain()` path.

Required repair:

- Await every disposer and reject normal drain with the single error or an aggregate after all have
  settled. The signal handler must explicitly handle both fulfillment and rejection before exiting.
- Close registration when drain starts and reject a late registration, or add it to the active drain
  in a way that the already-returned promise really waits for it. It must not be silently dropped.
- Add tests for a rejecting normal drain, signal exit despite rejection, idempotent repeated drain,
  and late registration.

### Important — recovery tail and rollout flush are not one ordered shutdown operation

`assembleCliPersistence().flush()` has the correct order: await `core.persistence.flushRecovery()`
first, then `agentRollout.flush()`. Production shutdown does not register that operation. Instead,
`apps/cli/src/runtime.ts:132-135` registers the recovery tail separately and lets
`createNodeHostInvoke()` register the rollout flush; `drain()` starts all three disposers concurrently.

If a queued recovery capture has not entered the rollout driver's queue when the rollout disposer
samples it, that flush can finish before the capture appends. The recovery tail still waits for the
append's strong write, but an append failure is converted to a `RecoveryWriteOutcome {status:'error'}`;
without the later ordered driver flush, the store's recorded failure can be missed, and the current
`allSettled` then hides every remaining error anyway.

Required repair:

- Register one CLI persistence disposer that calls the existing ordered `persistence.flush()`.
- Prevent host route assembly from registering a second rollout disposer when the injected driver is
  lifecycle-owned by that composite. MCP remains its own disposer.
- Assert the production disposer order `recovery tail -> rollout flush`, not only a direct manual call
  to `persistence.flush()`.

### Important — bootstrap does not drain when assembly/reconcile fails

`apps/cli/src/bootstrap.ts:75-84` awaits `assembleCliRuntime()` before entering its `try/finally`.
A source-warning rejection correctly blocks `newSession()` and execution, but it also bypasses
`shutdown.drain()` after SQLite/core persistence and all three disposers have already been assembled.
Move assembly inside the guarded lifetime and make renderer cleanup optional so startup failure also
drains. Add a bootstrap test where assembly rejects and drain is still awaited without replacing the
primary failure accidentally.

### Important — the CLI acceptance test still does not observe agent execution

The new runtime test asserts `['reconcile', 'root-append', 'flush']`; it calls
`persistRecovery()` directly and contains no model/run-loop execution probe. Core tests separately
prove that a root append failure blocks `startModelRun()`, but R1's explicit test gate requires the
CLI assembly test itself to observe `reconcile -> root append -> agent execution -> flush`. Use
`startModelRun()` with a probe run loop (or an equivalent CLI execution seam), and retain the driver
identity assertion for the child path.

## R1 acceptance assessment

- ✅ CLI configures real recovery plus `recoveryStore`; root capture now creates a `RecoveryWriter`.
- ✅ Root and child obtain the same core-injected rollout driver.
- ✅ Typed source warnings block Web/CLI startup; projection warnings report and continue.
- ✅ Web corruption test rejects before hydrate, `newSession`, or render.
- ✅ Host rollout routes and core share one injected driver instance.
- ✅ Runtime tests use temporary SQLite/app-data, reset core, close connections, and remove files.
- ✅ Static Web retains IndexedDB and never creates a rollout adapter.
- ❌ Normal/signal shutdown do not yet provide an ordered, error-reporting durability drain.
- ❌ Assembly failure bypasses the CLI drain.
- ❌ The required CLI `reconcile -> execution -> flush` observation is still absent.
- ✅ 15 targeted/related test files pass: 70 tests.
- ✅ `pnpm exec tsc -b`, `pnpm check:boundaries`, `pnpm check:state`, and `git diff --check` pass.
- ✅ All reviewed owner and supporting 050 files remain below 300 physical lines.

---

## R2 independent review

VERDICT: PASS

R2 closes every R1 lifecycle finding. No product-code blocker remains.

### Shutdown semantics

- `apps/cli/src/shutdown.ts:112-121` caches one drain promise, closes registration before invoking
  disposers, waits for all settlements, rethrows the sole reason unchanged, and aggregates multiple
  reasons. Repeated calls therefore observe the same fulfilled/rejected result; registration after
  drain starts rejects at lines 160-163.
- `apps/cli/src/shutdown.test.ts:65-100` reproduces normal-drain-then-signal sharing, stable rejection,
  late-registration rejection, aggregate rejection, and signal exit after drain failure. Lines
  117-135 retain immediate second-signal exit; the timeout/stuck-disposer branch also exits once.
- A first signal after normal drain has started calls the cached promise and waits for it; a second
  signal bypasses that wait. Both signal fulfillment and rejection explicitly reach `exitOnce()`.

### CLI ownership, startup, and execution fence

- Production registers exactly two disposers: the ordered persistence composite at
  `apps/cli/src/runtime.ts:131-137`, then MCP cleanup. The host receives the same driver as `borrowed`,
  so `packages/host-node/src/createNodeHostInvoke.ts:135-146` does not register another rollout flush.
  A borrowed lifecycle without an injected driver rejects; the default remains host-owned.
- `apps/cli/src/persistence.ts:63-66` strictly awaits recovery-tail flush before rollout flush.
  Host routes close over the injected driver, while root recovery and child recording both obtain it
  from the same core persistence dependencies.
- `apps/cli/src/bootstrap.ts:72-113` installs lifetime management before assembly. Assembly/reconcile
  failure still drains; drain success preserves the primary error, while a simultaneous drain failure
  yields an `AggregateError` whose cause and first error are the primary failure.
- `apps/cli/src/runtime.test.ts:136-159` crosses the real `startModelRun` fence and observes exactly
  `reconcile -> root append -> model loop -> recovery flush -> rollout flush`. It also asserts two
  production disposers and driver identity. Its SQLite/app-data paths are absolute temporary paths;
  after each test it flushes, resets core/bridge singletons, closes SQLite, and removes both roots.

### Web/static regression and durability

- Server Web reconciles before recovery hydrate/new-session/render. The entry corruption test proves
  a typed source warning rejects all three; the server-host test proves a projection warning continues
  and reconcile precedes hydrate.
- Static persistence constructs only IndexedDB drivers and never constructs the server rollout
  adapter. The HTTP adapter's no-op `flush()` is valid: it has no client write queue, and each append
  awaits the server durability operation; the owned Node server driver remains the actual queue drain.

### Verification and documentation note

- Exact related suite: 15 files, 81 tests passed. `pnpm exec tsc -b`, `pnpm check:boundaries`,
  `pnpm check:state`, and `git diff --check` passed.
- All 18 source/test owners are below 300 lines; largest is `apps/web/src/main.tsx` at 240 lines.
  Reviewed changes retain one responsibility per added assembly/lifecycle file and stay within the
  task's 20-file owner set (including the package manifest and lockfile).
- Minor documentation correction requested: `reports/080-report.md:13-14` is stale R1 text claiming
  separate host rollout and root-tail disposers, contradicting the correct R2 description at lines
  17-18 and the implementation. It should be removed or rewritten, but does not block the product PASS.
