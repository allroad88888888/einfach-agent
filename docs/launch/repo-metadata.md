# GitHub 元信息文案草稿

仓库已 public（`github.com/allroad88888888/einfach-agent`），但 GitHub 页面的 description
为空、topics 为空。本文档给出可直接粘贴到仓库 Settings 的候选文案，供拍板后由维护者手动填写；
本文档本身不触发任何发布动作。

事实核对基准：[`README.md`](../../README.md) 与 [`CLAUDE.md`](../../CLAUDE.md)。

> **命名已拍板**：统一 einfach 系——显示名 **Einfach Agent**，GitHub 仓库维持
> `einfach-agent`，npm scope 未来走 einfach 系（发包时才实际改包名），详见
> 推广发布 issue 树（已完成，全文随 Git 历史归档） 的"未决"章节。本文档已按此定稿替换全部
> `<项目名>` 占位与"待拍板"表述。

## 1. Description 候选

GitHub 仓库 description 是全局唯一、无版本历史的一句话。命名已拍板，建议直接使用下方
"定稿"候选正式填入；命名拍板前起草的通用表述（不含项目名）保留作备选，供后续需要通用
表述时参考。

### 中文（≤100 字符）

| # | 候选文案 | 字符数 |
| --- | --- | --- |
| 1（定稿） | Einfach Agent，装配式 Agent Runtime 开发者框架：可插拔内核驱动 Web、Tauri 桌面与 CLI 三宿主，支持 DeepSeek、GLM | 83 |
| 2（备选） | 装配式 Agent Runtime：一个可插拔内核驱动 Web、Tauri 桌面与 CLI 三种宿主，支持 DeepSeek、GLM 双模型 | 70 |
| 3（备选） | 可插拔 Agent Runtime 内核，一套代码驱动 Web、Tauri 桌面、CLI 三种宿主，树形子 Agent 与 MCP 内置 | 68 |
| 4（备选） | 装配式 Agent Runtime：工具/插件/观测/持久化全可插拔，Web、Tauri、CLI 三宿主一体，原生适配国产模型 | 63 |

定稿候选 1 的理由：在原推荐候选（现表中候选 2）基础上补入产品名 Einfach Agent 与"开发者
框架"定位，对齐已拍板主打故事"开发者框架（装配式内核）"，同时保留三宿主覆盖面与已验收可用的
DeepSeek/GLM 模型；不提 Kimi——Kimi adapter 已实现但真实 Key 验收前公开门禁保持关闭，详见
[`README.md`](../../README.md) "模型接入"一节，避免在门面文案上认领未对最终用户交付的能力。
候选 2/3/4 为命名拍板前起草的通用表述，不含项目名，保留作备选。

### 英文（≤120 characters）

| # | 候选文案 | 字符数 |
| --- | --- | --- |
| 1（定稿） | Einfach Agent ("simple" in German): a composable-core framework for Web, Tauri desktop & CLI, with DeepSeek/GLM support | 119 |
| 2（备选） | A composable agent runtime core powering Web, Tauri desktop, and headless CLI hosts with DeepSeek/GLM support | 110 |
| 3（备选） | Pluggable Agent Runtime core: swappable tools, hooks, and observability across Web, Tauri desktop, and CLI hosts | 113 |
| 4（备选） | One assemblable core, three hosts (Web/Tauri/CLI): pluggable tools, tree-shaped subagents, MCP, and trace viewer | 113 |

定稿候选 1 与中文定稿候选 1 对齐，保持中英文 description 传达同一定位；额外点出 Einfach 是
德语"简单"，呼应"装配式内核"追求的极简可插拔理念。候选 2/3/4 为命名拍板前起草的通用表述，
保留作备选。

## 2. Topics 候选（≤20，按优先级排序）

全部为小写连字符格式，可直接粘贴进 GitHub Topics 输入框。排序依据：定位准确度优先，其次是
预期搜索流量；越靠前建议优先添加，凑不满 20 个也应保证前 10 个都在。

