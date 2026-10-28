# 浏览器 Agent：可嵌入的配置与运行包、独立视图、独立工具包

创建：2026-09-18
基线：`953ae7a118eb974e3bb6d134ef65d6fb23c5082e`（main，与 origin/main 同步）
Status: done (2026-09-21). 370/380 DOM tools and both consumers passed R1 independent reviews; 390 coverage audit approved. Local changes only.

## 通用DOM交互：自定义下拉选择（2026-09-21）
现场CUA确认最新“工单类型选择漏洞”：read_form识别13字段，field-1为custom-select/supported:false；read_field_options失败not exposed，select_option失败no options，wait超时。编排点击控件即看到“安全漏洞”及另3候选。缺通用DOM操作与节点定位，不能归咎候选数据不存在。
裁决：新增独立tools/dom包，复用PageRef/页面绑定/文档写队列；原生form工具保留，自定义控件走read_dom→click_dom→wait/read→click→read验证。移除扩展fixture-cities默认注册，演示仅在fixture。拒绝为DeepFOS硬编码class/value。用户开工授权足够，不重复确认。

| ID | 表面与精确入口 | 归属 | 证据 | 状态 |
|---|---|---|---|---|
| D01 | tools/dom纯Web节点读取、6工具、普通div弹层选择 | 370 | 370 R1 review、76tests、390-browser-check | done |
| D02 | DOM身份、隐藏/disabled、替换/导航/取消、写队列 | 370 | 370 R1 review/行为测试 | done |
| D03 | extension协议/bridge/content/service-worker/注册 | 380 | 380 R1实际组合、最终bundle | done（真实MV3业务未实测） |
| D04 | embedded + UI工具配置/演示完整调用闭环 | 380 | mock core双目标回读、CUA真实registry及25项目录 | done |
| D05 | workspace/依赖/边界/公开包/移除fixture-cities | 380 | 390-verification、packed ESM/d.ts、build/gates | done |
| D06 | 独立覆盖审计、组合回归、浏览器与产物证据 | 390 | 72files/254tests、390-review APPROVED、390-verification | done |

任务：370(sol)完整纯Web工具包；380(sol)固定合同接入两宿主与演示，完成等待370审查；390(sol)在两叶通过后独立覆盖审计/终审。370、380文件面不重叠并行。审查另派sol，只读。
## 本轮全局约束
- 用户已说“开工”，沿用本地task-tree直接执行，无远程issue、commit、push。
- 根cwd /Volumes/work/ai/web-agent；pnpm workspace。先读CLAUDE.md与.project-lines/SKILL.md相关工具线。不安装依赖或升级lock版本；380可独占补新增workspace importer/link和本地symlink，不运行pnpm install。保留全部已有未提交修改；前态快照见reports/370-before或380-before。
- 全部浏览器交互由编排者通过CUA完成；执行/审查者不启动浏览器、Playwright/CDP/Chrome for Testing、不访问或存入Keychain、不用真实模型/真实业务请求作自动测试。
- 包与视图分离：agent配置/凭证归agent，UI只是可选消费者，tools独立包。不为DOM操作重做runtime/状态/撤销引擎，不改变网络预捕获与无redo。
- 新增/大改普通源文件<=300行，复杂单一算法<=500须理由；执行者读one-file-one-thing skill。报告列文件职责与wc结果。
- 未获授权不自动扩展现有Agent的toolNames或既有session冻结能力。新工具可在现有配置选择后新会话使用，测试覆盖可选且真正可调。
- 子agent不得再派子agent。只能改任务files与自己的编号报告，不能改任务/index。实现后独立review，失败按R1/R2/R3闭环。
- 写操作复用page的enqueueDocumentWrite，PageRef绑定导航/文档身份与取消守卫不能削弱；没有后台重试或未知写结果重放。纯DOM事件isTrusted=false，文档明确真实限制，不宣称覆盖依赖可信键盘默认动作的网站。
- 本次目标top document（可以宿主显式传同源iframe.contentDocument）。跨源iframe/closed shadow不是本次交付；不增加debugger/全站权限。


## 任意时间任意消息撤销

用户明确整个设计应任意时间任一点可undo，现提示“超出可撤销历史”不应成为常态产品限制。已定位createSessionHistory默认调用einfach createHistory，cap100按事务而非轮数淘汰，旧用户items:append丢失。340(sol)内聚修复core历史保留/落盘配对及browser入口真实集成，350随后独立审查。U10全历史、U11耐久配对、U12压缩/运行/会话隔离、U13消息入口回填、U14仍被历史引用资源可达性都归340。

裁决：优先使用既有history/slots/driver，不另造checkpoint/历史引擎；移除产品时间/数量淘汰，不能将旧已遗失逆操作伪造为全状态恢复。新正常流程不制造历史不可用，外部副作用不假装可逆，真实legacy barrier保留安全检查。保持310无redo交互、320通用form及270网络采集。未经请求不commit/push/远程issue，禁止Keychain/CDP/真实模型。同步捕获与flush的确凿失配风险一并归此次恢复合同修正，不只改UI文字。

340裁决落地方案：复用createHistory公开cap禁用实际淘汰；恢复快照可选嵌入同刻history payload，借已有driver单记录CAS原子性消除双记录失账窗口；旧无嵌入快照仍按generation读legacy日志。历史仍引用的上传不在stop时释放，最终不可达时释放。没有新包/历史引擎。

340定向通过后，完整相关范围回归261files/2076tests仍有multiClient单项失败与defaultCorePlugins动态import未处理错误。新增discovered_from340的360(sol)限定诊断测试生命周期/插件初始化，不能以单文件绿掩盖组合失败；340源码冻结，350独立审查仍继续。

350首轮除barrier损坏引用校验外通过；唯一Important采纳，340 R1仅校验+就近测试。360独立诊断全量测试并发问题，文件面不相交。

340/350/360最终收口：U10–U14完成，350 R1独立PASS，360独立PASS无遗留质量项。取消默认100事务淘汰；状态与history同刻捕获并借既有recovery driver同记录原子保存；旧格式仍验证generation/barrier后兼容读。1205消息+中段checkpoint=1206事务，persist→新core hydrate→撤最早同时还原items/checkpoint实测通过。停止运行保留历史仍引用资源，分支最终不可达及会话删除有释放回归。旧已丢账诚实诊断，不伪造过去状态，无redo回归。

完整261files/2078tests通过（360-full-final.log），最后测试helper同步订阅防护仅定向2files/11tests复验通过；根build及core/IDB/browser runtime/UI/extension/embedded构建、state/boundaries/docs/diff门禁均通过。360实证只证明原1秒窗口结束仍running及清理竞态，动态import异常内部精确根因没有独立证明；未改runtime或预加载插件。ZIP逐文件/CRC核验通过并更新checksums。原生Chrome始终cgWindowNotFound，未在用户业务会话实际撤销；需要重载既有扩展/刷新页面读取新产物。无commit/push/远程issue/模型请求/钥匙串。

## read_form自定义控件补全

用户指出下拉等控件仍遗漏。原生Chrome确认当前只读7字段，实际还含4个happy-input树选择和2个同源iframe富文本。320(sol)内聚修复page工具包的控件发现/元数据/回归；独立审查随后执行。沿用task-tree与one-file-one-thing，不新增包。D01发现、D02身份/兼容、D03真实语义、D04选项只读/暴露状态、D05现场形状回归都归320。裁决：read_form读取已在DOM暴露的选择信息，不自动点击加载远程候选；unsupported写能力不能冒充控件readOnly。当前页目标13逻辑控件，精确结果由最终真实bridge验证。

用户追加裁决：通用工具先覆盖传统form及非传统表单，默认按原生/ARIA语义/受约束DOM结构发现；站点专属放已有adapter。happy-input等现场名字只作fixture，不能成为生产识别前提。此约束写入page包README作为设计约定；不新建全局memory skill，不扩大包架构。320合同已更新。

320首轮实机13字段及50项测试通过；330独立审查提出3个Important：嵌套popup候选混入value、presence占位符误读、hidden祖先下选项暴露状态误报。均属通用读取合同内，R1采纳修复，未扩大工具能力。

320/330最终收口：D01–D05已完成，330 R1独立PASSED无遗留质量项。通用原生/ARIA/受约束DOM发现，特殊组件仍走现有adapter；候选/占位/当前值及隐藏祖先状态边界均有回归，原生datalist兼容保留。page16files/52tests、扩展桥接+工具预览2files/13tests、page/extension/embedded构建、根tsc、state/boundaries/docs/diff检查均通过；ZIP重新生成且字节/CRC核验。R0原生MV3新document实际13字段（原7），补四自定义选择器及两richtext；R1时Chrome窗口不可用，最终安装实例未重载复验，需重载扩展并刷新目标文档。报告320-report.md、320-verification.md、320-browser-check.md、330-review.md。已将通用边界写入page README，没有新包、全局memory skill、commit/push或远程issue。

## 最新裁决：移除重做

用户明确要求移除重做，覆盖290的redo需求。310(terra)执行当前UI中的小型删除：删重做入口/回调/草稿恢复专属状态、已撤销占位和无用样式；保留每条消息的undo与原话回填聚焦。共享core通用日志API不在此次产品交互删减范围，避免破坏其他宿主。更新既有测试和构建；不操作用户当前浏览器对话、不重复请求确认。

