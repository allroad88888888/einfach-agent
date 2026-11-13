# @einfach-agent/persistence-idb

An IndexedDB session and history persistence driver for the `@einfach-agent/core` persistence
contract.

Recovery format 2 contains a reference to an immutable journal batch, not the complete undo ledger.
New operations append to the `historyJournal` store. Strict write transactions complete before the
matching recovery reference is committed. Restoring a snapshot follows only its selected batch chain;
older whole-ledger records are not read or migrated.

This package is part of the [Einfach Agent](https://github.com/allroad88888888/einfach-agent)
workspace — see the main repository for setup, documentation and contribution guidelines.
