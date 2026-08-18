# 项目内 Skills 自动加载蓝图（`.webAgent/` 约定）

目标：让 agent 在绑定某个 workspace 后，**自动发现并加载该仓库自带的 skills**，与编译期内置
skills 并列进入 L1 清单，正文与资源沿用既有 L2/L3 协议按需读取。

本文是 [`skills-tree-blueprint.md`](skills-tree-blueprint.md)「阶段 4 — （可选）Tauri 文件系统
skills 目录」占位项的展开，接续其阶段 1–3 已落地的成果，不重复其结论。

## 背景：三个事实

1. **现状是纯静态的**（`packages/agent-core/src/skills/registry.ts`）：5 个 skill 由
   `import x from './x.md?raw'` 在编译期打包成模块级常量 `skillSources`，元数据（name /
   description / triggers / resources）写死在数组里。运行期**没有任何注册入口**，
   `buildSkillManifestText()` / `readSkill()` / `readSkillResource()` 全是同步纯查询。
   换言之：当前无论 workspace 里有什么，agent 都看不见。
2. **文件系统地基已经齐全，无需新增 Rust command**。`list_workspace_files` 支持
   `recursive` 与 `includeHidden`（`.webAgent` 是隐藏目录，必须后者），`read_workspace_file`
   带 workspace confinement；两者都经 `toolContext/workspaceInputGuards.ts` 的 `withWorkspaceReadAccess` 注入会话
   绑定的 `workspaceRoot`（`resolveWorkspaceRoot`，session → workspace 解析已存在）。
   `tools/fs/find-test-lint-commands` 已经是「列目录 + 读文件 → 推断项目约定」的同构先例。
3. **`.webAgent-archive/` 是另一条线，不要混淆**。子 agent 的 `sk_*` 经验技能
   （`subagents/skillCache.ts` + `runtime/skillGovernance.ts`）由子 agent 产出、经 CLI
   （`npm run subagent:skills`）治理 promote，**不进主会话 registry、不进清单**。本蓝图只覆盖
   「仓库作者预置、给主会话用」的静态 skills。三个目录职责互不重叠：

   | 目录 | 归属 | 是否入库 |
   | --- | --- | --- |
   | `.webAgent/` | 仓库作者预置的 skills（本蓝图） | **入库** |
   | `.webAgent-archive/` | 子 agent 运行归档与经验技能 | 已在 `.gitignore` |
   | `.webAgent-cache/` | 本地缓存 | 已在 `.gitignore` |

## 目录约定

```text
<workspace>/
  .webAgent/
    skills/
      deploy-flow/
        SKILL.md              # 必需：frontmatter(name, description) + 正文（L2）
        references/
          checklist.md        # 可选：L3 资源，键即相对 SKILL.md 的路径
  .claude/
    skills/
      legacy-skill/SKILL.md   # 兼容读取（只读，格式同构）
```

- 一个 skill = 一个目录 + 目录内的 `SKILL.md`；`SKILL.md` 同目录下的其它文本文件即该 skill 的
  L3 资源，资源键是相对该目录的路径（`references/checklist.md`），与内置 skill 的
  `resources` Record 键语义逐字一致。
- 扫描根：`.webAgent/skills/` 与 `.claude/skills/`（后者是兼容路径，只读，不写）。
- 深度：skill 目录只认扫描根的**直接子目录**；资源可再嵌套。
- **同样这两个目录会在用户主目录下再扫一遍**（`~/.webAgent/skills/`、`~/.claude/skills/`），
  见下方「作用域」。

## 命名空间：项目 skill 一律带 `project/` 前缀

清单里项目 skill 显示为 `project/deploy-flow`，`skill_read` 也用这个名字。理由有三条，
每条都单独成立：

1. **消灭撞名**：内置 `planning` 与项目 `planning` 不会互相覆盖，无需定义谁赢。
2. **来源可见**：用户选择了「自动加载、不设确认」（见「安全边界」），来源标注就是模型侧
   仅存的可信度信号——它必须出现在名字里，而不只在段落说明里。
3. **前缀内的分段可排序**：清单按「内置段 → 项目段」分区，各段内按名字字节序排，
   字节稳定契约不受影响。

`.webAgent/skills/x` 与 `.claude/skills/x` 撞名时 **`.webAgent` 胜**（自家约定优先），
落选者不进清单，并记一条可观测告警。

