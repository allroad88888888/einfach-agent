# 030 执行报告：读取受限工作区图片

## 改动摘要

- 新增 Node host 命令 `read_workspace_image`，只接受显式 `path`，复用现有 workspace root、realpath/symlink confinement 与 `allow_external_paths` 规则。
- 新增有界增量读取：默认及硬上限均为 20 MiB；读取前检查文件大小，读取时最多保留 `limit + 1` 字节，防止检查后文件增长绕过限制。
- 只按魔数接受 JPEG、PNG、WebP，扩展名不参与信任判断；返回仅含规范 MIME、base64、原始请求文件名与 byte size，不提供任意二进制读取命令。
- 新增 core `readWorkspaceImage` host bridge，严格收窄 MIME、base64 语法与解码后大小，并公开 `WorkspaceImageReadInput` / `WorkspaceImageReadResult`。
- 在 `ToolContext` 接入 `readWorkspaceImage?`，完整复用 `withWorkspaceReadAccess`、调用前后 stale/abort 守卫与进度上报；非 Auto 会话会剥离调用方伪造的外部路径权限，Auto 权限只由会话状态注入。
- 为实际命令注册面补充必要接线：`commandNames.ts`、`commandArgs.ts`、`workspace/read/index.ts`、根导出及命令注册测试。未改动任意二进制通道或通用文本读取实现。

## 验收命令与结果

1. `pnpm exec vitest run packages/host-node/src/**/*workspace*image*.test.ts packages/agent-core/src/runtime/**/*workspace*image*.test.ts`
   - 通过：3 个测试文件，17 项测试全部通过。
   - 覆盖：JPEG/PNG/WebP 魔数、与扩展名解耦、伪扩展名拒绝、workspace/symlink 越界、Auto 外部只读、默认/自定义/全局大小上限、host 响应收窄、命令参数映射、调用前取消、调用中取消后的迟到结果丢弃。

