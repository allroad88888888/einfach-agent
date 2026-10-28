# 270 eager network recording report

## Result

- Worker lifecycle synchronization registers future `document_start` scripts without unregistering semantically identical registrations, then injects ISOLATED and MAIN scripts into every already-open authorized HTTP(S) top-level tab. Per-tab failures are isolated.
- The extension MAIN recorder retains a bounded 100-request document-lifetime buffer with 32 KiB safe-body limits. It reports the real recorder start time, view scope, and capacity/age drop count.
- `list_network_requests` accepts no `captureId` and reads the already-running document buffer. The returned document-view ID supports subsequent request/response reads. A missing preinstalled recorder returns `NETWORK_RECORDER_UNAVAILABLE`; the first read never installs the hook.
- Explicit captures remain session-isolated filter views. Their `startedAt` is view creation time and `recordingStartedAt` is recorder installation time. Stopping one does not stop or hide the document view.
- MAIN reinjection uses a lifecycle version: same-version reinjection keeps the buffer; an older gateway is disposed and replaced once. Traffic from before the new recorder injection cannot be reconstructed.
- Every extension JavaScript bundle is wrapped in a private function scope. Chrome executes `scripting.executeScript({ files })` entries as classic scripts in MAIN/ISOLATED worlds; without this wrapper, a second evaluation redeclared bundled top-level `var` state and detached the existing gateway from its observer map.
- MAIN calls return a bounded success/error envelope. Chrome can otherwise turn a thrown MAIN-world error into a `null` scripting result; recorder failures now retain a specific extension response such as `NETWORK_RECORDER_UNAVAILABLE` instead of becoming `INVALID_NETWORK_RESULT`.

## Verification

- Network package: 14 files, 40 tests passed. Covers direct list before start, fetch response body readback, retention beyond five minutes, missing-recorder failure, simultaneous document/explicit views, stop isolation, limits, sanitization, XHR, timeout and cancellation.
- Extension: 7 files, 33 tests passed. Covers real MAIN wiring, old/same-version reinjection, bundle isolation, full handshake/network routing and error envelopes, already-open authorized tab injection, unauthorized exclusion, one-tab failure isolation, registration retry/equivalence, permission removal, native document pinning and transfer validation.
- `node browser-agent/extension/tests/network-main-classic-dist.mjs` first rebuilds the extension, then evaluates that fresh `dist/network-main.js` twice as a classic script in one JSDOM Window. After a fetch between evaluations it verifies gateway identity, direct document-list visibility, and response-body readback. Output: `classic dist reinjection passed: gateway, request, and response body survived`.
- `pnpm --dir browser-agent/tools/network build` passed.
- `pnpm --dir browser-agent/extension build` passed after the parallel page package build was ready.

`window-observer.ts` is 320 lines after a narrow lifecycle-statistics change to an existing 298-line strongly coupled fetch/XHR observer. Splitting its private observer state/pruning functions would make the single hook state machine harder to audit. New `host-input-validation.ts` is 51 lines; extracting it keeps `window-host.ts` at 279 lines.
