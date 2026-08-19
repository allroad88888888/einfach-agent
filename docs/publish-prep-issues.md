# npm 发包准备 Issue 树

目标：把 [npm 发包方案蓝图](launch/npm-publish-plan.md) 的差距清单（G1–G13）中**不需要发布
动作**的准备段全部落地——构建产物、exports 映射、包元数据、依赖修正、产物冒烟。
**红线：本树不执行任何 `npm publish`、不删 `./*` 通配（S10 仍 GATED 于
[core 公开面收敛树](core-surface-issues.md)）、所有包保持 `private: true`**——按发布键
永远是用户。scope 命名沿用拍板：einfach 系（实际改名随首发批次，本树用现名构建）。

前置已就绪：G4 公开面收敛完成（barrel + 门禁）、LICENSE 已落（G12 部分）、G8 peer 写法
待改、G6（`?raw`）是硬骨头。

## 树

```text
V1 tsup 试点（agent-ai）   V2 ?raw 内联插件   V3 逐包构建接线
V4 包元数据整备   V5 依赖修正侦察（G9/G10）   V6 subagents 死 subpath 砍除
V7 产物冒烟门禁   V8 d.ts nodenext 解析修复   V3a core 接线 → V3b 其余包接线
D（G10 @tauri-apps 摘除，V5 侦察产出）：
  D1 本地宿主探测/惰性 invoke   D2 三处纯探测点脱钩   D3 workspaceDialog 惰性 open
  D4 迁移无计时 invoke×4       D5 迁移带计时 invoke×6   D6 依赖降 optional peer
  D7 豁免表与注释合流收尾   D8 测试宿主模拟统一约定
GATED  实际 publish + S10 + 包名换 scope（用户触发）
```

并行规则：V1/V4/V6 无依赖可先行；V2 依赖 V1（复用其构建骨架）；V8 依赖 V1（修的是
其声明产物）；V3a 依赖 V1+V2+V8+D2–D5，V3b 依赖 V3a+D6（core package.json 串行）；V5 先侦察后动（已完成，产出
D 线）；V7 依赖 V3b。D 线内部：D1 先行；D2/D4/D5 依赖 D1 且改动面互不重叠可并行；
D3 依赖 D2；D6 依赖 D2–D5；D7 依赖 D6。D 线与 V2/V8 改动面不相交，可并行推进。

## 卡

### V1 · tsup 构建试点（agent-ai）

- **依赖**：—
- **改动面**：`packages/agent-ai/`：`tsup.config.ts`（ESM、entry=src/index.ts）、独立
  declaration tsconfig（`tsc --emitDeclarationOnly`）、`package.json` 增 build script 与
  dist 指向的 `exports`/`types`/`files`（保留 `private: true`）；根 `package.json` 若需
  devDependency tsup 一并加（`CI=true pnpm install < /dev/null` 落锁）
- **判据**：`pnpm --filter @einfach-agent/ai build` 产出 `dist/index.js` + `.d.ts`；
  `node -e "import('file:///…/dist/index.js')"` 可加载；仓库内 alias 消费不回归
  （`pnpm test` 相关面 + `pnpm build`）
- **模型**：opus
- **状态**：DONE bca957d（`packages/agent-ai/package.json` 同枚提交搭载了 V4 的
  `repository`/`publishConfig` 两字段——三卡并发写同一文件，按主责归卡）

### V2 · ?raw 内联 esbuild 插件

- **依赖**：V1
- **改动面**：共享构建配置里加 esbuild 插件：`.md?raw` 在 onLoad 读文件内联为字符串
  （语义对齐 `apps/cli/src/raw-module-loader.mjs`）；以 `tools/skills` 为验证对象
- **判据**：`tools/skills` 产物 `dist/` 里无 `?raw` 说明符、skill 正文内联；Node 直接
  `import()` 产物可取到正文
- **模型**：opus
- **状态**：DONE 5af4549（正文逐字往返含非 ASCII；tools/skills 本卡只接 tsup，`.d.ts` 步
  被 TS6059 挡住降级——根因与解法记在 V3a/V3b。probe tsconfig 误射 150 个 `.d.ts` 进源码树
  的事故已自查清理，V8 归因 + 主会话纠偏闭环）

### V3a · core 构建接线（拓扑根）

