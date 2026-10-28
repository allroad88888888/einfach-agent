# 370 DOM tools implementation report

Status: DONE after R1

## R1 independent-review closure

The first independent review rejected the R0 candidate with three Important findings. R1 addresses all three without changing the public contract:

1. Every reentrant phase now rechecks abort, current document/PageRef, and the exact original Element before the next phase. A `pointerdown`, `input`, or `keydown` handler that aborts or removes/replaces the target stops the remaining sequence and rejects. A terminal `click` is allowed to remove a popup option after the one click has completed, while abort/navigation during that handler still rejects.
2. Disabled state now walks ancestors for `aria-disabled`, disabled native ancestors, and disabled fieldsets. The first direct legend subtree retains the native fieldset exception.
3. Added behavioral compatibility tests for an ARIA combobox expansion/selection/read-back flow and the existing page host's native select value/change behavior.

The orchestrator's related click-sequence requirement is also covered: the target realm's `PointerEvent` is used when available with `pointerType:'mouse'`, both `pointerdown` and `pointerup` are emitted, and focus occurs after an uncancelled `mousedown`. Every phase retains one exact click and a guard after page-controlled code.

## Delivered contract

- Added the pure-Web package `@einfach-agent/tools-browser-dom` under `browser-agent/tools/dom`.
- Exported the fixed public contract: `DomNode`, all six input/result interfaces, `DomToolsHost`, `createDomToolsHost`, `createDomTools`, `registerDomTools`, `isDomSnapshot`, and `isDomActionResult`. `PageRef` and `PageCallContext` are reused from the page package.
- Registered tools in the required order: `read_dom`, `click_dom`, `type_dom`, `press_dom_key`, `scroll_dom`, `wait_for_dom`. Every tool has a strict object schema, guide, implementation, and direct wrapper test.
- Exported `enqueueDocumentWrite` from the page package. The DOM package imports it as an external workspace dependency; the emitted JS retains the package import, so page and DOM operations share one `WeakMap<Document, Promise<void>>` queue rather than bundling a second queue.
- Updated the three page guides to route unsupported/non-exposed custom controls through read → observed ref → action → read-back verification, without claiming visible labels are undisclosed business values.

## Behavior and evidence

- `read_dom` returns stable per-Element refs, visible ordinary `div`/`span` nodes as well as native and ARIA controls, safe bounded text/value/attribute projections, pagination, scope refs, selector/text filtering, and an explicit error above the 100,000-node scan budget. Text filtering reaches targets near the end of ordinary long pages rather than filtering only a prefetched first page.
- Hidden ancestors, `hidden`, `aria-hidden`, `inert`, collapsed visibility, script/style/template/noscript, password inputs, and hidden inputs are excluded. The attribute allowlist omits event attributes, URLs, class/data payloads, and arbitrary HTML attributes.
- Actions require the exact previously observed ref and current `PageRef`. Unknown, removed/replaced, stale-page, detached-document, hidden, disabled/`aria-disabled`, readonly/`aria-readonly`, and unsafe text-input targets are rejected. Identity is never recovered by text matching.
- Clicking emits one pointerdown/mousedown/focus-if-allowed/pointerup/mouseup/click path on the original Element, allowing ordinary delegated handlers on non-ARIA candidates. Identity, connectivity, cancellation, document binding, and actionability are checked between reentrant phases. A result says only `dispatched:true`; guides require business-state read-back.
- Typing uses the target document realm's native value setter and dispatches `input` then `change`. Keyboard events explicitly remain untrusted and do not claim browser default behavior. Same-origin iframe documents use their own constructors, avoiding cross-realm `instanceof` failures.
- `wait_for_dom` polls at a bounded interval, enforces a 30-second maximum, supports present/absent, cleans timers on abort, throws a clear timeout, and never treats scan-budget exhaustion as absence.
- Result validators recursively validate `PageRef`, every node, optional nested attributes, strings, booleans, and actual node-count/string/attribute bounds.

Representative regression coverage includes an async body-mounted plain-span dropdown, search input filtering, selecting “安全漏洞”, final display read-back, same-name distinct refs, ARIA combobox selection behavior, native select/input behavior, same-origin iframe realm handling, replacement/stale/unknown refs, handler-time abort/replacement, inherited disabled state, fieldset/legend semantics, sensitive/hidden data, full pointer/mouse/focus order, pagination/tail filtering, timeout/absence, direct-call limits, and serialization with page `fillFields` through the shared document queue.

## Verification

- R0 `pnpm exec vitest run browser-agent/tools/dom/src browser-agent/tools/page/src`: **28 files, 71 tests passed**.
- R1 final same command: **29 files, 76 tests passed**.
- `pnpm --dir browser-agent/tools/page build`: passed; refreshed the declaration used by the new package.
- `pnpm --dir browser-agent/tools/dom build`: passed; tsup ESM build plus declaration generation and specifier fix.
- `pnpm exec tsc -p browser-agent/tools/dom/tsconfig.json --noEmit`: passed before the final combined run; the package build repeated declaration type-checking after final source changes.
- `git diff --check`: passed.
- R0 root `tsconfig.app.json` check reached a concurrent 380 consumer fixture inference error at `browser-agent/examples/embedded/src/main.ts:96`; it was reported immediately.
- R1 final `pnpm exec tsc -p tsconfig.app.json --noEmit`: passed after the concurrent consumer fix.

## File responsibilities and size check

All source/test files are below 300 physical lines. R1 TypeScript source and tests total 702 lines; the largest file is `dom-actions.ts` at 83 lines.

- `types.ts` (58): fixed public data/host contract only.
- `dom-host.ts` (37): document binding, observed identity map, phase guards, and queue orchestration.
- `dom-reader.ts` (47): bounded discovery, filtering, scoping, and pagination.
- `dom-node.ts` (47): safe DOM-to-contract serialization.
- `dom-visibility.ts` (27): ancestor visibility and inherited disabled/writable-state predicates.
- `dom-actions.ts` (83): guarded click/type/key/scroll event mechanics.
- `waiter.ts` (25): cancellable deadline polling.
- `page-binding.ts` (15): PageRef/current-document/abort guards.
- `validation.ts` (23): recursive result validators.
- `tool-support.ts` (8): shared schemas and tool error envelope.
- `register.ts` (13): ordered public tool creation/registration.
- Six tool implementation files (8 lines each), guides (3 lines each), and wrapper tests (5 lines each): one tool boundary apiece.
- Scenario tests: `dom-host.dropdown.test.ts` (36), `dom-host.safety.test.ts` (66), `dom-host.compatibility.test.ts` (23), `dom-host.read-wait.test.ts` (33), `dom-host.actions.test.ts` (25), `document-queue.test.ts` (16), `register.test.ts` (13).
- Package/build files and README provide the workspace package surface, external page dependency, declaration build, workflow, and limitations.

## Explicit boundaries

- Operates on the supplied top `Document`, or a same-origin iframe `contentDocument` explicitly supplied by the host. It does not cross cross-origin frames or closed shadow roots.
- Synthetic events have `isTrusted === false`; trusted gesture requirements, native privileged shortcuts, and guaranteed keyboard default actions remain outside scope.
- Reads do not open controls or infer remote/unrendered options. DOM display text is not converted into a hidden business value.
- Scan, result, string, input, scroll, and wait budgets are hard limits. Above the scan budget the tool asks the caller to narrow with `scopeRef` or `selector` instead of returning a misleading empty/absent result.
