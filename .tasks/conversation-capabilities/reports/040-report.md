# 040 独立覆盖审计报告

结论：**BLOCKED**

基线：`0fb3afbdf656df7184134075887aa414eb348828`。本次只读审计了 index、010/020/030 task/report/review、相对基线的完整工作区 diff，并独立复跑机械门；未调用真实模型或外部服务，未修改产品/测试代码，未 commit。

阻断原因有三项：

1. **持久化策略未在 Sessions/运行边界做运行时校验，存在 fail-open。** `isSessionCapabilityPolicy` 虽会拒绝未知版本（`packages/agent-core/src/state/sessionCapabilityPolicy.ts:75-95`），但 SQLite/IndexedDB 将 JSON/对象直接断言为 `SessionMeta`（`packages/persistence-sqlite/src/sqliteSessionsPersistence.ts:97-112`、`packages/persistence-idb/src/sessionsPersistence.ts:84-99`），hydrate 又原样写入 atom（`packages/agent-core/src/state/persistence/hydrate.ts:198-217`）。最终 `captureRunCapabilitySnapshot` 直接 normalize 未校验对象（`packages/agent-core/src/runtime/turnToolVisibility.ts:26-49`）。独立机械复现把 `{version:2,state:'locked',allowedTools:['secret'],allowedSkills:['hidden'],...}` 传入该边界，得到 `{"state":"locked","tool":true,"skill":true}`（exit 0）；未来/损坏版本会被当作有效 locked allowlist，违反 fail-closed 及 C-010/C-012。
2. **固定用户可见文案未国际化。** 消失项 tombstone 写死英文 `No longer available in the current environment.`（`packages/agent-core/src/runtime/sessionCapabilityCatalog.ts:49-65`），并由 `apps/web/src/agentNew/ui/ConversationCapabilitySection.tsx:74-82` 直接显示；中文 UI 会泄漏英文，C-014 不闭合。
3. **全仓测试为红。** `pnpm test` 有 5 个失败，均在未改动的 `apps/web/src/agentNew/ui/AppShell.test.tsx`：其 `@einfach-agent/core/runtime/commands` mock 未提供新增的 `getSessionCapabilityCatalog`，渲染到 `ConversationCapabilitiesButton.tsx:25` 即抛 `TypeError`。C-015 和总门 5 不成立。

## C-001 至 C-015 覆盖矩阵