- **依赖**：V1、V2、V8、D2–D5（core 源码在 D 线在途时不接，避免对半成品跑构建门禁）
- **改动面**：V2 实测发现：`tsc -p tsconfig.build.json` 在**任何有跨包 import 的包**上都会
  因 `tsconfig.app.json` 的 `paths` 把 `@einfach-agent/*` 指向源码而 TS6059 全灭（agent-ai 试点
  零跨包依赖属幸存者偏差）。解法（V2 记在 `tools/skills/tsconfig.build.json` 文件头）：
  依赖包先出 dist 且 exports 改指 dist，本包 `tsconfig.build.json` 加 `"paths": {}` 让声明
  emit 走 node_modules 吃依赖的 `.d.ts`（声明文件不参与 rootDir 判定）。core 是全仓拓扑根，
  单独成卡：`packages/agent-core/` 的 `tsup.config.ts`（entry 与 9 条 subpath exports 逐条
  对应）、`tsconfig.build.json`（`rootDir: "./src"` + `"paths": {}`）、`package.json` 的
  exports 全部改成 `{types, default}` 指 dist、build script 接 fix-dts-specifiers；
  顺手落 V8 建议的 preset 注释（`dts: false` 旁一句「必须接 fix-dts-specifiers，否则
  node16/nodenext 消费方直接红」）
- **判据**：`pnpm --filter @einfach-agent/core build` 绿且 dist 无 `dist/packages/...` 泄漏层级；
  9 条 subpath 的 dist 产物与 exports 逐条对应；nodenext 探针对 core 至少一条 subpath 绿；
  仓库内 `pnpm test` 相关面 + `pnpm build` + `node scripts/check-boundaries.js` 不回归
- **模型**：opus
- **状态**：DONE 5e50939（splitting 单例 A/B 实证；新增硬前提 preserveSymlinks（TS2742，pnpm symlink 环境）；`./*` 通配未动。遗留：上游 @einfach/core@0.2.19 自身非 nodenext-clean（8 条 TS2834），skipLibCheck:false 的消费方会红——修复在上游，发布批次前由用户定夺 patch/升级/README 说明）

### V3b · 其余包构建接线

- **依赖**：V3a、D6（core 的 package.json 两卡都要动，串行避免打架）
- **改动面**：其余待发包（六域 + mcp、tools meta、react-plugin、subagents、persistence-*、
  observability-*）复制骨架：`tsup.config.ts` + `tsconfig.build.json`（**必须** `rootDir:
  "./src"` + `"paths": {}`，V8/V2 的两个硬前提）+ build script（含 fix-dts-specifiers）+
  exports 改指 dist；tools/skills 补上被 V2 降级掉的 `.d.ts` 步。按 workspace 拓扑序
  `pnpm -r build` 串起来
- **判据**：`pnpm -r --filter './packages/**' --filter './tools/**' build` 全绿；
  `scripts/subagent-replay*` 对 `@einfach-agent/subagents/archive/replay` 的消费在 exports
  改 dist 后仍工作（`pnpm subagent:replay` 冒烟 + colocated 测试）；仓库内测试与
  `pnpm build` 不回归
- **模型**：sonnet
- **状态**：DONE a8f263f（17 个 packages/tools 构建全绿；archive/replay 以真实归档 fixture
  直接消费 dist exports 通过。V7 继续用 pack 后安装覆盖真实 Node 消费面）

### V4 · 包元数据整备（G11/G12/G13）

- **依赖**：—
- **改动面**：各待发包 `package.json` 补 `files: ["dist"]`、`publishConfig.access: public`、
  `repository`（含 directory）；每包最小 `README.md`（一句定位 + 指回主仓）；
  `peerDependencies` 的 `workspace:*` → `workspace:^`（G8）
- **判据**：`node scripts/check-docs.js`（新增 README 进扫描）；`CI=true pnpm install`
  无 diff 外抖动；grep 佐证逐包覆盖
- **模型**：sonnet
- **状态**：DONE a7fa424（16 包 metadata + README，directory 逐包核对无误；agent-ai 的两字段
  随 V1 提交 bca957d）

### V5 · 依赖修正侦察（G9/G10）

- **依赖**：—
- **改动面**：侦察卡——G9（`packages/subagents` 未声明 `@einfach/core` 等）全量清点
  undeclared deps 并直接补上（低风险）；G10（core 硬依赖 `@tauri-apps/api`）**只侦察**：
  改 optional peer 需要哪些 import 点位改动态守卫、与 workspace 桥/S5a 的 workspaceDialog
  遗留怎么合流，产出拆卡建议不动手
