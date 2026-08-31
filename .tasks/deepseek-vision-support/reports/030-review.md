# 030 独立审查：读取受限工作区图片

## 结论

**REJECTED**。机械验收记录与静态接线基本完整，但 C-004 的路径禁闭仍存在可利用的 check-then-open 竞态；此外，“错误不泄漏 workspace 外真实路径”在失败打开分支没有闭合证据。当前实现不能判定为安全完成。

本审查只依据任务文件、执行报告、指定基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 的范围 diff，以及 5 个未跟踪实现/测试文件各自的 `git diff --no-index /dev/null <file>`。按要求没有重跑报告声称已跑的测试。

## 验收标准逐条判定

1. ✅ 图片测试命令：执行报告记录 3 个测试文件、17 项测试通过。静态测试内容对应正常 JPEG/PNG/WebP、魔数与扩展名解耦、伪扩展名、静态 symlink 越界、20 MiB/自定义上限、host 响应收窄，以及调用前/调用中取消。按审查指令未重跑。
2. ✅ TypeScript：正式 `tsc -b` 未全绿，但报告将剩余错误明确限定为共享 worktree 的 `*.md?raw` `TS2307`，并记录两个目标 package 分别隔离检查为 exit 0；这符合验收标准允许的“只剩明确记录的共享前置错误”。⚠️ 原始编译输出不在允许审查材料中，无法再独立核实错误全集。
3. ✅ 文件行数：独立 `wc -l` 显示 `agent-core/src/runtime/workspaceImageRead.ts` 95 行、host 实现 124 行、host 测试 100 行；相关新增 core 测试分别 64/87 行，均低于 300 行。新增文件职责也分别集中在 host 受限读取、core bridge 与对应场景测试。
4. ✅ 空白检查：执行报告记录 `git diff --check -- packages/host-node packages/agent-core` 通过；所审范围 diff 未见相反证据。

机械验收通过不覆盖下面的路径竞态，因此不等于 C-004 安全语义通过。

## C-004 核对

| 检查点 | 判定 | 证据 |
|---|---|---|
| 仍是图片专用读取，不是显式任意二进制命令 | ✅ | host 只注册 `read_workspace_image`；`detectMimeType` 只接受 JPEG/PNG/WebP 魔数，core MIME 联合也只有三类。范围 diff 没有新增通用 binary-read 命令。 |
| workspace root 与 Auto 外部只读权限 | ✅（非竞态路径） | `workspaceCapabilities.ts` 用 `withWorkspaceReadAccess(input)` 注入权限；测试证明 Auto 强制注入 `allowExternalPaths: true`，非 Auto 会剥离调用方伪造值。 |
| symlink/路径越界 | ❌ | 静态 symlink 逃逸测试通过，但 host 在 `workspace-image-read.ts:92-96` 校验后才按路径重新打开，存在竞态绕过，详见 I-1。 |
| 依据魔数而非扩展名 | ✅ | `workspace-image-read.ts:38-52` 检测 JPEG/PNG/WebP 头；测试用 `.bin/.data/.raw` 成功、伪 `.png` 失败。 |
| 20 MiB 与自定义上限 | ✅（host） | `MAX_WORKSPACE_IMAGE_BYTES` 为 `20 * 1024 * 1024`；`imageReadLimit` 拒绝非正安全整数和更高值；先 `stat`，随后最多读取 `limit + 1` 字节，可发现检查后增长。 |
| base64/MIME/filename/size | ✅（正常 host 路径） | host 返回 `bytes.toString('base64')`、规范 MIME、`basename(requested)`、实际 `byteLength`；core 校验 MIME、严格 base64 语法及解码长度与 `sizeBytes` 一致。 |
| stale/abort | ✅ | ToolContext 调用前后均 `assertFresh()`；测试覆盖预先 abort 不调用 host，以及读取中 abort 后丢弃迟到结果。底层 I/O 不主动取消，报告已准确披露。 |
| host 命令名/args/invoke 接线 | ✅ | `commandNames.ts` 登记名称，`commandArgs.ts` 登记 snake_case 参数，`workspace/read/index.ts` 登记 handler；`createNodeHostInvoke.test.ts` 的实现全集包含该命令，报告记录该回归测试通过。core bridge 使用相同命令名并由 package index 导出。 |

