---
id: '270'
title: 插件启动自动采集页面请求并可直接读取已有记录
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '130'
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/tools/network/**
  - browser-agent/extension/src/**
  - browser-agent/extension/tests/**
  - browser-agent/extension/README.md
  - browser-agent/extension/tsup.config.ts
---

用户再次明确“插件一加载就开始捕获所有请求，而不是等agent调用”。按现有需求先做授权文档全部fetch/XHR接口请求；编排已异步问图片/CSS/导航资源是否也需要，未答不臆造webRequest/debugger新权限。不得等待Agent start_capture才安装hook、不得仅修改话术。该任务沿用纯Web recorder/已有扩展权限，不能改manifest或扩大授权域。

## 已核实现场与代码

- 原生Chrome真实对话read_form成功后问捕获多少请求，Agent start_network_capture({includeBuffered:true})返回0。它解释“刚刚才开始采集”。编排DevTools只读看到window.__einfachBrowserAgentNetworkGateway__为true、performance resource143；故不能简单声称从未注入，需分别处理生命周期与缓存可观测性。
- service-worker.ts startup/onInstalled/onStartup/onAdded只syncRegisteredScripts；script-registration.ts仅注册future document_start，未给已打开授权tabs安装脚本，实际现有页要等handshake。注册每次worker启动还unregister两脚本，造成间隙。getAll origins过滤仅http/https（需考虑合法*://和<all_urls>但只使用已授权原集合）。
- network-main.ts注入时installWindowNetworkRecorder，主frame100条/5min；window-recorder maxAgeMs默认5min最多10min，用户页面停留更久后初始化请求悄悄全过期。window-host startCapture.startedAt是session capture时间，未暴露真正recorder时间；list tool强制captureId，模型必须先start，现说明也误导。
- read network/types/window-recorder/window-observer/window-host/start/list工具与docs，extension network-main/service-worker/script-registration/network-bridge/protocol/test。Chrome官方说明 https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts 和 https://developer.chrome.com/docs/extensions/reference/api/scripting 确认document_start与MAIN、registered/existing执行的区别。只能通过现有公开API。

## 合同 N07–N10

- N07 插件worker加载/安装更新/浏览器启动/网站权限授予后，除注册future document_start之外，给已经打开且授权的http(s)tab立即安装ISOLATED+MAIN；无会话/不打开侧栏也工作。注入幂等不会清掉已有buffer或叠hook；单tab失败不挡其他tabs，撤权停止，重启重注册失败可重试。不要无条件unregister已正确脚本制造启动空窗。无权限页面不得注入。
- N08 文档预采集持续到document结束，与Agent capture start/stop生命周期分离。缓存保持明确的有界请求数/正文大小，避免仅过5min就无声清空导致常规页面初始化数据消失。可给recorder添加显式document-lifetime选项保留纯web默认兼容；容量淘汰仍必须有界，复用已有红action。新增状态至少能区分页面recordingStartedAt/采集范围/丢弃计数（具体字段最小实现），让模型不能把读取时间冒充开始监听时间；不可伪造注入前历史正文。
- N09 list_network_requests允许不传captureId读取该绑定文档的自动预缓冲，首次读取不得才启动基础采集；保持显式captureId兼容，request/response后续引用明确，工具说明准确区别读预缓冲与建立会话过滤视图。无预采集宿主不能把刚安装冒称过去在监听；stop显式capture不停止文档预采集；会话隔离、取消、参数校验/返回转移上限继续成立。
- N10 回归需要真实network-main+worker wiring而非仅mock自己：worker启动时已开授权tab即注入/未授权不注入、文档请求先发生后无Agent start直接list能看到、对话前fetch/XHR正文可读、>5min但未超容量仍可读、重注入保持/撤权停止、显式capture隔离+取消。保留原sanitize/limits/Request/response语义测试，不引入真实外网请求或CDP。报告每个场景证据。

读取CLAUDE.md、.project-lines relevant工具/宿主线、one-file-one-thing。普通文件<=300，已有window-observer约300只窄改可说明；若新增模块列职责。禁止install/改lock/commit/push/远程issue/操作浏览器/钥匙串/再委派。产品仅声明范围，报告reports/270-report.md。并行260会改tools/page，勿触碰；extension最终build需等260通知，但本任务可先定向tests与networkbuild，dist ready及时通知编排。发现范围不足先报路径/理由，不能自己扩大manifest权限。

## R1 原生MV3实测阻断

编排重载已装扩展，在新cloud业务document验证：Agent任何工具调用之前，MAIN gateway direct list读出26条fetch/XHR，scope=document，recordingStartedAt早于第一条请求。实际extension页面runtime.sendMessage→worker→content readForm正确返回问题标题/问题链接/系统环境。但handshake后再走network-call list报INVALID_NETWORK_RESULT；捕获Chrome executeScript MAIN原始异常是RECORDER_UNAVAILABLE。

根因假设已由源码对应：network-main的ESM产物被作为classic script重复执行，顶层var observers WeakMap每次重置，旧gateway闭包依赖这些同名全局变量；same-version resume表面保留gateway却破坏observer。必须以实际打包产物classic脚本重复eval加回归，隔离content/network注入脚本模块作用域（如按入口IIFE），不只用vi.resetModules模拟新ESM上下文。用真实document回放先请求→handshake/重复注入→list及body仍可读，映射保持，网页函数语义不变。MAIN故障跨Chrome序列化时抛错会变null，route不能把明确RECORDER_UNAVAILABLE只报invalid result，可复用现有响应形状返回有界错误。修后重建extension及时通知编排。补发R1报告，独立280续审。