- **判据**：G9 修正后 `pnpm install` + 相关测试绿；G10 侦察报告含逐 import 点位清单
- **模型**：opus
- **状态**：DONE 76f7d4e（G9：3 处生产依赖 + 16 包测试 devDeps 落锁；agent-core 测试里的
  tools-* 引用按 check-boundaries 的 testFilePattern 口径**不补**——补了即包层反向依赖。
  G10 侦察推翻 S5a「延迟 import 救不了」的记档：`isTauri()` 实测只读全局量，拆卡为 D 线。
  顺带核实：tools/mcp 的 zod 声明**不是死的**——@modelcontextprotocol/sdk 1.29.0 把 zod
  列为 peer（`^3.25 || ^4.0`），保留即显式满足 peer 契约，不删）

### V6 · subagents 死 subpath 砍除

- **依赖**：—
- **改动面**：`packages/subagents/package.json` 的 9 条自有 subpath exports 中 8 条零消费
  （盘点搭便车发现，唯一在用的是 `./archive/replay`）——砍到只剩实际消费面
- **判据**：`pnpm test` 相关面绿；`grep -rn "@einfach-agent/subagents/" apps packages tools scripts`
  与保留清单一致
- **模型**：sonnet
- **状态**：DONE a225ef9

### V7 · 产物冒烟门禁

- **依赖**：V3b
- **改动面**：新脚本 `scripts/check-dist.js`（或等价）：对每个待发包 `npm pack` → 临时目录
  安装 → `import()` 冒烟——专抓 alias 短路下永不暴露的 G5/G6/G11 类问题；本地可跑，
  CI 接线写卡但不动 ci.yml（发布批次再接）
- **判据**：脚本对全部待发包跑通；故意破坏一个 exports 能被抓住（负例测试）；
  含 `moduleResolution: nodenext` 下的类型解析探针（V1 发现 `.d.ts` 内是无扩展名相对
  说明符，V8 修复后此探针是防回归门禁）
- **模型**：opus
- **状态**：DONE（`pnpm check:dist` 对 16 个 `files: ["dist"]` 包执行 pack → 解包暂存
  workspace 依赖为等价发布 semver → 再 pack → 临时 npm consumer 安装；25 个显式公开 ESM
  entry points 与 NodeNext 声明解析通过，并在临时安装物上清空一个 `exports` 后验证负例必败）

### V8 · d.ts nodenext 解析修复

- **依赖**：V1
- **改动面**：V1 发现 `tsc --emitDeclarationOnly` 产出的 `.d.ts` 里是无扩展名相对说明符
  （`export * from './modelApi'`），`moduleResolution: node16/nodenext` 的消费方解析不到。
  修法优先「后处理给声明产物的相对说明符补 `.js` 扩展名」（新脚本挂进包的 build script，
  落在 V1 骨架里让 V3 一并复制）；如实测有更优解（如单文件声明）需在卡上写明取舍。
  改动面：新脚本 + `packages/agent-ai/package.json` build script + 必要的骨架注释
- **判据**：最小 nodenext 消费方探针（临时 tsconfig `module: nodenext` 对 dist 类型入口
  `tsc --noEmit`）从红变绿；`pnpm --filter @einfach-agent/ai build` 与 Node import 冒烟不回归；
  `pnpm exec vitest run packages/agent-ai` 绿
- **模型**：opus
- **状态**：DONE c56671e

## D 线 · G10：core 摘除 @tauri-apps 硬依赖（V5 侦察产出）

背景事实（V5 侦察，已主会话复核）：core 内 14 条 `@tauri-apps` 静态 import 边散在 13 个
文件；`@tauri-apps/api/core` 的 `isTauri()` 实现只是 `!!(globalThis||window).isTauri`，
零运行时依赖，可本地复刻——S5a 在 `index.ts` 留的「延迟 import 救不了（同步探测）」记档
不成立。10 处 `invoke` + 1 处 dialog `open` 全部已在 async 函数内且位于 `isTauri()` 守卫后，
惰性 import 不改时序。风险与合流细节见 V5 报告（Git 历史 76f7d4e 前后）。

### D1 · 本地宿主探测与惰性 invoke 加载器

- **依赖**：—
- **改动面**：新增 `packages/agent-core/src/runtime/hostTauri.ts`：`isTauriHost()`（逐字对齐
  `@tauri-apps/api` 2.11.1 的 `isTauri()` 语义）+ 缓存 module promise 的 `loadTauriInvoke()`
  （缓存纪律同 `state/stateViewPort.ts` 的 S2c 记档，防同 tick 并发首次 import 的 mock 竞态）；
  colocated 测试含「只探测不触发 import」探针。不改任何既有调用点
