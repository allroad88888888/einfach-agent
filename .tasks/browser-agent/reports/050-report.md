# 050 实施报告

状态：实现完成，交 060 独立审计。Chromium MV3 与嵌入浏览器闭环通过；Microsoft Edge 未安装、未验证。真实浏览器“中途取消一个已经进入异步 DOM adapter 的写入”仍没有可控慢 adapter 场景，IPC 取消语义由定向集成测试覆盖，见限制。

## 交付

- `browser-agent/extension`：可解压加载的 MV3 扩展，真实 side panel、service worker、content script、session→tab/frame/逻辑 document 绑定、显式重绑、权限申请、持久绑定恢复和页面/API 工具装配。模型密钥只留在侧栏 client。
- Chrome 消息按 `frameId` 路由，content script 校验逻辑 `documentId/revision`；不把自建逻辑 ID 错传为 Chrome 原生 documentId。导航后的旧绑定返回 unknown result，且不自动重放。
- `ExtensionPageBridge` 在预取消时不发送调用；中途取消传递相同 request/target；即使随后收到成功也以 `AbortError` 结算。未知写回执与取消分开处理。
- `browser-agent/examples/embedded`：不依赖 UI/React/Chrome，两个 namespace client 操作两个同源 iframe。每次点击建立新会话并等待真实 `runAtom` done；`query_options` 的真实返回分别流入 `cn-city`/`gb-city`。
- 生产 tsup 使用 `tsconfig.bundle.json` 清空根 `paths`，按正式 built exports 消费依赖。E2E 只在临时复制的扩展目录加入 harness/测试权限，生产 `dist/manifest.json` 未被改写。
- 根门禁覆盖 agent、page/api tools、embedded 的 React/UI/Chrome/Node 禁入并含负例；state source scope 精确包含嵌入示例；dist 检查区分 JS 入口与 CSS 资产。
- README 记录加载、嵌入、权限/生命周期、数据源授权、同源与受限页面边界，以及 Edge/真实客户站点未验证。

## 浏览器证据

所有自动化使用 Chrome for Testing `151.0.7922.34`、独立 `mkdtemp` profile，并显式传入 `--password-store=basic --use-mock-keychain`。脚本捕获 spawn 失败，等待自身 Chrome 退出后删除临时目录；未读取、写入或删除系统钥匙串，也未接触用户日常 Chrome。最终检查无测试 Chrome 或测试临时目录残留。

### MV3 / 默认 UI

命令：

```sh
npx pnpm@10.15.0 --filter @einfach-agent/browser-extension build
node browser-agent/extension/tests/browser-e2e.mjs
```

结果见 `050-evidence/mv3-report.json` 和 `050-evidence/default-sidepanel.png`：

- 真实 unpacked MV3 加载；扩展页受信点击触发真实 side panel。
- `sidePanel.onOpened/onClosed`，两次打开、关闭后 panel target 消失。
- 默认 UI 完成“保存连接→保存 Agent→绑定活动页→新建会话→发送→query_options→read→fill→validate→已完成”，模型请求 9 次。
- CSS 实际加载：1 个 stylesheet，body 背景 `rgb(245, 243, 238)`，view `display:flex`。
- 三个 Agent/model 权限差异经真实 core 运行；四个会话（含同页两个写会话），20 次确定性模型请求。
- query 返回 `shanghai` 并实际填入；文件字段明确 unsupported；校验结果可见。
- 切到另一活动 tab 后 pinned read 仍读原 tab；绑定未漂移。
- 关闭/重开后四个 session 的绑定均恢复到相同逻辑 document。
- 导航后旧目标返回 `CONTENT_SCRIPT_UNAVAILABLE` + `unknownResult:true`。

其他证据：`050-evidence/mv3-harness.png`、`050-evidence/chrome-stderr.log`。

### 客户自有 UI

命令：

```sh
npx pnpm@10.15.0 --filter @einfach-agent/example-embedded build
node browser-agent/examples/embedded/tests/browser-e2e.mjs
```

结果见 `050-evidence/embedded-report.json`、`050-evidence/embedded-two-clients.png`：两个 namespace 首次及重复点击均产生不同新 session 并完成；两个 iframe 分别得到 `{person:"Ada",city:"cn-city"}` 与 `{person:"Ada",city:"gb-city"}`，证明 API 查询结果进入 fill 参数。

