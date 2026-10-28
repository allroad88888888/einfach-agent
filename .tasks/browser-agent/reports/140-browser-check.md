# 140 编排 CUA 可见检查

2026-09-18，既有原生 Google Chrome，预览 http://127.0.0.1:4178/fixture.html?scenario=configured 。只用mcp__cua_repl，没有启动Chrome for Testing/CDP、没有钥匙串交互，没有调用真实模型服务。

点击“演示请求捕获”后AX实际呈现：
```
对话前初始化请求：GET /fixture-api/cities，状态 200
初始化响应：{"country":"CN","cities":[{"label":"上海","value":"shanghai"},{"label":"北京","value":"beijing"}]}
本次共捕获 3 条请求
最新请求：GET /fixture-api/cities，状态 200
最新响应：{"country":"GB","cities":[{"label":"伦敦","value":"london"}]}
```
业务iframe城市选项同步从上海变为伦敦。固定Vite本地HTTP路由/入口此前由140实现，按钮通过registry操作真实Window fetch/XHR。初始化记录早于Agent装配的顺序另由源码/集成测试证明，此UI结果证明记录可读且响应内容可见。

随后点击“配置”，实际显示19个工具复选框：skill_search、skill_read、read_page、read_table、read_form、fill_fields、validate_form、read_field_options、wait_for_field、select_option、clear_fields、query_options、list_options_sources、start_network_capture、list_network_requests、get_network_request、get_network_response、wait_for_network_request、stop_network_capture，均有中文描述。保持页面打开供用户查看。

范围：真实纯Web iframe的本地HTTP捕获与配置UI通过。此检查不是安装/运行MV3扩展的document_start实测；扩展路由/动态注册目前由单元mock和bundle构建覆盖，不能据此宣称真实MV3抓包已实测。

## 120 R1 修复后复验
根在R1源码冻结、extension/embedded重建后通过CUA刷新同一预览页，再次点击演示按钮，得到同样的初始化CN响应、3条请求、最新GB响应与200状态；城市选项变为伦敦。读取对话前请求的真实本地HTTP路径在生命周期/正文修复后仍通过。页面保持显示成功结果。

最终120 R3冻结后再次CUA刷新并点击演示，仍显示CN初始化响应/200、共3条请求、GB最新响应/200，业务城市切至伦敦。该证据与最终176测试/23 packed产物同版本。