| ID | 判定 | 生产证据 | 测试证据 / 缺口 |
| --- | --- | --- | --- |
| C-001 | PASS | 新会话显式生成 default-all draft：`state/sessionCapabilityPolicy.ts:43-50`，`runtime/commands/sessionCommands.ts:44-89`；catalog 再与 host/workspace 上界求交：`runtime/sessionCapabilityCatalog.ts:72-103`。 | `state/sessionCapabilityPolicy.test.ts:23` “creates a v1 default-all draft…”；`runtime/sessionCapabilityCatalog.test.ts:81` “applies registry trust, host capability, and workspace skill preference ceilings”。 |
| C-002 | GAP | 搜索/全选/清空/空态在 `ConversationCapabilitySection.tsx:31-60`，加载/错误/重试在 `ConversationCapabilitiesPanel.tsx:40-61,145-180`。但 `load()` 无请求代次或取消保护；policyVersion 触发的新旧请求可乱序覆盖 catalog/error/loading。 | `ConversationCapabilitiesPanel.test.tsx:65,98,108` 覆盖草稿操作和错误重试；**没有 deferred out-of-order load、明确 loading 状态或 tool/Skill 真空 catalog case**。 |
| C-003 | GAP | send 经每会话 submission gate 后，在 prepare 成功、run 前 await lock：`runtime/commands/runLifecycleCommands.ts:52-104`；lock 用预期 policyVersion、先写 locked、await durable save、失败回滚：`runtime/commands/sessionCapabilityCommands.ts:145-179`。 | `sessionCapabilityCommands.test.ts:104,123,133,148,165,194` 覆盖顺序、空/准备/当前 run 失败及编辑竞态；**没有两个并发首发的直接用例**，不能按 040 标准仅凭实现推断原子性。 |
| C-004 | GAP | toggle 命令拒绝 legacy/locked：`sessionCapabilityCommands.ts:112-143`；UI 用 provider 的即时 state 而非慢 catalog 判只读：`ConversationCapabilitiesPanel.tsx:103-110`；stop/continue 路径没有写 capabilityPolicy：`runLifecycleCommands.ts:115-205`。 | `sessionCapabilityPolicy.test.ts:36`、`ConversationCapabilitiesPanel.locked.test.tsx:65`、`sessionCapabilityCommands.test.ts:184` 覆盖命令/UI/重复发送；**未直接覆盖 stop、retry、rollback、delete 后仍 locked**。 |
| C-005 | PASS | clone 仅取当前仍安全可用的已选项，生成新 draft：`sessionCapabilityPolicy.ts:136-149`、`sessionCapabilityCommands.ts:181-202`；UI action：`ConversationCapabilitiesPanel.tsx:90-101,172-177`。 | `sessionCapabilityCommands.test.ts:66,86` 覆盖 legacy/locked/消失项；`ConversationCapabilitiesPanel.test.tsx:108` 覆盖只读复制入口。 |
| C-006 | PASS | run snapshot 过滤 manifest/list/schema：`turnToolVisibility.ts:79-110`；prefix 绑定冻结 catalog：`runtime/modelTurnPrefix.ts:64-130`；schema gate 同一 catalog：`runtime/toolCallGate.ts:83-95,121-180`。 | `sessionCapabilityToolRuntime.test.ts:61-82` 四态表；`:166-209` 实际模型请求序列同时验证 prefix、list、schema 与 guessed call（使用本地 fake fetch）。 |
| C-007 | PASS | executor 在执行前同时重查 session allowlist、run catalog、注册版本：`runtime/toolCallExecutor.ts:38-101`；递归 `callTool` 复用同一 snapshot/catalog/版本及 host ceiling：`runtime/toolContext.ts:161-202`。timed dispatch 也进入 executor：`runtime/timedDispatch.ts:125-170`；plugin hook 位于 gate 后且 executor 再校验。 | `sessionCapabilityToolRuntime.test.ts:166,211,234` 覆盖顶层猜名、递归拒绝且不泄名、registry/host 上界；`toolCallExecutor.test.ts` 与 `toolCallGate.test.ts` 覆盖执行/确认门。 |
| C-008 | PASS | Skill snapshot 同时截取 builtin/project/user：`runtime/toolContext/skillsCapabilities.ts:27-57`；manifest/context 用同一集合：`:73-141`；全局 search/read 再查 `isAllowed`：`tools/skills/src/skill-search/skill-search.ts:43-55`、`tools/skills/src/skill-read/skill-read.ts:79-88,90-223`。 | `sessionCapabilitySkillsRuntime.test.ts:48,104,130`；`tools/skills/src/session-capability.runtime.test.ts:48,113`；`skill-search/session-capability.test.ts:27`、`skill-read/session-capability.test.ts:32`，覆盖三类名字、直接猜读、workspace disabled、late registration、legacy/draft。 |
| C-009 | GAP | 仅在会话允许 `delegate_agent` 时挂 delegation：`runtime/toolContext.ts:205-227`；child execution 依次求交 session/profile/catalog/host/version：`runtime/toolContext/delegationCapabilities.ts:74-139`。子 agent profile 本身不含 `skill_search`/`skill_read`（`runtime/subagents/toolProfile.ts:41-52`），故当前 Skill 集是安全的空子集。 | `sessionCapabilityDelegation.test.ts:57,79,98,131,162,201` 充分覆盖 child Tools；**没有 child Skill 可见/直读断言**，C-009 的 Skill 半项缺直接测试。 |
| C-010 | **BLOCKER** | `SessionMeta.capabilityPolicy` 可选以兼容 legacy：`state/core.type.ts:179-200`；recovery codec 严格验证可选字段：`state/recoverySnapshot.codec.ts:81-89`，且 recovery static meta 优先：`state/persistence/recoveryHydration.ts:92-129`。但 Sessions 的 SQLite/IDB/hydrate 路径绕过校验，见报告首项，未知版本可放行。 | `recoverySnapshot.type.test.ts:142,153` 只证明 recovery JSON roundtrip/严格拒坏策略；`recoveryProjection.session.test.ts:47` 证明投影保留；**没有 SQLite、IndexedDB、Sessions hydrate 的策略 roundtrip/损坏/未来版本测试**。 |
| C-011 | PASS | locked allowlist 是具体名字；run 以 ToolEpoch/Skill snapshot 冻结：`turnToolVisibility.ts:79-141`、`runCapabilitySnapshotCache.ts:14-33`；catalog 为消失项补 selected+unavailable tombstone：`sessionCapabilityCatalog.ts:49-65,104-114`。 | `sessionCapabilityToolRuntime.test.ts:84,112,124`、`sessionCapabilitySkillsRuntime.test.ts:104`、`runCapabilitySnapshotCache.test.ts:53`、`sessionCapabilityCatalog.test.ts:95` 覆盖 late/replacement/mutation/消失项。 |
| C-012 | **BLOCKER** | 正常数据下，catalog/执行层仍求交 registry trust、host bridge、workspace disabled 和 child profile：`sessionCapabilityCatalog.ts:72-103`、`turnToolVisibility.ts:113-141,190-208`、`delegationCapabilities.ts:108-139`。然而 C-010 的未校验持久数据可在进入这些消费者前伪造 locked allowlist，已违反全局 fail-closed 约束。 | `sessionCapabilityCatalog.test.ts:81,117`、`sessionCapabilityToolRuntime.test.ts:234`、`sessionCapabilityDelegation.test.ts:162`、`sessionCapabilitySkillsRuntime.test.ts:48` 覆盖正常上界；没有畸形/未来持久策略穿透全路径的测试。 |
| C-013 | GAP | dialog、Escape、Tab wrap、初始/恢复焦点：`ConversationCapabilitiesPanel.tsx:63-71,111-143`；桌面抽屉、窄屏全屏、安全区、reduced-motion：`conversation-capabilities.css:26-38,63-77`。 | `ConversationCapabilitiesPanel.test.tsx:122,134` 覆盖 Escape、焦点归还、窄屏 CSS；**未模拟 Tab/Shift+Tab 焦点环绕**。 |
| C-014 | **BLOCKER** | Panel/Section 的静态 UI copy 多数使用 Lingui；但 tombstone description 在 `sessionCapabilityCatalog.ts:60` 写死英文并在 Section `:76` 直出。 | en/zh catalogs 已包含本次 Lingui msg，build 可编译；现有 UI 测试 `ConversationCapabilitiesPanel.test.tsx:65-96` 只断言英文 tombstone，不会发现中文泄漏。 |
| C-015 | **BLOCKER** | 独立检查已完成且未触发外部模型。 | 定向门全绿，但全仓 `pnpm test` 5 项失败；因此总门不闭合。 |

