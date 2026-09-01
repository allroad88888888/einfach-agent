# 090 R1 independent review

VERDICT: PASS

## Acceptance review

- ✅ 1. Dry-run performs no SQLite write. `--write` uses the exact five-table drop API and rebuilds all projection tables/state through the shared node rollout service.
- ✅ 2. Source preflight completes before the target executor is created. Framing, codec, path/history/target identity, empty source, line size, and ordinal failures include source file plus byte offset and leave the old DB and JSONL unchanged.
- ✅ 3. Absolute temporary/custom paths work. Canonicalized `/`, home, workspace aliases, and DB/rollout overlap are rejected before I/O.
- ✅ 4. `pnpm exec vitest run packages/host-node/src/rollout/sourcePreflight.test.ts scripts/agent-rollout-rebuild.test.js` passes: 2 files, 17 tests.
- ✅ 5. `pnpm agent-rollout:rebuild -- --help` exits 0 and matches the documented options and safety behavior.
- ✅ 6. All task-owner files are below 300 physical lines. The script is 116 lines; its test is 107; the preflight implementation is 88; the source catalog is 44; their tests are 65; documentation is 47.

No Critical, Important, or Minor finding remains in the reviewed scope.

## R0 finding closure

### ✅ Corruption is rejected before projection destruction

`scripts/agent-rollout-rebuild.js` calls `discoverCanonicalRolloutSources` and `preflightRolloutSources` before `createNodeSqlExecutorLoader`. The bounded preflight validates every complete record against its canonical path/history/target and exact zero-based ordinal.

The expanded script test seeds a valid DB, corrupts the source with first identity mismatch, later identity/target drift, nonzero start, duplicate/gapped ordinal, unterminated line, and oversized line, then verifies:

- the command rejects with the source path and byte offset;
- JSONL bytes are unchanged;
- target DB bytes are unchanged;
- all five pre-existing projection table snapshots are unchanged.

Manual R1 reproduction replaced a valid source with a codec-valid ordinal-1 record. It failed at byte 0 before DB open; SHA-256 for both DB and JSONL stayed unchanged, and the original catalog row remained present.

Empty, malformed-codec, and post-discovery missing-file cases were also exercised manually. Each returned `corrupt rollout source at <file>:0: <detail>`.

### ✅ Exact schema deletion preserves other tables

The script calls public `dropRolloutProjectionSchema`; it no longer discovers tables by prefix. The regression test proves both `agent_rollout_future_keep` and `unrelated_keep` survive a successful rebuild. The manual ordinal-failure reproduction also retained the future sentinel. Documentation now describes the exact current projection set rather than prefix deletion.

### ✅ Validation memory is bounded

`sourcePreflight.ts` reads fixed-size chunks, caps the pending line at `AGENT_ROLLOUT_MAX_LINE_BYTES`, and never retains the whole append-only source. The multi-chunk test uses 7-byte chunks, and the oversized-line test uses 31-byte chunks and rejects at the correct source offset.

### ✅ Canonical path safety and source/DB separation

`canonicalize` resolves existing symlinks and walks to the nearest existing parent for missing paths. Resolved aliases of `/`, home, and workspace are refused. Bidirectional containment rejects a DB equal to, inside, or containing the rollout root. Tests cover workspace/home aliases plus a missing DB below a rollout symlink and prove no file is created.

### ✅ Public entry and source discovery remain single-authority

The script imports only `packages/host-node/src/index.ts` for app-data resolution, source discovery, preflight, exact projection drop, SQLite loading, service reconciliation, and connection close. Both the service and rebuild command use `discoverCanonicalRolloutSources` from `sourceCatalog.ts`, eliminating the previous duplicated discovery logic. Codec and path identity rules are consumed from their public/shared owners rather than copied into the script.

## Verification evidence

- `pnpm exec vitest run packages/host-node/src/rollout/sourcePreflight.test.ts scripts/agent-rollout-rebuild.test.js` → 17 passed.
- `pnpm exec vitest run packages/host-node/src/rollout/service.test.ts packages/host-node/src/rollout/projectionSchema.test.ts packages/host-node/src/rollout/projector.test.ts packages/host-node/src/rollout/jsonlStore.test.ts` → 23 passed.
- `pnpm agent-rollout:rebuild -- --help` → exit 0.
- `pnpm exec tsc -b` → passed.
- `pnpm check:boundaries` → passed.
- `pnpm check:state` → passed.
- `git diff --check` → passed.
- Manual checksum check: semantic-corruption failure preserved DB and JSONL SHA-256; dry-run preserved a pre-existing opaque DB byte-for-byte.
