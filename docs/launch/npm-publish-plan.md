# npm 发包方案蓝图

> **这是演进蓝图，不是当前实现。** 截至本文撰写，仓库内 **18 个 workspace 包全部标
> `"private": true`，没有任何包发布过 npm**，也没有发布流水线。下文描述的是"将来要发包时怎么做"
> 的目标形态，任何一条都不代表 API 已交付。真正按下发布键的动作由维护者手工执行。

> **命名占位说明**：npm scope 取决于尚未拍板的"未决·命名"（见
> 推广发布 issue 树（已完成，全文随 Git 历史归档）），本文一律用 `<scope>` 占位，例如 `<scope>/core`。
> 现有包名前缀 `@web-agent/` 只是 workspace 内部标识，**不预设**它就是最终 npm scope。

事实核对基准：[`vite.config.ts`](../../vite.config.ts)、[`tsconfig.app.json`](../../tsconfig.app.json)、
各包 `package.json` 与 [`CLAUDE.md`](../../CLAUDE.md)。

## 1. 现状：workspace 包不单独编译

仓库刻意让所有包**不产出构建产物**：[`vite.config.ts`](../../vite.config.ts) 的 `resolve.alias`
与 [`tsconfig.app.json`](../../tsconfig.app.json) 的 `paths` 把每个 `@web-agent/*` 直接指向该包的
`src`。改包无需 build，`tsc -b` 也是 `noEmit` 的纯类型门禁。这对仓库内开发是优点，对发包是**起点为零**：

- 没有 `dist/`，没有 `.d.ts`，没有构建脚本；
- 各包 `exports` 字段虽已存在，但**指向 `.ts` 源码**，Node 无法直接消费；
- 消费路径全部由 alias 短路，`exports` 字段在仓库内**从未被真正走通过**——它今天是装饰性的。

结论：发包不是"加个 `npm publish`"，而是先把每个包变成一个**能被 alias 之外的解析器消费的产物**。

## 2. 差距清单与解法

| # | 差距 | 证据 | 解法 |
| --- | --- | --- | --- |
| G1 | 无构建产物 | 无任何包有 build 脚本或 `dist/` | 引入统一构建（见第 3 节），产物落 `dist/` |
| G2 | `exports` 指向 `.ts` | 如 `@web-agent/ai` 的 `"." : "./src/index.ts"` | 改指 `./dist/index.js` + `types` 指 `./dist/index.d.ts` |
| G3 | 全部 `private: true` | 18 个包无一例外 | 待发布包去掉该字段；不发布包**保留**（第 5 节） |
| G4 | `@web-agent/core` 没有 barrel | 其 `exports` 只有 `"./*": "./src/*"`，仓库内实际深导入 **61 个不同子路径** | 发包前必须收敛公开面：加 `src/index.ts` barrel + 显式 subpath 白名单，其余转内部 |
| G5 | `./*` 通配产出无扩展名路径 | `@web-agent/core/runtime/commands` → `./src/runtime/commands`，Node ESM 不做扩展名补全 | 构建后 exports 映射到带 `.js` 的具体文件；不能沿用裸通配 |
| G6 | `?raw` 导入 | 6 个工具域共 **39 个 `.md` 同目录正文**以 Vite 的 `?raw` 引入 | 构建期把 `.md` 内联成字符串常量（见下） |
| G7 | `?raw` 的类型声明只有一份且靠手工 include | [`raw-modules.d.ts`](../../tools/skills/src/raw-modules.d.ts) 被 `apps/cli/tsconfig.json` 显式 include | 内联后该 ambient 声明不再进入发布产物，仅留仓库内开发用 |
| G8 | React peer 声明不完整 | `@web-agent/react-plugin` 已声明 `react` peer，但写成 `workspace:*` 的 `@web-agent/core` peer 会被 pnpm 改写成**精确版本** | peer 改用 `workspace:^`，发布时得到 `^0.1.0` 而非死锁 `0.1.0` |
| G9 | 未声明依赖 | `packages/subagents` 有 10+ 文件 `import { atom } from '@einfach/core'`，但其 `dependencies` 只列了两个 `@web-agent/*` | 补 `@einfach/core` 到 dependencies；发布前跑一次 undeclared-deps 检查 |
| G10 | core 硬依赖 Tauri | `@web-agent/core` 把 `@tauri-apps/api` 列为 `dependencies`，被 `workspaceRead`/`workspaceWrite`/`workspaceRg` 等直接 import | 改为 optional peer（`peerDependenciesMeta.optional`），否则纯 Web/Node 消费方被迫装 Tauri |
| G11 | 无 `files` 字段 | 所有包都没有 | 加 `"files": ["dist"]`，否则 `*.test.ts` 与 `.md` 源料一并进 tarball |
| G12 | 无 `license` / `repository` / `README` | 仓库根**连 LICENSE 文件都没有**；只有 `agent-plugin-example` 有 README | 阻塞于"未决·License"（A5）；每个发布包补最小 README + `repository.directory` |
| G13 | 无 `publishConfig` | 所有包都没有 | scoped 包默认私有，必须加 `"publishConfig": {"access": "public"}` |

