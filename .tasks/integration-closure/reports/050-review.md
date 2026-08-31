# 050 最终独立审查

结论：**APPROVED**

审查基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

本次只读五棵功能树及 integration 010/020/030/035/040/050 的任务、报告、最终 review，并审阅相对基线的完整任务范围 diff；未重跑报告中的验收命令，未修改产品文件，未 commit/publish/push/upload，也未读取 secrets。明确排除了 `.project-lines/**`、`CLAUDE.md`、`UndoBar.tsx`、`UndoBar.test.tsx`、`agentnew.subagent-trace.css`、ignored build/runtime artifacts 与未声明的 `apps/desktop/gen/schemas/*`。

## Findings

### Critical

无。

### Important

无。

### Minor

1. 根 `.gitignore` 新增 `apps/target` 与 `apps/desktop/target`，但不在五树任务声明中，且文件末尾缺少换行。桌面树已经有自己声明并审过的 `apps/desktop/.gitignore`；根文件不应随本交付提交，除非维护者另行确认并单独处理。
2. `agentnew.shell.css` 将侧栏样式搬到新文件 `agentnew.workspace-sidebar.css`，并由 `agentnew.css` 新增 import；这组三文件改动未出现在任一任务文件的 files 清单中。它们必须作为一个不可拆的原子组处理：本次建议全部排除（同时不暂存该 import hunk）；若维护者确认要纳入，则三者必须一起提交。`agentnew.css` 删除 UndoBar 注释的 hunk 属明确排除的既有改动，同样不要暂存。
3. `packages/agent-core/src/runtime/core/createCore.test.ts` 当前 306 行，是基线 305 行上的一行小改；属于存量超限，不是本轮新增/大改文件违规。其余新增或大改普通文件未见超过 300 行；锁文件、PO 与 generated schema 属规则例外。

## 验收逐项判定

- 跨树协议一致：DeepSeek 文件引用、provider route、host/runtime 命令与 UI 投影使用同一组显式 provider/model/profile 身份；未知模型与非目标 provider 均 fail closed，未见把 OpenAI-compatible 路由误当官方适配器的旁路。
- DeepSeek vision：上传批次校验 purpose，部分失败回滚；消息投影只接受已验证的文件引用；discard/retain 去重后 best-effort 清理。图片查看请求隔离历史与工具，结束路径清理文件。PNG/JPEG/WebP 静态容器检查集中在共享策略，低清限制尺寸、高清保留原图，动态/不支持容器保守失败。
- model profiles：持久化 manifest 只含非敏感元数据并拒绝额外字段；credential 与 profile 在同一配置事务内更新/删除；转发从同一锁定快照绑定 origin 与 credential。API key 仅在瞬态草稿/credential section 中流转，日志、公开状态与导出 manifest 未见泄露。
- thinking projection：能力按精确模型身份解析；DeepSeek/GLM 的具体 effort 只投影到对应适配器，关闭、未知模型及兼容路由不泄露参数。会话运行中更新受阻并持久化选择；UI 切换保留模型身份并清洗不支持 effort。
- Lingui：035 的最终证据为两份 482-entry catalog、无空翻译/fuzzy/obsolete、English Missing 0，extract 前后 hash 一致。真实 `I18nProvider` 测试覆盖应用入口，动态文本仍通过变量插值而非冻结 fixture；未见测试替换生产 provider 来掩盖缺陷。
- Tauri/CI：薄壳只负责 sidecar 启停与三模式转发；token 不进入 URL/日志。静态 guard 对词法绑定、赋值目标与动态 import/computed require 保守失败。release workflow 的 PR/非 tag 路径不注入 secrets 且不 upload/publish，tag/version、签名/公证 prerequisites、Apple Silicon matrix/staging/build target 与 Rust target 安装顺序一致。
- 测试可信度：相关回归测试直接穿过生产入口、host/runtime transaction、request projection 和静态分析器；未发现仅复制实现逻辑、跳过真实 provider 或用宽松 mock 掩盖生产 bug的新增 Critical/Important。
- 账本一致：030 的 BLOCKED 是发现 catalog 漂移与类型职责问题的历史结论；035、040 均已 DONE/APPROVED，050 报告从稳定状态重跑全门并记录全绿。各功能树历史 REJECTED 均有明确后继 R1/R2 或接管任务 supersede。

## 明确可提交范围建议

1. 以五棵功能树任务 frontmatter 的产品/测试/docs/config 文件、integration 010/020/040 的修复文件，以及对应 `.tasks` 任务/index/report/review 为正向白名单；所有 untracked 源文件必须显式加入，不能只提交 tracked diff。
2. 必须一并包含直接 import/runtime 依赖：`agentnew.model-connections.css`、`agentnew.model-providers.css`、`agentnew.language-switcher.css`、`agentnew.app-shell-header.css`，以及 desktop workflow、Rust crate/sidecar、vision tool package、Lingui catalogs/config 和新增类型拆分文件。漏掉任一新 CSS/imported module、Cargo/package lock 变更或 generated Lingui JS 会使构建或运行结果偏离已验收状态。
3. 明确排除用户指定的既有改动、ignored artifacts、`apps/desktop/gen/schemas/*` 和根 `.gitignore`。对 `agentnew.css` 使用 hunk staging，排除 UndoBar 注释删除及未纳入的 workspace-sidebar import；同时排除 `agentnew.shell.css` 与 `agentnew.workspace-sidebar.css`。如决定接受侧栏拆分，则反向将后三者作为单独原子提交。
4. 暂存后应以 `git diff --cached --name-status` 再核对一次：不得出现上述排除项，不得遗漏任何被已暂存文件静态 import 的 untracked 文件；随后才适合提交。

在按上述边界暂存的前提下，当前交付没有未关闭的 Critical 或 Important。