**C-004：❌ 未完成。** 静态路径检查成立，但安全边界在并发路径替换下不成立。

## 质量发现

### Critical

无。

### Important

#### I-1：路径禁闭与文件打开不是同一个原子操作，可竞态读取 workspace 外图片

- 精确位置：`packages/host-node/src/workspace/workspace-image-read.ts:92-96`；打开函数位于 `:55-60`。
- 当前顺序是先 `resolveExistingWorkspacePath(...)` 得到字符串 `absolutePath`，再 `open(absolutePath, 'r')`。打开时没有 `O_NOFOLLOW`，也没有基于已打开 handle 的身份/归属复核。
- 反例：准备 workspace 内合法 `photo.png`；让另一个本地进程在路径校验返回后、`open` 前反复把 `photo.png` 换成指向 `/outside/secret.png` 的 symlink。Node 的普通 `open(..., 'r')` 会跟随新 symlink，于是外部 JPEG/PNG/WebP（不超过 20 MiB）会被读取并返回。现有静态 symlink 测试不能覆盖这个时序。
- 影响：非 Auto 会话也可能绕过 workspace root，只是读取面仍受图片魔数和大小限制；这直接违反 C-004 的 symlink/路径越界目标。
- 修复要求：把禁闭判断绑定到实际打开的对象；采用平台可用的 no-follow/handle 身份校验方案，并在打开后确认同一对象仍位于已批准 root，随后只从该 handle 读取。补充可控竞态回归测试。

#### I-2：失败打开分支未证明会清除已解析的 workspace 外真实路径

- 精确位置：`packages/host-node/src/workspace/workspace-image-read.ts:55-60` 与 `:70-77`。
- `openImage`/`readBounded` 把底层错误经 `errorText(error)` 原样拼入对外错误；调用 `openImage` 的参数是解析后的 `absolutePath`。Node 文件系统错误通常携带被打开的绝对路径，而本文件没有做路径替换或错误码白名单化。
- 反例：Auto 允许外部读取时，请求 workspace 内指向外部图片的相对 symlink；在 `realpath` 成功后令外部目标消失或变为不可读，`open` 失败信息可能带出 canonical 外部路径，而调用方原本只知道 symlink 名。
- 现有“不泄漏”测试只覆盖 `allow_external_paths` 为 false 时 helper 直接拒绝静态 symlink 的分支，没有覆盖解析成功后的 open/read 错误。由于 `errorText` 实现不在允许审查 diff 中，其是否另有全局脱敏属于 ⚠️无法核实；当前范围证据不足以满足任务的明确无泄漏保证。
- 修复要求：对外只返回稳定、与 canonical 路径无关的错误；内部诊断若需要完整错误，应走不返回给模型的日志通道。补充 Auto 外部 symlink 在 open/read 失败时的无泄漏测试。

### Minor

#### M-1：core 对 host payload 的“受限”复核不含大小上限或字节魔数

`packages/agent-core/src/runtime/workspaceImageRead.ts:48-78` 只核对 MIME 枚举、base64 语法和长度一致性。一个不符合契约的 custom/remote host 可返回任意大内容，或把任意字节标成 `image/png`，core 仍接受。正常 Node host 已做限制，因此这不是当前主路径的直接越界，但测试名“拒绝扩成任意二进制通道”覆盖得比实际保证更宽。建议 core 至少复核 `sizeBytes <= min(maxBytes ?? 20 MiB, 20 MiB)`，并对解码前缀复核魔数。

#### M-2：存量公共类型文件仍超出普通文件上限

