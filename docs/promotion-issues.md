# 推广发布 Issue 树

目标：把已 public 但处于"裸公开"状态的仓库（无 LICENSE、无 description、README 无首屏
demo、包未发布）铺到"路人 30 秒看懂、10 分钟跑通"的可发布状态，并备齐发布素材。

非目标：任何"按发布键"的动作（npm publish、发帖、repo 改名）都由用户执行，不在本树内。

约定：发布素材统一落 `docs/launch/`（发布完成后整目录可归档删除）；文内引用代码路径用
反引号不用链接；每卡目标 20 分钟左右（含主会话验收）。

## 树

```text
未决  命名 / License / 主打故事（不排期，拍板前依赖它们的卡不开工）
A 开源就绪   A1 秘钥审计  A2 冷启动验证  A3 CONTRIBUTING  A4 元信息文案
             A5 LICENSE   A6 中文 README  A7 英文 README  A8 esbuild 占位符修复  A9 元信息定稿  A10 旧称同步  A11 桌面标题
B Demo 物料  B1 CLI 录屏  B2 截图清单    B3 截图执行
C 文章草稿   C1 装配内核  C2 CallTiming  C3 dogfood 400  C4 DeepSeek 踩坑  C5 子 Agent 治理
             C6 maxTurns 文档修正
D 对比定位   D1 竞品事实  D2 对比表
E 发布工程   E1 release 审计  E2 npm 发包方案
F Launch 帖  F1 中文渠道  F2 英文渠道
G 收尾       G1 删除本树
```

并行规则：依赖满足且改动面不重叠的卡可同时派。A1/A2/A3/A4/B1/B2/C1–C5/D1/E1/E2 不依赖
未决项，可先行；A5/A6/A7/D2/F1/F2 在对应决策拍板前不开工。

## 未决（已全部拍板，2026-08-13）

- **命名**：✅ 统一 einfach 系。显示名 Einfach Agent；GitHub 仓库维持 einfach-agent；
  npm scope 采用 einfach 系（实际包改名留到发包执行时，见 E2 蓝图的 scope 占位）。
- **License**：✅ MIT。
- **主打故事**：✅ 开发者框架（装配式内核），桌面版定位为内核能力展示品。

## A · 开源就绪

### A1 · git 全历史秘钥审计

- **依赖**：—
- **改动面**：仓库零改动；报告写入会话 scratchpad
- **判据**：对全历史跑 `git log -p` 按 `sk-`、`ghp_`、`AKIA`、`api[_-]?key` 等模式扫描；
  确认 `.env.local`、`~/.webAgent` 相关文件未被追踪；报告给出"是否发现泄漏"的明确结论。
  发现泄漏则另立卡处理，本卡不改历史
- **模型**：sonnet
- **状态**：DONE（仓库零改动，报告在会话 scratchpad）

### A2 · quickstart 冷启动验证

- **依赖**：—
- **改动面**：仓库零改动；摩擦点报告写入会话 scratchpad
- **判据**：在干净临时目录 `git clone` 本仓库后依次 `pnpm install`、`pnpm build`、
  `pnpm cli --help` 全部成功；README 步骤与实际差异逐条记录，供 A6 修正
- **模型**：sonnet
- **状态**：DONE（仓库零改动，报告在会话 scratchpad）

### A3 · CONTRIBUTING.md

- **依赖**：—
- **改动面**：`CONTRIBUTING.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；覆盖 pnpm workspace 流程、测试与 build
  门禁、conventional commit 约定、文件行数红线
- **模型**：sonnet
- **状态**：DONE fc00103

### A4 · GitHub 元信息文案

- **依赖**：—
- **改动面**：`docs/launch/repo-metadata.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；含 description（中英各一句）、topics 候选
  （≤20 个）、About 区建议；名字处标注占位待"未决·命名"
- **模型**：sonnet
- **状态**：DONE 335ac98

### A5 · LICENSE 落地

- **依赖**：未决·License
- **改动面**：`LICENSE`（新建）；根与各 `apps/*`、`packages/*`、`tools/*` 的
  `package.json` 增加 `license` 字段
- **判据**：LICENSE 文本与拍板一致；`grep -r '"license"' --include=package.json` 各包一致；
  `pnpm build` 通过
- **模型**：sonnet
- **状态**：DONE f043968

### A6 · 中文 README 重写

- **依赖**：未决·命名、未决·主打故事、B1、A2
- **改动面**：`README.md`
- **判据**：`node scripts/check-docs.js` 通过；首屏含一句定位、demo GIF 引用、≤5 步
  quickstart；A2 记录的摩擦点已修正
- **模型**：opus
- **状态**：DONE 1fcf890

### A7 · 英文 README

