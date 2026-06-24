# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (`--host 0.0.0.0`).
- `npm run build` — type-check (`tsc -b`) then `vite build`. Use this to verify types; there is no separate lint step.
- `npm test` — Vitest single run.
- `npm run test:watch` — Vitest watch mode.
- Run one test file: `npx vitest run src/agent/runtime/loop.test.ts`
- Filter by name: `npx vitest run -t "ask user question"`

Tests run in `jsdom` with `./src/test/setup.ts` as setup. Note `fileParallelism: false` in `vite.config.ts` — test files run serially (the agent runtime uses module-level singletons like `activeControllers`), so don't reintroduce parallelism without removing that shared state. Use `renderWithStore` from `src/test/renderWithStore.tsx` to render components against a fresh `@einfach/core` store.

## Environment / model config

The agent talks to DeepSeek's OpenAI-compatible API directly from the browser. Copy `.env.example` → `.env.local` and set `VITE_DEEPSEEK_API_KEY`. Provider selection (`src/agent/model/config.ts`): explicit `VITE_AGENT_MODEL_PROVIDER`, else `deepseek` when a key is present, else `mock`. With no key the runtime silently falls back to `MockModelAdapter` and deterministic answers — so the UI works offline but won't hit the model.

## External path dependencies (important)

`vite.config.ts` and `tsconfig.app.json` alias `@ai-components/*` to **source files outside this repo** at `/Volumes/work/web/ai-components/packages/*`, and `server.fs.allow` whitelists that directory. The app will not build or type-check if that sibling checkout is missing. `@` → `src`. React/react-dom are force-resolved and deduped to this app's `node_modules` to avoid duplicate-React issues when pulling in the external component sources.

## Architecture

A browser-only multi-agent chat runtime. There is no backend and no real filesystem/terminal/MCP access — "skills" and "tools" are in-repo simulations. The deliberate runtime boundary is documented in `src/agent/skills/web-chat-agent.md`.

**State (`@einfach/react` + `@einfach/core`), not Redux/Zustand.** All product state lives in atoms in `src/agent/state/atoms.ts`. The single `agentStore` is provided at the root (`src/main.tsx`). React components are render-only and read via `useAtomValue`; the agent runtime imports the store and writes through exported helpers (`appendMessage`, `appendTimelineEvent`, `patchRunState`, …). State is keyed by `sessionId` throughout (messages/runs/timeline are all `Record<sessionId, …>`), with derived `active*Atom` selectors resolving the active session.

**Run lifecycle — `src/agent/runtime/loop.ts` is the orchestrator.** `startAgentRun` → `executeRun` drives a fixed multi-agent pipeline:
1. `createMainArchitectPlan` (`agents/main-architect.ts`) produces a static set of `WorkerTask`s (skill-scan, tool-scan, clarifier, answer).
2. `pickSkillsForInput` selects skills by trigger-word match (always includes `web-chat-agent`).
3. Tools are **lazy-loaded**: `listToolSummaries` exposes only name/description/runtime; `ensureToolLoaded` → `loadTool` attaches the JSON schema only when needed. This lazy manifest is core to the design — see `tool-loading.md`.
4. Workers run in parallel (`Promise.all`) via `runWorkerTask` (`agents/workers.ts`), each returning an `AgentArtifact` with a `confidence`.
5. `mergeArtifacts` (`agents/deputy-architect.ts`) picks the answer draft (the deterministic fallback).
6. `resolveAgentTurn` runs the model turn(s) and decides: stream a final answer, or emit an `ask_user_question` payload and pause.

Every step appends/updates a `TimelineEvent` (rendered by `ToolTimeline`/`RunActivity`), so the UI shows live agent/skill/tool/model activity. Each run uses an `AbortController` stored in the module-level `activeControllers` map keyed by session; starting or stopping a run aborts the prior one. `wait()`/`delay()` helpers reject on abort — propagate the `signal` through any new async work.

**Model adapters (`src/agent/model/`).** `ModelAdapter` (`types.ts`) has two entry points: `runAgentTurn` (tool-aware, streaming, may return `tool_request`/`tool_payload`/`assistant_message`) and `generateFinalAnswer`. `createModelAdapter` (`index.ts`) picks `DeepSeekModelAdapter` or `MockModelAdapter`. The DeepSeek adapter:
- Sends only the lazy tool manifest plus a `request_tool_schema` function; when the model requests a tool, the runtime loads the schema and continues the conversation via an opaque `AgentTurnContinuation` (`buildContinuationMessages`) that replays prior messages + the tool result.
- Parses SSE streaming (`readDeepSeekStream`/`applySseFrame`), accumulating `content`, `reasoning_content`, and incremental `tool_calls`, emitting `ModelStreamEvent`s consumed by `createModelStreamProgress` for live timeline detail.
- **Never throws on API failure except `AbortError`** — every error path falls back to `deterministicAnswer` with an `error` field. Preserve this contract.

**AskUserQuestion flow.** When a run needs input, status becomes `waiting_user` and `pendingQuestion` is set on the run. `AskUserQuestionCard` collects answers into `pendingQuestionAnswersAtom`; `continueAgentRunWithAnswers` re-enters `executeRun` with `answerContext`, which threads through workers and the model prompt.

## Conventions

- TypeScript `strict` is on; `tsc -b` is the gate (run `npm run build`). The model adapter's "return-a-fallback, don't throw" pattern is intentional, not a smell.
- Components live in `src/chat/`, runtime/agents/model/state/skills/tools under `src/agent/`. Tests are colocated `*.test.ts(x)`.
- Skills are Markdown files imported with Vite's `?raw` and registered in `src/agent/skills/registry.ts`; tools are registered with name/runtime/schema in `src/agent/tools/registry.ts`. Add new ones to those registries.
- User-facing assistant strings are Chinese; keep that voice for output text.