`packages/agent-core/src/tools/types.ts` 当前 328 行；报告说明修改前已有 309 行，本任务仅为 canonical `ToolContext` 契约追加 19 行，符合“路过存量超限文件只指出、不顺手重构”的例外处理。它不单独阻断本叶子，但应作为后续独立拆分债务。

## 范围与无法核实项

- ⚠️ `resolveExistingWorkspacePath`、`resolveWorkspaceRoot`、`withWorkspaceReadAccess` 的既有实现不在指定 diff 中；本审查只能依据调用点、任务新增测试与执行报告判断其非竞态行为。尤其直接 `../` 穿越的 task-specific 新测试未出现在材料中，既有 helper 的该项行为无法重新核实。
- ⚠️ 同一范围 diff 混有目录选择、model connection profile、history/model settings 等并行改动；它们不属于 C-004，本审查未把这些并行功能的正确性计入 030 结论。
- ⚠️ `packages/agent-core/src/runtime/hostCommandBridge.ts` 与 `packages/host-node/src/commands/**` 在报告中注明当前不存在；实际接线分别走 `hostBridge.ts` 和 `workspace/read/index.ts`。允许材料中的名称、参数、registrar 与 invoke 回归证据已闭合。

## 最终判定

**REJECTED**：先修复 I-1，并闭合 I-2 的错误脱敏证据后，才可将 C-004 标为完成；其余四条机械验收标准可保留为通过。

---

## R1 独立复审（2026-08-21）

### R1 结论

**REJECTED**。I-2 的稳定错误脱敏与 M-1 的 core 二次限制已经闭合；I-1 只消除了最终路径分量的一次 symlink 替换和普通 inode 漂移，仍未把“confinement 判断”与“实际打开 handle 的身份”原子绑定。所有平台仍存在第二个 check-then-stat 竞态，C-004 继续为 ❌。

本节保留首轮结论，仅依据更新后的任务/执行报告、原审查、同一基线范围 diff 与当前未跟踪文件的 no-index diff。按要求没有重跑报告声称已跑的测试。

### R1 指定项核对

| 项目 | 判定 | R1 证据 |
|---|---|---|
| I-1 no-follow / handle identity / confinement | ❌ | POSIX `O_NOFOLLOW` 只保护最终路径分量；`verifyOpenedImage` 又先重新 resolve/confinement、后按字符串 `stat`，两步仍可观察到不同目录状态。详见 R1-I-1。 |
| I-2 稳定错误且不带 canonical 路径 | ✅ | `openImage`、`verifyOpenedImage`、`readBounded` 分别只返回固定文本，不再拼接底层异常；新增测试覆盖 Auto 外链目标在 open 前消失及已开 handle 在 read 前失效，两者断言精确稳定错误且不含外部路径。初始静态越界仍由原 symlink 测试覆盖。 |
| M-1 core 按调用上限/20 MiB 复核 size 与字节魔数 | ✅ | `effectiveSizeLimit` 取 `min(maxBytes ?? 20 MiB, 20 MiB)`；`normalizeResult` 在严格 base64 长度一致后用解码前缀识别 JPEG/PNG/WebP，并要求与声明 MIME 相等。测试覆盖调用上限、全局上限、任意字节、MIME/魔数错配及三类正向 payload。 |
| 新增确定性竞态/身份测试 | ❌（部分） | `afterResolve` 的单次最终 symlink 替换与 `afterOpen` 的单次不同 inode 替换是确定性的，但没有覆盖重新 confinement 与 `stat(current.absolutePath)` 之间再次切换路径的反例；因此不能证明竞态完全闭合。 |
| 既有 C-004 证据 | ✅（除路径竞态） | 27 项测试通过记录继续覆盖魔数、扩展名解耦、静态越界、大小、Auto 权限、payload、stale/abort 和命令接线；本轮未重跑。R1 文件行数实测为 host 158/测试 177、core 129/测试 120，均低于 300 行且职责集中。 |

### R1 质量发现

#### Critical

无。

#### Important

##### R1-I-1：身份复核自身仍是 check-then-stat，父目录切换可让外部 handle 通过

