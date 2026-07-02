# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (`--host 0.0.0.0`).
- `npm run build` — type-check (`tsc -b`) then `vite build`. Use this to verify types; there is no separate lint step.
- `npm test` — Vitest single run.
- `npm run test:watch` — Vitest watch mode.
- Run one test file: `npx vitest run src/agentNew/runtime/modelRun.test.ts`
- Filter by name: `npx vitest run -t "ask_user"`

Tests run in `jsdom` with `./src/test/setup.ts` as setup. Note `fileParallelism: false` in `vite.config.ts` — test files run serially because the runtime uses module-level singletons (`abortRegistry`'s controller map, the per-session store cache in `sessionStore.ts`), so don't reintroduce parallelism without removing that shared state. Use `renderWithStore` from `src/test/renderWithStore.tsx` to render components against a fresh `@einfach/core` store. IndexedDB tests use `fake-indexeddb`.

## Environment / model config

The agent talks to DeepSeek's and GLM's OpenAI-compatible APIs directly from the browser (`src/agentNew/api/{deepseek,glm,modelApi}.ts`). Copy `.env.example` → `.env.local` and set `VITE_DEEPSEEK_API_KEY` (and `VITE_GLM_API_KEY` for GLM sessions). `main.tsx` injects the keys via `configureCommands`. A session's `settings.vendor` (`'deepseek' | 'glm'`) selects the API and key. With no key, model calls fail and the run degrades to `status: 'error'` (the adapters never throw except on `AbortError`).

## Project layout

Everything lives under `src/agentNew/` (the app is a single, self-contained rewrite — there is **no** external path dependency and no `@ai-components` alias). `@` → `src`. `react`/`react-dom` are force-resolved+deduped to this app's `node_modules` in `vite.config.ts`. Design/decision docs live alongside the code: `CHECKPOINT-STATE-PLAN.md` (state layer), `RUNTIME-UI-PLAN.md` (runtime + UI), `FEATURES-PLAN.md` (tool/skill + persistence + Tauri + cleanup), `T8-UI-PLAN.md` (tool cards). Read these for the "why" behind the architecture and the contract IDs (U1/U2, TK*, PF4, etc.) referenced in code comments.

## Architecture

A browser-only chat runtime. No backend, no real filesystem/terminal/MCP — "skills" and "tools" are in-repo simulations (the boundary is documented in `src/agentNew/skills/web-chat-agent.md`). The planned desktop shell (Tauri + SQLite via `tauri-plugin-sql`) is the only remaining unbuilt block (`Ta` in FEATURES-PLAN).

**State: one store per session + a top-level rootStore (`@einfach/react` + `@einfach/core`, not Redux/Zustand).**
- `state/rootStore.ts` — the single global `rootStore` holds only cross-session state: `sessionsAtom` (`Record<id, SessionMeta>`) + `activeSessionIdAtom`.
- `state/sessionStore.ts` — `createSessionStore(id)` / `getSessionStore(id)` build and cache **one einfach `createStore()` per session** in a `Map`. Session-scoped atoms (`state/sessionAtoms.ts`: `itemsAtom`/`runAtom`/`checkpointsAtom`; `state/transientAtoms.ts`: `browserCardsAtom`/`pendingArtifactsAtom`/`pendingQuestionAnswersAtom`) are **shared atom keys whose values live in each session's own store** — value isolation comes from the store, so there is **no `Record<sessionId, T>` bucketing**.
- Writers (`state/sessionWriters.ts`, `state/checkpointWriters.ts`, `state/transientAtoms.ts`) take an explicit `id`, write into that session's store, and **ghost-guard** (no-op if the session isn't registered in `rootStore.sessionsAtom`). All updates are immutable (checkpoint snapshots depend on it).