- **判据**：新文件测试绿；`grep -rn "@tauri-apps" packages/agent-core/src/runtime/hostTauri.ts`
  只有惰性 import 一处（含注释豁免说明）；`node scripts/check-boundaries.js` 通过
- **模型**：sonnet
- **状态**：DONE d3c3883

### D2 · 三处纯探测点脱钩

- **依赖**：D1
- **改动面**：`runtime/modelTurnPrefix.ts`、`runtime/projectSkillsBridge.ts`、
  `runtime/workspaceDialog.ts` 的 `canPickWorkspaceDirectory`——这三处只用 `isTauri`，
  改用 `isTauriHost()` 即删掉静态边，零 async 变更
- **判据**：三文件不再 import `@tauri-apps/api/core`；相关测试 + `pnpm build` 绿
- **模型**：sonnet
- **状态**：DONE 43688c4（波及面补修：apps/web 全量 665 用例扫过，仅 plugins/initialize.test.ts 受影响——两层宿主门各读各的开关；mcp 系列源文件未迁移 mock 仍有效。全量门禁 3098 用例零失败）

### D3 · workspaceDialog 惰性 open 与 smoke 探针升级

- **依赖**：D2
- **改动面**：`runtime/workspaceDialog.ts` 的 `open` 改惰性 import（守卫后、async 内）；
  `index.smoke.test.ts` 的 dialog 探针同步改写——现在断言「barrel 不含 plugin-dialog」，
  静态边消失后原反证用例变空断言，须改成「import 深路径也不加载、真调用
  `pickWorkspaceDirectory` 才加载」
- **判据**：smoke 测试新旧两侧都有效（含反证）；全仓 `@tauri-apps/plugin-dialog` 静态边归零
- **模型**：opus
- **状态**：DONE 7f351c2（变异反证实测有效；check-boundaries 对 typeof import 类型位置与动态 import 无差别计观察项，D7 顺带收口；WorkspaceRootField/WorkspaceSidebar 豁免理由文案已过时，同归 D7）

### D4 · 迁移无计时的 invoke 调用点

- **依赖**：D1
- **改动面**：`runtime/workspaceRead.ts`（invoke×4）、`workspaceRg.ts`、
  `workspacePathOperation.ts`、`workspaceDelete.ts` 改 `loadTauriInvoke()`；纯机械
- **判据**：四文件静态边归零；`vi.mock('@tauri-apps/api/core')` 的既有测试文件**一行不改**
  仍绿（惰性 import 仍被 mock 拦截是 D 线的硬前提）；`pnpm build` 绿
- **模型**：sonnet
- **状态**：DONE 3910247（「既有 mock 测试一行不改」前提对 workspaceRead 的两个 colocated 测试不成立——isTauri mock 死亡墙（见 D5 状态注），按 D5 确立的 vi.mock(./hostTauri) 桥接修法增量适配，A/B 归因已做）

### D5 · 迁移带计时与其余 invoke 调用点

- **依赖**：D1
- **改动面**：`runtime/workspaceWrite.ts:242` 与 `workspacePatch.ts:228` 是
  `const pending = invoke(...)` 不立即 await、夹在 `invokeDispatchMs` 计时区间里——
  `await loadTauriInvoke()` 必须放在 `dispatchStartedAt` 采样**之前**，否则首次调用把模块
  加载耗时算进 IPC 派发诊断；另迁 `workspaceChange.ts`、`workspaceTask.ts`、
  `workspaceGit.ts`、`shellCommand.ts`
- **判据**：六文件静态边归零；计时语义有测试佐证（加载不计入 dispatch 计时）；
  既有 vi.mock 测试一行不改仍绿；`pnpm build` 绿
- **模型**：opus
- **状态**：DONE 84f3a2d（发现系统性前提失效：迁移后 vi.mock('@tauri-apps/api/core') 的 isTauri 分量成死代码——isTauriHost() 读 globalThis.isTauri 不经模块 mock。invoke 分量仍被动态 import 拦截有效。适配约定与清理立 D8）

### D8 · 测试模拟 Tauri 宿主的统一约定与死 mock 清理

- **依赖**：D2、D3、D4、D5
- **改动面**：D2/D4/D5 为过判据各自在测试文件里贴了 `vi.mock('./hostTauri')` 桥或
  `globalThis.isTauri` 开关（modelRun×2、workspaceRead×2、workspaceWrite、
  shellCommand.backgroundKill、apps/web plugins 等）。收敛为一个共享测试 helper
  （放测试脚手架，如 `runtime/hostTauri.testHarness.ts`，命名遵循 check-boundaries 的
  testFilePattern），各测试文件改用它；同时清理已死的 `vi.mock('@tauri-apps/api/core')`
  中 isTauri 分量（invoke 分量仍在用的保留）
