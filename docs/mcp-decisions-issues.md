# MCP 未决决策落地 Issue 树

[mcp-integration.md](mcp-integration.md) 「未决决策」一节的六条已全部拍板（2026-08-12），本文件把
落地工作拆到「一个 issue = 一次 commit」的粒度。执行约定见 skill `issue-tree-workflow`。

## 决策结论（六条）

1. **删除服务时清掉它的工具清单缓存**：做，级联删除（A2）。
2. **schema 校验失败时是否回显实际取值**：不做。回显的字符串本来就在模型自己那条 tool call 的
   参数里，不引入新信息；改全仓通用错误格式的成本配不上收益（A1 落档）。
3. **凭据支持**：做，静态 token（http `headers` / stdio `env`）先行；OAuth 留在「后续演进」（C 分支）。
   凭据只落 `~/.webAgent/config.json`，浏览器 localStorage 路径继续剥离；启动参数里疑似 token 的
   既有拒绝保持不变——token 应该走 env 字段，不走 args。
4. **显式连接工具**：两者都要。保留 `connect_mcp_server`（显式预热、语义明确的起进程确认点），
   同时把缓存清单注册为占位工具，模型直调未连接服务的工具时透明连接（D 分支）。上下文成本已接受。
5. **异步长任务**：不改 run 暂停/恢复模型；硬超时 120 秒 → 1 小时，并在 MCP 工具的 guide 里
   注入「长任务尽量拆成多次较小调用」的引导（E 分支）。
6. **MCP 配置本体迁出 localStorage**：做，且作为凭据支持的前置（B 分支）。存量迁移沿用模型 Key
   的口径：目标位置没有数据时才复制，旧数据保留。

## 执行前提（代码事实，派活时带给子 agent）

- 配置层剥离凭据的位置：`apps/web/src/mcp/config.ts`（`UNSAFE_ARGUMENT_KEY`、`SECRET_KEY_PART`、
  `toManagerConfig`）；`tools/mcp/src/serverConfig.ts` 的 manager 侧**已经**支持 `headers`/`env` 透传。
- 桌面配置文件通道已实现：web 侧 `apps/web/src/mcp/tauriMcpConfigStorage.ts`，Rust 侧
  `apps/desktop/src/mcp_config.rs`（`mcp_config_read` / `mcp_config_write`）。缺的只是
  `apps/web/src/mcp/initialize.ts` 的 `configureMcpSettings` 没传 `storage`。
- 工具名缓存**刻意不存 inputSchema**（`apps/web/src/mcp/toolNameCache.ts` 头注释）；透明连接的
  schema 必须按需连上去取，不是缓存下来。
- 硬超时常量：`tools/mcp/src/toolAdapter.ts` 的 `MCP_TOOL_CALL_TIMEOUT_MS`。
- 模型侧固定引导文案的注入点：`toolAdapter.ts` 的 `normalizedGuide()`（现有「untrusted」行就在这）。
- 起进程确认的探针链路：`initialize.ts` 的 `isMcpLaunchConsented` → `createMcpConnectTargetProbe`，
  未确认 stdio 在 Auto 模式也要暂停（commit `fee2264` 的语义）。

## 树

- A · 决策落档与残留清理
  - A1 决策记录进 mcp-integration.md
  - A2 删除服务级联清缓存
- B · 配置迁出 localStorage
  - B1 桌面端接线配置文件存储
  - B2 localStorage 存量迁移
- C · 静态凭据支持（依赖 B）
  - C1 持久化模型支持 headers/env
  - C2a 起进程指纹纳入 env（C1 实施中发现的安全缺口，前置于 C2）
  - C2 设置面板凭据字段
  - C3 JSON 导入支持 headers/env
- D · 透明连接（保留显式工具）
  - D0 修复缓存名反查的双重前缀（蓝图发现的存量 bug，前置）
  - D1 设计蓝图
  - D2a reconciler 放行本服务占位（前置阻塞）
  - D2 缓存清单注册为占位工具
  - D3a 起进程风险面扩展（安全关键，必须先于 D3b）
  - D3b 占位工具透明连接 execute
  - D4 连接工具文案适配
- E · 长任务
  - E1 硬超时提到 1 小时
  - E2 guide 注入拆小引导
- Z · 收尾
  - Z1 mcp-integration.md 现状同步
  - Z2 退役本 issue 树

并行提示：A1、A2、B1、D1、E1 改动面互不重叠，可同时派。E1/E2 同文件串行（已有依赖）。
C2 与 C3 可并行。D 分支内部严格串行：D0 → D2a → D2 → D3a → D3b → D4（顺序理由见蓝图
「实施拆分建议」；D2/D3 按蓝图重拆为 D2a/D2/D3a/D3b，2026-08-12）。

