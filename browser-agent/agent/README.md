# Browser Agent runtime

`@einfach-agent/browser-agent` creates an isolated browser runtime for one namespace. The client owns its IndexedDB persistence and namespace lock.

The runtime registers the existing `ask_user_question` tool from `@einfach-agent/tools-interaction`.
Select it in an Agent's tools before creating a session. Questions pause that session through
the core; the optional UI renders its existing decision card and resumes with the submitted
answers. Existing sessions keep their original tool selection. Other interaction tools are not registered.

`client.createSession(agentId, { title })` accepts an optional title. A nonblank title is trimmed
and limited to 48 Unicode code points; leaving it blank preserves core naming from the first
user message. The exported `SessionPageHost` contract lets an embedding host supply page
selection, binding and status to the optional UI. It has no Chrome or React dependency.

Call `await client.dispose()` when the user intentionally closes the client and active runs should become `stopped`. This remains the default behavior and is equivalent to `dispose({ preserveRecovery: false })`.

For a host lifecycle event such as `pagehide`, use:

```ts
await client.dispose({ preserveRecovery: true })
```

This aborts process-local work, persists active runs as recoverable, retains queued input and paused confirmation or question state, flushes persistence, and then releases the namespace owner. A newly created client for the same namespace can inspect `core.getSessionRecoveryStatus(sessionId)` and call `core.continueRecoveredSession(sessionId)`. Unknown external tool outcomes remain fenced for reconciliation and are never replayed automatically.

If the recovery snapshot is not durably acknowledged, `dispose` rejects and retains namespace ownership so another client cannot overwrite uncertain state. The caller should surface or log that failure; repeated `dispose` calls return the same rejected promise.

The first `dispose` call chooses the shutdown mode. Later calls return the same promise, even when they pass different options.

The runtime keeps the full in-session transaction ledger and stores it inside each recovery
snapshot. After recreation, any user turn whose validated ledger was persisted remains precisely
undoable. An older snapshot whose former capped ledger is already missing can restore state, but
the client does not fabricate the lost inverse operations.

`await client.deleteSessions(ids)` removes the specified conversations through the core's
session removal command and waits for persistence to flush. It retains Agent profiles, skills,
model connections and credentials, and does not reverse actions already performed on a webpage.

Text attachments are prepared in the runtime, independently of React or Chrome. Embedded clients
can call `addTextAttachments([], files)` with browser `File` objects, then send
`client.core.sendMessage({ text, files: attachments }, { sessionId })`. Selection keeps local blobs;
send validates and decodes their text before core commits the message. Rejection commits nothing.
Accepted messages persist extracted text and file metadata, so `restoreTextAttachmentDraft(content)`
can reconstruct a sendable draft after undo or reload. Limits and supported formats are documented
in the UI README.

The runtime also registers `paddle_ocr` from the independent `@einfach-agent/tools-browser-ocr`
package. Configure its separate credential with `client.saveOcrToken(token)` (empty string removes
it), select the tool in the Agent profile, then create a session. Public snapshots expose only
`ocr.credentialConfigured`; the token is never passed to the model or page content scripts.

PDF/image attachments use the same file-selection API. Bytes are stored in a namespace- and
session-scoped IndexedDB store; the model receives a file ID and metadata. The OCR tool uploads
the file only when invoked. Reload and undo preserve the file reference. `client.deleteSessions`
also deletes binary attachments; undo and compaction never evict them. Embedding hosts should
delete conversations through this client method. Word documents must first be exported as PDF.

`ocrFetch` is a separate optional transport, independent of model `fetch`. Ordinary web hosts need
a suitable server relay because the OCR API and result storage do not allow arbitrary-origin
CORS. The extension declares narrowly scoped service host permissions and performs requests in
the side panel. Credentials are stored in browser IndexedDB, like the existing model credentials,
not in the OS keychain.