## 作用域：工作区 `project/` 与用户主目录 `user/`

同一套目录约定在**两个根**下各生效一次：

| 作用域 | 扫描根 | 名字前缀 | 路径相对 |
| --- | --- | --- | --- |
| `project` | `<workspace>/.webAgent/skills`、`<workspace>/.claude/skills` | `project/` | 会话 `workspaceRoot` |
| `user` | `~/.webAgent/skills`、`~/.claude/skills` | `user/` | 快照的 `userSkillsRoot` |

- **两个作用域各占一个前缀，因此永不撞名**：工作区与主目录里同名的 `deploy` 是清单里
  两条并存的项（`project/deploy` 与 `user/deploy`），用户也能分别停用。撞名裁决只发生在
  同一作用域的 `.webAgent` 与 `.claude` 之间，规则不变。
- **上限按作用域各算一份**（各 32 个）：主目录堆满不该把工作区自己的 skill 挤掉。
- **主目录那两路把主目录当根传给桥**，路径依然是根内相对路径，因此不需要任何「允许越界读」
  的权限；`skill_read` 读取时按 `scope` 取对应的根（`ctx.skills.resolveScannedSkill` 返回
  `rootPath`）。用会话 workspace 去读主目录的文件会被 confinement 挡下，报的还是
  「路径越界」——看上去像权限问题，与真实原因（根取错）无关。
- **主目录恰好就是当前工作区时只扫一遍**：同一批文件不该以两个名字各占一份清单预算。
- 主目录由宿主给：Tauri 走 `@tauri-apps/api/path` 的 `homeDir()`
  （`runtime/userSkillsRoot.ts`，失败降级 undefined），CLI 走 `node:os` 的 `homedir()`，
  浏览器没有 → 只扫工作区。
- 清单里两个作用域**分两段**（「以下由当前 workspace 提供」/「以下由本机用户目录提供」）：
  来源不同、可信度也不同，合成一段会让模型无从分辨。

## 数据模型

```ts
/** 扫描产出的快照条目：只含元数据与路径，不含正文。 */
interface ProjectSkillEntry {
  /** 清单与 skill_read 使用的名字，恒为 `<scope>/<dir-name>`。 */
  name: string
  /** frontmatter description，单行化并截断后的结果；缺失则该 skill 被丢弃。 */
  description: string
  /** frontmatter triggers（可选），仅供 skill_search 检索，不参与请求组装。 */
  triggers: string[]
  /** SKILL.md 相对**本条目所属扫描根**的路径（见「作用域」）。 */
  filePath: string
  /** 资源键（相对 skill 目录）→ 相对同一扫描根的路径。白名单，见「安全边界」。 */
  resources: Record<string, string>
  /** 'agent' | 'claude'，用于告警与 UI 展示。 */
  origin: 'agent' | 'claude'
  /** 'project' | 'user'，决定名字前缀与 filePath 相对的根。 */
  scope: 'project' | 'user'
}

interface ProjectSkillsSnapshot {
  workspaceRoot: string
  /** 用户级扫描根（通常是主目录）；没扫用户目录时缺省，快照里也不会有 user 条目。 */
  userSkillsRoot?: string
  entries: ProjectSkillEntry[]
  /** 扫描期的降级信息（读失败、超限截断、撞名落选），供 UI 与 trace 展示，不进 prompt。 */
  diagnostics: string[]
}
```

**只读元数据、不预读正文**是有意的：清单只需要 name + description，正文与资源留到
`skill_read` 时按需 IO。扫描成本因此与 skill 数量成正比、与内容体积无关。

### frontmatter 子集

```markdown
---
name: deploy-flow
description: 何时用：改发布脚本或排查发布失败时读我；何时不用：普通业务改动。
triggers: [deploy, 发布, 上线]
---

正文从这里开始（L2）。
```

自写最小解析器，不引第三方依赖（仓库无 yaml 依赖，`skillCache.ts` 手写 yaml 输出是既有先例）：

- 只识别文件**开头**的 `---` 围栏，只支持 `name` / `description` / `triggers` 三个键；
  值只支持单行 scalar 与行内数组，不支持嵌套与多行。
- 未知键忽略并计入 `diagnostics`（不静默）。
- `name` 缺失 → 用目录名。`description` 缺失 → **丢弃该 skill**：清单里没有「何时用」的条目
  对模型是纯噪声，而这正是阶段 3 之后模型唯一的选择依据。
