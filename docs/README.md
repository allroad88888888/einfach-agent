# 文档导航

代码、根目录 [`README.md`](../README.md) 与 [`CLAUDE.md`](../CLAUDE.md) 是项目现状的第一事实源。
本目录只保留当前运行说明，以及尚未完成的演进蓝图；已完成的阶段性 PLAN 通过 Git 历史追溯。

## 当前实现说明

| 文档 | 适用范围 |
| --- | --- |
| [核心运行时流程](core-runtime-flow.md) | 应用装配、模型循环、工具调用、执行图、暂停恢复、状态与持久化 |
| [Planning Runtime](planning-runtime.md) | 结构化计划、审批、阶段执行与产出留痕 |
| [树形子 Agent Runtime](tree-subagent-runtime.md) | delegation、权限、预算、archive、后台执行与治理脚本 |
| [Context Caching](context-caching.md) | provider 自动缓存契约、profile/epoch、usage 归一化与观测 |
| [模型适配器兼容性契约](model-adapter-compatibility.md) | DeepSeek/GLM 的已验证请求差异、Rust 参考的适用边界与新增 vendor 准入项 |
| [MCP 集成](mcp-integration.md) | 连接生命周期与按需连接、透明连接、静态凭据（headers/env）、配置文件存储、失败分类与自愈、工具清单缓存、单次运行内的工具集、起进程确认与安全边界 |
| [插件上手：20 分钟写一个外部插件](plugin-quickstart.md) | 从零写 `plugin.json` + 单文件 ESM 入口、放进 `.webAgent/plugins/`、用 CLI 验证生效；当前边界（工具默认不可见、renderer 待桌面接线、浏览器预览不支持） |
| [用户配置目录](config-directory-override.md) | 默认 `~/.webAgent/config.json`、旧配置安全复制、`WEB_AGENT_CONFIG_DIR` 多实例隔离与密钥边界 |
| [Tauri 卡顿诊断日志](performance-diagnostics.md) | 长对话、plan 更新、大文件写入的分段耗时与前后端关联排障 |
| [工具规范](../packages/agent-core/src/tools/TOOLS-SPEC.md) | Tool、Registry、ToolContext、安全边界与新增工具约定 |

这些文档必须与当前 pnpm workspace、代码接口和测试同步更新。

## 演进蓝图

