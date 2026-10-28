# 010 R1 独立复审

结论：**REJECTED**。

R1 已逐项关闭首轮审查的六个代码阻断，但持久化配置的重复身份校验仍有实际缺陷；此外验收 1、2、3 及 R1 明确追加的关键行为场景没有对应测试证据，不能用单 client 集成测试或旧 core 回归数量代替。

## 首轮六项阻断复核

- ✅ **实例 persistence 双写**已修复：`packages/agent-core/src/runtime/commands/sessionCommands.ts:28-31` 只调用所属 `core.persistence`，不再无条件触发默认 facade。
- ✅ **配置 Skill 搜索**已修复：`tools/skills/src/skill-search/skill-search.ts:45-48` 将 `ctx.skills.list()` 全部传给统一搜索并在结果上执行 allowlist；`tools/skills/src/registry.ts:178-184` 按名称去重合并内置与注入 summary。
- ✅ **首发前工具扩权**已修复：`browser-agent/agent/src/client.ts:129-134` 在建会话时直接生成 locked 正向 tool/Skill allowlist；后注册工具不会进入该列表。
- ✅ **agentProfile 恢复边界**已修复：`packages/agent-core/src/state/agentProfileSchema.ts:21-40` 做 exact-key 与逐字段校验，recovery codec 在 `packages/agent-core/src/state/recoverySnapshot.codec.ts:83-91` 使用该校验；static hydrate 也在 `packages/agent-core/src/state/persistence/hydrate.ts:178` 丢弃损坏 profile。
- ✅ **初始化失败 owner 泄漏**已修复：`browser-agent/agent/src/client.ts:29-34,71-75` 在配置加载或 hydrate 失败时释放 owner，hydrate 失败还 reset persistence。ownership 改为 Web Locks（`browser-agent/agent/src/namespaceOwner.ts:6-35`），正常 realm 消失可由浏览器释放。
- ✅ **dispose 不等待持久化队列**已修复：bridge 在 `packages/agent-core/src/runtime/persistenceBridge.ts:177-179` 汇合 sessions/workspaces/recovery flush，client 在 `browser-agent/agent/src/client.ts:149-160` 先封闭新 mutation、等待配置 mutation，再 stop、flush、reset、release。

## 当前阻断发现

### Important — 配置 decoder 的 connection ID 与 Skill name 唯一性校验恒真

- 证据：`browser-agent/agent/src/configStore.ts:48-49` 先把 connection IDs 和 Skill names 构造成 `Set`；`:55-56` 再执行 `unique([...connectionIds])` 与 `unique([...skillNames])`。Set 已经去重，这两个判断对任何输入都为 true。
- 实际影响：version 1 数据可包含两个相同 ID 的不同连接，或两个同名不同正文的 Skill，并被 `loadConfig` 接受。之后 `find()`、过滤、会话 endpoint/key 解析和 Skill 冻结会依赖数组顺序，公开快照则暴露互相冲突的配置。报告所称“逐字段校验……唯一性”不成立，也违反损坏配置应明确拒绝的要求。
- 最小修复：先保留原数组的 ID/name 列表并比较 `new Set(list).size === list.length`；同时保留当前引用校验。补重复 connection ID、重复 Skill name 的 raw IndexedDB 拒绝测试，并确认失败后 ownership 可重试。

### Important — R1 明确要求的隔离与显式会话端到端场景仍缺失

- 证据：`browser-agent/agent/src` 只有 `client.integration.test.ts`、`configStore.test.ts`、`namespaceOwner.test.ts` 三组测试。`client.integration.test.ts:11-17` 的 helper 每次只创建一个 client、一个连接、一个 Skill、一个 Agent；全文件六个用例均未同时构造两个 client 与三个 Agent，也没有在显式操作 A 时切换 active session 到 B。
- 缺口：验收 1 要求两个 client、三个 Agent、同厂商双 endpoint 在同一场景证明 prompt/model/tool/header 不串；验收 3 要求显式发送 A 后切换到 B，继续验证 A 的 stop、confirm、answer/resume/recovery 且另一 client 不受影响。现有 endpoint 测试只在一个 client 的同一 Agent 创建新旧两个 session；旧 core 命令测试也没有证明 browser-agent 多实例装配行为。
- 最小修复：增加一个真实双 client/三 Agent 的集成场景，捕获每个请求的 endpoint、model、instructions、工具目录和 header；在请求或暂停期间改变 client A 的 active session 为 B，显式对原 session 执行 stop/confirm/answer/resume/continue，并断言 A/B 及第二 client 的 store、abort 和请求互不串线。

### Important — R1 要求的配置写失败不发布快照没有确定性验证

