# Skills 树形结构与稳定前缀清单蓝图

目标：把 skills 从「平面单文件 + harness 关键词预筛」演进为「树形资源 + 三层渐进披露 +
全量清单进稳定前缀」。本蓝图描述目标形态与实施顺序；引用时需同时核对实现与测试。

## 背景：三个事实

1. **实测缓存数据**（Tauri SQLite trace，185 轮会话）：`cache_epoch` 每轮 +1，原因清一色
   `history_inserted_before_dynamic_tail`。skillContext 每个 run 按最新输入重新匹配、注入在
   动态尾巴，每轮全额 cache miss。customInstructions 已迁入稳定前缀（modelRun.ts
   `stablePrefix`），尾巴里剩下的常驻项只有 skillContext——它是 epoch 无法稳定的最后一个
   结构性原因。
2. **业内对标**（Anthropic Agent Skills 规范 / Claude Code / Cursor Agent-Requested rules）：
   主流形态是三层渐进披露——L1 全量 name+description 常驻稳定前缀（description 写触发条件），
   L2 正文按需加载，L3 skill 内附属资源按正文指引再读。匹配智能在模型侧；harness 检索式预筛
   （LangChain tool-RAG 一类）定位是几百以上工具的海量场景。海量兜底（deferred + search）与
   本仓库 `request_tool_schema` manifest 分页已同构。
3. **现状**（`packages/agent-core/src/skills/registry.ts`）：5 个 skill 各一个 `.md` 经 Vite
   `?raw` 编译期打包，`SkillSource = {name, description, triggers, content}`，无资源树。
   `pickSkillsForInput` 用 triggers 关键词 + planning 启发式正则做 harness 预筛，
   `web-chat-agent` 恒在（名单永不为空）。`skill_read` 入参 `{name}`，返回单一 content。

## 目标形态

```text
清单（L1，全量，稳定前缀）        正文（L2，按需）           资源（L3，按需）
┌──────────────────────────┐   ┌──────────────────┐   ┌─────────────────────┐
│ · planning — 何时用…     │──▶│ skill_read(name) │──▶│ skill_read(name,    │
│ · data-visualization — … │   │ → SKILL 正文     │   │   resource)         │
│ · grid-table — 路由：先读 │   │ （正文里列出可读  │   │ → references/x.md   │
│   我，再选具体子 skill    │   │   资源与子 skill）│   │ → examples/y.md     │
└──────────────────────────┘   └──────────────────┘   └─────────────────────┘
```

- **L1**：全量 skill 清单（name + description）进稳定前缀，字节稳定、位置固定，
  与固定 system、customInstructions 同区。description 承载触发条件（「何时用/何时不用」），
  匹配由模型语义判断完成。
- **L2**：`skill_read(name)` 返回正文（现有行为不变），正文末尾附资源目录。
- **L3**：`skill_read(name, resource)` 返回树内单个资源。资源以相对路径命名
  （`references/palette.md`），正文里自然引用，模型按图索骥。
- **父子路由是内容约定，不是机制**：父 skill（如未来的 `grid-table`）在 description 与正文里
  指路子 skill；机制上父子都是平面清单项。零额外实现成本。
- **triggers 字段降级**：从 harness 匹配数据变为 description 文本的一部分
  （「Use when: …」），供模型阅读；`pickSkillsForInput` 最终退役。

## 数据模型（阶段 1 落地）

```ts
interface SkillSource {
  name: string
  description: string        // 含触发条件；建议 ≤ 160 字符（清单 token 预算）
  triggers: string[]          // 过渡期保留；阶段 3 后仅作为 description 素材
  content: string             // SKILL 正文（?raw 打包）
  resources?: Record<string, string>  // 相对路径 → 内容（?raw 打包）
}
```

- **web 端资源即 Record**：键是逻辑相对路径，值是编译期打包的内容。读取按键精确命中，
  不存在文件系统语义 → 天然免疫路径穿越；未知键返回 `ok:false` 并附可用键列表。
- `skill_read` 入参扩展为 `{name, resource?}`，向后兼容；返回 data 增加
  `resources: string[]`（可读资源目录），让模型无需猜测。
- 治理上限：单资源内容 ≤ 64KB（超限截断并在结果中声明）；单 skill 资源数 ≤ 32；
  清单总 token 预算见「风险与对策」。

## 实施阶段

### 阶段 1 — 树形资源与 L3 读取（纯增量，低风险）

- registry：`SkillSource.resources` + `readSkillResource(name, path)`；
- `tools/skills/skill-read`：`resource` 可选参数、资源目录回传、未知资源错误引导；
- 至少一个现有 skill 试点树形化（候选：`planning` 拆出 evaluator 说明作为
  `references/evaluation.md`），证明「正文引用 → 模型追读」链路；
- colocated 测试：资源读取、未知键、截断、目录回传；`skill_read` 现有用例不回归。
- 不动请求组装、不动 `pickSkillsForInput`。

### 阶段 2 — 行为 eval 门禁（B04/B05，先数据后机制）

在 `evals/deepseek-agent` 行为 A/B 基建上新增（arm 在 eval runner 内手拼 system 模拟，
**不依赖阶段 3 落地**）：

