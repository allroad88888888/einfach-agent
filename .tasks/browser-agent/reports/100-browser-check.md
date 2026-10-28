# 100 编排浏览器可见检查

2026-09-18，通过 CUA 原生 Google Chrome app 操作已有预览页，未启动测试Chrome，未操作系统钥匙串。

- 地址：http://127.0.0.1:4178/fixture.html?scenario=configured
- 点击“配置”后，浏览器AX实际显示Agent/技能/连接三个配置入口。
- “工具”fieldset显示13个可勾选工具：skill_search、skill_read、read_page、read_table、read_form、fill_fields、validate_form、read_field_options、wait_for_field、select_option、clear_fields、query_options、list_options_sources，全部具有中文描述。
- 同页“隔离的演示业务页面”中，嵌套about:srcdoc iframe标题“差旅申请演示”，实际显示申请人、国家、城市、交通方式、同行服务、政策确认、异步团队字段与近期申请表格。
- 服务保持运行，浏览器停在配置页。用户打开的DevTools原样保留。
- 本条证据验证可见装配；工具真实调用与目标隔离由100单元/集成证据验证，没有据此声称真实客户页面或Edge通过。
