# @einfach-agent/core

The assembly kernel for agent runtimes: the tool contract and registry, the main loop, plugins,
and the observability/persistence contracts, checkpoints and state atoms — no concrete tool
domains or host drivers.

Session transaction history has no application-level count or age limit. Recovery snapshots
atomically include the matching undo ledger, so a successfully restored snapshot can undo any
retained user turn. Logs already discarded by older releases or rejected as corrupt cannot be
reconstructed; those sessions recover their valid state without inventing an undo history.

This package is part of the [Einfach Agent](https://github.com/allroad88888888/einfach-agent)
workspace — see the main repository for setup, documentation and contribution guidelines.
