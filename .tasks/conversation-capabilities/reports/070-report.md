# 070 最终独立覆盖审计报告

结论：**DONE**

基线：`0fb3afbdf656df7184134075887aa414eb348828`；审计时分支 `main`、`HEAD` 仍为该基线。本轮完整阅读任务树 task/report/review、040 BLOCKED、050/060 APPROVED、相对基线的全部 tracked diff 与新增文件；产品/测试代码冻结，未 commit、未恢复或改写 stash、未派生 agent、未调用真实模型或外部服务。本报告是唯一写入。

## 总结

- 040 的三项 blocker 已闭合：Sessions/hydrate 与运行时畸形策略改为 fail closed；tombstone 固定文案移至 Lingui UI；`AppShell` commands mock 补齐且全仓测试恢复全绿。
- 040 的五组直接覆盖缺口已闭合：并发首发、锁定后的 stop/重复发送/undo-redo、child Skill 子集、loading/双空态/out-of-order load、Tab/Shift+Tab focus wrap 均有直接回归。
- C-001 至 C-015 全部 PASS；完整测试、构建、状态、边界、i18n 稳定性、diff whitespace 与行数门均通过。

## C-001 至 C-015 最终证据

| ID | 判定 | 生产证据 | 直接测试证据 |
| --- | --- | --- | --- |
| C-001 | PASS | `packages/agent-core/src/state/sessionCapabilityPolicy.ts:54-61` 创建 default-all draft；`packages/agent-core/src/runtime/commands/sessionCommands.ts:68-89` 保证新会话显式携带并持久化；当前环境上界由 `runtime/sessionCapabilityCatalog.ts:72-103` 解析。 | `state/sessionCapabilityPolicy.test.ts:26` “creates a v1 default-all draft…”；`runtime/sessionCapabilityCatalog.test.ts:81` “applies registry trust, host capability, and workspace skill preference ceilings”。 |
| C-002 | PASS | `apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx:49-111,175-194` 负责 generation-guarded load、错误/重试与顺序更新；`ConversationCapabilitySection.tsx:31-60` 负责搜索、全选/清空和双空态。 | `ConversationCapabilitiesPanel.test.tsx:84` draft/search/toggle/bulk；`:128` loading + tool/Skill 双空态；`:139` 普通乱序；`:155` stale toggle 交错；`:176` 更新错误保留。 |
| C-003 | PASS | `runtime/commands/runLifecycleCommands.ts:52-112` 在有效 prepare、run 状态检查后且 `runSession` 前 await lock；`runtime/commands/sessionCapabilityCommands.ts:145-178` 做版本复查、durable save 和失败回滚。 | `sessionCapabilityCommands.test.ts:108` durable-before-run；`:127` 空/prepare failure；`:137` prepare 编辑竞态；`:152,169` 两类持久化失败；`:198` 双并发首发只锁一次且第二条 queued。 |
| C-004 | PASS | `sessionCapabilityCommands.ts:112-143` 在命令层拒绝 legacy/locked 修改；`ConversationCapabilitiesPanel.tsx:127-133,191-201` 锁定态只读；stop/history 路径不写 root `SessionMeta`。 | `sessionCapabilityCommands.test.ts:52` 锁后 toggle=`policy_locked`；`:188` 重复发送不改 allowlist；`:229` stop、undo、redo 后仍 locked 且 toggle 拒绝；`ConversationCapabilitiesPanel.locked.test.tsx:65` 已打开面板随 meta 即时只读。 |
| C-005 | PASS | `sessionCapabilityPolicy.ts:148-160` 只把当前安全目录中的原选择复制为 draft；`sessionCapabilityCommands.ts:181-202` 创建新会话且不改源；`sessionCommands.ts:77-89` 激活新会话。 | `sessionCapabilityCommands.test.ts:70` legacy 按安全默认复制；`:90` locked 的拒绝项/消失项不被重启用；`ConversationCapabilitiesPanel.test.tsx:186` 只读 UI 调用 clone 并关闭面板。 |
| C-006 | PASS | `runtime/modelTurnPrefix.ts:73-108,119-130` 把 Tool/Skill manifest 绑定 run snapshot；`runtime/turnToolVisibility.ts:79-109` 固化成员/schema/version；`runtime/toolCallGate.ts:83-95,121-180` 对 schema list/fetch 使用同一目录。 | `sessionCapabilityToolRuntime.test.ts:61` 四态 manifest/list/schema 表；`:166` prefix、schema discovery、定向 fetch 与 guessed call 同一 allowlist。 |
| C-007 | PASS | `runtime/toolCallExecutor.ts:38-101` 顶层执行前复查 session/run/version；`runtime/toolContext.ts:161-201` 递归 `callTool` 复用同一 snapshot/catalog/host 闸。 | `sessionCapabilityToolRuntime.test.ts:166` 顶层猜名拒绝且 executor 零调用；`:211` 递归拒绝且错误不泄名；`:234` late registry 与 host 上界。`toolCallExecutor.test.ts`、`toolCallGate.test.ts` 同在本轮定向门。 |
| C-008 | PASS | `runtime/toolContext/skillsCapabilities.ts:32-57,73-140` 从同一 snapshot 构建 manifest/list/isAllowed/resolve；`tools/skills/src/skill-search/skill-search.ts:43-55` 与 `skill-read/skill-read.ts:79-88` 再查单名权限。 | `sessionCapabilitySkillsRuntime.test.ts:48,104,130` 覆盖 builtin/project/user、late registry 与 draft；`tools/skills/src/session-capability.runtime.test.ts:48` 覆盖全局 search/read/body/resource 猜名拒绝；`skill-read/session-capability.test.ts:33` 覆盖三类直接猜名。 |
| C-009 | PASS | `runtime/toolLoopBootstrap.ts:86-91` 仅在父会话允许时创建 delegation，并传 strict registry；`runtime/toolContext/delegationCapabilities.ts:108-139` child 执行再求交 session/profile/host/epoch；`toolContext.ts:187-220` 复用父 Skill snapshot。 | `sessionCapabilityDelegation.test.ts:60,82` 禁委派时无 runtime/surface；`:101` child Tool/`skill_search`/`skill_read` 直接拒绝；`:145` child 收到冻结父 Skill 子集；`:206,245` profile/host/epoch/session 与 bootstrap 交集。 |
| C-010 | PASS | `state/sessionCapabilityHydration.ts:7-12` 仅把真正缺字段视为 legacy，所有 present-invalid 变 locked-empty；`state/persistence/hydrate.ts:177-180,202-204` 在 recovery 合并前后双净化；`recoverySnapshot.codec.ts:81-89` 保持严格 codec。 | `sessionCapabilityHydration.test.ts:27,36` missing/valid/各类坏值；`persistence/hydrate.sessionCapabilities.test.ts:46,69` sessions-only 表驱动及合法 recovery 优先；`persistence-idb/src/sessionsPersistence.test.ts:56`、`persistence-sqlite/src/sqliteDriver.test.ts:99` canonical v1 round-trip；`recoverySnapshot.type.test.ts:153` legacy 与坏 recovery。 |
| C-011 | PASS | locked 具体 allowlist 与 tombstone 在 `runtime/sessionCapabilityCatalog.ts:49-65,104-114`；同 run 冻结与 resume 复用在 `runtime/runCapabilitySnapshotCache.ts:14-33`。 | `sessionCapabilityCatalog.test.ts:95` 消失 Tool/Skill 保留为 selected+unavailable；`sessionCapabilityToolRuntime.test.ts:84,124` late/replacement 不扩权；`runCapabilitySnapshotCache.test.ts:53` 同 epoch Tool/Skill/policy 不漂移。 |
| C-012 | PASS | catalog 先应用 registry/host/workspace ceilings（`sessionCapabilityCatalog.ts:80-103`）；实际递归执行再守 host/run（`toolContext.ts:161-198`）；Skill workspace 上界进入冻结集合（`skillsCapabilities.ts:108-135`）；child 再取 profile/host/session 交集（`delegationCapabilities.ts:108-139`）。 | `sessionCapabilityCatalog.test.ts:81,121` registry/workspace/host；`sessionCapabilityToolRuntime.test.ts:234` recursive host/registry；`sessionCapabilitySkillsRuntime.test.ts:48` workspace-disabled；`sessionCapabilityDelegation.test.ts:206` child 四重交集；畸形探针结果见下节。 |
| C-013 | PASS | dialog/初始与归还焦点/Escape/Tab wrap 在 `ConversationCapabilitiesPanel.tsx:86-94,134-166`；桌面 drawer、窄屏全屏、安全区与 reduced-motion 在 `conversation-capabilities.css:26-38,63-77`。 | `ConversationCapabilitiesPanel.test.tsx:200` 同时模拟 Tab、Shift+Tab、Escape、focus return；`:221` 检查 720px 全屏与 safe-area；`:84` 检查初始焦点及 disabled accessible description。 |
| C-014 | PASS | tombstone core 只返回空动态描述（`sessionCapabilityCatalog.ts:49-65`），UI 用 Lingui 输出固定说明且正常描述原样展示（`ConversationCapabilitySection.tsx:74-80`）。 | `ConversationCapabilitiesPanel.test.tsx:117` 用真实 zh-CN/en Provider 断言中文无英文泄漏及英文翻译；extract 报 509/509、English Missing 0，hash 稳定。 |
| C-015 | PASS | 010/020/030 实现经 040 独立阻断审计、050/060 修复与独立 APPROVED 后，再由本 070 在冻结工作区复核全 diff 与所有机械门；65 个产品/测试/i18n diff 文件均落在 010/020/030/050/060 声明并集。 | capability/persistence/runtime/UI 定向集 25 files / 184 tests 全绿；`AppShell.test.tsx:111-238` 原 7 个组装回归保留并全绿；完整门见下表。 |