**UI ↔ runtime boundary (contracts U1/U2/U3).** React components only **read atoms** (`useAtomValue`) and **call commands** (`runtime/commands.ts`) — they never call writers, never `setter` an atom, never touch a store instance. Commands don't take a `store` (they self-resolve `rootStore` / `getSessionStore(activeId)`). Provider layering: root `<Provider store={rootStore}>` drives the sidebar; `ui/ActiveSessionProvider.tsx` swaps in the active session's store with `key={activeId}` so switching sessions remounts the right pane.

**Run lifecycle — `runtime/commands.ts` + `runtime/modelRun.ts`.** `sendMessage` → `runSession` appends the user item, sets the run, and calls `runToolLoop`, a multi-turn lazy-tool loop: send `[system, ...items]` + the visible tool manifest → if the model returns `tool_calls`, append the assistant item then execute each tool (`runtime/toolExecution.ts`, dispatching `skill_search`/`skill_read`/`save_file`/`browser_action`) and append a tool-result item, then loop; on a plain `stop` append the final assistant item and `commitCheckpoint`. Items are stored directly in `itemsAtom` and re-sent each turn (no continuation blob). Tools are **lazy-loaded**: the model sees only `listToolSummaries` + a `request_tool_schema` function; `ensureToolLoaded` attaches a schema only when requested (`runtime/toolLoading.ts`). Every write-back after an `await` re-checks `isCurrentRun(id, runId)` (session still exists **and** run not superseded) **and** `signal.aborted` — a superseded/aborted run must not pollute a new one. Aborts go through `runtime/abortRegistry.ts` (a module-singleton `Map<id, AbortController>`; `beginRun` aborts any prior controller, `endRun` only clears its own).

**AskUserQuestion flow.** When the model calls `ask_user_question`, the loop first backfills tool results for any sibling tool_calls, then sets `status: 'waiting_user'` + `pendingQuestion` and returns (leaving the ask_user tool_call un-backfilled). `ui/AskUserQuestionCard.tsx` renders the (defensively normalized) questions, collects answers via the `answerQuestion` command into `pendingQuestionAnswersAtom`, and `resumeWithAnswers` backfills the ask_user tool result and re-enters `runToolLoop` reusing the paused run's `runId`. While `waiting_user`, the Composer is locked and `sendMessage` no-ops (else a new run would orphan the ask_user tool_call and produce an invalid tool-call sequence).

**Persistence (`state/persistence/*` + `runtime/persistenceBridge.ts`).** `HistoryDriver` (IndexedDB impl) stores per-session checkpoints; a sessions store persists `SessionMeta`. `main.tsx` `hydrate`s before seeding (restores sessions + latest checkpoint items). Writes are fire-and-forget via `persistenceBridge` (no-op until `configurePersistence` injects the drivers; errors swallowed). `runAtom` (status/pendingQuestion) is **not** persisted — a refresh mid-`waiting_user` is lost by design.

**Checkpoints / revert.** One user turn = one checkpoint (an items snapshot committed at turn end). `ui/CheckpointBar.tsx` + the `revertToTurn` command do a truncating revert (`jumpToCheckpoint` restores items + truncates the checkpoint list; the command also prunes browser cards newer than the revert point and truncates persisted checkpoints).

## Conventions

- TypeScript `strict` is on; `tsc -b` is the gate (run `npm run build`). The model adapters' "return-a-fallback, don't throw (except AbortError)" pattern is intentional, not a smell.
- Everything is under `src/agentNew/`: UI in `ui/`, orchestration in `runtime/`, state in `state/`, model APIs in `api/`, skills/tools in `skills/` + `tools/`. Tests are colocated `*.test.ts(x)`.
- Skills are Markdown imported with Vite's `?raw` and registered in `skills/registry.ts`; tools are registered with name/runtime/schema in `tools/registry.ts`. Add new ones to those registries.
- Follow the plan docs' contract IDs when touching runtime/state (ghost guard, stale-run guard, immutable updates, UI-reads-atoms-calls-commands). Each stage is closed with a `codex review --uncommitted` pass.
- User-facing assistant strings are Chinese; keep that voice for output text (and for code comments/plan docs, matching the existing style).
