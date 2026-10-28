# 010 实施报告

## 结果

状态：`DONE`。R1 已关闭独立审查六项阻断及追加的 ownership、配置解码、dispose、真实冻结 Skill 执行、React 版本和 lockfile 要求。

## 修改摘要

- 新增 headless `@einfach-agent/browser-agent`，提供 Agent/Skill/连接 CRUD、IndexedDB 往返、隐藏 key 的深冻结公开快照。
- 创建会话时写 locked 正向 tool/Skill allowlist；首发前注册新工具不扩权。instructions、连接 ID/endpoint、Skill 正文/资源随会话冻结；key 仍按原连接 ID 动态解析。
- 前缀只含 allowlist 内冻结 Skill 摘要；正文/资源经 `skill_read`。`skill_search` 搜索配置 Skill 的 name/description/trigger 并守 allowlist。
- session CRUD 只写所属 `core.persistence`。bridge 新增全队列 `flush()`；dispose 封闭新 mutation，等待配置写，停止 hydrated/new sessions，等待 sessions/workspaces/recovery，再 reset/release。
- namespace ownership 改用 Web Locks，realm 消失由浏览器回收；真实浏览器缺 Web Locks 时 fail closed，jsdom 才用测试协调。申请 reject 会传播且可重试。
- 配置库逐字段校验 root、数组、records、revision、引用、唯一性、URL、credential 状态；失败不覆盖且释放 ownership。
- `agentProfile` 在 recovery/static hydrate 严格 exact-key 校验；旧数据缺字段兼容。
- client 仅装 Skill 工具、`compactContextTool` 和宿主显式工具，不装 shell/filesystem/Node 工具。
- UI 使用 React 18.3.1 peer + devDependency并声明 core；lockfile 只新增 workspace importers，既有解析版本恢复基线。
- 新根接入 workspace、TS/Vite、state/boundary/dist 门禁；修复 comparison 文档实施前已有的失效链接。

## R1 前后证据

| 阻断 | R1 前 | R1 后 |
| --- | --- | --- |
| persistence 隔离 | 非默认 core 双写默认 facade | 只调用 `core.persistence`；双 core driver 测试证明隔离 |
| Skill 搜索 | 配置 Skill 被 scope 过滤 | 三字段统一搜索、去重、allowlist 测试 |
| 权限冻结 | draft 负向列表 | 建会话即 locked 正向 allowlist，late tool 被拒 |
| profile 恢复 | 任意 JSON | exact-key、revision、数组、resources 严格校验 |
| 失败清理 | hydrate 失败遗留 owner | 初始化失败 reset/release，连续重试返回原错误 |
| dispose 耐久 | 只 flush recovery | 等待 config 与 sessions/workspaces/recovery，立即重建恢复会话 |

## 公开接口精确签名

```ts
interface BrowserAgentClient {
  readonly core: BrowserCore
  getSnapshot(): BrowserAgentSnapshot
  subscribe(listener: () => void): () => void
  saveAgent(input: AgentProfileInput): Promise<AgentProfile>
  deleteAgent(id: string): Promise<void>
  saveSkill(input: ConfiguredSkillInput): Promise<ConfiguredSkill>
  deleteSkill(name: string): Promise<void>
  saveConnection(input: ModelConnectionInput): Promise<ModelConnection>
  deleteConnection(id: string): Promise<void>
  createSession(agentId: string): Promise<string>
  dispose(): Promise<void>
}
function createBrowserAgent(options: {
  namespace: string
  registerTools?: (registry: ToolRegistry) => void
  fetch?: typeof globalThis.fetch
}): Promise<BrowserAgentClient>
```

```ts
sendMessage(input: SendMessageInput, options?: { sessionId?: string }): Promise<SendMessageResult>
stopRun(options?: { disposeUserContent?: boolean; sessionId?: string }): void
confirmTool(approved: boolean, always?: boolean, sessionId?: string): void
answerQuestion(questionId: string, value: AskUserAnswerValue, sessionId?: string): void
resumeWithAnswers(sessionId?: string): void
continueInterruptedRun(sessionId?: string): void
undoTurn(sessionId?: string): HistoryCommandResult
redoTurn(sessionId?: string): HistoryCommandResult
```

默认 UI facade 对 stop/continue 保留零参数 overload；CoreInstance 保持上述显式目标签名。

## 覆盖矩阵证据

| 行 | 证据 |
| --- | --- |
| C01 | 并发配置 mutation、深冻结、损坏配置、owner、立即关闭重建、独立 core driver 写入。 |
| C02 | 配置 Skill 三字段搜索；旧会话重载后经真实模型循环 search/read，读 V1 而非已编辑 V2。 |
| C03 | mock 最终请求捕获两 endpoint、冻结 instructions、动态 key；公开快照无 key；AI 回归通过。 |
| C04 | send/stop/confirm/answer/resume/continue/undo/redo 显式 resolver；非法 ID 不回退 active。 |
| C14 | state 26 roots/1033 文件；boundary 1038 文件/9 rules；新根负例通过。 |

