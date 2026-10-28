---
id: '160'
title: 用户能直接找到模型与 API Key 并完成首次 Agent 配置
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '040'
model: gpt-5.6-sol
status: done
done: 2026-09-19
created: 2026-09-19
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/ui/**
  - browser-agent/README.md
---

# 用户能直接找到模型与 API Key 并完成首次 Agent 配置

## 现场与目标

用户反馈没有选模型/填 Key 的界面，并质疑 tasktree 完成结论。编排已在原生 Chrome 的 http://127.0.0.1:4178/fixture.html?scenario=configured 核实：配置→连接确实存在 Endpoint/models/password 表单；Agent 确有联动模型 select。但入口名“连接”含糊，空态仅文字提示，当前 fixture 只种一个 precise-1，无法直观看出模型切换。这是 040 的实际交付续修，不要假称原先毫无实现。

只改可选 ui 包这一内聚配置流程，真实扩展与嵌入均消费同一 BrowserAgentView。延续现有绿色/灰色视觉，不增加包、provider 框架、模型自动发现或新依赖。遵循 frontend-design-codex 与 one-file-one-thing 技能；先在报告写文件职责清单。已有压缩格式不得继续扩成不可读大行，新增/大改普通源码及测试 ≤300 行。

## 精确入口及公开合同

- ui/src/View.tsx 当前 panel=chat；ui/src/settings/SettingsView.tsx 当前 section=agents，tabs 为 Agent/技能/连接。
- ui/src/settings/ConnectionEditor.tsx 已用 client.saveConnection({id?,label,baseUrl,models,apiKey?}) 保存，清理 password，成功后 beginNew；不得直接调用网络或存储。
- ui/src/settings/AgentEditor.tsx 已按 connectionId 联动 model；保留缺失 tool/skill/connection/model 引用的显式错误与禁止静默替换行为。
- ui/src/chat/ChatView.tsx 空态“还没有 Agent”只有文字，增加明确可操作的配置入口。
- agent/src/types.ts 只读参考：ModelConnection 暴露 credentialConfigured，不暴露明文 Key；snapshot.connections/agents 是已有配置事实。
- ui/src/BrowserAgentView.test.tsx 原 8 个测试涵盖配置、隔离、错误、缺失引用、重置、消息/工具/命令；可因可访问标签变更更新查询，不能删掉这些覆盖。
- ui/tests/fixture.testFixtures.tsx 在每次页面刷新用新 namespace，所有模型 fetch 是 createFixtureModelFetch mock，已有 page/api/network 真工具与 iframe 请求演示。保留全部在途工具接线，预览准确标明“演示预览：模型请求为模拟响应，请勿输入真实 API Key”；至少两个明确演示模型供选择。如需窄屏证据，可增加 fixture-only width=360 参数使实际挂载容器 360px，不改变产品公共 API。
- browser-agent/extension/src/sidepanel.tsx 只读参考：真实 namespace extension/default fetch，同一 View；不需改扩展产品源码。

## 可观察验收

1. 从初始空态一眼可见“配置模型与 API Key”入口，点击直达实际可填写表单；常驻设置入口明确“模型与 API Key”。已配置用户也能直接找到。
2. 表单清晰区分连接名称、接口地址、模型 ID 列表、API Key；有简短可理解的输入提示，模型用用户服务实际 ID，不编造通用可用模型清单。Key 为 password，不回填，保存失败保留必要草稿，成功清空；已配置状态可见。
3. 连接保存成功有明确下一步创建 Agent，Agent 编辑页可直接管理模型与 Key。新建 Agent 使用刚保存的连接；多个模型可选。没有连接/模型时有可执行入口，不是死路；保留编辑既有 Agent 的缺失引用保护。
4. 用户能沿可见入口完成连接→创建 Agent/选择模型→回到对话/创建会话；不要求自动跳转，操作文案明确。现有 Skill/tools 配置仍可正常使用。
5. 使用真实 client+fakeIDB/mock fetch 的 meaningful UI 测试走上述首次流程，选第二个模型，断言实际 mock transport 收到对应 endpoint/model 与测试 Key；界面不回显 Key。保留原测试。必要时分出首配场景测试文件，测试 helper 用 *.testFixtures.ts 命名。
6. 360px 侧栏及宽嵌入区可用，键盘和错误提示可访问。编排通过 CUA 做实际浏览器和截图验收，执行者不启动浏览器，报告注明这一步由编排补证而不是虚报已验。
7. pnpm exec vitest run browser-agent/ui 从仓库根运行；UI build 通过。编排随后根 tsc/边界/state、扩展重建与范围复核。

## 约束与报告

- 禁止系统钥匙串任何访问/写入/查询/删除，不启动 Chrome for Testing/CDP/Playwright，不用真实凭据或真实模型请求。浏览器仅编排 CUA 使用现有原生 Chrome。
- 不 install，不改根 lock。旧全局 pnpm 是7，执行已有 exec/build 可用，安装会降级 v9 lock。
- 当前其他页面/API/network 工具改动全部保留；本范围前态 reports/160-prechange.diff。不要回滚旧改动。
- 不创建远程 issue、不 commit/push；只写自己报告 reports/160-report.md（含职责、实际变更、测试命令结果、风险）。不改 index 或本任务书。不再委派子 agent。
- 回执 DONE/NEEDS_CONTEXT 加简短摘要。验收目标是用户可操作的完整路径，不把单纯改标签当全部交付。

## R1 独立审查修复

审查报告：`.tasks/browser-agent/reports/160-review.md`。Important：同一公开 BrowserAgentView 从 client A rerender 成 client B，旧编辑状态/未受控表单仍保留；会对B提交A的connection/agent id与草稿。应在client身份改变时重置整个视图的本地草稿/选择/导航上下文（或等效明确隔离），不能复制、缓存或重新暴露Key。用真实双client、同一render rerender测试分别覆盖连接密码草稿和Agent编辑，断言B不收到A的数据，保留两个同时挂载视图原覆盖。

这是160隔离验收修复，不扩展core/client存储。仅ui范围修改、报告追加R1；报告必须使用绝对路径 `/Volumes/work/ai/web-agent/.tasks/browser-agent/reports/160-report.md`，不得写根 reports/。旧报告已由编排移动到正确位置。
修后UI测试/build、根tsc定向通过，再交独立复审；不启动浏览器。编排会补实际宽窄CUA，不需要执行者等待浏览器才能回DONE。

R1独立复审PASSED：160-review-r1.md，M01–M04覆盖闭合。编排48 files/179tests、types/state/boundaries、UI与最终扩展构建、宽/360px CUA及ZIP字节校验通过。原生键盘因用户操作停止，user-event焦点链补证；真实模型服务未连通验收。
