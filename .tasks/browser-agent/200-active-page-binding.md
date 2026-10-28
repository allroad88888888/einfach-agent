---
id: '200'
title: 新建会话能处理尚未授权的活动页面
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '050'
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/extension/src/page-bridge.ts
  - browser-agent/extension/src/chrome.d.ts
  - browser-agent/extension/tests/page-bridge.test.ts
  - browser-agent/extension/src/service-worker.ts
  - browser-agent/extension/tests/service-worker.test.ts
---

## R1：真实 Chrome 复现后的修正（2026-09-20）

先前 done/PASSED 只覆盖模块验证；用户反馈仍失败，编排已在现有原生 Chrome 的 cloud.deepfos.com「项目问题详情」实际复现：点固定工具栏图标只关闭侧栏，图标仍为「想要访问此网站」；扩展菜单在「已请求访问权限」下点击 Einfach Browser Agent 也只重新打开侧栏。选择 ai录数 Agent 后点击新建会话仍得到同一权限提示，没有 session。

根因有 Chromium 源码证据：https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/extension_action_runner.cc ，RunAction 在 HasSidePanelActionForTab 为 true 时直接 return kToggleSidePanel，发生在 GrantTabPermissions 之前，源码明确说明自动打开侧栏不授予 activeTab。

R1 优先要求（补充下文原合同）：
1. service-worker 显式 setPanelBehavior({ openPanelOnActionClick: false }) 覆盖旧持久设置；注册 chrome.action.onClicked listener，在用户点击的同一同步调用链中调用 chrome.sidePanel.open({windowId: tab.windowId})，不得先 await 丢失用户手势。合理处理 Promise 拒绝，不能产生 unhandled rejection。不要增加 tabs/全站必需权限，不额外注入/自动创建 session。
2. chrome.d.ts 仅增加所需 Tab.windowId、action.onClicked、sidePanel.open 声明。保留缺 URL 时既有恢复提示与原绑定校验；若实际发现其也需修改先报告根因。
3. service-worker.test.ts 就近添加回归，证明禁用自动侧栏 toggle、action 回调即时按所点击窗口打开侧栏、拒绝可收敛；保留已有网络/原生 documentId/无效载荷测试。测试不能 mock 成点击自动授予权限来冒充 Chrome 实测。
4. 仅修改 files 声明范围，保留已有网络工具和 UI 所有未提交工作。普通源文件 <=300 行。运行根目录 extension 全部测试、extension build、根 tsc；禁止 install/lock/Chrome/CDP/系统钥匙串/真实 Key/commit/push/再次派发。
5. 报告改写 reports/200-report-r1.md，保存这一轮必要验证输出；编排负责独立 210 R1 审查与真实现有 Chrome 重载，然后实际新建会话绑定目标页。没通过真实用户路径不再标任务 done。

此前任务与报告保留为历史：

用户在新建会话时报 `No active page is available.`。现有bindActiveTab先query active/currentWindow，再把缺tab.id和缺tab.url合为此错误；但没有activeTab临时授权/host授权时tabs.query仍可返回id而不带url，因此永远到不了后面的按origin授权。这是明确代码缺口，不能假报已经实测用户具体tab数据。

编排已核官方Chrome文档：
- https://developer.chrome.com/docs/extensions/reference/api/tabs：读取url需tabs/host/activeTab，query本身无需tabs权限；官方推荐lastFocusedWindow作当前聚焦页查询。
- https://developer.chrome.com/docs/extensions/reference/api/permissions：Chrome133+提供addHostAccessRequest({tabId})，不需要知道URL；会在浏览器工具栏请求本页host访问，用户同意才持久授予当前origin；跨origin导航清除请求。此方法成功不代表已授权。
- https://developer.chrome.com/blog/new-extensions-menu-testing：可feature-detect，没有相应新菜单的用户也需保留点击工具栏扩展图标再试的回退说明。

实施保持原签名bindActiveTab():Promise<TargetBinding>与app先bind再createSession顺序，不新增抽象包。仅改声明范围，若确需小新helper/test请先报告合理原因。

1. 区分无tab/非法id与有id缺url。合法id可为0，不能用!tab.id；使用非负整数判断。无tab才显示中文“没有可绑定的活动网页，请先打开目标网页再重试”。currentWindow返回空可lastFocusedWindow保守回退；已有tab但缺url不能跳去其他窗口，避免绑定错页。
2. 有tabId缺URL时，如chrome.permissions.addHostAccessRequest存在，await它，仅为该tab请求；随后返回清楚中文提示用户在Chrome工具栏扩展菜单允许当前网站并再次新建会话。不要自动创建未绑定session，不把void resolve当授权成功，不未经授权发handshake、不请求全部站点或tabs权限。若API不可用/拒绝，用“请在目标网页点击工具栏的插件图标，再重试；确认目标是普通HTTP/HTTPS网页”的可操作中文回退，不抛无意义英文。
3. 有URL时沿用按单origin permissions.contains/request，再正常handshake。把受限页面/拒绝授权/无效响应的主要错误转成可理解中文。URL格式异常也应明确。确保返回binding的tabId/frameId与所请求目标相符；仍保留原page/session/document隔离，不转发未验证binding。
4. chrome.d.ts只添加使用到的lastFocusedWindow查询属性和可选addHostAccessRequest API声明，manifest与现有必需权限/optional_host_permissions不变。
5. 就近定向回归覆盖：tab有id无url请求本tab权限且没有握手；权限请求Promise完成仍不视为已授权；下一次query有url+权限后可握手成功；无tab；API不可用/拒绝回退；restricted；deny；正常成功；绑定目标不匹配；当前窗口有tab时不跨windowfallback。保留原文档隔离/取消/恢复测试。普通文件<=300行，不创建重复镜像测试。

报告写绝对路径 `.tasks/browser-agent/reports/200-report.md`；禁止改index/任务文件，禁止再spawn、commit/push、install/lock、浏览器/CDP/钥匙串/真实凭据。运行根cwd `pnpm exec vitest run browser-agent/extension`、extension build、根app tsc；不要重复全仓。编排另做独立审查和产物刷新。当前全部已有未提交UI默认DeepSeek/网络扩充等必须保留。