## 卡片

### A1 · 把六条未决决策改写为已决策记录

- **依赖**：—
- **改动面**：`docs/mcp-integration.md`（「未决决策」一节改为「已决策」，写明六条结论与理由；
  同步修正 32 行、198 行两处「见『未决决策』」的前向引用措辞——事实描述保持现状，只把
  「未定」改为「已决策、待实施」）
- **判据**：`node scripts/check-docs.js` 通过；六条决策每条都有结论句；第 2 条明确写「不做」及理由
- **模型**：sonnet
- **状态**：DONE a67ef0a

### A2 · 删除服务时级联清掉它的工具清单缓存

- **依赖**：—
- **改动面**：`apps/web/src/mcp/service.ts`（`remove()`）；如需新的删除入口则
  `apps/web/src/mcp/toolNameCacheWriter.ts` / `toolNameCacheProjection.ts`；测试补在
  `apps/web/src/mcp/service.test.ts` 或 colocated 新文件
- **判据**：`pnpm exec vitest run apps/web/src/mcp` 通过，新用例断言删除服务后
  `readToolNameCache()` 不含该 serverId 且缓存存储被回写；`pnpm build`
- **模型**：sonnet
- **状态**：DONE 5e66f71

### B1 · 桌面端 MCP 服务配置接上配置文件存储

- **依赖**：—
- **改动面**：`apps/web/src/mcp/initialize.ts`（`configureMcpSettings` 传
  `storage: createDesktopMcpConfigStorage()`）、`apps/web/src/mcp/initialize.test.ts`
- **判据**：`pnpm exec vitest run apps/web/src/mcp/initialize.test.ts apps/web/src/mcp/tauriMcpConfigStorage.test.ts`
  通过：Tauri 宿主下服务配置读写经 `mcp_config_read`/`mcp_config_write`（mock `invoke` 断言），
  浏览器宿主行为不变；`pnpm build`
- **模型**：sonnet
- **状态**：DONE 11c123b

### B2 · localStorage 存量服务配置一次性迁入配置文件

- **依赖**：B1
- **改动面**：`apps/web/src/mcp/tauriMcpConfigStorage.ts`（或独立迁移模块，≤300 行）、
  `apps/web/src/mcp/tauriMcpConfigStorage.test.ts`
- **判据**：配置文件的 `mcp` 段**没有 `servers` 键**且 localStorage 有存量 → 首次 `load()` 把
  净化后的存量写入文件，localStorage 原样保留；`servers` 键已存在（含空数组）→ 不迁移；迁移幂等
  （两次 load 结果一致）；`launchConsent` 随配置一并迁移。`WEB_AGENT_CONFIG_DIR` 覆盖目录的隔离
  语义要么保住、要么在代码注释与 Z1 文档里写明为什么覆盖目录也迁移。
  `pnpm exec vitest run apps/web/src/mcp` + `pnpm build`
- **模型**：opus
- **状态**：DONE e444d3e

### C1 · 持久化模型支持 http headers 与 stdio env（仅文件存储）

- **依赖**：B2
- **改动面**：`apps/web/src/mcp/types.ts`、`apps/web/src/mcp/config.ts`
  （sanitize 与 `toManagerConfig` 透传）、`apps/web/src/mcp/persistence.ts`
  （localStorage 路径继续剥离凭据字段）、`config.test.ts`、`persistence.test.ts`
- **判据**：文件存储 save/load 往返保留 `headers`/`env`；`createMcpConfigStorage`（localStorage）
  往返后**不含**这两个字段；`toManagerConfig` 把两字段透传进 manager 配置；`parseArgsText`
  对疑似 token 启动参数的拒绝保持不变；`pnpm exec vitest run apps/web/src/mcp` + `pnpm build`
- **模型**：opus
- **状态**：DONE e3ab35d

### C2a · 起进程确认指纹纳入 env

- **依赖**：C1
- **改动面**：`apps/web/src/mcp/stdioLaunchConsent.ts`（`stdioLaunchFingerprint`）、
  `stdioLaunchConsent.test.ts`
- **判据**：改 `env` 使既有起进程确认作废（与改 command/args/cwd 同语义——`env` 能改变一条
  已确认命令行实际执行的代码，如 `LD_PRELOAD`）；**无 `env` 的存量配置指纹保持不变**（老确认
  不被一次升级集体作废）：`env` 仅在存在时进入指纹元组；增删 `env` 前后指纹不同的用例、
  无 `env` 配置升级前后指纹逐字节相同的用例都要有；
  `pnpm exec vitest run apps/web/src/mcp` + `pnpm build`
