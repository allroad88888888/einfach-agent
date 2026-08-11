# 启动模型密钥门禁 Issue

状态：已完成
创建日期：2026-08-11
协调者：gpt-5.6-sol（high）
范围：Tauri 桌面端在渲染主工作区前，确认当前启动会话所需的模型 API Key 已保存在 `~/.web-agent/config.json`；未配置时只能在门禁对话框中输入并保存。
非目标：不恢复 macOS Keychain 或环境变量兜底；不改变浏览器/开发中继行为；不在本次补做模型切换时的运行前检查。

## 目标与验收

- 桌面应用先完成会话恢复和模型凭证状态读取，再决定是否进入 `AppShell`；加载中不短暂渲染主工作区。
- 新用户无会话时，默认会话是 DeepSeek，因此检查 `deepseek-default`。
- 已恢复会话时，按当前激活会话的 `vendor` 与 `region` 映射到 `deepseek-default`、`glm-default` 或 `kimi-cn`；其他 provider 是受控错误，不错误地放行或索要错误的 Key。
- 目标 Key 的状态为 `configured: false` 时，只渲染不可关闭的密钥门禁对话框。用户不能通过遮罩、Esc 或“跳过”进入主界面。
- 对话框只接收本次目标 provider 的 password input；保存调用现有 Tauri IPC，成功后清空 draft，并再次确认状态为 `configured: true`，才渲染主工作区。
- IPC/状态读取失败显示可重试错误，不能把“读取失败”当作“未配置”后覆盖已有配置。
- Key 始终只作为前端内存 draft 传给 Tauri；不得写入浏览器存储、日志、会话持久化、URL、macOS Keychain 或环境变量。
- 静态 Web 与本地开发中继不展示该门禁，因为它们没有可写的桌面配置宿主；维持当前行为。

## 已确认决策与实现依据

| 决策 | 结论 | 当前依据 |
| --- | --- | --- |
| 配置位置 | 只使用 `~/.web-agent/config.json` | 已完成的原生凭证层；`CredentialSource` 只包括 `config` 与 `missing` |
| 启动目标 | 优先取已恢复的激活会话；无会话则取 DeepSeek 默认目标 | `main.tsx` 先 hydrate 再 `newSession()`；`sessionCommands.ts` 默认 vendor 为 DeepSeek |
| 等待策略 | 会话 hydrate 与 `hydrateAppSettings()`（其内含 `hydrateModelCredentials()`）都必须完成或进入明确错误态 | `bootstrapApplication()` 等待设置与会话恢复后解析 target，再决定是否渲染 `AppShell` |
| 写入边界 | 复用 `model_credential_status` 与 `model_credential_set`，IPC 不返回 Key | `modelCredentialHost.ts` 与 `modelCredentialCommands.ts` 已有只读状态/写入接口 |
| 对话框关闭 | 未保存成功时禁止关闭；写入失败保留在对话框并可重试 | 产品要求“必须先输入 key” |

待实现时必须确认：恢复出的“当前激活会话”在 core state 中的唯一读取入口。不得通过 UI 当前显示或 session 列表顺序猜测目标。

## 任务树

```text
KEY-GATE  启动模型密钥门禁
├─ KEY-GATE-00  启动凭证目标契约与可测试解析
│  └─ KEY-GATE-00A  解析当前会话 → ModelCredentialId 的纯函数与单测
├─ KEY-GATE-10  启动状态机
│  ├─ KEY-GATE-10B  复用现有凭证状态；保存后重新确认并放行
│  └─ KEY-GATE-10C  凭据状态读取错误脱敏
├─ KEY-GATE-20  不渲染主界面的启动装配
│  └─ KEY-GATE-20A  串联 persistence、settings、目标解析与 AppShell 入口
├─ KEY-GATE-30  密钥门禁交互
│  ├─ KEY-GATE-30A  不可关闭、可访问的单 provider 对话框及样式
│  ├─ KEY-GATE-30B  对话框交互测试：保存、失败、重试和不可跳过
│  └─ KEY-GATE-30C  读取错误脱敏的组件断言
├─ KEY-GATE-40  文档与回归执行记录
│  └─ KEY-GATE-40A  更新实现说明、验收记录和必要的用户提示
└─ KEY-GATE-90  独立安全与启动回归审查
   └─ KEY-GATE-90A  检查 Key 泄露面、异步竞态、Tauri/Web 分支与合并测试
```

## 叶子任务与模型分配

