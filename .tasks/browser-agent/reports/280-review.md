# 280 表单标题与插件自动采集独立审查

结论：**PASSED**。独立审查未发现遗留阻断或质量项。260 的 F01–F03 与 270 R1 的 N07–N10 均有源码、定向回归和真实 Chrome 后验支撑；首次 270 实现暴露的 classic bundle 重复注入缺陷已修复并复验。

## 范围与方法

- 审阅 `260-report.md`、`270-report.md`、`260-scope.diff`、`270-scope.diff`，并与 `260-270-prechange.diff` 对照，排除 080–250 等既有未提交增量。260 的实际新增面是字段标题解析器、接线、回归与就近说明；270 的实际新增面是 network 包生命周期/视图合同、扩展注册与 MAIN 桥、R1 bundle 隔离及其回归。
- 按任务约束未重跑已绿的定向测试。报告记录 page 15 files/43 tests、network 14 files/40 tests、extension 7 files/33 tests及相关包构建通过；编排最终 root build、state、boundaries、embedded build 通过，`git diff --check` 通过。
- 复核 `260-270-browser-check.md` 的原生 Chrome 证据。操作仅使用既有 cloud.deepfos.com 授权，未发模型消息、未填写/提交表单、未读取正文或密钥、未增加权限。

## 合同逐项结论

| 合同 | 结论 | 独立证据 |
| --- | --- | --- |
| F01 | PASS | `fieldLabel` 保留 aria-label、aria-labelledby 和关联 label 的优先级，随后读取控件 `title`、最近单控件 form-item 的唯一可见标题，最后才回退 name/placeholder。多控件行、嵌套 form、冲突标题、隐藏标题、状态/错误与控制分支说明被保守排除。 |
| F02 | PASS | 改动只影响字段描述生成；候选元素、敏感 input 排除、元素身份、值、只读/unsupported、iframe 文档归属与写入路径未被改写。新增解析只读取 DOM、属性与计算可见性。 |
| F03 | PASS | `dom-field-labels.test.ts` 覆盖两个相同“请输入”分别得到“问题标题/问题链接”、span title、控件 title、ARIA/多关联 label 优先、combobox、重复/跨字段/嵌套 form/说明/错误/选项隔离及星号冒号清理。真实完整桥 `readForm` 返回 7 个可见语义标题，含“问题标题”“问题链接”“系统环境”。 |
| N07 | PASS | worker 在加载、安装、启动、授权变化及 handshake 同步 registered scripts；future document 用 top-frame `document_start` 的 ISOLATED+MAIN，已开授权 tab 逐个补注入，单 tab 失败隔离，未授权 tab 不注入，等价注册不先 unregister，撤权清理当前 MAIN gateway。R1 用私有 IIFE 隔离每次 classic eval 的 bundle 变量；重复 handshake 后 26 条早期请求全部保留。 |
| N08 | PASS | extension recorder 使用 document-lifetime 保留，仍受 100 条与安全正文 32 KiB 上限约束；容量淘汰计入 `droppedCount`。状态区分 `scope`、视图 `startedAt` 与 observer 的 `recordingStartedAt`。真实新文档监听时间比第一条请求早 101 ms，未声称恢复注入前历史。 |
| N09 | PASS | `list_network_requests` 的 schema 不再要求 captureId；无 ID 时只读取 `retainInstalledObserver`，不存在预装 recorder 时返回 `RECORDER_UNAVAILABLE`，不会在首次 list 偷装 hook。document view 与显式 capture 可同时按 ID 访问，所有权按 session 校验；停止显式 capture 不停止 document view。真实完整 runtime→worker→scripting→MAIN 链在未调用 startCapture 时返回 26 条，并以返回的 captureId/requestId 读到 HTTP 200、captured、407 字符正文。 |
| N10 | PASS | 包级回归覆盖 >5 分钟仍保留、fetch/XHR、正文、容量/正文限制、脱敏、会话隔离、取消、stop 与参数校验；扩展回归覆盖注册等价/重试、已开授权 tab、撤权、native document pinning、传输校验、MAIN 生命周期及错误 envelope。`network-main-classic-dist.mjs` 先构建当前 dist，再在同一 Window 经典执行两次，验证 gateway 身份、早期请求及正文保留。真实 MV3 再次 handshake 后 count 仍为 26、`allEarlyRequestsRetained=true`、`sameRecordingStart=true`。 |

## R1 阻断与关闭证据

首轮真实 MV3 后验发现：页面 MAIN 内直接 list 可见 26 条，但 handshake 补注入后完整桥返回 `RECORDER_UNAVAILABLE`。根因是 ESM bundle 作为 classic script 重复执行时，顶层 `var` 重置 observer 映射，而旧 gateway 仍闭包引用该全局绑定。

R1 给 extension 四个独立、无拆包入口统一增加 IIFE banner/footer；最终四份 JS 产物可解析且无残留 import/export，service worker 与 sidepanel 的 module 装配保持可用。新增的可复验 dist 脚本先重建产物，避免旧 dist 假绿；服务端 MAIN 调用同时改为有界 success/error envelope，具体 recorder 错误不再被 Chrome 的 `null` 结果降级成 `INVALID_NETWORK_RESULT`。最终真实 Chrome 完整链在重复 handshake 前后均返回同一 26 条和相同 recording start，阻断关闭。

## 结构与边界

- 新的 `dom-field-labels.ts` 80 行，只负责标题解析；测试 44 行。`host-input-validation.ts` 51 行，`window-host.ts` 279 行，其余关键扩展文件均低于 300 行。
- `window-observer.ts` 为 320 行；它由原 298 行强内聚 fetch/XHR observer 窄增生命周期统计，低于复杂单状态机 500 行上限，报告已说明不拆分理由，未形成按行数伪拆。
- 未增加 manifest 权限、debugger、webRequest、共享会话存储或新宿主。自动范围仍是已授权主文档的 fetch/XHR；图片、CSS、导航、worker、其他 frame 及插件安装前历史明确不在本次承诺内。

没有遗留质量发现。
