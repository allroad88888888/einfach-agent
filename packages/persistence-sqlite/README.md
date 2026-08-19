# @web-agent/persistence-sqlite

A SQLite session and history persistence driver for the `@web-agent/core` persistence contract.

The package holds no SQL runtime of its own: the host assembly layer injects one through
`configureSqlExecutor(loader)`, against the `SqlExecutor` port exported from
`@web-agent/core/state/persistence`. The Tauri desktop host injects the desktop SQL plugin;
other hosts inject their own executor.

This package is part of the [Einfach Agent](https://github.com/allroad88888888/einfach-agent)
workspace — see the main repository for setup, documentation and contribution guidelines.
