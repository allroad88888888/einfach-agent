# 090 report

## R1 repair

- Extracted canonical JSONL source discovery and bounded source preflight into host-node rollout modules. The service now reuses discovery; the command invokes only public catalog, preflight, exact projection-drop, and service entry points.
- Preflight completes before SQLite is opened. It streams bounded chunks and rejects malformed framing, oversized lines, codec failures, canonical path/history/target drift, empty source files, and ordinal gaps/duplicates/nonzero starts with source file and byte offset.
- Replaced prefix-based table deletion with public `dropRolloutProjectionSchema`; future `agent_rollout_*` tables and unrelated tables are preserved.
- Canonicalized existing paths and nearest existing parents for missing paths. Symlink aliases of `/`, home, and workspace are refused; database and rollout tree must be disjoint.
- Updated the operator guide to describe exact projection-table rebuild behavior, path aliases, source/database separation, and preflight diagnostics.

## Verification

- `pnpm exec vitest run packages/host-node/src/rollout/sourcePreflight.test.ts scripts/agent-rollout-rebuild.test.js` — 17 tests passed.
- `pnpm agent-rollout:rebuild -- --help`
- `pnpm exec tsc -b`
- `pnpm check:boundaries`
- `pnpm check:state`
- `git diff --check`

All passed. Files added or substantially changed for this leaf remain under 300 lines.