310已完成：UI 8files/30tests、UI/extension build、tsc -b、diff检查通过；编排亲验state门禁与最终源码/dist无redo UI残留，IIFE保留，ZIP逐文件/CRC校验通过。310-review.md独立PASS。撤销后只保留回填原话，不再留撤销占位。安装实例未本轮重载，需重载读取新dist。无core/其他工具修改，无commit/push/远程issue。

## 撤销回填与明确重做入口

用户要求撤销后原话回到输入框并有redo。290(sol)内聚修复UI/就近真实core集成，随后独立审查；沿用240日志命令，不新建历史存储。裁决：每条已撤消息下显示“重做”；成功撤销回填并聚焦，失败不改草稿；重做只清仍未编辑且来源已恢复的回填草稿。用户编辑过的草稿保留。按既有task-tree授权直接修复；编排只读浏览器QA，不操作真实业务对话history、不用真实模型/钥匙串/CDP。覆盖U01回填聚焦、U02原位重做、U03草稿编辑/分支、U04会话client隔离均归290。

290/300收口：U01–U04已完成。成功撤销精确回填原话并聚焦；同文字/运行中撤销与拒绝保留草稿均回归；原位明确“重做”，未编辑回填来源恢复后清空、用户编辑草稿保留。8files/30tests、UI/extension/embedded builds、tsc、state/boundaries/docs、ZIP逐文件校验通过。300独立PASSED无遗留质量项。原生Chrome本地真实core+模拟模型的中间撤销/全撤/重做/草稿保留实测见reports/290-browser-check.md，编排验证reports/290-verification.md。安装实例未本轮重载（用户并行使用浏览器，未争抢焦点），最终需明确重载生效；不是已装实例验收。无core新增修改、无commit/push/远程issue。

## 真实页面字段标题与自动请求采集续修

用户再次指出read_form拿不到title、插件加载时就应该开始请求采集。编排原生Chrome观察fields前两项“请输入”，真实标题“问题标题/问题链接”；请求0条且模型误称刚开始监听。原生DevTools只读发现当前gateway已存在，不能把0条径直归因未注入。代码另证注册不覆盖已开页面、5min缓存会全过期、list强制先start。260(sol)独立page包标题修复，270(sol)network+extension生命周期修复，280(sol)联合独立审查。沿用task-tree与one-file-one-thing，不重开包/远程issue、不访问钥匙串、不启动CDP、不改manifest授权；现有业务页只读，不提交表单或发真实模型消息。

| 覆盖 | 入口 | 归属 | 状态 |
|---|---|---|---|
| F01–F03 | DOM字段title/就近表单项/真实形状回归 | 260 | done：43测试与真实readForm七字段标题 |
| N07 | 已开页面+document_start自动注入/授权生命周期 | 270 | done：v3实际26条预采集、重复handshake保留 |
| N08 | 文档连续预采集/有界缓存/可观测开始时间 | 270 | done：40项network回归与原生开始时刻验证 |
| N09–N10 | 直接list预缓冲/读取结果/隔离与MV3接线 | 270 | done：33扩展回归、真实dist重复eval与MV3全桥 |

裁决：保留页面数目/正文容量限制，但不让用户停留五分钟就丢掉未查看的初始化请求；不承诺恢复插件安装前历史。所有请求暂按页面全部fetch/XHR，资源请求扩展等待用户可选答复；不以超时当作授权。用户本轮明确要求看浏览器，允许只读当前真实结果与DOM诊断；若需更新/重绑用已有权限，新增授权仍由用户。

260/270/280最终收口：260实际MV3 readForm已返回问题标题/问题链接/系统环境等七字段；270首次native发现classic bundle重复注入重置顶层WeakMap而在handshake后RECORDER_UNAVAILABLE，R1以IIFE隔离、gateway版本3和有界错误envelope修复。可复验脚本network-main-classic-dist.mjs先build当前产物再同Window经典eval两次，保持早期request/response。编排v3真实全桥首次无start读26条；第二次handshake后仍26条、早期ID全部保留、监听时刻不变；HTTP200响应正文读取407字符。280独立PASSED，无遗留质量项。根build/state/boundaries/docs、embedded build与最终ZIP字节/CRC校验通过；报告260-270-browser-check.md、280-review.md。已重载用户既有插件，保持原网站权限，未发真实模型/填写表单/触碰钥匙串/commit/push。旧已开页的content listener更新需刷新目标文档，本次专用新document已实测；旧版MAIN升级一次会清理旧闭包，不能恢复注入前数据。

## 消息下的撤销与重做

用户纠正redo/undo应在每条用户记录下面，原底部全局栏不合适。240（sol）内聚实现精确轮次core命令+UI，250（sol）独立审查，不另建包。裁决：复用retractTurn与现有日志，补显式session；被撤消息在原位置淡化占位并提供目标式redo，redo回放既有状态不重新请求模型。不能把同一全局undo函数挪到各消息下假装目标化；占位从现有日志投影，不另建history存储。

| ID | 表面 | 归属 | 状态 |
|---|---|---|---|
| H01 | 每条用户消息下精确撤销/不可撤原因 | 240 | done：真实core/UI回归、360 CUA |
| H02 | 已撤消息占位与重挂/全撤后的恢复入口 | 240 | done：hydrate回归、360原位占位截图 |
| H03 | 恢复所选轮的已有结果、不重跑模型工具 | 240 | done：真实sendMessage/fetch计数回归 |
| H04 | 新分支/屏障/异步运行/多会话隔离 | 240 | done：定向core与既有屏障回归 |
| H05 | 窄宽消息动作与现有布局配置回归 | 240 | done：360图证、R1键盘回归、220容器证据 |

240/250收口：独立复审PASSED（R1），禁用原因可聚焦读取且不可误激活；已撤占位不再整体透明，保留恢复按钮对比。相关core/UI等41测试与R1 UI16测试通过（有重叠，不累加），core/runtime/UI/extension/root build、编排最终tsc/docs/diff与embedded build通过；ZIP已更新且逐文件校验。证据reports/240-report.md、240-browser-check.md、240-verification.md、250-review.md。浏览器限制明确：原生只实测360三轮入口、中间撤回/原位占位；redo/最终CSS/本轮宽屏由真实core回归及既有布局验证补证。用户并行使用Chrome，未争抢焦点或重载当前插件，需用户重载生效；未commit/push。

## 对话优先的侧栏续改

用户明确认为信息臃肿、对话太小，要求将多数功能收进右上角设置。220（sol）负责现有UI与扩展壳，230（sol）独立审查；复用现有包/配置表单，不增业务层。裁决：默认仅紧凑会话工具栏与齿轮，设置页再显示三个配置栏目；聊天填满可用高度、输入区停在底部，页面绑定缩成一行。保留设置来回时会话/草稿，切client仍隔离。用户明确方向与继续执行授权足够，不再次询问布局偏好。

| ID | 表面 | 归属 | 验证 | 状态 |
|---|---|---|---|---|
| C01 | 默认对话工具栏/去重复头部 | 220 | 220-browser-check.md，宽/360/真实侧栏截图 | done |
| C02 | 设置齿轮、3配置页、首配与焦点返回 | 220 | 47项UI/extension回归；CUA焦点与草稿返回 | done |
| C03 | 消息滚动区与固定底部输入框 | 220 | 360有消息/草稿截图、宽版等待截图 | done |
| C04 | 运行/确认/恢复/历史操作及目标行 | 220 | 命令回归；运行详情折叠；真实侧栏重绑定 | done |
| C05 | headless隔离、生产嵌入和扩展高度 | 220 | builds/根tsc/隔离回归/230 PASSED | done |

220最终收口：12 files/47 tests通过，最后测试only补history details真实入口后10/10通过；UI/extension构建与编排根tsc、ZIP逐文件/CRC校验通过。真实Chrome已重载新布局，消息占主要高度、输入框在底部。运行内部详情与工具参数结果默认折叠。230独立PASSED无遗留质量项；报告220-verification.md、220-browser-check.md、230-review.md。未commit/push/远程issue。

200权限弹窗随后消失，编排只读观察到真实ai录数会话已绑定项目问题详情（200-browser-r1.md）。没有代用户点击授权。本次布局仍用本地模拟预览验证，不将布局请求当作新增授权。

200 R1 现场修正：用户说仍不能新建会话，编排在用户现有原生 Chrome/cloud.deepfos.com 实际点击工具栏、扩展菜单、选 ai录数、新建会话，均回到权限提示，没有 session。Chromium ExtensionActionRunner 源码证实自动 sidePanel action 提前 return，跳过 activeTab 授权。裁决：显式关闭自动 toggle，改同步 action.onClicked→sidePanel.open；不扩大权限。200 原执行者 R1 修正，210 独立审查；最终完成必须有同一真实页面的新建会话/绑定证据。原 PASSED 仅历史模块验证，不再冒充用户路径通过。

## 新建会话的活动页面权限修复

200（sol，done）与210独立审查PASSED：修复有tabId但没有URL读取权限被误报“无活动页面”的问题；用Chrome133+按tabId请求单网站授权，缺能力时给明确操作提示，授权后用户重试进入原绑定流程。无tab、受限网页与授权被拒分开处理，不新增tabs/全站必需权限。27项扩展回归、build、根tsc通过；ZIP已更新。编排证据200-verification.md，独立报告210-review.md。真实用户当前tab的权限数据未读取、真实MV3授权未实测；用户重新加载扩展后重试，没有代用户授予网站权限。