- 无 frontmatter 的 `SKILL.md` 同样按「description 缺失」处理。

> 不对称记录：内置 skill 的元数据在 `registry.ts` 数组里、`.md` 本身没有 frontmatter。
> 统一（内置也迁 frontmatter）是可选的后续项，不在本蓝图范围内。

## 加载时机与缓存

- **缓存键是 `workspaceRoot`，不是 sessionId**。同一 core 内不同会话可绑不同 workspace，
  同 workspace 的多会话共享一份快照。存储挂 `CoreInstance`（`core.projectSkills`，与
  `core.tools` 同构），`createCore()` 的隔离性天然成立；**内置层保持模块级常量不动**
  （编译期恒定，无隔离问题）。
- **触发点**：`modelRun` 组装稳定前缀之前 `await ensureProjectSkills(sessionId, core)`。
  命中缓存时同步返回，只有首次绑定或显式刷新才走真实 IO；`buildSkillManifestText` 因此仍是
  同步纯函数，只是多接一个快照入参。
- **失效**：会话切换 workspace、用户在 UI 显式刷新。**第一期不做文件监听**——改了
  `.webAgent/skills` 要点一下刷新，或换会话。
- **降级**：非 Tauri（web）没有文件系统 → 快照恒为空。**此时清单逐字等于今天的输出**
  （项目段整体不出现，而不是出现一个空段），web 端零回归是硬要求。
  扫描失败（无 workspace、目录不存在、桥报错）同样降级为空快照 + `diagnostics`，
  **绝不让 run 失败**。

## 与稳定前缀 / 缓存 epoch 的关系

项目段并入 `buildSkillManifestText()` 的输出，位置仍在 `stablePrefix` 的第二段
（`modelRun.ts:1379` 附近），已被 `stablePrefixContent` 计入 `systemFingerprint`，
因此无需改 contextCache：

- 同一 workspace 内连续对话：快照不变 → 清单字节不变 → 缓存照常命中，**epoch 不动**。
- 切 workspace / 刷新 / 仓库改了 skill：前缀字节变 → contextCache 归因 `profile_changed`
  并起新 epoch，一次性全量 miss。这与「用户改自定义指令」「工具注册态变化」是同一权衡，
  低频、可解释。
- transcript 的「注入 skill 清单」卡片按内容指纹判重（`modelRun.ts:1431` 附近），
  项目 skills 变化会自然记一张新卡，无需额外改动。

## 读取链路

现有 `skill_read` / `skill_search` 直接 `import` registry 模块函数。项目 skills 是 per-core
数据，必须改经 `ToolContext`——这同时修正了「工具绕过 ctx 拿能力」的既有小违例：

```ts
// ToolContext 新增只读能力（buildToolContext 从 core + sessionId 注入）
skills?: {
  list(): SkillSummary[]                                   // 内置 + 扫描（快照）
  read(name: string): LoadedSkill | undefined              // 内置：同步命中正文
  // 阶段 F 起：`user/` 也走这里，且返回该条目自己的读取根
  resolveScannedSkill(name: string):
    { filePath: string; resources: Record<string, string>; rootPath: string } | undefined
}
```

- `skill_search`：改读 `ctx.skills.list()`，评分逻辑不变；ctx 缺失时回退模块级内置 registry，
  现有测试逐字不变。
- `skill_read(name)`：`project/` 或 `user/` 前缀 → `resolveScannedSkill` 拿到 `SKILL.md` 路径与
  `rootPath` → `ctx.readWorkspaceFile`（把 `rootPath` 作为 `workspaceRoot` 原样传下去）读取 →
  **剥掉 frontmatter** 返回正文 + `resources` 目录；内置名走今天的同步分支。`execute` 改 async
  （`Tool.execute` 本就允许返回 Promise）。
- `skill_read(name, resource)`：资源键必须在快照白名单内精确命中，命中后才用其**扫描时记录的
  路径**去读——不接受模型给出的任意路径。

## 安全边界

**已定决策：自动加载，不设首次确认**（用户 2026-07-28 决定）。据此如实记录权衡与缓解。

风险面是真实的：项目 skill 的 description 直接进 system 稳定前缀，等价于「clone 到本地的任何
仓库都能往 system prompt 里写字」。不设确认意味着这条注入路径**默认敞开**，本蓝图不假装
它被关上了。以下缓解不改变「自动加载」的体验，必须全部落地：