**G6 是最硬的一条**：39 个 `.md` 正文是工具 schema 的一部分，不是文档。仓库内靠 Vite 处理 `?raw`，
Node CLI 宿主靠 [`raw-module-loader.mjs`](../../apps/cli/src/raw-module-loader.mjs) 注册的自定义 loader 兜住。
**发布产物不能要求消费方注册 loader**——那等于把内部构建假设写进公开 API。唯一可接受的解法是
构建期把 `.md` 内容内联成字符串常量，让产物里根本不存在 `?raw` 说明符。这一条直接决定了第 3 节的选型。

## 3. 构建工具选型

**推荐：tsup（esbuild）出 JS，类型声明用 `tsc --emitDeclarationOnly` 单独产。**

三个候选的实际比较：

| 方案 | 能否内联 `?raw`(G6) | 深导入路径 | 主要风险 |
| --- | --- | --- | --- |
| **tsup**（推荐） | 能：esbuild 插件在 `onResolve`/`onLoad` 拦 `?raw`，与 CLI loader 同一套语义 | 多 entry 逐一映射，需显式列 entry | `dts` 对 core 这种大类型面可能慢或炸 |
| `tsc -b` composite emit | **不能**：tsc 只转译 TS，不认 `?raw`、不打包资源 | 天然 1:1 保留目录结构，最省心 | **另一处硬伤**：TS 输出 ESM 时不补 `.js` 扩展名，而现有源码深导入全是无扩展名的，产物 Node 直接跑不了 |
| source-publish（发 `src`，exports 指 `.ts`） | 不能，把问题外推给消费方 | 原样 | 消费方必须自备 TS 编译、`?raw` loader，还要复制本仓库 `moduleResolution: Bundler` 的解析语义 |

**为什么不选 `tsc -b`**：它有两处独立硬伤，且都要改全仓库源码才能绕过——`?raw` 要逐个删掉改成运行时读文件
（工具正文就没法随包分发了），无扩展名深导入要给 61 处以上 import 补 `.js`。代价远大于配一份 tsup。

**为什么不选 source-publish**：它把"能不能用"完全押在消费方复刻本仓库的构建假设上。仓库自己都需要
一个专用 Node loader 才能跑 CLI，指望外部使用者复现这套是不现实的。仅在"内部 alpha 内网分发"时可作临时手段，
不作为公开发布形态。

**tsup 的风险与缓解**：`tsup --dts` 走的是 rollup 系声明打包，`@web-agent/core` 类型面大、跨子模块引用多，
容易慢或在循环类型上失败。因此**不用 tsup 出类型**：JS 交给 tsup（`format: ['esm']`，仓库全线 `"type": "module"`，
无 CJS 消费需求），`.d.ts` 交给一份带 `declaration: true` + `emitDeclarationOnly` 的独立 tsconfig。
两者产物合并进同一个 `dist/`，职责清晰且各自可单独排障。

配套约定：每包一个 `tsup.config.ts`，`sideEffects: false`（工具注册走显式 `registerStandardTools` 调用，
不依赖 import 副作用——**逐包核实后再标**），`target` 与 [`tsconfig.app.json`](../../tsconfig.app.json) 的 `ES2022` 对齐。

## 4. 包间发布顺序

依赖图（见 [`CLAUDE.md`](../../CLAUDE.md) 的分层约定）决定拓扑序，同层内可并行：

1. **`<scope>/ai`** — `packages/agent-ai`，零 workspace 依赖，也不 import 任何外部运行时包，最干净的首发对象。
2. **`<scope>/core`** — `packages/agent-core`，依赖 ai。**G4/G10 必须在这一步解决**，它是整个公开面的地基。
3. **工具域** — `tools/{shell,fs,interaction,planning,skills,agents}` 六域 + `tools/mcp`，均只依赖 core，彼此无依赖，可并行发。
4. **能力包** — `agent-react`、`subagents`、`persistence-idb`、`persistence-sqlite`、`observability-idb`、`observability-sqlite`。
   均依赖 core；**同层内有一条内部边**：`observability-sqlite` 依赖 `observability-idb`，idb 必须先发。
5. **meta 包 `<scope>/tools`** — `tools/standard`，依赖第 3 步的六个域包（**不含 mcp**，mcp 按 CLAUDE.md 由应用层按需装配），最后发。

实操上 `pnpm publish -r` 会自行按拓扑排序，上面的顺序是**校验口径与手工回退方案**，用于在自动化出问题时逐包补发。