| 优先级 | topic | 理由 |
| --- | --- | --- |
| 1 | `ai-agent` | GitHub 上 agent 类项目最高频检索词，扩大自然发现面 |
| 2 | `agent-framework` | 准确对应"装配式内核 + 可插拔工具/插件"的框架属性 |
| 3 | `agent-runtime` | 直接对应 README 自我定位"Agent Runtime"，精确匹配 |
| 4 | `llm` | 覆盖泛 LLM 应用开发者的通用检索习惯 |
| 5 | `tool-use` | 工具契约/registry 是内核的核心机制，见 [`TOOLS-SPEC.md`](../../packages/agent-core/src/tools/TOOLS-SPEC.md) |
| 6 | `mcp` | 已实现 MCP 应用层集成，见 [MCP 集成](../mcp-integration.md) |
| 7 | `model-context-protocol` | MCP 全称，覆盖两种搜索习惯（缩写与全称） |
| 8 | `deepseek` | 已验收可用的国产模型，精准引流真实用户 |
| 9 | `glm` | 已验收可用的国产模型（智谱 GLM） |
| 10 | `subagent` | 树形子 Agent 治理是差异化能力，见 [树形子 Agent Runtime](../tree-subagent-runtime.md) |
| 11 | `tauri` | 桌面宿主技术栈，吸引 Tauri 生态开发者关注 |
| 12 | `desktop-app` | Tauri 桌面是"完整产品形态"的目标宿主 |
| 13 | `typescript` | Web/Core/工具域主力语言，覆盖 TS 生态检索 |
| 14 | `rust` | Tauri 桥接层语言，吸引 Rust 开发者 |
| 15 | `react` | Web UI 技术栈 |
| 16 | `cli` | headless CLI 是三宿主之一，`pnpm cli` 已可跑真实 run |
| 17 | `observability` | trace viewer、CallTiming 投影是内核内建能力 |
| 18 | `plugin-architecture` | 压缩、finish reason、loop guard 等横切行为均以插件 hook 实现 |
| 19 | `pnpm-workspace` | 仓库以 pnpm workspace 组织多包，吸引 monorepo 关注者 |
| 20 | `kimi` | Kimi adapter 已实现（`kimi-k2.6` 与图片输入），但真实 Key 验收前门禁关闭，故排最后仅做长尾覆盖 |

`kimi` 特别说明：与其余 topics 不同，它对应的能力目前对最终用户不可见（公开门禁关闭），列入
候选仅因代码已交付、供仓库访客了解技术方向；若追求"topics 只反映已对外交付的能力"这一更严格
标准，可以直接从候选列表删去这一条，不影响其余 19 个。

## 3. About 区建议

### Website 留空处理

建议**暂时留空**。原因：

- 没有可公开访问的托管 Demo——Web 预览是本地 `pnpm dev` 起的开发服务器，且真实模型 Key 只能
  由桌面原生层读取，静态 Web 部署没有可信模型代理、不能直接调用模型服务（见
  [`README.md`](../../README.md) "配置模型"一节）。
- `docs/` 目前是仓库内 Markdown，没有独立发布的文档站点。

待有以下任一产出后再回填：一个只做展示、不接真实模型 Key 的只读 Demo 页面；或者一个独立发布的
文档站点（例如 GitHub Pages）。这两项目前都不在已交付范围内，不在本卡处理。

### Release 展示建议

当前仓库还没有推送过任何 tag（`git tag` 为空），GitHub 侧的 Releases 区会自动显示"暂无
release"，**不需要手动处理**。已有的发布流水线是 [`release-desktop.yml`](../../.github/workflows/release-desktop.yml)：
推送与 `apps/desktop/tauri.conf.json` 版本一致的 `app-v<version>` tag 会触发四平台构建并产出
GitHub Draft Release，需要发布负责人手动复核后发布，完整步骤见 [Desktop 发布与签名](../release-signing.md)。
在推送第一个 `app-v*` tag 并手动发布 Draft 之前，Releases 区保持自动的空状态即可，无需在 About
设置里额外配置。

### Packages 展示建议

仓库所有内部包都是 `workspace:*` 私有包（`package.json` 标 `"private": true`），当前没有任何
包发布到 npm registry 或 GitHub Packages，因此 About 侧栏的 Packages 区会自然保持空白，**同样
不需要手动处理**。发包方案仍在起草（见 推广发布 issue 树（已完成，全文随 Git 历史归档） 的 E2
"npm 发包方案蓝图"，状态 DOING），在该蓝图交付并真正执行首次 `npm publish` 之前，不要在 About
区做任何 Packages 相关的手动配置或预告性文案。

## 4. 社交预览图（Social Preview）建议

一句话：命名已拍板，建议直接设计正式社交预览图——**Einfach Agent** 品牌字样 +
"装配式 Agent Runtime 开发者框架"一句定位语 + 三宿主图标示意 Web/Tauri/CLI，随
README/主打故事一起产出成品图，不再需要过渡用的占位图。