## 040 blocker 与 GAP 复核

| 040 项 | 最终结果 |
| --- | --- |
| Sessions/hydrate future 或损坏 policy fail-open | CLOSED：central sanitizer + runtime defensive normalize；独立探针五类坏值均业务权限全拒绝。 |
| tombstone 英文泄漏 | CLOSED：core 不携固定英文，真实中英文 Provider 回归通过。 |
| AppShell mock 导致全仓 5 failures | CLOSED：`AppShell.test.tsx:57-65` 补齐命令 mock；该文件与完整 `pnpm test` 均通过。 |
| 并发首发无直接用例 | CLOSED：`sessionCapabilityCommands.test.ts:198`。 |
| stop/retry/rollback/delete-message 类生命周期无直接用例 | CLOSED：重复发送 `:188`，stop + undo/redo（消息历史删除/回退路径）`:229`；每步均比较 locked policy，最终命令仍拒写。 |
| child Skill 无直接断言 | CLOSED：`sessionCapabilityDelegation.test.ts:101,145`。 |
| loading/empty/out-of-order load 无直接断言 | CLOSED：`ConversationCapabilitiesPanel.test.tsx:128,139,155`。 |
| Tab/Shift+Tab focus wrap 无直接断言 | CLOSED：`ConversationCapabilitiesPanel.test.tsx:200`。 |

