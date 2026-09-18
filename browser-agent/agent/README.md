# Browser Agent runtime

`@einfach-agent/browser-agent` creates an isolated browser runtime for one namespace. The client owns its IndexedDB persistence and namespace lock.

Call `await client.dispose()` when the user intentionally closes the client and active runs should become `stopped`. This remains the default behavior and is equivalent to `dispose({ preserveRecovery: false })`.

For a host lifecycle event such as `pagehide`, use:

```ts
await client.dispose({ preserveRecovery: true })
```

This aborts process-local work, persists active runs as recoverable, retains queued input and paused confirmation or question state, flushes persistence, and then releases the namespace owner. A newly created client for the same namespace can inspect `core.getSessionRecoveryStatus(sessionId)` and call `core.continueRecoveredSession(sessionId)`. Unknown external tool outcomes remain fenced for reconciliation and are never replayed automatically.

If the recovery snapshot is not durably acknowledged, `dispose` rejects and retains namespace ownership so another client cannot overwrite uncertain state. The caller should surface or log that failure; repeated `dispose` calls return the same rejected promise.

The first `dispose` call chooses the shutdown mode. Later calls return the same promise, even when they pass different options.