追加小型增量已完成：新建模型连接预填 DeepSeek V4.1 Flash、https://api.deepseek.com/v1、deepseek-flash，Key为空；仅UI草稿，不自动覆盖或写入已有配置。180执行、编排抽查源码与既有回归；2文件11项定向测试、UI/extension build、app tsc通过。ZIP已更新校验。190既有视觉审查保持历史，本小型转录增量没有冒称再经独立审查。原生Chrome已被用户切到其他页面并关闭预览，本轮未再次导航或刷新插件，重载后读取新构建。

## 视觉改版

用户认为当前界面很丑；沿用原任务树续修，不请求重复执行确认。180（sol，done）负责可选UI全部呈现、extension目标条和fixture预览壳；190（sol，done）独立审查兼覆盖审计。
覆盖V01主导航/空态、V02模型Key、V03Agent/技能能力、V04对话状态、V05窄宽嵌入/扩展壳，均归180；全部done，190独立复验PASSED。基线是160已验收源码前态，不回滚旧能力。
裁决：采用白底深灰文字、少量重点蓝、单层四栏目导航；工具配置折叠以减少首屏噪声。只改视图，不增加包或业务层。源码改动由执行agent完成，编排看真实浏览器与审查。
170记录后用户已自行安装插件，2026-09-20 CUA观察到实际侧栏。此轮视觉优先用现有预览，不授予业务网站权限、不触碰钥匙串；可在相同权限下更新已装插件。

用户追加指定GitHub Apple design skill。已下载dickwu/apple-design-skill@da2da6dd03aacf06da3fecf205347601d38bb141到个人skills/apple-hig-design，原动效skill保留。180/190必须按其HIG规范实施与审查；仅阅读规范，不执行外部脚本。浏览器侧栏使用Web基础设计原则，不伪造原生系统窗口。

## 模型与 API Key 配置续修

- 160（sol，done R1，discovered_from 040）：明确配置入口、首次连接→Agent→对话流程、模型选择、模拟预览说明；范围仅 ui 与必要 README，独立审查后回收 C08/C10。
- 裁决：用户持续授权与本次反馈足以继续修正，不再次询问是否执行；不增包或改业务运行层，避免把界面问题扩大为架构重做。
- 现场证据：原生 Chrome 实际打开“配置→连接”能看到 Endpoint/模型/API Key 表单；Agent 已有模型 select，但 fixture 仅 precise-1。原040功能代码存在，入口/首配可用性验收不足，原报告保留为历史。
- 覆盖：M01 空态/常驻入口（View/ChatView/SettingsView）；M02 连接表单与下一步（ConnectionEditor）；M03 Agent 选模型与管理入口（AgentEditor）；M04 模拟预览与360px/宽屏（tests fixture）。均归160且done；160-review-r1.md独立覆盖审计PASSED，160-browser-check.md与160-root-verification.md为编排证据。
- 用户最新钥匙串约束优先于旧040浏览器脚本说明：只用现有原生 Chrome/CUA，不启动 Chrome for Testing/CDP，不访问系统钥匙串。

160 独立审查发现client身份切换会保留旧表单草稿，R1按公开嵌入视图边界重置本地状态并补回归；宽屏与360px CUA新表单已核实。R1已独立PASSED，48 files/179tests、构建与ZIP校验通过，160 done。原生浏览器键盘中止未冒称已测，由user-event焦点测试补证。

## 追加网络请求工具

| 任务 | 交付 | 模型 | 状态 |
|---|---|---|---|
| 120 | 独立network工具包，纯Web fetch/XHR捕获及6工具 | sol | done（R3独立通过） |
| 130 | 扩展绑定页面的MAIN-world捕获桥 | sol | done（R2独立通过） |
| 140 | 配置19项工具、真实本地请求演示、workspace接线与覆盖 | sol | done（R1独立/CUA通过） |

裁决：按用户持续授权直接扩展；先做观察页面请求/响应，主动发起任意请求不在本次默认范围。可选澄清已发，未阻塞此独立捕获工作。新包仍放browser-agent/tools/network，沿用每工具包一个完整子issue；三个文件面互不相交，按固定合同并行，130/140最终done等待上游审查。
裁决：选纯Web fetch/XHR observer以便客户无UI嵌入，扩展在已授权的目标文档MAIN realm装配它；沿用现有scripting权限，固定Chrome原生documentId避免导航竞态，不引入debugger权限。可读取页面recorder注入后、会话开始前的缓存请求；不能恢复注入前历史/其他realm/worker/WebSocket。
边界：内存记录按会话隔离、有容量/正文/时间上限，凭据头与敏感参数先脱敏；观察不消费原请求body或重发请求。所有测试仍不操作系统钥匙串；真实浏览器交互仅编排CUA，不启动CDP脚本。
覆盖矩阵：N01工具与纯Web捕获→120；N02隔离/脱敏/有界→120；N03扩展document路由/取消→130；N04配置19项/本地真实HTTP演示→140；N05公开包/无UI嵌入→140；N06早期注入与对话前请求→120/130/140。证据已齐，150独立覆盖审计收口。上一轮working tree前态保存在reports/network-prechange.diff，禁止把已有增量误当本次新增或回滚。

## 追加工具扩充

| 任务 | 结果 | 模型 | 依赖 | 状态 |
|---|---|---|---|---|
| 080 | 页面读取、表格、下拉选项、等待、选择、清空六个新工具 | sol | 无 | done R1 |
| 090 | 授权数据源发现工具 | terra | 无 | done R1 |
| 100 | 扩展桥与预览完整工具清单和覆盖验收 | sol | 固定合同先开工；完成等待080、090 | done |
| 110 | 最终组合测试失败归因与稳定验证 | sol | 080、090、100 | done |

裁决：用户已授权增加工具，沿用本地任务树直接推进，不重复请求执行确认。工具仍归两个既有工具包；不增加SDK或宿主框架。新增7个业务工具，总计11个；加2个Skill工具，完整配置页显示13个。
裁决：预览原来只注册Skill工具，是工具列表偏少的直接原因；100接入真实工具并将演示业务DOM放独立iframe，避免工具误读配置界面。所有浏览器交互本次由编排者通过CUA完成，执行者不启动Chrome或CDP脚本。沿用禁止系统钥匙串访问/存入的用户约束。
覆盖矩阵（全部完成）：

| ID | 表面 | 归属 | 证据 | 状态 |
|---|---|---|---|---|
| T01 | 页面内容与表格读取 | 080 | reports/080-report.md、reports/080-review-r1.md；可见性/分页/替换/iframe | done |
| T02 | 字段选项、等待、选择、清空 | 080 | reports/080-report.md；真实DOM/registry拒参/取消/旧字段/partial failure | done |
| T03 | 授权数据源发现 | 090 | reports/090-report.md、reports/090-review-r1.md；权限/分页/兼容/脱敏 | done |
| T04 | 扩展绑定、文档身份、取消 | 100 | reports/100-report.md、reports/100-review.md；桥与protocol测试 | done |
| T05 | 配置页13项工具与隔离预览 | 100 | reports/100-browser-check.md；CUA实际可见及iframe真实调用 | done |
| T06 | 公开包与嵌入兼容 | 100 | reports/100-report.md、reports/tools-final-dist.log；22 packed包/NodeNext | done |

裁决：100按任务内固定签名并行开始装配，文件范围与080/090不相交 — 减少等待且不新增抽象 — 上游若改变签名由编排同步，100最终done仍等待080/090独立审查；编排+执行合计最多4个活跃agent。

090首次审查REJECTED：发现实现收紧了原source注册校验。编排采纳兼容性发现，撤回早期“与query id限制对齐”建议，R1恢复既有构造器合同并补回归。新增工具不改变原调用行为。

090 R1独立PASSED，API26项测试与包build通过，编排亲验新工具8项通过。080完成进入独立审查，100预览catalog验证13项，准备编排真实浏览器检查。

编排CUA检查通过，配置页实际显示13项；100新增fixture辅助文件未用testFixtures命名导致state门禁失败，交100窄修命名，不扩大白名单。browser-agent整体106测试中105通过，旧client.integration固定30ms等待断言失败，编排定向复核；其余新增工具组合测试全部通过。边界/docs已通过。

080独立REJECTED，R1补关闭details/visibility:collapse隐藏内容过滤及页面包自己的iframe读页/读表测试；100已有iframe集成证据，不以其替代页面包独立验收。其他工具验收通过。

100源扫描命名修正完成，state/tsc和8项集成复验通过；旧client.integration定向8/8通过（tools-client-recheck.log），首轮为固定30ms等待在并行负载下的时序失败，保留原日志，不改无关运行包代码。100进入独立审查，最终完成仍等080 R1。

080 R1独立PASSED、100独立PASSED，三个追加实现叶全部done，工具本身与CUA覆盖完成。编排最终组合107项中105通过，仍有client/multiClient两项旧测试失败且出现defaultCorePlugins is not iterable；不再按单纯30ms超时裁定，创建临时基线worktree对照756cd97（只读产品、不带当前diff），核实是否既有组合问题后收尾。state/根tsc/最终extension及embedded重建已通过。

基线19files/82tests通过，尚不能把当前组合失败归为基线缺陷。新增发现110，范围限两个旧集成测试，优先调查测试生命周期与真实终态等待；不允许通过预加载plugin、mock内核或放宽断言掩盖问题。若需runtime改动先报告根因再裁决。原测试日志全部保留。

