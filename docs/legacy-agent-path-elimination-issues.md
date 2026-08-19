# 旧隐藏 Agent 路径清理 Issue

状态：完成（前端完整构建受既有 MCP 依赖错误阻断；本 Issue 的聚焦验收已通过）
创建日期：2026-08-11
协调者：gpt-5.6-sol（high）

> **本文是一份完成后的执行账本，卡面按当时的事实保留不改。** 其中提到的桌面端
> （`apps/desktop/`、Rust 源文件、`cargo test`）已随 [Node 宿主树](node-host-issues.md) 的 T1
> 整条删除（提交 `e52c31d`），只能从 Git 历史读；同一批能力今天由 `packages/host-node` 承接。
> **判据本身仍然成立**，换的只是承接者。

## 目标与边界

仓库不再使用旧隐藏 Agent 路径前缀。工作区项目 Skills 改用
`.webAgent/skills`，运行归档改用 `.webAgent-archive`，本地缓存改用
`.webAgent-cache`。用户配置继续由 `WEB_AGENT_CONFIG_DIR` 选择目录，未设置时为
`~/.webAgent/config.json`；该变量不承载 API Key。

本次不保留旧路径的读取兼容或迁移逻辑，避免仓库重新出现旧名称。业务领域的
`agent` 对象字段不是文件系统路径，不在本次重命名范围。不得删除用户数据；只移动
Git 已跟踪的项目 Skills 目录。

## 任务树

```text
LEGACY-AGENT-PATH  消除旧隐藏 Agent 路径
├─ LEGACY-AGENT-PATH-00  路径契约
│  └─ LEGACY-AGENT-PATH-00A  固化三种新路径与禁止兼容读取
├─ LEGACY-AGENT-PATH-10  项目 Skills
│  ├─ LEGACY-AGENT-PATH-10A  扫描器、桌面桥与项目资源迁移
│  └─ LEGACY-AGENT-PATH-10B  项目 Skills UI 与定向测试
├─ LEGACY-AGENT-PATH-20  运行归档
│  ├─ LEGACY-AGENT-PATH-20A  Core 归档路径与测试
│  ├─ LEGACY-AGENT-PATH-20B  Desktop、工具脚本与测试
│  ├─ LEGACY-AGENT-PATH-20C  Desktop 读取侧归档路径与测试
│  └─ LEGACY-AGENT-PATH-20D  Subagent Tree UI 测试 fixture
├─ LEGACY-AGENT-PATH-30  文档与忽略规则
│  └─ LEGACY-AGENT-PATH-30A  面向用户的路径表述与检查规则
├─ LEGACY-AGENT-PATH-80  集成验收
│  └─ LEGACY-AGENT-PATH-80A  全仓旧路径扫描、聚焦测试、构建
└─ LEGACY-AGENT-PATH-90  独立审查
   └─ LEGACY-AGENT-PATH-90A  无旧路径、无配置回退与数据安全审查
```

## 叶子任务与模型分配

