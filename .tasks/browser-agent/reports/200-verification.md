# 200 编排验证

代码确认旧bindActiveTab把缺tab.id和缺tab.url都报作No active page。Chrome官方tabs文档说明URL受host/activeTab权限限制，permissions文档提供按tabId的addHostAccessRequest。用户具体标签数据未读取，所以没有断言唯一现场原因。

- 执行者extension回归6文件27项、extension build、根tsc -b通过。
- 编排审阅最终bindActiveTab、声明和定向测试，保留app先绑定后创建会话顺序。
- 编排亲验git diff --check通过，manifest无变更，源码/测试未超300行。
- 最终ZIP逐文件与extension/dist相同，12文件，CRC通过；SHA256 857b68ebde59d3145806796040685f2a54d5fd7fc9746ca39654a9ba8030c686。
- 没有真实网站授权/真实Key输入/模型调用。未自动重新加载用户扩展，用户重新加载后可重试当前网页；不能将模拟Chrome API测试当成实际权限弹窗实测。

官方依据：
- https://developer.chrome.com/docs/extensions/reference/api/tabs
- https://developer.chrome.com/docs/extensions/reference/api/permissions
- https://developer.chrome.com/blog/new-extensions-menu-testing
