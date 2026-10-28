# 410 历史清理与通用性检查（2026-09-21）

## 范围与结论

- 用户要求清理插件会话历史，并检查现有实现是否写死业务。
- 搜索 `browser-agent/{agent,extension,ui}/src` 与 `browser-agent/tools/*/src` 的 93 个生产 TS/TSX 文件，排除测试、fixture、声明和 dist。
- `deepfos / 安全漏洞 / 工单类型 / ai录数 / fixture-cities` 在上述生产源码中的匹配数为 0；同名内容出现在测试/演示中。
- 这不证明所有行为通用。实际问题是识别启发式混入通用层、扩展装配缺少配置，以及 frame 范围限制。
- 本轮不重构 tools 架构；只交付历史管理并记录源码核查与最小复现。

## 需要处理的问题

### 1. 插件注册了没有真实来源的接口选项工具

`browser-agent/extension/src/sidepanel.tsx:20` 将 `createApiToolsHost` 的 sources 固定为 `[]`，并将授权函数固定为 false。
因此扩展中的 `list_options_sources` 必为空，`query_options` 无法查询任何真实来源；Agent 勾选工具也无法改变它。
这是装配缺口：API 工具包本身支持宿主注入 source/query 与按会话授权（`browser-agent/tools/api/src/options-host.ts:72`），不能据此宣称插件已具备业务接口配置能力。

建议：将可序列化的数据源配置归入现有 agent 配置包，由扩展装配成现有 API host；UI 只编辑配置。
保留工具包现有 source 抽象，不增加站点 if/else 或把演示接口注册回生产。

### 2. 通用表单识别把 CSS 命名和布局约定当作语义

- `browser-agent/tools/page/src/dom-logical-controls.ts:83`：类名只要含 `multiple` 就判多选，连显式 `aria-multiselectable="false"` 也会被覆盖。
- `browser-agent/tools/page/src/dom-field-labels.ts:41`：附近标题识别依赖 `*-form-item` / role=group / 外部 label；`:77` 候选还限定为 label、span[title]。
- `browser-agent/tools/page/src/dom-control-roots.ts:13`：div/span + tabindex + label/placeholder/子节点即可能被归为自定义控件；`dom-logical-controls.ts:96` 随即将其命名为 custom-select。
- `dom-logical-controls.ts:30` 与 `dom-field-labels.ts:61` 另以 placeholder/required 类名推断值或必填状态。

最小复现已运行，3 个现象全部确认（源码保存在 `410-heuristics-probe.ts.txt`，运行记录 `410-heuristics-probe.log`）：

| 输入变化 | 当前真实结果 |
| --- | --- |
| role=combobox、aria-multiselectable=false，类名 multiple-columns | kind=combobox-multiple |
| 相同 span[title]+input，容器 x-form-item 改为 x-field | label 从“姓名”变成空字符串 |
| 普通 div tabindex=0 aria-label=帮助说明，含一段说明文字 | kind=custom-select |

这些是通用启发式误判，不是写死了“安全漏洞”。应以原生/ARIA 关系作为明确语义；结构不足时保留 DOM 观察与操作，避免断言为下拉/多选。
组件类名和特殊布局归显式 adapter，不继续向通用层添加组件片段。

### 3. 已有表单 adapter 接口，但插件没有装配它

`browser-agent/tools/page/src/types.ts:21` 定义 `ControlledFieldAdapter`；`:28` 允许通过 `controlledAdapters` 注入。
`dom-fields.ts:43` 优先匹配显式 adapter；嵌入示例 `browser-agent/examples/embedded/src/main.ts:25` 已使用。
但扩展 `browser-agent/extension/src/content-script.ts:13` 创建 host 时未传 adapter，实际始终走默认发现/写入逻辑。

建议：复用这一个接口，在扩展的页面侧组合 adapter；平台/组件适配不进入 DOM 工具核心，也不放在展示包。
未知控件继续通过 read_dom/click_dom/type_dom 等通用操作处理，操作后回读。

### 4. 插件当前固定顶层 frame，不能代表页面里的所有请求/控件

- `browser-agent/extension/src/script-registration.ts:30`：已有标签注入固定 frameIds=[0]。
- `script-registration.ts:39`：两份 document_start 脚本均 allFrames=false。
- `browser-agent/extension/src/page-bridge.ts:116`：会话绑定固定 frameId=0。
- `browser-agent/extension/src/content-script.ts:12`：targetId 固定 main-frame。
- `browser-agent/tools/dom/src/dom-reader.ts:32`：只遍历传入 document 的普通 DOM，不遍历 iframe 文档或 shadow root。

这在当前 README 中已有范围说明，但与“所有请求”不能划等号。
`browser-agent/tools/network/src/window-observer.ts:104` 观察的是当前 window 的 fetch/XHR；不涵盖 worker/WebSocket/图片/浏览器导航。
建议后续扩展宿主的 frame 发现、绑定与路由，复用现有 PageRef；底层工具继续只作用于宿主明确传入的文档。

## 已有合理抽象与不应误判的常量

- DOM 工具对观察到的 ref 操作；读接口接受 scope/selector/text，不含业务字段或目标选项。见 `browser-agent/tools/dom/src/types.ts:19`、`dom-reader.ts:23`。
- page 工具按 PageRef、稳定字段 id 读写，并验证实际回读；adapter 已提供扩展点。见 `browser-agent/tools/page/src/dom-host.ts:13`。
- 模型连接、Agent instructions/toolNames/skillNames 均来自配置；createSession 固化当次版本。见 `browser-agent/agent/src/client.ts:134`。
- DeepSeek V4.1 Flash/deepseek-flash 是用户此前明确要求的可编辑默认值（`browser-agent/ui/src/settings/ConnectionEditor.tsx:19`），不是锁死模型。
- DOM 合成事件的 isTrusted=false 是当前执行机制的边界，不是业务硬编码。见 `browser-agent/tools/dom/src/dom-actions.ts:12`。

## 本轮历史管理实现

- 设置新增“历史记录”，支持逐条删除和清空当前 client 的会话。
- 运行包 `client.deleteSessions(ids)` 复用 core.removeSession，并等待持久化队列；UI 不直接碰数据库或存储驱动。
- 删除范围是确认时列出的 session ids，不会顺手删除确认后新建的会话。
- Agent、skills、模型连接与凭据配置独立保留。
- 扩展监听会话删除并解绑相应页面；聊天视图不再为已删除会话重建 store。
- 集成测试覆盖取消、指定删除、批量范围、删除后重载、恢复快照清除、配置保留、namespace 隔离。
- 用户回复“do it”确认永久删除后，已在实际 Chrome 点击确认，界面显示“已删除 4 个会话”和“共 0 个会话”。
- 重新加载扩展后复核：会话下拉显示“暂无会话”，历史设置显示“共 0 个会话 / 暂无历史记录”。
- 重载后配置仍显示 ai录数 r2、DeepSeek V4.1 Flash 与“API Key 已配置”；没有读取或改动凭据。

## 验证

- UI、agent 与 page-bridge：16 个测试文件、70 项测试通过。
- 表单启发式最小复现：1 项审计探针通过，确认表格中的 3 种现象；留存为 txt，避免把错误行为固化为正常回归要求。
- 根 TypeScript 检查、agent/UI/extension 构建、边界检查、文档检查、git diff --check 均通过。
- 未修改表单/DOM/API/network 工具行为，未更改或读取用户 API Key，未提交或推送代码。