2. `pnpm exec tsc -b packages/host-node/tsconfig.json packages/agent-core/tsconfig.json`
   - 未通过，但只剩共享 worktree 前置错误：`tools/agents`、`tools/fs`、`tools/interaction`、`tools/planning`、`tools/shell`、`tools/skills` 的多处 `*.md?raw` import 报 `TS2307`。
   - 输出中没有 `packages/host-node` 或 `packages/agent-core` 的本任务类型错误。
   - 辅助隔离验证通过：
     - `pnpm exec tsc -p packages/host-node/tsconfig.json --types vite/client,node` → exit 0。
     - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types vite/client,node` → exit 0。

3. `wc -l packages/agent-core/src/runtime/workspaceImageRead.ts packages/host-node/src/workspace/*image*.ts`
   - 通过：core 实现 95 行；host 测试 100 行；host 实现 124 行；均不超过 300 行。

4. `git diff --check -- packages/host-node packages/agent-core`
   - 通过：无空白错误。

5. 额外接线回归：`pnpm exec vitest run packages/host-node/src/commandNames.test.ts packages/host-node/src/createNodeHostInvoke.test.ts`
   - 通过：2 个测试文件，11 项测试全部通过。

## 已完成覆盖矩阵行及证据

- `C-004`：工作区图片安全读取——完成。
  - 路径边界证据：host 测试拒绝真实 symlink 逃逸，错误不包含根外 canonical target；显式 `allow_external_paths: true` 才允许根外读取。
  - 类型边界证据：三类合法魔数通过，伪 `.png` 拒绝；core 对 `application/octet-stream`、非法 base64、size 不一致均拒绝。
  - 资源边界证据：20 MiB 稀疏文件超限测试与自定义 `max_bytes` 超限测试通过；实现采用上限内增量读取。
  - 生命周期证据：ToolContext 在调用前 abort 时不触发 host bridge，在调用中 abort 时通过后置 `assertFresh` 丢弃迟到 payload。
  - 注册证据：命令全集与 `createNodeHostInvoke` 接线测试通过，模型侧没有可调用的通用二进制命令。

## 未验证项

- 正式 `tsc -b` 总命令未能得到全绿结果，受范围外 `*.md?raw` 声明/构建图问题阻塞；本任务两个 package 已用等价声明加载方式分别通过类型检查。
- 未做真实网络、发布、push、提交或跨平台 Windows 文件系统测试；任务不授权这些动作。

## 范围外发现

- 任务 files 中的 `packages/host-node/src/commands/**` 在当前仓库不存在。实际静态注册入口是：
  - `packages/host-node/src/commandNames.ts`
  - `packages/host-node/src/commandArgs.ts`
  - `packages/host-node/src/commandNames.test.ts`
  - `packages/host-node/src/createNodeHostInvoke.test.ts`
  编排者已明确将这些路径扩入边界；本次只为 `read_workspace_image` 做必要接线。
- 任务 files 中的 `packages/agent-core/src/runtime/hostCommandBridge.ts` 不存在；现有中立桥为 `runtime/hostBridge.ts`，新能力通过它调用，无需修改该文件。
- `packages/agent-core/src/tools/types.ts` 在本次修改前已有 309 行，现为 328 行。本次是在任务明确指定的 canonical ToolContext 契约文件内做小改；按规则未顺手进行范围外公共类型拆分。其他新增/改动普通文件均未超过 300 行。
- 工作区内 `packages/host-node/src/workspace/dialog/` 等未跟踪内容属于并行在途改动，本任务未触碰。

## 疑虑

- 正式类型总门仍为红色，尽管错误与本任务无关；合并前应由拥有工具包构建图的任务修复或确认 `*.md?raw` 声明加载方式。
- HostInvoke 协议不承载 `AbortSignal`，因此取消语义是“不启动已取消读取、丢弃读取中的迟到结果”；底层已开始的 Node 文件读取不会被主动中止，但受 20 MiB 硬上限约束。

## 建议后续动作

1. 修复工具包 `*.md?raw` ambient declaration 在 `tsc -b` 构建图中的加载，再复跑正式类型总门。
2. 在后续 050 视觉 runtime 中仅消费 `ToolContext.readWorkspaceImage`，不要绕过该能力直接调用 host 命令或暴露 base64 通用读取入口。
3. 将 `tools/types.ts` 的存量超限拆分作为独立文件组织任务处理，避免在本叶子扩大公共契约重构面。

## R1 修复记录

### 修复摘要

- I-1（TOCTOU）已修复：
  - POSIX 打开实际文件时使用 `O_RDONLY | O_NOFOLLOW`，阻止最终路径分量在 resolve 后被替换成 symlink 并被跟随。
  - 所有目标平台在打开后都用 bigint `fstat(handle).dev/ino` 与重新解析、重新执行 confinement 后的当前路径对象 `stat.dev/ino` 做精确身份复核。
  - 身份与边界复核通过后只从已验证的 `FileHandle` 读取；后续路径再被替换不会改变读取对象。
  - 可控竞态测试覆盖 resolve 后换为外部 symlink，以及打开后把路径换成 root 内另一 inode；后者直接证明 handle/path 身份不一致会被拒绝。
- I-2（错误路径泄漏）已修复：open、handle 身份复核与 read 失败都返回不含底层异常文本或 canonical 路径的稳定错误。测试覆盖 Auto 外部 symlink 在 open 前目标消失，以及已验证 handle 在 read 前失效，两条错误均不包含外部目标路径。
- M-1（core 远程 host 复核）已修复：core 现在拒绝 `sizeBytes > min(maxBytes ?? 20 MiB, 20 MiB)`，在大小与严格 base64 校验后仅解码前 12 字节所需前缀，重新识别 JPEG/PNG/WebP 魔数并要求与声明 MIME 完全一致。

### Race closure 与跨平台行为

- macOS/Linux 等 POSIX 平台是两层防护：`O_NOFOLLOW` 先拒绝最终 symlink 竞态，打开后的 bigint handle/path 身份与 confinement 复核再覆盖父目录替换、打开后路径替换等情况。
- Windows 不依赖不可移植的 `O_NOFOLLOW`；普通只读打开后，通过同一套重新 confinement 与 bigint `dev/ino` 身份复核确认实际 handle 就是当前已批准路径对象。复核之后读取只走 handle，不再按字符串重开。
- 打开后 inode 替换的确定性回归依赖 POSIX 允许重命名已打开文件，因此在 Windows 条件跳过；Windows 代码路径仍由目标包 TypeScript 检查覆盖，本轮未在 Windows 主机实际运行文件系统竞态测试。

### R1 验收命令与结果

1. `pnpm exec vitest run packages/host-node/src/**/*workspace*image*.test.ts packages/agent-core/src/runtime/**/*workspace*image*.test.ts`
   - 通过：3 个测试文件，27 项测试全部通过。
   - R1 新增证据：resolve→open symlink 竞态、open 后 inode 身份漂移、Auto 外链 open/read 错误脱敏、core custom/global 大小上限、PNG/JPEG/WebP 正向魔数与 MIME/魔数错配拒绝。

2. `pnpm exec tsc -b packages/host-node/tsconfig.json packages/agent-core/tsconfig.json`
   - 结果与首轮相同：仅范围外 `tools/*` 的 `*.md?raw` import 报 `TS2307`，没有本任务路径错误。
   - R1 辅助隔离验证：
     - `pnpm exec tsc -p packages/host-node/tsconfig.json --types vite/client,node` → exit 0。
     - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types vite/client,node` → exit 0。

3. `wc -l packages/agent-core/src/runtime/workspaceImageRead.ts packages/host-node/src/workspace/*image*.ts`
   - 通过：core 实现 129 行；host 测试 177 行；host 实现 158 行；均不超过 300 行。

4. `git diff --check -- packages/host-node packages/agent-core`
   - 通过：无空白错误。

5. `pnpm exec vitest run packages/host-node/src/commandNames.test.ts packages/host-node/src/createNodeHostInvoke.test.ts`
   - 通过：2 个测试文件，11 项测试全部通过。

### R1 覆盖矩阵结论

- `C-004`：完成，待独立复审。
  - 路径禁闭已绑定到实际打开 handle，而非只信任 open 前的 canonical 字符串。
  - 所有 post-resolve 文件系统失败使用稳定脱敏错误。
  - Node host 与 core 两侧都限制 20 MiB/调用方上限并复核三类图片魔数，custom/remote host 不能把任意二进制或超大 payload 冒充图片。

### R1 未验证项与疑虑

- 未在 Windows 主机实跑竞态文件系统测试；Windows 采用打开后 confinement + handle/path identity 复核，不使用 `O_NOFOLLOW`。
- 正式 `tsc -b` 仍受范围外 `*.md?raw` 构建图问题阻塞；两个目标包的 R1 类型检查已分别通过。
- 原报告所列 HostInvoke 无主动 I/O abort、`tools/types.ts` 存量超限与其他范围外发现保持不变。

## R2 修复记录

### 剩余 I-1 修复

- 删除 R1 `verifyOpenedImage` 中对用户 pathname 的二次 `resolveExistingWorkspacePath` 与 `stat`。打开后不再用 pathname realpath/stat 证明 handle confinement。
- 新增 `workspace-image-handle-path.ts`，唯一职责是按平台从已打开 numeric fd 解析最终 vnode 路径：
  - Linux：只对 `/proc/self/fd/<numeric fd>` 调用 `realpath`。
  - macOS：只以 `execFile`（`shell:false`）执行固定 `/usr/sbin/lsof`，参数固定为 `-a -p <process.pid> -d <numeric fd> -Fn`；pid/fd 必须是安全整数。
  - 其他平台明确 fail-closed，不开放图片读取能力。
- `verifyOpenedImage` 现在只取得 `fstat(handle)` 与 handle resolver 的最终绝对路径；非 Auto 用 canonical workspace root 对该 handle 路径做分量边界判断，Auto 可跳过 root confinement。校验后继续只从原 handle 读取。
- resolver 查询失败、命令缺失/超时、stderr、deleted、相对路径、额外/重复记录、pid/fd 不匹配、反斜杠转义均收敛为固定 `cannot verify opened image path`；图片命令再收敛为固定 `requested image changed during access`，不会返回 `lsof` 错误或真实路径。

### Race closure

- 初始 pathname resolve 仅用于选取要打开的候选，不再被当作打开后安全证明。
- 打开后的 confinement 事实直接来自 fd：Linux `/proc/self/fd/N` 指向当前进程已打开对象；macOS `lsof` 查询固定 pid/fd 对应 vnode name。父目录在初始 resolve、open 或其后如何切换，都没有第二次 pathname lookup 可被攻击者配对操纵。
- resolver 返回外部 handle path 时，即使最初 pathname 仍在 workspace 内也会拒绝；返回内部 handle path 时读取原 handle。测试用注入 resolver 对这两条做确定性覆盖。
- `allowExternalPaths:true` 仍要求平台能够可靠解析 handle 路径，只跳过 root containment；图片魔数、大小、错误脱敏、stale/abort 与 core payload 二次复核均保持不变。

### macOS `lsof` 严格协议

- 输出必须恰好三行且唯一匹配：`p<当前 pid>`、`f<当前 fd>`、`n<绝对路径>`，只允许末尾一个换行。
- 实机探针证明包含换行的文件名被 `lsof -Fn` 编码为字面 `\\n`；解析器拒绝所有反斜杠转义，因此多行/控制字符文件名不会被误当作可验证路径。
- 固定 executable、固定标志、数字 pid/fd、无 shell、64 KiB 输出上限、2 秒超时；任何 stderr 或非零失败均 fail-closed。
- 当前 macOS 环境真实打开文件的正向测试通过，解析路径与 `realpath(file)` 一致。

### R2 验收命令与结果

1. `pnpm exec vitest run packages/host-node/src/**/*workspace*image*.test.ts packages/agent-core/src/runtime/**/*workspace*image*.test.ts`
   - 通过：4 个测试文件，47 项测试全部通过。
   - R2 新增证据：Linux `/proc/self/fd` 固定路径、deleted/相对/查询失败拒绝；macOS 固定命令参数、唯一记录解析、模糊/转义/deleted/命令失败拒绝；unsupported platform fail-closed；真实 macOS fd 正向解析；图片读取对外部/内部 handle path 的确定性拒绝/通过。

2. `pnpm exec tsc -b packages/host-node/tsconfig.json packages/agent-core/tsconfig.json`
   - 仍只报范围外 `tools/*` 的 `*.md?raw` `TS2307`，没有本任务路径错误。
   - R2 辅助隔离验证：
     - `pnpm exec tsc -p packages/host-node/tsconfig.json --types vite/client,node` → exit 0。
     - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types vite/client,node` → exit 0。

3. `wc -l packages/agent-core/src/runtime/workspaceImageRead.ts packages/host-node/src/workspace/*image*.ts`
   - 通过：core 129 行；handle resolver 测试 111 行；handle resolver 74 行；host 读取测试 182 行；host 读取实现 157 行；全部不超过 300 行。

4. `git diff --check -- packages/host-node packages/agent-core`
   - 通过：无空白错误。

5. `pnpm exec vitest run packages/host-node/src/commandNames.test.ts packages/host-node/src/createNodeHostInvoke.test.ts`
   - 通过：2 个测试文件，11 项测试全部通过。

### R2 覆盖矩阵结论

- `C-004`：完成，待 R2 独立复审。
- 剩余 I-1 已闭合：confinement 只依据实际打开 fd 的最终路径，不存在 pathname 二次 resolve→stat 窗口。
- R1 已完成的稳定错误脱敏和 core 大小/魔数复核保持通过。

### R2 未验证项与疑虑

- Linux `/proc/self/fd` 分支通过注入的协议测试，当前执行主机是 macOS，未在 Linux 主机运行真实 fd 正向测试。
- Windows/其他平台按设计 fail-closed；不提供不可靠的 fallback。
- 正式 `tsc -b` 继续受范围外 `*.md?raw` 构建图问题阻塞；两个目标包分别类型检查通过。

## R3 修复记录

### R2-I-2 修复

- 新增单一职责 `workspace-image-open.ts`，集中负责平台守卫、安全打开与原 handle 的普通文件校验；该内部模块未从 package 根导出，也没有给产品命令增加测试参数或外部后门。
- 在调用任何 pathname `open` 前只允许 `linux` / `darwin`；其他平台固定拒绝为 `workspace image reads are unavailable on this platform`。依赖注入单测证明 unsupported platform 下底层 `open` 调用次数为 0。
- Linux/macOS 打开 flags 固定为 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`。保留 POSIX 最终分量 no-follow，并确保只读 FIFO 在没有 writer 时不会阻塞打开。
- 打开后首先对原 `FileHandle` 执行 bigint `fstat` 并严格要求 `isFile()`；FIFO、socket、device、directory 均收敛为固定 `requested image is not a file`，handle 在拒绝路径中关闭。只有 regular file 才继续既有 fd-bound handle path confinement，随后仍只从同一个原 handle 读取。
- 新增真实命名管道回归：在临时 workspace 用 `/usr/bin/mkfifo` 创建 FIFO，不启动 writer，完整调用 `readWorkspaceImage` 必须在 750ms 内拒绝；同时断言 handle-path resolver 未调用、错误精确稳定且不含 FIFO 路径。若旧实现回归为阻塞 open，测试失败分支会用本进程临时 `O_RDWR | O_NONBLOCK` handle 解阻并立即关闭，不残留外部进程，临时工作区随后照常清理。
- R2 已通过的 fd-bound confinement、稳定错误脱敏与 core payload 大小/魔数复核未重写，行为保持不变。

### R3 验收命令与结果

1. `pnpm exec vitest run packages/host-node/src/**/*workspace*image*.test.ts packages/agent-core/src/runtime/**/*workspace*image*.test.ts`
   - 通过：5 个测试文件，57 项测试全部通过。
   - R3 新增证据：unsupported platform 在 pathname open 前拒绝且 `open` 未调用；Linux/macOS flags 同时包含 `O_NOFOLLOW` / `O_NONBLOCK`；原 handle `fstat` 对 FIFO/socket/device/directory 严格拒绝；真实 FIFO/no-writer 在 750ms 保护内有界拒绝。

2. `pnpm exec tsc -b packages/host-node/tsconfig.json packages/agent-core/tsconfig.json`
   - exit 2；仍仅报范围外 `tools/agents`、`tools/fs`、`tools/interaction`、`tools/planning`、`tools/shell`、`tools/skills` 的 `*.md?raw` import `TS2307`，没有本任务路径错误。
   - R3 隔离验证：
     - `pnpm exec tsc -p packages/host-node/tsconfig.json --types vite/client,node` → exit 0。
     - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types vite/client,node` → exit 0。