- 精确位置：`packages/host-node/src/workspace/workspace-image-read.ts:79-97`，调用顺序位于 `:126-137`。
- `verifyOpenedImage` 先调用 `resolveExistingWorkspacePath(root, approvedPath, ...)` 做第二次 confinement，随后才调用 `stat(current.absolutePath)`，最后把这个 pathname stat 的 `dev/ino` 与已打开 handle 比较。第二次 confinement 与 pathname stat 仍不是同一原子操作；`stat` 也会跟随 symlink/被替换的父目录。
- POSIX 反例：
  1. 初始 resolve 时 `/workspace/dir/image.png` 是合法内部文件。
  2. resolve 后把 `dir` 换成指向 `/outside/dir` 的 symlink；最终分量 `image.png` 在外部目录中仍是普通文件，因此 `O_NOFOLLOW` 不阻止 open，handle 打开外部图片。
  3. `verifyOpenedImage` 的第二次 resolve 前暂时恢复内部 `dir`，使 confinement 通过并返回内部 pathname。
  4. 在该 resolve 返回后、`stat(current.absolutePath)` 前再次把 `dir` 换回外部 symlink；`stat` 跟随父目录并取得与已打开外部 handle 相同的 `dev/ino`，身份比较通过，随后从外部 handle 读取。
- Windows 也存在同一反例，并且没有 `O_NOFOLLOW` 这一层；报告所述“所有平台重新 confinement + dev/ino”没有消除 resolve 与 stat 之间的窗口。是否在 Windows 主机上具有完全相同的重命名/共享细节仍属 ⚠️未实跑，但算法层面的非原子性不依赖 Windows 测试结果才能成立。
- 当前两项新增竞态测试均无法反驳此反例：`afterResolve` 只切换一次，所以 POSIX 被最终分量 `O_NOFOLLOW` 拦截、Windows 被持续存在的外链 confinement 拒绝；`afterOpen` 只换成不同 inode，所以必然 mismatch。测试没有在第二次 resolve 与 stat 之间进行第二次切换。
- 修复要求：使用能把路径解析限制和打开对象绑定为一个安全操作的平台原语，或从已打开 handle 获得并验证不可伪造的最终路径/文件标识；仅对 pathname 重做 `realpath/stat` 无法证明竞态安全。POSIX 需覆盖所有路径分量（不只是最终分量），Windows 需使用 reparse-point/handle 语义等价的实现。无法在某平台提供该保证时，应在该平台拒绝该能力，而不是以非原子复核宣称闭合。补充能够控制第二次 confinement→stat 窗口的确定性测试。

#### Minor

无新增 Minor。首轮 M-1 已关闭；M-2（`tools/types.ts` 存量 328 行）保持为非阻断债务。

### R1 C-004 判定

- 图片专用命令、JPEG/PNG/WebP 魔数、host/core 双侧 20 MiB 与调用方上限、base64/MIME/filename/size、Auto 权限注入、stale/abort、命令名/参数/registrar/invoke 接线：✅。
- 稳定错误脱敏：✅。
- symlink/路径禁闭绑定到实际 handle：❌，R1-I-1 仍可绕过。

**R1 最终判定：REJECTED。C-004 仍未完成。**

---

## R2 独立复审（2026-08-21）

### R2 结论

**REJECTED**。R1-I-1 的 pathname 竞态已按要求闭合：打开后 confinement 只取自当前进程的 numeric fd，之后只读原 handle；I-2 与 M-1 也保持闭合。但当前代码在确认平台与普通文件类型之前执行阻塞式 `open(O_RDONLY)`，workspace 内无 writer 的 FIFO 可让 host 调用和取消流程无限等待。该新 Important 使 C-004 仍不能完成。

本节保留前两轮历史，只依据更新后的任务、执行报告、原审查、同一任务 files 的当前基线 diff及未跟踪文件 no-index diff。按要求未重跑报告声称已跑的测试。

### R2 指定项核对