- **B04 清单自判 vs harness 预筛**：arm A = 现状（按输入筛出的名单）；arm B = 全量清单
  （含触发条件式 description）进 system 首部。任务集覆盖「应命中某 skill」与「不应命中」
  两类。判据：skill_read 命中率（该读的读了）、误触率（不该读的读了）、首次命中轮次。
- **B05 树形导航**：任务答案埋在某 skill 的 L3 资源里（正文只给指引）。判据：模型是否
  沿 L1→L2→L3 读到目标资源并在最终回答中使用（标志串机器可判）。
- 教训回写：fixture 不得惩罚正确行为（参见 2026-07-27 首轮 B01 次数门控伪影）；
  n ≥ 20/arm。

**门禁**：B04 显示 DeepSeek 自判命中率不低于 harness 预筛（差距 ≤ 5 个百分点视为通过，
误触率不得显著恶化），才进入阶段 3；否则保留预筛、只交付 L3 树形能力，并在本蓝图记录数据。

### 阶段 3 — 清单迁入稳定前缀（动请求形状，eval 通过后）

- 组装：全量清单进稳定前缀，段序按变更频率排——`[system, skillManifest, customInstructions?]`
  （清单运行期恒定、只随发版变，放在用户可变的自定义指令之前，改指令时清单段缓存仍命中）。
  清单内容仅依赖 registry 注册态——注册变化（新增/删除 skill）触发 `profile_changed` 新 epoch，
  与 customInstructions 同权衡（低频全量 miss 换每轮命中）；
- `buildSkillContextItem` / `pickSkillsForInput` 退役（或降级为 UI 展示用途）；
  动态尾巴中 skillContext 移除——此后尾巴仅剩事件驱动项（planContext / continuationNotice /
  toolFailureNotice），**多数轮次尾巴为空，`cache_epoch` 在纯追加对话中不再每轮 +1**；
- contextCache 观测：skillManifest 并入 systemFingerprint 输入；
- 适配 modelRun / modelTurn / contextCache 测试；trace 验收：Tauri 实测一个多轮会话，
  确认 epoch 仅在事件驱动注入轮次变化。

### 阶段 4 —（可选）Tauri 文件系统 skills 目录

用户自定义 skill 目录（`SKILL.md` + 资源文件），Rust command 加载、真实路径安全
（canonicalize + 根目录约束）、变更时 registry 重注册。独立蓝图另立，此处仅占位。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 清单 token 膨胀 | description ≤ 160 字符；skill 数 > 24 时清单只列 name + 一句话、引导 `skill_search`（机制与 request_tool_schema manifest 同构，已存在） |
| DeepSeek 按 description 自判不足 | 阶段 2 数据门禁挡在前面；不达标则清单照旧进前缀但保留 harness 预筛作为「高亮」提示（两者可叠加），再迭代 description 写法 |
| 新增 skill 打破缓存 | 注册态变化是低频事件；epoch 归因为 profile_changed，观测可解释 |
| L3 资源被滥用塞大文件 | 64KB 截断 + 资源数上限；超预算内容应改为 workspace 文件由 read 工具读取 |
| 与子 agent 管理技能（skillGovernance，`sk_` 前缀）混淆 | 本蓝图只覆盖静态注册 skills；governance 流水线不动，文档互链说明边界 |

## 与现有机制的关系

- `request_tool_schema` manifest 分页：海量工具的发现层，与本蓝图互补，不改动。
- `skill_search` 工具：清单全量化后降级为大规模兜底与 UI 检索，保留。
- TK4（「skill 走 tool、不进 prompt」）：L2/L3 仍严格遵守——进 prompt 的只有清单元数据，
  正文永远经 `skill_read`。TK4 注释在阶段 3 时同步改写。
- 行为 eval 基建（`evals/deepseek-agent/behavior-*`）：阶段 2 直接复用 arm/判据/报告框架。

## 验收门禁（每阶段）

1. `pnpm exec vitest run packages/agent-core/ evals/deepseek-agent/ tools/skills/` 全绿；
2. `pnpm build` 通过；
3. 阶段 2 产出 eval 数据表并回写本蓝图「门禁结论」；
4. 阶段 3 附 Tauri 实测 trace（epoch 稳定性）作为完成证据。

## 门禁结论（随实施回填）

- [x] **B04：通过，且方向反转**（2026-07-27，deepseek-v4-pro，n=20/cell，
  results/2026-07-27T08-15-31.845Z.behavior-ab.jsonl）。组级（4 case 合并，n=80/arm）：
  manifest target_read **100%** / false_read **0%**；prefilter target_read **62.5%** /
  false_read **12.5%**。门禁只要求 manifest 不落后 5pp，实际反超 37.5pp。逐 case 看，
  预筛的劣势是结构性的：hit-semantic（措辞不含触发词）prefilter 0/20 全灭——关键词
  不出现＝技能不存在；miss-adjacent（关键词误导）prefilter 有 10/20 被预筛名单带偏误读，
  manifest 0 误读——预筛名单本身就是一种「暗示该读」。两 arm 在 hit-explicit 与
  miss-unrelated 上打平满分。
- [x] **B05：通过**（同批数据，n=20）。l2_read / l3_read / marker_used 均 20/20，
  平均 3 轮（清单→正文→资源→作答的最短路径）。DeepSeek 三层导航无障碍。

**判定：阶段 3 放行**——全量清单进稳定前缀 + `pickSkillsForInput` 退役按蓝图执行；
无需保留预筛叠加（降级路径未触发）。