- 证据：`browser-agent/agent/src/configStore.test.ts:20-31` 只覆盖损坏/未来数据加载；`client.integration.test.ts` 没有让 IndexedDB transaction/open/put 失败。工厂也没有 driver 注入点，当前测试无法对该路径做确定性控制。
- 代码推演：`browser-agent/agent/src/client.ts:77-81` 的顺序是先 `saveConfig`，成功后才替换 config/snapshot 并通知，静态审查看来正确；但验收 2 与 R1 追加要求明确要求故障 driver 行为测试，当前报告把未执行的场景表述为 DONE。
- 最小修复：为配置存储提供包内可测依赖注入或在测试中可靠模拟失败 transaction；断言 mutation reject、snapshot 引用和值不变、listener 不触发，随后一次成功 mutation 仍可提交。

## 追加要求复核

- ✅ 异常 realm owner：生产使用 Web Locks；缺 API 的真实浏览器 fail closed，jsdom fallback 仅用于测试。Web Locks manager reject 和共享互斥有定向测试。
- ✅ dispose 与进行中配置写竞态：`closing` 在 dispose 开始同步置位，已排队 mutation 由 `mutation` 链等待，之后停止通知并释放 owner（`client.ts:149-160`）；集成测试覆盖两个已排队写与重开恢复。
- ❌ 配置库完整结构校验：字段、URL、引用和多数唯一性已覆盖，但重复 connection ID / Skill name 漏检，见阻断一。
- ❌ 真正双 client/三 Agent与切换展示显式操作 A：当前不存在对应场景，见阻断二。
- ❌ 故障写不发布成功：实现顺序合理但无要求的行为测试，见阻断三。
- ✅ 立即关闭后会话恢复：`client.integration.test.ts:64-73` 覆盖。
- ✅ 配置/Skill 编辑后旧会话恢复：`client.integration.test.ts:107-140` 经 dispose/recreate 后走真实模型 tool loop，证明旧 instructions 与 Skill V1 保留。
- ✅ React/lockfile/骨架：UI manifest 使用 React 18.3.1 并声明 core；报告给出 frozen lockfile 与全 build 证据，scope R1 未包含已转交 020/030 的工具源目录。
- ✅ compact 工具装配：`browser-agent/agent/src/client.ts:55-62` 仅额外登记一个 `compactContextTool`，测试断言 compact timing 注册恰好一个。任务验收 4 要求的 core compact recovery/timing 回归已在规定测试命令中通过；这足以证明新 client 具备入口并复用既有引擎，未发现另造压缩路径。

## 覆盖矩阵判定

- ❌ **C01**：正常路径的 namespace owner、实例 bridge、配置/会话重建已有实现；但损坏配置可含重复连接/Skill 身份，且要求的双 client/三 Agent 隔离场景没有证明。
- ✅ **C02**：配置 Skill 可按 name/description/trigger 搜索，`skill_read` 从 session profile 读取冻结正文/资源并经过 allowlist；重建后的真实 tool loop 已证明 V1 不漂移。
- ✅ **C03**：会话冻结 endpoint、按逻辑 connection ID 动态读取最新 key；mock fetch 捕获旧/新 endpoint、轮换 key、冻结 instructions，公开 snapshot 去除 key。未发现凭据进入 prompt 或错误信息。
- ✅ **C04**：统一 resolver 对未知显式 ID 不回退 active session，send/stop/confirm/answer/resume/continue/undo/redo 及 undo→stop 传递均正确。矩阵的实现行为通过，但验收 3 所要求的组合端到端场景仍缺失。
- ✅ **C14**：新根和嵌套工具包进入 state/boundary/dist 扫描，agent 有 React/UI/Chrome/Node 禁入规则；报告给出负例和门禁通过证据。

## 验收标准逐条判定

1. ❌ 单 client 双 session 的 mock 请求不能替代两个 client、三个 Agent 的指定隔离场景；没有同时验证不同 Agent 的 model、工具目录与 header 不串。
2. ❌ 已覆盖配置重建、立即 dispose 会话恢复、旧会话 Skill/instructions 冻结、endpoint/key、重复 namespace和引用删除；但故障写不发布测试缺失，且 decoder 仍接受重复 connection ID / Skill name。
3. ❌ 显式命令代码接缝成立，但没有“A 运行时选中 B，再对 A stop/confirm/resume/recovery且另一 client 不受影响”的集成证据。
4. ✅ 规定的 compact recovery/timing 与相关 capability 回归已报告通过，stop 路径仍保留 outcomeUnknown 语义；新 client 注册唯一 compact timed tool。
5. ✅ 报告记录规定 vitest 命令 34 files / 258 tests 通过，真实模型循环覆盖配置 Skill search/read 与冻结内容。
6. ✅ browser-agent build、全 `pnpm build`、headless import、state、boundaries 均有通过证据；运行包无 React、DOM 初始化或 Chrome 依赖。
7. ✅ 报告列出公共签名、schema 规则、包配置和测试命令；其中唯一性与验收覆盖结论需按本复审修正。

## 回执

**REJECTED** — 原六项阻断已关闭，但配置唯一性仍有实际缺陷，且验收 1/2/3 和 R1 指定的关键集成场景未完成。
