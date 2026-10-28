---
id: '100'
title: 扩展与配置预览可选择并调用完整浏览器工具
kind: leaf
parent: browser-agent
depends_on: []
completion_requires: ['080', '090']
model: gpt-5.6-sol
status: done
base: 756cd97
files:
  - browser-agent/extension/**
  - browser-agent/ui/tests/**
  - browser-agent/ui/package.json
  - browser-agent/examples/embedded/**
  - browser-agent/README.md
  - pnpm-lock.yaml
---
# 扩展与配置预览可选择并调用完整浏览器工具
读index.md。写入范围如frontmatter，不能改agent/core或tools包。报告 .tasks/browser-agent/reports/100-report.md。消费080/090在各包根导出的类型；不得自己复制工具实现。按one-file-one-thing≤300行，fixture免行数限制。不提交、不启动浏览器，真实浏览器UI验收由编排者CUA完成。

裁决：本叶按文内已确定的公开合同先并行实现装配，文件面与080/090不重叠。新工具源码尚在实现时可完成桥与fixture；相关build/test须等上游源码就绪，若发现合同冲突先报编排者。100最终done必须等待080/090独立审查通过。

## 现状
ui/tests/fixture.testFixtures.tsx createBrowserAgent没传registerTools，所以预览工具列表只有skill_search/skill_read；这也是用户本次抱怨的直接原因。工具包现已从4个扩到11个（页面9/API2）。扩展sidepanel已有两个registrar，但PageBridge只实现readForm/fillFields/validateForm，protocol/service-worker/content-script只允许三种消息。原对话/skills/连接与独立嵌入边界保持。

## 交付
1. ExtensionPageBridge实现可选readPage/readTable；PageMethod、PageResult、validator、content dispatch增加只读readPage/readTable，使用包根类型。所有新方法按原target binding/permission/document身份/abort路由，readTable必须校验PageRef。service-worker原catch把所有失败标unknownResult，改接新方法时至少维持写失败unknown语义，新只读失败不应误称写入结果未知。wait/select/clear/options复用原host方法走同一桥，无须新增每个tool一个消息协议。
2. 预览fixture注册真实DOM/API工具：创建单独同源iframe内的演示业务表单/语义table，DOM host仅指向此iframe，不能读写Agent自身配置表单。演示含文本、单/多选、checkbox、依赖国家的城市选项、异步字段、语义表格。registered API source给fixture label description并实现本地候选数据。配置页展示完整13个模型可见工具（11业务+2skills），示例Agent默认选最常用read/field操作工具（不必全选）；提供有意义的中文说明。纯演示不请求真实模型、API key固定mock，不改存储到系统钥匙串。
3. fixture Vite alias接tools page/api源码；如果fixture imports需要，在ui/package.json devDependencies加workspace依赖及pnpm锁更新，UI生产依赖不能引入具体tools包。不新增npm依赖。
4. fixture支持query view=settings由UI公开可选initialView参数不可在本任务新增（UI src不在范围），因此若公开接口无此参数不要改UI；编排者在浏览器点击配置。保持原empty/waiting/running场景和browser smoke已有意义。
5. 视情况更新embedded例子说明可用新工具，原mock请求顺序不要无故重写。README说明完整清单/preview命令。测试扩展桥新方法的target isolation、cancel/stale、protocol拒绝未知方法；UI预览装配测试验证隔离iframe与完整catalog且真实执行至少read_page/read_table/read_field_options/select_option/clear_fields/list_options_sources/等待调用。
6. 覆盖审计：核对新工具在DOM registrar/legacy custom host/extension bridge/preview/embedded公开包消费者可达；逐项报告，不把legacy host未实现可选read API记作缺陷。验证所有现有browser-agent单元测试、受影响包build、根tsc -b，记录执行证据。不要运行旧CDP浏览器脚本；浏览器操作只通过CUA且由编排者执行，不启动测试Chrome。

## 080合同
PageToolsHost增加readPage?(PageReadInput,ctx):Promise<PageSnapshot>与readTable?(ReadTableInput,ctx):Promise<TableSnapshot>；PageReadInput{maxChars?};PageSnapshot{page,title,url,text,truncated,tables:[{id,caption,rowCount,columnCount}]};ReadTableInput{page,tableId,offset?,limit?};TableSnapshot{page,tableId,headers,rows,nextOffset?,truncated}。工具名字：read_page/read_table/read_field_options/wait_for_field/select_option/clear_fields。后4无需扩展协议变化，复用readForm/fillFields。
## 090合同
ApiToolsHost增加listSources?({offset?,limit?},ctx)返回{sources:[{id,label?,description?}],nextOffset?}。createApiToolsHost实现它；registerApiTools注册query_options+list_options_sources。