## 绕过面结论

- manifest、lazy schema、顶层 dispatch、递归 `callTool`、timed dispatch、plugin hook、host ceiling 均在冻结 catalog 和执行前复查两层闭合；拒绝结果使用固定文案，不回显隐藏名字。
- Skill manifest/search/read（含直接猜 builtin/project/user 名字）共享一次 run snapshot；workspace disable 是上界。legacy 仍沿用历史动态语义；意外 draft 只保留协议控制工具且不暴露 Skill。
- 子 agent Tool 是 session ∩ profile ∩ host ∩ epoch；Skill 当前为空子集，但缺少直接回归断言。
- recovery codec 路径严格；**Sessions persistence 路径不是严格边界**，这是本次发现的真实安全绕过。
- 同会话 send 有 submission gate，编辑竞态也按 policyVersion 拒绝；但缺并发首发直接测试。UI 批量切换已顺序化；Panel catalog load 仍有异步乱序显示风险。锁定态编辑即使 UI 暂时陈旧也会被命令层拒绝，未发现“UI 可改且命令未锁”的越权。

## 实际机械门

| 命令 | 结果 | 原始摘要 |
| --- | --- | --- |
| 定向 Vitest（22 个 capability/persistence/UI/confirmation 文件） | PASS | `22 passed`, `153 passed`, duration `4.61s` |
| `pnpm test` | **FAIL** | files `1 failed / 798 passed / 3 skipped`（802）；tests `5 failed / 6476 passed / 3 skipped`（6484）。5 项均为 `AppShell.test.tsx` mock 缺 `getSessionCapabilityCatalog`。 |
| `pnpm build` | PASS | web client/server build 完成；只有既有 chunk size 与 dynamic/static import warning。 |
| `pnpm check:state` | PASS | `981 non-test TS/TSX files`, `5 rules`。 |
| `pnpm check:boundaries` | PASS | `997 non-test TS/TSX files`, `7 rules`；仅输出既有 observations。 |
| `git diff --check` | PASS | exit 0，无输出（报告写入前后均要求复核）。 |
| 恶意未来版本策略本地复现 | **FAIL-CLOSED 门失败** | exit 0，输出 `{"state":"locked","tool":true,"skill":true}`。 |

