# 200 R1 原生 Chrome 实测

日期：2026-09-20。用户反馈「试了 不行，你自己操作试试」。编排直接操作用户现有 Google Chrome；不启动 Chrome for Testing 或 CDP，不访问钥匙串，不输入凭据、不发模型消息、不填写或保存业务表单。

## 修复前复现

- 当前业务标签为 cloud.deepfos.com 的「项目问题详情」。扩展 ID jlabenglclhfihpncpggbnolcjabkooo，来源确认为仓库 browser-agent/extension/dist。
- 侧栏选择已有「ai录数 · r1」Agent，点击新建会话后，显示「请在 Chrome 工具栏的扩展菜单中允许此插件访问当前网站，然后再次新建会话……」。没有 session，目标条仍为「创建会话后将自动绑定当前页面」。
- 点击固定工具栏图标只关闭侧栏，图标仍为「想要访问此网站」。扩展菜单显示 Browser Agent 在「已请求访问权限」组；按菜单指示点击插件，仅重新打开侧栏。再次选择 Agent 并点击新建会话，仍失败。
- 实测推翻了此前仅模块测试与源码审查足以收口的结论，200/210 重新开启 R1。

## 根因及修正门

[Chromium ExtensionActionRunner 源码](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/extension_action_runner.cc) 的 RunAction：HasSidePanelActionForTab 为 true 时直接返回 kToggleSidePanel，发生在 GrantTabPermissions 之前。扩展启用 openPanelOnActionClick 导致工具栏点击不能得到 activeTab 临时授权。

[Chrome sidePanel 官方文档](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) 允许在 action 点击同步回调中调用 sidePanel.open({windowId})。R1 显式关闭原自动 toggle，改为该方式；保留最小权限以及原页面绑定校验。

## 修复后验证

1. 在已有 chrome://extensions 的本插件详情页点击「重新加载」，Chrome 显示「已重新加载」。没有卸载插件或更换来源，原有 Agent 配置保留。
2. 回到同一「项目问题详情」标签，点击工具栏插件图标，侧栏正常打开；Chrome 图标说明从「想要访问此网站」变为「可以访问此网站」，实际确认 activeTab 恢复。
3. 选择已有「ai录数 · r1」并点击「新建会话」。Chrome 这次实际弹出「Einfach Browser Agent 请求获得更多权限」，范围精确为「读取和更改您在 cloud.deepfos.com 上的数据」，已不再循环旧提示。
4. 原生工具确认规则要求在新增网站访问权限处取得确认。编排提出单网站授权确认并停在该弹窗，没有点击允许。
5. 用户随后要求压缩侧栏布局。编排再次只读观察用户现有 Chrome：权限弹窗已消失，侧栏「目标页面」显示「项目问题详情」，「使用 Agent」为「ai录数 · r1」，「会话」为「ai录数」，消息记录为「准备好了 / 发送第一条消息开始工作」，输入框可用。这是实际 session 已创建并绑定的证据；编排没有点击权限允许或发送消息。后续截图时用户自行切到扩展详情页，可见单网站 cloud.deepfos.com 已列入访问站点。

200 R1 真实新建会话/绑定门已通过；用户继续提出的布局需求另归220，不能反推本轮已测试真实模型或业务填数。

R1 模块验证：extension 6 files / 29 tests、build、根 tsc 通过；独立 210 R1 review PASSED。编排 git diff --check 与重新打包的逐文件/CRC/manifest 校验通过。上述证据不替代最后真实 session 验证。
