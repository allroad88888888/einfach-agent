---
id: '140'
title: 网络工具在配置页与演示请求中可用
kind: leaf
parent: browser-agent
depends_on: []
completion_requires: ['120', '130']
model: gpt-5.6-sol
status: done
base: 756cd97
files:
  - browser-agent/ui/tests/**
  - browser-agent/ui/package.json
  - browser-agent/examples/embedded/**
  - browser-agent/README.md
  - vite.config.ts
  - tsconfig.app.json
  - pnpm-lock.yaml
  - scripts/check-boundaries.js
  - scripts/check-boundaries.test.js
---
# 网络工具在配置页与演示请求中可用
仅改frontmatter范围；报告reports/140-report.md。读index全局规则和one-file-one-thing。此前13工具已交付，所有改动还在working tree，reports/network-prechange.diff是前态；别重置。不要启动浏览器/CDP或修改UI生产src，本次UI改变在fixture。fixture辅助TS必须*.testFixtures.ts以通过source白名单。

## 交付
- root Vite alias、tsconfig.paths增加@einfach-agent/tools-browser-network→browser-agent/tools/network/src/index.ts；check-boundaries headless包清单增加network并补现有fixture测试（不可扩大通用豁免）；workspace已有browser-agent/tools/*不必再加分组，check-dist会自动发现。
- ui/package.json仅devDependencies加network workspace包，生产UI保持无具体tools依赖；fixture Vite alias同步。
- 与120/130并行：等120 package.json和130 extension/package.json已落盘再用pnpm10完成锁/链接更新。本机默认pnpm7不支持v9锁，必须使用已缓存可用的npx pnpm@10.17.1，先确认version，不要用pnpm7 install导致清空链接。安装前通知编排，完成后通知恢复；lock只新增network importer/依赖链接，不升级其他包。
- FixtureBusiness中创建createWindowNetworkHost({window:iframe.contentWindow!,targetId:'fixture-business-frame',documentId:'fixture-business-document'})；client registrar加入registerNetworkTools，总catalog 19项（6network+11业务+2skill）。纯webfixture使用同realm真实fetch/XHR流量，不用手工塞假请求记录。
- Vite fixture server提供固定本地 /fixture-api/cities JSON路由（仅本地演示，无真实客户凭据），fixture中的明确演示按钮触发iframe.window.fetch与XHR，或国家变化触发该真实本地请求。提供一个“演示请求捕获”按钮，按真实工具registry执行start→触发fetch/XHR→wait/list→getRequest/getResponse→stop，在fixture旁以简洁中文呈现数量、方法、URL路径、状态码、响应内容。不要把测试实现细节塞进UI产品的用户流。
- 演示mock模型fetch保持本地无真实provider请求；网络host只监听业务iframe，不捕获配置页面、模型Key或其他tab。fixture unload dispose网络host。不要自动start长期监听用户其他页面。
- 文档列6工具及能力边界：开启后fetch/XHR、内存有界、默认5min TTL、只读观察不重发、历史/跨frame/WebSocket未覆盖；embedded说明可通过相同包无React接入（可补例子，但不要破坏原mock填写闭环）。

## 固定120合同
NetworkToolsHost的startCapture(input{urlIncludes?,methods?},ctx)→CaptureStatus；stopCapture({captureId},ctx)→CaptureStatus；listRequests({captureId,offset?,limit?,urlIncludes?,method?},ctx)→{capture,requests,nextOffset?}；getRequest({captureId,requestId},ctx)→Details；getResponse({captureId,requestId},ctx)→Response；waitForRequest({captureId,urlIncludes?,method?,state?:'started'|'finished',timeoutMs?},ctx)→Summary。
createWindowNetworkHost({window:Window,targetId,documentId?,maxRequests?,maxBodyChars?,maxDurationMs?})返回上述host + dispose():void；registerNetworkTools(registry,host)；所有类型从包根export。
6tool名称start_network_capture/list_network_requests/get_network_request/get_network_response/wait_for_network_request/stop_network_capture，参数同方法input。

## 覆盖与验收
- 从fixture导出真实装配函数测试，勿在测试复制一套永不影响真实入口的装配；校验catalog19、隔离iframe、真实fetch/XHR被捕获并能读response、stop后不再记录、不会读到模拟模型credential。jsdom可注入可控fetch/XHR，但最终CUA按钮需走真实Vite本地HTTP。
- 更新旧13项catalog断言到19，旧工具用例原样保留。
- 完整browser-agent测试、根tsc、相关包build、state/boundaries/docs；node_modules链接更新后通知其他agent可验证。不运行旧browser-smoke/CDP scripts，不自行操作浏览器。
- 覆盖审计N01工具合同/纯Web捕获=120；N02权限脱敏/有界/多会话=120；N03扩展固定document路由/取消=130；N04配置19项/真实网络演示=140；N05public包/无UI嵌入=140。每项给证据或准确未验证范围，特别区分真实纯Web捕获验证与MV3 mock路由测试；不夸大真实扩展网络已实测。终审与编排CUA收口。


## 最新用户修正（优先于上文冲突部分）
用户明确要对话前请求。120增加installWindowNetworkRecorder({window,maxRequests?,maxBodyChars?,maxAgeMs?})→{dispose():void}；在fixture业务iframe最早可执行时立即安装，与network host使用同一包模块与Window。首次加载fixture业务页面先发初始化cities fetch（在Agent创建/会话start之前），之后演示按钮只调用start（includeBuffered默认true）→list/getResponse验证已有初始化请求，再发新fetch/XHR→wait/list/getRequest/getResponse→stop。UI明确展示“对话前初始化请求”及响应，不仅数量多了几项。测试通过真实装配函数验证先发生请求/后start仍可读，includeBuffered:false不读旧请求，其他iframe隔离。刷新iframe重建采集，unload释放所有实例。纯Web嵌入例子展示先安装recorder/后建Agent。
README边界改为：注入后且在对话前的请求可读；注入前历史无法补抓。扩展已授权origin动态document_start自动预注入，首次在已打开页面授权需刷新才能覆盖初始化；预缓冲随文档持续、只保留最近5min/100条，session capture仍有5min TTL。未授权站点不自动采集。
覆盖N06 页面早期注入+对话前请求→120/130/140，140给独立覆盖审计证据、根CUA观察“对话前初始化请求”。

## R1 独立审查修复
reports/140-review.md发现模型credential隔离断言未真实触发模型fetch，属于恒通过。仅修此测试和必要fixture装配辅助：使用演示假credential，recorder活跃时经真实createSession/sendMessage运行模型transport，确定mock模型fetch确实调用且接到固定fake Authorization，再断言业务iframe捕获没有模型URL/请求/响应credential。按现有agent集成测试等待指定run终态再dispose，不加固定sleep/放宽断言/跑真provider。报告reports/140-report-r1.md。产品路径限制不变，禁止install（当前lock已正确），source无必要不用改。根CUA已实际点击演示成功，证据reports/140-browser-check.md，README不要把纯Web结果夸为MV3实测。
