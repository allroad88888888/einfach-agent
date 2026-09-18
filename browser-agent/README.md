# Browser Agent packages

`@einfach-agent/browser-agent` is the headless configuration and runtime package. It owns Agent, Skill, connection, credential, session binding, and IndexedDB persistence for one namespace. Optional UI, extension, page-tool, and API-tool packages are separate consumers.

## Load the extension

Build the published dependency closure first, then build the application:

```sh
pnpm -r build
pnpm --filter @einfach-agent/browser-extension build
```

Open `chrome://extensions` or `edge://extensions`, enable developer mode, choose **Load unpacked**, and select `browser-agent/extension/dist`. The unpacked directory is self-contained and does not need a Node server or development server. Click the extension action to open its side panel.

The extension requests access to a page origin only when a new session binds the active tab. Permission refusal, browser-internal pages, missing content scripts, navigation, and a replaced document are reported as target errors. A session stays pinned to the tab, top frame, and document generation captured at creation. Switching tabs does not move it. Cross-origin iframes, closed shadow roots, arbitrary third-party component frameworks, and final form submission are outside the first release.

The side panel owns the browser-agent client, model transport, credentials, and run state. The service worker only validates and routes messages. Content scripts receive page operations and opaque session IDs; they never receive model keys. Closing the panel stops active runs. Reopening hydrates core state and revalidates stored target metadata against the live document. An interrupted write with no reply remains unknown and is not replayed. Conversation undo does not undo changes already made to a web page.

## Embed without the UI package

`browser-agent/examples/embedded` is a private workspace example with two independent namespaces and customer-owned DOM. Its package does not depend on React, the optional UI package, or Chrome APIs. The essential assembly is:

```ts
const pageHost = createDomPageHost({ document, targetId: 'customer-form' })
const apiHost = createApiToolsHost(sources, {
  isSourceAllowed: (sourceId, sessionId) => authorization.allows(sessionId, sourceId),
})
const client = await createBrowserAgent({
  namespace: 'customer-workspace',
  registerTools(registry) {
    registerPageTools(registry, pageHost)
    registerApiTools(registry, apiHost)
  },
})
```

Create `OptionsSource` adapters in trusted host code. Each adapter maps a fixed source ID to a fixed request builder and response mapper. Derive authorization from the bound session in `isSourceAllowed`; do not let model arguments supply URLs, headers, or scripts. For an existing signed-in API, make a same-origin request or use a narrowly scoped server endpoint. Do not copy all browser cookies to another origin. CSP, CORS, and authentication failures remain visible failures.

Native form controls work through the default DOM host. Register a `ControlledFieldAdapter` for a customer component: `matches` identifies the control, `read` exposes safe field metadata, `write` applies a value and honors the abort signal, and optional `validate` returns its current validation error. Password and hidden inputs are not exposed; unsupported controls remain visible as unsupported outcomes.

Build the standalone example with `pnpm --filter @einfach-agent/example-embedded build`, then serve its `dist` directory from any static HTTP server. The fixture uses deterministic local model responses and fixed option data only. It proves the integration path, not compatibility with an arbitrary customer site or real customer API.

Chrome MV3 is the automated development target. Microsoft Edge uses the same MV3 manifest but requires a separate release compatibility check; it has not been inferred from a Chromium result.
