# DOM交互浏览器验收

日期：2026-09-21。仅编排者通过CUA操作现有Google Chrome，未启动CDP/Playwright/Chrome for Testing，未读取或保存Keychain。

## 故障前态（已观察）

真实用户现有“项目问题详情”页面和Browser Agent侧栏：
- 用户最新请求“工单类型 选择漏洞”。read_form此前已发现13字段，工单类型为custom-select、supported:false。
- 展开工具记录确认read_field_options返回field options are not exposed in the current DOM；select_option(value="漏洞")返回field does not expose options；wait_for_field options超时。
- 编排者点击工单类型“请选择”，实际弹层出现：缺陷工单（有异常报错信息）、答疑工单（咨询类）、安全漏洞、创建空间或其他。弹层还含搜索输入框。未选择或保存业务数据。
- 说明候选可经UI交互发现；旧工具集没有展开/DOM操作路径。

## 本地验证准备

- 编排者启动Vite fixture：`pnpm exec vite --config browser-agent/ui/tests/fixture.vite.config.mjs`，127.0.0.1:4178。
- 用现有Chrome新标签打开 `http://127.0.0.1:4178/fixture.html?scenario=configured`，保留原业务标签。
- 真实截图确认本地页面与业务iframe可见，原生表单、网络演示入口存在。DOM新实现尚在进行；此观察不算新版功能通过。

## 新版结果

370 R1源码与fixture稳定后，CUA实际点击本地页面“运行DOM选择演示”按钮。由于原生AX引用在当前环境反复返回已失效，使用最新截图中按钮坐标(944,626)点击，然后读取最新AX：
- 业务iframe原“尚未选择”已变为“安全漏洞”。
- 演示输出五步：read_dom按可见文字找到自定义下拉；click_dom展开普通div/span异步候选；wait_for_dom在已观察父节点看到安全漏洞；click_dom选择候选；read_dom在候选关闭后回读显示值安全漏洞。
- 这是可见页面按钮调用真实ToolRegistry→DOM host链，不是编排者手工点击业务候选，也没有调用真实模型。
- 原业务标签保留；未改真实项目工单、未保存/提交。
- 真实已安装MV3扩展在用户业务站点调用新DOM工具尚未实测；扩展路由以本轮组合测试与生产bundle验证为依据，不能把本地fixture等同真实MV3业务成功。

## 配置入口
CUA随后打开同一fixture设置→Agent→工具能力，实际可见6项独立复选框：read_dom、click_dom、type_dom、press_dom_key、scroll_dom、wait_for_dom，和原有19项同目录，共25项。没有保存或修改真实用户Agent配置。
