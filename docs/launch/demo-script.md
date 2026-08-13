# CLI Demo 录制脚本

对应 issue 卡 B1。目标：录一段 60–90 秒的终端演示，覆盖一次**真实** `pnpm cli` run（工具调用 +
流式回复），用于发布物料。本文档写清楚选定的场景、复录步骤和踩过的坑，任何人按本文档都应该能
复现出同样的产物。

## 1. 录制目标（卖点）

演示 [`pnpm cli`](../../CLAUDE.md) 这个 headless CLI 宿主的两件事：

1. **工具调用真实发生、可见**：终端里能看到 `[tool] <name> → ok` 这样的调用轨迹，不是把模型输出
   直接当成黑盒文本。
2. **计划（Planning）是一等能力**：让模型自己去读项目内置的 `planning` skill 并复述——顺带展示
   [project skills 的 L1/L2 懒加载机制](../../tools/skills/src/tool-loading.md)（先给摘要，
   需要时再 `request_tool_schema`/`skill_read` 取完整内容），这是"装配式 Agent Runtime"在
   `docs/launch/repo-metadata.md` 里对外宣称的差异化点之一。
3. **流式回复**：`[assistant]` 那段文字是逐字流式追加打出来的，不是一次性甩一大段。

## 2. 选定的提示词与理由

最终选定：

```
pnpm cli -p '用 skill_search 搜索和"计划 planning"相关的 skill，找到后用 skill_read 读取最相关的一个，最后用三四句话中文总结这个项目的计划机制是什么、什么时候该用它。'
```

选择过程试跑了 4 个候选，记录如下（真实跑过，非猜测）：

| # | 提示词方向 | 结果 | 弃用/采用原因 |
| --- | --- | --- | --- |
| 1 | 直接让模型读 `README.md` 开头总结项目 | 模型**拒绝执行**，声称自己没有文件读取工具 | 见下方"重要架构事实"：CLI 里 `read_file` 等 fs/shell 工具的 `runtime: 'server'`，非 Tauri 环境根本不会出现在模型可用工具里（`CLAUDE.md`："`server` 工具在非 Tauri 环境中不会暴露给模型"）。模型的拒绝是**正确行为**，但作为发布 demo 不好看 |
| 2 | 显式点名 `read_file` 工具读 `package.json` | 报 `tool not allowed for child agent: read_file`，模型如实拒绝 | 同上，进一步证实 fs 工具在 CLI 里不可用，排除这条路线 |
| 3 | `skill_search` + `skill_read` 总结"工具懒加载"机制 | 成功：3 行工具调用 + 完整流式中文总结 | 内容合格，但回复里有一句"我通过 `skill_search` 找到了…"，而实际调用轨迹里模型是直接从 `skill_manifest` 摘要跳到 `skill_read`，并没有单独调用 `skill_search`——叙述和实际工具轨迹对不上，不选它 |
| 4（**采用**） | `skill_search` + `skill_read` 总结"计划 planning"机制 | 成功：3 行工具调用 + 结构清晰的两段式中文总结（"是什么" + "什么时候用"），叙述不夸大工具使用 | 内容更贴近产品真实卖点（结构化计划工作流），叙述与工具轨迹一致，实测约 6–9 秒完成，适合控制在 60–90 秒的演示节奏里 |

**重要架构事实（录制/改动前必须知道）**：CLI 是 Node 进程，但标准工具里 `runtime: 'server'` 的
那部分（`tools/fs`、`tools/shell` 全部，见 [`tools/fs/src/read-file/read-file.ts`](../../tools/fs/src/read-file/read-file.ts)
的注释）依赖 `ToolContext.readWorkspaceFile` 等 Tauri 原生桥接，**在非 Tauri 宿主（包括 CLI）里
根本不进模型可见的工具清单**，见 `CLAUDE.md`"`server` 工具在非 Tauri 环境中不会暴露给模型"这句。
所以 CLI demo 不能用"读文件"当卖点，只能用 `runtime: 'internal'` 的工具——`skill_manifest` /
`skill_search` / `skill_read` / planning 五件套 / `delegate_agent` 等。选 planning 主题是因为它
比"工具懒加载"更像一个终端用户会关心的产品能力。

## 3. 逐步复录步骤

1. 确认凭据链路：`~/.webAgent/config.json` 里要有 `modelCredentials["deepseek:default"]`（CLI 默认
   强制要求 DeepSeek key，见 [`apps/cli/src/credentials.ts`](../../apps/cli/src/credentials.ts) 的
   `requireDeepSeekCredential`）。**不要**在任何录制产物或本文档里粘贴 key 本身。
2. **踩坑提醒**：凭据解析顺序是"环境变量优先于配置文件"（同一份 `credentials.ts`）。如果当前
   shell 里残留了 `DEEPSEEK_API_KEY` / `GLM_API_KEY` / `KIMI_API_KEY` 环境变量（哪怕是别的项目
   留下的、已失效的值），会**静默覆盖**掉 `config.json` 里配置好的有效 key，报错表现为
   `Chat completion returned 401 (authentication_error)`，但 `config.json` 本身是好的。
   录制前用 `env | grep -E 'DEEPSEEK_API_KEY|GLM_API_KEY|KIMI_API_KEY'` 检查一遍；如果存在就在
   启动录制的命令前加 `env -u DEEPSEEK_API_KEY -u GLM_API_KEY -u KIMI_API_KEY`，或者直接在一个
   干净的新终端里录。