| ID | 责任 | Owner model | Primary files | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| KEY-GATE-00A | 将 session model settings 精确映射到既有凭证 descriptor；覆盖 DeepSeek、GLM、Kimi、未知 vendor 与无会话 | gpt-5.6-terra（medium） | 新增 `apps/web/src/settings/startupCredentialTarget.ts` 与同名测试 | 无 | 无 UI 依赖的纯函数通过所有边界用例 | 已完成 |
| KEY-GATE-10B | 复用既有 `modelCredentialEntriesAtom` 的 ready / missing / retryable-error 状态；保存后重新读 status 确认 | gpt-5.6-sol（high） | `apps/web/src/settings/modelCredentialCommands.ts` 与 `apps/web/src/settings/commands.test.ts` | KEY-GATE-00A | 原生 IPC 失败可重试；保存返回值不能越过 status 复查；draft 与真实 Key 不离开既有写入边界 | 已完成（`pnpm test -- apps/web/src/settings/commands.test.ts`、`pnpm exec tsc -b --pretty false`） |
| KEY-GATE-10C | 读取凭据状态失败时只公开稳定的可重试文案，不透传宿主异常 | gpt-5.6-terra（medium） | `apps/web/src/settings/modelCredentialCommands.ts` 与 `apps/web/src/settings/commands.test.ts` | KEY-GATE-10B | hydrate 的错误状态和组件可见内容均不含宿主异常或 Key | 已完成（`pnpm exec vitest run apps/web/src/settings/commands.test.ts --reporter=dot`：7/7；TypeScript 通过） |
| KEY-GATE-20A | 修改启动编排，等待持久化和凭证 hydrate 后才选择 gate 或 `AppShell` | gpt-5.6-sol（high） | `apps/web/src/main.tsx` 及其聚焦测试（如需） | KEY-GATE-00A | 无短暂主界面；Tauri 与非 Tauri分支正确；共享入口只由此任务修改 | 已完成（启动入口等待 persistence/settings hydrate 后再渲染） |
| KEY-GATE-30A | 实现只显示目标 provider 的 password 输入门禁、焦点/aria、禁用关闭和对应样式 | gpt-5.6-terra（medium） | 新增 `apps/web/src/agentNew/ui/StartupCredentialGate.tsx`、同名测试与 `apps/web/src/agentNew/ui/agentnew.css` 的专属样式块 | KEY-GATE-00A、KEY-GATE-10B | 不渲染 Key、不可跳过、保存期间正确禁用且满足 a11y | 已完成（组件测试 5/5、TypeScript 通过） |
| KEY-GATE-30B | 对真实用户路径做组件/集成测试：缺失→输入→保存→复查→放行，错误→重试；检查 Esc/遮罩不能绕过 | gpt-5.6-luna（medium） | 新增 `apps/web/src/agentNew/ui/StartupCredentialGate.integration.test.tsx` | KEY-GATE-20A、KEY-GATE-30A | 以 host mock 覆盖桌面成功和失败分支，不读取真实 Key | 已完成（缺失→输入→保存→复查→放行及失败重试路径已覆盖） |
| KEY-GATE-30C | 将既有组件测试改为断言读取异常不向用户显示，并保持重试路径覆盖 | gpt-5.6-luna（low） | `apps/web/src/agentNew/ui/StartupCredentialGate.test.tsx` | KEY-GATE-10C、KEY-GATE-30A | 原始宿主异常不得出现在门禁；脱敏错误仍可重试并放行 | 已完成（`StartupCredentialGate.test.tsx`：5/5） |
| KEY-GATE-40A | 将最终契约、行为与验证命令写回项目文档/本 Issue | gpt-5.6-luna（medium） | 本文档、`docs/README.md`，以及实施后必要的当前实现说明 | KEY-GATE-20A、KEY-GATE-30B | 文档只陈述已验证行为，链接检查通过 | 已完成（实现说明、验收记录和验证证据已回填） |
| KEY-GATE-90A | 独立审查完整 diff 与测试证据；检查配置/日志泄露、启动竞态、分支漏拦截和测试缺口 | gpt-5.6-sol（high，非实现 Owner） | 只读审查；必要时新增独立审查测试 | KEY-GATE-10B、KEY-GATE-20A、KEY-GATE-30B、KEY-GATE-40A | 结论、命令和未决风险都回填 Issue；没有 P0/P1 未解决项 | 已完成（无 P0/P1；3 项 P2 已记录） |

## 并发批次与冲突护栏