| 项目 | 判定 | R2 证据 |
|---|---|---|
| 打开后不再用攻击者 pathname 做 realpath/stat confinement | ✅ | `workspace-image-read.ts:73-86` 只对 `handle.stat()` 与 `resolveHandlePath(handle.fd)` 操作；初始 `absolutePath` 在 `open` 后不再参与任何 filesystem lookup。 |
| Linux fd 最终路径 | ✅（静态协议） | `workspace-image-handle-path.ts:60-62` 只对 `/proc/self/fd/<已校验数字 fd>` 调用 `realpath`；deleted、相对、换行、反斜杠和查询失败均 fail-closed。⚠️ 报告明确当前 macOS 主机未实跑 Linux 真实 fd 正向测试。 |
| macOS 当前进程 numeric fd / 固定 lsof | ✅ | 固定 executable `/usr/sbin/lsof`，固定参数 `-a -p <process.pid> -d <fd> -Fn`；pid/fd 是安全整数。`execFile` 明确 `shell:false`，有 64 KiB 上限和 2 秒超时，非零错误或任意 stderr 均拒绝。 |
| lsof 唯一严格解析 | ✅ | 只接受恰好一组且固定顺序的 `p<pid>`、`f<fd>`、`n<绝对路径>` 三行，只容许一个末尾换行；额外/重复记录、pid/fd 不匹配、相对路径、`(deleted)`、反斜杠转义、换行及 resolver failure 全部拒绝并返回固定错误。 |
| 真实 mac handle 与外部 handle 证据 | ✅ | 报告记录当前 macOS 的真实 fd 正向解析等于 `realpath(file)`；正常 host 外部读取测试通过真实默认 resolver，注入 resolver 的外部/内部 handle 测试分别证明 root 拒绝与读取原 handle。 |
| 其他平台 fail-closed | ✅（机密性）/ ❌（打开前拒绝） | resolver 对非 Linux/macOS 固定拒绝，不会读取字节；但平台判断发生在 pathname 已被 `open` 之后，特殊文件可在到达拒绝前阻塞，详见 R2-I-2。 |
| canonical root 分量边界 | ✅ | root 来自既有 `resolveWorkspaceRoot` 的 canonical 结果，handle resolver 返回绝对最终路径，非 Auto 使用既有 `isWithinRoot(root, handlePath)` 做分量边界判断；没有字符串前缀式新实现。 |
| `allowExternalPaths` 权限范围 | ✅ | 它只跳过 `isWithinRoot`；fd 解析仍强制执行，`fstat.isFile`、host 20 MiB/调用上限、增量 `limit+1`、图片魔数与 core size/base64/MIME/魔数复核均不受该开关影响。 |
| confinement 后只读原 handle | ✅ | `verifyOpenedImage` 返回后，数据路径仅调用 `readBounded(handle, limit)`；没有按 pathname 重新打开或读取。 |
| 47 项测试证据 | ✅（所声明场景） | 报告记录 4 个文件、47 项通过；静态计数与参数化用例吻合，覆盖真实 mac 正向、Linux 协议、lsof 唯一/歧义/失败、unsupported platform、内外 handle、既有 C-004 与 core 复核。按指令未重跑。 |

### R2 对既有发现的结论

- R1-I-1：✅ 已关闭。`/proc/self/fd/N` 或固定 pid/fd 的 `lsof` 结果绑定已打开对象，不再存在第二次 pathname resolve→stat 窗口。
- I-2：✅ 保持关闭。resolver、open、verify、read 的对外错误均为稳定文本，不透传 canonical 路径或子进程错误。
- M-1：✅ 保持关闭。core 继续按调用上限与 20 MiB 硬上限复核实际 base64 长度及 JPEG/PNG/WebP 字节魔数。
- 文件组织：✅ R2 实测 resolver 74 行/测试 111 行、host 读取 157 行/测试 182 行、core 129 行/测试 120 行，均低于 300 行；resolver 与读取职责分离合理。

### R2 质量发现

#### Critical

无。

#### Important

