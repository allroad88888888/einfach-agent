# 项目路线图

更新时间：2026-08-03。

这份路线图面向当前 `feat/agentnew-rewrite` 架构。阶段 0 的 CI/文档护栏、阶段 1 的
Core 多实例隔离与结构优化蓝图 B1–B7 共 33/33 均已完成；R7 的前置提交为 `81509c0`，
终拆提交为 `338285f`，完成记录通过 Git 历史追溯。阶段 2/3 → 4 是本次结构优化范围之外的后续路线。

## 目标

1. 把现有插件接口从 loop hook 扩展为可交付的 Core 扩展面。
2. 收紧生产密钥、桌面权限、发布和回归验证链路。
3. 控制前端包体与长期 archive 的运维成本。

## 阶段 2：插件扩展面产品化

优先级：P1；Core 多实例隔离已具备。

P2.1–P2.4（至 `7d3f1be`）已完成：插件按 Core 实例安装，工具注册预检为原子操作，订阅与 disposer 已接入真实 run 生命周期；请求与工具 hook 已进入生产路径，`shouldStop` 已收紧为显式停止决定；绑定当前 `CoreInstance` 的最小 command facade 与非 React 垂直样板也已交付。

P2.5 的 UI 协议设计已完成，R1–R4 已按独立、可回退批次交付：

- [插件 UI Renderer 协议蓝图](plugin-renderer-protocol-blueprint.md) 固定了 Core 的无 React
  timeline item 投影、由 React 宿主按 root 维护的 renderer registry，以及 R1–R5 迁移顺序。
- R1 已完成（`846743a`）：现有 `MessageList` 的纯时间线关联逻辑已提取为无 React 的 Core
  公共投影并补回归测试；同时完成投影消费、思考分组、阶段轨迹与虚拟视图模型的前置职责拆分。
- R2 已完成（`a2b8d97`）：`@web-agent/react-plugin` 提供按 React root 隔离的 renderer
  registry；内建 kind 不能覆盖、重复注册原子拒绝、失效 disposer 不会删除后续注册，unknown
  item 以安全纯文本 fallback 显示。
- R3 已完成（`66072f3`）：App root 创建并共享 Web renderer registry，`MessageList` 通过
  dispatcher 呈现全部既有 Core timeline kind，同时保留思考分组、虚拟窗口、流式光标和用户回退。
- R4 已完成（`79bde78`）：`@web-agent/react-plugin` 公开受限的 UI 插件安装面，宿主统一回滚和
  释放 renderer 注册；`@web-agent/plugin-example` 以 Core 根入口与 `/react` 子入口配对示例。
- R5 的 [自定义持久化 Timeline Item RFC](persistent-plugin-timeline-item-rfc.md) 已起草：它固定
  checkpoint 兼容、archive 隔离、最小权限和多 consumer 降级要求；协议批准前不改持久化格式，也不开放插件写入。

验收标准：

- 一个外部包可以注册工具、观察状态并调用受限命令，不导入 Core 内部 store。（已验证）
- 插件 teardown 后没有残留订阅或工具。（已验证）
- UI 扩展不让 `agent-core` 依赖 React。

## 阶段 3：安全与发布闭环

优先级：P1，可与阶段 2 部分并行。

- 生产桌面版将模型凭证移出前端构建产物，优先使用 Tauri 后端或系统凭证存储。（已完成：`c9f764d`；桌面端系统钥匙串与受限模型代理已就位，Web 静态包拒绝直连模型。）
- 为 shell、文件写入、Git 和 child capability 增加跨平台权限回归矩阵。（已完成：`d89c1ea`。）
- 建立 Windows、macOS、Linux 的目标平台构建与签名流程。（已完成：`e90ab14`；PR 在三种
  runner 构建无安装包的原生 build smoke artifact，release tag 生成签名安装包。）
- 明确 Web 预览只提供无 `server` 工具的降级能力，并增加能力探测测试。（已完成：`6b9b08b`。）

验收标准：

- 发布包和 Web 静态资源不包含生产 API Key。
- 危险能力必须经过现有确认/授权边界，子 Agent 不能扩大父节点权限。
- 每个平台都有可复现的构建产物和最小构建冒烟验证。（已完成：`f5e8f60`、`dae85ff` 与
  本提交的三平台无安装包原生构建。）

## 阶段 4：性能与长期运行

优先级：P2。

- 根据构建分析拆分较大的 UI、Markdown/trace 和低频面板代码。
- 为长会话、并发子树和 archive 索引建立容量基准。
- 增加 archive 清理、导出和恢复策略，同时保持审计事件 append-only。
- 记录关键指标：首屏加载、单 turn 延迟、工具耗时、模型调用数和归档写入失败率。

验收标准：

- 主入口 chunk 不再触发当前的 500 KiB 构建警告，低频功能按需加载。
- 长会话和最大允许子树的内存、磁盘增长有可重复的基准结果。
- archive 达到容量阈值时有明确、可审计且不会破坏事件流的治理操作。

## 本次结构优化范围之外的推荐执行顺序

```text
阶段 2 插件化 ─────┐
                   ├─→ 阶段 4 性能与长期运行
阶段 3 安全发布 ───┘
```

每个阶段开始前，应把条目拆成独立变更：先补失败测试或可观测证据，再实现最小闭环，最后更新当前说明。