3. `wc -l packages/host-node/src/workspace/*workspace-image*.ts packages/agent-core/src/runtime/*workspace*image*.ts`
   - 通过：opener 58 行 / opener 测试 79 行；host 读取 144 行 / 测试 235 行；handle resolver 74 行 / 测试 111 行；core 读取 129 行 / 测试 120 行；ToolContext 测试 87 行。全部普通文件不超过 300 行。

4. `git diff --check -- packages/host-node packages/agent-core`
   - exit 0，无空白错误；R3 新增/未跟踪文件另逐一执行 `git diff --no-index --check /dev/null <file>`，均无 whitespace diagnostics（仅以 exit 1 表示存在内容差异）。

5. `pnpm exec vitest run packages/host-node/src/commandNames.test.ts packages/host-node/src/createNodeHostInvoke.test.ts`
   - 通过：2 个测试文件，11 项测试全部通过。

### R3 覆盖矩阵结论

- `C-004`：完成，待 R3 独立复审。
- `R2-I-2` 已闭合：支持平台不会因 FIFO/no-writer 阻塞；不支持平台在 open 前 fail-closed；所有已打开的非 regular filesystem object 都在 handle-path 查询和字节读取前被拒绝。
- 正式 `tsc -b` 的范围外 `*.md?raw` 前置错误、Linux 真实 fd 未在当前 macOS 主机实跑、`tools/types.ts` 存量超限债务保持为既有疑虑。
