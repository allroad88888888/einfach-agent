# WebAgent 默认配置目录迁移 Issue

状态：已完成
创建日期：2026-08-11  
协调者：gpt-5.6-sol（high）

## 目标与边界

将未设置目录覆盖时的桌面用户配置位置由 `~/.web-agent/config.json` 改为
`~/.webAgent/config.json`。`WEB_AGENT_CONFIG_DIR` 是唯一可导出的目录覆盖变量：
设置后使用 `${WEB_AGENT_CONFIG_DIR}/config.json`，不读取任何 API Key 环境变量。

为避免已有用户在升级后丢失模型 Key 或 MCP 配置，默认路径下当新文件不存在且旧文件存在时，
安全复制旧 `~/.web-agent/config.json` 到新位置；新文件优先，覆盖目录不触发迁移，旧文件不删除。
`.agent/skills` 仍是项目 Skills 目录，不是用户配置目录，也不参与本功能。

非目标：把 `.webAgent` 当作环境变量名（POSIX shell 不支持 `.`）；迁移或删除项目
`.agent` 目录；从环境变量读取 API Key；迁移浏览器 localStorage；删除旧用户配置目录。

## 任务树

```text
WEBAGENT-CONFIG-DIR  默认配置目录迁移
├─ WEBAGENT-CONFIG-DIR-00  路径与迁移契约
│  └─ WEBAGENT-CONFIG-DIR-00A  新默认、一次性兼容复制与安全边界
├─ WEBAGENT-CONFIG-DIR-10  调用方回归
│  ├─ WEBAGENT-CONFIG-DIR-10A  模型凭据默认路径断言
│  └─ WEBAGENT-CONFIG-DIR-10B  MCP 配置默认路径断言
├─ WEBAGENT-CONFIG-DIR-30  用户表述
│  ├─ WEBAGENT-CONFIG-DIR-30A  运行时 UI 配置位置文本
│  └─ WEBAGENT-CONFIG-DIR-30B  文档与历史 Issue 路径事实
├─ WEBAGENT-CONFIG-DIR-80  集成验收
│  └─ WEBAGENT-CONFIG-DIR-80A  聚焦回归、构建与临时目录清理
└─ WEBAGENT-CONFIG-DIR-90  独立审查
   └─ WEBAGENT-CONFIG-DIR-90A  安全与迁移语义审计
```

## 叶子任务与模型分配

| ID | Wave | Owner model | Exclusive files | 目标与验收 | Status |
| --- | --- | --- | --- | --- | --- |
| WEBAGENT-CONFIG-DIR-00A | B1 | gpt-5.6-sol（high） | `apps/desktop/src/web_agent_config_store.rs`、新增迁移专属测试文件 | 默认写入 `.webAgent`；仅无覆盖、新文件缺失时复制旧文件；新文件优先；覆盖目录不读取旧目录；旧文件不删除；保持目录 `0700`、文件 `0600`、原子写和受控错误。新测试文件单一职责且所有普通文件 ≤300 行 | completed |
| WEBAGENT-CONFIG-DIR-10A | B2 | gpt-5.6-terra（medium） | `apps/desktop/src/model_credential_config.rs` | 将默认目录断言改为 `.webAgent`，不改变凭据业务语义 | completed |
| WEBAGENT-CONFIG-DIR-10B | B2 | gpt-5.6-terra（medium） | `apps/desktop/src/mcp_config_tests.rs` | 将 MCP 默认目录断言改为 `.webAgent`，不改变 MCP 配置语义 | completed |
| WEBAGENT-CONFIG-DIR-30A | B1 | gpt-5.6-luna（medium） | `apps/web/src/agentNew/ui/ModelCredentialPanel.tsx` | 将界面中的配置位置替换为 `.webAgent`；不调整状态或交互 | completed |
| WEBAGENT-CONFIG-DIR-30B | B1 | gpt-5.6-luna（medium） | `README.md`、`CLAUDE.md`、`docs/config-directory-override.md`、`docs/startup-model-credential-gate-blueprint.md`、`docs/ROADMAP.md`、`docs/README.md` | 更新所有可安全修改的用户/工程文档为真实路径与迁移语义，明确 `.agent/skills` 无关、环境变量仅选择目录且无 Key fallback；不触及主工作区已有脏改动的 MCP Issue | completed |
| WEBAGENT-CONFIG-DIR-80A | B3 | gpt-5.6-sol（high） | 无生产文件；可新增独立集成测试 | 在输入冻结后运行迁移、凭据、MCP 聚焦测试及构建；确认 worktree 与验证临时目录可安全清理 | completed |
| WEBAGENT-CONFIG-DIR-90A | B3 | gpt-5.6-sol（high，非实现 Owner） | 只读审查 | 审查优先级：不读取 Key 环境变量、迁移不覆盖新文件/不删除旧文件、覆盖目录隔离、错误不泄露路径或密钥、变更未混入现有 MCP 脏改动 | completed：无 P0/P1 |

## 并发与交付规则

- 所有实现都在独立 worktree 分支 `feat/webagent-config-directory-migration` 完成；主工作区现有 MCP 脏改动完全排除。
- 00A 独占 Rust 存储模块直到冻结；10A/10B 只能在其契约冻结后开始。30A/30B 与 00A 可并行。
- 不得暂存或提交主工作区的现有改动。根协调者只会显式暂存已审查文件、创建迁移提交、合并 worktree 分支。
- 交付后移除本次 worktree；仅删除本次创建且经 `git worktree list` / 路径核对确认的临时目录，不删除 `~/.web-agent` 或用户的任何配置目录。

## 验证计划

- `cargo test --manifest-path apps/desktop/Cargo.toml web_agent_config_store`
- `cargo test --manifest-path apps/desktop/Cargo.toml model_credential_config -- --test-threads=1`
- `cargo test --manifest-path apps/desktop/Cargo.toml mcp_config -- --test-threads=1`
- `pnpm build`
- `node scripts/check-docs.js`
- `git diff --check`
- `rg -n 'var_os|WEB_AGENT_CONFIG_DIR|API_KEY' apps/desktop/src`，确认目录覆盖不扩展为 Key 来源。

## 审查记录

- 80A：存储迁移 19/19、模型凭据 5/5、MCP 9/9 通过；文档检查和 diff 检查通过。临时 worktree 没有 `node_modules`；合并后的主工作区 `pnpm build` 已通过。
- 90A：默认路径、一次性兼容复制、覆盖目录隔离、0700/0600 权限、固定错误和无 API Key 环境变量读取均符合契约；无 P0/P1。P2：两份未改的历史 Issue 仍描述旧路径，留作独立文档清理。
