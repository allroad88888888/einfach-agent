---
id: '120'
title: 网络工具可捕获页面请求并读取响应
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-sol
status: done
base: 756cd97
files:
  - browser-agent/tools/network/**
---
# 网络工具可捕获页面请求并读取响应
用户追加“还有获取请求等”。仅改 browser-agent/tools/network/**；报告 reports/120-report.md。读index全局约束。使用one-file-one-thing，普通源码/测试≤300行，正常多行排版，每个tool目录实现+.md+测试。不得改core/agent/其他包、不提交、不启动浏览器。已有working tree是已通过上一轮的13工具，别重置。

## 交付
新增独立 @einfach-agent/tools-browser-network 包，private 0.1.0，依赖仅core，结构参考tools/api：package/README/tsup/tsconfig/raw-modules/公开index。6工具：start_network_capture、list_network_requests、get_network_request、get_network_response、wait_for_network_request、stop_network_capture。均中文description，schema不支持allOf/if/uniqueItems，必要处execute显式验证。普通readonly工具错误固定文案；start/stop有capture状态副作用，串行network:capture，不触发业务请求。

提供纯Web createWindowNetworkHost，在给定Window中观察之后发生的fetch/XHR，供嵌入方直接用；Chrome MAIN-world宿主由130调用同一factory。不捕获历史、WebSocket、图片/导航、service worker内部或其他frame独立realm流量，文档明确。

## 公开合同（130/140同步消费）
以下接口与类型均从包根export，不能擅改签名；如需调整先报告编排。
```ts
type NetworkCallContext = Pick<ToolContext, 'sessionId'|'signal'>;
interface CaptureRef { captureId:string; targetId:string; documentId:string }
interface CaptureStatus extends CaptureRef { active:boolean; startedAt:number; stoppedAt?:number; count:number; droppedCount:number }
interface NetworkCaptureOptions { urlIncludes?:string; methods?:readonly string[] }
interface CaptureInput { captureId:string }
interface RequestInput extends CaptureInput { requestId:string }
interface NetworkListInput extends CaptureInput { offset?:number; limit?:number; urlIncludes?:string; method?:string }
interface NetworkWaitInput extends CaptureInput { urlIncludes?:string; method?:string; state?:'started'|'finished'; timeoutMs?:number }
interface NetworkRequestSummary { requestId:string; url:string; method:string; resourceType:'fetch'|'xhr'; state:'pending'|'complete'|'error'; startedAt:number; durationMs?:number; status?:number }
interface NetworkRequestDetails extends NetworkRequestSummary { requestHeaders:Readonly<Record<string,string>>; requestBody?:string; requestBodyState:'pending'|'captured'|'omitted'; requestBodyTruncated:boolean }
interface NetworkResponseDetails { requestId:string; url:string; status?:number; headers:Readonly<Record<string,string>>; body?:string; bodyState:'pending'|'captured'|'omitted'|'error'; truncated:boolean; reason?:string }
interface NetworkListResult { capture:CaptureStatus; requests:readonly NetworkRequestSummary[]; nextOffset?:number }
interface NetworkToolsHost {
 startCapture(input:NetworkCaptureOptions,ctx:NetworkCallContext):Promise<CaptureStatus>;
 stopCapture(input:CaptureInput,ctx:NetworkCallContext):Promise<CaptureStatus>;
 listRequests(input:NetworkListInput,ctx:NetworkCallContext):Promise<NetworkListResult>;
 getRequest(input:RequestInput,ctx:NetworkCallContext):Promise<NetworkRequestDetails>;
 getResponse(input:RequestInput,ctx:NetworkCallContext):Promise<NetworkResponseDetails>;
 waitForRequest(input:NetworkWaitInput,ctx:NetworkCallContext):Promise<NetworkRequestSummary>;
}
function createWindowNetworkHost(options:{window:Window;targetId:string;documentId?:string;maxRequests?:number;maxBodyChars?:number;maxDurationMs?:number}):NetworkToolsHost & {dispose():void};
function createNetworkTools(host:NetworkToolsHost):readonly Tool[];
function registerNetworkTools(registry:ToolRegistry,host:NetworkToolsHost):void;
```
各tool工厂公开导出，命名createStartNetworkCaptureTool等。

## 捕获语义
- 记录按sessionId隔离；start重启当前session生成新captureId并清旧记录；他session不能读/stop/等另一个captureId。检查绑定Document仍是window.document，导航后旧host失败。
- 缺省每capture保留最近100请求，宿主maxRequests上限500；requestId稳定，淘汰返回受控not found，列表默认20最大100并带droppedCount。所有输出新建副本，调用方不能改内部记录。
- maxBodyChars默认32768、上限65536；只在内存，不写localStorage/IDB/钥匙串；捕获默认5分钟、宿主maxDurationMs上限10分钟，超时自动停止/卸载，stop后保留已捕获记录供读取，dispose清理。
- fetch包装保持原this/参数、返回同一个Response实例或原异常，不能因观察失败影响原请求；对clone的流有界读取，不能直接无界.text()。Request body不能消费原body。XHR包装原型open/send/setRequestHeader或等价机制，保留原同步/异步、事件和返回语义；abort/error/timeout受控记录。二进制、流式/SSE、opaque/不可读正文用omitted和固定reason。观察不重发/回放请求。
- 同一Window的多host/多capture不能反复套娃；使用模块内WeakMap共享observer订阅，最后一个订阅退出才恢复自己拥有的fetch/XHR包装；别覆盖第三方后来安装的包装。所有timer/listener/clone-reader随stop/dispose/TTL清理，迟到结果不串到新capture。
- URL去username/password/hash，敏感query值（token/api key/password/secret/session/cookie/authorization/csrf等）脱敏。headers只允许非凭据白名单（如accept/content-type），禁止Authorization/Cookie/Set-Cookie等进入缓存。
- 请求/响应JSON和urlencoded表单正文递归脱敏敏感键，限制深度/元素数量/文本大小；不可安全解析的JSON、超限JSON、binary/HTML等返回omitted，不把截断后的未脱敏JSON作为text输出。普通text/plain可有界展示，但不可透出headers或错误stack；record errors用固定文案。只对页面业务流量观察，不能注入模型key或宿主权限。
- wait默认5秒最大30秒，state默认finished，可先匹配已有记录；超时/AbortSignal立即停止等待且清timer/listener，停止捕获且无匹配时立即受控失败；可取消的是观察等待，不取消页面自己的fetch/XHR。
- 工具execute和host公开直接调用均校验参数（NaN/非法枚举/空id/负数/过大等）；pagination不用0 limit；不要依赖schema钳位掩盖非法直接host输入。

## 验收
真实registry→factory host契约；fetch成功/失败/Request object/正文不被消费/超大与不可读/敏感信息；XHR成功/失败/取消；A/B session隔离、同Window多个host、start替换旧capture、stop/TTL/dispose、保留/淘汰、wait匹配/timeout/abort/停止后失败、导航/iframe realm。使用可控fetch/XHR与真实同源iframe Document，必要时fake timers，但清理必须完整。每工具就近测试，包测试/build/行数+docs通过。120不能改rootalias；140负责接线，若包测试等alias未就绪先告知130/140已建package，请编排协调。不要跑CDP浏览器。


## 最新用户修正（优先于上文冲突部分）
用户明确：插件打开页面时就注入请求tool的一部分，获取对话开始前的请求。不能只在start tool时监听。新增公开早期采集入口：
```ts
interface WindowNetworkRecorderOptions {
 window:Window; maxRequests?:number; maxBodyChars?:number; maxAgeMs?:number
}
function installWindowNetworkRecorder(options:WindowNetworkRecorderOptions):{dispose():void};
```
此入口立即同步安装fetch/XHR observer，在模块内同Window共享、脱敏、有界的页面预缓冲区记录。默认100/最大500条，默认32Ki/最大64Ki正文，默认5分钟/最大10分钟记录保留时间；时间是滚动记录过期，不是5分钟后停止采集。采集器生命周期跟随当前Document/pagehide或dispose，刷新重新建立；重复install引用计数，不套娃、不能一个dispose破坏其他实例，最后释放清理hook/readers/timers/缓存。未安装recorder时host仍可按原按需模式用。
NetworkCaptureOptions增加 includeBuffered?:boolean，默认true：startCapture从同一Window当前Document的预缓冲区复制符合过滤器的记录（包括请求开始于会话之前，pending后续更新能正确接续），然后监听后续流量。false仅从调用后开始。多个会话各自captureId、过滤器、stop状态与记录副本隔离；它们可读取同一个已授权页面的预缓冲区，绝不串其他Window/Document。保留原session capture默认5min TTL。restart默认重新快照页面缓冲，旧captureId失效。stop只停止当前会话capture，独立的页面recorder仍监听到页面销毁/显式dispose，tool描述和README明确。
所有旧“不能捕获开启前请求”改为：可以读取早期recorder注入以后、对话开始之前的请求；注入前历史无法补抓。不回填伪造请求，不以performance历史元信息冒充有响应正文。新增验收：先install recorder→发真实受控fetch/XHR→后建session并start/list/getResponse可见早期记录；未授权/其他realm不可读；滚动过期与容量、stop不影响其他会话或页面recorder、dispose/pagehide清理、多次安装与重复注入、includeBuffered:false、pending继承。请尽早创建package.json并通知编排，供140安装。

## R1 独立审查修复（必须完整执行，不能只补happy path）
reports/120-review.md REJECTED，逐条修Critical与7个Important。源文件正常多行格式化也必须修（此前编排提醒后仍未落实），不要用单行函数/测试伪装≤300。按真实职责拆observer共享管理、fetch hook、XHR hook、body读取与sanitize、capture生命周期/验证；不要新增外部包或万能层。每工具就近真实run验证参数转发/错误，registry组合验收不能仅name断言。报告reports/120-report-r1.md准确列证据。
- 敏感key支持常见camel/snake/kebab变体，如client_secret/refreshToken/auth-token/session_id/csrfToken/API key；URL/嵌套JSON/urlencoded均回归，未知结构不把raw JSON截断输出。
- host构造本身不启动采集；active capture持hook，stop/TTL释放，只有独立recorder持续预采集。每实例limits不能被其他host拉大，recorder滚动5min不能被host改10min，有清理定时器。迟到更新不能把已淘汰旧请求重新插入recent缓冲/新capture，includeBuffered:false不能接收旧pending。
- 准确转发fetch原arguments/this；支持Request clone的安全JSON/text/form正文，URLSearchParams/string等常用body；不消耗原body不影响原Response/异常。readBounded解码前截字节，有界且cancel不await。
- XHR json响应支持递归安全脱敏，复用/同步/abort/error/timeout保持原语义；原open/header方法成功后再更新安全元信息，观察失败不改变业务，dispose清理所有listener。
- 生命周期裁决：所有pagehide停止当前捕获/清页面预缓冲/释放reader与hook，BFCache pageshow.persisted时仍存在的recorder引用重新同步安装，后续start可采新请求。与130及时对齐，不得回退为永久失去监听。记录不跨新Document；每window共享安装仅一份。
- host直接调用所有入口也要参数/ctx.signal校验（包括start已aborted不重置旧capture），wait先检查abort，再查匹配，读取返回副本；state finished应在response安全正文处理已结束后可见，不能snapshot在body pending时误报已完成。不要让错误字符串包含未经脱敏URL或stack。
验证命令使用根`pnpm exec vitest run browser-agent/tools/network/src`；不要pnpm --dir package test误跑整个仓库；不执行install。不删旧测试或松断言。新的行为用有意义测试证明，不为了数目复制实现。修完由原reviewer独立复审。

## R2 窄修（独立复审仍拒绝，必须逐项证明）
完整发现reports/120-review-r1.md，修4个Important与同路径pending状态Minor，报告reports/120-report-r2.md。重点按每个capture自身maxBodyChars安全裁剪/省略已脱敏record副本，多个host任意加入顺序都不能突破各自上限；observer共享只影响收集容量，不允许上限向消费者泄露。first recorder清旧records逐条cleanupRecord，所有await之后写回/emit之前复核record仍在当前observer的当前Document/generation，不要把已清除/过期/淘汰请求复活到新capture。maxAge变小时立即prune且重新设timer；精确类型校验可选methods与method（null/0/NaN/object等）统一INVALID_INPUT。Request clone读取中标pending。
新增最小有效回归：大host→小host、小host→大host、recorder→小host；旧pending request在first recorder安装/滚动过期/淘汰后晚返回不得进入新includeBuffered:false；短maxAge recorder接入已有observer后的主动清理（fake timers）；非法直接调用矩阵；pending正文状态。别仅添加用例名或mock目标实现。
new package.json的test脚本目前`vitest run`会在包cwd扫描整个repo而导致cwd失败；将其明确限定网络包并从正确root运行（或删除未承诺的test脚本，README保留已验证根命令），不要再实际误跑全仓。此修正不扩包范围。全部完成、源码冻结后仅发一次DONE，随后不要再改源码造成审查/构建证据过期。普通source/tests≤300，不install。
