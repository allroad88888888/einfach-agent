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

The complete browser-tool catalog contains eleven page/form tools, six DOM tools, six network observation tools, and two Skill tools, for twenty-five model-visible tools. The DOM tools are `read_dom`, `click_dom`, `type_dom`, `press_dom_key`, `scroll_dom`, and `wait_for_dom`. Read tools inspect the bound document; every mutation continues to require its exact `PageRef` and a ref returned by an earlier DOM read. Existing Agents keep their saved tool selection and existing sessions keep their frozen capability set. Select the DOM tools in the Agent editor and create a new session to use them.

The extension does not register demonstration option sources. Production hosts can register their own authorized API sources; the local UI and embedded fixtures retain fixed sample sources solely for testing. DOM events are synthetic (`isTrusted === false`), so sites that require trusted browser input may reject them. The first release covers the top document, or a same-origin iframe document explicitly supplied by an embedded host. Cross-origin iframes and closed shadow roots remain outside this contract.

Network observation covers `fetch` and `XMLHttpRequest` made by the bound window after the recorder is injected. Installing the recorder before creating the Agent lets a later capture include requests made before the conversation starts; requests made before injection cannot be recovered. The recorder keeps at most the most recent 100 requests for five minutes by default, while each capture session also expires after five minutes. It observes sanitized request and response data without replaying traffic. Previous documents, other frames, workers, and WebSockets are not covered. In the extension, an already authorized origin is injected at `document_start`; granting an origin for a page that is already open requires a refresh to cover its initialization traffic. Unauthorized sites are never recorded automatically.

To inspect the optional UI fixture without a model credential, run `pnpm exec vite --config browser-agent/ui/tests/fixture.vite.config.mjs` and open `http://127.0.0.1:4178/fixture.html?scenario=configured`. The fixture clearly marks its model response as simulated and must not receive a real API key. It provides two demonstration model IDs and an isolated same-origin business iframe; its tools cannot read or modify the Agent configuration form. Add `&width=360` to constrain the mounted product view to a 360-pixel container while keeping the browser window wide.

## Embed without the UI package

OCR is available in the independent `tools/ocr` package and registered by the runtime. Configure
its token under **Settings → 工具服务**, select `paddle_ocr` in the Agent, and create a new session.
PDF/image attachments are stored per conversation and uploaded only when the tool runs.
The extension has fixed fetch permissions for the PaddleOCR API and its verified result bucket;
these service permissions never enable page/network recorder injection on those service origins.
See [OCR tool](tools/ocr/README.md) for input, limits, retry behavior and embedding transport requirements.

`browser-agent/examples/embedded` is a private workspace example with two independent namespaces and customer-owned DOM. Its package does not depend on React, the optional UI package, or Chrome APIs. The essential assembly is:

```ts
const pageHost = createDomPageHost({ document, targetId: 'customer-form' })
const recorder = installWindowNetworkRecorder({ window }) // install before initialization traffic
const networkHost = createWindowNetworkHost({ window, targetId: 'customer-form' })
const apiHost = createApiToolsHost(sources, {
  isSourceAllowed: (sourceId, sessionId) => authorization.allows(sessionId, sourceId),
})
const client = await createBrowserAgent({
  namespace: 'customer-workspace',
  registerTools(registry) {
    registerPageTools(registry, pageHost)
    registerDomTools(registry, createDomToolsHost({ document, targetId: 'customer-form' }))
    registerApiTools(registry, apiHost)
    registerNetworkTools(registry, networkHost)
  },
})
// On unload: networkHost.dispose(); recorder.dispose(); client.dispose()
```

Create `OptionsSource` adapters in trusted host code. Each adapter maps a fixed source ID to a fixed request builder and response mapper. Derive authorization from the bound session in `isSourceAllowed`; do not let model arguments supply URLs, headers, or scripts. For an existing signed-in API, make a same-origin request or use a narrowly scoped server endpoint. Do not copy all browser cookies to another origin. CSP, CORS, and authentication failures remain visible failures.

Native form controls work through the default DOM host. It also exposes optional page text and semantic-table reads, field option discovery, waiting, exact option selection, and clearing through the same host boundary. Register a `ControlledFieldAdapter` for a customer component: `matches` identifies the control, `read` exposes safe field metadata, `write` applies a value and honors the abort signal, and optional `validate` returns its current validation error. Password and hidden inputs are not exposed; unsupported controls remain visible as unsupported outcomes.

For a non-native control, use `read_dom` to observe its visible trigger and opaque ref, `click_dom` to expand it, `wait_for_dom` or a scoped `read_dom` to observe asynchronously rendered candidates, then click the exact candidate ref and read the displayed value again. A dispatched click confirms event delivery only; the final read establishes the business result.

Build the standalone example with `pnpm --filter @einfach-agent/example-embedded build`, then serve its `dist` directory from any static HTTP server. The fixture uses deterministic local model responses and fixed option data only. It proves the integration path, not compatibility with an arbitrary customer site or real customer API.

Chrome MV3 is the automated development target. Microsoft Edge uses the same MV3 manifest but requires a separate release compatibility check; it has not been inferred from a Chromium result.