| 文档 | 状态 |
| --- | --- |
| [结构优化蓝图（按并发批次）](structure-optimization-blueprint.md) | 已完成：B1–B7 共 33/33；R7 前置 `81509c0`、终拆 `338285f`，完成记录可由 Git 历史追溯 |
| [Core 插件化蓝图](core-plugin-extraction-blueprint.md) | 部分实施；hook、插件工具、订阅与多实例隔离已收口，公开受限命令已具备；UI 协议以独立蓝图为准 |
| [插件扩展面产品化蓝图](plugin-productization-blueprint.md) | P2.1–P2.4 已完成：Core 私有安装、真实 run 生命周期、请求/工具 hook、显式停止决定、受限命令与非 React 样板 |
| [插件 UI Renderer 协议蓝图](plugin-renderer-protocol-blueprint.md) | P2.5 的 R1–R4 已完成（`846743a`、`a2b8d97`、`66072f3`、`79bde78`）：Core 导出无 React 的时间线投影，React 包提供 root 隔离 registry 与受限 UI 插件安装面，Web 保留既有交互；R5 的 [持久化 item RFC](persistent-plugin-timeline-item-rfc.md) 已起草，待协议批准 |
| [自定义持久化 Timeline Item RFC](persistent-plugin-timeline-item-rfc.md) | R5 设计门槛：版本化 envelope、checkpoint/SQLite/IndexedDB 兼容、archive 隔离、最小写入权限与 Web/CLI/server 安全降级；尚未开放实现 |
| [Skills 树形结构与稳定前缀清单](skills-tree-blueprint.md) | 阶段 1–3 已实施：L3 资源树、B04/B05 行为门禁通过、全量清单进稳定前缀、harness 预筛已退役；阶段 4 拆出为下一行 |
| [项目内 Skills 自动加载（`.webAgent/`）](project-skills-blueprint.md) | 阶段 A–D、F 已实施：workspace 与用户主目录下的 `.webAgent/skills` 与 `.claude/skills` 自动进 L1 清单（前缀 `project/` 与 `user/`），正文与资源经 `skill_read` 按需读；阶段 E（行为 eval）可选未做 |
| [图片输入协议 RFC](image-input-rfc.md) | Provider-neutral 图片内容、adapter 所有权、提交事务、持久化降级与宿主安全边界；已实现，真实 Key 联调前门禁关闭 |
| [Kimi Provider 接入蓝图](kimi-provider-integration-blueprint.md) | Kimi（实际 API ID `kimi-k2.6`）接入的本地树形 Issue、依赖批次、逐项执行模型与开放门禁；代码完成、50B 静态审查完成，最终验收随 50A 阻塞，当前 NO-GO |
| [启动模型密钥门禁 Issue](startup-model-credential-gate-blueprint.md) | 已完成：进入桌面主界面前按恢复会话的模型检查默认 `~/.webAgent/config.json`；默认新文件缺失时安全复制旧配置，缺失目标 Key 则用不可跳过的输入门禁阻塞工作区，并记录逐 leaf 模型分配、验证证据与独立审查结论 |
| [上下文缓存成本治理](context-cache-cost.md) | 压缩投影复用已实现、收益待实测；含账单归因方法与验证 SQL |
| [上下文缓存成本 · 后续跟进项](context-cache-followups.md) | F1 实测验证（最高优先）、F2 尾巴失效归零、F3 会话过长提示；F5 跨 run 复用暂不做，C1/C2 已关闭并附结论 |
| [请求组装归因交接（2026-08-04）](context-cache-request-assembly-handover-2026-08-04.md) | 已证实的低命中来源、trace 入口、接手实施顺序与复测口径 |
| [MCP 透明连接蓝图](mcp-transparent-connect-blueprint.md) | 已实施（D0–D4）：缓存清单注册为占位工具、按需透明连接、起进程确认与 reconcile 的复用规则、`connect_mcp_server` 的新分工与上下文预算；正文作为设计记录保留 |
| [项目路线图](ROADMAP.md) | 阶段 0–4 已完成的交付与验收记录；后续仅在获得明确授权后推进 R5 协议实现、可选行为评测或新的路线图条目 |
| [core 公开面收敛盘点](core-public-surface-audit.md) | 盘点阶段，无实现：`@web-agent/core` 是唯一带 `exports` 通配的包，实测 68 条深导入子路径（非测试 63 / 测试 37）全部构成公开承诺；含五类归类、8 条疑似内部泄漏点名、68→9 的白名单方案、barrel 与 exports 两步走迁移，以及 17 张卡的拆分建议；发包蓝图 G4 的前置 |
| [core 公开面收敛 Issue 树](core-surface-issues.md) | 步骤 1 + S11 委派接缝整形完成：九条 barrel、白名单门禁、批次执行段下沉 core、packages/subagents 深导入归零、T 线八项超限拆分；仅余 S10（删通配，GATED 至首次发包批次） |
| [npm 发包准备 Issue 树](publish-prep-issues.md) | 执行中：E2 蓝图 G1–G13 的准备段（构建产物 / ?raw 内联 / 元数据 / 依赖修正 / 产物冒烟）；不含任何 publish 动作，发布键与 S10 由用户触发 |
| [Node 宿主与 Web 自托管 Issue 树](node-host-issues.md) | 执行中（H 线 6/12）：把浏览器版做成能力完整的本地自托管应用——core 的 Tauri invoke 抽成可注入 host bridge，能力实现收敛为一份 `packages/host-node`（约 4700 行 TS），经 `apps/server` 服务浏览器与 CLI，Tauri 最终退成 sidecar 套壳，npm 分发不需要任何签名证书；66 卡分十条线，MVP 路径 50 卡，三项未决待拍板 |
| [插件生态蓝图](plugin-ecosystem-blueprint.md) | 设计阶段，无实现：把 assembly-time 插件产品化为 `.webAgent/plugins/` 动态加载的用户插件——加载协议与错误隔离、借鉴 MCP 起进程确认的信任模型、启停与 plugin id 归因、npm 分发前置；`timeline.persist` 阻塞于 R5；默认信任姿态、首期宿主与模型可见工具三项待用户拍板 |

蓝图描述目标形态，不代表所有 API 都已交付。引用蓝图时需要同时核对实现和测试。

## 维护约定

- 包管理与脚本统一使用 `pnpm`；应用放在 `apps/*`，Agent 包放在 `packages/*`，
  工具包放在根级 `tools/*`。
- 文档使用仓库相对链接，不记录开发机绝对路径。
- 新增或移动 runtime 能力时，同步更新本索引和对应当前说明。
- 阶段性 PLAN 完成后从工作树删除，需要时从 Git 历史读取。
- 环境变量只记录应用实际读取的键；浏览器侧 `VITE_*` 值视为公开构建数据。
