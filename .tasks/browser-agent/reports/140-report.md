# 140 网络工具配置与演示报告

## 结果

- 根 Vite alias、TypeScript paths、fixture alias 与边界扫描均已纳入 `@einfach-agent/tools-browser-network`。
- UI 仅在 `devDependencies` 引入 network 包；生产 UI 源码没有具体工具包依赖。配置 fixture 通过真实 registrar 暴露 19 项工具（11 个页面/API、6 个网络、2 个 Skill）。
- fixture 在业务 iframe 可执行任何业务请求之前安装 recorder，再发起初始化 cities fetch。网络 host 只绑定该 iframe；演示按钮通过真实工具 registry 完成 start（含 buffered）→ list/getResponse → 新 fetch/XHR → wait/list/getRequest/getResponse → stop，并显示“对话前初始化请求”、方法、URL 路径、状态与响应正文。
- fixture API 由 Vite 本地 `/fixture-api/cities` 固定 JSON 路由提供；模型 transport 仍为本地 mock。卸载时释放 network host、recorder 与 client，不会自动长期监听其他页面。
- embedded 示例在无 React/Chrome API 的客户界面装配相同 network 包，并展示先安装 recorder、后创建 Agent 的顺序。
- README 记录 6 个工具以及能力边界：注入后可读对话前流量；注入前历史不可恢复；仅 fetch/XHR；默认预缓冲最近 5 分钟/100 条；capture 默认 5 分钟；只读观察；不覆盖历史文档、其他 frame、worker 或 WebSocket；扩展首次授权已打开页面需刷新。
- pnpm 10.17.1 更新 v9 锁，仅增加 25 行 workspace importer/link；未升级依赖。最终锁备份为 `reports/network-lock-v9.yaml`，UI/extension/embedded 的 network symlink 均已核实。

## 验证

- `npx pnpm@10.17.1 exec vitest run browser-agent`：38 files / 125 tests 通过。
- `npx pnpm@10.17.1 exec tsc -b --pretty false`：通过。
- network、UI、embedded 三个相关包 build：通过。
- `npx pnpm@10.17.1 check:boundaries`：通过；新增 fixture 测试证明 network 包受现有 headless 禁入规则约束，没有扩大通用豁免。
- `npx pnpm@10.17.1 check:state`、`node scripts/check-docs.js`、`git diff --check`：通过。
- 新增/大改文件均低于 300 行。

## 覆盖审计

| ID | 证据与范围 | 状态 |
| --- | --- | --- |
| N01 工具合同/纯 Web 捕获 | 120 的包测试；140 的 `network-preview.integration.test.ts` 通过真实 host/registrar 捕获受控 fetch 与 XHR 并读取响应。 | 已覆盖 |
| N02 权限脱敏/有界/多会话 | 由 120 包测试覆盖；140 不重复实现。 | 已覆盖（120） |
| N03 扩展 document 路由/取消 | 由 130 的桥与路由测试覆盖；140 未做真实扩展浏览器网络实测。 | 自动化覆盖（130），真实 MV3 待编排 CUA |
| N04 配置 19 项/真实网络演示 | catalog 集成测试断言 19 项；fixture 按真实 registry 调用，本地 Vite 路由提供真实 HTTP 目标。 | 已覆盖；按钮视觉与真实 HTTP 由编排 CUA 收口 |
| N05 public 包/无 UI 嵌入 | root alias/paths、workspace link、network build、embedded build 与 README 示例。 | 已覆盖 |
| N06 页面早期注入/对话前请求 | `createFixtureBusiness` 先装 recorder 再发初始化 fetch；测试证明后 start 可读、`includeBuffered:false` 不读旧请求、其他 iframe 隔离。 | 已覆盖；根页面“对话前初始化请求”显示由编排 CUA 收口 |

没有运行旧 browser-smoke、CDP 或自行启动浏览器。纯 Web 捕获已通过 jsdom 中的真实 Window fetch/XHR 包装路径验证；MV3 仍是 mock 桥/路由自动化证据，不能表述为真实扩展网络已实测。