## 5. 不发布清单

以下包**不进 npm**，靠保留 `"private": true` 自动排除（`pnpm publish -r` 跳过 private 包，不需要额外过滤）：

- `apps/cli`（`@web-agent/cli`）——宿主应用，不是库。
- `apps/web`、`apps/desktop`——两者**连 `package.json` 都没有**，本就不构成 workspace 包。
- `packages/agent-plugin-example`（`@web-agent/plugin-example`）——插件契约的可运行样例，
  其价值在于随仓库演进，发到 npm 反而会产生"版本落后的示例"这一负资产。

## 6. 版本与 dist-tag 策略

- **0.x 阶段用 fixed version（全部公开包同一版本号），不做独立版本。** 理由：core 的公开面被十几个包共享，
  独立版本会立刻把"哪个 tools 配哪个 core"变成需要查表的矩阵问题；统一版本号让兼容性判断退化成一次字符串比较。
  等公开面稳定到 1.0 且各包演进速率明显分化后，再评估拆成独立版本。
- **首发 `0.1.0`，dist-tag 用 `next`，不占 `latest`。** `npm install <scope>/core` 在没有 `latest` 时会失败，
  这正是想要的效果：迫使早期使用者显式写 `@next`，避免把未稳定 API 当默认版本推给随手安装的人。
  观察期结束后用 `npm dist-tag add <scope>/core@0.x.y latest` 一次性提升。
- **0.x 语义**：破坏性改动进 minor（`0.1.0` → `0.2.0`），修补进 patch。0.x 下 `^0.1.0` 不跨 minor，
  这个语义正好把破坏性改动挡在自动升级之外。
- **workspace 协议改写**：pnpm 发布时把 `workspace:*` 改写成**精确版本**，`workspace:^` 改写成 `^版本`。
  内部 `dependencies` 用 `workspace:*`（精确锁定，符合 fixed version 策略）；
  `peerDependencies` 一律改用 `workspace:^`，否则 G8 那种精确 peer 会让消费方寸步难行。
- **changesets：引入，但不在首发。** 首发是一次性动作，手工统一 bump 更省事；
  从第二个版本起引入 `@changesets/cli`，用其 `fixed` 配置把全部公开包锁成一组，
  顺带解决 changelog 与"改了 core 忘了 bump 下游"的问题。仓库当前**没有** `.changeset/` 目录。

## 7. CI 发布流水线要点

将来新增 publish workflow 时的约定（**本蓝图不创建该文件**）：

- **触发器与桌面发布分开**：桌面走 `app-v*` tag（见 [Desktop 发布与签名](../release-signing.md)），
  npm 包用独立前缀如 `pkg-v*`，避免一个 tag 同时点燃两条产线。
- **provenance**：`permissions` 需要 `id-token: write` + `contents: read`，
  发布用 `pnpm publish -r --access public --no-git-checks --provenance --tag next`。
  provenance 让 npm 页面显示可验证的构建来源，对一个新开源项目是低成本的信任增量。
- **凭据**：优先用 npm 的 OIDC trusted publisher（免长期 token）；退路是 granular access token 存
  `NODE_AUTH_TOKEN`。**npm org / scope 由用户手工创建**，CI 不碰账号层面的事。
- **发布前门禁**：复用 [`ci.yml`](../../.github/workflows/ci.yml) 现有四步（check-docs → check-boundaries → test → build），
  再加一条现在还不存在的**产物冒烟**：对每个待发包 `npm pack`，在临时目录里从 tarball 安装并
  `node --input-type=module -e "import('<scope>/core')"`。这一步专门用来抓 G5、G6、G11 这类
  "仓库内一切正常、装出来就炸"的问题——它们在 alias 环境下**永远不会暴露**。
- `--frozen-lockfile` 安装，与 ci.yml 的 `desktop-native` job 口径一致。

## 8. 执行前的阻塞项

1. **未决·命名** → 决定 npm scope；scope 定不下来，包名、README 徽章、文档里的安装命令全部无法定稿。
2. **未决·License** → `package.json` 的 `license` 字段与仓库根 LICENSE 文件（A5）；
   **没有 License 的包不应发布**，这是发布的硬前提而非收尾项。
3. **G4（core 公开面收敛）** → 61 个深导入子路径全部公开意味着任何内部重构都是 breaking change，
   必须在 `0.1.0` 落地前决定哪些进白名单。这是本蓝图里工作量最大、也最应该先做的一项。

前两项属于 推广发布 issue 树（已完成，全文随 Git 历史归档） 的"未决"章节，第三项建议单独开卡。
另见 [GitHub 元信息文案草稿](repo-metadata.md) 关于 About 区 Packages 展示的说明——
在首次 `npm publish` 真正发生前，不要在任何门面位置做预告性文案。