1. **来源可见**：`project/` 名字前缀 + 清单项目段固定前言（「以下由当前 workspace 提供，
   非内置」）。模型据此知道这批条目的可信度低于内置。
2. **注入卫生**（纯函数，可单测）：name 限定 `[a-z0-9-]{1,64}`，越界即丢弃；description
   剥离控制字符、折成单行、截断至 160 字符——防止伪造清单行、伪造段落分隔、撑爆前缀。
3. **路径不由模型给**：L3 资源只读扫描期已发现的键，路径来自快照；叠加 Rust 侧既有的
   workspace confinement 兜底。
4. **治理上限**：单 workspace 最多 32 个 skill（超出按名字序截断并告警），单 skill 最多 32 个
   资源，单资源 64KB（复用 `truncateSkillResourceContent`），扫描 `maxEntries` 上限 2000。
5. **资源扩展名白名单**：`.md/.txt/.json/.yaml/.yml/.csv/.ts/.tsx/.js/.sql`，其余忽略，
   避免把二进制读进上下文。
6. **可观测**：`diagnostics` 进 UI 与 trace，用户随时能看到「这个 workspace 往清单里加了什么」。

若日后要收紧，最小改动是在 §加载时机的 `ensureProjectSkills` 前加一道 workspace 信任门，
其余设计不动。

## 实施阶段

### 阶段 A — 纯函数层（零 IO，全单测）

- `skills/projectSkills.ts`：frontmatter 解析、name/description 卫生化、条目构建、
  撞名与上限裁决、`diagnostics` 生成；全部是「输入 = 文件清单 + 文本，输出 = 快照」的纯函数。
- `buildSkillManifestText(snapshot?)` 扩展：无快照/空快照时输出与今天逐字相同（回归护栏）。
- colocated 测试：frontmatter 各种残缺形态、卫生化边界（控制字符/超长/非法 name）、
  `.webAgent` 与 `.claude` 撞名、上限截断、空快照字节一致性。

### 阶段 B — 扫描与缓存

- `skills/projectSkillsLoader.ts`：经 `listWorkspaceFiles`（`recursive: true, includeHidden: true`）
  扫两个根 → 读各 `SKILL.md` 的前 4KB 取 frontmatter → 组快照；非 Tauri / 失败一律空快照。
- `CoreInstance.projectSkills`：`Map<workspaceRoot, ProjectSkillsSnapshot>` + `ensure` / `refresh` / `clear`。
- 测试用 fake 桥（不碰真实 fs），覆盖：命中缓存不重复 IO、读失败降级、无 workspace 降级。

### 阶段 C — 请求组装与读取链路

- `modelRun` 组装前 `await ensureProjectSkills`，清单带上快照；
- `ToolContext.skills` 注入 + `skill_read` / `skill_search` 改造（含 async 分支与白名单校验）；
- 测试：项目 skill 进清单的快照断言、web 端清单零回归、`skill_read` 读项目正文/资源/
  非法资源键、`skill_read` 对未知 `project/*` 的错误引导。

### 阶段 D — UI 与可观测

- 会话/设置面板展示当前 workspace 的项目 skills（名字、来源、资源数）与刷新按钮；
- `diagnostics` 展示；transcript 注入卡片沿用既有判重，无需改动。

### 实施状态（2026-07-28）

阶段 A–D 已落地并通过 `pnpm exec vitest run` 全量与 `pnpm build`。阶段 E 未做。

首版代码经 review 后修正了以下缺陷，都属于「跑起来像是好的、实际不工作或长期劣化」的类型，
后续改动不要回退：