- **模型**：opus
- **状态**：DONE 702d9af

### C2 · 设置面板支持录入与编辑凭据字段

- **依赖**：C2a
- **改动面**：`apps/web/src/agentNew/ui/McpSettingsPanel.tsx`、必要时
  `apps/web/src/agentNew/ui/McpServerCard.tsx`、`apps/web/src/mcp/types.ts`（draft）、
  `apps/web/src/mcp/config.ts`（draft 校验）、`apps/web/src/mcp/state.ts`、
  `apps/web/src/agentNew/ui/SettingsCenter.mcp.test.tsx`
- **判据**：Tauri 宿主表单可填 headers（http）/ env（stdio）键值对并落盘；浏览器宿主对应输入
  禁用并给中文提示（凭据仅桌面端支持）；`pnpm exec vitest run apps/web/src/agentNew/ui/SettingsCenter.mcp.test.tsx`
  + `pnpm build`
- **模型**：sonnet
- **状态**：DOING

### C3 · JSON 导入通道支持 headers/env

- **依赖**：C1
- **改动面**：`apps/web/src/mcp/jsonConfig.ts`、`jsonConfig.test.ts`、`service.import.test.ts`
- **判据**：桌面宿主导入含 `headers`/`env` 的 JSON 被接受并落盘；浏览器宿主导入同样内容报中文
  错误、**不静默剥离**；`pnpm exec vitest run apps/web/src/mcp` + `pnpm build`
- **模型**：sonnet
- **状态**：DONE 5862a34

### D0 · 修复工具名缓存反查的双重前缀

- **依赖**：—
- **改动面**：`apps/web/src/mcp/toolNameCache.ts`（`findLastKnownToolProvider` 改为直接比较缓存
  条目名，类型注释同步修正）、其调用与接线点（`cachedToolProviderProbe.ts` /
  `toolProbeWiring.ts`，去掉 `toRegisteredName` 注入）、`toolNameCache.lastKnown.test.ts`
  （fixture 改用注册名，复现原 bug 后转绿）
- **判据**：缓存条目名即注册名（`toCachedTools` 语义不变），反查直接比较；新用例证明模型用注册名
  调未连接工具时 `tool_provider_not_connected` 回执能命中；
  `pnpm exec vitest run apps/web/src/mcp tools/mcp` + `pnpm build`
- **模型**：opus
- **状态**：DONE 3088e6f

### D1 · 透明连接设计蓝图

- **依赖**：—
- **改动面**：新增 `docs/mcp-transparent-connect-blueprint.md`、`docs/README.md` 蓝图表加行
- **判据**：`node scripts/check-docs.js` 通过；蓝图覆盖并给出结论：占位工具的注册来源与生命周期
  （缓存不存 schema 的既有决定如何兼容——schema 按需连上去取）、`request_tool_schema` 与 execute
  两条按需连接路径、未确认 stdio 的暂停语义（复用 `mcpConnectTarget` 探针，Auto 模式也暂停）、
  reconcile 对占位工具的替换与命名冲突语义、连接失败时占位工具的降级表现、上下文预算影响、
  保留的 `connect_mcp_server` 的新分工；D2–D4 拆分若需调整须同步改本文件
- **模型**：opus
- **状态**：DONE ead8fd4

### D2a · reconciler 放行本服务占位

- **依赖**：D0、D1
- **改动面**：`tools/mcp/src/toolReconciler.ts`（冲突判定与覆盖阶段）、占位登记表的最小接口
  （`tools/mcp/src/` 新文件，形状以蓝图第五节为准）、colocated 测试
- **判据**：冲突判定放行「本服务占位占着的名字」（判据来自占位登记 `owns(name)`，不看名字长相）；
  覆盖阶段 register 真实工具并释放占位登记；「抛出即 registry 未被改动」契约保持（校验阶段零副作用
  有用例）；`pnpm exec vitest run tools/mcp` + `pnpm build`
- **模型**：opus
- **状态**：DONE 9e8e08f

### D2 · 缓存清单注册为占位工具

- **依赖**：D2a
- **改动面**：`tools/mcp/src/` 新文件（占位工具工厂与生命周期同步器分开两个文件，≤300 行；蓝图
  明令禁止塞进 `clientManager.ts` / `toolAdapter.ts`）、`apps/web/src/mcp/toolProbeWiring.ts`
  （缓存 → 占位的接线）、colocated 测试