110完成：仅修两旧测试等待真实run done，保留原断言；定向11/11、原默认并发browser-agent完整27files/107tests均通过，无unhandled errors。进入独立复审并收口终审；产品跨包终审已PASSED。编排最终tsc与dist再次通过（22 packed包/32 ESM入口）。

最终收口：110独立PASSED、reports/tools-final-review.md整树PASSED，无遗留质量发现。107项组合测试、相关包build、根tsc、state、boundaries、docs与dist全部通过。最终CUA再次确认配置页13项可勾选并停留该页，4178服务保持运行。试用ZIP已由最新dist重新生成并逐字节/CRC校验，checksums已更新；临时基线worktree已清理。只验证本地fixture与公开合同，客户站点/API及Edge继续属于既定未验证范围。

本地试用交付：[安装说明与压缩包](artifacts/README.md)。插件和嵌入示例均来自已验收的 dist，逐文件比对及 ZIP CRC 检查通过，未改变产品代码。

## 本地提交交接

- 用户继续推进后，将已验收实现固定为本地提交 `756cd97`：`feat(browser-agent): add configurable extension and headless packages`。
- 提交前重新生成产品 diff，与终审保存的 `reports/final-scope.diff` 逐字节一致，SHA-256 为 `ffe1d15456d6484345fa5ecfc585d8673ef2bef55d70e9d3cb03e72876096099`；没有新增产品修改，不重复已通过的6650项测试。
- 提交包括162个源码、测试、构建配置及必要说明文件。任务树、报告、截图与试用压缩包留在本地；未push或创建远程issue。
- 下一阶段真实业务接入需要客户页面地址、接口请求/响应示例及鉴权方式；现有默认扩展仍使用明确标注的fixture-cities示例数据源。

## 目标与包边界

在现有 Web Agent 上提供浏览器扩展：创建多个 Agent，分别配置 instructions、skills、tools、模型连接与 API key，
通过页面工具和业务接口完成表单填充。客户可以只用运行包和工具包，完全使用自己的界面。

```text
browser-agent/
├── agent/       @einfach-agent/browser-agent：全部 Agent/Skill/模型连接配置、运行装配与持久化
├── ui/          @einfach-agent/browser-agent-ui：可选 React 视图，包含配置表单与对话展示
├── extension/   @einfach-agent/browser-extension：扩展入口、消息桥、权限与目标页面绑定
├── tools/
│   ├── page/    @einfach-agent/tools-browser-page：读表单、填字段、回读校验
│   └── api/     @einfach-agent/tools-browser-api：按已注册业务数据源查询选项
└── examples/
    └── embedded/：客户自有界面接入示例，不是新增 SDK 包
```

依赖方向：`extension → agent + ui + tools`；`ui → agent + agent-react`；`agent → 现有 core/ai/persistence`；
`tools → core/tools`。Agent 包通过 `registerTools(registry)` 接受工具注册，不硬编码 page/api 包。
页面 DOM 与请求适配合同归各工具包；Chrome 消息路由归 extension，不向 core 添加浏览器专用宿主总线。

## 范围与默认值

- 用户已确认：一个总目录；多个 Agent、Skill 配置、API key 等逻辑集中一个包；展示一个包；tools 多个包。
- 用户已确认：每个独立工具包一个子 issue；同一包的实现、测试、说明一起验收，不按单函数拆 issue。
- 用户已明确：不要在远程创建 issue；本树只在 `.tasks/browser-agent/` 维护，不同步 GitHub。
- 规划默认：Chrome/Edge Manifest V3，侧栏持有运行实例，service worker 仅协调扩展生命周期与消息。
  关闭侧栏后允许运行中断，重开走恢复；不承诺后台持续推理。用户确认按本计划继续实施。
- 规划默认：先支持原生表单与一个受控组件 fixture；通过适配器接客户组件，不承诺任意网站自动兼容。
- 已有会话保留创建时的 Agent revision、instructions、模型连接身份与 Skill 内容版本；配置修改作用于新会话。
  API key 只按连接 ID 在执行时解析，轮换 key 不复制旧密钥进会话；删除连接后旧会话明确不可运行。
  同一连接的 endpoint/model 配置编辑也不能静默改写已有会话的请求目标；密钥轮换与 endpoint 版本分别处理。
- 多 Agent 指多个可配置角色与各自会话；第一版不新增 Agent 团队编排、Skill 市场或动态下载执行代码。
- 没有真实客户接口资料；验收用本地表单与确定性接口 fixture，不把示例业务当成用户已经指定的需求。
- 第一版只读页面、填字段、检查字段与查询数据；最终业务提交、跨源 iframe、关闭的 Shadow DOM 不在范围内。

## 可复用基础与必须补齐的接缝

| 已核实入口 | 复用方式与缺口 |
| --- | --- |
| `packages/agent-core/src/runtime/core/createCore.ts` | 已有隔离 core 与实例命令；不用 defaultCore。 |
| `packages/agent-core/src/runtime/commands/sessionCommands.ts` | 复用会话 CRUD；其持久化调用仍有默认实例路径，需用双实例测试修正实际触达的路径。 |
| `packages/agent-core/src/runtime/commands/runLifecycleCommands.ts` | 当前 send/stop 依赖 activeSession；新增显式 sessionId 入口，保持现有调用兼容。 |
| `packages/agent-core/src/runtime/modelTurnPrefix.ts` | instructions 当前来自 core.config；须让已绑定会话使用自己的快照。 |
| `packages/agent-core/src/state/sessionCapabilityPolicy.ts` | 复用草稿、锁定 allowlist、递归调用限制；不重建工具权限系统。 |
| `packages/agent-core/src/runtime/toolContext/skillsCapabilities.ts` | 已有 Skill summary 快照；需补正文与资源读取的一致版本来源。 |
| `tools/skills/src/skill-read/skill-read.ts`、`tools/skills/src/skill-search/skill-search.ts` | 当前内置内容偏静态注册；让配置 Skill 的 list/search/read 共享注入源，保留旧来源行为。 |
| `packages/agent-ai/src/providerLocalTransport.ts` | 复用浏览器模型 transport；避免复制 Web app 的全局 connection/provider registry。 |
| `packages/persistence-idb/src/index.ts` | 复用 sessions、recovery、history log；实例使用独立命名空间，保留已有 checkpoint/undo。 |
| `packages/agent-react/src/coreStoreBindings.tsx` | 复用 Provider 与只读 atom 订阅；不搬入 apps/web 的产品 settings 单例。 |
| `tools/interaction/src/browser-action/browser-action.ts` | 目前只是 render_card，不是页面操作工具，不能冒充现成 DOM 自动化。 |
| `scripts/check-boundaries.js`、`scripts/check-dist.js`、`scripts/state-invariants/sourceFiles.js` | 当前枚举根目录未含 browser-agent；应扩扫描面，不豁免新包。 |

历史依据：`953ae7a` 已将 compaction 变为可恢复工具，`9114530` 已提供不可变会话能力；本项目继续复用两者。

## 全局约束

1. 不复制模型循环、会话消息、checkpoint、JSONL/历史日志或 undo 状态；复用现有 core 命令与写入器。
   Agent/Skill/连接目录是新增产品配置，允许独立持久化；运行态仍只有 core 一份。
2. 运行包、工具包不得 import React、UI、Chrome API、apps/web 私有文件或 Node 运行时；浏览器适配在扩展入口注入。
   UI 只能调用命令与读取状态；core 不反向依赖任何新产品包。
3. 使用公开 package exports；确有下游消费者才增加出口。禁止另造 profiles/host/sdk 包或万能插件框架。
4. 用户配置不进入代码执行：Skill 是文本与文本资源，API 数据源是宿主注册适配器，模型不能指定任意脚本执行。
5. 明文 key 不出现在公开配置快照、prompt、日志、导出或 content script 消息；UI 仅显示 configured 状态。
   模型与业务 API 凭据分开，禁止把已有真实凭据用于测试；本地凭据持久化不声称为安全保险库。
6. 每个会话显式绑定 Agent revision 与页面目标；切换 UI 选中项不能改变正在执行的会话、模型连接或目标页。
7. 页面写入按文档串行，导航/取消后拒绝迟到写入；未知写入结果保留现有恢复围栏，不自动重放。
   对话撤销不代表网页或业务系统外部副作用已撤销，UI 必须准确显示这一边界。
8. 纯浏览器交付不依赖本机服务或远端转发服务；跨域、权限和鉴权失败应为可理解的业务错误。
9. 普通新增/大改文件 ≤300 行；强内聚单一状态机可 ≤500 行并说明原因。按职责拆文件，不按行数拆 issue。
10. 编排者只写 `.tasks/`；执行者仅改自己的 files 与 report，禁止派子 agent、提交、push、发布与无关重构。
    用户已授权按本树实施；不创建远程 issue。每项经过独立审查，最多 4 个并发执行任务。
11. 执行前读取仓库 CLAUDE.md 与 .project-lines/SKILL.md 的相关主线；用户确认的新浏览器产品边界优先于旧宿主限制。
    改 Markdown 运行 `node scripts/check-docs.js`；不能将文档中的历史描述当作当前代码事实。

## 已实现的公共契约

以下基础合同已经010实现且R2独立审查确认，配置类型与客户端完整签名见 browser-agent/agent/src/types.ts；070新增可恢复关闭参数也已R1独立审查通过。