##### R2-I-2：阻塞式 open 先于平台/普通文件校验，FIFO 可无限挂起 host 与取消流程

- 精确位置：`packages/host-node/src/workspace/workspace-image-read.ts:64-70`、`:122-138`。
- `openImage` 使用 `O_RDONLY | O_NOFOLLOW`，没有 `O_NONBLOCK`；`stats.isFile()` 与不支持平台的 resolver 拒绝都只发生在 open 成功之后。
- 反例：在 workspace 内创建命名管道 `blocked.png`，不启动 writer，再调用 `read_workspace_image`。POSIX 对 FIFO 的只读阻塞式 open 会等待 writer，代码永远到不了 `fstat.isFile()`、fd resolver、20 MiB 限制或魔数判断。HostInvoke 不承载 `AbortSignal`，ToolContext 又在 `await readWorkspaceImage(...)` 之后才执行第二次 `assertFresh()`，所以用户取消也不能让该 promise 完成；多次调用还可占满 libuv 文件系统线程。
- 影响：一个并非 JPEG/PNG/WebP 的 workspace 对象即可让模型触发无界等待，违反“受限图片读取”的文件类型、资源和取消边界。其他平台的“明确 fail-closed”也并非打开前拒绝，特殊对象可能先产生同类问题。
- 47 项测试没有 FIFO/no-writer 场景，也没有断言 unsupported platform 在调用 `open` 前失败。
- 修复要求：在任何 pathname open 前先拒绝非 Linux/macOS 平台；在支持的 POSIX 平台使用不会等待 FIFO writer 的安全打开方式（例如加入 `O_NONBLOCK`，再基于原 handle `fstat` 严格要求 regular file），同时保留现有 no-follow 与 fd-bound confinement。补充带超时保护的 FIFO 回归，以及 unsupported platform 不触发 open 的测试。

#### Minor

无新增 Minor。首轮 M-2（`tools/types.ts` 存量 328 行）继续是非阻断债务。

### R2 C-004 判定

- fd-bound 路径禁闭、错误脱敏、MIME/size/base64、Auto 权限、原 handle 读取、stale 检查和命令接线：✅。
- 对非图片 filesystem object 的有界拒绝与可取消性：❌，R2-I-2 可造成无限等待。

**R2 最终判定：REJECTED。修复 R2-I-2 后方可批准 C-004。**

---

## R3 最终独立复审（2026-08-21）

### R3 结论

**APPROVED**。R2-I-2 已按最小边界闭合；R1-I-1、I-2、M-1 保持闭合。当前证据足以将 C-004 判定为完成。

本节保留前三轮历史，只依据更新后的任务、执行报告、原审查、同一任务 files 的当前基线 diff及未跟踪文件 no-index diff。按要求未重跑报告声称已跑的测试。

### R3 指定项核对