- **判据**：蓝图第一节 `desired` 规则四个重算时机各有用例（manager 状态变化、缓存写/删、hydrate
  完成、服务删除）；占位形状按蓝图表格（透传 schema、`runtimeFor`、同函数生成 description）；
  注册纪律有用例（`registry.has` 跳过不覆盖、`expected` 注销）；本 issue 内占位 execute 暂返回
  既有的「请先调用 `connect_mcp_server`」结构化回执，不引入连接路径；
  `pnpm exec vitest run tools/mcp apps/web/src/mcp` + `pnpm build`
- **模型**：opus
- **状态**：DOING

### D3a · 起进程风险面扩展

- **依赖**：D2
- **改动面**：`packages/agent-core/src/runtime/dangerousTools.ts`（`classifyToolRisk` 的 `mcp__*`
  分支按蓝图第四节风险表）、装配期事实合成（`apps/web/src/mcp/initialize.ts` /
  `toolProbeWiring.ts`：注册名 → serverId → 既有 `createMcpConnectTargetProbe`，已连接返回
  undefined）、colocated 测试
- **判据**：未连接 + stdio + 未确认 → `requiresConfirmation`（Auto 模式暂停）；未连接 + stdio +
  已确认 → `dangerous`；HTTP 或已连接 → 维持现状零回归；探针答不上来**不从严**的语义有用例并注释
  写明装配硬约束（占位注册与探针同进同退）；模型路径确认不回写起进程指纹；
  `pnpm exec vitest run packages/agent-core/src/runtime apps/web/src/mcp` + `pnpm build`
- **模型**：opus
- **状态**：TODO

### D3b · 占位工具透明连接 execute

- **依赖**：D3a
- **改动面**：D2 的占位模块（execute：入口校验 → 状态复查 → 单飞连接 → reconcile → `registry.run`
  委派，蓝图第三节 5 步）、失败映射复用 `connectFailureResult.ts`（蓝图第六节表格，`details` 带
  `viaPlaceholder`）、colocated 测试
- **判据**：蓝图第三、六节逐条有用例——单飞连接（并发第二调用不拆第一条连接）、连接用独立 180 秒
  超时不吃 1 小时硬超时、`registry.run` 委派且参数对真实 schema 二段校验、`ctx.callTool` 防环坑有
  回归说明、工具已消失回执附真实清单、AbortError 透传、失败不清缓存不注销占位；
  `pnpm exec vitest run tools/mcp apps/web/src/mcp` + `pnpm build`
- **模型**：opus
- **状态**：TODO

### D4 · 连接工具文案适配

- **依赖**：D3b
- **改动面**：`tools/mcp/src/connect-mcp-server/`（`connectSkill.ts`、`lastKnownToolsText.ts` 等）、
  colocated 测试
- **判据**：`connect_mcp_server` 描述不再展开占位已可见的完整清单，定位改为显式预热与诊断；
  `pnpm exec vitest run tools/mcp` + `pnpm build`
- **模型**：sonnet
- **状态**：TODO

### E1 · MCP 工具调用硬超时提到 1 小时

- **依赖**：—
- **改动面**：`tools/mcp/src/toolAdapter.ts`（`MCP_TOOL_CALL_TIMEOUT_MS` → `3_600_000`）、
  `toolAdapter.test.ts`、`connect-mcp-server/connect-mcp-server.ts` 如有引用
- **判据**：`pnpm exec vitest run tools/mcp` 通过（含超时用例更新）；`pnpm build`
- **模型**：sonnet
- **状态**：DONE 1a16044

### E2 · guide 注入「长任务拆小」引导

- **依赖**：E1
- **改动面**：`tools/mcp/src/toolAdapter.ts`（`normalizedGuide()`）、`toolAdapter.test.ts`
- **判据**：每个 MCP 工具的 guide 含一行英文引导（与现有 guide 行文风格一致）：调用有 1 小时
  硬超时，可拆分的长任务应拆成多次较小调用；`pnpm exec vitest run tools/mcp` + `pnpm build`
- **模型**：sonnet
- **状态**：DONE 1e71271

### Z1 · mcp-integration.md 现状同步

- **依赖**：A2、B2、C1、C2、C3、D4、E2
- **改动面**：`docs/mcp-integration.md`，必要时 `docs/README.md` 该行的适用范围描述
- **判据**：`node scripts/check-docs.js` 通过；文档不再宣称「需要认证的服务接不上」「两处存储」
  「120 秒超时」「只有显式连接」等已过时事实
- **模型**：sonnet
- **状态**：TODO

### Z2 · 退役本 issue 树

- **依赖**：Z1
- **改动面**：删除 `docs/mcp-decisions-issues.md`，`docs/README.md` 移除该行
- **判据**：`node scripts/check-docs.js` 通过
- **模型**：sonnet
- **状态**：TODO
