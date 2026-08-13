# 英文渠道帖文案（Show HN / r/LocalLLaMA）

> 本文件是**草稿**：两个英文渠道各一版可直接复制粘贴的正文，供维护者审阅与改写。**发布动作一律
> 由维护者手工执行**，仓库里没有任何自动发帖流程。事实以 `README.en.md`、
> `docs/launch/comparison.md` 以及 `docs/launch/articles/` 下的 `deepseek-v4-pitfalls.md`、
> `dogfood-400.md` 为准；未交付的能力（Kimi 入口、npm 发布）只写进诚实段落，不写进强项。正文里的
> 仓库文件一律用反引号标注，不放仓库内相对链接——帖子发出去以后相对路径是死的。

## 一、Show HN

> **渠道**：Hacker News 的 Show HN。提交表单的 URL 填 `https://github.com/allroad88888888/einfach-agent`，
> 下面的正文作为第一条评论贴出（Show HN 的惯例，不要把正文塞进标题）。
> **账号**：必须用维护者**本人的个人账号**发，HN 对代发、新注册小号和拉票非常敏感；发出去之后要
> 全程亲自回评论，回复质量对排名的影响比帖子本身大。
> **时间**：建议美东工作日 08:00–11:00（UTC 12:00–15:00）。避开周末和美东深夜——低峰期首页停留
> 时间短，一条本来能活的帖子会被埋掉。
> **配图/链接**：HN 正文不渲染图片，只留仓库链接即可；`docs/launch/assets/cli-demo.gif` 留到评论区
> 有人问「实际跑起来什么样」时再补。

**标题候选**（HN 上限 80 字符，括号内为实测字符数，破折号是 en dash 各计 1 字符）：

1. `Show HN: Einfach Agent – an agent kernel you assemble, not a finished app`（73）**← 推荐**
2. `Show HN: Einfach Agent – one agent kernel, three hosts, DeepSeek/GLM adapters`（77）
3. `Show HN: Einfach Agent – an assembled agent runtime for browser, desktop and CLI`（80）

推荐 1：一句话划清「内核不是成品」，正好是本项目与 Cline/OpenCode 那类成品编码 Agent 的分界，也预先
挡掉"又一个 agent 客户端"的第一印象；且 73 字符留了改词余地。候选 3 卡在 80 上限，改一个字就超。

**正文**：

I have been building a desktop coding agent for a while, and I kept running into the same thing:
every time I wanted a second host — first a browser preview, later a headless CLI — the runtime came
along as a copy. Most agent projects I looked at ship a loop that is welded to one storage backend,
one UI and one tool set. You can fork it, but you cannot take the loop and leave the rest.

So I pulled the kernel out and turned every capability into a slot. `packages/agent-core` holds the
tool contract and registry, the main loop, plugin hooks, and the state/persistence/observability
interfaces — nothing else. Tools, trace sink, persistence driver, project skills, plan runtime and
sub-agent delegation are injected at assembly time. If you don't inject something, it isn't there;
there is no silent fallback to a built-in default. `createCore()` returns an instance that privately
owns its store, tool registry and plugin host, so two can run in one process.

Three parts I think are worth a look:

**Slots with a CI-enforced boundary.** The dependency direction is
`agent-ai ← agent-core ← tools-* ← app`. `scripts/check-boundaries.js` scans import statements and
fails if the core ever pulls in React, a tool domain package, or a capability package. It runs before
the tests in CI, so that arrow is checked rather than merely documented.

**One kernel, three hosts.** Browser preview, Tauri desktop and a headless CLI run the same loop, the
same tool contract and the same plugin chain. The CLI assembly layer is 60 lines
(`apps/cli/src/runtime.ts`): in-memory history driver, traces to stderr, Node `fetch`. Everything
else in that host is terminal shell. It paid for itself immediately — its first real run returned a
400 from DeepSeek for a bug that had been sitting on main with the test suite green, because the
tests encoded what the docs said instead of what the server does.

**Sub-agent governance.** Delegation is a tree with per-path budgets — depth, children, concurrency,
total nodes and model calls — where a child's budget narrows along the path and can never exceed its
parent's. Runs are appended to a JSONL archive under `.webAgent-archive/`, with scripts for replay,
capacity, retention and index compaction. Traces are structured spans (agent / llm / tool / internal)
written to IndexedDB or SQLite, with a viewer in the app.

What it is not, so you don't find out the hard way:

- Nothing is published to npm. Every package is `private: true` and its `exports` point at
  uncompiled `src/*.ts`, resolved by this repo's own Vite aliases and tsconfig paths — that does not
  hold outside the workspace. Using it means cloning the repo.
- Docs and in-app copy are Chinese-first. `README.en.md` is the English entry point; the design
  articles behind it are not translated.
- Three provider adapters, hand-written instead of going through an aggregation SDK, and only
  DeepSeek and GLM are enabled by default. Kimi is implemented but gated off until it has been
  verified against a real key. No OpenAI, Anthropic or Gemini, no local models, and no
  OpenAI-compatible `base_url` fallback.
- No lint script (`tsc -b` is the only static gate), no CHANGELOG, no release process, and no semver
  promise past `0.1.0`.

So this is not something to depend on today. It is for people who want to open an agent runtime up
and change it. The feedback I would most like is on the seams: whether the slots are cut in the right
places, and what you would need to inject that you currently can't. MIT.

## 二、r/LocalLLaMA