| 缺陷 | 后果 | 现状 |
| --- | --- | --- |
| `skill_read` 直接取 `ctx.readWorkspaceFile(...).content` | 该函数返回 `{ok,data}`，取 `.content` 恒为 undefined → **项目 skill 的正文与资源永远是空字符串，且返回 ok:true** | 显式解包并判 `ok`，失败透出桥的 error |
| bridge 对 `{ok:false}` 直接取 `.data.entries` | 抛 TypeError 顶替真实原因，诊断信息变成 `Cannot read properties of undefined` | 失败即 throw，带原始 error |
| 目录不存在被当成扫描错误 | 绝大多数仓库两个根都没有 → 设置面板对每个正常仓库常驻两条「错误」 | 识别为常态，静默返回空 |
| UI 刷新按钮调 `refresh(root)` 不传 bridge | bridge 缺省分支＝「本环境无文件系统」→ **点刷新等于清空已加载的 skills** | 走 `refreshProjectSkills` 命令，命令内部构建 bridge |
| 快照存在 core 私有 Map | UI 无从订阅，重扫完成不重渲染；且 UI 直接 import `defaultCore` 违反 U1 边界 | 快照存 `rootStore.projectSkillsAtom`，UI 只读 atom + 调命令 |
| `ensure` 只在 `runSession` | 其余六个 `runToolLoop` 入口用空快照拼清单 → 同会话相邻请求前缀字节不同，缓存整段作废 | 收进 `runToolLoop`，所有入口统一 |
| 资源键未命中报 `SKILL_NOT_FOUND` | skill 存在、只是资源名写错时谎报 skill 不存在，模型无从自我修正 | 报 `SKILL_RESOURCE_NOT_FOUND` 并列出可读键 |
| frontmatter 围栏逻辑在 core 与 tools 各写一份 | 两处对同一文件可能切在不同位置 | 收口成 `splitFrontmatter`，唯一判定处 |
| `skill_search` 另写一套项目 skills 评分 | 与 registry 的评分常量必然漂移，两类 skill 的排序不再可比 | `searchSkills(query, extra)` 单一实现 |
| YAML scalar 把任意位置的 `#` 当注释 | `description: 修复 #123 的问题` 被截成「修复」 | 遵循 YAML：`#` 前需有空白 |

另外两处非缺陷改进：两个扫描根与各 `SKILL.md` 的读取改为并发（原先串行，32 个 skill 要排 32 个
IPC 往返）；`ensure` 增加 in-flight promise 去重（并发 run 只扫一次）。

#### 真实数据验证（门禁 3/4）

对本仓库真实扫描（`.webAgent/skills/demo` + 已存在的 `.claude/skills/codegraph`）跑通了
L1 清单 → L2 正文 → L3 资源全链路，`diagnostics` 干净。两条 Rust 侧行为经
`cargo test --manifest-path apps/desktop/Cargo.toml` 实测确认，并固化为**跨语言契约测试**
（`workspace_read.rs` 的 `list_returns_workspace_relative_slash_paths_for_nested_skill_dirs`
与 `list_missing_directory_errors_with_not_accessible_text`）：

1. `list_workspace_files` 返回的 `path` 是 workspace 相对、正斜杠、无 `./` 前缀 ——
   loader 的四段判定依赖它。**漂移是静默的**：多一个前缀，项目 skills 会全部消失且不报错。
2. 目录不存在确实报 `is not accessible ... No such file or directory` ——
   `isMissingDirectoryError` 的文本判据依赖它。

真实数据还暴露了一个规格问题（已修）：`codegraph` 的 description 长 200+ 字符，被 160 上限
**截在句子中间且无任何标记**（「…索引未覆盖的文件也」，原文是「也不要用」）。截断点恰好吞掉
「何时不用」的限制条件，模型有把约束读反的风险。Claude Code 生态的 description 普遍是这个
长度，所以这不是个别现象。现在截断会追加 `…`，并回一条 diagnostics 提示作者改短。

边界记录：子 agent 的工具白名单（`subagents/toolProfile.ts`）不含 `skill_read` / `skill_search`，
子 agent 不参与 skills 机制，因此无需为其注入项目清单。

### 阶段 F — 用户级 skills（2026-08-18 落地）

阶段 A–D 只扫工作区，于是 `~/.claude/skills` 里的 skill 一个都进不来——那是多数人真正
积累 skill 的地方。本阶段把同一套目录约定在主目录下再跑一遍，落点见上方「作用域」。

改动面：`skills/projectSkills.ts` 出 `scope` 与 `scanRootLabel`（诊断里 `~/` 前缀是区分
两个同名目录的唯一线索）；快照合成从 `projectSkills.ts` 拆到
`skills/projectSkillsSnapshot.ts`（多扫描根合并是另一件事，且原文件已 400+ 行）；
`ToolContext.skills.resolveProjectPath` 更名 `resolveScannedSkill` 并返回 `rootPath`；
停用偏好正则放宽到两个前缀；主目录解析新增 `runtime/userSkillsRoot.ts`（Tauri）与 CLI 的
`homedir()`。