## 独立恶意策略与 legacy 探针

实际通过 `pnpm exec tsx -e` 将 five present-invalid 值依次送入 sanitizer 与 run snapshot：future v2、`null`、额外 key、乱序 allowlist、显式 `undefined`。每类结果均为：UI 可见 policy state=`locked`；`secret` Tool=false；`hidden` Skill=false；三个 protocol control tools=true。进程 exit 0。

同一探针同时验证真正缺少 own `capabilityPolicy` 字段的 legacy：sanitizer 不补字段，run state=`legacy-unrestricted`，历史 Tool/Skill 行为保持允许。该结果与 `sessionCapabilityPolicy.test.ts:123`、`sessionCapabilityHydration.test.ts:27,36`、`hydrate.sessionCapabilities.test.ts:46` 的仓库回归一致；Panel 的 `readOnly = effectiveState !== 'draft'` 位于 `ConversationCapabilitiesPanel.tsx:127-133`，故净化后的坏策略 UI 必为只读。

## 实际机械门

| 命令 | 结果 |
| --- | --- |
| capability/persistence/runtime/UI 定向 Vitest（25 个文件） | PASS：25 passed，184 passed，4.07s。 |
| `pnpm test` | PASS：801 files passed、3 skipped（804）；6505 tests passed、3 skipped（6508）；78.29s。 |
| `pnpm build` | PASS：`tsc -b`、Vite client、server `tsup` 与 web embed 完成；仅既有 dynamic/static import 与 >500 kB chunk warnings。 |
| `pnpm check:state` | PASS：扫描 982 个非测试 TS/TSX，5 条规则。 |
| `pnpm check:boundaries` | PASS：扫描 998 个非测试 TS/TSX，7 条规则；仅列出既有豁免 observations。 |
| `pnpm lingui:extract` | PASS：zh-CN 509，en 509，English Missing 0。 |
| `pnpm lingui:compile` | PASS。 |
| catalog 前后 SHA-1 | PASS，完全一致：en PO `662a0d...`、en JS `84e6e5...`、zh-CN PO `60e738...`、zh-CN JS `5d7362...`。 |
| `git diff --check 0fb3afbdf656df7184134075887aa414eb348828` | PASS，exit 0，无输出。 |
| 恶意/legacy `tsx` 探针 | PASS，exit 0；五类坏字段 locked-empty，missing field legacy。 |

测试和探针只使用内存 core、fake/mock driver/fetch；没有真实网络模型调用。

## 行数、职责、声明与工作区边界

按 `one-file-one-thing` 的 `wc -l` 物理行口径检查全部 65 个产品/测试/i18n diff 文件；i18n 资源/生成文件按规则豁免。其余全部 `<=300`：最高 `packages/agent-core/src/index.ts` 300（包公开面 barrel）、`tools/skills/src/skill-read/skill-read.test.ts` 295、`Composer.tsx` 294、`sessionCapabilityDelegation.test.ts` 291、`recoverySnapshot.codec.ts` 281、`hydrate.ts` 277、`AppShell.test.tsx` 273、两个 capability command/tool runtime 测试各 268。新增实现最高为 Panel 208 / policy 175 / Skill capabilities 141；新增测试最高 291。未见 `partN`/`utils` 假拆或新增文件跨业务层职责。

产品/测试 diff 均落在 010/020/030/050/060 的 `files` 声明并集；`.tasks/` 只含本任务树 task/report/review。分支与 HEAD 未变；`stash@{0}` 仍是 `feat/chatgpt-subscription` 保存项，另有既有 `stash@{1,2}`，本轮未操作。Lingui 后 catalog hash 与 status 文件集合稳定，构建产物未进入工作树。

未发现残余安全绕过、持久化兼容回归、未声明产品 diff、Missing、红色机械门或行数违规。C-001 至 C-015 及验收总门全部闭合，结论为 **DONE**。
