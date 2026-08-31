# Einfach Agent

English | [中文](README.zh-CN.md)

**A developer framework for assembling agent runtimes.** The kernel ships mechanism, not implementations:
tools, loop plugins, observability, persistence and sub-agent delegation are injected into named slots. One
kernel drives a self-hosted browser app backed by a local Node server, a static build with no local
capabilities, and a headless CLI. DeepSeek and GLM are wired in as first-class providers, not bolted on
afterwards.

> *einfach* is German for "simple". The kernel keeps only what has to live in a kernel; everything else is swappable.

![One real run in the CLI host](docs/launch/assets/cli-demo.gif)

**Heads-up for English readers:** the docs and the in-app copy are currently Chinese-first. This README is the
English entry point; the design articles linked at the bottom have not been translated.

## Quickstart

You need Node.js **≥ 22.13** and **pnpm** — the repo links its packages with `workspace:*`, so `npm install`
resolves the wrong dependency tree. See [Requirements](#requirements).

```bash
git clone https://github.com/allroad88888888/einfach-agent.git && cd einfach-agent
pnpm install

# The complete product: build the frontend once, then start the local server.
# It prints a URL carrying a one-time token and opens your browser on it.
pnpm build
pnpm serve

# Enter a model key on the settings page the first time the app opens. The local
# backend writes it to ~/.webAgent/config.json; the browser never holds the real key.

# Or drive one real run from the terminal. The CLI host has the same local file,
# shell and Git tools, scoped to --workspace (default: the current directory).
pnpm cli -p "Read the planning skill and summarize this project's plan mechanism in three sentences"
```

The script is `pnpm serve`, not `pnpm server` — `server` is a reserved pnpm subcommand. It binds `127.0.0.1`
on port 4765 (it walks forward if that one is taken), and `--no-open` skips launching the browser. The
frontend it serves is the output of `pnpm build`; without that build it answers every page with a 503 that
tells you to run it.

`pnpm dev` starts the Vite preview instead — same UI, no backend, no local capabilities.

## What each host can do

- **Browser + local Node server** (`pnpm serve`) — the complete product: shell, workspace files, ripgrep, task
  execution, patches, Git diffs, MCP stdio servers, SQLite sessions and traces. The frontend probes
  `GET /api/health` at startup; a healthy answer puts it in the `server` host state, and every local capability
  travels over `POST /api/invoke/:command` to `packages/host-node`.
- **Static build** (`pnpm dev`, or any deployment with no backend) — same React UI and runtime, but the probe
  fails, no command bridge is registered, and every tool that needs the machine (files, shell, Git, ripgrep)
  disappears from the model's tool list instead of failing at call time. `pnpm dev` additionally gets model
  access through the Vite development relay. A built static deployment uses explicit browser BYOK: the key is
  stored in that browser's localStorage and requests go directly to the provider, so the provider must allow the
  deployment origin with CORS.
- **Headless CLI** — real runs without a UI, for dogfooding, automation, and letting a coding agent test
  itself. It loads the same `packages/host-node` capability implementation in-process, so its tools are the
  local machine's; it configures no persistence, so a session lives only as long as the process. `-v` prints
  traces and timing diagnostics to stderr.
- **Models** — DeepSeek and GLM today, integrated directly rather than through an OpenAI-compatible shim. Kimi
  (`kimi-k3`, image input included) is implemented but gated off until it has been verified against a real
  key. OpenAI and Anthropic are not supported yet.
- **Runtime** — multi-session, checkpoint/revert, lazy tool schemas, confirmation for dangerous tools, structured
  plans, a tree of sub-agents, a background execution graph, context compaction with provider cache stats, traces.

## The assembly kernel

`packages/agent-core` provides mechanism only. Each instance from `createCore()` privately owns its store, tool
registry, abort registry, plugin host and observability port, so two can run side by side in one process:

| Slot | What you inject |
| --- | --- |
| `registerTools` | The tool set. Leave it out and the instance has **no tools at all**; apps call `registerStandardTools` for the six standard domains |
| `plugins` | Loop plugins. Compaction, finish-reason handling, the loop guard and migrations are plugins, not branches in the main loop |
| `observability` | Trace sink: IndexedDB, SQLite, stderr, or none |
| `projectSkillsProvider`, `skillRegistry` | Project skill discovery and the built-in skill catalog |
| `planRuntime` | The structured planning runtime |
| `delegation` | The sub-agent delegation runtime; without it there are no sub-agents |
| `config` | Runtime configuration such as API key and vendor |

Session and history persistence is not a constructor argument — the host configures a driver through the
persistence bridge. The dependency direction is one-way, and it is not left to good intentions:

```text
packages/agent-ai ← packages/agent-core ← {tools-*, capability packages} ← app
```

`node scripts/check-boundaries.js` runs before the tests in CI: it scans import statements and fails outright if
the core ever pulls in React, a `@einfach-agent/tools-*` package, or any capability package.

## One kernel, one capability implementation

Local capabilities are implemented **once**, in TypeScript, and reached over two different transports:

```text
              ┌─ browser ──── HTTP ────┐
agent-core ──▶│                        ├──▶ packages/host-node ──▶ the machine
              └─ CLI ─── in-process ───┘
```

The assembly entry points, each choosing its own implementations:

- **Web assembly** — `apps/web/src/main.tsx`: standard tools, the React UI and the MCP application layer. It
  resolves the host state once at startup and picks the command bridge, model transport, credential host,
  persistence and trace drivers from it — SQLite over the server for the `server` state, IndexedDB for `static`.
- **Local server** — `apps/server`: one Node HTTP process that serves the built frontend and routes
  `/api/invoke/:command` into the host-node command table. It binds the loopback address, and every `/api/*`
  call is checked against the peer address, the `Host`/`Origin` headers and the token printed at startup —
  the health probe is the single token exemption, so that a page opened without one degrades loudly.
- **Headless CLI** — `apps/cli/src/runtime.ts`: same standard tools, the same host-node bridge in-process,
  stderr traces, no React.
- **Capability implementation** — `packages/host-node`: all 30 host commands (workspace read/write/patch,
  shell, Git, ripgrep, MCP stdio, SQLite, the model proxy and credential storage), shared by both hosts above.

![Plan approval, waiting for the user's decision](docs/launch/assets/plan-approval.png)

## Requirements

- Node.js ≥ 22.13 — the persistence layer uses the built-in `node:sqlite`, which needs no flag from 22.13 on.
  That bound is declared in the `engines` field of `@einfach-agent/server` and `@einfach-agent/host-node`.
- pnpm (the repo uses `workspace:*`; do not install with npm)

Build output: the frontend lands in `apps/web/dist/`, and `apps/server` bundles itself into
`apps/server/dist/main.js` with a copy of that frontend at `apps/server/dist/public/`, so the server package
runs without the repository working tree.

## Configuring models

The key variables in `.env.example` exist only for the local browser development relay used by `pnpm dev`. A
`pnpm serve` app sends keys to the local Node backend, which writes them to `~/.webAgent/config.json`. A built
static deployment instead uses the key explicitly entered in its settings page. If the local config file does not
exist yet, the backend safely copies an older `~/.web-agent/config.json`; the new path wins and the old file is
kept. The CLI host reads the same file, or another path via `--config <file>`.

`WEB_AGENT_CONFIG_DIR` only selects the configuration directory (for example `$HOME/.webAgent`). It is not a
source of model keys, and setting it disables migration; see
[the configuration directory notes](docs/config-directory-override.md) for multi-instance setups and directory
requirements.

New sessions default to DeepSeek, and the session's `vendor` setting decides which provider is actually called.
The Kimi entry point is additionally gated by the public build flag `VITE_KIMI_IMAGE_INPUT_ENABLED`, which stays
`false` until Kimi has been accepted end-to-end against a real China-region key.

`deepseek-v4-flash-vision-exp` supports image input. In Composer, JPEG, PNG and WebP attachments keep their
original bytes and are temporarily uploaded through DeepSeek's [Files API](https://api-docs.deepseek.com/zh-cn/guides/files_api).
The model-facing `view_image` tool defaults to `detail: 'low'`, which resizes a static image into a 512×512
bounding box before upload. Use `detail: 'high'` for OCR, small text in screenshots, dense charts, or close visual
comparison; it retains the original pixels. Files created for image observation are best-effort deleted after either
completion or failure. See DeepSeek's [Vision guide](https://api-docs.deepseek.com/zh-cn/guides/vision) for the upstream
image interface.

Server-host keys are injected by the local Node backend into a restricted provider transport; no response body
ever carries one back to the browser. Static BYOK keys are deliberately different: they are plaintext in browser
localStorage and are sent directly to the selected official provider. Any same-origin script or trusted browser
extension can read them, so use this only on a trusted deployment and clear site data to remove them. Keys are
never compiled into the frontend bundle. On Unix the local config directory is created `0700` and the file `0600`.
Kimi image uploads, `ms://` references and their cleanup semantics live in the Kimi adapter — the backend only
offers generic JSON/multipart transport within an endpoint allowlist.

## Development commands

```bash
pnpm install

pnpm dev            # browser preview, no local capabilities
pnpm build          # type check + production build (frontend, then the server package)
pnpm serve          # the self-hosted local server; needs a prior `pnpm build`
pnpm test           # tests

# Headless CLI host: -p runs once and exits, no -p opens a REPL, -h lists every option
pnpm cli -p "<prompt>"

# The three gates, in the order CI runs them, before `pnpm test` and `pnpm build`
node scripts/check-docs.js               # documentation links
node scripts/check-boundaries.js         # assembly boundaries
node scripts/check-state-invariants.js   # state mechanism invariants

# CI then rebuilds every publishable dist and checks it, in this order — not the other way round,
# because the server package embeds the frontend that `pnpm build` produced
pnpm -r build && node scripts/check-dist.js

# A single test file, or a single case by name
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.singleTurn.test.ts
pnpm exec vitest run -t "ask_user"
```

Warnings about chunk size, chunk splitting and dynamic imports during `pnpm build` are expected noise, not
failures — trust the exit code.

Test files run in parallel, isolated by `isolate: true` in `vite.config.ts`: each file gets its own worker, so
module-level singletons such as `defaultCore` exist once per worker and nothing leaks across files. A test that
needs stronger isolation should call `createCore()` rather than fall back to serial execution.

## Running it outside the repository

The packages are **not published to any registry** — `private: true` on the four packages below is a deliberate
guard, not an oversight. To run the app from outside the working tree, build the tarballs and install them:

```bash
pnpm build && pnpm -r build
pnpm pack --pack-destination /tmp/einfach-agent \
  --filter @einfach-agent/server --filter @einfach-agent/core \
  --filter @einfach-agent/ai --filter @einfach-agent/host-node

cd /tmp/einfach-agent && npm install *.tgz
./node_modules/.bin/einfach-agent --no-open
```

Use `pnpm pack`, not `npm pack`: only pnpm rewrites the `workspace:*` ranges into real versions. The bin is
named `einfach-agent` while the package is `@einfach-agent/server`, so `npx einfach-agent` would resolve to an
unrelated, non-existent package — install the tarballs instead.

## Repository layout

```text
.
├── apps/
│   ├── web/                     # Vite entry, React assembly, UI, component tests
│   ├── server/                  # the local HTTP host: static frontend + /api/invoke + model proxy
│   └── cli/                     # headless CLI host, for dogfooding and automation
├── packages/
│   ├── agent-ai/                # DeepSeek / GLM / Kimi API adapters
│   ├── agent-core/              # the kernel: state, runtime, tool contract, plugin/observability/persistence contracts
│   ├── agent-react/             # React plugin surface and timeline renderer registry
│   ├── agent-plugin-example/    # a runnable sample of the plugin contract
│   ├── host-node/               # the Node capability implementation behind every host command
│   ├── subagents/               # delegation scheduling, batching, archive governance, view state
│   ├── persistence-{idb,sqlite}/    # session and history drivers
│   └── observability-{idb,sqlite}/  # trace drivers and readers
├── tools/
│   ├── standard/                # meta package aggregating the six standard domains
│   ├── shell/ fs/ interaction/ planning/ skills/ agents/   # those six domains
│   └── mcp/                     # a seventh domain, outside the standard package, assembled by the app
├── docs/                        # current behaviour notes plus in-progress blueprints
└── scripts/                     # gate scripts and sub-agent archive/skill governance
```

The core installs no tools or capability implementations by itself. Application entry points register the
standard tool set and hand `createCore` the project skills, planning, delegation, persistence and observability
they need; other consumers can register only the domains they want.

## Design deep dives

Why the kernel looks the way it does, and which walls we walked into. These articles are in Chinese, and the
oldest of them still describe the Tauri desktop host that has since been removed:

- [One kernel, three hosts: designing an assembled agent runtime](docs/launch/articles/assembly-kernel.md) (Chinese)
- [Giving tools a lifecycle: the CallTiming mechanism](docs/launch/articles/call-timing.md) (Chinese)
- [Sub-agent governance: replay, capacity and archiving](docs/launch/articles/subagent-governance.md) (Chinese)
- [Dogfooding with the CLI host: catching a production 400 in ten minutes](docs/launch/articles/dogfood-400.md) (Chinese)
- [Field notes on the DeepSeek V4 thinking protocol](docs/launch/articles/deepseek-v4-pitfalls.md) (Chinese)

## Docs and contributing

- [docs/README.md](docs/README.md) is the documentation index; it separates notes describing current behaviour
  from blueprints describing where things are heading. Completed phase plans live only in Git history.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR: environment setup, the gates to run before
  committing, commit conventions, and the hard rules.
- [CLAUDE.md](CLAUDE.md) holds the working conventions for coding agents inside this repo.

## License

[MIT](LICENSE)
