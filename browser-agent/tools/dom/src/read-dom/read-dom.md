# read_dom

Read visible DOM nodes from the bound top document. Start without `page`, then preserve the returned `PageRef` and opaque refs. Use `scopeRef`, `selector`, or `text` to narrow a later read; filters scan the bounded document rather than only the first result page. Reading is passive and never opens a popup. Passwords, hidden inputs, hidden ancestors, scripts, styles, and arbitrary attributes are excluded. Use pagination when `truncated` is true.
