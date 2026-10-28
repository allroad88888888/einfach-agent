---
id: '130'
title: 扩展可观察绑定页面的网络请求
kind: leaf
parent: browser-agent
depends_on: []
completion_requires: ['120']
model: gpt-5.6-sol
status: done
base: 756cd97
files:
  - browser-agent/extension/**
---
# 扩展可观察绑定页面的网络请求
只改extension/**；报告reports/130-report.md。读index全局约束。公开网络合同见本任务下文，与120固定对齐，不自行复制捕获实现。普通文件≤300行，遵循既有raw/build惯例。不要启动浏览器/CDP、不提交/操作钥匙串。上轮已完成的page/api改动仍未提交，保留它们；reports/network-prechange.diff保存本轮前态供归因。当前HEAD756cd97。

## 交付
ExtensionNetworkBridge实现NetworkToolsHost，闭包读取已有ExtensionPageBridge.target(sessionId)，因此同一会话绑定同一tab/frame/document；sidepanel注册network工具，新增dependency @einfach-agent/tools-browser-network。网络工具不触发主动业务请求。
通过现有activeTab+scripting+origin授权，在绑定page的MAIN realm使用120的createWindowNetworkHost；新增network-main.ts单独bundle entry。不加debugger/webRequest/全站持久host权限，不把MAIN世界操作搬进core。不使用任意eval/string脚本模型参数，固定method白名单。

## 推荐准确路由
chrome.scripting支持ISOLATED/MAIN，InjectionResult.documentId与target.documentIds自Chrome106提供（官方 https://developer.chrome.com/docs/extensions/reference/api/scripting）。
网络调用必须先在ISOLATED世界读取content-script拥有的逻辑document标识，与现有binding.documentId/revision/targetId校验；该次executeScript结果的原生documentId用于随后MAIN注入/调用的target.documentIds，不能仅frameId做check→use（导航竞态会读到新页面）。
content-script安装时登记一个仅扩展ISOLATED可见的只读绑定标记供固定probe函数读取；不能从DOM/page MAIN变量取授权凭据。网络MAIN bundle仅暴露有限call/cancel入口，内部创建120 host并按sessionId分开capture；全部结果视为页面不可信输入，固定结构验证+容量界限，不提升为指令。
- protocol增加独立network-call/cancel-network-call种类与NetworkMethod/结果，保留page-call行为；service-worker验证sender为本extension页面，同page现有路由一致。
- Cancellation不能只等待原Promise回复：bridge收到abort立即拒绝并尽力发cancel，late结果丢弃；main按requestId AbortController取消等待，不能取消页面业务请求。
- start失败不能留下无主capture；get/list/wait/stop在没有绑定/绑定过期时fail closed，不借当前activeTab重定向。重绑旧capture不能串用；stop/capture TTL由120限制。
- sidepanel pagehide尽力dispose network bridge，停止拥有的captures，仍沿用原client.dispose({preserveRecovery:true})；卸载不保证异步完成，因此120的短TTL是兜底，不声称后台永久抓包。MAIN不接收模型连接/Key/扩展storage数据。
- MAIN与ISOLATED互通请用固定executeScript函数的JSON返回值；避免可被网页postMessage伪造的授权通道。页面仍能影响MAIN返回数据，这与DOM内容一样是不可信观察数据，不能作为权限判据。
- 更新chrome.d.ts中executeScript类型覆盖world、func/args、documentIds与InjectionResult，不用any扩散遮住类型错误；新增entry打包后应自包含，不留import。

## 120消费合同
包名 @einfach-agent/tools-browser-network。NetworkCallContext=Pick<ToolContext,'sessionId'|'signal'>。
NetworkToolsHost methods均(input,ctx) Promise：
startCapture({urlIncludes?:string,methods?:readonly string[]})→CaptureStatus；
stopCapture({captureId})→CaptureStatus；
listRequests({captureId,offset?,limit?,urlIncludes?,method?})→NetworkListResult；
getRequest({captureId,requestId})→NetworkRequestDetails；
getResponse({captureId,requestId})→NetworkResponseDetails；
waitForRequest({captureId,urlIncludes?,method?,state?:'started'|'finished',timeoutMs?})→NetworkRequestSummary。
createWindowNetworkHost({window:Window,targetId,documentId?,maxRequests?,maxBodyChars?,maxDurationMs?})→NetworkToolsHost & {dispose():void}；registerNetworkTools(registry,host)。
CaptureStatus={captureId,targetId,documentId,active,startedAt,stoppedAt?,count,droppedCount}；
Summary={requestId,url,method,resourceType:'fetch'|'xhr',state:'pending'|'complete'|'error',startedAt,durationMs?,status?}；
Details extends Summary加requestHeaders、requestBody?、requestBodyState:'pending'|'captured'|'omitted'、requestBodyTruncated；
Response={requestId,url,status?,headers,body?,bodyState:'pending'|'captured'|'omitted'|'error',truncated,reason?}；
List={capture:CaptureStatus,requests:readonly Summary[],nextOffset?}。
从包根import，tool具体schema消费上述，不让model指定tab/target。

## 验收
桥单元测试覆盖方法完整、两session不同target、native documentId固定、导航竞态/旧capture、未授权sender、未知method、立即abort/late response、stop/dispose；验证MAIN只收到会话id和工具参数，不含模型凭据，页面fetch/XHR hooks来自120；运行既有extension测试（不跑CDP脚本）与build/tsc，manifest新增权限为0。report记录JS entry无外部import。真实配置页/纯Web网络fixture由140和编排CUA验证，不声称未经验证的真实MV3网络场景通过。


## 最新用户修正（优先于上文冲突部分）
用户明确要求页面打开时就注入采集器，以便对话读取此前初始化请求。已授权的站点需要动态注册两个document_start脚本（top frame）：content-script.js在ISOLATED、network-main.js在MAIN；只注册现有permissions已授予的origin，不增加全站必需权限。首次bindActiveTab申请origin成功后、handshake时完成动态注册并立即注入当前Document；已打开页注入前的请求不可回补，文档提示刷新后覆盖初始化。启动/安装与permissions.onAdded同步注册，onRemoved取消对应注册；注册过程串行、幂等避免并发重复ID，URL restricted排除。注册持久可覆盖后续重新打开页面、无需先打开侧栏/先有会话。
network-main在文档开始执行即同步调用120新增公开入口：installWindowNetworkRecorder({window,maxRequests?,maxBodyChars?,maxAgeMs?})→{dispose():void}。缓冲在同bundle模块WeakMap中，随后同一MAIN入口创建createWindowNetworkHost时共用。不要求先有逻辑binding/session。后续host仍使用可信ISOLATED probe的逻辑binding创建，native documentId pin不变。NetworkCaptureOptions新增includeBuffered?:boolean，默认true，start tool会快照本页面此前采集的记录，false只观察之后请求。
页面预缓冲默认最近100条、正文32Ki、记录滚动保留5min；页面recorder本身持续到pagehide/dispose，不因对话关闭停止，也不因session capture TTL停止。sidepanel dispose仅停止自己的capture，不能销毁页面预采集；session结束前对话记录不写storage。pagehide/bfcache按可验证语义释放或恢复，避免恢复后永远失去监听。权限撤销不再自动注入，并尽力通知已知/已打开匹配页面MAIN.dispose清预缓冲和hook（unregister不会删除已注入脚本，官方文档已说明）；不要声称无法保证的即时回收。
新增测试：注册两world document_start、仅授权origins、首次当前doc注入、重复并发handshake幂等、权限添加/撤销、未开对话已采集→开会话start读取早期请求、刷新新Document不沿用旧capture；无新增manifest必需权限/凭据传入。更新chrome.d.ts/register API和测试mocks，不破坏既有page桥。

## R1 独立审查修复
严格按reports/130-review.md修复3个Important；顺手可修同一注册函数中的Minor wildcard matcher（无需扩scope）。另编排发现route函数try中直接return routeNetwork(message)，异步拒绝可能绕过catch并让onMessage的route.then(respond)不回包，请定向复现executeScript reject并修正确保固定可理解错误且不会挂起。禁止再install，锁/链接由140独占。补真实模块network-main+120接线测试（纯jsdom，不是启动浏览器），页面预缓冲在没有对话时已捕获→会话读取、bfcache/刷新/撤权；与120最终生命周期实现对齐。报告reports/130-report-r1.md，只改extension。

## R2 生命周期补修
编排在R1最终源码发现真实缺陷：network-main.ts公开gateway.dispose（撤销权限时调用）只删除gateway，仍保留lifecycleKey与pageshow监听；之后BFCache pageshow.persisted会再次installGateway，在已撤销权限后重新开始采集。请区分页面暂挂（pagehide→允许pageshow恢复）与明确dispose/权限撤销（彻底终止并解除lifecycle监听）。显式授权后重新注入仍应正常安装。补实际MAIN模块“dispose→pageshow不重装；重新注入→可恢复”的回归。并同范围修R1 reviewer的Minor：合法空header value应允许，但仍限制类型/长度；不要允许空header name。只改extension/**及reports/130-report-r2.md，不install。由原reviewer范围复审。
