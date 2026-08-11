# 配置目录环境变量 Issue

状态：已完成
创建日期：2026-08-11
协调者：gpt-5.6-sol（high）

## 目标与边界

为需要同时运行多套 Web Agent 桌面配置的用户提供 `WEB_AGENT_CONFIG_DIR`。该变量只选择 `config.json` 所在目录：未设置时保持 `~/.web-agent/config.json`；设置时使用 `${WEB_AGENT_CONFIG_DIR}/config.json`。

覆盖值必须是非空绝对路径。无效值必须返回受控错误，不能静默退回默认目录，以免把凭据写进错误位置。此变量不是 API Key 来源：不得读取 `DEEPSEEK_API_KEY`、`GLM_API_KEY`、`KIMI_API_KEY` 或任何其他密钥环境变量；目录 `0700`、文件 `0600` 与原子写入语义必须保持。

非目标：不迁移默认目录，不改变浏览器或开发中继配置，不支持环境变量指定单个 Key 或 `config.json` 文件名。

## 任务树

```text
CONFIG-DIR  桌面配置目录覆盖
├─ CONFIG-DIR-00  路径契约
│  └─ CONFIG-DIR-00A  解析目录覆盖并保持安全读写
├─ CONFIG-DIR-01  覆盖目录安全性
│  └─ CONFIG-DIR-01A  拒绝会改变已有普通目录权限的覆盖值
├─ CONFIG-DIR-30  用户说明
│  └─ CONFIG-DIR-30A  编写多配置实例的启动与隔离说明
├─ CONFIG-DIR-31  文档事实校正
│  └─ CONFIG-DIR-31A  移除未实现的 MCP 隔离声明
└─ CONFIG-DIR-90  独立审查
   └─ CONFIG-DIR-90A  审查安全边界与回归证据
```

## 叶子任务与模型分配

| ID | Wave | Owner model | Exclusive files | 目标与验收 | Status |
| --- | --- | --- | --- | --- | --- |
| CONFIG-DIR-00A | B1 | gpt-5.6-sol（high） | `apps/desktop/src/web_agent_config_store.rs`、新增 `apps/desktop/src/web_agent_config_store_tests.rs` | `WEB_AGENT_CONFIG_DIR` 是唯一目录覆盖；unset 保持默认；绝对路径指向其 `config.json`；空/相对路径受控失败；测试不改全局进程环境，并证明读写、目录及文件权限均走选择路径 | completed：实现与聚焦测试完成 |
| CONFIG-DIR-01A | B1R | gpt-5.6-sol（high） | `apps/desktop/src/web_agent_config_store.rs`、`apps/desktop/src/web_agent_config_store_tests.rs` | Unix 下覆盖目标若已存在，必须是私有 `0700` 目录，否则在写入前受控失败且权限不变；不存在的目录仍由安全写入创建。测试覆盖拒绝与无副作用 | completed：P1 已关闭 |
| CONFIG-DIR-30A | B2 | gpt-5.6-luna（medium） | 新增 `docs/config-directory-override.md` | 只说明已实现的目录选择、macOS/Linux 启动示例、默认与隔离语义；明确不是 API Key 环境变量 | completed：文档检查通过 |
| CONFIG-DIR-31A | B2R | gpt-5.6-luna（medium） | `docs/config-directory-override.md` | 只陈述目前确实落盘到该文件的模型凭据；不得声称 MCP 已隔离；补充覆盖目录须为专用目录及权限行为 | completed：P1 已关闭 |
| CONFIG-DIR-90A | B3 | gpt-5.6-sol（high，非实现 Owner） | 只读审查，可新增独立测试 | 检查默认回归、覆盖值校验、无 Key 环境变量读取、错误不泄露敏感值；回填 P0/P1/P2 与命令证据 | completed：P0/P1 均关闭 |

## 并发与交付规则

- B1 只允许 CONFIG-DIR-00A 改动 Rust 共享配置存储及其专属测试。`web_agent_config_store.rs` 当前 281 行，必须先把内联测试拆到专属测试模块，成品每个普通文件均不得超过 300 行。
- B1R 只允许 CONFIG-DIR-01A 修改与 00A 相同的存储文件和专属测试，以消除审查确认的路径权限副作用。
- B2R 只允许 CONFIG-DIR-31A 更正文档事实，不能修改代码或 Issue。
- B2 在 B1 冻结环境变量名与语义后开始，不能修改 Rust 或入口代码。
- B3 在代码与文档冻结后只读审查；如有 P0/P1，先在本文新增修复 leaf、分配新 Owner，再修复。
- 本功能在独立 worktree 分支 `feat/config-directory-override` 完成；主工作区的未提交 MCP 改动不属于本功能，不得暂存、修改或提交。

## 验证计划

- `cargo test --manifest-path apps/desktop/Cargo.toml web_agent_config_store`
- `cargo test --manifest-path apps/desktop/Cargo.toml model_credential_config`
- `pnpm build`
- `node scripts/check-docs.js`
- `git diff --check`
- 独立代码搜索确认 Rust 只读取 `WEB_AGENT_CONFIG_DIR` 用于目录选择，不读取 API Key 环境变量。

## 审查记录

- CONFIG-DIR-90A：默认路径、绝对路径覆盖、空/相对值失败、无 API Key 环境变量读取与 Unix 权限均已复审；P0/P1 已关闭。
- 非阻塞 P2（不属本功能 diff）：`model_credential_config` 的既有测试临时目录只由 PID 与时间戳命名，并发全组偶发碰撞；单测重跑通过，后续另行建 Issue 处理。
- 交付验证：配置存储测试 13/13、凭据测试串行 5/5、`pnpm build`、文档检查与 `git diff --check` 均通过。