- **依赖**：A6
- **改动面**：`README.en.md`（新建）；`README.md` 顶部加互链
- **判据**：`node scripts/check-docs.js` 通过；结构与中文版对齐，非逐句直译
- **模型**：opus
- **状态**：DONE 49194e8

### A8 · 修复 pnpm-workspace.yaml 的 esbuild 占位符

- **依赖**：—
- **改动面**：`pnpm-workspace.yaml`
- **判据**：A2 冷启动发现第 7 行是字面量占位符 `esbuild: set this to true or false`，每次
  install 都打印 "Ignored build scripts" 警告；查证构建脚本被忽略时 esbuild 是否仍完好
  （平台二进制经 optionalDependencies 分发则应设 false），落成真实布尔值；
  `CI=true pnpm install < /dev/null` 不再出该警告；`pnpm build` 通过
- **模型**：sonnet
- **状态**：DONE 8d55dfd

### A9 · 元信息文案按命名定稿

- **依赖**：未决·命名（已拍板：einfach 系）
- **改动面**：`docs/launch/repo-metadata.md`
- **判据**：把 `<项目名>` 占位与"待拍板"说明替换为 Einfach Agent 定稿口径；
  `node scripts/check-docs.js` 通过
- **模型**：sonnet
- **状态**：DONE 5ce6c41

### A10 · 文档旧称同步为 Einfach Agent

- **依赖**：未决·命名（已拍板）
- **改动面**：除 `README.md`（A6 负责）外所有含旧称"Web Agent"的文档：`CONTRIBUTING.md`、
  `docs/**`、`.github/**` 等；不改代码标识符（`@web-agent/*` 包名、`~/.webAgent` 配置目录、
  `WEB_AGENT_*` 环境变量维持原样，属发包/兼容范畴）
- **判据**：`grep -rn "Web Agent" --include="*.md"` 里除 README（A6 处理）与历史性引用外
  的旧称改为 Einfach Agent；`node scripts/check-docs.js` 通过
- **模型**：sonnet
- **状态**：DONE 94ff705

### A11 · 桌面窗口标题与 release 名称改为 Einfach Agent

- **依赖**：未决·命名（已拍板）
- **改动面**：`apps/desktop/tauri.conf.json`（`"title"`）、`apps/desktop/src/mcp.rs`
  （MCP clientInfo title）、`.github/workflows/release-desktop.yml`（`releaseName`）；
  代码标识符（crate 名、文件名、`web_agent_config_store` 等）不改
- **判据**：三处用户可见字符串改为 Einfach Agent；
  `cargo test --manifest-path apps/desktop/Cargo.toml` 通过；workflow 仅改 releaseName 一处
- **模型**：sonnet
- **状态**：DONE 68c34ca

## B · Demo 物料

### B1 · CLI demo 录制

- **依赖**：—
- **改动面**：`docs/launch/assets/cli-demo.gif`（或 `.cast`）、`docs/launch/demo-script.md`
- **判据**：产物文件存在且可播放；演示覆盖一次真实 run（工具调用 + 流式回复）；
  `demo-script.md` 按其步骤可复录。真实 Key 走 `pnpm cli` 的既有凭据链路，禁止出现在
  任何产物里；录制工具缺失时先交脚本并记录安装步骤，由主会话补录
- **模型**：sonnet
- **状态**：DONE 9ea55a8 + 69fb8cc（gif 已用 vhs 补录）

### B2 · 桌面版截图清单