```ts
type BrowserCore = ReturnType<typeof createCore>; // createCore 来自 core/plugin
interface AgentProfileInput {
  id?: string; name: string; instructions: string;
  connectionId: string; model: string;
  toolNames: readonly string[]; skillNames: readonly string[];
}
interface AgentProfile extends AgentProfileInput { id: string; revision: number }
interface ConfiguredSkillInput {
  name: string; description: string; triggers: readonly string[];
  content: string; resources: Readonly<Record<string, string>>;
}
interface ConfiguredSkill extends ConfiguredSkillInput { revision: number }
interface ModelConnectionInput {
  id?: string; label: string; baseUrl: string;
  models: readonly string[]; apiKey?: string;
}
interface ModelConnection {
  id: string; label: string; baseUrl: string;
  models: readonly string[]; credentialConfigured: boolean;
}
interface BrowserAgentSnapshot {
  agents: readonly AgentProfile[]; skills: readonly ConfiguredSkill[];
  connections: readonly ModelConnection[];
}
interface BrowserAgentClient {
  readonly core: BrowserCore;
  getSnapshot(): BrowserAgentSnapshot;
  subscribe(listener: () => void): () => void;
  saveAgent(input: AgentProfileInput): Promise<AgentProfile>;
  deleteAgent(id: string): Promise<void>;
  saveSkill(input: ConfiguredSkillInput): Promise<ConfiguredSkill>;
  deleteSkill(name: string): Promise<void>;
  saveConnection(input: ModelConnectionInput): Promise<ModelConnection>;
  deleteConnection(id: string): Promise<void>;
  createSession(agentId: string): Promise<string>;
  dispose(options?: { preserveRecovery?: boolean }): Promise<void>;
}
function createBrowserAgent(options: {
  namespace: string;
  registerTools?: (registry: ToolRegistry) => void; // core/tools 的原生合同
  fetch?: typeof globalThis.fetch;
}): Promise<BrowserAgentClient>;
```

scope、发送、停止、确认、恢复、undo 继续通过 `client.core` 的实例命令，不再镜像一套运行 facade。
010 在既有返回值不变的前提下实现以下兼容签名；未给 sessionId 时保持原 activeSession 语义：

```ts
sendMessage(input: SendMessageInput, options?: { sessionId?: string }): Promise<SendMessageResult>;
stopRun(options?: { disposeUserContent?: boolean; sessionId?: string }): void;
confirmTool(approved: boolean, always?: boolean, sessionId?: string): void;
answerQuestion(questionId: string, value: AskUserAnswerValue, sessionId?: string): void;
resumeWithAnswers(sessionId?: string): void;
continueInterruptedRun(sessionId?: string): void;
undoTurn(sessionId?: string): HistoryCommandResult;
redoTurn(sessionId?: string): HistoryCommandResult;
// continueRecoveredSession(sessionId)、sessionAtomScope(sessionId) 保持现有签名。
```

以上参数/结果类型沿用现有定义，只为实际消费补公开导出。显式 ID 不存在时拒绝，不回退到当前选中会话。
`getSnapshot` 返回稳定只读引用，提交成功后才通知；配置载入或保存失败有明确错误，不能伪报持久化成功。
同 namespace 的多个写实例必须拒绝重复拥有或实现协调；不能用现有全量 sessions clear/put 相互覆盖。

## 任务树与模型

```text
010 Agent 配置与无视图运行包 [sol]
040 可选视图包 [sol]（消费已审查的公共合同）
020 页面表单工具包 [sol]（消费现有 core/tools）
030 接口数据工具包 [terra]（消费现有 core/tools）
010、020、030 完成 → 050 扩展与客户嵌入集成 [sol]（最终验收等待040）
                          → 060 独立覆盖审计 [sol]
```

| id | 本地任务 | depends_on | model | status |
| --- | --- | --- | --- | --- |
| 010 | [Agent 配置与运行](010-agent-runtime.md) | 无 | gpt-5.6-sol | done |
| 020 | [页面表单工具包](020-page-tools.md) | 现有 core/tools、已交接骨架 | gpt-5.6-sol | done |
| 030 | [接口数据工具包](030-api-tools.md) | 现有 core/tools、已交接骨架 | gpt-5.6-terra | done |
| 040 | [可选视图包](040-ui.md) | 已交接公共合同/骨架 | gpt-5.6-sol | done |
| 050 | [扩展与客户嵌入集成](050-extension-embedding.md) | 010、020、030、040、070 | gpt-5.6-sol | done |
| 060 | [独立覆盖审计](060-coverage-audit.md) | 010–050、070 | gpt-5.6-sol | done |
| 070 | [宿主关闭与恢复](070-host-close-recovery.md) | 010 | gpt-5.6-sol | done |

020/030/040 的写路径严格互斥。010 已准备 workspace 和工具骨架，020/030 各自取得工具目录完整写权，
010 的 R1 不再修改这两个目录；根配置和 lockfile 暂由 010 独占。050 顺序接入真实入口。
reviewer 与最终审查使用 gpt-5.6-sol。
未派发任务 base 为 null，派发前记录届时 HEAD；当前未提交产品改动也必须纳入审查证据。

## 覆盖矩阵

精确路径含“新增”时表示本次实现的产物；证据列已回写最终验收命令、断言或截图路径。

| id | 表面 / 状态 | 精确入口或路径 | owner | 验证证据要求 | 状态 |
| --- | --- | --- | --- | --- | --- |
| C01 | Agent CRUD、配置版本、旧会话隔离 | `browser-agent/agent/src/client.ts` / `multiClient.integration.test.ts` | 010 | 010 R2：双client/三Agent请求隔离、配置失败与恢复；复审PASSED | done |
| C02 | Skill list/search/read、正文与资源版本 | `tools/skills/src/`、`browser-agent/agent/src/client.ts` | 010 | 重建旧会话实际skill_search/read仍V1；configured-skill/allowlist回归 | done |
| C03 | 连接/API key、同厂商多 endpoint | `browser-agent/agent/src/client.ts` / `configStore.ts` | 010 | multiClient.integration：URL/model/instructions/tool/header隔离；endpoint冻结/key轮换 | done |
| C04 | 显式会话命令、持久化/compaction/undo | `packages/agent-core/src/runtime/commands/`、`browser-agent/agent/src/` | 010 | pending fetch仅停止A；显式命令作用于A；压缩恢复/timing回归 | done |
| C05 | 读字段、填充、校验失败与不支持控件 | `browser-agent/tools/page/src/`（新增） | 020 | 020 R3复审PASSED；8 files/25 tests，含同源iframe、adapter优先、回读失败 | done |
| C06 | DOM 变化、取消、重复写入与导航 | `browser-agent/tools/page/src/`（新增） | 020 | dom-host.r1.test.ts：Document FIFO、排队取消、中途失效；身份/PageRef负例 | done |
| C07 | 接口搜索、分页、字段映射、鉴权失败 | `browser-agent/tools/api/src/`（新增） | 030 | 030 R1：2 files/17 tests；真实deadline、取消body、迟到结果、安全错误映射；复审PASSED | done |
| C08 | Agent/Skill/模型与Key配置、空/加载/失败态 | `browser-agent/ui/src/settings/` | 040→160 | 160 R1独立通过；真实client首配/模型/Key/跨client隔离验证 | done |
| C09 | 对话流、停止、确认、恢复与 undo 展示 | `browser-agent/ui/src/chat/`（新增） | 040 | 040报告：真实client配置/发送/工具/显式session/undo恢复；复审PASSED | done |
| C10 | 窄侧栏、键盘、焦点、样式隔离 | `browser-agent/ui/src/` | 040→160 | 160宽/360px CUA截图与user-event键盘补证；原生键盘中断范围详见报告 | done |
| C11 | 扩展加载、权限拒绝、目标 tab/document 路由 | `browser-agent/extension/src/`（新增） | 050 | 050 R1独立PASSED，Chrome151真实MV3/侧栏/导航/reload；权限负例定向；Edge未测 | done |
| C12 | 多会话同页写串行、侧栏关闭/重开恢复 | `browser-agent/extension/src/`（新增） | 050 | mv3-report的interruptedRecovery三项true；真实IPC取消/embedded异步adapter；unknown不重放 | done |
| C13 | 自有界面嵌入、两个独立实例 | `browser-agent/examples/embedded/`（新增） | 050 | embedded-report双namespace/iframe/重复运行/不同API结果；060 packed无UI consumer通过 | done |
| C14 | 新根目录边界、公开导出、纯浏览器依赖 | `scripts/check-boundaries.js`、`scripts/check-dist.js` | 010 | 新根负例、agent build/headless import、state/boundaries通过；完整packed由060复核 | done |
| C15 | 完整闭环：取选项→填表→校验→重载 | `browser-agent/extension/tests/`（新增） | 050 | 默认UI+真实core/dispatcher/content script闭环；050复审PASSED；模型/接口为fixture | done |
| C16 | 全矩阵、旧 Web/CLI/Server 回归 | `.tasks/browser-agent/reports/060-report.md`（新增） | 060 | 最终6650测试通过/3跳过，root/workspace build/state/boundaries/dist通过；060与终审PASSED | done |
| C17 | 宿主关闭保留恢复状态、释放owner、拒绝迟到写回 | `browser-agent/agent/src/client.ts`、`packages/agent-core/src/runtime/commands/` | 070 | 070 R1独立PASSED，agent25/core71，真实driver失败保留owner、双client、paused/unknown重建 | done |

