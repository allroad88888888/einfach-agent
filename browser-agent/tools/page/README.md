# `@einfach-agent/tools-browser-page`

Page-bound `read_form`, `fill_fields`, and `validate_form` tools with no React or Chrome dependency.

```ts
import { createCore } from '@einfach-agent/core/plugin'
import { createDomPageHost, registerPageTools } from '@einfach-agent/tools-browser-page'

const host = createDomPageHost({ document, targetId: 'content-script-target' })
const core = createCore({ registerTools: (registry) => registerPageTools(registry, host) })
```

An extension host implements `PageToolsHost` and binds each instance to its session target. `read_form` has no target argument. Writes and validation must receive the exact `PageRef` returned by a read. `revision` is a document-binding generation and changes only after navigation or rebinding, not ordinary DOM mutations.

The direct DOM host supports text inputs (password and hidden inputs are always excluded, including from adapters), textarea, select, multi-select, checkbox, and radio. Complex widgets are unsupported unless supplied through `controlledAdapters`. A `ControlledFieldAdapter` has `kind`, `matches(element)`, `read(element)`, `write(element, value, ctx)`, and optional `validate(element)`. Explicit adapters take priority over native handling, while native disabled/read-only state is still enforced. The write method receives the call's abort signal through `ctx`; the host checks cancellation, document identity, and field identity again after an asynchronous write.

Field IDs are opaque identities for the exact elements observed during `read_form`; replacing an element invalidates its prior ID. Labels are descriptive only and never used to select a write target. Hosts sharing a `Document` use one FIFO write queue; a failed batch does not block later batches, and queued cancellation is checked before mutation. Filling dispatches bubbling `input` and `change` events and compares the requested value with the actual value read back (multi-select arrays use set equality). A mismatch returns `ok:false` with the actual value. Validation never submits a form. Conversation undo cannot reverse external page changes.
