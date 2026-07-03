# Web Agent（agentNew）

一个浏览器聊天 runtime + Tauri 桌面壳。前端主体在 `src/agentNew/`，桌面后端在 `src-tauri/`。

- **前端**：React 18 + Vite + `@einfach` 状态库（代码在 `src/agentNew/`）。
- **桌面**：Rust + Tauri 2（`src-tauri/`），提供真实的 shell / 文件 / git 能力与 SQLite 持久化。
- **同一份前端，两处跑**：Tauri 是主产品目标与能力基准；Web 是 dev 预览，属于**功能子集**——`shell` / workspace 文件族 / `git diff` 这类 `server` 工具在浏览器里不可用，会从工具清单自动隐藏降级；要完整能力请用 Tauri。

---

## 1. 先决条件

### 通用（Web 与 Tauri 都需要）
- **Node.js ≥ 20.19（或 ≥ 22.12）** + npm（Vite 7 的最低要求）。

### 仅「构建/运行 Tauri 桌面应用」额外需要
- **Rust 工具链 ≥ 1.77.2**（用 [rustup](https://rustup.rs) 装 stable）。
- 各操作系统的系统依赖：
  - **macOS**：Xcode Command Line Tools —— `xcode-select --install`
  - **Windows**：Microsoft C++ Build Tools（含 MSVC）+ WebView2 Runtime（Win10/11 通常已内置）
  - **Linux（Debian/Ubuntu 系）**：
    ```bash
    sudo apt update
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    ```
  - 其它发行版参考 Tauri 官方 [Prerequisites](https://v2.tauri.app/start/prerequisites/)。

---

## 2. 配置环境变量

模型 API Key 通过 `VITE_*` 注入，**构建时会被编入前端产物**（Web 与 Tauri 都读它，所以打包前必须先配好）。

```bash
cp .env.example .env.local
```

在 `.env.local` 里填：
- `VITE_DEEPSEEK_API_KEY`：**必填**。不填的话模型调用会降级为 `status: 'error'`。
- `VITE_GLM_API_KEY`：可选（会话 `vendor` 选 GLM 时用）。
- `VITE_DEEPSEEK_BASE_URL` / `VITE_DEEPSEEK_MODEL`：可选，默认已给。

> `.env.local` 不入库，换机器 / CI 需重新配置。

---

## 3. 安装依赖

```bash
npm install
```

---

## 4. 方式一：作为 Web 运行（浏览器 / dev 预览）

```bash
# 开发（热重载）
npm run dev
# → 打开 http://localhost:5173

# 生产构建（纯静态站点），产物在 dist/
npm run build

# 本地预览已构建的静态产物
npm run preview
```

`npm run build` 会先跑 `tsc -b` 做类型检查（这是唯一的类型门禁），再 `vite build`。
Web 模式下 shell / 文件 / git 等 `server` 工具不可用，属预期的功能子集。

---

## 5. 方式二：作为 Tauri 桌面应用运行

```bash
# 开发：热重载 + 原生窗口（首次会编译 Rust，较慢；之后增量很快）
npm run tauri dev

# 打包为「当前操作系统」的可执行文件 / 安装包
npm run tauri build
```

`npm run tauri dev` 会自动在 1420 端口起前端 dev server 并挂到原生窗口；
`npm run tauri build` 会自动先 `npm run build` 产出 `dist/`，再编译 Rust release 并打包。

---

## 6. 构建为对应操作系统的可执行文件

**Tauri 不做便捷的跨平台交叉编译**：要哪个 OS 的产物，就在**那个 OS 上**跑 `npm run tauri build`（Windows 的 `.exe` 必须在 Windows 上构建，macOS 的 `.app`/`.dmg` 在 macOS 上，Linux 的包在 Linux 上）。

`tauri.conf.json` 里 `bundle.targets` 为 `"all"`，会尽量产出当前平台支持的全部包型。产物位置：

- **原始可执行文件**（Cargo 包名为 `app`）：
  - macOS / Linux：`src-tauri/target/release/app`
  - Windows：`src-tauri/target/release/app.exe`
- **分发包 / 安装包**（应用名为 `web-agent`）：`src-tauri/target/release/bundle/`
  | 平台 | 产物 |
  |---|---|
  | macOS | `bundle/macos/web-agent.app`、`bundle/dmg/web-agent_0.1.0_*.dmg` |
  | Windows | `bundle/nsis/web-agent_0.1.0_*-setup.exe`、`bundle/msi/web-agent_0.1.0_*.msi` |
  | Linux | `bundle/deb/*.deb`、`bundle/appimage/*.AppImage`、`bundle/rpm/*.rpm` |

日常分发通常直接给 `.dmg` / `-setup.exe` / `.AppImage`（双击安装即可）。

---

## 7. 测试

```bash
# 前端单测（vitest，jsdom 环境）
npm test

# Rust 后端测试（shell / workspace 命令的真实执行集成测试）
cargo test --manifest-path src-tauri/Cargo.toml
```

---

## 8. 注意事项

- `vite.config.ts` 里 `react` / `react-dom` / `@` 的 alias 相对本配置文件解析（`fileURLToPath(new URL(...))`），项目挪目录 / 换机器都不受影响，无需手改。
- 项目根目录没有独立的 `web` / `desktop` 子目录——Web 与桌面共用同一套 `src/`；差异仅在运行环境（`isTauri()` 探测）与 `server` 工具是否可见。