- **判据**：`grep -rn "globalThis.isTauri" --include='*.test.*' packages apps` 收敛到
  helper 与 hostTauri 自己的测试；全量 `pnpm test` 绿；helper 文件不被边界扫描当生产代码
- **模型**：sonnet
- **状态**：DONE 6104e7e（helper 单函数 restore 设计；mcp 系两层 mock 各管各的保留；寄主 vi.mock 行按「invoke 分量在用即保留」保守处理）

### D6 · agent-core 依赖降 optional peer

- **依赖**：D2、D3、D4、D5
- **改动面**：`packages/agent-core/package.json`：`@tauri-apps/api`、`@tauri-apps/plugin-dialog`
  从 dependencies 改 `peerDependencies` + `peerDependenciesMeta.optional: true`；tsup external
  补这两个说明符（V3 若已接线则改共享处）；`CI=true pnpm install < /dev/null` 落锁
- **判据**：`grep -rn "@tauri-apps" packages/agent-core/src --include='*.ts' | grep -v test`
  只剩 `hostTauri.ts` 的惰性一处；摘包冒烟（模拟无 optional 依赖时 core 可 import、
  探测返回 false 不炸）；全量 `pnpm test` + `pnpm build` 绿
- **模型**：opus
- **状态**：DONE edbe6a8（G10 交付：dist 唯一 tauri 边为守卫后动态 import 裸说明符；摘包冒烟含「isTauri 强制真 + 依赖缺席」加压路径收敛为失败返回值；lockfile 零变更经强制重解析逐字节验证——pnpm 10 auto-install-peers 把 optional peer 并入解析集；apps 侧无搭便车（web 应用即仓库根包，已直接声明））

### D9 · 发布声明产物摘除 @tauri-apps 类型引用

- **依赖**：D6
- **改动面**：D6 遗留——optional peer 缺席时，`dist/runtime/hostTauri.d.ts` 与
  `dist/runtime/workspaceDialog.d.ts` 里的 `typeof import('@tauri-apps/…')` 对消费方 tsc
  解析不到（运行时无碍已冒烟证实；消费方开 skipLibCheck 时也静默，但发布物类型面应自洁）。
  把 `runtime/hostTauri.ts`、`runtime/workspaceDialog.ts` 源码里的类型位置引用换成本地
  结构类型（invoke 需保留泛型形态 `<T>(cmd, args?, opts?) => Promise<T>`，调用点的
  `invoke<unknown>` 不能破）；`.testHarness.ts` 不在发布物内，不动
- **判据**：重建后 `grep -rn "@tauri-apps" packages/agent-core/dist --include='*.d.ts'`
  零命中；hostTauri/workspaceDialog 相关测试与 smoke 探针一行不改仍绿；`pnpm build` 绿
- **模型**：sonnet
- **状态**：DONE 53ceef9（实测唯一泄漏点是 loadTauriInvoke 导出签名；另发现并处理「导出符号 JSDoc 写包名字面量会被 tsc 带进 d.ts」的次生泄漏。**违纪记档**：该 agent 用了 git stash 做基线对比（明令禁止）——已验无残留、无损伤（stash 表里两条均为本会话前的历史遗留，勿动），后续派活 prompt 需继续强调）

### D7 · 豁免表与模块图纪律注释合流收尾

- **依赖**：D6
- **改动面**：`scripts/check-boundaries.js`——workspace 桥那条「barrel 会把 @tauri-apps 灌进
  模块图」豁免的理由随静态边消失而失效，逐条重估：能退的退（并进 `./tools` barrel）、
  退不掉的改写理由（如 `workspaceRead × apps/web/src/plugins` 还有 vi.mock 目标这层）、
  `hostPlatform`（本就零 tauri 边、搭便车挂在豁免里）归位；重写
  `packages/agent-core/src/index.ts` 头部与 workspaceDialog 例外注释；
  `docs/launch/npm-publish-plan.md` 的 G10 标已解决
- **判据**：`node scripts/check-boundaries.js` 通过且豁免表条数下降；受影响包邻接测试 +
  `pnpm build` + `node scripts/check-docs.js` 绿
- **模型**：opus
- **状态**：DONE（豁免表从 9 条归为 2 条测试边界例外；生产调用统一走根面或
  `@einfach-agent/core/tools`，根 barrel/Tauri smoke、邻接测试、17 包构建、`pnpm build`、文档与边界门禁均绿）