## 验收总门与续跑

1. 三个 Agent 使用不同技能、工具与模型连接，切换展示不会串会话、凭据或目标页面。
2. 默认 UI 和客户自有 UI 消费同一运行包；客户无须安装 ui 包，工具包也能独立注册进现有 core。
3. 本地页面从接口获取候选项并填入字段，受控组件通过显式适配工作；失败返回具体字段与原因。
4. 原有压缩、恢复和对话 undo 工作；外部页面写入结果未知时不擅自重复执行。
5. `pnpm test`、`pnpm build`、新增各包 build、`pnpm check:state`、`pnpm check:boundaries`、
   `pnpm check:dist`、`git diff --check` 通过；覆盖矩阵每行有实际证据。
6. 060 独立审计通过，缺口由编排者追加 discovered_from 任务或明确范围裁决；不以局部绿测冒充全树完成。
7. 续跑先读本 index、任务状态和 Git；下游只能在依赖 done、接口同步完成后派发，禁止重拆已有已完成任务。

## 决策与变更

- 2026-09-18：用户“继续”，确认按本地任务树连续实施；派发 010，base 为 953ae7a118eb974e3bb6d134ef65d6fb23c5082e。
- 2026-09-18：010 首次交付 DONE_WITH_CONCERNS；定向 242 + 附加 63 项测试及包构建通过，编排者亲验 state 通过；交独立 reviewer，未解锁下游。
- 2026-09-18：010 审查 REJECTED，C01/C02 未满足；R1 修正默认实例双写、Skill 搜索、权限冻结、恢复 schema、失败清理与持久化 flush，补齐实际验收场景。
- 裁决：交接已完成的 page/api 构建骨架，020/030 与 010 R1 并行 — 两工具仅消费既有 core/tools，不依赖 BrowserAgentClient — 010 不再写工具目录，根依赖由其独占，接口变更须编排。
- 裁决：异常关闭后的 owner 回收列为 010 必修 — 050 的侧栏重开依赖它，永久占用不能支持既有恢复目标 — 需在此项验证浏览器生命周期，不后移为运维遗留。
- 2026-09-18：按用户修正，将 tools 从一个大 issue 分为页面包、接口包各一项；同包工具共享适配与验收，不拆成一工具函数一项。
- 2026-09-18：用户明确只要本地 issue，停止远程创建；本次误建条目的关闭记录保存在 reports/remote-issue-cleanup.json，仅作清理审计，不用于同步。
- 2026-09-18：独立计划审查已完成；补齐显式会话命令、源授权 callback、文档代次规则；基础包后可并行 3 项，路径无重叠。
- 裁决：Chromium MV3 实际加载是开发完成门，Edge 实机另列发布检查 — 避免依赖未确认存在的浏览器环境 — Edge 未测则不声称已验收。
- 裁决：暂不设业务 tools 空包 — 未提供真实业务接口 — 若有具体系统，只增加对应工具包子 issue，不扩基础抽象。
- 裁决：第一版采用侧栏运行与恢复 — 沿用已有 Web runtime，降低生命周期改造量 — 若必须关侧栏不停，需要另做常驻运行宿主。
- 裁决：保留现有 Web/CLI/Server 产品界面，不迁移到新 UI — 这次要新增扩展并支持嵌入 — 原产品仍走回归验证。
- 裁决：真实客户站点验收暂不计入完成门 — 无站点与接口合同 — fixture 通过不能声称任意客户页面已兼容。

## 遗留与发现

- 基线文档门禁失败：docs/launch/comparison.md:111 链接到已不存在的 kimiImageFeature.ts；010 在必要文档闭环中修正这一个失效引用，不扩大文档重写。
- 已关闭：010首轮owner/双client三Agent/故障写入/lockfile疑虑，R2独立复审通过；根完整回归由060在最终集成态核实。
- 环境核实：本机有 Google Chrome 与 Playwright 浏览器缓存，没有 Microsoft Edge；050 执行 Chromium MV3 实测，Edge 单列未验证。
- 真实客户 DOM/接口合同、Firefox、后台持续运行不属于当前验收范围。

- 2026-09-18：010 R1、020、030 报告 DONE；捕获含未跟踪文件的范围 diff，进入独立审查。

- 2026-09-18：030 审查 REJECTED，进入 R1；修复真实超时、迟到取消结果与安全错误文案。编排者亲验 page+api 共 26 项通过，新增负例仍须补齐。

- 2026-09-18：010 R1 复审 REJECTED；原阻断已关闭，R2 修正重复配置身份并补缺失的双 client/三 Agent、显式会话命令、配置写失败证据。
- 2026-09-18：020 审查 REJECTED，R1 修正 adapter 优先级/敏感字段、真实回读结果及写入串行；编排补充逐字段文档有效性检查。
- 裁决：DOM host 内按 Document 串行实际写入 — 嵌入调用者也可直接消费 host — 扩展桥仍独立负责请求生命周期与文档路由，不重复引擎调度器。

- 裁决：040 与010 R2并行，UI目录完整交接 — R1独立复审已确认消费合同，剩余decoder/行为证据与UI写路径无重叠 — 若下游暴露运行包缺口，由010原任务修，最终不得跳过010验收。
- 2026-09-18：040派发terra，应用frontend-design-codex进行窄/宽截图和键盘验证。该技能引用shared visual-runtime未安装，使用本地浏览器fixture完成等价检查。

- 2026-09-18：020 R1复审PASSED，C05/C06 done。原Minor记录：等待中取消测试时序只覆盖启动前；随后020 R2已修正并复审通过，050仍做真实浏览器取消验证。

- 2026-09-18：030 R1复审PASSED，C07 done；接受Minor：同步取消后的source启动微任务仍执行一次，但外层已拒绝、signal已取消且只读结果丢弃。
- 2026-09-18：010最终全仓build发现020测试类型错误，020重开R2仅修类型与旧取消测试时序；040在途类型错误由UI执行者自行收口。

- 2026-09-18：020 R2类型修正与取消测试时序复审PASSED，done；030 done。040初稿自报尚缺组件职责与浏览器验证，继续本项实施，不后移既定验收到050/060。

- 2026-09-18：010 R2复审PASSED，运行包与两个工具包均done；编排亲验R2新增隔离/故障/decoder定向集通过。
- 裁决：050消费已稳定UI出口，与040并行开发桥/客户嵌入 — 两任务写路径完全分离 — 050最终UI闭环须等待040审查，060显式依赖双方。根配置与lock由010交给050独占。

- 裁决：040执行升档sol接管 — terra连续增量报告仍缺实际交互与浏览器验收，涉及复杂运行态展示 — 保留已有有效改动但以公开出口重新核对，原执行者停止写入，不增加包或任务。

- 2026-09-18：050嵌入使用独立同源iframe，暴露020全局DOM构造器跨realm判定缺口；020重开R3由新sol修复并补真实iframe测试，050无需绕过公开host合同。010/030保持done，050继续不依赖该修复的工作，最终门等待020恢复done。

- 2026-09-18：编排旧面回归 packages/tools/apps/scripts 共818文件/6492测试，6490通过；两个失败为sourceFiles新嵌套root旧断言（050已修）与planExecutionBudget 15秒超时，正在定向复核。日志reports/original-surfaces-tests.log，最终门尚未通过。

- 2026-09-18：旧预算测试定向复跑6/6通过，首轮为15秒超时；sourceFiles复跑被040在途fixture命名挡住，040已改为testFixtures/.mjs，未扩大扫描豁免；再次定向验证中。

- 2026-09-18：旧面复核已收口：planExecutionBudget 6/6通过、sourceFiles 9/9通过（日志original-surfaces-recheck.log和source-scope-recheck.log）；首轮6492项中的两个失败均有后续通过证据，最终集成仍由060全面核验。

- 2026-09-18：020 R3复审PASSED，iframe缺口关闭且编排亲验2项通过；010/020/030重新全部done，050可使用已重建页面包。

- 用户追加硬约束（2026-09-18）：测试Chrome触发系统钥匙串“Chromium Safe Storage”访问弹窗，用户明确不要访问/存入系统钥匙串。所有测试浏览器立即停止；禁止批准钥匙串访问或输入密码；禁止查询/删除用户现有钥匙串项。以后仅临时profile+--password-store=basic+--use-mock-keychain，mock凭据，退出后删除本次临时profile。此约束适用于040/050/060与所有后续自动化，不需再次询问。

- 2026-09-18：钥匙串紧急修正完成：040/050两处测试启动均强制mock-keychain/basic和临时profile，编排静态检查通过；没有批准弹窗/输入密码/查询钥匙串。040旧临时profile由原执行者清理，后续浏览器必须沿用此约束。040完整交付进入独立审查，亲验6项UI测试通过。

- 2026-09-18：040首次独立审查REJECTED，R1修正Agent编辑时缺失工具引用静默丢失；同类缺失引用一起核实。两项Minor记入本轮小修，未开新任务。

- 040 R1交付DONE，8项测试/构建通过，进入独立复审。050可消费已稳定UI产物，最终done仍等待复审。

- 2026-09-18：040 R1独立复审PASSED，原Important与两个Minor全部关闭；编排亲验8/8测试通过，C08–C10 done。050可完成最终默认视图验收。