## 自动检查

- `npx pnpm@10.15.0 exec vitest run browser-agent/extension/tests/page-bridge.test.ts browser-agent/extension/tests/runtime.integration.test.ts`：2 files / 6 tests passed（最终取消修正后）。
- 前一组合定向：extension + embedded 4 files / 30 tests passed，日志 `050-evidence/vitest.log`。
- `pnpm -r build`：通过，日志 `050-evidence/pnpm-r-build.log`（最终根 build 由编排者在 040 R2 后复跑）。
- `pnpm check:dist`：22 packed packages / 32 public ESM entry points、CSS/NodeNext/negative exports 通过，日志 `050-evidence/check-dist.log`。
- `pnpm check:state`：28 roots / 1055 files 通过。
- `pnpm check:boundaries`：1060 production TS/TSX / 11 rules 通过。
- `node scripts/check-docs.js`：535 Markdown files 通过。
- `git diff --check`：通过。
- 编排者最终全仓 `pnpm test`：833 files passed / 3 skipped；6638 tests passed / 3 skipped，日志 `reports/final-full-test.log`。

## 覆盖结论与限制

- C11：Chromium 实机通过；权限拒绝/受限页面为定向测试，目标固定、切 tab、导航失效为实机证据。Edge 未安装，保持未验证。
- C12：实机覆盖同页双会话、关闭/重开、绑定恢复、切 tab、导航/content script 断开与 unknown result；IPC 层覆盖预取消不发送、中途 cancel、迟到成功不恢复。由于生产 DOM host 操作同步且 fixture 未向产品 content script 注入测试专用慢 adapter，尚未在 Chrome 中稳定命中“写入已进入后再取消”的时隙；020 的真实已进入 adapter 取消测试与本项 IPC 测试共同覆盖该合同。unknown write 通过实机失联及单次发送断言证明不重放。compaction 的恢复/中断归 C04 已通过，本扩展没有把其状态映射为页面写重试。
- C13：Chrome 实机双实例与重复运行通过，构建不含 UI 依赖。
- C15：真实默认 UI、真实 core/tool dispatch、真实 content script DOM、确定性本地 mock 全链路通过；不含付费模型或真实客户站点。

## R1 修复记录

- I1：`runtime.integration.test.ts` 新增真实 core dispatcher 失败链。Readonly Agent 实际请求 `fill_fields` 但 capability 不允许；API Agent 分别实际调用未授权 `cities` source 与抛出内部错误的 `broken` source。断言禁用写未执行、页面不变、未授权 source 未调用、失败 source 仅调用一次、安全工具结果不含内部 `fixture secret`，三个 run 最终均为 `done`。最终定向结果 2 files / 7 tests passed。
- I2 reload：真实 Chrome 同 URL `tabs.reload` 后，旧逻辑 document 返回 `CONTENT_SCRIPT_UNAVAILABLE/unknownResult`；重新显式 handshake 得到不同 documentId，新目标 `readForm` 成功。
- I2 cancel：真实 Chrome 扩展消息通道发送相同 requestId/target 的 `cancel-page-call` 并收到 `{ok:true}`。同步 `readForm` 可能先完成，报告不将其冒称为中途取消；迟到结果隔离由 bridge 的预取消/途中取消单测和下述真实异步 adapter 浏览器场景覆盖。
- M1：embedded 两个真实 iframe 均通过公开 `controlledAdapters` 完成 controlled note 写入。另一个浏览器 fixture 让 async adapter 确认已进入后 abort，再释放迟到 continuation；结果为 `AbortError`、`lateWrite:false`、DOM 值仍为 `before`。
- 宿主初始化失败：`sidepanel.tsx` 捕获 client 创建或 binding restore 失败，在 root 内显示可读错误与 Retry，不再留下空白侧栏。
- 运行中关闭/重开：侧栏 `pagehide` 使用 070 的公开 `dispose({preserveRecovery:true})`。真实 side panel 先暂停一个未完成模型请求，关闭面板，再重开同一 namespace；新 client 展示“可恢复上次运行”，目标栏恢复到原 Controlled fixture。点击“恢复运行”后由确定性 mock 返回 `Recovered safely.`，状态变为“已完成”。`mv3-report.json` 记录 `recoverable:true`、`bindingRestored:true`、`continued:true`。