> **渠道**：Reddit r/LocalLLaMA。发帖前先看一眼当下的版规和置顶——自我推广的容忍度这个社区改过
> 几次，硬广会被秒删。flair 选 Resources / Discussion 一类，别选新闻类。
> **账号**：用维护者**本人有历史发言记录**的账号；新号 + 自家仓库链接容易进自动过滤。发完别走人，
> 这个社区看的是你能不能在评论区把协议细节答明白。
> **时间**：建议美东工作日上午发，避开周末。
> **文风**：标题和正文都不要出现 blazing fast / revolutionary / game-changing 这类词，这里对营销腔
> 的反应比 HN 还激烈；先给硬细节，项目介绍放后面。
> **配图/链接**：正文放仓库链接即可。要配图就用 `docs/launch/assets/cli-demo.gif`（一次真实 run 的
> 直接证据），别贴 UI 美图。

**标题**（推荐）：
`Three DeepSeek V4 thinking-protocol traps you only hit with tool calls (notes from writing the adapter by hand)`

**备选**：
`DeepSeek V4: aliases are silently routed to the thinking family, and it changes what a valid request is`

**正文**：

Notes from integrating `https://api.deepseek.com/chat/completions` directly — OpenAI-compatible SDK, function
calling on, real multi-turn agent runs. All three were found against the live API, not read out of the docs.

**1. Tool-call turns must echo `reasoning_content` back, or you get a 400.**

The first turn is always fine. The second one — where you append the tool result and continue — fails:

```text
HTTP/1.1 400 Bad Request
... reasoning_content ... must be passed back ...
```

The thinking family treats the reasoning chain as conversation state, so an assistant message carrying
`tool_calls` must come back with its `reasoning_content`. Two extras: `content: null` on such a turn —
standard in the OpenAI protocol, and the declared type in most SDKs — is rejected, it wants a string; and an
empty string passes. That is what makes the fix cheap, because a runtime that synthesizes assistant turns (we
project lifecycle-tool output into history) has nothing real to echo. The field must be present, not filled.

**2. Aliases are silently routed into the thinking family, so "I never enabled thinking" is no defense.**

We sent `deepseek-chat` with no `thinking` field at all and got the same 400 — the `model` field in the
response body said `deepseek-v4-flash`. Whether your request is validated by thinking rules is decided by what
the server resolved, not by the switch you set. So anything conditional on `body.thinking?.type === 'enabled'`
leaks: on aliases, on the default model, on user-typed model names, and intermittently, depending on where the
alias points that day. Normalizing unconditionally is safe — `reasoning_content: ""` on a non-thinking path
has no observed side effect. Never branch on a field the server can change behind your back.

Same shape, different field: with thinking on, `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`
and `tool_choice` are rejected rather than ignored. Confusing symptom — flip "deep thinking" on in a session
and it can never send another message, because the settings panel still carries a temperature. Strip them in
the adapter without mutating the caller's object: that temperature is the user's config once thinking is off.

**3. `finish_reason: insufficient_system_resource` is a failure that arrives as HTTP 200.**

Capacity shortage comes back as a private terminal state on a 200 with a clean SSE close:

```json
{ "choices": [ { "delta": {}, "finish_reason": "insufficient_system_resource" } ] }
```

Not a 429, not a 5xx — status-code retry middleware and your SDK's `maxRetries` never fire; at the transport
layer this was a successful request. It is worth exactly one automatic retry, under a hard condition: never
replay a request that already emitted anything, since streamed deltas are on screen and a replayed tool call
can run a side effect twice. Easy to miss: `reasoning_content` counts as emitted output; check the final
message too, since a `stream: true` request can come back as non-streaming JSON; and don't re-send after abort.

All of this stays in one adapter file (`packages/agent-ai/src/deepseek.ts`), along with the fourth cheap one:
streaming returns no `usage`, hence no `prompt_cache_hit_tokens`, unless you set `stream_options.include_usage`.
Every verified provider difference is written down in `docs/model-adapter-compatibility.md` rather than leaking
into the generic abstraction; the long version is `docs/launch/articles/deepseek-v4-pitfalls.md` (Chinese).

**The project these came from.** Einfach Agent (*einfach* is German for "simple"), MIT — an assembly-style
agent runtime kernel. The core holds the tool contract and registry, the main loop, plugin hooks and the
state/persistence/observability interfaces; tools, trace sink, persistence driver, skills, plan runtime and
sub-agent delegation are injected as slots, and `scripts/check-boundaries.js` fails CI if the core ever
imports React or a tool domain package. One kernel assembles three hosts: browser preview, Tauri desktop,
headless CLI. DeepSeek and GLM are first-class — hand-written adapters, no aggregation layer, so the traps
above and GLM's thinking / `reasoning_effort` handling are ours to maintain.

Caveats, since this subreddit will find them anyway:

- **No local model support.** No Ollama, no llama.cpp, no OpenAI-compatible `base_url` fallback. If you run
  local weights, this repo is protocol notes and a runtime to read, not something to plug into.
- Nothing is on npm: packages are `private: true` with `exports` pointing at uncompiled `src/*.ts`. Clone it.
- Docs and UI copy are Chinese-first; `README.en.md` is the English entry point.
- Three adapters, two on by default (DeepSeek, GLM). Kimi is implemented but gated off until it is verified
  against a real key. No OpenAI, Anthropic or Gemini.
- No lint script, no CHANGELOG, no release process, no semver promise past `0.1.0`.

Happy to answer protocol questions here — and if you have hit a fourth V4 trap with tool calls, I want it.