| ID | Wave | Owner model | Exclusive files | 目标与验收 | Status |
| --- | --- | --- | --- | --- | --- |
| LEGACY-AGENT-PATH-00A | B1 | gpt-5.6-sol（high） | 只读契约；本 Issue | 确认三种新路径与无兼容读取边界；记录已存在脏改动 | done |
| LEGACY-AGENT-PATH-10A | B1 | gpt-5.6-sol（high） | `packages/agent-core/src/skills/projectSkillsLoader.ts`、其定向测试、`packages/agent-core/src/runtime/projectSkillsBridge.ts`、`apps/desktop/src/workspace_read.rs`、跟踪的项目 Skills 资源目录 | 工作区扫描只读 `.webAgent/skills` 和 `.claude/skills`；资源与桥测试同步；不动 UI | done：`0cc0ec2` |
| LEGACY-AGENT-PATH-10B | B2 | gpt-5.6-terra（medium） | `apps/web/src/agentNew/ui/ProjectSkillsPanel.tsx`、其测试 | UI 不展示旧项目 Skills 路径；定向测试验证新文案 | done：`9f1d8e5` |
| LEGACY-AGENT-PATH-20A | B1 | gpt-5.6-sol（high） | `packages/agent-core/src/subagents/`、`packages/agent-core/src/state/subagent*`、相关 runtime 测试 | Core 归档只使用 `.webAgent-archive`，保持路径校验与事务安全 | done：`b883d35` |
| LEGACY-AGENT-PATH-20B | B1 | gpt-5.6-terra（medium） | `apps/desktop/src/workspace_write.rs`、`tools/agents/`、`scripts/subagent-*` 与各自测试 | Desktop/tooling 只使用新归档路径；保留路径安全限制 | done：`eef3dc8` |
| LEGACY-AGENT-PATH-20C | B2 | gpt-5.6-sol（high） | `apps/desktop/src/workspace_read.rs` 中归档读取逻辑与定向测试 | 清理首次扫描遗漏的读取侧归档常量、白名单与 fixture；不改变读取限制 | done：`d35c597` |
| LEGACY-AGENT-PATH-20D | B2 | gpt-5.6-terra（medium） | `apps/web/src/agentNew/ui/SubagentTreePanel*.test.tsx` | 更新归档 fixture，不改 UI 行为 | done：`cf2b0d1` |
| LEGACY-AGENT-PATH-30A | B1 | gpt-5.6-luna（medium） | `.gitignore`、`CLAUDE.md`、`docs/`（本 Issue 除外）、`scripts/check-docs.js` | 清理路径文档与忽略规则，不修改本轮用户 MCP 脏改动文件 | done：`416c591` |
| LEGACY-AGENT-PATH-80A | B3 | gpt-5.6-sol（high） | 无生产文件 | 聚焦测试、`pnpm build`、文档检查、全仓扫描都通过 | done：聚焦验收通过；完整构建见审查记录 |
| LEGACY-AGENT-PATH-90A | B3 | gpt-5.6-sol（high，非实现 Owner） | 只读审查 | 确认无旧路径、无兼容回退、路径校验不削弱、未纳入用户 MCP 脏改动 | done：无 P0/P1 |

## 并发与交付规则

- 实现必须在本次独立 worktree 完成；主工作区现有 MCP 改动是用户资产，完全排除。
- 10B 在 10A 的路径契约冻结后进行；20C/20D 是首轮全仓扫描发现的遗漏，分别与 10A、20A 的已完成文件串行执行。
- 根协调者仅维护 Issue、审查、验收、显式暂存与提交；实现和测试由叶子 Owner 完成。
- 完成后，只移除经 `git worktree list` 核对的本次临时 worktree；不删除用户家目录或用户配置。

## 验证计划

- `pnpm exec vitest run packages/agent-core/src/skills/projectSkillsLoader.test.ts`
- `pnpm exec vitest run packages/agent-core/src/subagents packages/agent-core/src/state/subagent*`
- 分别执行 `cargo test --manifest-path apps/desktop/Cargo.toml workspace_read` 与 `workspace_write`
- `pnpm build`
- `node scripts/check-docs.js`
- `rg -n --hidden --glob '!.git' $'\\x2eagent' .` 无结果；业务对象字段的 `settings.agent` 单独排除。
- `git diff --check`，且所有新建或大改文件 `wc -l` 不超过 300。

## 审查记录

- 验收通过：Desktop `workspace_read` 27/27、`workspace_write` 32/32；指定 Vitest
  8 文件共 144/144；文档检查通过（72 篇 Markdown）；`git diff --check` 通过；旧路径精确
  扫描为零命中。
- 完整前端构建未通过：`tools/mcp/src/streamableHttp.ts` 缺少
  `@modelcontextprotocol/sdk` 子路径类型并产生两个隐式 `any`。该目录不在
  `a00c718...HEAD` 的本 Issue diff 中，作为既有 MCP 依赖问题记录，不阻断路径清理交付。
- 独立审查无 P0/P1：项目 Skills、归档、缓存均无旧路径或兼容回退；归档读取仍保持
  trace 范围与索引 16 MiB 限制；配置仅由 `WEB_AGENT_CONFIG_DIR` 选择目录，未发现 API Key
  环境变量读取。
- 非本 Issue P2：`model_credential_config` 的测试临时目录只以 pid 与纳秒区分，并行时偶发
  相撞；串行 5/5 与单例均通过，应由独立测试稳定性 Issue 跟进。