- 2026-09-18：编排全仓pnpm test通过，833文件通过/3跳过，6638测试通过/3跳过（105.43s）；日志reports/final-full-test.log。当前新包已包含，后续050改动仍按最终diff补定向，不盲目重跑全量。
- 编排最终state/boundaries均通过，日志reports/final-state.log、final-boundaries.log；根pnpm build进行中。050已提供pnpm-r-build/check:dist（22 packed包、32公开ESM入口）通过日志，060按最终状态复核证据。

- 根pnpm build暴露040 R1新增测试fixture的无效ToolCallTiming，重开040 R2做窄类型修复；运行时代码/8项测试行为已通过，050继续实现但done等待R2复审。根build当前失败日志保留。

- 根pnpm build复跑已通过（含tsc -b、Web Vite、Server及embed）；成功日志reports/final-root-build-r1.log。首次失败是040 R1测试fixture类型，R2独立tsc与8项定向通过后关闭；不要误读首次失败日志为当前仍失败。

- 040 R2独立复审PASSED，测试类型缺口关闭；根build通过，040恢复done。

- 050完整交付及浏览器证据收到，进入独立审查；报告明确Chrome异步adapter取消时隙和Edge未验证，C12按真实证据评估后裁决。

- 050独立审查REJECTED，R1补实际运行时拒绝/失败与真实Chrome reload/cancel证据；编排明确运行中关侧栏恢复不得用完成态重建替代。当前验收要求保持，不以单元通过替代尚未完成的浏览器场景。

- 裁决：060提前核实稳定包的packed headless consumer和静态边界，与050 R1真实浏览器验证并行；其开工依赖改为已done的010–040，最终C11–C15及整体完成仍严格等待050独立复审done。理由是无写冲突且消费者只依赖已稳定公开合同，代价是050最终改动须再次对证据范围核对，不重复全量测试。

- 050 R1实测发现跨包生命周期缺口：pagehide调用默认dispose会将运行记为用户停止，重开无恢复入口；不dispose则快速重开有owner租约冲突。新增discovered_from:050的070，产出dispose({preserveRecovery:true})可恢复关闭；原默认dispose保持停止语义。独立任务覆盖core取消/迟到结果/持久化/owner接缝，050消费，060最终审计等待070和050均done。

- 070实现交付：可恢复关闭/保留工具事实/阻止迟到abort回写，agent21与core恢复71项通过，进入独立审查；050可并行接入已稳定签名实测，最终done仍等070审查。070涉及核心运行路径，因此此前全仓测试仅作前态证据，最终再核全仓门，不用分包复跑掩盖组合装载失败。

- 编排亲验070 agent+runInterruption组合6 files/27 tests通过，日志reports/070-parent-test.log；静态发现persistRecovery的error outcome可能被丢弃，已交独立reviewer核实。050恢复执行最终pagehide接入和真实pending运行关闭重开证据，仍受070完成门约束。

- 070独立审查REJECTED，R1修复真实recovery error outcome被忽略且仍释放owner，并补关闭A/B隔离与paused/unknown重建证据。050最新Chrome运行中关闭恢复三项断言已通过，可独立审其消费代码，最终done仍等待070。

- 050 R1自身独立PASSED，编排2文件7项通过，最终done待070；070 R1交付agent25/core71及build/gates通过，进入独立复审。编排开始本次核心修改后的全仓test，旧6638通过日志保留为前态证据。

- 070 R1独立PASSED，050依赖门解除，两叶done；所有实现叶已完成。060最终审计核新packed关闭合同、050最终Chrome证据及编排本次全仓门。

- 裁决：实现叶全部done且产品停止写入后，终审可先只读全量diff，与060最终packed审计/编排全仓门并行；终审结论必须等060及最终门证据齐全。理由是无产品写冲突，代价是若任一门发现修复，须刷新范围diff并复审改动，不能提前宣称全树完成。

- 最终核心R1集成全仓pnpm test通过：834 files passed/3 skipped，6650 tests passed/3 skipped，105.05秒；日志reports/final-full-test-r1.log。包含070新恢复关闭四项与050 R1，组合装载问题本次全量未复现。最终build/packed/覆盖审计/终审仍在进行。

- 终审曾质疑pagehide异步退出不能保证写盘；追完整既有core链后撤回：modelRunLifecycle在请求前持久化model_run_started，工具执行前持久化outcomeUnknown，hydrate将遗留running/awaiting_tool归interrupted。裁决：复用已有运行中持久化边界作为崩溃恢复依据，不为unload新增宿主或恢复状态副本；pagehide仅做有序退出。产品终审已PASSED，完整结论仍待060与最终门。
- 编排最终pnpm-r build与根pnpm build通过，日志reports/final-workspace-build.log和final-root-build-r2.log；state/boundaries/docs也通过，dist分发门在执行。

- 最终dist已通过22 packed包/32 ESM入口/CSS/NodeNext/negative exports；060最终报告PASSED、C01–C17全有证据，进入独立终审收口。新的packed恢复关闭通过且无UI/React依赖；不再运行已通过测试。

- 全树完成：reports/060-review.md与reports/final-review.md均PASSED；C01–C17全部done，所有实现叶独立复审通过。最终测试834 files/6650 tests通过（各3跳过），workspace/root build及state/boundaries/docs/dist/diff全部通过。保留范围：Chrome151 fixture实测；Edge与真实客户站点/API未验证，第一版无后台持续运行/跨源iframe/关闭Shadow DOM/最终业务提交。保留030已记Minor，不构成完成阻断。用户钥匙串约束持续生效，测试Chrome与临时profile已清理；本轮不commit/push。

### 网络需求调整：页面开始加载即预采集
用户最新明确要求读取对话前请求。裁决：采集生命周期属于Document，工具消费属于session；在已授予origin通过dynamic content scripts document_start注入MAIN采集器与ISOLATED绑定标记，页面预缓冲持续采集但滚动限时/限量。会话start默认读取预缓冲快照，stop不影响页面采集，刷新清理旧document。120新增installWindowNetworkRecorder纯Web入口；130负责授权origin注册/撤销及native doc路由；140演示并审计先初始化请求/后开会话。上述三个任务“最新用户修正”优先于旧合同中仅捕获会话之后的限制。N06归属120/130/140，状态pending。
150-network-audit为独立只读覆盖审计/终审叶子，依赖120/130/140通过；N01–N06全部证据及真实CUA初始化请求观察通过前不标网络功能done。

130执行中误越界运行系统旧pnpm的`pnpm install --lockfile-only=false`导致v9 lock降为v5.4，已立即叫停其一切install/lock操作并交独占140恢复。恢复从140安装后备份或HEAD v9+network-prechange.diff既有lock增量，再pnpm10重建workspace links；不能简单checkout丢前态。恢复后备份network-lock-v9.yaml并核无版本升级。编排只核验不亲改产品。
锁恢复已由140完成并经编排git diff复核：v9.0，diff仅25行（新增network importer/3个consumer link，保留上一轮UI page/api devDependencies），没有任何resolution/version升级。reports/network-lock-v9.yaml备份与当前一致，消费者symlink已恢复，继续验证。

120独立review REJECTED：敏感key变体脱敏、按需host生命周期、共享limits、fetch原语义/Request body、XHR JSON、滚动过期/大chunk和实质测试均需R1修复；已按原任务完整重派。130 R1处理注册重试、返回payload边界和MAIN真实模块接线。140 R1已独立PASSED，编排定向2项通过，且CUA真实本地HTTP“对话前初始化请求”及19工具已通过；其最终done仍等120/130。

120 reviewer误用包目录test入口触发全仓扫描后报告的7个失败文件，编排已核到共同cwd假设（scripts/check-boundaries.test.js:28、subagent-skill-governance.test.js:10、host-node/jsonlStore.test.ts:63等用process.cwd拼仓库路径）。从正确仓库根定向复验全部7个文件：81/81通过、无unhandled（reports/network-cwd-regression.log）。因此未改这7个产品/测试去规避错误，失败定位为误用执行目录；不当作功能缺陷，也不当作全仓通过证据。
130 R1独立PASSED with Minor后，编排最终读码发现撤权dispose后pageshow会重新启用recorder；将此实质生命周期问题纳入130 R2，连同合法空header value兼容窄修，最终仍须复审。不会用“只剩Minor”掩盖新发现。

130 R2独立PASSED无遗留，编排MAIN真实模块+service-worker定向2files/7tests通过（130-parent-test.log）；120仍R1中，待其稳定后再最终extension/组合验证。

120 R2复审确认四项原问题已修，但发现为满足无recorder多host限额而将已有recorder也改Math.max导致预缓冲上限回退；进入R3，按skill由全新sol agent接手120-network-r3.md，范围仅network。已有根R2最终171测试/23 packed通过作为前态，不用于跳过该重要缺陷。R3明确有recorder取保守上限、无recorder才允许合并较大观察范围，并保留每capture独立输出限额。

120 R3全新agent修复已独立PASSED，130/140上游条件达成，三叶正式done；最终根47files/176tests、tsc、extension/embedded build、state/boundaries/docs、23 packed/33 ESM全部通过，CUA R3再次实测通过。150独立最终覆盖审计running，之前171等是保留的历史前态。

### 网络最终覆盖矩阵

