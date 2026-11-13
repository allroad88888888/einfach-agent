# Agent rollout storage

Agent rollout storage preserves model-history evidence independently from normal session recovery.

## Responsibilities

JSONL files are append-only source evidence. SQLite rollout tables are a disposable query projection rebuilt from those files. SQLite recovery format 2 remains the runtime recovery state. Atom undo operations use a separate append-only `history-journals/<session-hash>.jsonl` file, reusing the local durable-append primitive. These journals contain immutable batches linked by parent IDs; the snapshot commits the selected batch ID and undo barrier only after its append is durable. A failed snapshot write leaves an unselected branch, not a mismatched undo ledger. Neither journal is replaced by the model-history projection.

Server and CLI use the same application-data directory. Static Web has no local file driver and continues to use its existing IndexedDB/recovery behavior.

Default application-data locations are:

- macOS: `~/Library/Application Support/com.webagent.app`
- Windows: `%APPDATA%/com.webagent.app` (or `%USERPROFILE%/AppData/Roaming/com.webagent.app`)
- Linux: `$XDG_DATA_HOME/com.webagent.app`, falling back to `~/.local/share/com.webagent.app`
- A host custom data directory appends `com.webagent.app` to that directory.

The database is `web-agent.db`; sources are under `rollouts/conversations/`.

## Rebuild

Run a read-only inventory first:

```sh
pnpm agent-rollout:rebuild
```

Use `--write` only after taking the normal database backup. It drops only the current disposable projection tables: catalog, events, items, turns, and projection state. It then recreates them solely from JSONL; unrelated tables and future rollout tables are retained. It never writes, truncates, compacts, repairs, or deletes JSONL.

```sh
pnpm agent-rollout:rebuild -- --write
pnpm agent-rollout:rebuild -- --rollout-root /recovery/app-data/rollouts --database-path /recovery/app-data/web-agent.db --write
```

Both paths must be absolute. The command resolves symlinks before rejecting `/`, the user home directory, and the workspace root (including aliases). The database path must be disjoint from the rollout tree. `--rollout-root` must end in `rollouts`.

## Incident guide

If JSONL append succeeds but projection fails, preserve the source file and run the dry-run followed by `--write` against a backup or the intended application-data directory. A crash or an unterminated final line is reported as a warning by normal reconcile; do not edit the source in place. A malformed complete record makes rebuild fail with its file and byte offset; restore the source from the authoritative evidence backup before retrying.

For a stale lock, first confirm no process still owns the history. Live parseable lock owners are intentionally not stolen; stop that process or wait for it to exit. A malformed old owner or dead PID can be recovered by the normal lock path. Rebuild performs a bounded, read-only preflight before it opens the database; malformed framing, oversized lines, identity drift, and ordinal gaps report the source file and byte offset.

Deleting a session never deletes rollout JSONL or its projection. There is currently no rollout prune, delete, compact, or repair-source operation, so source disk use grows over time.

Recovery format 1 and embedded undo ledgers are no longer accepted; there is no migration or old undo-store fallback. Existing evidence files are not automatically deleted.

Search and history queries are a separate read layer; see [Agent history tools](./agent-history-tools.md).
Do not treat rollout projection tables as a stable public API.
