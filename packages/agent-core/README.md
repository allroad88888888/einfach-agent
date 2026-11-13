# @einfach-agent/core

The assembly kernel for agent runtimes: the tool contract and registry, the main loop, plugins,
and the observability/persistence contracts, checkpoints and state atoms — no concrete tool
domains or host drivers.

Session transaction history has no application-level count or age limit. Einfach's incremental
persistence port records new operations; the host appends immutable batches to a local JSONL journal
(or IndexedDB for static Web). Recovery format 2 stores the exact journal head and undo barrier,
after confirming those batches are durable. Recovery replays that head's chain, never an uncommitted
file tail. Older recovery formats and whole-ledger records are not migrated or read as fallbacks.

This package is part of the [Einfach Agent](https://github.com/allroad88888888/einfach-agent)
workspace — see the main repository for setup, documentation and contribution guidelines.