既有边界没变：路径同样只从扫描快照取（模型永不参与拼路径），读取一律以「该条目自己的根」
为界、不开 `allowExternalPaths`。

#### 被符号链接进来的 skill 目录

`~/.claude/skills/<name> -> 别处` 是 dotfiles 共享 skill 的常见写法（本机 20 个用户 skill 里
5 个如此）。桥的两条真实行为使它原本**静默缺席**，都已固化成跨语言契约测试
（`apps/desktop/src/workspace_read_confinement_tests.rs` 的两个 `linked_skill_dir_*`）：

1. confine 模式下，目标在根外的 symlink 条目**整条不出现在列表里**；
2. 列目录**不递归进 symlink**，即使目标就在根内。

于是 loader 用 `allowExternalPaths: true` **仅列出**两个 skills 目录（多出来的只有「symlink
条目本身可见」这一件事），再把每个 symlink **当它自己的 workspace root** 传回桥——canonicalize
后就是目标目录，目录内文件是根内相对路径，读取不需要任何越界许可。条目因此自带 `rootPath`，
而不是按 scope 去快照上取：被链接进来的那个根既不是 workspace 也不是主目录。

链接指向的目录里没有顶层 `SKILL.md` 时静默跳过（不一定是 skill）；断链、读失败会留诊断——
本机实测 4 个断链因此**第一次变得可见**，此前它们和「没放过这个 skill」无法区分。

CLI 的 Node 桥同步了这两条语义（列出但不跟进 symlink、允许把 symlink 当根），否则同一台机器上
CLI 会比桌面少几个 skill 且无从解释。CLI 宿主的**已知限制**仍在：它没有本机文件读取通路
（`readWorkspaceFile` 只在 Tauri 下可用），所以 CLI 里 L1 清单会列出 `user/*` 与 `project/*`，
但 `skill_read` 读不到正文。这不是本阶段引入的——项目 skills 一直如此，README 也已写明
「CLI 宿主无本机文件工具」。

#### 真实数据验证

以本机 `~/.claude/skills`（20 个目录，其中 5 个符号链接、4 个已断链）+ 本仓库两个项目目录扫描：
20 条进快照（4 条 `project/` + 16 条 `user/`，含唯一一个活链接 `user/einfach-core-engine`，
其 `rootPath` 指向链接目标目录），4 条断链各留一条诊断，其余诊断全是既有的 description 超长提示。

### 阶段 E —（可选）行为 eval

沿用 `evals/deepseek-agent` 的 B04 框架，验证「内置 + 项目 skills 混排」时的命中率与误触率
不劣于纯内置基线。项目 skill 数少时优先级低，可在真实仓库跑出问题后再补。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 仓库经 description 注入 system 前缀 | 用户已选自动加载；靠 `project/` 前缀 + 卫生化 + 上限 + 可观测缓解，信任门留作后续最小改动 |
| 清单 token 膨胀 | description ≤ 160 字符 + skill 数 ≤ 32；超限走 `skill_search` 兜底（机制已存在） |
| 每 run 多一次 IO | 缓存键为 workspaceRoot，命中即同步返回；只有首次绑定/显式刷新走真实 IO |
| 切 workspace 掉缓存 | 归因 `profile_changed`，与改自定义指令同权衡；同 workspace 连续对话 epoch 不动 |
| `.claude/skills` 格式漂移 | 只读 name/description/triggers 三个键，未知键忽略并告警；不跟随其它字段语义 |
| 与 `.webAgent-archive/` 混淆 | 目录职责表 + 本蓝图只覆盖静态预置 skills；governance 流水线不动 |
| 改了文件不生效 | 第一期无文件监听，UI 提供显式刷新；文档写明 |

## 验收门禁（每阶段）

1. `pnpm exec vitest run packages/agent-core/ tools/skills/` 全绿；
2. `pnpm build` 通过；
3. **web 端清单字节零回归**：非 Tauri 下 `buildSkillManifestText()` 输出与实施前逐字相同；
4. 阶段 C 后附 Tauri 实测：一个带 `.webAgent/skills` 的 workspace，确认清单出现项目段、
   `skill_read` 能读到正文与 L3 资源、同 workspace 连续对话 `cache_epoch` 不变。