- **依赖**：—
- **改动面**：`docs/launch/screenshot-plan.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；列出 ≥6 个界面场景（会话流、计划审批、
  子 Agent 树、危险工具确认、trace viewer、MCP 设置），每项写明需要的前置状态
- **模型**：sonnet
- **状态**：DONE d7a4685

### B3 · 桌面截图执行

- **依赖**：B2
- **改动面**：`docs/launch/assets/*.png`
- **判据**：清单场景各有一张截图；画面里无隐私信息（本机路径、key、真实会话内容）
- **模型**：—（主会话亲自执行，GUI 操作无法委派）
- **状态**：DONE 8390f15（浏览器草稿 3 张：会话流式/决策提问/计划审批；危险确认、子 agent 树、trace viewer、MCP 已连接态受浏览器宿主限制，待桌面补拍）

## C · 技术文章草稿（全部落 `docs/launch/articles/`）

### C1 · 《一个内核，三个宿主：装配式 Agent Runtime 设计》

- **依赖**：—
- **改动面**：`docs/launch/articles/assembly-kernel.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；引用的 API 与文件路径和当前代码一致
  （抽查 `createCore` 槽位、Web/桌面/CLI 三处装配入口）
- **模型**：opus
- **状态**：DONE e3fe18f

### C2 · 《给工具加生命周期：CallTiming 机制》

- **依赖**：—
- **改动面**：`docs/launch/articles/call-timing.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；九个核心时机与
  `packages/agent-core/src/tools/toolCallTiming.ts` 定义一致；与 Claude Code hooks 的
  对比至少 3 条且事实准确
- **模型**：opus
- **状态**：DONE a006f43

### C3 · 《用 CLI 宿主 dogfood，十分钟抓出一个线上 400》

- **依赖**：—
- **改动面**：`docs/launch/articles/dogfood-400.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；叙事与 `f4e3359` 前后的提交事实一致；
  全文不出现任何真实 key 片段
- **模型**：opus
- **状态**：DONE 605c4a7

### C4 · 《DeepSeek V4 thinking 协议踩坑实录》

- **依赖**：—
- **改动面**：`docs/launch/articles/deepseek-v4-pitfalls.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；坑位描述与
  `packages/agent-ai/src/deepseek.ts` 的请求净化与 thinking 归一化行为一致
- **模型**：opus
- **状态**：DONE 1e624f0

### C5 · 《子 Agent 治理：replay、容量与归档》

- **依赖**：—
- **改动面**：`docs/launch/articles/subagent-governance.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；提到的治理脚本与根 `package.json` 的
  `subagent:*` 脚本一一对应
- **模型**：opus
- **状态**：DONE f31de61

### C6 · 修正子 Agent 文档与测试注释里过时的 maxTurns 数字

- **依赖**：—
- **改动面**：`docs/tree-subagent-runtime.md`、`packages/agent-core/src/subagents/runtime.test.ts`（仅注释）
- **判据**：C5 写作核实发现文档写 maxTurns 硬上限 8，代码 `subagents/input.ts` 的
  `HARD_MAX_TURNS = 16`；`runtime.test.ts:2343` 注释同样写 8。两处改为与代码一致；
  `node scripts/check-docs.js` 与 `pnpm exec vitest run packages/agent-core/src/subagents/runtime.test.ts` 通过
- **模型**：sonnet
- **状态**：DONE 28e059a

## D · 对比与定位

### D1 · 竞品事实收集

- **依赖**：—
- **改动面**：`docs/launch/competitor-facts.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；pi / OpenCode / Cline / Cherry Studio 每家
  覆盖架构形态、扩展机制、模型支持、子 Agent 与观测能力，逐条附来源链接（需联网检索）
- **模型**：sonnet
- **状态**：DONE 442ad3e

### D2 · 对比表成文

- **依赖**：D1、未决·主打故事
- **改动面**：`docs/launch/comparison.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；诚实列出本项目弱项 ≥3 条；强项与代码事实
  一致（不写未交付能力）
- **模型**：opus
- **状态**：DONE e33eb8b

## E · 发布工程

### E1 · release workflow 审计（原"新建草稿"，前提失效后改写）

- **依赖**：—
- **改动面**：审计报告写入会话 scratchpad；仅确认真实缺陷时才修改
  `.github/workflows/release-desktop.yml`
- **判据**：写卡时漏看了已存在的 `release-desktop.yml`（`e90ab14`，签名校验 + draft
  release 齐备），本卡改为：与 `ci.yml` 的环境一致性核对、缺陷排查（引号转义、权限提升、
  并发设置）、lint；结论落 scratchpad 报告
- **模型**：opus
- **状态**：DONE 7a0ade2

### E2 · npm 发包方案蓝图

- **依赖**：—
- **改动面**：`docs/launch/npm-publish-plan.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；覆盖 src-alias 不编译的现状、构建工具选型、
  包间发布顺序、不发布清单（`apps/*`、示例包）、版本与 dist-tag 策略；明确标注为蓝图
- **模型**：opus
- **状态**：DONE c5117e2

## F · Launch 帖草稿

### F1 · 中文渠道帖（V2EX / 掘金 / 即刻）

- **依赖**：A6、B1、未决·命名、未决·主打故事
- **改动面**：`docs/launch/posts-zh.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；三个渠道各一版且调性区分（V2EX 克制、
  掘金带技术细节、即刻短句）
- **模型**：opus
- **状态**：DONE 9e6c99d

### F2 · 英文渠道帖（Show HN / r/LocalLLaMA）

- **依赖**：A7、未决·命名、未决·主打故事
- **改动面**：`docs/launch/posts-en.md`（新建）
- **判据**：`node scripts/check-docs.js` 通过；Show HN 标题 ≤80 字符、首段无 marketing 腔；
  LocalLLaMA 版突出国产模型协议细节
- **模型**：opus
- **状态**：DONE 165140b

## G · 收尾

### G1 · 删除本树

- **依赖**：其余全部 DONE
- **改动面**：删除 `docs/promotion-issues.md` 与 `docs/README.md` 的索引行；`docs/launch/`
  去留由用户届时决定
- **判据**：`node scripts/check-docs.js` 通过
- **模型**：sonnet
- **状态**：DOING（本卡与树的删除同批执行）
