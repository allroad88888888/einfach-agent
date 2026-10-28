# 真实业务页面下拉选择复核

日期：2026-09-21。用户反馈仍失败后，编排通过CUA读取现有Google Chrome插件最新会话。此为370–390完成后的现场排障与配置衔接，没有新增产品源码改动。

## 失败证据

最新用户消息“工单类型选漏洞”。工具记录明确：`request_tool_schema({query:"dom"})` 返回 `items:[]`、`total:0`。后续只能调用read_field_options/select_option/fill_fields/wait_for_field并失败。list_options_sources返回空，证明新版清理演示源已生效。

设置→Agent→ai录数：r1，19项已选，新增read_dom/click_dom/type_dom/press_dom_key/scroll_dom/wait_for_dom全部未选。根因是新工具没有进入实际Agent工具清单/会话能力快照，不是该次DOM调用报错（该次没有DOM调用）。

## 现场处理

- 为用户正在验证的ai录数勾选六项已实现DOM工具，保存为r2，25项已选；其他已选工具、工作说明、模型连接保留。
- 返回项目问题详情业务标签，以r2创建新会话并绑定该页面，保留旧会话历史。
- 在实际插件中发送“工单类型选择安全漏洞，只选择，不保存或提交。完成后回读确认。”通过用户已配置模型完成真实运行；没有读取/展示/保存Keychain或模型Key，没有重新配置模型。

## 实际结果

真实工具记录出现read_dom、click_dom、wait_for_dom。Agent经DOM找到控件、展开候选；首次点候选容器回读未生效后继续观察并点击真实文本span，选择成功。随后read_form与read_dom均回读确认。

CUA看到业务页面工单类型显示“安全漏洞”，联动出现“安全漏洞描述”字段，表单仍待提交。

打开最终工具“参数与结果”核实原始返回：
- read_form：`field-1` / 工单类型 / custom-select / `value:"安全漏洞"`。`supported:false`仍表示原生fillFields无该控件适配器，不影响此次DOM操作。
- read_dom(scopeRef=dom-208)：控件内实际span `dom-433`，`name`与`text`均为“安全漏洞”，truncated:false。

未点击保存/提交。选择触发的页面联动（描述模板改为漏洞模板）属于用户目标字段自身业务行为。未修改产品源码、未跑与本次配置处理无关的重复测试、未commit/push。

## 验证范围更新

390中“真实MV3业务未实测”为上一阶段事实。本次已完成现有已安装MV3扩展 + 实际业务页面 + 实际配置模型 + 工具原始回读的该单个下拉场景验证；不扩大为所有第三方控件/站点兼容结论。新版默认不修改旧Agent与既有会话的能力快照，旧r1会话仍缺DOM工具；当前选中新r2会话可使用25项工具。