测试全程使用内存 core、mock/fake fetch/driver；未访问真实外部模型。

## 行数与单一职责

`wc -l` 物理行口径。i18n 生成/资源文件按全局规则豁免；其余本次新增/大改文件均未超过 300 行。

| 文件/组 | 行数 | 责任判断 |
| --- | ---: | --- |
| `packages/agent-core/src/index.ts` | 300 | export barrel，恰好到普通文件上限；本次仅导出新 API。 |
| `apps/web/src/agentNew/ui/Composer.tsx` | 294 | 存量 composer 组合层，本次小接线，未越线。 |
| `tools/skills/src/skill-read/skill-read.test.ts` | 295 | Skill read 单一测试面。 |
| `state/recoverySnapshot.codec.ts` | 281 | recovery codec 单一责任。 |
| `runtime/sessionCapabilityToolRuntime.test.ts` | 268 | capability Tool 运行时集成面。 |
| `runtime/sessionCapabilityDelegation.test.ts` | 247 | delegation capability 集成面。 |
| `runtime/toolContext.ts` | 230 | ToolContext 构造；本次接入快照/递归闸。 |
| `runtime/commands/sessionCapabilityCommands.ts` / test | 211 / 213 | capability 命令及其测试。 |
| `runtime/turnToolVisibility.ts` | 208 | 单次 run 工具可见性/冻结读视图。 |
| `ConversationCapabilitiesPanel.tsx` / tests | 185 / 149 + 87 | panel 状态编排及普通/真实命令测试。 |
| `state/sessionCapabilityPolicy.ts` / test | 162 / 125 | 策略纯契约及测试。 |
| `runtime/sessionCapabilityCatalog.ts` / test | 115 / 125 | 安全上界 catalog 及测试。 |
| `ConversationCapabilitySection.tsx` / Button / CSS | 90 / 62 / 77 | 分别负责列表 section、入口摘要、样式。 |
| 其余本次非豁免变更 | 每个 ≤ 281 | 未见假拆分或一文件跨两个层面的新增模块。 |

## 工作区、声明面与边界

- 当前分支是 `main`；基线与任务树一致。`stash@{0}` 仍为 `feat/chatgpt-subscription` 保存项，另有既有 `stash@{1,2}`；本次未 apply/pop/drop 或改写 stash。
- 对照 010/020/030 的 `files` 声明，所有产品/测试 diff 均落在三叶声明并集；任务树 task/report/review 属编排产物。未发现额外产品实现文件被偷偷修改。
- 未改动的 `AppShell.test.tsx` 不是声明外 diff，但它暴露了新增命令 API 对全仓 mock 契约的遗漏，必须修复后才可验收。
- 本报告是 040 唯一写入；未 commit。

## 最小修复叶范围

1. **持久化 fail-closed 叶（必须）**：在 Sessions SQLite/IDB hydrate 与 run capture 的共同可信边界验证 `capabilityPolicy`；缺字段仍按 legacy，字段存在但版本未知/结构损坏不得退化成 legacy 或 locked 放行，应进入明确的拒绝/不可运行状态。补 SQLite、IndexedDB、sessions-only hydrate、recovery 优先、未知版本、未知 key、非规范 names 的端到端测试。
2. **i18n 叶（必须）**：tombstone 只传稳定状态/标记，展示层通过 Lingui 生成说明（或传可翻译 message），补 zh-CN 渲染断言，extract/compile 后确认 catalogs 稳定且无 Missing。
3. **全仓 mock 叶（必须）**：只更新 `apps/web/src/agentNew/ui/AppShell.test.tsx` 的 runtime commands mock，提供稳定 `getSessionCapabilityCatalog`（及渲染路径需要的新增方法），复跑该文件和全仓 `pnpm test`。
4. **回归覆盖叶（应补）**：补同会话双并发首发；stop/retry/rollback/delete 后策略不解锁；child Skill 空/子集；loading/empty/out-of-order load；Tab/Shift+Tab wrap 五组用例。Panel 的 out-of-order case 若失败，仅在 `ConversationCapabilitiesPanel.tsx` 加 request generation/cancel guard。

修复完成前不得将任务树结论标为 DONE。
