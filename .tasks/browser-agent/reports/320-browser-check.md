# 320 原生Chrome现场与验收

状态：PASSED。修复前后均通过原生 Chrome 观察，后验为真实 MV3 全链路。

## 修复前

2026-09-20，CUA原生Chrome当前项目问题详情，侧栏最新read_form结果7项，已修好的标题正常（问题标题/问题链接/优先级3/附件/系统环境），但缺少4个树选择及2个富文本。真实network工具已报26请求，本任务不重改network。

只读原生DevTools现场结构：

- 工单类型、所属部门、相关项目：表单项 deepfos-business-form-item 中 selectWarp > selectContentAll > happy-input[tabindex=1] > FormTree placeholder；没有input/combobox role。
- 相关产品组件同结构，根有FormTree multipleContainer类。
- 系统环境为happy-input + HappySelect类 + role=combobox；空白时SelectLabel placeholder显示请选择，不能当当前值。
- 两个富文本iframe class=tox-edit-area__iframe、title=富文本区域，其same-origin contentDocument.body[contenteditable=true]；真正字段名来自最近表单项的问题描述/解决方案。
- 工单类型label内em类包含required，字段本身无required属性，原native问题标题也靠近有此必填标题样式。

所有诊断只读取DOM，不点击下拉、不选择候选/填值/提交，不读取React私有状态/凭据、未发模型请求。仅记录控件结构/标签，未导出业务正文。CUA输出包含已有页面无关i18n错误，非本任务新增。

## 修复后

2026-09-20，编排构建当前 extension/embedded dist，Chrome 扩展管理页重载既有 Browser Agent 实例（原网站授权不变）。为了不刷新用户原页面及可能的草稿，在独立新业务 document 中加载同一页面，通过独立扩展页 DevTools 调用真实 runtime handshake → page-call/readForm，结果 `ok:true`，`fields.length:13`。

| 字段 | kind | required | readOnly | supported | optionsStatus |
|---|---|---|---|---|---|
| 工单类型 | custom-select | true | false | false | not-exposed |
| 问题标题 | text | true | false | true | — |
| 问题描述 | richtext | false | false | false | — |
| 问题链接 | text | false | false | true | — |
| 系统环境 | combobox | false | false | false | not-exposed |
| 相关产品组件 | custom-multiple | false | false | false | not-exposed |
| 所属部门 | custom-select | false | false | false | not-exposed |
| P0 - 高 | checkbox | false | false | true | — |
| P1 - 中 | checkbox | false | false | true | — |
| P2 - 低 | checkbox | false | false | true | — |
| 相关项目（页面完整标签） | custom-select | true | false | false | not-exposed |
| 相关附件（页面完整标签） | input-file | false | false | false | — |
| 解决方案 | richtext | false | false | false | — |

四个无 role 选择器及两个富文本补齐，13 项无重复；iframe 标题使用外部业务标签。问题描述读取文本长度213，解决方案0，仅记录长度，没有导出正文；空选择器未将“请选择”当作值。系统环境保持 `readOnly:false`，未知写入能力以 `supported:false` 表达。

未打开下拉，因此5个选择控件的远程/未渲染候选明确为 `not-exposed`；原生/ARIA 已暴露候选由 package 回归验证。全部操作只读，无填写/提交/模型调用/钥匙串操作。用户原业务 document 未刷新，旧监听器仍需该页面后续刷新才能更新。

## R1 后验环境说明

首轮13字段的真实MV3证据有效。随后准备R1复验时，CUA原生Chrome getAXState/getApp 均返回 `cgWindowNotFound`，getState仅列出Chrome应用运行、没有可用浏览器表面。未使用CDP、Chrome for Testing或其他UI自动化绕过。若R1完成时表面仍不可用，R1边界以DOM回归与最终构建验证，不能声称修补后的安装实例已重新加载/再验。