## 验收命令与结果

- 规定 vitest 命令：34 files / 258 tests，通过。
- boundary fixture + configured Skill + AI provider + recovery/profile codec：5 files / 68 tests，通过。
- `pnpm --filter @einfach-agent/browser-agent build`：通过。
- `pnpm build`：通过（仅既有 Vite warnings）。
- `pnpm check:state`：通过，26 roots / 1033 files / 5 rules。
- `pnpm check:boundaries`：通过，1038 files / 9 rules。
- `node scripts/check-docs.js`：通过，522 Markdown。
- pnpm 9.15.9 `install --frozen-lockfile`：通过，27 workspace manifests 一致。

## 改动清单

新增未跟踪源文件：`browser-agent/agent/src/{client,configStore,namespaceOwner,types,validation,index}.ts` 及三份测试、`packages/agent-core/src/runtime/commands/sessionTarget.ts`、`packages/agent-core/src/state/agentProfileSchema.ts` 及测试、`tools/skills/src/skill-read/configured-skill.test.ts`，以及 browser-agent 下游骨架。page/api 已交 020/030 独占，R1 未再改其源文件。其余为 core/AI/skills 接缝、workspace/构建/门禁配置、lockfile importer 与文档链接。

## 未验证项和疑虑

- Web Locks 的 realm 异常消失回收由浏览器原生生命周期保证；jsdom 覆盖共享 manager 互斥、释放后重开和 request reject 后重试，不能真实销毁浏览器进程。
- client 已断言 compact timed tool 恰好一项；实际压缩与恢复由规定集中的 compact recovery/timing 回归覆盖。

## R2 修复与新增证据

- 修正配置 decoder：先保留原始 `connectionIdList` / `skillNameList` 再判重，不再对已去重的 Set 恒真判断。raw IndexedDB 用例分别写入重复 connection ID 与重复 Skill name，均明确拒绝；同 namespace 再次创建仍得到原损坏错误，证明 ownership 已释放。
- 初始化清理现在覆盖 `createCore`、宿主 `registerTools`、persistence configure 与 hydrate 全阶段。定向用例令 `registerTools` 主动抛错，随后同 namespace 创建成功。
- 新增 `configMutation.test.ts`：注入确定性首次失败的包内 config store，断言 mutation reject、snapshot 保持同一引用和值、listener 零调用；第二次写成功并持久化，证明串行队列没有被失败毒化。
- 新增 `multiClient.integration.test.ts` 的真实组合场景：同时创建两个 client、三个 Agent；client 1 的两个 Agent 使用同厂商不同 endpoint/model/instructions/tool/key，client 2 使用第三套配置。三个真实 mock 模型请求逐项断言 URL、Authorization、model、instructions、工具摘要互不串，两个公开快照均无 key。
- 同文件第二个真实生命周期场景先将 active 切到 B，再显式操作 A：`answerQuestion` 写入 A；`continueRecoveredSession` 返回 A 的 waiting 状态；`resumeWithAnswers` 真实续跑并只向 A 回填 tool result；`confirmTool(false)` 真实恢复并只向 A 回填拒绝结果；`stopRun` 只停止 A；`continueInterruptedRun` 只续跑 A；`undoTurn/redoTurn` 只改 A。B 与第二 client C 的 items/run/answers/artifacts 均保持不变，模型请求计数精确为 A 的三次恢复请求。
- 第三个真实并发用例让 A 与另一 client 的 C 同时停在 pending mock fetch，active 选 B；显式 `stopRun({sessionId:A})` 后直接断言 A 请求的 `AbortSignal.aborted === true`、C 仍为 false 且 run 保持 running。释放两个 pending response 后 A 保持 stopped、C 正常 done，证明 abort registry 与 transport signal 没有跨 client/session 串线。

R2 最终验证：

- 规定 vitest 命令：36 files / 265 tests，通过。
- `pnpm --filter @einfach-agent/browser-agent build`：通过。
- `pnpm check:state`：通过，26 roots / 1040 production files。
- `pnpm check:boundaries`：通过，1042 production files / 9 rules。
- `node scripts/check-docs.js`：通过，527 Markdown。
- `git diff --check`：通过。
- R2 收尾重跑 `pnpm build` 时，TypeScript 在已转交 020/040 独占的文件失败：`browser-agent/tools/page/src/dom-host.r1.test.ts:93` TS2790、`register.integration.test.ts:16` TS2339、`browser-agent/ui/src/BrowserAgentView.tsx:59` TS2322。010 未修改这些范围外文件；R1 时全仓 build 已通过，本轮 `@einfach-agent/browser-agent` 自身 build 仍通过，已即时报告编排者协调。

R2 后无未关闭的 010 自有范围验收缺口。Web Locks 的真实浏览器 realm 销毁仍由浏览器原语保证，测试边界与 R1 报告一致。
