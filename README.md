# Einfach Agent

English | [中文](README.zh-CN.md)

**A developer framework for assembling agent runtimes.** The kernel ships mechanism, not implementations:
tools, loop plugins, observability, persistence and sub-agent delegation are injected into named slots. One
kernel drives three hosts — a browser preview, a Tauri desktop app, and a headless CLI. DeepSeek and GLM are
wired in as first-class providers, not bolted on afterwards.

> *einfach* is German for "simple". The kernel keeps only what has to live in a kernel; everything else is swappable.

![One real run in the CLI host](docs/launch/assets/cli-demo.gif)

**Heads-up for English readers:** the docs and the in-app copy are currently Chinese-first. This README is the
English entry point; the design articles linked at the bottom have not been translated.

## Quickstart

You need Node.js **≥ 20.19 or ≥ 22.12** and **pnpm** — the repo links its packages with `workspace:*`, so
`npm install` resolves the wrong dependency tree. Desktop builds also need Rust stable ≥ 1.77.2, see
[Requirements](#requirements).

```bash
git clone https://github.com/allroad88888888/einfach-agent.git && cd einfach-agent
pnpm install

# Add a model key: write ~/.webAgent/config.json, or use the desktop settings page.

pnpm dev            # browser preview
pnpm tauri dev      # Tauri desktop, full capabilities

# Or drive one real run from the terminal. The CLI host has no local file tools,
# so this example works off the built-in skills.
pnpm cli -p "Read the planning skill and summarize this project's plan mechanism in three sentences"
```

## What each host can do

- **Tauri desktop** — the complete product: shell, workspace files, ripgrep, task execution, patches, Git diffs.
- **Browser preview** — same React UI, same runtime; tools backed by the Tauri `server` bridge are unavailable
  and disappear from the model's tool list automatically.
- **Headless CLI** — real runs without a UI, for dogfooding, automation, and letting a coding agent test itself.
  `-v` prints traces and timing diagnostics to stderr.
- **Models** — DeepSeek and GLM today, integrated directly rather than through an OpenAI-compatible shim. Kimi
  (`kimi-k2.6`, image input included) is implemented but gated off until it has been verified against a real
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

## One kernel, three hosts

Three assembly entry points, each choosing its own implementations:

- **Browser preview** — `apps/web/src/main.tsx`: standard tools, IndexedDB persistence and traces, the React UI,
  and the MCP application layer.
- **Tauri desktop** — reuses that same web assembly; the Rust bridge in `apps/desktop/` swaps in SQLite
  persistence, real shell/file/Git access, and a native model proxy.
- **Headless CLI** — `apps/cli/src/runtime.ts`: same standard tools, in-memory history driver, stderr traces, no React.

![Plan approval on the desktop host](docs/launch/assets/plan-approval.png)

## Requirements

- Node.js ≥ 20.19, or ≥ 22.12
- pnpm (the repo uses `workspace:*`; do not install with npm)
- For Tauri: Rust stable ≥ 1.77.2, plus platform dependencies — Xcode Command Line Tools on macOS, Microsoft
  C++ Build Tools and the WebView2 Runtime on Windows, WebKitGTK and a build toolchain on Linux. See the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Tauri normally has to be built on the target OS (`.exe/.msi`, `.app/.dmg`, `.deb/.rpm/.AppImage`). Web output
lands in `apps/web/dist/`, desktop bundles in `apps/desktop/target/release/bundle/`.

## Configuring models

The key variables in `.env.example` exist only for the local browser development relay. The desktop app never
reads model keys from `.env.local` or the process environment — enter them on the settings page and they are
written to `~/.webAgent/config.json`. If that file does not exist yet, the app safely copies an older
`~/.web-agent/config.json`; the new path wins and the old file is kept. Keychain entries from older versions are
not migrated. The CLI host reads the same file, or another path via `--config <file>`.

`WEB_AGENT_CONFIG_DIR` only selects the desktop configuration directory (for example `$HOME/.webAgent`). It is
not a source of model keys, and setting it disables migration; see
[the configuration directory notes](docs/config-directory-override.md) for multi-instance setups and directory
requirements.

New sessions default to DeepSeek, and the session's `vendor` setting decides which provider is actually called.
The Kimi entry point is additionally gated by the public build flag `VITE_KIMI_IMAGE_INPUT_ENABLED`, which stays
`false` until Kimi has been accepted end-to-end against a real China-region key.

Keys are read by the native desktop layer only and injected into a restricted provider transport. They are never
stored in browser localStorage or compiled into the frontend bundle. On Unix the config directory is created
`0700` and the file `0600`, and an override directory must pass the same permission check. The file is
plaintext, so do not commit, share or copy it anywhere untrusted. Kimi image uploads, `ms://` references and
their cleanup semantics live in the Kimi adapter — Tauri only offers generic JSON/multipart transport within an
endpoint allowlist. A static web build has no trusted proxy and cannot call model services at all.

## Development commands

```bash
pnpm install

pnpm dev            # browser development preview
pnpm build          # type check + production build
pnpm test           # frontend tests

# Headless CLI host: -p runs once and exits, no -p opens a REPL, -h lists every option
pnpm cli -p "<prompt>"

node scripts/check-boundaries.js   # assembly boundary gate, runs before the tests in CI
node scripts/check-docs.js         # documentation link gate, same

pnpm tauri dev
pnpm tauri build
cargo test --manifest-path apps/desktop/Cargo.toml   # Rust bridge integration tests

# A single test file, or a single case by name
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.singleTurn.test.ts
pnpm exec vitest run -t "ask_user"
```

Warnings about chunk size, chunk splitting and dynamic imports during `pnpm build` are expected noise, not
failures — trust the exit code.

Test files run in parallel, isolated by `isolate: true` in `vite.config.ts`: each file gets its own worker, so
module-level singletons such as `defaultCore` exist once per worker and nothing leaks across files. A test that
needs stronger isolation should call `createCore()` rather than fall back to serial execution.

## Repository layout

```text
.
├── apps/
│   ├── web/                     # Vite entry, React assembly, UI, component tests
│   ├── cli/                     # headless CLI host, for dogfooding and automation
│   └── desktop/                 # Tauri 2 / Rust desktop bridge
├── packages/
│   ├── agent-ai/                # DeepSeek / GLM / Kimi API adapters
│   ├── agent-core/              # the kernel: state, runtime, tool contract, plugin/observability/persistence contracts
│   ├── agent-react/             # React plugin surface and timeline renderer registry
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

Why the kernel looks the way it does, and which walls we walked into. These articles are in Chinese:

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
