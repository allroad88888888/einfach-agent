# 050 独立审查

结论：**REJECTED**

审查范围：任务说明、全局 index、`050-report.md`、`050-scope.diff`，以及范围内真实源码和已保存的浏览器/测试证据。按要求未重跑已报通过测试，未启动浏览器。

## 验收逐条核实

1. ✅ **扩展构建与 Chromium MV3 闭环证据齐备。** `mv3-report.json` 记录 Chrome for Testing 151.0.7922.34、真实扩展 ID、side panel 打开/关闭、默认 UI 的 9 次模型请求和 read/fill/validate 结果；`browser-e2e.mjs` 使用临时 profile、`--password-store=basic`、`--use-mock-keychain`，并在 `finally` 终止进程和删除临时目录。生产 `dist/manifest.json` 是 MV3 可加载清单，测试只修改临时复制目录。Edge 明确标为未安装、未验证，符合本条允许的兼容范围限定。

2. ❌ **三个 Agent 存在，但“工具拒绝与失败场景经过真实运行时”没有成立。** 浏览器 harness 确实创建 form/readonly/denied 三个 Agent（`browser-runtime-harness.testFixtures.ts:28-35`），但 mock transport 对所有非 `form-model` 请求直接返回普通完成文本（`:66-74`），所以 readonly/denied Agent 从未请求不在 allowlist 的工具，也没有产生运行时拒绝。Vitest 集成测试只断言 denied session 的 `allowedTools: []`（`runtime.integration.test.ts:20-29`），同样未执行被拒工具；API source 拒绝、请求失败等失败路径也没有真实 core 运行证据。成功链路 query_options→read→fill→validate→完成有覆盖。

3. ❌ **部分生命周期有真实浏览器证据，但未达到“各有真实浏览器冒烟证据”。** 已证实切 tab 后固定目标、同页双写会话、导航后旧目标失效、content script 无回执为 unknown、side panel 两次打开/关闭及绑定恢复（`browser-harness.js:18-43`，`mv3-report.json`）。但是脚本没有刷新原页面的独立场景，也没有发出 `cancel-page-call`；取消仅由 `page-bridge.test.ts` 的 mock IPC 单测覆盖。实施报告已如实披露尚未在 Chrome 命中“写入已进入异步 adapter 后取消”，但验收标准 3 明确要求取消有真实浏览器冒烟证据，不能以 020 单测与 050 IPC 单测组合替代。compaction 不映射成页面重试的结论只有报告陈述，050 浏览器证据未制造或观察该状态。

4. ✅ **构建、定向 Vitest、依赖闭包与正式出口证据可接受。** 保存日志记录 extension/embedded 测试和构建通过；embedded `package.json` 不含 UI/React/Chrome，源码通过 agent/core/page/api 的正式包出口装配。`check-dist` 已扩展到 browser-agent 包并区分 CSS 资产与 JS 入口，报告记录 packed consumer 检查通过。按审查约束未重复运行这些命令。

5. ✅ **README 覆盖要求。** 包含 unpacked 加载、嵌入最小装配、OptionsSource/授权接口与受控组件 adapter 接入、权限和生命周期、同源/跨源及控件边界，并明确 Edge 与真实客户站点未验证。

6. ❌ **不能标开发 done。** Chromium 主成功闭环和截图齐备，Edge 限制也陈述准确；但标准 2、3 的必需证据仍缺失，因此不满足“其他缺口经明确裁决后方可完成”的完成门槛。

## 问题分级

### Important

- **I1：工具拒绝/失败没有经过真实运行时。** 当前三 Agent 浏览器场景只能证明模型和暴露工具集合不同，不能证明模型实际调用禁用工具时 core 拒绝并将错误返回对话，也不能证明 API 权限/请求失败沿真实 dispatch 可见。补充一个确定性 mock turn，让 readonly 或 denied Agent 实际请求被禁工具，并让另一个调用触发可信 source 拒绝或请求失败，记录最终工具错误与 run 状态。
- **I2：验收标准 3 的真实浏览器矩阵不完整。** 增加明确的页面 reload（验证旧 documentId 失效且显式重绑恢复）和真实 IPC cancel 场景；取消至少应证明相同 request/target 的 cancel 到达 content script、迟到结果不继续驱动 run、写入结果不被重放。若生产同步 DOM host 无法稳定构造“已进入异步 adapter”，需要由编排者显式修改该验收要求；现有报告限制说明本身不等于通过。

### Minor

- **M1：本任务交付说明要求 fixture 包含受控控件、校验失败、权限/请求失败；当前 extension/embedded fixture 只有原生 input/select/file，未注册 `controlledAdapters`，浏览器成功证据中的校验失败只是 unsupported file。** README 解释了 adapter 接入，但没有本项 fixture/浏览器装配证据。若这些由 020 工具包单测覆盖而不要求 050 重复，应在任务裁决中明确缩小本项 fixture 要求；否则应补最小受控控件与失败 fixture。

未发现 Critical 问题。现有生产桥接代码具备固定 session→tab/frame/document、逻辑文档校验、单次发送、取消信号和恢复握手的基本结构；拒绝结论来自验收证据缺口，而非已发现会破坏成功主链路的产品缺陷。
