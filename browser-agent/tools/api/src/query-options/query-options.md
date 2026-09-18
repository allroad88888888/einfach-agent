# Query options

Use this tool only to read candidate values from a registered business source. Choose a
known `sourceId`; do not send URLs, credentials, request headers, or request methods.

Pass `query` for keyword search, `parameters` for a dependency such as a selected parent
field, and the returned `nextCursor` to get the next page. The result contains only
`label` and `value`; use `value` when a page field needs a machine value.

An empty `options` array is a valid result. When `truncated` is true, refine the query or
continue with `nextCursor` when it is present.