| ID | 表面与入口 | 归属 | 最终证据 | 状态 |
|---|---|---|---|---|
| N01 | tools/network 6工具、fetch/XHR/Request/registry | 120 | 120-r3-vitest.log 38项；120-review-r3.md | covered |
| N02 | network sanitize、observer/host、limits/lifecycle | 120 | 所有既有回归与R3顺序/pending测试；独立审查通过 | covered |
| N03 | extension bridge/main/service worker/registration | 130 | 130-review-r2.md；最终组合含22 extension tests | covered，未做本轮真实MV3实测 |
| N04 | UI fixture catalog、本地HTTP演示 | 140 | 140-review-r1.md；140-browser-check.md R3 CUA，19工具与初始化响应 | covered |
| N05 | network公开包、headless embedded、workspace边界 | 140 | 23 packed/33 ESM；types/build/state/boundaries通过 | covered |
| N06 | document_start MAIN采集、先请求后对话读取 | 120/130/140 | 130真实MAIN模块接线；140实际Vite HTTP初始化记录；R3 CUA复验 | covered，纯Web实测/扩展模块验证 |

网络范围裁决：注入后的fetch/XHR，默认页面预缓冲最近5分钟/100条；授权origin才自动预注入，首次授权已打开页面需刷新覆盖初始化；页面预采集独立于会话stop。没有新增任意URL主动请求工具。未实测范围：本轮真实MV3网络自动注入、Edge、真实客户站点/API；跨frame/worker/WebSocket不在本次能力范围。注入前历史正文无法恢复。未访问系统钥匙串，未创建远程issue或发布。

Final audit: reports/150-review.md PASSED, N01-N06 covered, no outstanding quality findings. Preview server remains available at http://127.0.0.1:4178/fixture.html?scenario=configured .

### 180 视觉改版验收进展（2026-09-20）
编排已读GitHub Apple HIG skill并实际应用；CUA确认360px空态与模型表单、宽屏Agent编辑/能力分组，以及用户自行安装的本地extension/dist刷新后的新版侧栏。第一次190审查读到了图证更新前报告，以证据缺失拒绝，没有产品功能发现；正在复验更新记录和直接只读当前原生Chrome图像。原始图像保留于CUA会话输出，不伪造本地PNG路径。
编排全browser-agent+boundary 48文件179测试通过；根tsc -b通过。最后静态发现深色目标条hover浅底与无效font shorthand，交180窄修，不扩大任务范围。

| ID | 表面与入口 | 归属 | 证据 | 状态 |
|---|---|---|---|---|
| V01 | View/ChatView 单层导航与空态 | 180 | 180-browser-check.md 360空态及真实侧栏；UI回归 | done（190 PASSED） |
| V02 | ConnectionEditor 模型与Key | 180 | 360模型表单CUA；首配实际client/第二模型transport测试 | done（190 PASSED） |
| V03 | AgentEditor/SkillEditor能力与CRUD | 180 | 宽屏Agent CUA、折叠缺失引用/资源/隔离回归 | done（190 PASSED） |
| V04 | chat会话、确认、恢复、undo | 180 | 190源码审查；既有命令/多会话回归；未新增真实模型调用 | done（190 PASSED） |
| V05 | 嵌入容器与真实extension侧栏 | 180 | 宽/360 CUA；同路径已装扩展刷新实际生效；生产build | done（190 PASSED） |

180最后两个目标条CSS点（深色hover与字体声明）已关闭，extension再次build与ZIP逐文件校验通过；未改headless配置或tools行为。深色/高对比/减少动态按源码与颜色数值核验，本轮未更改用户系统偏好进行视觉实测；原生键盘由既有user-event焦点验证补证。

180/190最终完成：独立reviewer已通过现有原生Chrome只读确认宽屏Agent配置与新版真实扩展侧栏，190-review.md最终PASSED。V01–V05全部有证据；最后CSS修复与构建已纳入复验。Skill来源、安装路径与固定commit见180-skill-source.json。本轮未commit/push、未创建远程issue。

370 DOM首轮完整交付，28files/71tests与page/dom builds通过，独立审查启动；380模型实际调用集成调试继续，所有功能done仍等待审查/组合/浏览器证据。

370独立审查REJECTED，R1修动作阶段取消/替换、祖先禁用、ARIA/native select行为测试，保留原报告以便复核。380自身接线继续，最终必须消费R1产物再build/组合验证。

380首轮独立审查REJECTED：缺完整Chrome通道组合验证，mock模型最终成功未检查tool回读值。R1补两个内聚验收，若暴露实际产品bug一并修。370 R1继续，合同稳定；所有源稳定后根做最终组合/build/CUA。

370 R1冻结：29files/76tests、dom build、根tsc通过，3 Important全部修复；独立复审启动。编排CUA实测本地普通div/span异步下拉真实registry链完成，页面由尚未选择变安全漏洞，候选关闭后回读确认；390-browser-check.md记录原始工具观察。

370 R1独立复审APPROVED，正式done；380 R1交付9files/37tests并源码冻结，复审中；根开始最终全browser-agent组合与extension/embedded产物构建。

DOM全树收口：370/380 R1复审与390终审均APPROVED，D01–D06全覆盖、零遗留质量发现。最终72files/254tests、tsc、extension/embedded构建、state/boundaries/docs/diff、packed ESM/d.ts、ZIP CRC/逐文件验证均通过。CUA本地普通div/span异步选择与配置六工具实际可见通过；用户真实业务MV3调用未冒称实测。新能力需重载扩展/刷新页面/Agent选择DOM工具后新建会话。原配置与既有会话冻结能力未暗改，未访问钥匙串/真实模型/提交业务/commit/push。

## 400 实际业务页失败复核（2026-09-21，完成）
用户再次反馈失败，CUA确认日志query dom返回items空，实际ai录数r1仅19项且6DOM未启用；新版包已加载但未进入实际Agent/session。编排在现有UI为该Agent启用六DOM并保存r2，创建新会话，用实际配置模型执行同一选择任务。真实业务页面已选安全漏洞，read_form field-1.value及read_dom实际span文本双回读确认；未保存/提交。无产品源码改动，旧历史保留。此追加现场证据补足390当时保留的真实MV3该场景未实测边界；详情reports/400-live-dropdown-check.md。

## 410 历史管理与通用性检查（2026-09-21）

- 已补设置历史管理与运行包 deleteSessions，复用 core 删除、持久化和会话隔离；16 文件 70 测试、类型检查及三包构建通过。
- 已检查 93 个生产源码文件中的业务常量，复现 3 种表单启发式误判；详见 [410 检查报告](reports/410-abstraction-audit.md)。
- 用户回复“do it”后已在实际 Chrome 删除全部 4 个会话；重新加载扩展仍为 0 个会话，ai录数 r2 与 DeepSeek 连接、API Key 已配置状态保留。
- tools 抽象问题本轮只审查，未擅自进行整体重构；未创建远程 issue，未提交或推送。

## 420 接入 ask_user_question（2026-09-21，完成）

- 运行包直接依赖并注册现有 askUserQuestionTool；复用 core 暂停/恢复与现有 DecisionCards。
- 77 文件 / 282 测试、类型检查、相关包构建与门禁通过。
- 实际 Chrome 已更新并给 ai录数启用该工具，保存为 r3（26 项），已创建绑定当前业务页的新会话。
- 详情：[420 接入记录](reports/420-ask-user-question.md)。

## 430 会话历史前置（2026-09-21，完成）

- 历史移到对话顶栏，支持分组搜索、直接切换、各会话草稿、重命名和确认删除；设置只保留配置。
- 复用 core 活动会话、命名、删除能力；修复改名后恢复快照覆盖标题的问题。
- 78 文件 / 286 项产品回归和 4 文件 / 38 项 core 回归通过；构建及门禁通过。
- 已更新实际 Chrome，验证切换草稿与取消删除，用户两条会话保留；详情 [430 交付记录](reports/430-history-navigation.md)。

## 440 新建会话与页面绑定（2026-09-21，完成）

- 新建先选 Agent / 目标标签页 / 可选标题，成功绑定后进入对话，取消不产生历史；失败保留输入。
- 聊天保留紧凑页面条，历史增加页面信息。页面刷新、跳转、关闭、恢复及重新绑定有明确状态，通用 UI 与 Chrome 实现分离。
- 301 项分套件回归、类型检查、构建及门禁通过；合并并行测试仍有上轮已记录的初始化偶发失败，详见报告。
- 实际插件已更新，验证具名创建、页面绑定持久化、明确重新绑定与取消；详情 [440 交付记录](reports/440-session-creation.md)。

## 450 最新会话重复调用调查（2026-09-21）

- 当前会话共 43 个已展示工具调用，最终被 core 重复检测终止；已核对原始回执与项目实现。
- 确认全页等待误命中顶栏同名用户、DOM 结构信息不足，以及错误选择器在真实弹层打开时仍返回 0；手动打开人员列表正常，未改值。
- 修复尚未实施；证据、代码位置、尚不能断言的部分及修复顺序见 [450 调查记录](reports/450-dropdown-loop-diagnosis.md)。

## 460 自动压缩后模型请求 400（2026-09-21，完成）

- 真实快照与同端点最小 A/B 请求确认：压缩回执合成的 assistant 缺少 reasoning_content，DeepSeek 返回 400；补为空字符串后 200。
- 修复通用 timed 请求投影，原始会话、checkpoint 与 undo 保留；已有会话无需迁移。
- 42 项回归、类型检查、扩展构建及边界/状态门禁通过，已刷新实际插件侧栏；详情 [460 修复记录](reports/460-compaction-400-fix.md)。
