# Browser extension

New conversations first choose an Agent, a target tab and an optional conversation title. The
extension verifies the selected tab's URL and document before creating the session, then waits
for the binding to be persisted. Failure rolls back the new session. Cancel creates no history.

The target belongs to the conversation; switching the active browser tab does not retarget it.
The chat header shows a compact page summary with reveal and explicit rebind actions. History
includes the bound page title and site. Closed, navigated and inaccessible pages retain their
last selected metadata and block further sends; active runs stop when their target becomes
unavailable. Same-URL reloads while the sidepanel is open reconnect with fresh DOM references
and session capture cursors. A changed URL requires an explicit rebind, even after navigating
back. Restoring a different document after the sidepanel was closed also requires rebinding.

Page selection uses existing host and active-tab permissions, without adding `tabs` permission.
Chrome hides metadata for inaccessible tabs; these remain identifiable by window/tab position.
Grant website access by opening the plugin on a normal webpage, then refresh the page list.
Browser-internal pages cannot be bound. The generic UI only depends on `SessionPageHost`;
Chrome API calls and binding persistence stay in the extension.

The extension installs its isolated page bridge and MAIN-world fetch/XHR recorder at `document_start` for granted HTTP(S) origins. When the worker starts, the extension is installed or updated, the browser starts, or website access is granted, it also injects both scripts into already-open authorized top-level tabs. Restricted, closing, or navigating tabs fail independently.

The recorder starts when `network-main.js` is injected and keeps at most 100 requests with at most 32 KiB per safe body for the current document lifetime. Capacity eviction is reported through `droppedCount`. It cannot recover traffic from before injection and does not observe images, stylesheets, navigation resources, WebSocket, workers, service-worker internals, or other frame realms.

`list_network_requests` can read the automatic document buffer without a `captureId`. Its result identifies `scope: "document"`, reports `recordingStartedAt`, and returns a `captureId` for later request/response detail reads. `start_network_capture` creates an optional session-owned filter view; stopping that view does not stop document recording.

Reload an already-open target page after updating from an older extension build when page-reading bridge behavior also changed. The network MAIN entry has its own versioned lifecycle and replaces an older gateway once while preserving the buffer on repeated injection of the same version.