并发上限按当前 4 个 slot 计算，协调者占 1 个；每批最多同时启动 3 个执行 agent。

| 批次 | 可并发叶子 | 原因与禁止重叠路径 |
| --- | --- | --- |
| B0 | KEY-GATE-00A | 先冻结共享契约；无稳定 target contract 前不并发进入状态/UI。 |
| B1 | KEY-GATE-10B、KEY-GATE-30A | 勘察确认现有凭证 atom 已完整区分 loading / missing / error，故不新建重复状态机。前者独占既有 commands 与单测，后者仅写新组件、其测试和专属 CSS；不得修改 `main.tsx`。 |
| B1.1 | KEY-GATE-10C | 10B 交付后发现读取错误仍会透传宿主文案；独占 commands 与其测试完成脱敏，且不改 UI。 |
| B2 | KEY-GATE-20A | 10B、30A 交付后，协调者独占 `main.tsx`，串联启动时序和 UI 门禁。 |
| B3 | KEY-GATE-30B | 组件与入口稳定后单独写端到端用户路径；不得编辑组件实现。 |
| B3.1 | KEY-GATE-30C | 10C 完成后，独占既有组件测试同步安全契约；可与新文件的 30B 测试并发。 |
| B4 | KEY-GATE-40A、KEY-GATE-90A | 代码冻结后，文档更新和只读独立审查可并发；发现缺陷则回到新的修复 leaf，而不是在审查中混改。 |

`main.tsx`、`agentnew.css`、公开 exports 和锁文件都是单 Owner 路径。任何任务发现需要修改另一个正在执行 leaf 的路径，必须停下、更新本树并重新排期。

## 验证与交付

- 单元：目标映射、gate 状态转移、保存后状态复查、错误重试。
- 组件/集成：Tauri 缺 Key 不渲染 `AppShell`；输入有效 Key 后才放行；保存失败、status 失败、Esc、遮罩、重复点击均不能绕过。
- 手工桌面验收：首次启动无 `~/.web-agent/config.json` 或无对应条目时显示目标 provider 对话框；保存后重启不再出现；已恢复 GLM/Kimi 会话检查其自身 target。
- 安全：搜索浏览器持久化、console、trace、URL 和测试快照，确认没有 API Key 明文；确认不存在 Keychain 或环境变量 fallback。
- 文档：运行 `node scripts/check-docs.js`，并记录实际测试命令和结果。

## 实施与验证记录

实现已完成并通过 KEY-GATE-90A 独立安全与启动回归审查（无 P0/P1）。已验证的行为包括：Tauri 启动会等待会话与模型凭证状态恢复；缺失目标 Key 时主工作区不渲染；门禁只允许输入当前目标 provider 的 Key；保存后必须再次确认 `configured: true` 才放行；保存、读取失败均保留可重试路径并脱敏宿主错误；静态 Web 与开发中继行为不变。

本轮验证证据：

- 4 个聚焦 Vitest 文件共 22 个测试通过。
- `pnpm build` 通过，仅报告既有 chunk size warning。
- `git diff --check` 通过。
- 实现验证时 `node scripts/check-docs.js` 通过，检查 68 个 Markdown 文件；本次补入本 Issue 的记录后复跑仍通过，共检查 69 个 Markdown 文件。
- 独立审查确认桌面凭据只走 `~/.web-agent/config.json`，没有 macOS Keychain 或桌面环境变量兜底；没有新增非 Einfach 产品状态。审查复核了聚焦测试 22/22、TypeScript、`pnpm build`、Rust 凭据测试 6/6 与 `git diff --check`。
- 新增及修改的普通文件均不超过 300 行；`apps/web/src/agentNew/ui/agentnew.css` 原有 4130 行，本次只追加隔离的门禁样式块，未进行无关重构。

独立审查记录了以下 P2，不阻断本 Issue；如要处理，必须先新建 leaf Issue、分配模型与文件 Owner：

- 设置页的删除凭据失败仍可能展示原始 host 异常；本次启动 hydrate/save 路径已脱敏。
- `main.tsx` 的 bootstrap 等待时序目前仅由代码审查间接覆盖；后续可抽出可注入协调函数补直接时序测试。
- `agentnew.css` 是存量超限文件，按规则已记录，本功能不扩大为无关样式重构。

执行时，所有后续修复、测试补充或范围变更都必须先在本树新增叶子 Issue、分配模型和文件 Owner；按本树的依赖与文件 Owner 启动实现 agent。
