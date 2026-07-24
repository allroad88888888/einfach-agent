# 项目路线图

更新时间：2026-07-24。

这份路线图面向当前 `feat/agentnew-rewrite` 架构。它只安排尚未收口的工作，不重复已经完成的
workspace 拆包、Planning Runtime、树形子 Agent 和 Tauri 基础桥接。

## 目标

1. 让 `createCore()` 成为真正可并行嵌入的隔离实例。
2. 把现有插件接口从 loop hook 扩展为可交付的 Core 扩展面。
3. 收紧生产密钥、桌面权限、发布和回归验证链路。
4. 控制前端包体与长期 archive 的运维成本。

## 阶段 0：CI 与文档校验

优先级：P0，建议先完成。

- 为 Markdown 增加相对链接与旧源码路径检查。
- 在 CI 固定执行 `pnpm test`、`pnpm build` 和 Rust bridge 测试。

pnpm workspace、环境变量说明、当前架构文档和历史 PLAN 清理已经完成；本阶段只剩自动化护栏。

验收标准：

- CI 能阻止失效文档链接和构建/测试回归。
- 新增文档不能重新引用旧源码目录、npm 命令或已删除的阶段性 PLAN。

## 阶段 1：Core 多实例隔离收口

优先级：P0。

当前 `CoreInstance` 已隔离 root/session store、工具 registry、abort registry 和 config，但源码仍明确标注
Planning 与子 Agent 路径中的 `defaultCore` 缺口。

- 让 Planning 的 getter、writer、审批和 evaluation 全程显式接收当前 core。
- 让 delegation 的权限检查、子节点工具调用和 archive 收尾使用父 run 所属 core。
- 完成剩余穿线，并补充两个 core 同时运行的 Planning、持久化和子 Agent 集成测试。
- 明确默认单例兼容层：旧导出只代理 `defaultCore`，新嵌入方统一使用 `createCore()`。

验收标准：

- 两个相同 session id 的 core 可并发规划、调用工具和派发子 Agent，状态与权限互不串台。
- 独立实例测试不依赖重置 `defaultCore` 才能通过。
- 默认应用行为与现有 UI、持久化格式兼容。

## 阶段 2：插件扩展面产品化

优先级：P1，依赖阶段 1。

现有插件层已支持 loop hooks、`registerTool` 和订阅意向；剩余工作应围绕真实使用场景推进：

- 把订阅绑定和 dispose 生命周期接入每次 run，而不只停留在装配与单测层。
- 设计不产生循环依赖的 command facade，绑定当前 `CoreInstance`。
- 评估 `registerRenderer` 是否由 Core 提供稳定 item 协议、由 React 宿主维护 renderer registry。
- 先迁移一个垂直能力作为样板，并验证插件卸载、异常隔离和注册冲突策略。

验收标准：

- 一个外部包可以注册工具、观察状态并调用受限命令，不导入 Core 内部 store。
- 插件 teardown 后没有残留订阅或工具。
- UI 扩展不让 `agent-core` 依赖 React。

## 阶段 3：安全与发布闭环

优先级：P1，可与阶段 2 部分并行。

- 生产桌面版将模型凭证移出前端构建产物，优先使用 Tauri 后端或系统凭证存储。
- 为 shell、文件写入、Git 和 child capability 增加跨平台权限回归矩阵。
- 建立 Windows、macOS、Linux 的目标平台构建与签名流程。
- 明确 Web 预览只提供无 `server` 工具的降级能力，并增加能力探测测试。

验收标准：

- 发布包和 Web 静态资源不包含生产 API Key。
- 危险能力必须经过现有确认/授权边界，子 Agent 不能扩大父节点权限。
- 每个平台都有可复现的构建产物和最小启动冒烟测试。

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

## 推荐执行顺序

```text
阶段 0 基线
   ↓
阶段 1 多实例隔离
   ↓
阶段 2 插件化 ─────┐
                   ├─→ 阶段 4 性能与长期运行
阶段 3 安全发布 ───┘
```

每个阶段开始前，应把条目拆成独立变更：先补失败测试或可观测证据，再实现最小闭环，最后更新当前说明。
