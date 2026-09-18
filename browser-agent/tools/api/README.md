# @einfach-agent/tools-browser-api

This browser-safe package exposes one read-only `query_options` tool. A host registers
named `OptionsSource` adapters and decides authorization per trusted `ToolContext.sessionId`.
Models can select only a source ID and bounded search, filter, and cursor values; they never
provide a URL, headers, credentials, or request method.

```ts
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'

const host = createApiToolsHost([
  {
    id: 'cities',
    async query(input) {
      const all = [{ label: 'Paris', value: 'paris' }, { label: 'Lyon', value: 'lyon' }]
      return { options: all.filter((option) => !input.query || option.label.toLowerCase().includes(input.query.toLowerCase())) }
    },
  },
], { isSourceAllowed: (sourceId, sessionId) => sourceId === 'cities' && sessionId.startsWith('customer:') })

registerApiTools(core.tools, host)
```

`createApiToolsHost` accepts an optional host-only `timeoutMs` (10,000 ms by default, up to
120,000 ms). It covers the source call, HTTP request, and response-body read. On cancellation
or timeout the package aborts the adapter signal and rejects any later source result. Tool
errors use fixed messages by stable code, so adapter-provided error text never reaches the
model or UI.

For an HTTP system, keep its URL, credentials, and response mapping in an `OptionsSource`.
`createFetchOptionsSource` accepts a host-owned request function and a payload mapper; its
tests use a deterministic injected fetch fixture. The factory forwards cancellation to fetch,
maps authorization, timeout, rate-limit, service, JSON, and network failures to safe codes,
and never returns raw response bodies or headers.

```ts
import { createFetchOptionsSource } from '@einfach-agent/tools-browser-api'

const departments = createFetchOptionsSource({
  id: 'departments',
  request: ({ query, parameters }) => ({
    url: `/api/departments?q=${encodeURIComponent(query ?? '')}&company=${parameters?.companyId ?? ''}`,
    init: { headers: { Authorization: `Bearer ${credentialFromHost}` } },
  }),
  mapResponse: (payload) => {
    const body = payload as { rows: Array<{ name: string; id: string }>; next?: string }
    return { options: body.rows.map((row) => ({ label: row.name, value: row.id })), nextCursor: body.next }
  },
})
```

The returned candidates are directly suitable for a page tool's label/value field input.
An empty list is successful. Results are capped at 100 options and report `truncated: true`
when the host limits a response; adapters should return `nextCursor` for callers to continue.
