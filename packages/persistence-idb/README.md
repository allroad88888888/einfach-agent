# @einfach-agent/persistence-idb

An IndexedDB session and history persistence driver for the `@einfach-agent/core` persistence
contract.

Current recovery records contain the matching undo ledger in the same IndexedDB value and commit
it atomically. The separate history-log store remains readable for migration from older records;
new recovery generations do not depend on a second asynchronous write.

This package is part of the [Einfach Agent](https://github.com/allroad88888888/einfach-agent)
workspace — see the main repository for setup, documentation and contribution guidelines.
