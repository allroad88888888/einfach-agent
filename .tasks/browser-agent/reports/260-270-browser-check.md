# 260/270 真实浏览器诊断与验收

状态：PASSED（270 R1真实MV3完整桥接复验通过）。

## 修复前原生Chrome观察

- 用户当前“项目问题详情”的真实Browser Agent对话，`read_form`返回7个控件，前两项为 `label:请输入`，页面可见字段名为“问题标题/问题链接”；组合框没有标签。展开工具结果确认是原始结果缺失，非纯UI隐藏。
- 网络工具先 `start_network_capture({includeBuffered:true})`，返回active:true/count:0/droppedCount:0；Agent随后报告刚开启采集。此回复不能作为采集器实际启动时刻的证据。
- 原生DevTools通过只读DOM诊断看到input自身title/name为空；最近表单项路径为 input→happy-input→deepUX-form-item-control-input→deepUX-form-item-control→deepfos-business-form-item。每个最近表单项匹配到2个label/title/form-item-label候选。role=combobox同样有外层候选。未读取或修改密钥、未提交表单。
- 原生页面主上下文 `__einfachBrowserAgentNetworkGateway__`存在，performance有143条resource；因此只凭0条不能断言没有安装监听。
- 代码确认：原注册只影响future document_start、已开页面需要handshake才补装；页面预缓存TTL默认5分钟、到期会裁掉；list schema强制captureId，推动模型先start；没有返回真实页面recordingStartedAt。这些分别是实现缺口，不能用话术替换实际修复。
- 第二轮只读诊断时用户切到另一个站点，编排停止继续操作该页面；没有绕过浏览器警告或请求新增网站权限。

## 浏览器机制参考

- Chrome [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)与[scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)：动态document_start与现有页executeScript装配需分别覆盖。产品不新引CDP/debugger，不扩大manifest授权。

## 修复后证据

1. 已在Chrome现有扩展详情重载同路径产物，保留既有cloud.deepfos.com授权，未授予新权限。
2. 打开新的项目问题详情document，在没有发Agent消息、没有start_capture的情况下，页面MAIN真实gateway直接list返回：scope=document，count=26，returned=26，types=[fetch,xhr]，recordingStartedAt=1789889477672，第一条startedAt=1789889477754（监听先于请求82ms）。说明真实document_start预采集已经生效。
3. 独立扩展sidepanel页面的原生DevTools中，经既有runtime.sendMessage→service worker→content-script，readForm返回ok:true；真实labels为“问题标题”“问题链接”“P0 - 高”“P1 - 中”“P2 - 低”“相关附件(问题必须上传logger)”“系统环境”。没有读出业务值/发送模型/填写表单。
4. 同一完整桥接路径listRequests省captureId失败：INVALID_NETWORK_RESULT。只读scripting诊断sync/普通async返回正常，实际gateway调用异常跨Chrome后result:null；catch原错误为RECORDER_UNAVAILABLE。与handshake补注入classic bundle重置顶层observers映射一致。编排未将页面direct成功冒称完整工具链通过，已交270 R1。

## R1 原生Chrome最终复验

重新加载最终扩展（MAIN lifecycle v3，所有entry使用私有IIFE作用域），刷新编排专门打开的业务测试document。保留原用户其他页面，未调用模型或修改表单。

在专用extension sidepanel页面的原生DevTools中，通过真实chrome.runtime.sendMessage→service worker→Chrome.scripting→MAIN gateway链路执行（不是只看页面内部对象）：

- `handshake` 后首次 `network-call/listRequests({limit:100})`，没有调用startCapture：scope=document，count=26，recordingStartedAt=1789890050323，第一条请求startedAt=1789890050424（监听早于请求101ms）。
- 再次handshake触发补注入，然后再次list：count=26，`allEarlyRequestsRetained:true`，`sameRecordingStart:true`。重复classic注入不再丢掉内部映射或历史记录。
- 同一完整桥 `page-call/readForm` 返回ok:true，labels为“问题标题”“问题链接”“P0 - 高”“P1 - 中”“P2 - 低”“相关附件(问题必须上传logger)”“系统环境”。
- 使用返回captureId与requestId调用 `network-call/getResponse`，ok:true，HTTP200，bodyState=captured，bodyLength=407。仅记录长度，不在日志中输出业务正文。

以上结果保留于CUA `实测完整桥接、重复连接保留历史请求及响应读取` 输出。没有伪造截图文件，也未发真实模型消息。页面初始化自动监听、完整读工具桥、重复连接保缓存与正文读取都已实际覆盖。

边界：本次自动采集是已授权主文档的全部fetch/XHR；图片、CSS、导航、worker/跨frame请求未增加。用户可选资源范围问题尚未答复，沿用明确的接口请求范围；不把未授权站点或插件安装前历史说成已捕获。
