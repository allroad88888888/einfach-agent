---
id: '090'
title: Agent可发现获授权的业务选项数据源
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-terra
status: done
repair_round: 1
base: 756cd97
files:
  - browser-agent/tools/api/**
---
# Agent可发现获授权的业务选项数据源

## R1审查修正
参照 reports/090-review.md 恢复原source注册校验（非空trim与重复id），不要因新增发现功能收紧构造器；新增长id注册回归测试。query_options本来会拒绝>500的查询id，本次保持原失败时点。编排先前要求与query参数限制对齐的消息撤回：发现工具只增加可选label/description的输出边界，不改变原host初始化合同。其他已通过行为保持。报告更新并记录定向复验，不重复全仓。
读index.md；仅修改browser-agent/tools/api/**。报告 .tasks/browser-agent/reports/090-report.md。不提交，不启动浏览器。one-file-one-thing≤300行，新增工具一目录实现+.md+测试。

现有createApiToolsHost sources Map、isSourceAllowed(sessionId)权限闭包、query_options工具、query deadline和错误脱敏全部复用。增加list_options_sources工具，让模型先发现可用sourceId再query_options。不得增加任意URL/fetch或暴露请求header/token/闭包；不增加框架包。

## 公开合同供100消费
```ts
interface OptionsSourceInfo { id:string; label?:string; description?:string }
interface ListOptionsSourcesInput { offset?:number; limit?:number }
interface ListOptionsSourcesResult { sources: readonly OptionsSourceInfo[]; nextOffset?:number }
interface OptionsSource { // original id/query unchanged
  label?:string;
  description?:string;
}
interface ApiToolsHost {
  // queryOptions unchanged
  listSources?(input: ListOptionsSourcesInput, ctx:ApiCallContext):Promise<ListOptionsSourcesResult>;
}
function createListOptionsSourcesTool(host:ApiToolsHost):Tool;
```
export类型+factory。createApiToolsHost实现listSources；registerApiTools保留原export入口兼容，只有host.listSources存在才注册新工具。页面显示中文描述。
list_sources按调用当时session逐个过滤权限，之后offset分页，默认20最大100；输出只包含白名单 metadata（id及有界label description，字符串最长500，源id沿用原校验），禁止透出任何额外源对象属性。调用前检查signal；permission错误使用安全固定文案，不回显异常秘密；不调用query，无网络。保持来源顺序稳定。bad offset/limit类型、非整数、负数、过大等应拒绝（工具schema+host直接调用）。query_options业务行为不改变。

## 验收
测试经registry运行的发现→query闭环，session A/B权限不同、权限回调改动立即反映、分页按授权结果计算、空源列表、取消、非法参数、错误秘密不外泄、legacy仅queryOptions host仍兼容、metadata不含header等。API包原测试全过，pnpm --filter @einfach-agent/tools-browser-api build。README更新，报告命令结果+公开合同。每文件职责及行数检查。
