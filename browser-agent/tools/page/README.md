# `@einfach-agent/tools-browser-page`

Nine page-bound tools with no React or Chrome dependency:

- `read_page` and `read_table` read bounded visible content and semantic tables.
- `read_form`, `read_field_options`, and `wait_for_field` inspect page fields.
- `fill_fields`, `select_option`, and `clear_fields` update identified fields without submitting.
- `validate_form` checks fields without changing or submitting the form.

```ts
import { createCore } from '@einfach-agent/core/plugin'
import { createDomPageHost, registerPageTools } from '@einfach-agent/tools-browser-page'

const host = createDomPageHost({ document, targetId: 'content-script-target' })
const core = createCore({ registerTools: (registry) => registerPageTools(registry, host) })
```

An extension host implements `PageToolsHost` and binds each instance to its session target. `read_form` and `read_page` have no target argument. All identity-based operations must receive the exact `PageRef` returned by a read. `revision` is a document-binding generation and changes only after navigation or rebinding, not ordinary DOM mutations.

`readPage` and `readTable` are optional host methods for compatibility with existing custom hosts. A host without them registers the original three tools plus the four field tools (seven total). A complete DOM host registers all nine. The optional method contracts are:

```ts
readPage(input: PageReadInput, ctx: PageCallContext): Promise<PageSnapshot>
readTable(input: ReadTableInput, ctx: PageCallContext): Promise<TableSnapshot>
```

`read_page` limits visible body text to 12,000 characters by default and at most 20,000, excludes form values and hidden or executable content, and lists at most 50 tables. `read_table` reads at most 100 rows per call, 50 visible columns, and 500 characters per cell. Table identities are exact element identities and expire when a table is replaced.

The direct DOM host discovers controls in this order: native HTML controls (including controls outside a `form`), explicit ARIA/contenteditable semantics, then a constrained DOM fallback for a single labelled and focusable control root. The fallback excludes buttons, links, navigation, multi-control groups, and wrappers around native controls. Same-origin editable iframe bodies are read as one outer field; other iframe content is not traversed. Password and hidden inputs are always excluded, including from adapters, and parent text reads omit hidden and technical input content.

Unknown semantic and DOM controls are readable with `supported:false`; this does not imply `readOnly:true`. `readOnly` reflects disabled/readonly page state, while `supported` reports whether the host has a safe write implementation. Site- or component-specific behavior belongs in `controlledAdapters`. A `ControlledFieldAdapter` has `kind`, `matches(element)`, `read(element)`, `write(element, value, ctx)`, and optional `validate(element)`. Explicit adapters take priority over native and generic discovery, while native disabled/read-only state is still enforced. The write method receives the call's abort signal through `ctx`; the host checks cancellation, document identity, and field identity again after an asynchronous write.

Field IDs are opaque identities for the exact elements observed during `read_form`; replacing an element invalidates its prior ID. Labels are descriptive only and never used to select a write target. Hosts sharing a `Document` use one FIFO write queue; a failed batch does not block later batches, and queued cancellation is checked before mutation. Filling dispatches bubbling `input` and `change` events and compares the requested value with the actual value read back (multi-select arrays use set equality). A mismatch returns `ok:false` with the actual value. Validation never submits a form. Conversation undo cannot reverse external page changes.

Field labels prefer explicit ARIA and native label relationships, then a control `title`, then the single visible title in the nearest one-control form-item container. `name` and `placeholder` are fallbacks. Nearby inference is intentionally skipped for rows with multiple controls or nested forms so text from another field, help text, errors, and option labels is not reused as a field title.

Native select/datalist choices and options in an explicitly linked, already-rendered ARIA listbox/tree are read without interaction. `optionsStatus` distinguishes `exposed` (including a genuinely empty rendered list) from `not-exposed` (for example, a popup that has not rendered). `options` retains stable values; `optionLabels` carries display-only choices whose IDs are not present in the DOM. The host does not click controls, inspect framework-private state, request remote choices, or claim that rendered choices are the full remote dataset.
