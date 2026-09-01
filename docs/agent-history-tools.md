# Agent history tools

The four read-only tools expose agent histories stored on the same machine:

- `list_agent_histories` lists root and child histories.
- `list_agent_history_items` lists summaries for one exact history.
- `read_agent_history_item` reads stable JSON text for one materialized item.
- `search_agent_histories` searches indexed history text.

There is no per-agent ACL. Root agents and all three child profiles can read every history available
to the current local host. Tool input contains logical root/child IDs only; the runtime binds the
current workspace path privately for legacy lookup.

## Sources

Append-only JSONL is canonical evidence. SQLite is the rebuildable read model, and FTS is a derived
search index. A global list or search reads only the canonical local SQLite catalog or FTS index.
When an exact target has no canonical catalog entry, the provider may read that target's old root
recovery snapshot or child trace. Such results carry `LEGACY_PARTIAL_HISTORY`; they are not a global
filesystem scan and may be incomplete.

CLI and server Web use the local provider. Static Web has no host adapter, so the tools return
`AGENT_HISTORY_UNAVAILABLE` rather than an empty success.

## Paging and failures

Cursors are opaque and bound to the operation, target, and filters. Reuse the returned cursor
without editing it. List/item pages accept at most 100 records, search pages 50 hits, search queries
1,000 Unicode code points, and item reads 20,000 code points. A complete result envelope is bounded
to 100,000 characters; `OUTPUT_TRUNCATED` means continue from its cursor or offset.

Keep returned warnings with the result. Source corruption fails closed with
`AGENT_HISTORY_SOURCE_CORRUPT`; projection or search-index lag remains a warning. Invalid or stale
cursors, missing histories, missing items, and deleted items have distinct stable error codes.