| 项目 | 判定 | R3 证据 |
|---|---|---|
| unsupported platform 在 pathname open 前 fail-closed | ✅ | `workspace-image-open.ts:32-35` 在调用依赖 `open` 前仅允许 `linux`/`darwin`；单测注入 `win32` 并明确断言 opener 调用次数为 0。对外错误固定为 `workspace image reads are unavailable on this platform`。 |
| Linux/macOS 安全打开 flags | ✅ | `workspace-image-open.ts:39-40` 对两个允许平台统一使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`；参数化测试分别精确断言 Linux、Darwin 的数值 flags。 |
| 原 handle regular-file 校验顺序 | ✅ | opener 在同一 `FileHandle` 上先执行 bigint `stat` 并严格检查 `isFile()`，非 regular object 关闭 handle 后拒绝；只有通过者才返回给 `workspace-image-read.ts` 做 fd-bound confinement。读取仍只调用同一 handle 的 `read`。 |
| FIFO/no-writer 真实回归 | ✅ | 测试用固定 `/usr/bin/mkfifo` 创建真实 FIFO，不启动 writer；`Promise.race` 的 750 ms 门只有收到精确 `requested image is not a file` 拒绝才通过，并断言 resolver 未调用、错误不含 FIFO 路径。超时分支以本进程临时 `O_RDWR | O_NONBLOCK` handle 解阻，立即关闭，随后等待原 read promise 收尾并强制抛错；因此旧阻塞实现不能假阳性通过，也不会给失败测试遗留悬挂读或外部进程。正常拒绝路径由 opener 关闭 FIFO handle，`afterEach` 再清理 workspace。 |
| 非 regular object 与 fstat failure | ✅ | opener 单测覆盖 FIFO/socket/device/directory 的 `isFile:false`，逐项断言关闭一次；fstat 异常也关闭 handle，并收敛为固定错误。完整读取测试另以真实目录证明 handle-path resolver 不会被调用。 |
| 稳定错误、不泄漏路径/底层异常 | ✅ | unsupported、open、fstat/changed、not-file、resolver、read 均使用稳定错误文本；fstat 测试的底层异常包含 `/outside/secret.png` 但对外只见固定文本，FIFO 完整测试也断言不含真实路径。 |
| opener 单一职责与行数 | ✅ | `workspace-image-open.ts` 58 行，只负责受支持平台的安全打开及原 handle regular-file 校验；测试 79 行。模块未从 package 根导出，未扩大产品命令面。 |
| 57 项测试证据 | ✅ | 报告记录 5 个相关测试文件、57 项通过；静态用例计数吻合：R3 新增 unsupported/open flags/4 类非文件/fstat failure 共 8 项，完整目录与 FIFO 共 2 项，在 R2 的 47 项上合计 57。按指令未重跑。 |

### 既有安全项保持情况

- R1-I-1：✅ fd-bound confinement 未被回退。打开后不再对攻击者 pathname 做 realpath/stat；Linux `/proc/self/fd/N`、macOS 固定 pid/fd `lsof` 的严格解析保持不变，其他平台在更早阶段拒绝。
- I-2：✅ 所有新增 opener 失败也使用稳定错误并关闭已取得 handle，原 resolver/open/read 脱敏保持不变。
- M-1：✅ core 仍按 `min(maxBytes ?? 20 MiB, 20 MiB)` 复核 size，严格验证 base64，并对解码前缀的 JPEG/PNG/WebP 魔数与声明 MIME 做一致性检查。
- Auto 外部读取：✅ `allowExternalPaths` 仍只放开 canonical root 边界；平台、regular-file、fd resolver、20 MiB/调用上限、增量读取、图片魔数及 core 二次校验全部照常执行。
- 生命周期与接线：✅ 调用前后 stale/abort 守卫及 host 命令名、参数、registrar、invoke 证据未变。

### 验收与质量

1. ✅ 图片测试：报告记录 5 文件 57 项通过；未重跑。
2. ✅ 类型：正式 `tsc -b` 仍仅有已记录的范围外 `*.md?raw` `TS2307`；两个目标 package 隔离检查 exit 0，符合任务允许条件。
3. ✅ 行数：R3 独立 `wc -l` 为 opener 58/测试 79、resolver 74/测试 111、host 144/测试 235、core 129/测试 120、ToolContext 测试 87，均不超过 300 行。
4. ✅ 空白：报告记录范围 diff 与所有 R3 no-index 文件检查无 whitespace diagnostics。

R3 未发现新增 Critical、Important 或 Minor。首轮 M-2（`packages/agent-core/src/tools/types.ts` 存量 328 行）继续按既有规则作为非阻断、已披露债务；Linux 真实 fd 未在当前 macOS 主机实跑也继续作为明确披露的跨平台验证限制。

### R3 C-004 判定

- 受限图片类型与 payload：✅。
- workspace/Auto 权限与 fd-bound symlink/路径禁闭：✅。
- 20 MiB/调用上限及非 regular filesystem object 有界拒绝：✅。
- 稳定错误、stale/abort、命令完整接线：✅。

**R3 最终判定：APPROVED。C-004 可以完成。**
