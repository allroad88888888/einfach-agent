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
V7 产物冒烟门禁
GATED  实际 publish + S10 + 包名换 scope（用户触发）
```

并行规则：V1/V4/V6 无依赖可先行；V2 依赖 V1（复用其构建骨架）；V3 依赖 V1+V2；
V5 先侦察后动（G10 可能牵动 workspace 桥，侦察定拆卡）；V7 依赖 V3。

## 卡

### V1 · tsup 构建试点（agent-ai）

- **依赖**：—
- **改动面**：`packages/agent-ai/`：`tsup.config.ts`（ESM、entry=src/index.ts）、独立
  declaration tsconfig（`tsc --emitDeclarationOnly`）、`package.json` 增 build script 与
  dist 指向的 `exports`/`types`/`files`（保留 `private: true`）；根 `package.json` 若需
  devDependency tsup 一并加（`CI=true pnpm install < /dev/null` 落锁）
- **判据**：`pnpm --filter @web-agent/ai build` 产出 `dist/index.js` + `.d.ts`；
  `node -e "import('file:///…/dist/index.js')"` 可加载；仓库内 alias 消费不回归
  （`pnpm test` 相关面 + `pnpm build`）
- **模型**：opus
- **状态**：DOING

### V2 · ?raw 内联 esbuild 插件

- **依赖**：V1
- **改动面**：共享构建配置里加 esbuild 插件：`.md?raw` 在 onLoad 读文件内联为字符串
  （语义对齐 `apps/cli/src/raw-module-loader.mjs`）；以 `tools/skills` 为验证对象
- **判据**：`tools/skills` 产物 `dist/` 里无 `?raw` 说明符、skill 正文内联；Node 直接
  `import()` 产物可取到正文
- **模型**：opus
- **状态**：TODO

### V3 · 逐包构建接线

- **依赖**：V1、V2
- **改动面**：其余待发包（core、六域 + mcp、tools meta、react-plugin、subagents、
  persistence-*、observability-*）复制 V1/V2 骨架接 build；`pnpm -r build` 串起来
- **判据**：`pnpm -r --filter './packages/**' --filter './tools/**' build` 全绿；
  仓库内测试与 `pnpm build` 不回归
- **模型**：sonnet
- **状态**：TODO

### V4 · 包元数据整备（G11/G12/G13）

- **依赖**：—
- **改动面**：各待发包 `package.json` 补 `files: ["dist"]`、`publishConfig.access: public`、
  `repository`（含 directory）；每包最小 `README.md`（一句定位 + 指回主仓）；
  `peerDependencies` 的 `workspace:*` → `workspace:^`（G8）
- **判据**：`node scripts/check-docs.js`（新增 README 进扫描）；`CI=true pnpm install`
  无 diff 外抖动；grep 佐证逐包覆盖
- **模型**：sonnet
- **状态**：DOING

### V5 · 依赖修正侦察（G9/G10）

- **依赖**：—
- **改动面**：侦察卡——G9（`packages/subagents` 未声明 `@einfach/core` 等）全量清点
  undeclared deps 并直接补上（低风险）；G10（core 硬依赖 `@tauri-apps/api`）**只侦察**：
  改 optional peer 需要哪些 import 点位改动态守卫、与 workspace 桥/S5a 的 workspaceDialog
  遗留怎么合流，产出拆卡建议不动手
- **判据**：G9 修正后 `pnpm install` + 相关测试绿；G10 侦察报告含逐 import 点位清单
- **模型**：opus
- **状态**：DOING

### V6 · subagents 死 subpath 砍除

- **依赖**：—
- **改动面**：`packages/subagents/package.json` 的 9 条自有 subpath exports 中 8 条零消费
  （盘点搭便车发现，唯一在用的是 `./archive/replay`）——砍到只剩实际消费面
- **判据**：`pnpm test` 相关面绿；`grep -rn "@web-agent/subagents/" apps packages tools scripts`
  与保留清单一致
- **模型**：sonnet
- **状态**：DOING

### V7 · 产物冒烟门禁

- **依赖**：V3
- **改动面**：新脚本 `scripts/check-dist.js`（或等价）：对每个待发包 `npm pack` → 临时目录
  安装 → `import()` 冒烟——专抓 alias 短路下永不暴露的 G5/G6/G11 类问题；本地可跑，
  CI 接线写卡但不动 ci.yml（发布批次再接）
- **判据**：脚本对全部待发包跑通；故意破坏一个 exports 能被抓住（负例测试）
- **模型**：opus
- **状态**：TODO
