# 040 UI report

## Delivered

- `@einfach-agent/browser-agent-ui` exports the production `BrowserAgentView` from the package root and explicitly exports `styles.css`. The unused legacy component was removed.
- The view binds each client through `RootStoreProvider` and each selected session through `AgentStoreProvider(client.core.sessionAtomScope(id))`. Unmounting releases only the view subscription and does not dispose or stop the client.
- Settings are split by responsibility: Agent create/edit/delete with connection-aware model selection and registry-derived tools; Skill create/edit/delete with multi-resource add/edit/remove; connection create/edit/delete with configured state and password clearing after successful save. Missing connections, models, tools and skills remain visible and cannot be reported as successful saves.
- Chat uses `@einfach-agent/core/timeline` projection for messages, reasoning, tool calls/results, runtime events and cards. It covers running, tool progress, done, error, stopped, waiting confirmation, waiting user, recoverable, and reconciliation-blocked states.
- Send, stop, question answers/resume, confirmation, recovery, undo and redo all pass the displayed session ID. Draft text clears only after a successful send. Undo/redo buttons consume the core availability atom and surface refusals plus the external-side-effect boundary.
- Scoped package CSS supports 360px sidebars and wide embedding, visible keyboard focus, reduced motion/transparency preferences, and no host-level element overrides.
- README documents external client creation, explicit style import, host-owned disposal, and optional adoption.

## Automated verification

```text
pnpm exec vitest run browser-agent/ui
# 1 test file, 6 tests passed

pnpm --filter @einfach-agent/browser-agent-ui build
# tsup JS/CSS build passed
# tsc declaration emit passed
# fix-dts-specifiers scanned 9 declaration files

pnpm check:state
# passed; 28 workspace src roots / 1055 non-test TS/TSX files

node scripts/check-docs.js
# passed
```

The tests import `BrowserAgentView` through `src/index.ts`, create real `BrowserAgentClient` instances with fake IndexedDB and deterministic mock fetch, and cover two mounted clients, complete configuration forms, persistence failure, the real send/tool-result flow, all displayed-session decision commands, undo/redo and recovery.

## Real Chromium evidence

Run the deterministic fixture with:

```text
pnpm exec vite --config browser-agent/ui/tests/fixture.vite.config.mjs
node browser-agent/ui/tests/browser-smoke.mjs
```

Chrome stable was launched with an isolated temporary profile through DevTools Protocol. After the user's keychain constraint was added, the reusable script was hardened with `--password-store=basic` and `--use-mock-keychain`; it asks Chrome for a random debugging port and reads that port from its own temporary profile, rejects spawn failures immediately, waits for its own process to exit, and removes only its generated profile in the `finally` path. This prevents future runs from accessing the macOS system keychain or attaching to another browser on a reused port. Evidence is in `browser-agent/ui/reports/040-evidence/`:

- `empty-narrow.png`: initial empty state at 360×760;
- `settings-wide.png`: configured connection form at 1040×780;
- `waiting-narrow.png`: waiting-user decision controls at 360×820;
- `running-wide.png`: running conversation controls at 1040×780;
- `browser-checks.json`: console, keyboard focus and overflow results.

All four captures report no console errors, no document or visible-element horizontal overflow, and a focused button with a solid visible outline after keyboard Tab navigation. The screenshots were visually inspected for hierarchy, spacing, narrow wrapping and disabled/action states.

## Boundary checks

- No Chrome API, `apps/web` private import, default core, global provider fallback, UI framework, state library or new dependency was added.
- Production source only reads core atoms through the root/session bindings and mutates runtime state through public commands.
- The fixture uses only local deterministic data and never sends a model request.
- `node --check browser-agent/ui/tests/browser-smoke.mjs` passes after the keychain-safe lifecycle change. No browser was started while verifying this correction.

## R1 review fixes

- Agent editing now merges missing tool and Skill names from the saved profile into the form as checked `已缺失` references. Submitting while any missing reference remains selected produces a text error and leaves the saved revision untouched; explicitly unchecking it allows the save.
- A saved connection or model that is no longer available remains visible as `已缺失`. The form does not silently select a replacement and disables save until the user chooses a current connection and model.
- Tool choices continue to consume `client.core.tools.list()`, whose public catalog excludes internal call-timing tools. The R1 component test registers then unregisters a real tool and also registers a call-timing tool to verify both behaviors.
- Agent, Skill and connection `新建` actions now remount a fresh draft even when the editor was already in new mode. A component test covers all three reset paths.
- README now gives the host an executable loading and initialization-error surface around the asynchronous `createBrowserAgent` call.

R1 verification, without starting a browser or repeating screenshots:

```text
pnpm exec vitest run browser-agent/ui
# 1 test file, 8 tests passed

pnpm --filter @einfach-agent/browser-agent-ui build
# JS/CSS and declaration build passed; 9 declaration files scanned

node --check browser-agent/ui/tests/browser-smoke.mjs
node scripts/check-docs.js
git diff --check -- browser-agent/ui .tasks/browser-agent/reports/040-report.md
# passed
```

## R2 test fixture type fix

- The call-timing visibility fixture now uses the real public `ToolCallTiming` contract, `callTiming: 'sessionStart'`, instead of the invalid `{ bucket: 'sessionStart' }` object.
- This preserves the R1 behavior assertion that internal timed tools do not appear in the Agent tool picker.

R2 verification, without starting a browser:

```text
pnpm exec tsc -p browser-agent/ui/tsconfig.json --noEmit
# passed, including BrowserAgentView.test.tsx

pnpm exec vitest run browser-agent/ui
# 1 test file, 8 tests passed

pnpm --filter @einfach-agent/browser-agent-ui build
# JS/CSS and declaration build passed
```
