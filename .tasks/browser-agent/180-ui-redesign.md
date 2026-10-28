---
id: '180'
title: 浏览器工作台具有清楚导航与精致的窄侧栏界面
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '160'
model: gpt-5.6-sol
status: done
created: 2026-09-20
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/ui/**
  - browser-agent/extension/src/app.tsx
  - browser-agent/extension/src/sidepanel.css
---

# 浏览器工作台具有清楚导航与精致的窄侧栏界面

用户直接反馈“这界面真丑”。160功能补齐已有独立验收，视觉仍是两层重复按钮、浅绿灰大背景、所有按钮实色/描边、默认表单堆砌。此叶完整重塑视图的信息结构/视觉/预览，保留公开client业务行为和19工具。不要只换几个颜色或再添装饰卡片，不改headless运行层，不安装新UI库/字体依赖。

## 设计方向（实现前在报告简要自审再执行）

用户追加明确要求从GitHub下载Apple设计skill使用。编排已用skill-installer下载 `dickwu/apple-design-skill` 固定commit `da2da6dd03aacf06da3fecf205347601d38bb141` 到 `/Users/dol/.codex/skills/apple-hig-design`，并保留原 `/Users/dol/.codex/skills/apple-design` 动效skill。**必须读取并应用新下载的 `/Users/dol/.codex/skills/apple-hig-design/SKILL.md`**，按它的加载表读取本次相关HIG（accessibility/layout/typography/color/designing-for-macos + entering-data/text-fields/buttons/sidebars/或disclosure）。不要运行其scripts/pull-hig.mjs。本项目是Web侧栏，套用HIG层级、分组、字体、间距、焦点及反馈原则，不添加原生macOS菜单/假红黄绿窗控，不为了Apple风格做整片玻璃。
这取代之前仅泛化frontend-design的决策来源。已有配色可按技能审视/微调为中性层次与清楚的重点蓝；给出实际对比度，减少描边与卡片嵌套。浅色优先，同时用语义token提供深色/增强对比/减少动态的合理回退，无需加主题设置界面。短促按下反馈可用CSS，不加动画依赖或拖拽弹簧体系。报告列实际读取的HIG章节和哪些判断是我们自己的。

对象：在业务网页旁边工作的Agent侧栏；单屏职责清楚，让人知道自己在跟哪个Agent工作、在哪里配置模型。
- 配色：纸白 #ffffff、冷灰底 #f6f7fb、墨色 #202532、次级文字 #667085、边界 #e7eaf1、重点蓝 #4059de。状态色按语义少量使用。不要灰绿/奶油色/大渐变/巨型品牌标题。
- 字体：中文与正文使用系统 PingFang SC / system-ui，正文/输入14px，标签13px，帮助文本12px，页面标题18–20px；模型ID等技术值用SFMono-Regular小范围辅助。不加载远程字体。保留可访问对比度和焦点。
- 结构：小而清楚的产品头部（可有一个简洁窗口/光标SVG标识，不用装饰英文kicker）。仅一层主导航：对话 / Agent / 技能 / 模型与Key。模型的可访问名称仍明确“模型与 API Key”；窄屏可用短视觉标签。不要重复“模型与 API Key”按钮两层，不让Agent/技能躲在模型栏目里。
- 内容：页标题/一句用途说明→轻量列表或选择器→重点表单。宽时列表在左、编辑在右；360px紧凑纵向组织，避免空列表巨卡/额外留白。按钮区分主/次/文字/危险，只有当前主要动作强调。
- Agent工作说明和模型选择优先；19项工具改为可展开的能力区域，显示选择数量（有搜索可加，但不扩成新功能）。收起/过滤不能丢已选工具或缺失引用；缺失引用要能被注意到并显式移除，不可静默删除。
- 对话空态用少量有意义的层级与明确行动；有Agent时选择/新建会话紧凑，对话消息/工具状态/输入区统一新样式。保留停止、确认、恢复、undo语义。
- 本次视觉辨识点是顶部简洁工作台导航与紧凑能力配置；其它区域保持克制。不要做营销首页、统计大卡、装饰编号、伪在线状态。

## 实施入口

- `ui/src/View.tsx`：持有panel与settingsSection；160新增WeakMap client身份key重挂内部workspace，必须保留这一隔离。可合并为单个本地activeView消除双层导航；BrowserAgentView公开props保持client/className，不读宿主全局URL控制状态。
- `ui/src/settings/SettingsView.tsx`：当前重复subtabs应移除，接主导航section；notice/preferredConnectionId的首配链路保留，变更区时旧无关成功消息应避免挂着误导。
- `ui/src/settings/{AgentEditor,ConnectionEditor,SkillEditor}.tsx`：当前真实CRUD可复用，不做mock表单。EditorList/FormHeading目前从AgentEditor导出，如重新组织可就近分出一个真正复用编辑器呈现组件，不建新抽象包。
- `ui/src/chat/{ChatView,ConversationTimeline,DecisionCards}.tsx`：保持RootStoreProvider/AgentStoreProvider只读hook和显式sessionId命令；仅视图优化。不要破坏等待/恢复/撤销卡片。
- `ui/src/styles.css`：当前30巨长行，改为可读分职责样式文件并由styles.css聚合，tsup仍出同一公开styles.css；不得依赖fixture覆盖CSS来假装产品适配。全局规则全部限定.browser-agent-view或本包专用类，不改宿主body/button样式。按容器适配，不能只媒体查询。
- extension/app.tsx & sidepanel.css只改呈现：目标页面条简洁，中文文案、不显示tab数字当产品主信息，错误仍可见；不得改bindActiveTab/权限、桥/会话逻辑。不要安装扩展，本次没有安装授权。
- fixture.html/testFixtures及业务fixture：目前窄版是左边360px+整片灰空白，默认宽版右侧原生表单很抢眼。把试用壳整理为居中的可读工作台/侧栏预览，演示业务区作为次要有标题的面板，真正业务iframe与请求演示接线全部保留；模拟响应说明不覆盖表单。width=360仍真正约束容器，不能截图缩放作弊。不要改业务input/field identity/隔离契约；fixture的模型fetch仍模拟。

## 验收覆盖矩阵

V01 主导航/空态：一层导航，模型Key一眼可见、四栏目均可达，空态行动直接。
V02 模型表单：Endpoint/模型ID/APIKey实际保存、状态/错误/下一步保留；password不回填。
V03 Agent/技能表单：多模型联动、工具/技能选择与CRUD保留，折叠/过滤已选项保存不丢；缺失引用显式提示。
V04 对话：会话选择、消息/工具/确认/运行/恢复/撤销均能阅读使用。
V05 宿主与360px/宽：可选包样式隔离、容器响应、extension目标条统一、fixture不掩盖产品；宽/窄实际截图由编排CUA验收。
全部归180实现，190独立review兼覆盖审计。不要自行标190通过。

## 测试与约束

- 应用 frontend-design、frontend-design-codex、one-file-one-thing。先在报告写小型设计计划/职责清单。普通源码/测试≤300物理行，不能一行数千字符绕过；新CSS按shell/settings/conversation等真实职责切分，不一规则一文件。现有BrowserAgentView.test.tsx已278行，新增场景分就近测试文件。
- 保留全部既有 meaningful UI 回归，可按单层导航更新测试查询，不能删除client切换隔离、实际第二模型transport、命令、缺失引用等断言。若新增折叠/搜索，至少检验选择跨折叠/过滤保存仍正确，不为纯颜色写镜像测试。
- 根cwd运行 `pnpm exec vitest run browser-agent/ui browser-agent/extension`；UI build、根tsc、state/boundaries、docs。不要install，不改根lock（系统pnpm旧7会降级lock，禁止安装）。
- 无真实APIKey/外部模型请求；不访问钥匙串，不启动Chrome for Testing、CDP、Playwright或浏览器脚本。编排通过现有原生Chrome/CUA核验。shared visual-runtime缺失有既定CUA替代裁决。
- 当前全部旧page/api/network/160改动必须保留，前态 reports/180-prechange.diff。不commit/push，不建远程issue。只改列明产品文件、只写自己的 `/Volumes/work/ai/web-agent/.tasks/browser-agent/reports/180-report.md`，不写根reports、不改index/任务书、不再spawn。
- 前端主要视觉稳定时提前通知编排可并行看浏览器，继续测试后再DONE。报告准确区分源码测试和编排CUA，不伪报截图或原生键盘完成。

## 2026-09-20 用户追加：默认 DeepSeek V4.1 Flash

用户要求模型配置默认好 DeepSeek Flash V4.1，Key 不默认。这是小型转录式增量，沿用180，不另开树；编排最终抽查，不重复190全量审查。

- 范围仅 ConnectionEditor.tsx 与既有 UI 测试。官方 https://api-docs.deepseek.com/updates/ 2026-09-10 明确当前模型 ID 为 `deepseek-flash`；官方 WorkBuddy 接入文档给出 `/v1/chat/completions`。
- 新建表单默认 label `DeepSeek V4.1 Flash`，baseUrl `https://api.deepseek.com/v1`，models `['deepseek-flash']`，credentialConfigured false。Key 无默认值，不读取环境或其他连接。
- 仅新建表单预填；编辑已有连接仍用 editing，不自动持久化或覆盖已有配置，不修改 headless 默认数据。全部字段仍可编辑。
- 新建说明改成“已预填 DeepSeek V4.1 Flash，填写 API Key 后保存即可；也可修改为其他兼容接口。”编辑说明保持通用。
- 更新 BrowserAgentView.test.tsx 两个新建或切换 client 后 label 为空的旧断言；保留 Key 为空、自定义覆盖及隔离断言。在 first-setup.test.tsx 既有流程中添加三个预填值及 Key 为空的断言，再继续原自定义多模型传输验证。不新建镜像测试文件。
- UI 定向测试、UI build 后 extension build、必要 app tsc。不重跑全仓、不 install、不改 lock、不打开浏览器或写 Key。仅追加自己的180-report.md，本次结果由编排抽查。