3. 在仓库根目录（`/Volumes/work/ai/web-agent` 或你本机的对应路径）执行，**必须**加 `< /dev/null`
   （CLI 在 `-p` 单轮模式下不需要 stdin，但非交互 shell 里不显式关闭 stdin 有极小概率挂起）：
   ```bash
   pnpm cli -p '用 skill_search 搜索和"计划 planning"相关的 skill，找到后用 skill_read 读取最相关的一个，最后用三四句话中文总结这个项目的计划机制是什么、什么时候该用它。' < /dev/null
   ```
4. 预期输出结构（真实产出见 [`assets/cli-demo.txt`](assets/cli-demo.txt)）：
   - `[tool] skill_manifest → ok`
   - `[tool] request_tool_schema → ok`
   - `[tool] skill_read → ok`
   - `[assistant] ……`（流式追加，两段中文，覆盖"是什么"与"什么时候用"）
   实测端到端（进程启动到输出完毕）约 6–9 秒；60–90 秒的演示时长通过录制前后各留几秒的"打字/
   读输出"停顿来凑，不需要也不应该在命令本身上做人为拖时间。
5. 用录屏工具封装上一步（选一种）：
   - **asciinema**（推荐，产出 `.cast`，体积小、终端原生重放）：
     ```bash
     asciinema rec docs/launch/assets/cli-demo.cast -c "pnpm cli -p '用 skill_search 搜索和\"计划 planning\"相关的 skill，找到后用 skill_read 读取最相关的一个，最后用三四句话中文总结这个项目的计划机制是什么、什么时候该用它。' < /dev/null"
     ```
     录制开始后等模型完全输出完（约 10 秒），再按 `Ctrl-D` 或等进程自然退出结束录制。
   - **vhs**（产出 `.gif`，适合直接嵌网页/README）：写一个 `docs/launch/assets/cli-demo.tape`：
     ```tape
     Output docs/launch/assets/cli-demo.gif
     Set Shell "zsh"
     Set FontSize 16
     Set Width 1000
     Set Height 560
     Set Theme "Dracula"
     Type "pnpm cli -p '用 skill_search 搜索和\"计划 planning\"相关的 skill，找到后用 skill_read 读取最相关的一个，最后用三四句话中文总结这个项目的计划机制是什么、什么时候该用它。' < /dev/null"
     Sleep 500ms
     Enter
     Sleep 12s
     ```
     然后 `vhs docs/launch/assets/cli-demo.tape`。
6. 录完立刻检查产物：`.cast`/`.gif` 里不能出现任何 key 片段、不能出现 `/Users/<用户名>/` 这类本机
   路径（仓库路径 `/Volumes/work/ai/web-agent` 本身不含用户名，可以出现；但如果你在别的机器上以
   `/Users/xxx/web-agent` 这样的路径工作，pnpm 的脚本 banner 会把这行 cwd 打印出来，见步骤 3 输出
   的头两行——这种情况下要么录制前把仓库软链接/checkout 到不含用户名的路径下工作，要么在文档里
   标注"需要后期从 gif 帧/cast 事件里裁掉这两行 banner"，不要直接发布带用户名路径的产物）。

## 4. 录制工具探测结果（本次执行环境）

在当前沙箱环境里执行探测（未做任何安装动作）：

```
$ command -v asciinema   # 无输出，未安装
$ command -v agg         # 无输出，未安装
$ command -v vhs         # 无输出，未安装
```

三个工具都不存在，且任务边界不允许安装系统软件。因此本次先交付真实运行的干净文本产物
[`assets/cli-demo.txt`](assets/cli-demo.txt)，`.cast`/`.gif` 留给拿到录屏工具的主会话按本文档
第 3 节直接录制——命令、提示词、预期输出都已经固定，不需要重新试错。

安装步骤（macOS，由用户/主会话自行执行，本次未执行）：

```bash
brew install asciinema   # 录制 .cast
brew install agg         # 可选：.cast 转 .gif
brew install vhs         # 另一条路线：直接产出 .gif，写 .tape 脚本驱动
```

## 5. 终端尺寸/主题建议

- 终端宽度建议 100–110 列、24–30 行：中文提示词较长，太窄会在录制里换行两三次，不美观；
  上面这条 prompt 在 100 列下大约折 2 行。
- 字号建议 14–16pt，暗色主题（如 Dracula / One Dark），和仓库其它发布物料（如有）保持深色调一致。
- 如果用 vhs，`Set Width`/`Set Height` 用像素（示例给了 1000x560，对应约 100 列×26 行等宽字体）。

## 6. 产物文件清单

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `docs/launch/demo-script.md` | 本次产出 | 本文档 |
| `docs/launch/assets/cli-demo.txt` | 本次产出 | 录屏工具缺失时的过渡产物：真实 `pnpm cli` run 的干净输出（已核对无 key、无用户名路径） |
| `docs/launch/assets/cli-demo.cast` | 待录（工具缺失） | 按第 3 节步骤 5 的 asciinema 命令录制 |
| `docs/launch/assets/cli-demo.gif` | 待录（工具缺失，二选一） | asciinema→agg 转出，或直接用 vhs 的 `.tape` 产出 |
