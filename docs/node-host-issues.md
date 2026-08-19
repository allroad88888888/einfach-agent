# Node 宿主与 Web 自托管 Issue 树

## 目标

把浏览器版从「残废预览」做成能力完整的本地自托管应用：后端**一份 Node/TS 能力实现**
（`packages/host-node`），服务浏览器、CLI、以及最终退成套壳的 Tauri 三个前壳，经 npm 分发
**仅本地运行,不发布到任何 registry**（用户裁决,见下），因而也**不需要任何代码签名证书**。

> ## 分发口径：**不发布，仅本地跑**（用户裁决）
>
> D3b 交回时点名三件「首发之前必须做」的事——创建 `@einfach-agent` npm org、加 `NPM_TOKEN`
> Secret、定版本策略。**用户对三条的答复都是「不要发，仅本地跑」。** 于是：
>
> · **四个包的 `private: true` 已恢复**（`96e261d` 摘掉、本次改回）。它是防误发最硬的护栏，而
>   风险是具体的：本机 `npm config get registry` 是一台**公司内网 registry 且 token 有效**，
>   摘掉 private 之后一句裸 `pnpm -r publish` 就会把四个包以 public 身份外发（主会话实测过那行
>   `Publishing to http://npmjs.deepfos.com/`）。
> · `publishConfig.registry` 保留——冗余但零成本，且它是主会话实测过**连显式 CLI `--registry`
>   都覆盖不掉**的真护栏；将来若改主意，目标已经是对的。
> · `engines` 与 `@types/node` 的位置**都保留**：它们不是「为了发布」的元数据，本地
>   `pnpm pack` → 仓库外 `npm install` 这条验证路径同样吃它们。
> · **D3 的流水线保留但休眠**：只由 `npm-v*` tag 触发（不会有人推），且它自己的闭包前置判定
>   在 `private: true` 下**必然 red** —— 这恰好是自我说明的信号，不是缺陷。
> · **D3c（版本策略）作废**，见该卡状态段。
>
> **本地运行的入口**（主会话端到端验过）：`pnpm pack` 四个包 → 仓库外 `npm install *.tgz` →
> `./node_modules/.bin/einfach-agent --no-open`，health / invoke / 前端产物全通。
> 仓库内直接跑则是 `pnpm serve`。
>
> 顺带记一条已核实的事实（将来若改主意会用到）：包名是 `@einfach-agent/server`、bin 名是
> `einfach-agent`，**两者不是一回事**——干净机器上 `npx einfach-agent` 解析的是非 scoped 的包
> `einfach-agent`，registry 上 404（主会话实测）。能跑通的是 `npx @einfach-agent/server`。

动机是分发成本：桌面版发布要 Apple Developer ID 与 Windows code-signing 证书
（见 [release-signing.md](release-signing.md) 的九个 Secret）。Web 自托管绕开整条链路。

终局形态：

```text
                    ┌─ 浏览器 ────── HTTP ─────┐
core (TS，不变) ──▶  ├─ CLI ───────── 进程内 ────┼──▶ packages/host-node ──▶ 系统调用
  configureHostInvoke └─ Tauri 套壳 ── sidecar ──┘      （一份能力实现）
```

## 树概览

```text
H  core host bridge 抽象        H1 → H1b → H2/H3/H4/H4b → H4c/H4d-1→H4d-2/H4e → H5 → H6
N  host-node 薄包装区           N1 → N2 → N3/N4/N5/N6/N7 → N8 ★CLI 完整
W  host-node 真逻辑区           W1..W15 → W16/W17 对拍
S  server HTTP 外壳             S1 → S2/S3/S5 → S4
B  前端 server 宿主装配          B1 → B2 → B3 → B4 ★浏览器 fs/shell 可用 · B5 补测 → B6 穷举守卫 / B7 trace 静默失效
M  模型代理                     M1 → M2/M4 → M3 → M5 · M6 ★浏览器完整对话
C  MCP 与事件通道               C1/C2 → C3 → C4 → C5 · C6 → C8 噪声 500 · C7 → C9 删自探测工厂 / B8 插件缺席
P  持久化收敛                   P1 → P2 → P3 → P4
D  分发                        D1 → D2 → D3 → D3b → D3c/D3d → D4
T  桌面端退出                   T1 删掉 apps/desktop（吸收 B8/C9）
未决                           目录选择器 / 对拍覆盖下限 / 多 workspace 切换
```

**MVP 路径 = H + N + W1–W15 + S + B + M**（约 46 卡）—— **已全部完成并经 M5 在真浏览器里验收**
（真实对话 + 两次真工具调用 + 流式可见 + 可中断，记录见 scratchpad 的 `m5-acceptance.md`）。

> **范围裁剪（用户裁决）。** 树一度长到 81 卡，因为主会话**把每一条验收发现都立成了一张卡**——
> 于是每做完 5 张就新增约 5 张，净剩恒在 11 张左右，看上去永远做不完。裁剪后剩 **2 张**：
> `T1`（删掉 apps/desktop，吸收 B8/C9）与 `D4`（文档）。
> 被 DROPPED 的 7 张各自写清了凭什么作废，**事实都留在卡里**（不删卡——删掉的卡会被后人重新想
> 一遍），将来真要做的人直接取用。判据是一句话：**「我注意到了」不等于「这得有人做」。**

全树 **78 卡**（H 线在执行中由 6 张增至 12 张，五张都是验收时才浮出来的：H1b 三卡共享测试脚手架、
H4b 从 H4 里拆出的总闸、H4c 验收漏扫 apps 面留下的回归、H4d 拆树后新增文件带来的缺口、
H4e 总闸改名的下游收尾；S 线因 N3 交回的 platform 阻断项增至 5 张；M 线因 M2 交回点名的取舍新增 M6；
M3/C4/P3/D3 那一批验收又新增 5 张：C6、C7、D3b、D3c、B5，**全部来自子 agent 交回时点名或主会话
验收时的独立探针，没有一张是写卡时想出来的**）。

**进度以状态行为唯一权威**，不要手抄一个数字在这里——它一定会过期。数法：

```sh
for s in DONE DOING TODO DROPPED; do
  printf '%-6s %s\n' "$s" "$(grep -c "^- \*\*状态\*\*：$s" docs/node-host-issues.md)"
done
printf '合计   %s\n' "$(grep -c '^- \*\*状态\*\*：' docs/node-host-issues.md)"   # 必须等于卡片总数
```

**状态只有 `TODO` / `DOING` / `DONE` / `DROPPED` 四种,合计恒等于卡片总数**——这是最省事的自检:
四者之和对不上,说明有卡多了或少了状态行。`DROPPED` 是**裁决作废**（前提没了、或用户决定不做），
它必须写清楚**凭什么作废**,而不是悄悄删卡——删掉的卡会被后人重新想一遍。

行首那个 `^- ` 锚点不是装饰：状态行永远是一条列表项，而**正文里也会出现 `状态**：TODO` 这串字**
（比如上面这段说明本身，以及卡面引用别的卡时）。少了锚点，说明文字会把自己算进待办数。

**每张卡有且只有一条状态行,状态只能被「改写」,不能被「新增」。** 派工时把 `TODO` 改成
`DOING`,交回时把 `DOING` 改成 `DONE <sha> …`——**始终是同一行**。

这条是花了代价换来的:`112cf71` 标在途时是往卡里**插**了 `DOING` 行而没删原来的 `TODO`
（7 增 2 删),交回时又只把 `DOING` 那行改成 `DONE`,于是 M2/M4/C3/P2/D2 五张各留下一条孤儿
`TODO`。后果是**同一张卡同时被计入 DONE 和 TODO**,进度数字自相矛盾（报出过「58 DONE + 17 TODO」
而全树只有 70 卡),已完成的卡还会重新出现在「下一步派谁」的候选里。五张已修。
下面这条要**恒只输出 H4d 一张**（它已拆成 H4d-1/H4d-2，标题只作路标、不带状态行）：

```sh
awk '/^### /{if(k&&n!=1)print n" 条: "c; c=$0; sub(/^### /,"",c); k=(c~/^[HNWSBMCPDT][0-9]/); n=0}
     /^- \*\*状态\*\*：/{n++} END{if(k&&n!=1)print n" 条: "c}' docs/node-host-issues.md
```

## 并行规则

- 分支内按依赖串行，分支间凡改动面不重叠即可并行。
- H 线必须整条做完再开 N8/B 线：它改的是 core 的注入点，中途状态下没有宿主能提供 invoke。
- W 线各卡改动面天然按目录隔离（`workspace/read/`、`workspace/write/`…），可高度并行，
  但都依赖 N2 的路径底座。
- 同时在途控制在 3–4 卡，验收吞吐是瓶颈。

## 现状事实

写卡前核实过的代码事实，是所有卡的共同依据。

**core 侧的 Tauri 耦合点是 13 个文件，形状统一。**
`packages/agent-core/src/runtime/` 下的 `workspaceRead / workspaceWrite / workspacePatch /
workspaceDelete / workspacePathOperation / workspaceRg / workspaceGit / workspaceChange /
workspaceTask / shellCommand / projectSkillsBridge / modelTurnPrefix / workspaceDialog`
各自持有同一段：

```ts
if (!isTauriHost()) return fail('… is only available in the Tauri desktop runtime')
const invoke = await loadTauriInvoke()
const raw = await invoke<unknown>('<command_name>', toTauriInput(input))
```

两个导出都来自 `runtime/hostTauri.ts`（61 行）。**浏览器与 CLI 因此都拿不到文件与 shell 能力。**

**Rust 侧共 27 个 `#[tauri::command]`，非测试实现 12336 行。**
关键：`workspace_*` 与 `shell*` **完全不 `use tauri`**。全仓只有 9 个 Rust 文件引用 tauri，
用法只有两类——`AppHandle` 取 `home_dir()` / `app_data_dir()`，`State<T>` 取全局单例
（`McpManager`、`ModelRequestCanceller`）。

**Node 等价实现约 4700 行**，其中真逻辑约 2550 行（read / write / patch / change），
其余是薄包装。分区实测：

| 区域 | Rust 实现 | Node 估算 | 性质 |
| --- | ---: | ---: | --- |
| MCP stdio | 1964 | ~300 | 协议编排已在 TS（`tools/mcp` 5178 行），Rust 只做 stdio 传输 |
| model proxy | 1250 | ~250 | HTTP 转发；不需要 Channel 编解码 |
| git / rg / task | 1560 | ~600 | 全是 spawn 外部命令 + 解析输出 |
| shell | 618 | ~300 | `child_process` 比 Rust 短 |
| delete / pathOps / common | 1152 | ~550 | 薄 IO 包装 |
| config store | 311 | ~150 | 读写 JSON |
| **workspace_write** | 2012 | ~900 | 写锁 / 限额 / atomic write |
| **workspace_read** | 1245 | ~550 | 分页 / 行寻址 / contentHash |
| **workspace_change** | 1181 | ~600 | journal + revert |
| **workspace_patch** | 965 | ~500 | patch 引擎 |

**流式只有两处，其余全是请求-响应。**
① 模型代理走 Tauri `Channel<ModelProxyEvent>`（`apps/web/src/modelTransport/tauriModelTransport.ts`）；
② MCP 走 Tauri `listen()` 收 `mcp-stdio-tools-changed` / `mcp-stdio-close`
（`apps/web/src/mcp/tauriStdioConnector.ts`）。shell / workspace 27 个命令里的其余部分逐个映射即可。

**Rust 测试面：3410 行测试文件 + 161 个测试函数。** 这是重写要接过来的账，也是对拍的素材源。
T 线之前 Rust 仍在，那段窗口期是唯一能双跑对拍的时机。

**`atomic_write` 的语义不能简化**（`apps/desktop/src/workspace_common.rs`）：
临时文件 → `sync_all` → **回填原文件权限位** → rename。少了权限回填，一次覆盖就会静默抹掉
脚本的可执行位。

**持久化现状**：桌面走 `@tauri-apps/plugin-sql` 的 SQLite，浏览器走 IndexedDB
（`apps/web/src/persistence/persistenceDrivers.ts` 按 `tauriHost` 二选一）。
套壳后的桌面版若不做 P 线会丢掉 SQLite。

**门禁三处要随新包同步**：`vite.config.ts` 的 `resolve.alias`、`tsconfig.app.json` 的 `paths`、
`scripts/check-boundaries.js` 的 `capabilityPackages` 数组。（N1 落地时实际改了**四**处：
同文件 `coreRules` 的「core 禁入能力包」清单也加了 `@einfach-agent/host-node`——core 反过来引它
就等于把「宿主是什么」重新焊回 core，正是 H 线拆掉的那件事。）

### 移植中发现的 Rust 侧问题（汇总，W16/W17 对拍前必读）

等价移植的纪律是**照搬 + 记录，不在移植卡里单方面改** ——错误文案与行为是两个宿主的对外契约，
改一个字就是制造分叉。但照搬不等于认可，下面这些是移植时实际发现的、Rust 侧本身就不对或值得
两边一起改的地方。**对拍撞上时该改哪一边，逐条已有判断。**

已在 Node 侧修掉（可观测输出仍逐字相同）：

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | `workspace_common.rs:143` | 每个读取块单独 `from_utf8_lossy`，多字节字符被块边界劈开时两半各变成 `�`；中文输出跨块就坏字。Node 用 `StringDecoder` 跨块保留不完整序列。**对拍撞上时改 Rust。** |
| 2 | `workspace_change_journal.rs` 的 `write_entry` | `fs::write` + `rename`，**没有 fsync**。而这份文件是「这次改动可撤销」的唯一凭据，掉电后目录项指向空洞内容 = 那次改动永久撤不回来且不报错。Node 走 `atomicWrite`（含 fsync）。 |

照搬未改，但已标记：

| # | 位置 | 问题 |
| --- | --- | --- |
| 3 | `workspace_change_journal_types.rs` 的 `FileSnapshot` | `content: Option<String>`，而 serde 对 `Option<T>` 的缺失字段有特判（直接 `visit_none()`）——一份**被截断的条目不会解析失败**，而是被当成 `content: null`，回滚时那等于「文件原本不存在」，于是**删掉用户的文件**。收严会拒掉桌面端写的合法条目，要修该两边一起加 `exists === (content !== null)` 的自洽校验。 |
| 4 | `workspace_write_before.rs:44` | 文案 `existing file exceeds reversible {MAX_BYTES} byte limit` 里的 "reversible" 与它实际用的常量对不上（`MAX_BYTES` 是 8 MiB 硬顶，`REVERSIBLE_MAX_BYTES` 才是 1 MiB）。 |
| 5 | `workspace_read*` 与 `workspace_delete.rs` 的错误消息 | 用**绝对路径**（`display_path`），而返回值里的 `path` 是根相对——一次失败会把宿主机绝对路径写进模型可见的错误文本。W10 交回时点名：删除侧的软链拒绝文案同样如此（`` `/Users/…/workspace/linked` ``），且比读取侧更值得列，因为它出现在一次被拒绝的破坏性操作里。 |
| 6 | `workspace_git.rs` 的 `parse_changed_files` | 不解 git 的 C-style quoted path，`core.quotePath` 开着时非 ASCII 文件名会是 `"\303\251.txt"`。 |
| 7 | `workspace_git_exec.rs` | `status --short` / `--stat` / `--name-only` **不设输出上限**（只有 diff 正文有 cap）。巨型仓库的 `status --short` 会整份进内存和返回值。 |
| 8 | `runtime/shellCommand.ts` 的 `normalizeResult` | 超时命令的 `exit_code: null` 被整形成 `-1` 并追加 `run_shell_command returned a response without a valid exit code`——对模型来说「超时被杀」被说成「桥返回了非法响应」。改动要 core + Rust 一起动。 |
| 9 | `workspace_rg.rs` | 不传 `path` 时 target 是 `.`，rg 于是给每个结果路径加 `./` 前缀，而 `normalize_display_path` 只剥绝对路径。 |
| 11 | `workspace_patch_path.rs:101` 与 `workspace_path_ops.rs:224` | 这两处的展示路径**无条件** `.replace('\\', "/")`，而 `workspace_write_target_path.rs` / `workspace_read_paths.rs` 的 `path_to_slash_string` 是 `if MAIN_SEPARATOR == '/' { 原样 }`——**同一仓库里两种做法**。unix 上 `\` 是合法文件名字符，于是真名 `a\b.txt` 的文件在读/写侧原样保留、在 patch 与 path_ops 侧变成 `a/b.txt`；而 patch 那个结果会**写进变更日志**，回滚时按另一个路径去找。W12 发现，主会话已复核四处实现。 |
| 12 | `workspace_write_result.rs` 的 `WorkspaceWriteResult` | 它是 `#[derive(Serialize)]` **没有 `rename_all`**，所以写入回执的顶层键是 snake_case（`bytes_written` / `change_set` / `dry_run`…），而 `workspace_read_types.rs` 与 `workspace_patch_result.rs` 都带 `rename_all = "camelCase"`——**同一仓库两种线上形状**。core 的 `normalizeResult` 两种都收，所以今天两边都跑得动，但 W16/W17 对拍会撞上。W7 发现，主会话已复核三个结构的 serde 属性。Node 侧照搬了 snake_case。 |
| 13 | `workspace_delete.rs` 的 `path does not exist` | 这句话**在正常路径上永远不会出现**：`resolve_delete_path` 对**最后一段**也做 `symlink_metadata`，所以目标不存在时先失败成 `failed to resolve target path: No such file or directory (os error 2)`；caller 里那个 `ErrorKind::NotFound → "path does not exist"` 分支只在 TOCTOU 窗口里可达（同理 caller 的 `is_symlink()` 判断也不可达）。W10 照搬了（TOCTOU 下仍有意义）并把测试钉成「报的是解析失败」。**W16/W17 对拍时别指望能构造出这句话。** |
| 14 | `workspace_write_compaction.rs` 的 `compact_subagent_index` | 重写每条记录走 `serde_json::to_string`，而 `Cargo.toml` 的 `serde_json` **没开 `preserve_order`**——`Value::Object` 底层是 `BTreeMap`，字段按 key 字节序**重排**，不保留原始书写顺序。压实因此会静默改写每一行的字段顺序（内容等价、字节不同）。Node 侧只能跟着排（`stableStringify`），否则对拍必炸。要修是给 Rust 开 `preserve_order`，但那会改变**所有** JSON 输出的字段序，波及面远超本树。W9 发现。 |
| 16 | `workspace_read_bytes.rs` 的 `offset exceeds file size` | **Rust 侧零测试覆盖**——只有 TS 有 colocated 测试（`bytesRead.test.ts:107`）。W17 发现，未改（生产代码不在该卡改动面）。 |
| 17 | 对拍口径·第三条排除规则 | 错误文案里嵌了 `display_path`（**解析后的绝对路径**）的用例**永远无法逐字对比**：两侧临时目录命名方案不相干（Rust `web_agent_parity_<pid>_<seq>`、Node `mkdtemp` 随机后缀）。与「OS 错误串」那条同类但不同源，已写进 `fixtures/README.md` 作第三条排除规则。W17 发现。 |
| 18 | `model_proxy_http.rs` 的 `model_http_client()` | **每次请求都新建 `reqwest::Client`**。reqwest 官方明确要求复用——不复用等于没有连接池，每轮对话多一次 TLS 握手。Node 侧走 undici 全局 dispatcher 天然有池，两侧输出相同、延迟不同。M1 发现。 |
| 19 | `model_proxy_http.rs` 的 `MODEL_REQUEST_TIMEOUT_SECONDS = 120` | 那是 reqwest 的 `Client::timeout`，语义覆盖**到响应体读完**。一次超过 120 秒的流式生成会被宿主掐断并报「模型响应中断」——对长思考模型不是理论问题。Rust 侧零测试覆盖。Node 照搬并补了两条测试分别钉「发请求阶段超时」与「读流阶段超时」。M1 发现。 |
| 20 | `model_proxy_envelope.rs` 的 56 MiB 上限 | 它施加在 **Tauri IPC 反序列化之后**——载荷早就整个在内存里了，实际挡的是 base64 解码那步的放大，不是内存峰值。**HTTP 那条路上必须在读请求体时另加一道同样的截断**（已交接给 M2）。M1 发现。 |
| 21 | `model_proxy_body.rs` 的 `valid_content_type` | `;` 不在允许字节集内且必须恰好两段，于是**带参数的 MIME 一律被拒**（`text/plain;charset=utf-8`）。而前端 `providerWireBody.ts` 直接用 `File.type`，浏览器在部分场景就会给出带参数的值——那种上传以「模型请求格式无效」被拒，文案完全指不出病因。M1 发现。 |
| 22 | `model_proxy_http.rs` 的两处「响应过大」 | 上游**声明** content-length 超限 → 命令级 `Err`；流中**累计**超限 → `Error` 事件 + `Ok(())`。同一个原因两种失败形状，桌面端两条都落到同一个 `fail()` 所以看不出来。M2 映射状态码时必须分开处理（M1 已分：前者 reject、后者从流里抛）。M1 发现。 |
| 23 | `model_proxy.rs` 的 `model_chat_completions` | 写死 `ProviderScope::Default`，而 Kimi 只接受 `Cn`——这条兼容命令**永远够不着 Kimi**。注释自称「给 DeepSeek 与 GLM 的兼容命令」，多半有意，但一条登记在册的命令只覆盖 2/3 供应商值得记一笔。M1 发现。 |
| 24 | `mcp_process.rs` 的 `TailBuffer` | **只写不读的死累积器**（全仓只有 `new` 和 `push`），每会话白占 16 KiB。连带一个实质缺口：**子进程 stderr 被完全吞掉**——`npx` 报「找不到包」这类输出不在任何地方留痕，用户只看到 `MCP server closed stdout`。Node 侧只 drain 不留尾。C1 发现。 |
| 25 | `mcp_process.rs:42`、`mcp_session.rs:274` | **Rust `Debug` 格式漏进用户可见文案**：`{:?}` 打印 `Option<i32>`，于是 close 事件的 message 是 `MCP server process exited (exit code Some(1))`，经 `tauriStdioConnector` 直接进失败提示。Node 照搬，要改两边一起改。C1 发现。 |
| 26 | `mcp_session.rs:88` | initialize 校验用的是**常量**而不是这次实际请求的版本：收下 `requested_protocol_version` 只写进请求，校验响应时比 `DEFAULT_PROTOCOL_VERSION`。今天必然相等所以无害，但只要放行第二个版本，「请求 A、只接受 B」就会静默发生。C1 发现。 |
| 27 | `mcp_manager.rs` 的 `used_session_tokens` | **只进不出、无淘汰**，硬顶 10 000，到顶的唯一出路是「重启应用」（错误文案自己这么写）。令牌是**每次连接尝试**消耗一个，含自动退避重连的每次失败（一轮 6 次 / 约 61 秒）。一个常驻进程挂着一台永远连不上的服务，约 **28 小时**就能烧光全局预算，之后**所有** MCP 服务都连不上。C1 发现，本轮最实质一条。 |
| 28 | `mcp_validation.rs::validate_command` | 只判空、**不判 NUL**（同文件的 `normalize_identifier` 判了）。Rust 上无害，但 **Node 的 `spawn` 对 command/args/env/cwd 里的 NUL 是同步抛 `TypeError`**——不接住就没有 `kind`，失败分类器判**暂时失败**，一份永远起不来的配置被无限重连。Node 已映射成同一 kind；收严的正解是两边一起加 NUL 判据。C1 发现。 |
| 29 | `mcp_manager.rs::list_tools` | 整趟超时在边界上给出误导文案：`checked_sub` 在 elapsed == timeout 时是 `ZERO`，于是报 ``timed out after 0 ms``，读起来像「你设了 0 超时」。Node 侧同形。C1 发现。 |
| 15 | `workspace_write_compaction.rs:129` 的本地 `atomic_replace` | 它是 `fs::write` + `fs::rename`，**既不 fsync 也不回填权限位**（继承临时文件的 umask 权限），而同仓库 `workspace_common.rs` 的共享 `atomic_write` 两者都做——**同一仓库两份「原子替换」**。压实是整份重写索引，掉电后目录项指向空洞内容 = 归档索引报废。Node 侧按任务书指令统一走共享 `atomicWrite`（产出字节不变，只是落盘更耐久）。W9 发现。 |

顺带发现的 TS 侧 bug（不在本树范围，未改）：

| # | 位置 | 问题 |
| --- | --- | --- |
| 10 | `vite.config.ts:58` 的 `defaultTraceDbPath()` | Linux 分支写的是 `process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share')`，而 `dirs` crate 的判据是 `env::var_os("XDG_DATA_HOME").and_then(dirs_sys::is_absolute_path)`——**必须是绝对路径才采用**。且 `??` 只挡 `null`/`undefined`，**空串会被当有值**，`path.join('', …)` 变成跟着进程 cwd 走的相对路径。 |

**⚠️ 跨宿主隐患（T 线套壳前必须解决）**：`workspaceRoot` 在变更日志里存的是 canonicalize 后的
绝对路径、回滚时逐字比对。Rust 的 `fs::canonicalize` 在 Windows 上给 verbatim 前缀
（`\\?\C:\…`），Node 的 `realpath` 给 `C:\…`——**套壳后同一个 workspace 会被判成
`workspace_mismatch`，回滚全部失败**。POSIX 上两者一致，所以 W14/W15 都没动。

### host-node 施工须知（N1 交回，N/W/S 全线共同依据）

**落地一域 = 建目录 + 写 registrar + 在 `createRoutes` 加一行展开。** 样板是
`packages/host-node/src/config/`：handler 是工厂形态（收 options 返回 handler），`index.ts` 是域
registrar（`create<Domain>Routes(options) => NodeHostRouteTable`）。**不要在 `createNodeHostInvoke.ts`
里直接写 handler**，28 条摊进去必顶破 300 行。

**没实现的命令不要写恒抛错的占位 handler。** 路由表是 `Partial`，缺席就是「键不存在」；写占位会让
分发层把它认成「已实现但坏了」。分发层区分两种失败：`unimplemented`（在命令全集里但本次装配没有
实现）与 `unknown-command`（不在全集内），S 线可按 `reason` 字段映射 501 / 404——**用字段而不是
`instanceof`**，错误要跨 HTTP 序列化。失败一律是 rejection 不是同步抛出。

**入参大小写不是「全都 snake_case」，是两层各有各的规则**（N1 逐条核对过 28 条）：
① 14 条带 `rename_all = "snake_case"`（全部 workspace/* 与 shell），顶层键是 snake_case，
core 的 `toTauriInput` / `toTauriReadInput` 已经转好，**路由表拿到的就是 snake_case，不要再转**；
② 另 14 条没有该属性，走 Tauri 默认转换，其中参数多为单词或无参、大小写无差别，**唯二例外**是
`cancel_model_provider_request` / `cancel_model_chat_completions` 的 `requestId`（camelCase）；
③ **嵌套载荷一律 camelCase，与命令的 rename_all 无关**——最坑的是 `write_workspace_file`：
顶层键 `change_context` 是 snake_case，值里却是 `changeId` / `sessionId` / `runId` / `toolCallId`
（`workspaceWrite.ts:102` 实证）；`apply_workspace_patch` 的 `operations[]` 更混，判别键 `type`
取值是 snake_case（`add_file` / `overwrite_file`），字段却是 camelCase（`oldText` / `newText`）。

**handler 收到的是 `Record<string, unknown>`，必须自己收窄。** `commandArgs.ts` 是收窄的**目标形状**，
不是替代品——同一张表要挂在 HTTP 后面，那条路上载荷是外部输入。

**判参数存在只能看值，不能用 `'key' in args`。** core 的 `toTauriInput` 整份对象字面量返回，
可选项无值时**键存在且为 undefined**；进程内注入（CLI / sidecar）原样到达，走 HTTP 时
`JSON.stringify` 会把它丢掉。同一份入参在两种传输下键集合不同，用 `in` 会写出
「本地能跑、上 server 就变」的 bug。

**两条反向通道不在 `(cmd, args) => Promise<T>` 的形状里**：`model_provider_request` /
`model_chat_completions` 有第三个参数 `events: Channel<ModelProxyEvent>`（不是 JSON），
`mcp_connect` 之后还有一路 Rust `emit` / 前端 `listen` 的 stdio 生命周期事件。它们归 `events/` 域
（C2 卡），是独立设计而非某条命令的实现细节——**M 线与 C 线的命令实现要等 C2**。

**`sqlite/` 域当前零命令**：桌面侧走 `@tauri-apps/plugin-sql`，不在本仓库的 `#[tauri::command]`
列表里。P2 定下命令名后**必须回来登记进 `NODE_HOST_COMMANDS_BY_DOMAIN`**，否则分发层会以
`unknown-command` 拒绝它。

**`commandNames.test.ts` 逐字比对 `apps/desktop/src/lib.rs` 的 `generate_handler!` 登记列表**——
Rust 侧增删命令而这里没跟上，该测试当场红（主会话已用「删掉一条命令」的探针验证它真会红，
不是空跑）。另有一条 `implemented` 断言列出当前已实现的命令名，落地一个域就把命令名加进那个
数组，**别把断言改成宽松匹配**。

**跑单包 build 前先确保 core 已按拓扑序构建**：能力包的 `tsconfig.build.json` 指向 core 的 **dist**，
而 core 的 dist 可能是陈旧的（N1 就撞上一份不含 H 线 `HostInvoke` 导出的旧产物，声明 emit 阶段
报 TS2305）。这一条不在 CI 里，容易踩。

**`model_chat_completions` / `cancel_model_chat_completions` 全仓零 TS 调用方**（Rust 侧给旧渲染层
留的兼容命令），登记在册是因为 `lib.rs` 里确实有，实现优先级最低。

---

## H · core host bridge 抽象

### H1 · 把 invoke 抽成可注入的 host bridge 契约

- **依赖**：—
- **改动面**：新建 `packages/agent-core/src/runtime/hostBridge.ts` 与 `hostBridge.test.ts`；
  `packages/agent-core/src/index.ts` 导出（装配层调不到的 `configureHostInvoke` 等于没交付，
  可达性属于本卡契约的一部分）
- **判据**：导出 `HostInvoke` 类型、`configureHostInvoke(loader)`、`hasHostBridge()`、
  `loadHostInvoke()`。**注入的是 loader（`() => Promise<HostInvoke>`）不是已解析的 invoke**——
  装配层拿 invoke 本身是异步的，注入已解析值会让「工具在注入完成前执行」变成一个时序竞态。
  `hasHostBridge()` 判的是 loader 是否已登记，同步可答。loader 只解析一次并缓存
  （照抄 `hostTauri.ts` 的 `??=` 理由：并发首次调用时 Vitest mocker 有一路会拿到未替换的真模块）。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/hostBridge.test.ts`
- **模型**：opus
- **状态**：DONE `5136364`。两处实现决策记在源码注释里：① loader 失败**不进缓存**（清回
  `undefined` 让下次重试，清理前比对 promise 身份，避免旧 loader 慢一步失败时清掉新桥的缓存）
  ——这与 `hostTauri.ts` 无条件缓存 rejection 的行为有意不同，那边是存量，本卡不顺手改；
  ② 未登记时以 **rejection** 失败而非同步 throw，因为本函数对外承诺返回 Promise，
  同步抛出会绕过 `.catch` 链变成未捕获错误。barrel 只收 `configureHostInvoke` + `HostInvoke`
  类型，`hasHostBridge` / `loadHostInvoke` 的消费方全在 core 内部。

### H1b · 共享测试脚手架加 hostBridge 版 mock 工厂

- **依赖**：H1
- **改动面**：`packages/agent-core/src/runtime/hostTauri.testHarness.ts`
- **判据**：**本卡因验收 H1 时发现三卡共享改动面而新增。** `hostTauri.testHarness.ts` 导出的
  `hostTauriBridgeMock` 被 `workspaceRead.contentHash` / `workspaceRead.runIndexPage`（H2）、
  `workspaceWrite`（H3）、`shellCommand.backgroundKill`（H4）四个桥测试共用——H2/H3/H4 若各自
  去加 hostBridge 版工厂，三个 agent 会同时改这一个文件。本卡先行把冲突面摘出来。
  加 `hostBridgeMock(loadHostInvoke)` 供 `vi.mock('./hostBridge')` 用，形状对齐现有
  `hostTauriBridgeMock`（`hasHostBridge` 恒真 + 调用方给的 loader），沿用文件里那段关于
  vi.mock hoisting 限制的说明。**旧工厂保留不动**：H2/H3/H4 逐卡切换，全切完才零消费方，
  由 H6 一并删。跑 `pnpm exec vitest run packages/agent-core/src/runtime`
- **模型**：sonnet
- **状态**：DONE `66b9872`。纯新增 39 行、零删除，旧工厂原样。新工厂的返回类型用 hostBridge 的
  `HostInvoke` 而非借桌面包的 invoke 类型；注释里为解释「特意没用那个类型」提及了包名，
  经核实 `.testHarness.ts` 不进发布物、`packages/agent-core/dist` 的 `.d.ts` 里该字符串仍零命中，
  D9 纪律未破。

### H2 · workspace 读侧四模块改走 host bridge

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `workspaceRead.ts`（5 处）、`workspaceRg.ts`、
  `workspaceGit.ts`、`workspaceTask.ts`
- **判据**：`isTauriHost()` → `hasHostBridge()`、`loadTauriInvoke()` → `loadHostInvoke()`，
  invoke 的 command 名与参数**逐字不变**。四个文件内 `hostTauri` 的 import 归零。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/workspaceRead` 与同目录 Rg/Git/Task 用例
- **模型**：sonnet
- **状态**：DONE `fc69162`。18 增 18 删的纯 identifier 替换，command 名与错误文案零命中 diff。
  Rg/Git/Task 三个模块没有 colocated 测试，读侧只有 workspaceRead 那两个桥测试切了工厂。
  **顺带记一个存量问题**：`workspaceRead.ts` 404 行，超 300 上限。本卡是等量替换未改变行数，
  按「路过存量超限文件小改只指出不重构」的规矩没动它。它主要是类型定义 + 参数转换的薄转发层，
  真正的拆分时机在 W1–W4 落地后（那时这个文件的定位会变），不单开卡。

### H3 · workspace 写侧五模块改走 host bridge

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `workspaceWrite.ts`、`workspacePatch.ts`、
  `workspaceDelete.ts`、`workspacePathOperation.ts`、`workspaceChange.ts`
- **判据**：同 H2；额外确认 `workspacePatch.ts` / `workspaceWrite.ts` 传给 observability 的参数未动。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/workspaceWrite.test.ts` 与
  `workspacePatch.timing.test.ts`
- **模型**：sonnet
- **状态**：DONE `c4c8ded`。17 增 17 删纯 identifier 替换，observability 参数链与
  `dispatchStartedAt` / `invokeDispatchMs` 计时未进 diff。跟随改了一处类型标注
  `Awaited<ReturnType<typeof loadTauriInvoke>>` → `…loadHostInvoke>>`。
  `workspacePathOperation.ts` 的守卫与文案写在同一行，整行必然进 diff 但文案两侧逐字相同。
  Delete / PathOperation / Change 三个模块全仓无 colocated 测试（已 grep 函数名确认）。

### H4 · shell 与 projectSkillsBridge 改走 host bridge

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `shellCommand.ts`、`projectSkillsBridge.ts`
  及其 colocated 测试
- **判据**：同 H2。两处**范围收窄**（原卡面写的是三个模块）：`modelTurnPrefix.ts` 拆去 H4b，
  因为它那处 `isTauriHost()` 不是早退守卫而是工具可见性总闸，改动性质完全不同；
  `workspaceDialog.ts` 始终不在范围（它用的是 `@tauri-apps/plugin-dialog` 而非 core invoke，
  归未决项 U-1）。跑 `pnpm exec vitest run packages/agent-core/src/runtime/shellCommand`
- **模型**：sonnet
- **状态**：DONE `f6e3b9b`。5 增 5 删。`projectSkillsBridge.ts` 的用法与 shellCommand 不同：
  它**只用守卫、不取 invoke**——实际 IO 委托给 `listWorkspaceFiles` / `readWorkspaceFile`
  （H2 改动面），所以那边只换了 `hasHostBridge()` 一处。

### H4b · 工具可见性总闸从「是不是 Tauri」改成「有没有桥」

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `modelTurnPrefix.ts`、`turnToolVisibility.ts`、
  `toolManifest.ts`、`turnToolSet.ts`，以及 `modelRun.requestProjection.test.ts`、
  `modelRun.dangerousToolConfirmation.test.ts`
- **判据**：**本卡因验收 H1 时发现 H4 卡面定性错误而拆出，是整棵树的总闸。**
  `turnToolVisibility.ts:31` 的 `isToolVisible(runtime, isTauri) => runtime !== 'server' || isTauri`
  决定**模型能不能看到文件与 shell 工具**——`runtime: 'server'` 不是某个叫 server 的工具，
  而是「需要本机能力」这一整类。这个 flag 从 `modelTurnPrefix.ts:45` 的 `isTauriHost()` 出发，
  经 `buildToolManifestText` / `buildTurnTools` 流到 `availableToolSummaries` 与 `isToolVisible`，
  沿途参数名一律叫 `isTauri`。**后端做得再全，这个 flag 不翻，Web 版就是空的。**
  本卡把源头换成 `hasHostBridge()` 并把沿途参数改名（`isTauri` → 表达「有本机能力」的名字），
  两个 modelRun 测试里的 `stubTauriHostFlag(true)` 相应换成登记一个假 loader——
  `hasHostBridge()` 看的是 loader 是否登记，不再看 `globalThis.isTauri`，不换则测试失去意义。
  **连带影响要在卡上写明结论**：`tools/mcp/src/placeholderTool.ts` 的注释说明 MCP stdio 占位
  工具正是靠这个过滤在浏览器下隐藏，闸门翻开后 C 线完成前它会可见但不可用——是接受这个窗口期
  还是加一层更细的能力粒度，本卡给出判断并记录。
  跑改动面相关测试；**全量与 `pnpm build` 由主会话验收时统一跑**——本卡与 H2/H3/H4 并行，
  工作树上有它们的中间态，全量失败会归因不清，且并发 build 会争 `dist/`。
- **模型**：opus
- **状态**：DONE `1f12abb`。参数名定为 `hostHasLocalCapabilities`：带 `host` 前缀避免在
  `isToolVisible(runtime, X)` 里被误读成「这个工具有本机能力」；用「能力」而非「桥」是因为
  桥只是当前实现手段，把手段写进语义参数名等于把刚拆开的耦合换个名字焊回去。
  **单源已独立复核**：`modelTurnPrefix.ts:64` 是唯一源头，三条流（清单文本、tools 数组、
  `toolCallGate` 的执行期拒绝）加子 Agent 那份全部由它喂。子 agent 另做了反向对照——
  把桩改成 false 后 15 例倒 7 例，且倒的正是依赖 server 工具可见性的那些，证明桩承重不是摆设。
  **共享脚手架被迫分家**（卡面没预见）：`stubHostBridgeFlag` 必须对 `./hostBridge` 做值导入，
  而 `hostTauri.testHarness.ts` 被四个 `vi.mock('./hostBridge')` 的桥测试 import，
  vi.mock 提升到 import 之前 → 值导入撞进被 mock 模块的 TDZ（实测 4 个文件报
  `Cannot access '__vi_import_0__' before initialization`）。故新开 `hostBridge.testHarness.ts`，
  原脚手架对 hostBridge 只留 `import type`。两边都留了注释记这个坑。
  超出卡面改了 3 行（`toolLoopBootstrap.ts` ×2、`transcriptInjection.test.ts` ×1），是字段改名的
  必然连带。

### H4c · 修 apps/web 插件测试的宿主桩（H2/H4 回归）

- **依赖**：H4b
- **改动面**：`apps/web/src/plugins/initialize.test.ts`
- **判据**：**来源：H2/H4 的回归，主会话验收时漏扫 apps 面，由 H4b 的子 agent 在裸 HEAD
  `c4c8ded` 复跑时发现。** `projectSkillsBridge.ts` 的判据换成 `hasHostBridge()` 之后，
  该测试仍用 `stubTauriHostFlag` 切 `globalThis.isTauri`，两个用例失败。改用 H4b 新增的
  `stubHostBridgeFlag`（`packages/agent-core/src/runtime/hostBridge.testHarness.ts`）。
  跑 `pnpm exec vitest run apps/web` 全绿
- **模型**：sonnet
- **状态**：DONE `f0967e0`。apps/web 全量 98 文件 / 673 例全绿。**卡面给的修法是错的，实测推翻了**：
  `stubHostBridgeFlag` 的 loader 故意解析出一个恒 reject 的 invoke，而本文件两条 Tauri 用例的断言
  需要 `list_workspace_files` 真的带着正确参数打到 invoke mock 上——换上去后 hydration 停在
  `status:'error'`、`listedRoots()` 恒空。最终改为直接 `configureHostInvoke` 登记一个转发到
  文件既有 `invokeMock` 的 loader（即 H5 桌面装配在测试里的等价物）。
  **另踩一个模块身份陷阱**（对 H4d-2 之后的所有测试卡都成立）：`configureHostInvoke` 改的是
  `hostBridge.ts` 的模块级变量，而该文件的 `freshHost` 每次先 `vi.resetModules()`；顶层静态 import
  拿到的是收集阶段那份**旧**模块实例，被测代码动态 import 拿到的是重置后的新实例，于是登记不生效、
  现象与上面那条一模一样。解法同文件里已有的 `uiStore` 动态重导入模式：在 `resetModules()` 之后
  再动态 import，用模块级可变引用接住供顶层 `afterEach` 复位。

### H4d · userSkillsRoot 改走 host bridge（已拆为 H4d-1 / H4d-2）

**改写原因**：调研交回的结论是这张卡不能只改一个文件。`resolveUserSkillsRoot` 走的不是 invoke，
而是 `hostTauri.ts:70` 那条 **core 的第二条 `@tauri-apps` 运行时边**（`import('@tauri-apps/api/path')`
取 `homeDir()`），而 Rust 侧 27 个 command 里**没有**主目录命令。于是纯替换两种写法都错：
保留 path 模块的话，登记了桥但没装 `@tauri-apps/api` 的 Node/浏览器宿主动态 import 失败 → 静默
返回 undefined，等于没改；直接换成 invoke 的话，Rust 没这个命令，H5 一落地**桌面端的 user skills
会静默消失**。三条事实已由主会话独立复核（`loadTauriHomeDir` 全仓单消费方、Rust 无该 command、
返回值确实被当 confinement 根用）。

**选型：新增桥命令 `get_user_home_dir`，不做 core 注入槽。** 决定性理由是这个值的用途——
它随后被 `tools/skills/src/projectSkillsLoader.ts` 当作**桥调用的 confinement 根**传回去
（`workspaceRoot: root.root` + `allowExternalPaths: true`）。它只在「桥背后那台机器的文件系统
命名空间」里有意义：浏览器接 Node 后端时，主目录是**服务端**那台机器的，前端无从知道。
让它和文件读取走同一个权威，「根是桥所在机器上的真实路径」才是结构性成立的。
注入槽还有两个毛病：server 宿主下浏览器无论如何都得经 `/api/invoke/:command` 拿服务端主目录，
命令消不掉，再加一个槽等于一件事两套机制；且槽的失败形态正是本仓库最忌讳的那种——某个宿主忘了
注入则 user skills 静默缺席、不报错，而桥只有 `configureHostInvoke` 一个登记点，漏不掉。

已否决的省事方案：在 H5 的 Tauri 装配层包一层 shim，把 `get_user_home_dir` 就地映射到
`@tauri-apps/api/path`（省掉写 Rust）。它在 invoke 路由里塞一个按命令名的分支，路由表就不再是
「有哪些命令」的唯一权威，且 T2 必须记得拆。宁可写 15 行 Rust，T3 跟着其余业务代码一起删。

### H4d-1 · Rust 新增 `get_user_home_dir` 命令

- **依赖**：—
- **改动面**：新建 `apps/desktop/src/user_paths.rs`；`apps/desktop/src/lib.rs` 加一行 `mod` 与
  一行 `generate_handler!` 条目
- **判据**：`#[tauri::command] pub fn get_user_home_dir(app: AppHandle) -> Result<String, String>`，
  走 `app.path().home_dir()`，失败文案照抄 `web_agent_config_store.rs:64` 的「无法定位用户主目录」，
  非 UTF-8 路径单独报错。**返回原始字符串、不做尾斜杠归一**——归一留在 core 一份，三个宿主共用。
  诚实记录：这是 AppHandle 的薄包装，与 `WebAgentConfigStore::from_app` 同形，**没有有意义的单测**
  （既有测试都从 `from_home_directory` 绕开 AppHandle）。验收 =
  `cargo test --manifest-path apps/desktop/Cargo.toml` 仍绿 + `pnpm tauri build --no-bundle` 编译通过
- **模型**：sonnet
- **状态**：DONE `925083c`。15 行，`lib.rs` 加两行。非 UTF-8 用
  `into_os_string().into_string()` 而非 `to_string_lossy()`——后者会把不可转字符静默换成
  U+FFFD，产出一个看似正常实则打不开的路径，故障现场离病因十万八千里。
  没加 `rename_all`（除注入的 `AppHandle` 外无参数，跟随 `mcp_config_read` 的先例）。
  161 个既有 Rust 测试仍绿；`generate_handler!` 是编译期宏，编译通过即验证了注册。

### H4d-2 · userSkillsRoot 改走桥，并删掉 core 的第二条 Tauri 运行时边

- **依赖**：H4d-1（**反序会在 H5 落地时让桌面端 user skills 静默消失**）
- **改动面**：`packages/agent-core/src/runtime/userSkillsRoot.ts` 及其测试；`hostTauri.ts`（删死代码）
- **判据**：守卫换 `hasHostBridge()`，取值改 `await invoke<string>('get_user_home_dir')`，
  **显式判 `typeof` 是字符串再 trim**（`invoke<T>` 不做校验）。`stripTrailingSlash` 与
  「失败一律降级 undefined」两段语义和注释逐字保留，只把「homeDir 在不同 Tauri 版本上带不带尾斜杠
  不一致」改成按宿主实现措辞。`hostTauri` import 归零后，`hostTauri.ts:63-74`
  （`TauriHomeDirFn` / `tauriPathModule` / `loadTauriPath` / `loadTauriHomeDir`）零消费方 →
  **一并删除**，core 的 `@tauri-apps` 运行时边从两条降到一条。
  **测试改法写死在卡上**：不要用 `hostBridgeMock`（它把 `hasHostBridge` 钉死为 true，而本文件的
  守卫正是被测对象），也不要用 `stubHostBridgeFlag`（它的桩 invoke 恒 reject，喂不出返回值用例）。
  直接用真实 hostBridge 模块 + `configureHostInvoke(() => Promise.resolve(invokeStub))` /
  `configureHostInvoke(undefined)` 切换，`afterEach` 复位，零 mock、无 TDZ 风险。
  现有 5 个用例 1:1 平移。跑 `pnpm exec vitest run packages/agent-core/src/runtime/userSkillsRoot.test.ts`
  + `pnpm exec vitest run tools/skills packages/agent-core/src/skills`
- **模型**：sonnet
- **状态**：DONE `3d9a6ce`。死代码已删净（全仓 grep 零残留），**core 的 `@tauri-apps` 运行时边
  从两条降到一条**——`hostTauri.ts` 只剩第 57 行那个 `import('@tauri-apps/api/core')`；
  core 生产代码里另一条是 `workspaceDialog.ts:52` 的 plugin-dialog（未决项 U-1）。
  **主会话验收时改了一处交回的测试**：「无桥」用例原写成「造一个会计数的 loader、特意不登记它、
  断言 calls 为 0」，那是永真断言——loader 压根没登记，计数当然是 0，连守卫被整个删掉都发现不了
  （守卫失效时会走到 `loadHostInvoke()` 拿 rejection 再被 catch 降级，计数同样是 0）。
  不 mock hostBridge 就无法区分这两条路径，已改成只断言外部契约并把这个理由写进注释。

### H4e · 收掉 `runtimeIsTauri` 这个旧名字

- **依赖**：H4b
- **改动面**：`ToolLoopBase.runtimeIsTauri`、`SubagentRuntimeOpts.runtimeIsTauri` 及其全部消费方
  （`toolLoopBootstrap` / `modelTurnRequester` / `toolCallGate` / `childAgentLoop` /
  `childAgentToolCalls` / `childToolVisibility` / `childResult` 等，15+ 文件及测试）
- **判据**：**来源：H4b 的建议。** H4b 只改到卡面四个文件之内，接缝停在
  `runtimeIsTauri: stablePrefix.hostHasLocalCapabilities`——旧名字被喂新语义这件事在源码里
  看得见（两处都写了注释），不是静默的，所以不阻塞任何卡。本卡把名字收干净。
  纯改名，跑 `pnpm exec vitest run packages/agent-core` 全量
- **状态**：DONE `5f40682`。21 个文件、45 处命中，44 增 51 删——多删的 7 行正是两段「待办」注释。
  diff 里除 identifier 外只有一行改动：`subagents/runtimeState.ts` 的字段注释原文写着
  「runs inside the native Tauri host」，与新名字和新语义直接冲突，跟着改了。
- **模型**：sonnet

### H5 · Tauri 装配层注入 invoke loader

- **依赖**：H2、H3、H4、H4b
- **改动面**：`apps/web/src/main.tsx`（tauri 分支）、`apps/web/src/test/setup.ts`（测试宿主注入）
- **判据**：桌面宿主下 `configureHostInvoke(() => loadTauriInvoke())` 在
  `registerStandardTools` 之后、任何工具可能执行之前完成。**这卡是 H 线的试金石**：
  跑 `pnpm exec vitest run packages/agent-core apps/web` 全绿 + `pnpm build`，
  桌面版行为与 H1 之前逐项一致
- **模型**：opus
- **状态**：DONE `2fde7cc`。登记点落在 `registerStandardTools` 之后的第一个装配块：模块体到末尾
  `void bootstrapApplication()` 之前全程同步，因此先于**所有**异步续段。除了「恢复出来的会话可能
  带着未完成 run」这个显而易见的时点，还有一个静默失败点值得记：`initializePluginSettings()` 那条
  workspace root 订阅触发的插件扫描里，`desktopProvider.resolveBridge()` 会求值一次
  `buildProjectSkillsWorkspaceBridge()` 并 `??=` **缓存**结果——那一刻没有桥的话，缓存下来的
  `undefined` 会让插件面在整个进程生命周期里都报「当前宿主没有 workspace 文件系统通路」，且不自愈。
  **不走 core 的 `loadTauriInvoke()`**：它不在 `@einfach-agent/core` 公开面上，深导入
  `@einfach-agent/core/runtime/hostTauri` 会撞 `check-boundaries` 的公开面白名单（S9，硬 error 不是
  观察项）；要不要放上公开面是 core 自己的决策。装配层自持 loader 反而更贴 H 线的方向。
  `setup.ts` 未动，而且是**实验验证**过的决定：临时加一个全局桩桥后重跑，恰好只有本卡新增的两个
  用例失败、其余零影响——全局桩既没必要，又会把本卡要证明的性质本身证伪。
  **纠正一个数字**：`runtime: 'server'` 的生产工具是 **16 个**（`tools/fs` 10 + `tools/shell` 6），
  不是先前记的 17——第 17 个 grep 命中是 `toolCallBatch.authorization.testFixtures.ts` 里的测试夹具。
  已独立复核。
  **未验证项（如实记录）**：没有真的启动桌面 app（`pnpm tauri dev`）。「桌面版行为与 H1 之前逐项
  一致」建立在测试与代码推理上，不是跑过桌面二进制。

### H6 · 宿主不可用文案去 Tauri 化

- **依赖**：H2、H3、H4、H4b、H4c、H4d-2
- **改动面**：11 个 runtime 模块里的 fail 文案（`shellCommand` / `workspaceChange` / `workspaceDelete` /
  `workspacePatch` / `workspaceRg` / `workspaceTask` / `workspaceDialog` / `workspaceGit` /
  `workspacePathOperation` / `workspaceRead` ×4 / `workspaceWrite`，共 15 处）；
  **`toolContext.subagentArchive.test.ts`（3 处断言了这句文案）**；`hostTauri.testHarness.ts`（删死代码）
- **判据**：`grep -rn "only available in the Tauri desktop runtime" packages/agent-core/src` 归零，
  替换为「当前宿主未提供 workspace 桥」（用户可见文案保持中文）。**`workspaceDialog.ts` 的那处也改**——
  它虽然仍走 `@tauri-apps/plugin-dialog`（未决项 U-1），但文案描述的是「当前宿主没有这个能力」，
  与桥无关，措辞该跟其余一致。
  **两个测试脚手架导出已确认零消费方**（主会话验收 H4d-2 时 grep 过，剩余命中全是注释里的提及）：
  `hostTauriBridgeMock` 直接删；`stubTauriHostFlag` 切的是 `globalThis.isTauri`，而 `isTauriHost()`
  如今只剩 `workspaceDialog.ts` 一个消费方——**删还是留由本卡判断并写明理由**，留就要说清谁将来会用它。
  跑 `pnpm exec vitest run packages/agent-core` 全量
- **模型**：sonnet
- **状态**：DONE `9dc5707`。两个脚手架导出都删了（`stubTauriHostFlag` 的留白理由写进文件头：
  `workspaceDialog.ts` 将来要补测试就沿用 `index.smoke.test.ts` 那套自包含写法，真出现多个消费方
  再抽公共 helper），文件 114 → 62 行、只剩 `hostBridgeMock` 一个导出。另连带修了两个断言旧文案的
  测试（`index.smoke.test.ts`、`toolContext.test.ts`，后者真实调用 `ctx.runShell` 未 mock）。
  **主会话验收时统一了措辞**：交回时 14 处写「未提供 workspace 桥」、shellCommand 那处写
  「未提供 shell 命令桥」——而桥只有一座（`hasHostBridge()`），两个名字会让模型以为
  「shell 桥没了但 workspace 桥也许还在」，白跑一轮文件工具；且那座桥本来也不叫 workspace 桥，
  它承载所有本机命令。已全部统一为「当前宿主未提供命令桥」。

---

## N · host-node 薄包装区

### N1 · 建 host-node 包骨架与路由表契约

- **依赖**：H1
- **改动面**：新建 `packages/host-node/`（package.json、tsconfig、`src/createNodeHostInvoke.ts`、
  `src/commandNames.ts`）；同步 `vite.config.ts` 的 alias、`tsconfig.app.json` 的 paths、
  `scripts/check-boundaries.js` 的 `capabilityPackages`
- **判据**：`createNodeHostInvoke(options): HostInvoke` 返回一个按 command 名分发的路由表，
  未实现的命令返回明确的「未实现」而非静默失败。路由表里**先落一条 `get_user_home_dir`
  → `os.homedir()`**（H4d 拆卡时并进来的，见 H4d-2；N7 读 `~/.webAgent/config.json` 也要用它）。
  **明确不要**把主目录塞进 `/api/health` 让 B1 顺手取走——那会把权威重新劈成两处。**包不依赖 `@einfach-agent/core` 的运行时**
  （只 import type），不含任何 HTTP。跑 `node scripts/check-boundaries.js` + `pnpm build`
- **模型**：opus
- **状态**：DONE `c9ff758`。900 行 src / 11 例。`NODE_HOST_COMMANDS_BY_DOMAIN` 的**键就是目录名**，
  所以命令表同时是目录规格；命令名联合类型从表推导，不手写第二份。入参形状因 300 行上限拆成
  `commandArgs.ts` + `commandPayloads.ts`，两者间有**双向编译期穷举断言**——命令集合与入参表任一头
  漏一条，`pnpm build` 当场红。门禁生效性也被验证过：子 agent 临时放了个 import 工具域的探针文件，
  确认 `能力包禁入工具域` 真的报错后删除。施工须知见上面「现状事实」新增的那一节。

### N2 · workspace 路径底座与 atomic write

- **依赖**：N1
- **改动面**：`packages/host-node/src/workspace/common/`（路径解析、confinement 判定、
  `atomicWrite`、带上限的增量读）
- **判据**：对齐 `apps/desktop/src/workspace_common.rs`。三条必须有 colocated 测试：
  ① 越界路径（`../`、绝对路径、symlink 逃逸）被拒；
  ② `atomicWrite` 写完后**原文件权限位保留**（含可执行位）；
  ③ 增量读到上限即停，不把大输出全缓冲进内存。
  跑 `pnpm exec vitest run packages/host-node/src/workspace/common`
- **模型**：opus
- **状态**：DONE `04a8fa5`。8 个源文件 + 7 份 colocated 测试（61 例），最大 158 行。
  Rust 侧那条 confinement 判定散在六份路径文件里各抄一遍，Node 收成一份，但**保留两种形态**
  ——读取形态（目标必须已存在、靠 realpath 断案、有 `allowExternalPaths` 特权）与写入形态
  （目标可能尚不存在、`../` 词法直接拒、回溯到最近已存在祖先再 canonicalize、**无**外部路径特权，
  因为「读到根外只是看见，写到根外是改别人磁盘」）。
  **两处技术发现已由主会话独立复现**：
  ① **前缀陷阱**——Rust 的 `Path::starts_with` 是**按分量**比的，`/ws-evil` 天然不以 `/ws` 开头；
  直译成 `startsWith` 就把这条性质丢了。判定一律在分隔符边界上比。
  ② **Node 的 realpath 有两种语义**——`fs.realpathSync`（JS 实现）先按词法消 `..` 再走链接，
  而 `fs/promises` 的 `realpath` 与 `realpathSync.native` 走 POSIX 语义（先解链接再吃 `..`），
  **只有后者等价 Rust 的 `fs::canonicalize`**。实测同一个 `link/../real/inner.txt`：JS 版抛 ENOENT，
  native 版解出真实文件。同理拼接不能用 `path.join` / `resolve`（它们会先消 `..`）。
  **变异验证**：删掉 `inheritPermissions` 的 chmod → 两条权限用例失败；把边界判定换成裸
  `startsWith` → 四条前缀用例失败。共 6 条定点失败后完整还原。
  **一处有意偏离 Rust**（见 W16 卡面）：UTF-8 分块解码修掉了 Rust 的坏字 bug。
  另有三处主动与 Rust 保持一致并写明理由：错误文案保留英文原文（两个宿主对同一次越界必须说
  同一句话）、rename 后不 fsync 父目录（要加两边一起加）、边界比较不做大小写折叠（fail-closed）。

### N3 · shell 执行

- **依赖**：N2
- **改动面**：`packages/host-node/src/shell/`
- **判据**：对齐 `apps/desktop/src/shell*.rs`（618 行）：平台 shell 选择、timeout、
  stdout/stderr 上限截断、后台进程登记与 wait/kill。命令 `run_shell_command` 的入参与返回
  逐字段对齐 core 的 `ShellCommandInput` / `ShellCommandResult`。
  跑 `pnpm exec vitest run packages/host-node/src/shell`
- **模型**：opus
- **状态**：DONE `711e032`。9 个源文件 + 5 份测试 / 39 例。
  **卡面前提被推翻且推翻得对**（主会话已复核）：我从文件名 `shell_wait.rs` 推断存在跨调用的
  后台进程表，实际那 75 行只等**本次调用的直接子进程**退出、超时就杀，整个 `shell*.rs` 零跨调用
  状态。所以 Node 侧同样零状态、不开 `hostOptions` 槽位。
  stdout / stderr **都用 drain**（`shell_output.rs` 的 `read_capped_into` 到上限后继续 read 只丢内容，
  两条流共用）——这不是可选项：管道缓冲只有几十 KB，读端一停写端就卡在 write 上，
  「输出超上限」会变成「命令挂到超时被杀」，`exit_code` 从 0 变 null。有专测用例，换成 stop 立刻红。
  **四处 Node 特有的必要偏离**：① 放弃读线程时 Rust 是丢 JoinHandle 让线程与 fd 一起泄漏，
  Node 必须 `stream.destroy()`，否则活着的 Readable 会让 CLI 宿主拒绝退出；② `detached` 而非
  `process_group(0)`（Node 只暴露前者，且 Windows 上语义完全不同，故只在非 win32 设）；
  ③ **env 是合并不是替换**——Rust 的 `Command::envs()` 往继承环境里加，Node 的 `env` 选项整份替换，
  照抄写法会让子进程丢掉 PATH，症状是「传了 env 就找不到任何可执行文件」；
  ④ 存在性检查用异步 `stat` 而非 `existsSync`（这张表要挂在 HTTP 后面，同步 IO 会卡事件循环）。
  **另记一笔既有的误导性文案**（桌面端今天就有，改动要 core + Rust 一起动）：超时命令的
  `exit_code: null` 被 core 的 `normalizeResult` 整形成 `-1` 并追加
  `run_shell_command returned a response without a valid exit code`——对模型来说「超时被杀」
  被说成「桥返回了非法响应」。

### N4 · git diff

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/git/`
- **判据**：对齐 `apps/desktop/src/workspace_git*.rs`（594 行）。**参数白名单必须照搬**
  （`workspace_git_args.rs` 与 `workspace_git_args_tests.rs`）——它挡的是经 diff 参数注入
  任意 git 子命令。跑 `pnpm exec vitest run packages/host-node/src/workspace/git`
- **模型**：opus
- **状态**：DONE `773e0d4`。7 个源文件 + 5 份测试 / 71 例（用真 git 仓库，不 mock）。
  **白名单是构造式不是过滤式**：argv 里每个 flag 都是源码字面量，调用方只能影响 `base` 与
  `paths` 两个值。逐条拒绝各挡什么已写进注释，其中一条**是子 agent 自己补的**、Rust 注释里没有：
  `base` 必须解析成 `^{commit}`——`git diff <x>` 里的 `<x>` 若不是 rev，git 会把它当 **pathspec**，
  少了这步，一个恰好是仓库内路径的 base 会让「对比某提交」静默变成「只看某文件」。
  它还诚实指出「base 含空白/控制字符」这条**在没有 shell 的前提下不是拆词防线**（`spawn` 不带
  `shell`，argv 直接 execve），挡的是另外两件次要的事，但没有因此放宽它。
  **env 三件套有行为验证而不只是断言配置存在**（主会话复核）：仓库 config 里配一个会 `touch`
  标记文件的外部 diff driver，断言标记文件不存在、且 diff 内容仍是 git 自己算的那份。
  路径 confinement 没有复用 common 的两个 `resolve*`（那两个产出绝对路径给系统调用，这里要的是
  给 git 的相对 pathspec，且必须允许目标已被删除），照搬 `workspace_git_path.rs` 自己那套。

### N5 · rg 搜索

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/rg/`
- **判据**：对齐 `apps/desktop/src/workspace_rg.rs`（486 行）：spawn `rg --json`、上下文行、
  `maxMatches` 上限与 truncated 标记、stderr 截断、`--max-filesize=1M`。rg 缺失时返回可读错误
  而非崩溃。跑 `pnpm exec vitest run packages/host-node/src/workspace/rg`
- **模型**：sonnet
- **状态**：DONE `9410ab5`。9 个源文件 + 5 份测试 / 54 例。六个常量逐值对齐（主会话复核），
  `maxMatches` 与 `contextLines` 超限一律**钳到 MAX 不拒绝**，`maxMatches` 为 0 或缺席回落 DEFAULT
  （0 不表示无限）。解析 `match` / `context` 事件，忽略 `begin` / `end` / `summary` 与解析不了的行
  ——与 Rust 的 `_ => {}` 逐条一致。
  **stdout 既不用 stop 也不用 drain**：走 readline 逐行解析并按 maxMatches 自行停止（Rust 的
  `parse_rg_stdout` 同样没用那两个共享 helper）；只有 stderr 用 `readCappedDrain`，必须与 stdout
  并发排空，否则 stderr 管道写满会把子进程堵死。
  **rg 缺失的文案在 Rust 原文后追加了中文安装提示**（Rust 原文没有可抄的）——前缀逐字保留，
  是增量信息不是改写，基于前缀的断言不受影响。
  **一处继承自 Rust 的行为要让调用方知道**：不传 `path` 时 rg 的 target 是 `.`，于是它给每个
  结果路径加 `./` 前缀（对真实 ripgrep 15.1.0 实测过），`normalize_display_path` 只剥绝对路径、
  不剥这个前缀。不是 bug，但默认搜索的调用方要预期到。

### N6 · run workspace task

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/task/`
- **判据**：对齐 `apps/desktop/src/workspace_task.rs`（480 行）：按 kind 发现并执行
  测试/lint 命令、输出上限、退出码透传。跑 `pnpm exec vitest run packages/host-node/src/workspace/task`
- **模型**：sonnet
- **状态**：DONE `40cb560`。7 个文件 / 59 例。kind（test / build / lint / typecheck）映射到同名
  `package.json` script，包管理器按 lockfile → `packageManager` 字段 → npm 逐级探测；
  `cargo_check` 依次找根 `Cargo.toml` → `apps/desktop/` → `src-tauri/`。
  **三个模块的 capped 读各不相同**（子 agent 先按 git 的类比假设 stdout 用 stop，自己 grep 后
  推翻，主会话复核确认）：`workspace_task.rs` 两个流**都用 drain**、`workspace_git_exec.rs`
  是 stdout=stop + stderr=drain、`workspace_rg.rs` 的 stdout 走逐行 JSON 解析不经 capped。
  task 用 drain 是对的——chatty 的构建/测试工具 stdout 到上限后若停读会背压卡死，反而制造假超时。
  **一处有意偏离**：Rust 的 timeout 分支用同步 `try_wait` 区分「kill 失败但进程其实已自然退出」
  与「kill 失败且仍在跑」；Node 的事件式实现里这个竞态**结构上不存在**（自然退出先 resolve 并
  `clearTimeout`，kill 分支只在进程确实还活着时才跑），故不复刻，理由写在 `taskProcess.ts` 文件头。

### N7 · 用户配置读写

- **依赖**：N1
- **改动面**：`packages/host-node/src/config/`
- **判据**：对齐 `web_agent_config_store.rs` + `web_agent_config_write.rs`：默认
  `~/.webAgent/config.json`；**新文件不存在时才**安全复制旧 `~/.web-agent/config.json`，
  新文件优先且旧文件保留；`WEB_AGENT_CONFIG_DIR` 只选目录、**不接受也不返回模型 Key**；
  设置覆盖目录时不触发迁移。Unix 下配置目录权限 0700。
  跑 `pnpm exec vitest run packages/host-node/src/config`
- **模型**：opus
- **状态**：DONE `c0b054d`。7 个文件 / 57 例。**凭证边界由主会话独立探针验证**：喂一份含
  `modelCredentials.deepseek = "sk-…"` 的配置，`mcp_config_read` 的返回里既无该 Key 也无
  `modelCredentials` 键名，而 `mcp` 段照常返回。设计理由也对——底座不认任何一段的内容，段视图
  请求的段名恒为 `mcp`，凭证拿不到不是因为某处写了过滤，是它根本不在返回路径上。
  `merge` 语义是**顶层浅合并 + null 删键**（两条互相排除的用例 + 变异测试钉住：改成整份替换
  或去掉 null 分支都会转红）。迁移四分支里最漂亮的一条：设了 `WEB_AGENT_CONFIG_DIR` 时
  `legacyPath` 恒为 `undefined`，**迁移在机制上不可能发生**，而不是靠某处记得写 if。
  **五处没照搬 Rust，各有理由**：① 加一条全进程写入串行队列——Rust 的 `static CONFIG_LOCK`
  只挡跨线程，Node 单线程但读—改—写中间隔着两次 await，两个并发 write 会各读旧值各写回；
  ② 补丁里值为 `undefined` 的键当作没写（Rust 无此分支，因为 Tauri 收的是已反序列化的 `Value`）
  ——不跳过就是「本地删得掉、上 server 删不掉」；③ 临时文件名用进程内自增序号（Node 无同口径
  纳秒时钟，`Date.now()` 同毫秒两次写入会撞名）；④ 缺 `patch` 的报错是新写的（Rust 那层由 Tauri
  反序列化挡住）；⑤ 只排顶层不递归排序（纯排版，为的是两个宿主轮流写同一份文件时不产生整份 diff）。
  **不复用 N2 的 `atomicWrite`，理由成立**：Rust 侧同样是两份实现，权限语义相反——workspace 那份
  显式**继承原文件权限**（否则覆盖会抹掉脚本可执行位），配置这份强制 0600 / 目录 0700。
  合成一个带开关的函数等于让调用方每次现选一次安全级别，漏选那次不报错、只让凭证变成同机可读。

### N8 · CLI 注入进程内 host

- **依赖**：H5、N3、N4、N5、N6、N7
- **改动面**：`apps/cli/src/runtime.ts`
- **判据**：**本线试金石**。注意 CLI 至今没有桥（H5 交回时点名）——这**不是回归**（Node 里没有
  `globalThis.isTauri`，`isTauriHost()` 在 H1 之前也一直是 false），而是本卡要补的那个缺口本身：
  在此之前 CLI 的文件 / shell 工具对模型一直不可见。
  `configureHostInvoke` 在 `registerStandardTools` 之后调用。
  **判据已按实际进度收窄**（原文要求验证「列文件 + 读 package.json」，但 read 域属 W1–W4、尚未落地）：
  当前路由表已实现 shell / git / rg / task / config 五域，本卡验的是**接线本身**——
  `hasHostBridge()` 在 CLI 启动后为 true、`run_shell_command` 能真的执行、
  未实现的 `read_workspace_file` 报的是「Node 宿主尚未实现」而**不是**「当前宿主未提供命令桥」
  （两者的区别正是这张卡的价值：桥接上了，只是某些域还没填）。
  文件工具的端到端验证随 W 线完成后补一张验收卡。跑 `pnpm exec vitest run apps/cli` + `pnpm build`
- **模型**：opus
- **状态**：DONE `8586159`。**N 线试金石通过。** 主会话独立端到端探针：装配桥之前
  `runShellCommand` 答「当前宿主未提供命令桥」，`configureHostInvoke` 之后同一调用
  `exitCode: 0` 且 stdout 含预期标记——core → 桥 → host-node → 真子进程这条链路打通。
  子 agent 自己的验证也没偷懒：判据 3 不只断 `exitCode === 0`（normalize 的兜底路径也能凑出
  体面的结果对象），而是让 shell **落一个只有真子进程做得出的痕迹**再用 `node:fs` 读回来，
  顺带证了 cwd 送对了。
  `homedir()` **保留在 CLI 侧并提升为进程内唯一权威**，经 `homeDir` 槽位注入给桥：CLI 自己就是
  那台机器，主目录这个事实由它产出；反过来向桥要等于绕一圈问自己，还凭空多一个会漂移的权威。
  **诚实标注的未验证项**：没有模型 Key、没跑真实一轮，「模型在 CLI 里看得见 shell 工具」是从
  `hostHasLocalCapabilities = hasHostBridge()` 推出来的，不是端到端观测到的。
  另：`apps/cli/package.json` 一改就必须同步 `pnpm-lock.yaml`（CI 的 desktop 作业用
  `--frozen-lockfile`，web 作业不带该 flag 所以不会暴露）。

---

## W · host-node 真逻辑区

所有 W 卡依赖 N2，彼此改动面按目录隔离，可高度并行。

### W1 · 文件读：字节分页与 contentHash

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/bytes*`
- **判据**：对齐 `workspace_read_bytes.rs` + `workspace_read_content.rs`：`offset` / `maxBytes` /
  `totalBytes` / `nextOffset` 语义逐字段一致；**`contentHash` 只在 offset 0 的首片返回，
  且截断时也返回**，8 MB 以上不返回。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `cde7899`。6 个文件 / 36 例。
  **哈希做了跨语言实跑对拍**：临时建了个只依赖 `sha2 = "0.10"`（与 `apps/desktop/Cargo.toml` 同版）
  的 crate 逐字抄 `content_sha256`，对四个样本与 Node 的 `createHash('sha256').digest('hex')`
  逐字符比对、全等，期望值钉进测试并注明来源（不是「跑一遍 Node 记下来」）。主会话复核了三个值，
  其中 `"abc"` 那条是 FIPS 180-4 公开向量。编码另有三处闭合背书：两个 guard 只收
  `sha256:<64 lowercase hex>`，core 的 `normalizeReadResult` 用同款正则过滤，而 `{:x}` 是小写 hex。
  **一个会静默错位的坑：`TextDecoder` 必须显式 `ignoreBOM: true`。** Node 默认把开头的 U+FEFF
  当 BOM 吃掉，而 Rust 的 `from_utf8` 原样保留——不设这个选项，带 BOM 的文件在 Node 侧少 3 字节，
  `bytes` / `nextOffset` 整体错位、续读从错误位置开始，**全程不报错**。而且选项名是反的
  （`true` = 不把 BOM 当特殊字符），极易写反。主会话实测确认：默认解出 2 字符，
  `ignoreBOM: true` 解出 3 字符。
  分页无损这条地基没有只靠读代码：`decodeUtf8` 做了 **4060 个样本的差分测试**，
  Rust `from_utf8` 与 Node 流式 `TextDecoder` 的分类与 `valid_up_to` 全等。
  **`nextOffset` 到文件尾时是「键不存在」**，不是 `undefined` 也不是 0；它与 `truncated` 共用
  `offset + bytes < totalBytes` 这一个判据，所以「最后一段正好读满 `maxBytes`」时 `truncated`
  仍为 false——它判的是「还剩没剩」，不是「这次有没有触上限」。
  **一处照搬但值得两边一起改的**：错误消息里用绝对路径（Rust 的 `display_path`），而返回值的
  `path` 是根相对——一次读失败会把宿主机绝对路径写进模型可见的错误文本。属跨语言对拍
  （W16/W17）该拿的决定，本卡未单方面改。

### W2 · 文件读：行寻址

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/lines*`
- **判据**：对齐 `workspace_read_lines.rs`：`startLine` / `lineCount` / `endLine` / `nextLine` /
  `totalLines`；`startLine` 与非零 `offset` 互斥的拒绝路径有测试。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `65d781a`。4 个文件 / 71 例（read 域合计）。W1 的文件一字未动。
  **⚠️ 接线时注意**：`read_workspace_file` 唯一该注册的是 `linesDispatch.ts` 的
  `createReadWorkspaceFileHandler`，**不是** `bytesRead.ts` 的字节版——挂错的症状是行参数被**静默
  忽略**（模型传 `startLine` 却拿到从头 20 KB，不报错）。
  **分派判据**：`start_line` 与 `line_count` 两个都没给才走字节模式（任一个都触发行模式，
  只给 `lineCount` 时起始行默认 1）；进了行模式后 `offset` **大于 0** 才算冲突——
  **`offset: 0` 不算传了**（Rust 是 `offset.is_some_and(|v| v > 0)`）。
  **一处 JS 直觉会写错的地方**：空文件是 **0 行**不是 1 行，而 `''.split('\n')` 给 `['']`（1 段）
  ——照着写会让 `startLine: 1` 读空文件返回空内容，而 Rust 报
  `startLine 1 exceeds the file's 0 line(s)`。子 agent 没用 `split`，另写 `lineBoundaries` 复刻
  `str::split_inclusive('\n')`。主会话已复核这个差异真实存在。
  行的其余定义：末行无换行仍算一行；`\r\n` 不额外成行、`\r` 留在所属行内容里；裸 `\r` 不是分隔符；
  行尾原样保留（这是「读出来的内容能直接当 `apply_patch` 的 oldText」的前提）。
  `nextLine` 与字节模式的 `nextOffset` **完全同款**：三字段共用 `servedAll` 一个判据，
  只在还有剩余时才存在这个键。
  行模式的 `contentHash` 只看 `startLine === 1`（截断时也给），没有字节模式那条「8 MB 以上不给」
  的分支——因为定位第 N 行必须先看过前面所有字节，超 8 MB 在读之前就整体拒绝了。
  **四处照搬并记录**：冲突文案与判据不贴合（只给 `lineCount` + 非零 offset 时报的是
  "pass either offset or **startLine**"）；错误消息用绝对路径（清单第 5 条）；
  `startLine` 越过末行是**硬错误**而字节模式 `offset == totalBytes` 返回空段，两者不对称；
  行模式每次调用整文件读入并重新切行，顺着 `nextLine` 走完大文件是 O(n²)（有 8 MB 硬顶兜着）。

### W3 · 目录列举与文件名搜索

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/list*`、`search*`
- **判据**：对齐 `workspace_read_list.rs` + `workspace_read_search.rs`：`recursive` /
  `maxEntries` / `includeHidden`；**不递归进 symlink**。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `180c89d`（与 W4 合成一枚——两卡并发追加了同两个共享文件，强行拆开会让某一枚
  带上另一卡的常量）。read 域 registrar 与接线 `26b72a7`。
  **symlink 有三种处理，不是一种**：realpath 成功且在根内 → **列出但不进去**（entry type 取自
  `lstat`，对 symlink 恒非目录，所以 `recursive: true` 也不会递归进去）；**dangling symlink
  整条不列**（canonicalize 失败）；目标越界的也整条不列（除非 `allowExternalPaths`）。
  `maxEntries` 是**硬停**：检查排在隐藏/越界过滤之后、push 之前，所以被过滤掉的条目既不计数
  也不触发 truncated；一旦触顶立即中止整个递归，不会读完当前目录。
  `includeHidden` 判据是名字以 `.` 开头，**隐藏目录整个子树跳过**——里面的非隐藏文件也不可见，
  因为那个目录压根没被进入。
  搜索的「glob」**刻意不是 glob**：四个字面前缀分支（`*prefix` 剥一个前导 `*` 后缀匹配 /
  `.ext` 后缀匹配 / `*` 在中间则**剥掉全部 `*` 做纯子串匹配、完全忽略位置** / 否则纯子串），
  全程大小写敏感。
  **两处照搬的、容易被误认成 bug 的行为**：① 目录读失败（如权限不足的子目录）中止**整条命令**
  而不是跳过那个子树；② 搜索时单个文件打开/读取失败同样中止**整个搜索**——一个 `chmod 000`
  的文件放在搜索根下的任何位置都会让整条搜索报错。这与「二进制/非 UTF-8 内容」不同，后者两边
  都是逐文件软跳过。子 agent 专门写了测试钉住 ②，并在报告里点名以免评审时误判。

### W4 · run index 分页读

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/runIndex*`
- **判据**：对齐 `workspace_read_run_index.rs`：JSONL 游标分页、`snapshot` 标识、`hasMore`。
  跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `180c89d`（与 W3 合枚，见上）。17 例。
  `snapshot` 形态是 `v1-<byteLen>-<16 hex>`，游标是不透明串 `{snapshot}:{before}`，`before` 是
  行数组的 0 基开区间上界（**不是字节偏移也不是行号**），解析用 `lastIndexOf(':')` 对齐 Rust 的
  `rsplit_once`。三种失败分开：语法非法 → `run index cursor is invalid` / `...version is
  unsupported`；语法合法但 `before` 越界 → `run index cursor is out of range; refresh history`；
  snapshot 不匹配 → `run index changed while paging; refresh history`。
  `hasMore` 为 false 时结果**不带 `cursor` 键**（不是 `undefined`），有 `'cursor' in page === false`
  的测试。
  JSONL 行切分**没有复用 W2 的 `lineBoundaries`**：那个复刻的是 `split_inclusive('\n')`（保留换行、
  给分块续读用），而 run index 要的是 `str::lines()` 语义（去掉换行、末尾 `\r` 也去、结尾换行
  不制造幻影空行）。两者只在文件末尾处不同，所以各写一份是对的。
  **一处有意的算法偏离**：没复刻 Rust 的 `DefaultHasher`（SipHash13），改用 sha256 前 16 hex。
  子 agent 给的理由是「Node 从不验证 Rust 铸的 cursor」——**这个断言过强**，主会话修正为：
  当前两个宿主的会话数据本就不共享（桌面 SQLite / Web IndexedDB），所以跨宿主 cursor 不会出现；
  **即使 P 线把持久化收敛后真的出现**，失败形态也是 `run index changed while paging; refresh
  history`，模型重新从头翻页，是设计好的降级路径而非数据损坏。结论可接受，但 **P3 落地时要回来
  重新评估这处**。

### W5 · 文件写：目标路径解析与限额

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/write/targetPath*`、`limits*`
- **判据**：对齐 `workspace_write_target_path.rs` + `workspace_write_limits.rs`。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `488fe5d`。targetPath **只有 49 行**——N2 已经把写入形态该做的四件事全移植进
  `resolveWorkspaceTargetPath`（自己 trim 加空串拒、词法直接拒 `..`、最近已存在祖先 canonicalize
  后比边界、**签名里根本没有** `allowExternalPaths`），本卡是把底座两块拼起来、不重抄判定，
  逐条对应关系写在文件头免得后人以为漏了什么。
  **判定时机**：写之前按**实测字节数**拒——既不是按声明的大小，也不是边写边数
  （`workspace_write_pipeline.rs:133-159` 先把 content 解成完整 payload 再比上限），所以调用方
  谎报大小无效，也不存在半截文件。且这个检查排在路径解析**之前**，因此超限失败的 `path` 字段
  是**原始入参**而非 displayPath——W7 拼流水线时要保住这个顺序。
  **一处直译就会错的地方**：可逆预算判定用 `Buffer.byteLength` 而非 `.length`，因为 Rust 的
  `String::len()` 是字节数；直译成 `.length` 会让 1.2 MB 的中文正文被判成「没超 1 MiB、可逆」
  再整份塞进变更日志。有专测钉住。
  **发现 Rust 一处文案与常量对不上**：`workspace_write_before.rs:44` 的
  `existing file exceeds reversible {MAX_BYTES} byte limit` 里 "reversible" 与它实际用的
  `MAX_BYTES`（8 MiB 硬顶）不符，该是 `REVERSIBLE_MAX_BYTES`（1 MiB）。**照搬未改**——
  错误文案是两个宿主的对外契约，改一个字就是制造分叉；要改该走 Rust 侧。

### W6 · 文件写：进程内与跨进程写锁

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/write/lock*`
- **判据**：对齐 `workspace_write_lock.rs`：进程内按目标路径的互斥表（含扫除阈值）+
  跨进程锁文件（`create_new` 抢占、token、心跳、stale 超时接管）。
  必须有「两个并发写同一路径被串行化」的测试。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `3d71aea`。4 个源文件 + 4 份测试 / 57 例。
  **进程内锁在 Node 里同样必要**，理由说得很准：单线程消掉的是数据竞争，消不掉**跨 await 的
  交错**。临界区是「读 before → 比 hash → 记回滚日志 → atomicWrite」，中间至少两次让出；
  A 在读 before 处让出、B 整段跑完把文件换了，A 恢复后拿**自己那次读到的** before 去比乐观守卫
  ——比的是过期快照当然通过——然后整份覆盖。**守卫存在的意义就是拦「你读完之后有人改过」，
  没有锁时它恰恰只会拿自己的旧读数自证清白。**
  API 收成 `run(key, operation)` 而非照搬 Rust 的「返回一把锁自己 lock」：Rust 靠 guard 的 Drop
  释放，JS 没有 Drop，`acquire`/`release` 写在两处时任何一条 early return 都能让那个路径永久死锁。
  `holders` **在排队时就加**（等待者也算持有者），否则扫除会删掉一条还有人排队的条目、
  后来者新建空队列就并行了。
  **stale 接管用改名而非直接 unlink**：两个等待者同时判陈旧时直接删会让 B 删掉 A 刚建好的锁；
  改名目的地带各自 token 必不同名，rename 成功的才算接管。释放时先比对 token 再删。
  **测试设计里有一条对照组**，值得后续卡照抄：主断言是「加锁后临界区 peak === 1」，但那可能
  只是因为临界区根本不让出——所以同文件里放了一条不上锁跑同一段临界区、断言 `peak === 2` 的
  对照组，外加一条「不同路径 peak === 2」钉粒度（退化成一条全局队列时前面几条依然全绿，
  只有它会红）。另做了 5 项变异验证，逐项列出哪些测试变红。
  **一处技术主张经主会话实测不成立**（做法对、理由错，代码未改）：它称「测试环境是 jsdom，
  全局 `setInterval` 返回的 number 上没有 `unref`，真调是当场 TypeError」，实测本仓库的
  vitest + jsdom 下全局 `setInterval` 返回的是 `object/Timeout/unref=function`。从 `node:timers`
  显式导入这个做法仍然正确——它不依赖环境全局是什么，换 happy-dom 或真浏览器环境就会坏。
  **一处它自己标注「测试盯不住」的改动**：锁年龄算成 `Date.now() - Math.floor(mtimeMs)`，
  因为两个读数精度不同（`Date.now()` 只有毫秒、`mtimeMs` 带纳秒小数），直接相减会得到
  「未来的 mtime」。实测去掉 floor 跑 5 遍仍全绿——20ms 轮询盖住了它——所以理由只能写在注释里。
  **一处 Rust 文案未移植**：`failed to initialize archive lock heartbeat` 对应 Rust 的
  `file.try_clone()` 失败，而 Node 侧初始写与心跳共用同一个 `FileHandle`、没有 clone 这一步，
  留着就是一句永不出现的文案。其余四句逐字保留。
  **给 W7 的交接**：`release()` 必须由调用方在 `finally` 里调（JS 没有 Drop），是那一层的责任。

### W7 · 文件写：乐观守卫与主流水线

- **依赖**：W5、W6
- **改动面**：`packages/host-node/src/workspace/write/guard*`、`pipeline*`
- **判据**：对齐 `workspace_write_guard.rs` + `workspace_write_pipeline.rs`：
  read-verify-write，`contentHash` 不匹配时拒绝覆盖并返回可操作错误。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `30f95ff`。13 个源文件 + 10 份测试 / 121 例（write 域合计 178）。全树最大一张。
  流水线 13 步的顺序表已在报告里逐条对齐 Rust，其中三条是**顺序本身就是契约**：
  content 解成完整字节比上限**排在路径解析之前**（所以超限回执的 `path` 是原始入参，
  有用例拿 `'./out.txt'` 钉住，把限额挪到后面当场红）；读 before **只读一次**、守卫/日志/摘要
  三方共用；`prepareChangeSet` 记账在落盘之前。**失败要撤的动作只有一个**——已预留的变更集
  （写盘或 executable 失败 → `discardPreparedChange`，dry run 同样丢）。
  **守卫不匹配给的是结构化回执不是 rejection**：`expectedOldContent` 不匹配时带
  `expected_bytes` / `current_bytes` / `first_mismatch_byte` / `expected_trailing_lf` /
  `current_trailing_lf` 五个数字，**全按 UTF-8 字节算**——`.length` 直译会让中文内容报出实际值
  1/3 的位置。`expectedContentHash` 不匹配则**不回传当前实际 hash**，照搬 Rust。
  **子 agent 纠正了自己初稿的一处错误说法**：不是「先 chmod 等于什么都没做」，准确版本是
  `create` 时文件还不存在会 ENOENT、`overwrite` 时先 chmod 反而会被 `atomicWrite` 原样继承——
  所以「写完之后」是唯一对四种模式都成立的位置。
  跨进程归档锁的 `release()` 包在临界区**外面**的 `finally` 里，异常/结构化拒绝/正常返回三条
  路径都过。三次变异验证：去掉 `withPathLock` → 并发用例变成「两个守卫都通过」当场红；
  限额挪到路径解析之后 → path 用例红；去掉写失败时的 discard → 孤儿账用例红。
  **base64 的 seam 刻意留成结构化拒绝而不是用 `Buffer.from(x,'base64')` 顶**（W8 接手）：
  后者对非法字符**静默跳过**，`"not base64!"` 会被解成垃圾字节写进磁盘，比拒绝糟。
  **两处 Node 侧无对应出口**：`mark_change_applied` 失败 Rust 打 warn、Node 只能吞（回执仍 ok，
  账停在 `prepared`，回滚照样认）；`WorkspaceWritePerf` 的分阶段耗时日志整段未移植。

### W7b · 把 change summary 合并进 workspace/common

- **依赖**：W7（`30f95ff`）、W13（`b169754`）
- **改动面**：新建 `packages/host-node/src/workspace/common/changeSummary*`；删除
  `workspace/write/changeSummary.ts` + `changeSummaryDiff.ts` 与 `workspace/patch/changeSummary.ts`
  + `lineDiff.ts`；改两域的 import 与测试
- **判据**：**来源：W7 与 W13 并行时各自实现了一份 `compute_change_summary`。** Rust 侧那个住在
  `workspace_common.rs`、被 write 与 patch 共用（`workspace_patch_pipeline.rs:93`），两卡都不敢在
  common 建同名文件（后落笔的会静默盖掉先落笔的），所以各留了一份。
  **两份的行为已确认一致**（主会话复核）：W13 在对照 W7 时发现自己的 `splitLines` 无条件剥末尾
  `\r` 是错的、已改成与 W7/Rust 同款（只剥真正位于换行符之前的）。合并时仍要**逐条对照再落笔**，
  别默认哪份对——两份的导出面不对称（patch 版导出 `splitLines`，write 版是私有函数）。
  合并后两域的测试都要仍然全绿，且 `computeChangeSummary` 的用例合并去重而不是删掉一半。
  跑 `pnpm exec vitest run packages/host-node` + `node scripts/check-boundaries.js`
- **模型**：sonnet
- **状态**：DONE `dd3f2e4`。128 增 311 删（净减 183 行），git 识别出了文件移动。
  **逐条对照的结论**：算法、常量（`DIFF_MAX_LINES=60`、`DIFF_LCS_BUDGET=800×800`）、渲染格式、
  返回形状、**LCS 回溯取等号的方向**（`>=` → 优先记 remove）两份完全相同；唯一实质差异就是卡面
  已知的 `splitLines` 尾部 `\r`，而提交时两份都已带修复，所以合并时行为已一致。
  公开面取**并集**：`splitLines` 与 `DiffTag` 现在导出（此前只有 patch 版导出），理由写在
  `lineDiff.ts` 头——`\r` 那个边界够微妙，值得能直接单测而不必绕经 `computeChangeSummary`。
  测试 26 → 23，**去掉的 3 条是真重复**（941 = 944 − 3，账对得上），且每对重复都保留了断言更强的
  那条：全对象 `toEqual` 的、检查确切渲染串的、断言更多字段的。两份各自独有的用例全部保留，
  包括两条 LCS 预算超限用例（801 行与 1200 行断言的性质不同：删-加顺序 vs 截断长度与文案）。

### W8 · 文件写：base64 二进制写入

- **依赖**：W7
- **改动面**：`packages/host-node/src/workspace/write/base64*`
- **判据**：对齐 `workspace_write_base64.rs`：解码失败明确报错，不写出半个文件。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `911fa14`。2 个新文件 + 3 处改动，write 域 178 例。
  **`Buffer.from(x, 'base64')` 的危害经主会话实测确认，比预想更糟**：
  `Buffer.from("not base64!", "base64")` **不报错**，产出 6 个垃圾字节 `9e8b5b6ac7ba`。
  模型若忘了编码直接传原文，这 6 字节就会被写进磁盘而回执说成功。
  **做法是逐字状态机移植**，不是「regex 预校验 + Buffer.from」也不是「解码后 round-trip 比对」：
  前者让校验规则与解码逻辑分成两套、会各自漂移；后者仍要先 `Buffer.from` 把垃圾解出来再发现
  不一致。状态机单遍消费，非法符号（含落在非尾部的 `=`，如 `"Z=g="`）在**任何字节产出之前**
  就抛，不存在能让非法字符抵达输出缓冲的代码路径。
  alphabet 是标准 RFC 4648（`-`/`_` 按非法字符拒），padding **可选**但一旦出现则去空白后总长
  必须是 4 的倍数、尾部 `=` 不超过两个；ASCII 空白先剥（含 `\x0C` 但**不含** `\v`，对齐 Rust 的
  `is_ascii_whitespace`）。测试覆盖非法字符、URL-safe 字符、padding 位置错、padding 长度错、
  截断输入、含空白的合法输入、空串（合法，解出零字节）。
  **限额比的是解码后的字节数**（`payload.bytes.length`），且仍在路径解析之前——W7 那条
  「超限时 `path` 是原始入参」的用例原封不动仍通过。
  `recoverPayloadText` 在 base64 路径下的作用：解码后若字节恰好是合法 UTF-8 且无内嵌 NUL，
  `text` 就是那段文本、变更日志照常记并能出行级 diff；否则 `text` 为 `null`，写入照样成功但
  标记为不可逆、无 diff。

### W9 · 文件写：归档 compaction

- **依赖**：W7
- **改动面**：`packages/host-node/src/workspace/write/compaction*`
- **判据**：对齐 `workspace_write_compaction.rs`。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `c219b7a`。纯逻辑（路径判定 / 节流判定 / JSONL 去重）与 IO 编排分两个文件，
  是为了 W16/W17 能直接拿纯函数对表，不必为了对拍在磁盘上真建一份归档。
  **卡面原话「压实失败大概率是安静跳过（压实是优化不是正确性）」是错的**，本卡实测推翻：
  `maybe_compact_subagent_index` 的 `Err` 在 `workspace_write_pipeline.rs:206` 被折成
  `Ok(error_result(...))`，与「守卫不匹配」「超限」走的是同一条结构化拒绝路径——**压实一失败，
  这次 append 的新内容根本不会被追加**。我那句描述的其实是 seam 尚未实现时的后果（W7 留的
  TODO 注释确实是安静少一步），不是压实实现后失败的行为。Node 侧照搬拒绝语义。
  主会话独立复核：把 seam 那两行注释掉，`pipelineCompaction.test.ts` 3 例转红（含拒绝语义那条），
  证明覆盖非空洞。Rust 的 `is_some_and(|age| age < THROTTLE)` 链在 mtime 位于未来时
  `elapsed()` 返回 `Err` → `None` → **不节流**，与 `isCompactionThrottled` 的负年龄分支一致。

### W10 · 删除路径

- **依赖**：N2、W14
- **改动面**：`packages/host-node/src/workspace/delete/`
- **判据**：对齐 `workspace_delete.rs`（461 行）。删除是不可逆动作，**必须先进 change journal
  再执行**，否则 `revert_workspace_change` 拿不回来。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `b6be655`（registrar 接线 `ba3d939`，与 pathOps 同批）。9 个源文件 + 7 份测试 / 61 例。
  **账里不存内容**：条目只记一条根相对路径（`movedPaths`），内容整份**复制**进
  `<journal>/<changeId>.payload`（删目录时那是一棵完整目录树，含权限位）。
  上限由递归预扫判：`MAX_ENTRIES = 20000`（含目录本身与全部子孙）、`MAX_BYTES = 512 MiB`
  （**只累计文件**，目录项自身 size 不计），边界是 `>`。**超限是拒绝删除，不是标记不可逆**
  ——10 万文件的目录在第 20001 个条目上就停手，一个字节不删、一条账不记。
  **symlink：链接和目标都不删，整次拒绝**，三道防线（逐段 lstat 含最后一段 / pipeline 再判一次
  只在 TOCTOU 窗口可达 / 递归预扫时树里任何一处软链拒整次）。**什么都不记**——拒绝全部发生在
  `prepareDeletedPathChange` 之前，日志目录里连一条 prepared 都不会有。
  **删除侧没有「不记账直接删」这个口子**（write 域有）：缺 `change_context` 直接 `ok:false`。
  理由写在源码顶部——写入的最坏情况是旧内容没了而新内容还在，删除的最坏情况是那份内容
  从世界上消失。
  三条补偿路径已实现，但**后两条没有测试覆盖并已诚实标注**：要在两次系统调用之间注入失败，
  没有 DI 就 induce 不出来（chmod 类做法在 root 容器里失效），Rust 侧同样没测。
  **主动核对了 Rust 问题清单里哪些条适用于本域**（主会话复核）：第 11 条**不适用**——
  `workspace_delete.rs:280` 的 `relative_path` 是**条件式**的（`if MAIN_SEPARATOR == '/'`），
  与读写侧一致、与 patch/path_ops 那两处不一致，本域站读写侧；第 3 条无关（删除走
  `movedPaths` + payload，全程不产生 `FileSnapshot`）。

### W11 · 复制与移动路径

- **依赖**：N2、W14
- **改动面**：`packages/host-node/src/workspace/pathOps/`
- **判据**：对齐 `workspace_path_ops.rs`：源/目标双向 confinement、目标已存在的处理、
  进 change journal。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `699c8e1`。5 个源文件 + 3 份测试 / 53 例。
  **又一处 Rust 自成一体的路径解析**（主会话复核：`workspace_path_ops.rs` 只从 common import 了
  `resolve_workspace_root`，`resolve_source`/`resolve_destination` 是它自己的局部函数）——
  而且**比共享的两个形态更严**：它们**直接拒绝绝对路径与 `..`**，而共享的读/写形态是允许写、
  再靠 realpath 断案。至此 Rust 侧已有三处自成一体的路径解析（write / patch / pathOps），
  每处的严格程度都不同。
  **目标已存在**：copy 与 move 判据相同，用 `symlink_metadata`（不跟随的 lstat）查原始拼接路径，
  **dangling symlink 也算存在**；Rust 没有 force/overwrite 参数，故没加。
  **EXDEV 不是特判**：Rust 的 `move_path` 不区分错误类型，**任何** `fs::rename` 失败都回落到
  copy + delete-source，且 delete-source 再失败时清理掉已复制的那份。这段 W14 已经移植过
  （`change/pathOpsMove.ts`），本卡直接复用。
  **目录递归但日志只记一条**：不管子树多大，copy 记一条 `TrackedPath{path, fingerprint}`
  （进 `createdPaths`）、move 记一条 `RelocatedPath{source, destination, fingerprint}`
  （进 `relocatedPaths`），fingerprint 递归哈希整棵子树的结构与内容。
  **`MovedPath` 与本卡无关**——它专属 `prepareDeletedPathChange`（W10 的可恢复删除载荷迁移）。
  **发现一处结构上不可达的死分支**：`source === destination` 的早退检查——目标解析已要求不存在，
  任何会 canonicalize 成已存在源的路径会先被「目标已存在」拦下。照搬保留（无害）。
  第 11 条已知问题（展示路径无条件 `\` → `/`）在本模块照搬，并有专门的测试钉住。

### W12 · patch：路径解析与 stage

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/patch/path*`、`stage*`
- **判据**：对齐 `workspace_patch_path.rs` + `workspace_patch_stage.rs`。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `9939a68`。7 个源文件 + 7 份测试 / 85 例。
  **纠正卡面一个预设**：「目标必须已存在吗」**不在路径层判**——路径解析对四个变体完全一样，
  存在性要求全在暂存规则里按 `FileState` 判。
  四个 operation 变体已逐个核对（`type` 取值 snake_case、载荷字段 camelCase，两层不同款）：
  `add_file`(path, content | executable)、`delete_file`(path | oldContent, expectedContentHash)、
  `replace`(path, oldText, newText | expectedReplacements)、
  `overwrite_file`(path, content | oldContent, expectedContentHash, executable)。
  **两处直译就会静默改写用户内容**（主会话已复现）：
  ① `replace` 必须用 `split().join()` 而**不是** `replaceAll`——后者会把 newText 里的
  `$&` / `$1` / `$'` 当替换模式展开。实测模型想写 `"price is $& and $1"`，`replaceAll` 给出
  `"price is FOO and $1"`（`$&` 被展开成匹配到的原文），**正文被静默篡改**。
  ② `changed_paths` 的排序是 Rust `sort_by_key(String)` = **UTF-8 字节序**，而 JS 默认 `sort()`
  是 UTF-16 码元序，遇增补平面字符顺序相反（实测 `["😀.txt","\ufffd.txt"]` vs
  `["\ufffd.txt","😀.txt"]`）。用 `Buffer.compare`。
  **stage 的中间态**：`Map<绝对路径, {initial, current, executable}>`，`initial` **整批只读一次**
  （第二次读会看见批内前面操作以为改过的内容，而磁盘并没变，`initial` 就不再是回滚依据）；
  操作只改 `current`、磁盘一字不动，所以「任一失败整体不写」是**根本没进落盘那步**而不是回滚。
  真回滚只发生在落盘中途失败（磁盘满/权限），靠 `initial` 逆序还原——那是 W13 的事。
  **越界但合理**：卡面把 `limits*` 划给 W13，但 stage 每个分支第一步就要用那三个校验器，
  故一并实现；`guard.ts` 与 `operation.ts` 树里没被任何卡认领，也一并落了。
  给 W13 的接口面与「校验入参 → 解析路径 → 读磁盘 → 算新状态」的顺序契约已在报告里交代。

### W13 · patch：应用流水线与限额

- **依赖**：W12、W14
- **改动面**：`packages/host-node/src/workspace/patch/pipeline*`、`fs*`、`limits*`
- **判据**：对齐 `workspace_patch_pipeline.rs` + `workspace_patch_fs.rs` +
  `workspace_patch_limits.rs`：全部 hunk 成功才落盘，任一失败整体不写。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `b169754`。8 个源文件 + 6 份测试 / 146 例。W12 的文件一字未改。
  **「任一失败整体不写」的主力不在回滚，而在根本没进落盘那步**（W12 的暂存设计），
  子 agent 用**退化探针表**证明测试不是摆设——四种退化各自让哪些用例变红：
  `if (rejected.length > 0)` 改成 `if (false)` → 3 条红；删掉 rollback 调用 → 3 条红；
  `applyExecutableBit` 挪到 `writeTextFile` 之前 → 2 条红；`commitChanges` 挪到
  `prepareChangeSet` 之前 → 1 条红。
  **失败注入不用 mock**，全是可控的真实文件系统状态：把目标路径的父段先建成**文件**
  （`zz` 是文件 → `zz/x.txt` 暂存得过、`mkdir` 时才炸）。还原失败那条更绕一层且在流水线里可达：
  `delete_file d` + `add_file d/x/y.txt` + `add_file zz/w.txt`——提交时删掉文件 `d`、`mkdir -p`
  把 `d` 变成目录、第三条炸；还原时 `d` 的位置已是目录，`rename` 报 EISDIR，于是两句话都留下。
  **还原是逆序的**（同一批里「先删文件 `d`、再在 `d/` 下建新文件」的还原必须先删 `d/x` 再写回 `d`），
  还原自身失败**不遇错即停**、逐条收集后汇总成 `"{原始错误}; failed to rollback partially applied
  patch: {逐条}"`（病因在前、磁盘现状在后）；全部还原成功时错误里不出现后半句。
  **executable 先写后置**：`atomicWrite` 会把**原文件**权限回填到临时文件再 rename，先置执行位
  会被那次回填整个盖掉。置位规则 `mode | ((mode & 0o444) >> 2)`（0644→0755、0600→**0700** 不是
  0711），清位无条件 `& ~0o111`，Windows 上整个函数 no-op。
  变更日志 `prepareChangeSet` 在 `commitChanges` **之前**；落盘失败 → `discardPreparedChange`
  不留孤儿账；成功 → `markChangeApplied`，而**它失败不让整条命令失败**（文件已改完，报错会让
  调用方以为没发生），照搬 Rust 的 `log::warn!` + 继续。
  **子 agent 在与 W7 对照时发现并修了自己的一个真 bug**（主会话已复核实现与回归测试）：
  `splitLines` 原来无条件剥末尾 `\r`，而 Rust 的 `str::lines()` 是先 `strip_suffix('\n')`、失败就
  整段原样返回——**末行没有换行符时它结尾的 `\r` 属于内容**（`"a\r"` 是一行 `"a\r"`）。
  无条件剥的后果是「以 `a\r` 结尾（无换行）」与「以 `a` 结尾」被判成同一份内容，
  **一次真实改动从 diff 里消失**。
  **一处判断不照搬**：`changes[]` 与日志入参里查不到暂存状态时它**抛错**，Rust 是 `filter_map`
  静默跳过——那种状态构造上不可能，但真发生时静默跳过意味着「文件照样被落盘、却不进
  `changedFiles` 也不进变更日志」= 一次撤不回来的改动且不报错。已在 `pipeline.ts` 注释点名。

### W14 · change journal：类型与写入

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/change/types*`、`prepare*`
- **判据**：对齐 `workspace_change_journal_types.rs` + `_prepare.rs`。journal 目录取
  Tauri 的 `app_data_dir()/workspace-changes` 同款路径，使套壳后与桌面版共用同一份日志。
  跑该目录 vitest
- **模型**：opus
- **状态**：DONE `be30709`。6 个测试文件 / 74 例，最大 221 行。
  journal 目录**逐层查证**而非照记忆写：tauri `path/desktop.rs:247` → `dirs::data_dir()` →
  `dirs-6.0.0/src/{mac,win,lin}.rs` → `dirs-sys` 的 `home_dir()`。三平台推导做成纯函数并
  **按目标平台选 `path.win32` / `path.posix`**——否则在 macOS 上测 Windows 分支会拼出正斜杠，
  测试钉住一个生产里不存在的形状。
  **三条为对拍钉死的约定**（各有测试）：可空字段一律 `T | null` 而非 `T?`（`JSON.stringify`
  会把 `undefined` 的键整个丢掉，Node 写的条目比 Tauri 写的少几个键且不报错）；对象字面量的
  书写顺序 = Rust 字段声明顺序（serde 按声明序、`JSON.stringify` 按插入序，对齐了才逐字节相同）；
  hash 走 UTF-8 字节。
  `createdAt` 用 `performance.timeOrigin + performance.now()` 而非 `Date.now()`：批量回滚按它排序
  （`_batch.rs:45` 写着「Journal creation order is authoritative」），毫秒精度会让同一毫秒内的
  两条账并列。
  **复用了 `atomicWrite`**（与 N7 不冲突：N7 不能复用是因为权限语义相反，日志这边没有那个冲突），
  并借此白拿三样，其中一样是**修 Rust 的欠账**——Rust 的 `write_entry` 是 `fs::write` + `rename`、
  没有 fsync，而这份文件是「这次改动可撤销」的唯一凭据，掉电后目录项指向空洞内容 = 那次改动
  永久撤不回来且不报错。所有可观测输出逐字相同。
  **⚠️ 留给 W15 判的跨宿主隐患**：`workspaceRoot` 存的是 canonicalize 后的绝对路径、回滚时逐字
  比对。Rust 的 `fs::canonicalize` 在 Windows 上给 verbatim 前缀（`\\?\C:\…`），Node 的
  `realpath` 给 `C:\…`——**套壳后同一个 workspace 会被判成 `workspace_mismatch`**。
  POSIX 上两者一致，所以本卡没动。

### W15 · change journal：批次与 revert

- **依赖**：W14
- **改动面**：`packages/host-node/src/workspace/change/batch*`、`revert*`、`pathOps*`
- **判据**：对齐 `_batch.rs` + `_revert.rs` + `_path_ops.rs`：`dryRun` 语义、批次内顺序、
  部分失败的报告形态。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `8a9a36e`（registrar 接线 `0762d59`）。17 个源文件 + 9 份测试 / 62 例，
  change 域合计 160 例。全树最大的一张卡。
  **`dryRun` 是「预演」不是「只校验」**：跑完整的四类冲突检测，只在最后一步分岔；
  `restoredFiles` 与真跑**逐字相同**（有测试直接对比两次结果的该字段）。批量的 dryRun 还会跑完整
  的逆序模拟，所以「单条预演冲突、整批预演通过」这种情况能正确报出来。
  **批次顺序不信入参**：按 `createdAt` 升序稳定排序后逆序执行。测法值得记——**故意用错误的
  入参顺序** `['ord-2','ord-1']` 退同一文件的两次连续改动，断言最终内容是 `a-1`；顺序若跟着
  入参走会停在 `a-2`（先退老的写回 a-1，再退新的又写回 a-2）**且全程 `ok: true`**，
  正是「说成功了其实写坏了」的形态。
  **三种失败报告形状不同**：预检冲突（`conflicts` 非空、`error` 为 null，一条盘都不碰）／
  执行中途漂移（`error` 非空、`conflicts` 为空，且已做过的每一步按组倒序补回去）／
  批量中途失败（逐条 `reapplyChangeSet` 回去，两个字段都空）。失败条目**一律不 `updateStatus`**
  ——`writeEntry(status:'reverted')` 是执行的最后一步，任何失败都在它之前返回，状态停在 `applied`、
  整批还能重试。有测试断言失败后磁盘内容与 `entry.status` 双双回到「没退过」。
  **Windows canonicalize 前缀判定为 T 线的事**（理由写在 `revertChangeSet.ts` 文件头，不是默默忽略）：
  ① 单边归一化只修一半——Node 认了 Rust 写的账、Rust 仍不认 Node 写的账，症状从「全都撤不了」
  变成「有时撤得了」，更难查；② 病根在写入侧不在比较侧，正确修法是统一写进日志的形态；
  ③ 现状 Node 自洽、POSIX 两边一致，风险窗口只存在于「Rust 写、Node 读」的过渡期，而那个过渡期
  就是 T 线本身。
  **照搬并记录三条**：`readSnapshot` 在执行循环里失败**不补偿**（`_revert.rs:127` 的 `?`）——
  前几个文件已还原、条目状态未改、调用方收到异常而非回执，窗口极窄但是「回滚了一半」的真实路径；
  `created-N.payload` 成功回滚后永久留在日志目录、无回收路径（它是批量补偿的唯一依据）；
  `content: null` 的歧义（清单第 3 条）在 `snapshotIo.ts` 头写明这一层分辨不出「真的不存在」
  与「条目被截断」。
  Node 侧三处实现选择（可观测行为与 Rust 一致）：目录项排序走 `Buffer.compare` 的 UTF-8 字节序
  （Rust 排的是 `OsString`）；解码 `{ fatal: true, ignoreBOM: true }`（默认会剥 BOM，
  于是带 BOM 的文件 hash 与 Rust 对不上、回滚被误判成冲突）；`chmod` 传完整 `st_mode` 不做
  `& 0o777`（掩掉会静默丢失 setuid/sticky）。

### W16 · Rust↔TS 对拍 fixture：patch 与 change journal

- **依赖**：W13、W15
- **改动面**：新建 `packages/host-node/fixtures/`（共享 JSON）+ 两侧的 fixture 驱动测试
- **判据**：**已知一处两边不该对齐的差异**（N2 交回，主会话已在 `workspace_common.rs:143` 证实）：
  Rust 对每个读取块单独跑 `String::from_utf8_lossy`，多字节字符被块边界劈开时两半各自变成 `�`
  ——中文输出只要跨块就会坏字。Node 侧用 `StringDecoder` 把块尾不完整的序列留到下一块，
  对未被劈开的合法 UTF-8 两边逐字节相同，被劈开时 Node 给的是**正确**结果。
  **本卡撞上这条时该改的是 Rust 侧**，不是把 Node 改回去凑对拍。理由记在
  `packages/host-node/src/workspace/common/index.ts` 的文件头。
  **新范式卡，会被 W17 抄。** 从 Rust 的 `workspace_patch_*_tests.rs` 与
  `workspace_change_journal_batch_tests.rs` 抽出输入/期望为语言无关的 JSON，
  Rust 与 TS 各写一个驱动器跑同一组。两侧全绿；故意改一处 TS 实现能让对拍变红
  （证明它真在比对，不是空跑）。跑 `pnpm exec vitest run packages/host-node` +
  `cargo test --manifest-path apps/desktop/Cargo.toml`
- **模型**：opus
- **状态**：DONE `2036ec7`。4 组 fixture / 53 例（change-summary 9、patch-stage-rules 23、
  patch-pipeline 14、change-batch-revert 7），两侧各一个驱动器；Rust 侧 4 个 `#[test]` 各遍历一组。
  范式与 schema 写在 `packages/host-node/fixtures/README.md`（**W17 照这份加**）。
  **对拍口径的三条判据**（W17 必读，都在 README 里）：① **比对解析后的结构不是字符串**——serde_json
  无 `preserve_order`，键顺序不算差异；② **键的有无算差异**——Rust 的
  `skip_serializing_if = "Option::is_none"` 让键整个消失，而无该属性的 `Option` 序列化成显式 `null`，
  TS 侧先过一遍 `JSON.parse(JSON.stringify(v))` 让 `undefined` 键消失来对齐，「少写一个 `null`」才暴露得出来；
  ③ **错误文案里带 OS 错误串的用例一律不进 fixture**——Rust 是 `No such file or directory (os error 2)`、
  Node 是 `ENOENT: … open '…'`，那是两个运行时的差异不是移植 bug，靠两侧 colocated 测试盯。
  UTF-8 分块那条豁免的落法：**不构造「一次读取跨过块边界的多字节字符」**，撞上就是撞上豁免。
  主会话独立验收（本卡被中途打断，判据由主会话补跑）：① 变异 `changeSummary` 的 `@@` 起始行号
  去掉 `+1`，**8 例转红**且横跨纯函数组与带 IO 的流水线组；② 更强的一次——直接把**共享 fixture**
  的一个期望值改成 999，**Rust 与 TS 同时转红**（Rust 报 `1 / 9 例与 Rust 实现不一致` 并打印
  actual/expected，TS 报 `1 failed | 8 passed`），证明两侧驱动器**确实在读同一份文件**、不是各跑各的。
  `parity_fixtures.rs` 的 `load_cases` 对「读不到 / 不是合法 JSON / 没有 cases 数组 / 空数组」一律 panic
  ——对拍没跑起来必须响亮失败，不能静默变成 0 例通过。
  **新发现**：`compute_change_summary` 在 Rust 侧**原本零测试**（`workspace_common.rs` 没有 `mod tests`），
  这组 fixture 既是对拍也是它的第一份测试。另：W16 独立撞上了 S1 记过的
  `new URL('字面量', import.meta.url)` 被 Vite 改写那条坑——两张卡各自踩到一次，结论已写进
  `parityFixtures.testHarness.ts` 注释。

### W17 · 对拍 fixture 扩到写锁与读限额

- **依赖**：W16
- **改动面**：`packages/host-node/fixtures/` 增量 + 两侧驱动器
- **判据**：照 W16 的范式覆盖 `workspace_write_*_tests.rs` 与
  `workspace_read_*_tests.rs` 的限额/边界用例。两侧全绿。
  **`packages/host-node/fixtures/README.md` 是本卡的规格书**——本卡是它的第一个使用者，用起来
  别扭的地方就是它的缺陷，顺手补。两个本卡特有的坑：① **写回执是 snake_case**
  （`WorkspaceWriteResult` 没有 `rename_all`），而读/patch 是 camelCase，期望值按各自实际形状写
  （findings #12，README 点名说主要影响本卡）；② **UTF-8 分块豁免正好落在读域**——fixture 一律
  不构造「一次读取跨过块边界的多字节字符」，读域限额用例很容易无意中造出来。
- **模型**：sonnet
- **状态**：DONE `b0b1dfa`。2 组 / 24 例（write-limits 9、read-limits 15）。
  两处**刻意缩小**并说明了理由：真撞 `REVERSIBLE_MAX_BYTES` 要往 fixture 里塞约 1 MB 字面量，
  改用「二进制内容经 base64 写入被标记不可逆」作廉价代理覆盖同一对字段；Rust 原测试的 20000 次
  重复缩到 50 次，避免一份 ~380 KB 的 fixture。
  主会话独立复核：改 `read-limits.json` 的一个期望值，**Rust 与 TS 同时转红**
  （`1 / 15 例与 Rust 实现不一致` / `1 failed | 14 passed`）。
  给 README 补了几处它自己用起来别扭的地方，其中一条是主会话没想到的：被测函数**不必是
  `pub(super)`**，Rust 的可见性本来就延伸到后代模块（`read_workspace_file_blocking_at_lines`
  就是全私有的）。**卡面标题「写锁与读限额」是错的**——仓库里根本没有专门的写锁 `_tests.rs`，
  判据与文件 glob 指的都是写**限额/边界**；它按判据做，判断对。
  留下两个 scratch 脚本产物（`binary.dat` / `medium.txt`，一个脚本漏传 `workspaceRoot` 默认到
  `process.cwd()` 造成），按纪律没自删、报告上来由主会话核对后清理。

---

## S · server HTTP 外壳

### S1 · server 包骨架、health 与静态托管

- **依赖**：N1
- **改动面**：新建 `apps/server/`；`tsconfig.app.json` 的 **`include`**（**不是** alias / paths，理由见状态）
- **判据**：`GET /api/health` 返回版本与宿主标识；`GET /*` 服务 `apps/web/dist`（缺失时给出
  可读提示而不是 404 裸页）。跑 `pnpm exec vitest run apps/server` + `node scripts/check-boundaries.js`
- **模型**：opus
- **状态**：DONE `f761fa4`。17 个文件 / 34 例，`node:http` 零新依赖（这个进程随后要经 `/api/invoke`
  执行 shell 与读写文件，依赖树里每多一个包都是同一份权限的分享者）。产物缺失回 **503** 不是 404：
  缺的不是某个资源、是服务器没准备好，此刻 `/api/health` 仍 200，两者合起来说的是同一件事。
  **卡面「改动面」那行原写「同步 `vite.config.ts` alias 与 `tsconfig.app.json` paths」，对 app 层不成立**
  ——`apps/cli` 两处都没有条目，app 不按包名被 import。真正必须改的是 `tsconfig.app.json` 的
  `include`。加 alias/paths 会凭空造出一条「可以 `import '@einfach-agent/server'`」的公开面。已改卡面。
  **路径禁闭两道，各挡各的**：① 词法（`staticPath.ts`，纯函数）解码**恰好一次** → 按 `/` 和 `\` 切段
  → 见 `..` 即拒；防二次编码的全部机制就是「只解一次」（`%252e%252e%252f` 解一次是字面文件名 →
  404），且下游拿到的是**分段数组不是字符串**，结构上没有再解一次的入口。② 落盘 realpath 后用
  `path.relative` 判包含（不是 `startsWith`——N2 记过 `/ws-evil` 的前缀陷阱），挡软链接。
  主会话独立复核：起真 server + 根外放金丝雀文件，用 `http.request({path})` 逐字写请求行打 12 种
  穿越形态（含大写 `%2E`、`%5c`、二次编码、`%00`、`%c0%af`、`%zz`），**无一泄露**。

  **两条新范式事实（S4 / B 线同样成立，别重蹈）**：
  · **`new URL('字面量', import.meta.url)` 在本仓库不能用**——Vite 的 assetImportMetaUrl 会把它当
  资源引用静态改写，Vitest 下拿到的不是 `file:` URL，`fileURLToPath` 当场抛
  `The URL must be of scheme file`。改用 `resolve(dirname(fileURLToPath(import.meta.url)), …)`。
  · **`new URL(request.url, base).pathname` 会把穿越判定的权威劈成两处**。主会话实测确认：
  `new URL('/%2e%2e/secret.txt', base).pathname === '/secret.txt'`——URL 规范把 `..` / `.%2e` /
  `%2e.` / `%2e%2e` 四种都算 dot segment 就地消掉，而 `%2f` / `%5c` 又原样留着。不是漏洞（弹栈到
  根就停），但一半攻击流量在到达判定层之前已被改写成合法路径，日志里表现为「客户端从没请求过的
  路径 404 了」。故新增 `requestPathname.ts` 取原样路径。连带结论：**测这类用例不能用 `fetch`**
  （它同样归一），脚手架用 `http.request({ path })` 把字符串逐字写进请求行。
  `check-boundaries.js` **不需要为新包加条目**：`capabilityPackages` 只管 `packages/*`，apps 层由
  `outsideCoreFiles()` 扫 `apps/*/src` 自动纳入。

### S2 · token 认证、Origin 校验与 loopback 绑定

- **依赖**：S1
- **改动面**：`apps/server/src/auth*`，外加 `requestRouter.ts` 与 `createServer.ts` 的接线（本卡独占）
- **判据**：**安全边界卡。** 默认只绑 `127.0.0.1`（复用
  `scripts/model-preview-relay.ts` 的 `isLoopbackAddress` 判据）；每次启动生成随机 token，
  `/api/*` 全部校验；校验 `Origin` 拒绝跨站。必须有测试证明：**无 token 的请求被拒**
  ——否则本机任何网页里的 JS 都能 POST 一条 `run_shell_command`。
  跑 `pnpm exec vitest run apps/server/src/auth`
  **绑 127.0.0.1 只挡住局域网里的别人，挡不住本机浏览器里的任何一个标签页**：简单请求不触发预检、
  `<form>` POST 连 CORS 都不涉及、DNS rebinding 还能让 Origin 变成攻击者自己的域名。三道各挡各的，
  本卡要写明哪道挡哪种。另需自行裁决：health 是否豁免 token（B1 的宿主探测发生在拿到 token 之前，
  不豁免会把 server 宿主误判成 static）、无 `Origin` 头的请求怎么处置、`Host` 头校不校。
- **模型**：opus
- **状态**：DONE `fd614b4`。4 源 + 6 测试 / 55 例。判定顺序 **对端地址 → Host → Origin → token**，
  token 放最后是刻意的：跨站请求在拿到任何「token 对不对」的回音**之前**就被拒，那道门后不存在
  可用来试探 token 的差异。**卡口在路径分派之前**，所以未认证的调用方连「有哪些接口存在」都问不出来
  ——`/api/invok` 拿到的是 401 而不是 404。
  **裁决一·health 豁免 token**（仍校验对端地址与 Origin/Host）：失败形态不对称——要 token 的话
  B1 探测拿 401 → 落到 `static` → 模型看不到任何本机能力，且界面上不会有一句话提到令牌；豁免的话
  探测恒成功、第一条真实 invoke 拿 401，B2 能说准话。**响亮地失败优于静默地正确。**
  **裁决二·无 `Origin` 头放行**：判据不是「缺席可信」而是「缺席之后还剩什么」——唯一危险的缺席形态
  （rebinding 下的同源 GET）已被 Host 挡住，于是它只降级成「token + Host」，与 curl 待遇一致。
  `Origin: null`（沙箱 iframe / `file://` / 跨源重定向）判**跨源**而非缺席。
  **裁决三·API 面只认 `Authorization: Bearer`，不认 `?token=`**：这白送第四道防线——跨源 JS 要设
  自定义头必须先过 CORS 预检，而我们不回任何 `Access-Control-Allow-*`，浏览器**根本不会发出**那条
  真实请求；`<form>` 压根设不了头。不用 Cookie：Cookie 不区分端口，同机任何跑在 127.0.0.1 上的
  服务都能读写它。token 存 **sessionStorage** 不是 localStorage（后者跨重启存活，而 token 每次启动
  换新 → 陈旧 token 401，症状离病因很远）。
  **绑定地址是默认值不是执行**：即便被绑成 `0.0.0.0`，`/api/*` 仍只对回环开放（每条请求重判对端
  地址），会暴露的只有静态产物。安全性不建立在「S4 记得传对地址」上。没有 `disableAuth` 开关，
  不传 token 时仍随机生成一枚（后果是全部 401 这种响亮失败，不是静默放行）。
  子 agent 做了 6 轮变异验证（删卡口→8 例红、删 Host 校验→4 例、Origin 判据反向→14 例、health 豁免
  改前缀匹配→1 例、`isLoopbackAddress` 改 `startsWith`→1 例、token 比较去掉 SHA-256→4 例）。
  主会话另起真 server 独立复核 13 种攻击形态，见 S3 卡的表。
  **卡面「复用 `scripts/model-preview-relay.ts` 的 `isLoopbackAddress`」是错的，已改**：那个模块的
  import 图经 `model-preview-relay-routes.ts` 直达 `ModelPreviewRelayCredentials`（三家模型 Key 的
  路由），import 它 = 给一台随后要执行 `run_shell_command` 的 server 接上一条读模型 Key 的边，
  正是本卡明令禁止的那类代码路径；顺带还会拉进 `vite` 与 `agent-ai`，而 `scripts/` 也不在
  `tsconfig.app.json` 的 include 里。改为**判据逐字照抄 + 注释写明为什么不 import**。
  已知收窄（照抄不改，fail-closed）：RFC 1122 的回环是整个 `127.0.0.0/8`，这份只认 `127.0.0.1`。
  **开发期摩擦点**：`pnpm dev`（Vite 在 5173）里的页面调 server API 会因 Origin 端口不同被 403。
  server 宿主的正确用法是 `pnpm build` 后 `pnpm serve`。刻意没开 `additionalAllowedOrigins`
  ——每个额外允许的 origin 都是一个洞；B 线若确实需要，那是单独一张卡。

### S3 · `/api/invoke/:command` 接 host-node 路由表

- **依赖**：S1、N1
- **改动面**：`apps/server/src/invokeRoute*`
- **判据**：body 即 args JSON，逐字透传给 `createNodeHostInvoke` 的路由表；未知 command
  返回 404 而非 500。跑该目录 vitest。
  **本卡只交 handler 工厂，不改 `requestRouter.ts`**（S2 独占那个文件），接线由主会话统一做
  ——同 host-node 那 9 个域「域只交 registrar」的既定协议。按 `reason` 字段映射
  `unknown-command` → 404、`unimplemented` → 501，**不要用 `instanceof`**（错误要跨 HTTP 序列化）。
- **模型**：sonnet
- **状态**：DONE `50bd46f`（接线随 S2 的 `fd614b4`）。4 源 + 4 测试 + 1 脚手架。
  状态码矩阵：405 非 POST／**415 Content-Type 不是 `application/json`**／400 `invalid_json`／
  400 `invalid_body`（顶层非纯对象）／413 超 `maxBodyBytes`／404 `unknown-command`／
  501 `unimplemented`／200 `result ?? null` 原样序列化（**不做任何大小写转换**，findings #12）。
  **415 那道是 S2 交回时点出的免费防线**：`<form>` 只能发三种简单 content-type、**设不了
  `application/json`**，于是表单 CSRF 连预检都过不去；且这一道**不依赖 `Origin` 头存在**
  （S2 已裁决无 Origin 的请求放行）。S3 原本裁决不校验，据此改了。
  **命令名解码失败回落未解码原串**而不是报错：合法命令名不含 `%`，回落串必然落空成
  `unknown-command` → 404，于是「什么是合法命令」始终只有 host-node 一处权威，server 层不复制
  一份校验逻辑。body 上限 32 MiB = 8 MiB（`workspace/write/limits.ts` 的 `MAX_BYTES`）× 1.33
  （base64 膨胀）+ 批次余量，暴露为可选项而非写死。按**流式累积**判超限，不信 `Content-Length`；
  超限后继续排空 data 事件但不再累积内存。用原始 `'data'/'end'/'error'` 监听器而非 `for-await`
  ——后者 early break 会毁掉共享 socket，连回一条错误都做不到。
  **主会话接线**（`requestRouter.ts` / `createServer.ts` / `package.json`）：`handleApi` 已改成
  `async` 并在调用处 `await`——原先是同步定义、同步调用，挂上异步 handler 后 rejection 会绕过
  外层 `try/catch` 变成未捕获错误而不是一条 500。`apps/server/package.json` 原本**没有
  `dependencies` 字段**，补了 `@einfach-agent/core` 与 `@einfach-agent/host-node`（vitest 靠根
  `vite.config.ts` 的 alias 能跑，真正 `node` 运行需要这两条）。
  连带修正 `health.test.ts`：`/api/invoke/run_shell_command` 从「未知路径回 404」那张表里移出
  ——接线后它是**真实存在**的接口，GET 拿到 405；单独钉住这条。
  **主会话端到端复核**（起真 server，独立于两卡的脚手架，13 种形态）：无 token→401、错 token→401、
  `?token=`→401（头-only 成立）、无 token 的 `/api/invok`→**401 而不是 404**（认证在分派之前，
  未认证者问不出接口清单）、跨站 Origin→403、`Origin: null`→403、坏 Host（rebinding）→403、
  表单 content-type→415、带 token→**200 且真的回了 `/Users/dol`**（HTTP → 认证 → invoke →
  host-node → 系统调用整条链路打通）、未实现命令→501、不存在命令→404、health 无 token→200、
  health 跨站→403。

### S5 · shell 的 platform 该由宿主说了算，不是调用方探测

- **依赖**：S1
- **改动面**：`packages/agent-core/src/runtime/hostPlatform.ts` 及其调用链；`apps/server/src/health.ts`
  与 `createServer.ts` 的握手。**不含 `apps/web/src/host/`**——那个目录当前不存在（主会话已核实），
  宿主探测三态化是 B1 的卡，本卡只把 core 与 server 两头做对。
- **判据**：**来源：N3 交回时点名的阻断项，`run_shell_command` 在 server 宿主下会整个不可用。**
  `platform` 由 core 的 `detectHostPlatform()` 在**调用方**探测后随命令传下去，宿主收到后校验
  「与自己不符就拒绝执行」。Tauri 下前端与原生同机，这条恒成立；**浏览器 → Node server 这条路上
  不成立**——用户在 macOS、服务端在 Linux，会稳定拿到 `platform mismatch: requested \`macos\`,
  current \`linux\``，一条 shell 命令都跑不了。
  那条校验本身挡的是真问题（模型按 A 平台组命令、宿主按 B 平台执行），**不能简单删掉**。
  正解大概率是让 core 从宿主握手拿平台而不是本地探测——`/api/health` 或桥的一次初始化调用
  回报宿主平台，core 用它组命令，于是「组命令」和「执行命令」用的是同一个事实。
  本卡要给出设计并落地，判据是：server 宿主下 macOS 浏览器 + Linux 服务端能正常跑 shell 命令，
  且「模型按错平台组命令」仍被挡住。
  **时序约束（主会话核实后补）**：`detectHostPlatform()` 是**同步**的，调用点在
  `modelTurnPrefix.ts:73`（组 system prompt 那一刻）与工具定义里；而握手是**异步**的。改成异步会
  波及一大片同步调用链，所以本卡真正要解的是这个矛盾，不是「加个字段」。判据不是哪个优雅，是
  **「忘了握手」的失败响不响亮**——静默回落到本地探测值的设计在 Tauri 下永远对、在 server 下永远错
  且不报错，那是最坏的一类。
  **两个消费者必须逐字一致**（`hostPlatform.ts` 文件头写明）：① shell 桥
  （`tools/shell/.../run-verification-command.ts:74` 与 `runtime/shellCommand.ts` 的 `input.platform`）；
  ② 注入给模型的运行环境段（`modelTurnPrefix.ts:73`）。漂移的后果是模型按 A 平台组命令、桥按 B 平台拒。
  宿主侧的校验两份都在：`apps/desktop/src/shell_pipeline.rs:44` 与
  `packages/host-node/src/shell/pipeline.ts:57`，文案逐字相同。
- **模型**：opus
- **状态**：DONE `6238518`。**平台成了 `configureHostInvoke` 的必填字段**：
  `configureHostInvoke({ loader, platform })`，桥与平台同一次调用生效、同一次调用作废。
  **同步/异步的矛盾是把顺序反过来解的**——不让取值变异步，而让「拿到平台」成为登记桥的前置条件：
  远端握手没回来就登记不了桥 → `hasHostBridge()` 为假 → 与静态预览行为一致（工具不进清单、执行早退）。
  那个窗口不是被论证成不可达，是**结构上不存在**。
  **「忘了握手」的失败形态是编译错误**（必填字段漏写连 `tsc -b` 都过不去），比任何运行期告警都响亮
  ——这正是卡面判据要的。原 `detectHostPlatform` **被改名删掉**（现为私有的 `detectLocalPlatform`），
  留着旧名当别名的话漏改的调用点会静默继续拿错值。
  两个消费者取同一个值靠的是**取不到别的**：`declaredPlatform` 模块私有、唯一读出口 `hostPlatform()`、
  写入面 `declareHostPlatform()` 不在任何公开面上且 core 内只有 `configureHostInvoke` 一处调用。
  新增第四值 `HostPlatform = ShellPlatform | 'unsupported'`（FreeBSD/AIX 这类：文件能力照常、
  shell 三选一没有对应项；没有这个值它就得谎报一个，而消费方会被迫自己发明回落值 = 权威又劈成两处）。
  server 侧 `/api/health` 加 `platform`，取自 host-node 新导出的 `nodeHostPlatform()`——**就是 shell 域做
  `platform mismatch` 判定时调的同一个函数**；`createServer.ts` 刻意**不开** `options.platform` 覆盖开关
  （开了就等于允许装配层报一个跟真机器不同的平台）。
  子 agent 做了 4 轮变异（整卡回退→6 例、只改消费者②→2 例且消费者①仍绿即两者分别被钉住、
  删 `declareHostPlatform` 调用→6 例、握手硬编码 linux→1 例）。
  **主会话端到端实测**（起真 server，curl 打）：`/api/health` 回
  `{"service":"einfach-agent","host":"node-server","version":"0.1.0","platform":"macos"}`；
  `get_user_home_dir` → `"/Users/dol"`；**`run_shell_command` 真的跑了** ——
  `echo web-version-works && uname -s` → `stdout:"web-version-works\nDarwin\n"`, `exit_code:0`；
  谎报 `platform:"windows"` 仍被
  `` platform mismatch: requested `windows`, current `macos` `` 挡下。**判据两半都成立。**

  **B 线照此接**（S5 交回，B1/B2/B3 照做）：① B1 用 health 成功 + `service`/`host` 判 server 宿主，
  并把 `payload.platform` 带出来，**忽略未知字段**别写「字段集合恰好等于这几个」；② B2/B3 必须
  `await` 完握手再 `configureHostInvoke({ loader: async () => httpInvoke, platform })`——**注意是 loader
  不是 invoke 本身**（`HostInvokeLoader = () => Promise<HostInvoke>`，直接传 `httpInvoke` 编译不过；
  这条是 B2 交回时纠正的，主会话记录 S5 报告时抄错了形态）。**不要 fallback**、
  也不要照抄 `main.tsx` 那行 `detectLocalPlatform()`（那是同机宿主专用）；③ 时序上要把宿主解析放在
  `bootstrapApplication()` **之前** await 掉而不是并行发起，否则恢复出来的未完成 run 可能在桥到位前
  跑工具；④ `'unsupported'` 原样传，不要自己映射成三值之一；⑤ **B3 的老待办仍在**：
  `buildEnvironmentItem` 的「宿主：Tauri 桌面端」文案写死，server 宿主一落地浏览器用户就会被
  告知自己在 Tauri 桌面端。

### S4 · 启动 CLI：端口选择、URL 打印、打开浏览器

- **依赖**：S2、S3
- **改动面**：`apps/server/src/main.ts`、根 `package.json` 加脚本
- **判据**：`pnpm serve` 打印带 token 的完整 URL；端口被占时自动换端口而非崩溃；
  `--no-open` 可关闭自动打开。跑该目录 vitest。
  **token 由本卡生成**（`generateAuthToken()`），同时喂给 `createWebAgentServer({ token })` 和打印的
  URL——不传不是「关闭认证」，`createServer.ts` 仍会随机生成一枚，后果是全部 401。
  `EADDRINUSE` 是**异步 error 事件**不是同步抛出，try/catch 接不住。打开浏览器必须
  `spawn(cmd, [url])` 而非拼 shell 字符串——URL 里有 token，拼进 shell 会让它进程列表可见且可注入；
  打不开浏览器不得让服务崩溃（headless / SSH / 容器里没有浏览器）。
- **模型**：sonnet
- **状态**：DONE `f94927a`（脚本改名与解析修复随 `6238518`）。11 个文件，源码最大 85 行，
  `main.ts` 只有 11 行；`main*` 下 39 例。
  **判据里的 `pnpm server` 是错的，已全树改成 `pnpm serve`**：`server` 是 **pnpm 的保留子命令**
  （它自己的 store server），裸跑 `pnpm server` 报
  `ERR_PNPM_INVALID_SERVER_COMMAND  "server --help" is not a pnpm command`，只有 `pnpm run server`
  能用。子 agent 发现了但没敢改脚本名（怕波及树与 S2 的文档），报告上来由主会话裁决改名——
  留着 `server` 等于让用户永远记「这个要加 run、别的不用」。`serve` / `web` 都不被 pnpm 占用，取 `serve`。
  实测确认过一件容易当假设的事：**`http.Server` 在 `EADDRINUSE` 之后能直接再 `listen`**，
  不必新建实例。默认起始端口 4765（避开 Vite 的 5173/4173 与常见 3000/8000/8080），10 次重试；
  非 `EADDRINUSE` 的错误码（`EACCES`/`EADDRNOTAVAIL`）立即重抛不重试——换端口修不好权限问题。
  打开浏览器一律 `spawn(cmd, [url])`，URL 从不进 shell 字符串；失败只写一行 stderr 不让服务崩。
  **自报的一处未验证**：Windows 分支 `cmd /c start "" <url>` + `windowsVerbatimArguments: true`
  无法在本机验证，若 Windows 近期要紧需复核。

### 新增·主会话验收 S4/S5 时发现的模块解析陷阱（B/D 线必读）

**症状**：`pnpm build`、`pnpm test`（4676 例）、三条门禁**全绿**，而 `pnpm serve` 一跑就
`SyntaxError: The requested module '@einfach-agent/host-node' does not provide an export named
'nodeHostPlatform'`——那个导出明明就在 `packages/host-node/src/index.ts:33`。

**成因**：同一个包名在两条解析路径上指向**不同的东西**。
- vite / vitest / `tsc -b` 走 `vite.config.ts` 的 `resolve.alias` 与 `tsconfig.app.json` 的 `paths`，
  直达 `src`（`CLAUDE.md` 写明的「workspace 包不单独编译」）。
- 真正的进程（`tsx` 跑 `apps/server` / `apps/cli`）走 node 的 ESM 解析：`paths` 里
  `"@einfach-agent/host-node": ["packages/host-node/src"]` 是**目录形式**，解析不到就**回落 node_modules**
  → workspace 符号链接 → `package.json` 的 `exports` → `./dist/index.js`，**一份 8 月 18 日的陈旧构建**
  （`dist/` 是 gitignore 的本地产物，只导出 5 个符号，没有当天新加的任何东西）。

**修法**：把该条目改成**文件形式** `["packages/host-node/src/index.ts"]`，与紧邻的
`"@einfach-agent/core": ["packages/agent-core/src/index.ts"]` 一致——后者一直是文件形式，所以
`@einfach-agent/core` 从没犯过这个病。改完 `pnpm serve` 立刻跑通。

**为什么之前没暴露**：host-node 是 N 线新加的包，而在 S4 之前**没有任何真实进程 import 它的新符号**
——`apps/cli` 虽然也 import 了 `nodeHostPlatform`，但 `pnpm cli --help` 在触及那条 import 之前就退出了。

**留给 B/D 线的两条**：
1. **`paths` 里其余目录形式的条目是同一颗雷**（`observability-*`、`persistence-*`、`subagents` 等
   当前都是目录形式）。它们今天只被 `apps/web` 经 vite 消费所以无恙；**哪天有 `tsx` 进程 import 它们，
   同样会静默吃到陈旧 `dist`**。D 线定分发形态时要连这条一起решить。
2. **没有任何门禁跑真实二进制。** 四千多例测试加三条门禁全绿，而 `pnpm serve` 起不来。
   B4 / M5 那两张「端到端验收」卡是目前唯一会碰到真实进程的地方，**别把它们简化成跑测试**。

---

## B · 前端 server 宿主装配

### B1 · 宿主探测三态化

- **依赖**：S1
- **改动面**：新建 `apps/web/src/host/resolveHost.ts` 与其测试（该目录当前不存在，由本卡新建）
- **判据**：返回 `'tauri' | 'server' | 'static'`。顺序：`isTauri()` → `GET /api/health` 成功 →
  `static`。探测失败必须落到 `static` 而不是挂起首屏。跑该目录 vitest。
  **「失败」包含「永远不返回」**：端口上有东西在听但从不回包、被代理拦住、服务端启动中途卡死，
  `fetch` 都会长时间挂着而不是报错，首屏就一直白着。**必须有超时**（`AbortController`），超时判
  `static`。另：判据是 health 成功**且** `service === 'web-agent'` **且** `host === 'node-server'`
  ——只判 200 不够，本机任何开发服务器都可能对该路径回 200。真·静态部署下 `/api/health` 多半被
  SPA 回落成一整页 HTML，`response.json()` 会抛，别让它变成未捕获错误。
  **不得跨 app import `apps/server` 的常量**（app 之间没有依赖边）。
- **模型**：opus
- **状态**：DONE `f48ba15`。依赖其实是 **S1 + S5**（`platform` 带出来这件事完全来自 S5，原树只写了 S1）。
  4 个文件 / 23 例。**返回可辨识联合而非裸字符串**：
  `{kind:'tauri'} | {kind:'server', platform} | {kind:'static', reason}`。`platform` 只挂在 `server` 上
  ——S5 把它做成 `configureHostInvoke` 的必填字段，做成联合之后「拿到 server 却没有 platform」
  在类型上构不出来，B3 想漏得先过 `tsc -b`。`tauri` 刻意**不带** platform（桌面 webview 与原生同机，
  权威是 core 的 `detectLocalPlatform()`，本模块没资格替它答）。
  **超时 2000ms，且不只靠 `AbortController`**：额外加 `Promise.race`——只上 abort 的话「超时后一定
  返回」就成了对 fetch 实现认不认那个 signal 的**假设**，而这个函数的全部职责恰恰是不让首屏挂在
  假设上。有一条用例就是「fetch 完全不理会 abort」，删掉 race 它会永远挂着。
  **跨 app 常量的漂移守卫**（本卡最值得抄的一手）：不能 import `apps/server`（app 之间没有依赖边，
  且真 import 会把 `node:http` 那条链拖进浏览器产物），所以 `serverHealthContract.ts` 自己抄一份常量；
  而抄一份的漂移症状恰好是**静默的**（server 宿主被判成 static）。于是测试用 `readFileSync` 把
  `apps/server/src/health.ts` **当文本读**进来（读文件不是 import，不产生模块边、不进产物），
  正则抽出常量字面量逐字对拍。**主会话独立复核：改服务端那个常量，网页端测试当场变红。**
  四值域写成 `Record<HostPlatform, true>` 而非数组——core 哪天加第五个值是**本文件的编译错误**。
  `version` 刻意不校验也不带出（用不到，要求它只增加漂移面）。
  **自报的一处覆盖缺口（未粉饰）**：默认超时 2000→1000 的变异**不会红**，因为测试钉的是
  `[1000, 5000]` 区间而非精确值——精确等值断言是变更探测器，调参只多改一行测试；真正不能越的是
  两头。主会话认可这个取舍。改成 50 或 30000 会红。
  真·静态部署的两种形态都覆盖了：`/api/health` 回 404 → `unhealthy`；被 SPA 回落成整页 HTML
  → `response.json()` 抛 → `unrecognized`（**且不 reject**）。补一条卡面没说准的：404 其实更常见，
  因为 Vite dev 的 SPA 回落要求 `accept: text/html` 而 `fetch` 默认发 `*/*`。

### B2 · httpInvoke 实现

- **依赖**：B1、S3
- **改动面**：新建 `apps/web/src/host/serverInvoke.ts` 与其测试
- **判据**：签名与 `HostInvoke` 一致；token 从 URL query 取一次后从地址栏清掉
  （避免进浏览器历史与 Referer）；HTTP 错误映射成与 Tauri invoke 同形状的 reject。跑该目录 vitest。
  **S2 的三条硬约束**：token 存 `sessionStorage` 不是 `localStorage`（后者跨重启存活而 token 每次
  启动换新 → 陈旧 token 401，症状离病因很远）；每条请求走 `Authorization: Bearer`、**绝不退回
  `?token=`**（服务端只认头不认 query；退回 query 会让跨站简单请求重新活过来）；**不用 Cookie**
  （Cookie 不区分端口，同机任何跑在 127.0.0.1 上的服务都能读写）。
  抹 query 要**保留 path / hash / 其余参数**，粗暴 `replaceState(null,'','/')` 会把带 hash 路由进来
  的用户踢回首页。请求必须带 `content-type: application/json`，否则 415——那个头本身是一道 CSRF
  防线（`<form>` 设不了它）。**不得跨 app import `apps/server` 的常量。**
- **模型**：sonnet
- **状态**：DONE `6336a53`。2 源 + 2 测试 / 28 例。
  **reject 的是裸字符串，不是 Error 也不是 `{error,message}` 对象。** 依据是实证而非风格：
  Tauri 的 `run_shell_command` 签名是 `Result<_, String>`，invoke 把那个 `String` 原样抛出；而 core 里
  有五处写的是 `String(error)`（`shellCommand.ts:38`、`toolLoopSupport.ts:29`、`timedDispatchLoop.ts:27`
  等），**reject 一个对象会让一句准确中文变成 `[object Object]`**（主会话实测确认）。裸字符串是
  两种 catch 写法下都拿到原文的唯一形状。
  为同时满足「401 要可识别」，拆成两层：`invokeServerCommand` 不折叠、失败恒抛
  `ServerInvokeError`（带 `status`/`code`）；`httpInvoke` 只是它的瘦包装，把错误折成 `.message`。
  要判 401 就绕开 `httpInvoke` 直接调底层，或用 `isServerInvokeUnauthorized()`。
  **query 与 sessionStorage 都有且不同时，query 赢**：token 每次启动换新，而 sessionStorage 跨刷新
  存活，于是「地址栏换成了终端新打印的链接、sessionStorage 还留着上次启动的旧 token」是真实场景；
  让旧值赢会让一个看起来该有效的新链接又拿到 401，且没有任何提示指向缓存。
  **新标签页无 token 时仍把请求发出去**（只是不带头），让服务端 `authGuard.ts` 给出准确的 401
  `missing_token`——不在客户端另编一句可能与服务端脱节的文案，同「命令名合法性只有 host-node
  一处权威」是同一个理由。

### B3 · main.tsx 按宿主分发并拆分到 300 行内

- **依赖**：B1、B2、H5
- **改动面**：`apps/web/src/main.tsx`（当前 224 行）、新增 `apps/web/src/host/` 下的装配模块
- **判据**：**另有一条 H4b 交回的待办必须在本卡收掉**：`modelTurnSystemItems.ts` 的
  `buildEnvironmentItem` 在宿主有本机能力时写死「宿主：Tauri 桌面端（可用本机文件、shell 与
  Git 工具）」。今天只有 Tauri 一种 server 宿主，这句逐字成立；server 宿主一落地，浏览器用户
  就会被告知自己在 Tauri 桌面端，而这段文本是喂给**模型**的——模型会按错误的宿主假设行事。
  改成按能力而非按宿主品牌措辞（`modelTurnPrefix.ts` 的调用处已留注释指向这里）。
  三宿主各自的 invoke / 持久化 / 观测 driver 选择收口到 `host/`；
  `wc -l apps/web/src/main.tsx` ≤ 300。**不许为凑行数把强内聚的装配序列打碎**——
  按「宿主」这一个职责切。跑 `pnpm exec vitest run apps/web` + `pnpm build`
- **模型**：opus
- **状态**：DONE `f7ea8fa`。`main.tsx` 8 处 `tauriHost` 判断归零，收口到 `host/` 下五个模块
  （命令桥 / 模型传输 / 凭据宿主 / 观测 driver / 恢复刷盘时机，各一句话职责）；
  **`wc -l main.tsx` = 195**。搬走的注释一并搬走，一句没删。
  **持久化没有搬进 `host/`，主会话认可**：那个分支**本来就不在 `main.tsx`**，而在
  `persistence/persistenceDrivers.ts` 里；入参从 `tauriHost: boolean` 改成 `ResolvedHost`
  并写明「有桥 ≠ 有 SQLite」（P 线之前 server 与 static 同待遇）。搬文件只改路径不改职责，
  包一层 `hostPersistenceDrivers.ts` 是 3 行假拆。
  **`buildEnvironmentItem` 改成按能力措辞**（H4b 的待办本卡收掉），入参改名
  `hostHasLocalCapabilities`。有能力（Tauri 与 server **同一句话**）：
  `本机能力：可用（文件、shell 与 Git 工具在宿主机器上执行）；宿主机器平台 ${platform}。`
  ——「宿主机器」是刻意的措辞，它同时交代了 server 宿主唯一需要额外交代的事实：**执行工具的
  那台机器不一定是用户面前这台**。平台为 `'unsupported'` 时追加一句「shell 类工具在本宿主上
  一定失败，不要调用」——否则模型只看到一个陌生平台名，会在三个 shell 工具里反复撞
  platform mismatch，而那句错误里没有任何「本宿主根本没有 shell」的信息。
  **测试设计值得抄**：`main.serverHost.test.tsx` 的握手平台故意取 `'unsupported'`——
  `detectLocalPlatform()` 返回类型是 `ShellPlatform`（`'macos'|'linux'|'windows'`），**永远产不出
  这个值**，所以断言在任何机器上都只能由握手值满足；取 `'linux'` 的话 Linux CI 上即使偷用本地
  探测也照样绿。主会话独立复核：把 server 分支改用 `detectLocalPlatform()`，该例当场转红。
  **卡面「static = 模型请求被拒」不准确**（B3 纠正）：`pnpm dev` 的浏览器预览也是 static 态，
  它走 dev 中继而非拒绝；拒绝只发生在构建产物上，判据是 `import.meta.env.DEV`，与宿主态正交。
  存量超限文件：`modelTurn.test.ts` 现 872 行（改前已 846），实为四个无关主题挤一处，建议单开一卡拆。

### B4 · 端到端验收：浏览器里读写文件与跑 shell

- **依赖**：B3、N8
- **改动面**：无（验收卡）；**实际产出一枚缺陷修复 `148da1d`**
- **判据**：**主会话亲自。** `pnpm serve` 后浏览器实际完成一轮：列目录 → 读文件 →
  写文件 → 跑一条 shell 命令。截图或逐步记录留在 scratchpad。
  **按能力链路验，不走模型链路**——M 线未落地，B3 也刻意让 server 宿主的模型能力维持不可用；
  模型那一轮是 M5 的判据。
- **模型**：—（主会话亲自）
- **状态**：DONE。真实 Chromium 打开 `pnpm serve` 打印的 URL，四步全通（均 HTTP 200）：
  列目录见 `sample.txt` → 读文件拿到内容与 sha256 → 写文件回 `created:true` 并带行级 diff →
  **shell 命令 `cat` 出了上一步刚写的那个文件**（`stdout:"B4 wrote this from the browser\nDarwin\n"`,
  `exit_code:0`）。最后一步是最强的一环：它证明写与执行落在同一个真实文件系统上。
  另从宿主侧独立复核了磁盘上确实多出那个 31 字节的文件。

  **本卡抓到一个所有单元测试都看不见的真缺陷（已修 `148da1d`）**：
  **token 在页面打开后一直留在地址栏**。`getServerInvokeToken()`（它顺带做「读走 query 里的
  token → 存 sessionStorage → `replaceState` 抹掉 query」）**只在 `serverInvoke.ts` 的请求路径上
  被调用**，于是「页面打开了、但一条命令都还没跑」的整段时间里 token 原样留在 URL 里——进浏览器
  历史、进截图，页面若外链还会进 Referer，**而那正是要抹掉它的全部理由**。
  单元测试看不见这条：它们直接调 `getServerInvokeToken()`，天然「调用过了」，看不见「谁在什么
  时候调它」。修法是在 `registerHostCommandBridge` 的 server 分支装配那一刻就调一次；
  回归用例落在装配层（`main.serverHost.test.tsx`），并顺带钉住「只抹 token 那一个参数，
  `keep=1` 与 `#/frag` 都要保留」。复核：撤掉那一行调用，该例转红。
  **这条正是「没有任何门禁跑真实二进制」那条结论的第一个兑现** ——4756 例单元测试全绿，
  而真实浏览器里第一眼就看见 token 还在地址栏上。

---

## M · 模型代理

### B6 · 宿主分流缺穷举守卫，加第四态时静默走错分支

- **依赖**：B5
- **改动面**：`apps/web/src/host/hostCommandBridge.ts` 及其余四个分流模块
- **判据**：**来源：B5 只报不改，主会话独立探针复核。** 给 `ResolvedHost` 加一支
  `{ kind: 'sidecar' }` 跑 `tsc -b`，`apps/web/src/host/host*.ts` **零编译错误**（基线 exit 0）。
  后果按模块分轻重：`hostCommandBridge.ts` 的 `switch` 没有 `default`，第四态直接返回 undefined
  → **不登记桥** → 文件/shell/Git/rg 工具整类对模型不可见、执行一律早退，**且不报错**——
  这正是该文件注释里「少了这一句会怎样」描述的那个后果。其余四个是 if 链带兜底，第四态落进
  unavailable / IndexedDB / 浏览器 pagehide，不至于失能但同样静默。
  **这条直接压在 T2（桌面前端切到 server 宿主）头上**：那张卡要动的就是三态划分。
  判据：加第四态时**每一个**分流模块都编译失败；`hostCommandBridge` 补 `default: assertNever(host)`。
- **模型**：sonnet
- **状态**：DROPPED（**范围裁剪，用户裁决「收口干完」**）。穷举守卫只在「新增一个宿主态」时才有价值，
  而唯一会新增宿主态的卡是 T 线——T 线现在改成**删掉桌面端**，宿主从三态减到两态，方向相反。
  B5 报的事实仍然成立（加第四态时 `host*.ts` 零编译错误，主会话探针复核过），记在这里供将来
  真要加宿主态的人直接取用：`hostCommandBridge` 的 `switch` 缺 `default: assertNever(host)`。

### B7 · trace 装配的两个静默失效

- **依赖**：B5、P4
- **改动面**：`apps/web/src/host/hostObservability.ts`
- **判据**：**来源：B5 只报不改，主会话逐条复核代码。** 两条独立缺陷，共性是「失效但不报错」：
  · **driver 加载失败被整个吞掉且无回落**：`.catch(() => {})` 之后 `configureObservability` 一次都没被
    调用，而 core 的 `enqueue()` 是 `if (!current) return`（`packages/agent-core/src/observability/trace.ts:56`）
    ——**所有 span 直接丢弃**，无日志、无告警、无 IndexedDB 兜底。同处还有个更小的时序缺口：
    写入端是 `void import(...)` 异步到位而 `configureHostObservability()` 同步返回，这中间完成的 span 一样丢。
  · **`server + DEV` 写 X 读 Y**：写入端 driver 只认 tauri → server 落 IndexedDB；读取端的 DEV 判据
    排在宿主判据之前 → server+DEV 走 `createDevSqliteLogReader`，读的是桌面那份 SQLite 文件。
    **而该文件头声称的正是「两端在同一个函数里按同一个宿主判据选」**，这一格上那句话不成立。
    对 `static + DEV` 这是有意设计（同机调试看桌面 trace，注释写明了）；M 线落地、server 宿主出现
    之后它才变成一处真实的「写 X 读 Y」。与 C7 同类（宿主判据没跟上，两份状态分家）。
  **排在 P4 之后**：P4 正在把 observability-sqlite 收敛到注入的 `SqlExecutor`，server 宿主届时会有
  自己的 SQL 通路，第二条的正解可能随之改变。
  B5 已在 `hostObservability.test.ts` 里**只钉住当前行为**并在注释里点名了这处张力。
- **模型**：opus
- **状态**：DROPPED（**范围裁剪**）。两条都属实（`.catch(() => {})` 吞掉 driver 加载失败 → core 的
  `enqueue()` 直接丢 span；`server + DEV` 曾经写 X 读 Y）。**第 ③ 条已被 P4 的接线连带修掉**，
  B5 的用例已改成正面断言当回归网。剩下的第 ② 条影响的是 trace 这个**诊断**功能，坏了不影响用；
  而 B5 已在 `hostObservability.test.ts` 里钉了「现状档案」并注明「B7 落地时它必然转红」——
  **真要修的人会在那一条上撞一次，撞到的正是他要改的那一格**。不需要一张常驻的卡替他记着。

### M1 · host-node 的 provider 请求转发

- **依赖**：N7
- **改动面**：`packages/host-node/src/model/`
- **判据**：对齐 `model_proxy*.rs` 的**端点白名单与 provider 路由**
  （`model_provider_route.rs`），Key 只从 N7 的配置读、**永不出现在返回体里**；
  上游流式响应原样透传；请求取消能真的中断上游。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `8c0454d`。14 源 + 10 测试 / 67 例。**白名单五条与 `model_provider_route.rs`
  同序同参**，`it.each` 逐行钉住；一并对齐 `valid_resource_id`、`valid_file_delete_path`、
  `accepts_scope` 配对表与 `ProviderTarget` 的 `deny_unknown_fields`（往 target 塞 `url` 必须被拒）。
  **没有新增任何端点。**
  **Key 不外泄的测试先正面钉住「Key 确实发出去了」**（`authorization === Bearer <key>`），否则整条
  用例可以靠「压根没读 Key」蒙混过关；再断言它不出现在成功返回体、上游 401 返回体、连不上时的
  `message`/`stack`/`cause` 里。主会话独立复核：把 Key 拼进上游失败错误 → 该用例当场转红。
  连不上时刻意丢掉原始 error——undici 的 cause 链带请求 URL 与头部摘要。本域**没有任何日志语句**。
  **流式出口就是本卡**（不是卡面给的两条路之一）：`forwardProviderRequest` 返回
  `{ status, contentType, body: AsyncGenerator<Uint8Array>, release() }`，逐块原样透传、不解析 SSE、
  不按行切、不转字符串；**`model_provider_request` / `model_chat_completions` 故意不进路由表**
  （写一个攒完再返回的 handler 才是错的，那个假象在开发机上看不出来），M2 直接调这个函数。
  失败分界线是**响应头有没有交出去**：之前 → reject；之后 → 从 generator 抛。
  **取消是在上游 socket 那头观察到的**：真 `node:http` 服务 + 真 `fetch`，服务端
  `response.on('close')` 判 `!response.writableEnded`。主会话独立复核：摘掉 `signal` → 相关用例
  全部超时转红。`requestId` 表的 `finish` 挂在**响应流收尾**而非函数返回时——函数拿到响应头就
  返回了，流还在 M2 手里跑，那段时间取消必须还找得到它。
  **卡面把 7 条 model 命令都算进本卡是错的**：M4 明写「host-node 侧补
  `model_credential_status/set/delete` 三个命令」，M1 只做 Key 的读取半边（转发要用）并把绑定表
  导出成缝——两张卡各写一份必然分叉。主会话已核对 M4 卡面，采纳。
  `redirect` 用 `'manual'` 而非 `scripts/model-preview-relay.ts` 的 `'error'`：实测 undici 的
  `'manual'` 把 302 原样交回，才等价 reqwest 的 `Policy::none()`（Rust 有专测断言拿到 302）。
  multipart 刻意自己编码字节而不用 `FormData`——vitest 跑在 jsdom，`globalThis.FormData` 是 jsdom 的，
  交给 undici 会被品牌检查判否、`String()` 成 `[object FormData]` 发出去，**本地全绿、上游收到垃圾**。

### M2 · server 的流式模型端点

- **依赖**：M1、S2
- **改动面**：`apps/server/src/modelRoute*`
- **状态**：DONE `9f94b20`（接线随 `54b0746`）。端点 `POST /api/model/request`，6 源 + 4 测试 / 26 例。
  **卡面「错误路径与客户端断开路径都要走到 `release()`」漏了第五条路径——本卡实测逼出来的。**
  「客户端在 `forwardProviderRequest` 返回**之前**就断开」这条路上**根本没有可 release 的对象**：
  那时函数还悬在「等上游回响应头」上（M1 的 120 秒超时），而这恰恰是「模型正在思考、还没吐第一个
  字」那几十秒——用户最可能关标签页的时刻。按卡面写法第一版测试**超时 15 秒**把它逼了出来。
  修法是那一段唯一的把手：按 requestId 在**在飞请求表**上取消。主会话独立复核：去掉那一步，
  3 例转红（含 15 秒超时那条）。
  两种「响应过大」（findings #22）天然分开：**声明** content-length 超限 → 完整 502；
  **流中累计**超限 → 200 已发出、只能断连。请求体上限 56 MiB，与 M1 的
  `MAX_PROVIDER_WIRE_REQUEST_BYTES` **同值**，不留「HTTP 放行、M1 再拒」的灰带。
  **一个已知取舍**：响应头之前的失败一律 502（message 用 M1 原文）。要细分成 400/403/503，
  `apps/server` 只能照抄一份中文串来 switch——那是给跨宿主对外契约立第二个权威。正解见新卡 **M6**。
  499 用 nginx 惯例而非 IANA 注册码：成功时本端点**原样透传上游状态码**，任何标准码都可能撞上。
- **判据**：`POST /api/model/request` 直接返回流式 body（**不进 `/api/invoke/:command`
  的统一路由**）；客户端断开时上游请求被取消。跑该目录 vitest
- **模型**：opus

### M3 · 前端 serverModelTransport

- **依赖**：M2、B2
- **改动面**：新建 `apps/web/src/modelTransport/serverModelTransport.ts` 与其测试
- **判据**：产出与 `createTauriModelFetch` 同形状的 fetch；`AbortSignal` 透传成 HTTP abort。
  **不复用 Channel 编解码**——HTTP 下 `createProviderFetch` 直接消费原生 `Response`。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `adf8aa9`（接线由主会话做）。3 源+测试 / 21 例，11 条变异探针。**探针抓到它自己写的空跑断言**：
  `expect(url).toBe(MODEL_ROUTE_PATH)` 两边同源，路径改了照样绿；已改逐字字面量，并**补了一条跨 app
  文本对拍守卫**（照 `serverHealthContract.test.ts`，读 `apps/server/src/modelRoutePath.ts` 的源码正则比对）。
  主会话独立复验：只改服务端正本 → 1 红，报错文本里是我改的那个值，证明真从正本抠值。
  abort 用真 `node:http` + 真 `fetch` 起服务，**实测两个阶段（响应头之前 / 流到一半）服务端观察到的都是
  `close && writableEnded === false`**，正是 M2 的触发条件，并有第三条负对照（正常收尾 `writableEnded === true`）
  ——M2 文件头那句「AbortController 与 socket.destroy() 形态不一定一样」的存疑可以收紧。
  接线排序**server 必须在 DEV 之前**：M4 的凭据宿主是 `tauri → server → unavailable` 无 DEV 分支，
  让 DEV 赢会造出「Key 存进后端、请求发给 Vite 中继」且两边都不报错。主会话接线后发现
  `host*.ts` 五个模块**全无 colocated 测试**，已补 `hostModelTransport.test.ts`（5 例）钉住三态与排序；
  探针实证：只测两种正常形态时两个分支谁前谁后都不设防。

### M4 · server 版模型凭据宿主

- **依赖**：M1、S3
- **改动面**：新建 `apps/web/src/settings/serverModelCredentialHost.ts`；host-node 侧补
  `model_credential_status/set/delete` 三个命令
- **状态**：DONE `7b52c0d` + `3ee59ee`。三条命令落在 `packages/host-node/src/model/credentialCommands.ts`，
  复用 M1 导出的绑定表缝（`credentialConfigKey` / `normalizeApiKey` / `readConfiguredModelCredential`）
  ——两张卡各写一份绑定表必然分叉，而分叉的症状是「存进去了但读不出来」。写入走 N7 的
  `updateSection`，**段更新不是整份覆盖**（有正面用例断言 `mcp` 段与其它顶层键不变）。
  **Key 不外泄的测试先正面钉住 Key 真的被存进去了**，再断言三次返回体与四条失败路径都不含它。
  主会话独立复核：让 `set` 回显 Key → 2 例转红。
  **卡面自相矛盾，本卡的裁决主会话已核实采纳**：判据既说「`status` 只回 `{configured, source}`」
  又说「对齐 `model_credentials.rs`」，而 Rust 的 `ModelCredentialStatus` 是**四个**字段。前端
  `apps/web/src/settings/modelCredentialHost.ts:36` 的类型确实只有两个，多出的 `provider`/`scope`
  是调用方自己传进去的回声、全仓无人读；而这条链路经 HTTP 暴露，能不出去的就不出去。取两字段。
  接线连带：B3 的「模型凭据仍走 unavailable（M 线未落地）」前提失效，已改成钉「没退回 unavailable、
  也没误用桌面原生层那条通路」。**纪律没有松动**——Key 仍由宿主读写，浏览器只是把它交给本机后端。
- **判据**：与 `createTauriModelCredentialHost()` 同接口；`status` 只回
  `{ configured, source }`，**任何路径都不回传 Key 本身**。跑该目录 vitest
- **模型**：opus

### M6 · 给模型转发的失败加 `reason`，让状态码分得开

- **依赖**：M1、M2
- **改动面**：`packages/host-node/src/model/errors.ts` 及其抛出点；`apps/server/src/modelRouteError.ts`
- **判据**：**来源：M2 交回时点名的取舍。** M2 现在把「响应头之前的一切失败」一律映射成 **502**，
  因为 M1 的 `MODEL_ERROR` 常量**不在 `@einfach-agent/host-node` 的包级公开面上**、那些错误也**没有
  `reason` 字段**。要分开「格式无效→400 / 目标未获允许→403 / 没配 Key→503 / 上游真的挂了→502」，
  `apps/server` 只能照抄一份中文串来 switch —— 那是给一份跨宿主对外契约立第二个权威，正是
  `createNodeHostInvoke` 那条「判别用 `reason` 字段而不是文案」立下的规矩要避免的。
  本卡给这些错误加上 `reason`（形状对齐 `NodeHostCommandErrorReason`：**跨 HTTP 要序列化，所以是
  字段不是 `instanceof`**），M2 那边按 `reason` 分状态码。
  判据：四类失败各有一条用例断言状态码；**且断言 `apps/server` 里没有任何一处比对中文错误文案**。
- **模型**：opus
- **状态**：DONE `9a9d76c`。7 类而非卡面的 4 类，多出的三类各有不能并桶的理由：`duplicate-request-id`→**409**
  （上一次还活着，换 id 重发即可）、`credential-config-invalid`→**500**（宿主自己的 config 段坏了，
  不是调用方也不是上游的错，重试无用）、`cancelled`→499（M2 已有）。**10 条中文文案一字未改**
  （主会话复验：改前改后文案集合逐字节相同）；`MODEL_ERROR` 表**刻意没上公开面**——导出去等于邀请
  别人拿文案 switch。barrel 7 增 0 删。文案守卫经主会话独立探针确认会咬（埋一处 `message === '…'` → 2 红）。
  **卡面「响应头之前一律 502」不准确**：取消那一支本来就分开。连带效应：分开状态码后 400/403/409
  不再被 `modelRetry` 重试（它只重试 429 与 5xx），确定性失败不再白跑三次退避。
  **主会话提的嵌套信封方案被本卡否决且理由成立**：那两个字段叫 `provider_*`，塞本机分类进去是断言假事；
  且非 2xx 的上游响应连 body 一起透传，真上游错误体走同一条白名单，在那行里分不开。
  正解在 `Composer.tsx` 的 `formatRunError`（已按状态码翻译，今天只有 401 那条），是 apps/web 的改动面。

### M5 · 端到端验收：浏览器里跑完一轮对话

- **依赖**：M3、M4、B4
- **改动面**：无（验收卡）
- **判据**：**主会话亲自。** 浏览器里完成一轮真实对话（含至少一次工具调用），
  流式输出可见、可中断。记录留在 scratchpad
- **模型**：—（主会话亲自）
- **状态**：DONE（验收卡，主会话亲自，无代码改动）。真实 Chromium + `pnpm serve` + 真 DeepSeek，工作区是一个
  **空的**临时目录。完整记录在 scratchpad 的 `m5-acceptance.md`。三条判据：
  ① **一轮真实对话含两次真工具调用**——`list_files(.)` 列出真文件、`read_file(notes.txt)` 回真内容与
  `contentHash`，模型逐字答对第二行，8 秒结束；注入的运行环境段是「本机能力可用，平台 macos」。
  **浏览器 + 本机 Node 后端 = 完整能力，整棵树的目标在这一刻兑现。**
  顺带在真浏览器里再证一次 B4：打开带 token 的链接后地址栏变成裸 `/`，token 在装配那一刻就被收走。
  ② **流式可见**——每 400 ms 采样，字符数 2466 → 2986 单调增长，不是攒完再一次性显示。
  ③ **可中断**——吐到 3379 字时点停止，此后 3 秒冻结在 3363 不动、停止按钮当场消失；
  **且服务端侧确认是真取消**：中断后无新增异常，进程无残留对外 TCP 连接（`lsof` 滤掉本地回环后为空）。
  **验收发现一条噪声缺陷，已立卡 C8**：新建工作区后每次先送三条 `500 @ /api/invoke/list_workspace_files`。
  未验：只跑过 macOS + Chromium + DeepSeek 一家；MCP 在这轮没被触发，C4 的 server 版 stdio connector
  仍未经真实对话路径验证；多标签页并发、断网重连未验。

---

## C · MCP 与事件通道

### C1 · host-node 的 MCP stdio 传输

- **依赖**：N3
- **改动面**：`packages/host-node/src/mcp/`
- **判据**：对齐 `mcp_session*.rs` + `mcp_protocol.rs`：spawn、JSON-RPC 帧收发、
  超时、进程退出清理。**协议编排不重写**——`tools/mcp` 里已有 5178 行 TS 实现，
  本卡只做传输层。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `bf71e9c`。20 源 + 6 测试 / 66 例，自写假 server（绝不跑第三方 MCP 实现），无残留子进程。
  **卡面「`tools/mcp` 里已有 5178 行 TS 实现，本卡只做传输层」这个前提是错的——主会话已复核。**
  `tools/mcp/src` 的非测试代码里 `jsonrpc` / `'tools/list'` / `'tools/call'` /
  `notifications/initialized` **零命中**（那 1 万行是**管理器层**：工具适配、schema 校验、集合对账、
  退避重连、失败分类、清单缓存）。**stdio 那条路的 wire 协议全仓只有 Rust 一份。** 所以「只搬字节」
  在四条命令上落不下去——`mcp_connect` 的返回值**就是** initialize 的结果，没有更薄的形态。
  C1 把「命令契约自带的那部分」（initialize 握手与能力协商、tools/list 分页与游标去重、
  tools/call 参数组装、服务端 ping 应答、list_changed 识别）搬了过来，其余一个字没碰。
  判据写在三处文件头，免得下一个人看到 `initialize` 就以为可以再抄一份。
  **分帧刻意不用 `StringDecoder`**（与 `workspace/common/readCapped.ts` 不同）：分隔符是 `\n`(0x0A)，
  而 UTF-8 多字节序列每个字节都 ≥0x80——按字节找分隔符、整行才 `toString('utf8')`，
  字符被劈开是**结构上不可能**，不是「测过没问题」。主会话独立复核：丢掉跨 chunk 累积 → 6 例转红。
  **Rust 从不发 SIGTERM**（卡面问「SIGTERM 后不退要不要 SIGKILL」是问偏了）：优雅步骤是**关 stdin**
  （MCP stdio 里「请你退出」的规范信号），等 grace 后直接 `kill(-pid, SIGKILL)` 整组。已照搬。
  **`unref` 是必需的**（child + 三条管道），Rust 里一个会话是 3 条线程而进程不等线程退出，
  Node 里活着的 ChildProcess 与管道会把 event loop 钉死——靠探针实测，不靠测试（测试进程自己
  不能退出来验证），已如实写进注释。
  主会话接线时把 `emitHostEvent` / `registerHostDisposer` 两个槽从 `McpRoutesOptions` **上提到
  `hostOptions.ts`**（C1 为避免四卡并行冲突刻意没动那个共用文件）。C1 只拿**发射面**不拿订阅面
  ——传输层能订阅自己发的事件就等于给「事件回环驱动状态」留口子。
  **接线连带**：28 条命令至此**全部落地**，于是经公开工厂已构造不出 `unimplemented`。
  `createNodeHostInvoke.test.ts` 与 `apps/server/src/invokeRoute.test.ts` 里三条「拿某条未实现命令
  当样本」的断言随之失效（后者是**包级测试全绿、全量套件才红**的典型，正是「改模块图要扫波及面」
  那条规则要抓的），已按事实改写：501 那条改用只抛 `unimplemented` 的桩（路由表是 `Partial`，
  将来新增命令而域没跟上时它仍是唯一报信人），百分号编码那条改用 `get_user_home_dir`
  ——C1 落地后 200 与 501 已不能区分「解码对了」与「解码错了」，而 404 与 200 可以。

### C2 · host-node 事件面

- **依赖**：N1
- **改动面**：`packages/host-node/src/events/`
- **判据**：新契约卡。`onHostEvent(name, handler): () => void`，覆盖
  `mcp-stdio-tools-changed` 与 `mcp-stdio-close`。CLI 进程内直接回调，无需序列化。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `8e42d3a`。8 文件 / 68 例。**契约（C3/C4/T 线照抄）**：
  `createHostEventBus(options?) => HostEventBus`，`HostEventBus extends HostEventSource, HostEventSink`
  ——`onHostEvent<Name>(name, handler): () => void` 与 `emitHostEvent<Name>(name, payload)`。
  **是工厂，不是模块级单例 + `configure`**：`hostBridge.ts` 收 loader 是为了消灭「已登记但判据仍为假」
  的窗口，这里更干脆——**根本没有「登记」这个动作**，对象存在即两半都可用；单例反而会把窗口请回来。
  拆成 Source/Sink 两半但**一次创建**：可独立创建的话立刻会出现「发射方挂 A 汇、订阅方挂 B 汇」，
  事件发得好好的就是没人收。
  **载荷约束 = JSON 值且顶层是普通对象，编译期 + 运行期两层**，且**运行期那一遍在 CLI 那条路上也跑、
  不是 dev-only**——判据里「无需序列化」说的是不该白白复制一份数据，本卡兑现的是「**CLI 不付序列化的
  代价，但付序列化的约束**」；只在 dev 跑的话生产 CLI 会接受一个生产 SSE 会改写的值，分岔原封不动回来。
  拦下的包括 `-0`、`Object.create(null)`、稀疏数组、挂了额外属性的数组、循环引用；菱形引用放行。
  「验器规则 == JSON 保真行为」由测试钉住（用 `node:assert` 的 `deepStrictEqual`，因为 vitest 的
  `toEqual` 认为 `{a:undefined}` 等于 `{}`，而那正是要抓的分岔）。
  **事件名取收敛联合**：开放字符串下拼错名字编译通过、运行不报错，症状是「MCP 退出了但前端没反应」，
  既不报错也不指向病因；收敛后同一行当场编译失败。另配运行期 `isHostEventName`（C3 从 SSE 帧读回的是
  `string`）。四种行为：派发中途取消**本次即不再调用**（快照 + 每次调用前复查 `active`，两者缺一不可）、
  handler 同步抛与 Promise reject 都 catch 后报给 `onHandlerError` 并继续（异步那条是「拖垮宿主」最现实
  的路径——Node v15 起未处理 rejection 默认结束进程）、重复订阅记两条独立订阅、重复取消幂等。
  主会话独立复核：把 Rust 侧 `mcp-stdio-close` 改成 `mcp-stdio-closed`，TS 的逐字对拍用例当场转红。
  **三条给下游的更正**：① `tauriStdioConnector.ts:52` 把 close 的 `message` 声明成可选并备了兜底文案，
  而 Rust 永远发这个字段——那是消费方防御不是契约，C4 可保留兜底但**别据此把类型改成可选**；
  ② **`createNodeHostInvoke.ts` 的目录规划把「模型流式响应的 Channel」也划进 `events/`，那两件事不该
  共用这个契约**——MCP 生命周期是全局广播、低频、fire-and-forget、无序无背压，模型流式是按请求的、
  有序、高频、要背压和取消，塞进 `onHostEvent` 会把后者做成畸形；**M 线需要 `events/` 下另一个独立机制**
  （大概是 per-request 的 stream/AsyncIterable），别以为等 C2 就够了；③ Rust 的 `McpLifecycleNotifier`
  用两个 `AtomicBool` 保证 close 至多发一次、且 close 后不再发 tools_changed，**那是 C1 的账**——
  本汇刻意不做去重（会话语义不属于事件面），C1 必须复刻否则 Node 侧会重复发 close。
  发射是全局广播、刻意不按 serverId 路由，保持与 Rust `app.emit` 同形状，好让 C4 逐字照搬既有过滤。

### C3 · server 的 SSE 事件端点

- **依赖**：C2、S2
- **改动面**：`apps/server/src/eventsRoute*`
- **状态**：DONE `97c4a31`（接线随 `54b0746`）。端点 `GET /api/events`，10 文件。
  **`EventSource` 设不了自定义头这个冲突：不退回 `?token=`，改成客户端用 `fetch` + `ReadableStream`。**
  服务端因此一行特例都没开，`authGuard` 四道判定原样管辖。退回 query 会拆掉两样：①「必须带自定义
  头」本身就是第四道防线（跨源 JS 设 `Authorization` 必须先过预检，而我们不回任何
  `Access-Control-Allow-*`，浏览器**根本不发**那条真实请求）；② 这是条**长连接**，URL 会一直挂在
  网络面板里，而 B2 刚做完「取一次就从地址栏擦掉」。**C4 照此实现**，`eventsRoute.testHarness.ts`
  的 `createSseParser` 是给它的参考实现（三个坑已标好）。
  **心跳发、15 秒、SSE 注释行**：第一价值不是保活是**让死亡可被察觉**——两个事件低频到可以数小时
  无字节，被掐之后服务端看得到 `'close'`，客户端却只是「再也收不到」。定时器 `unref()`。
  **重连明确不保证不丢**：不发 `id:`、不认 `Last-Event-ID`、不留重放缓冲。重放缓冲没有正确的大小，
  且**重放语义本身是错的**——两个事件按 `(serverId, sessionToken)` 定位，断线后客户端要的是重新
  确定真相而不是补时间线；重放一条旧 `close` 可能拆掉此后已重连好的会话。
  **C4 的补偿动作（必须做）**：把「连上事件流」当成状态重新同步的触发点——每次(重)连成功后对每个
  自认还活着的会话重拉 `mcp_list_tools`，拉不到的按已关闭处理；**每次**连上都做，包括第一次。
  它自己指出一条测不出来的东西并另开假定时器用例：定时器 `unref()` 后
  `process.getActiveResourcesInfo()` 按设计看不见它，于是「忘了 clearInterval」在真 server 用例里
  是绿的——**没让一条名字好听但抓不住东西的用例留在那儿**。
- **判据**：`GET /api/events` 走 SSE；断线重连不丢事件语义要么保证、要么在卡上写明不保证
  并说明前端如何补偿。跑该目录 vitest
- **模型**：opus

### C5 · 把 MCP 关停钩子挂进两个宿主的信号处理

- **依赖**：C1
- **改动面**：`apps/server/src/main*`（SIGTERM/SIGINT）、`apps/cli` 的关停路径
- **判据**：**来源：C1 交回时点名的实测缺口。** Node 对**没有 listener 的 SIGTERM/SIGINT 走默认
  处置，`process.on('exit')` 回调根本不执行**（C1 已用探针复现），于是 `SIGTERM` 停服会**漏下
  MCP 子进程**——症状是用户机器上几天后堆着一批僵尸进程，而病因离它极远。
  能力包**刻意不自己装信号处理器**：装 SIGINT 会改掉宿主语义（CLI REPL 的 Ctrl-C 是「中断本轮」
  不是「退出」），这类隐式全局正是本仓库反复吃过亏的形态。所以 C1 交出了
  `registerHostDisposer?: (dispose: () => Promise<void>) => void`（已上提到 `hostOptions.ts`），
  由装配层挂进自己的信号处理。
  本卡把它在两个宿主上挂上，并各配一条**真的发信号**的测试证明子进程确实被回收
  （不是「调用了 dispose」，是 `pgrep` 找不到了）。注意 dispose 是异步的而信号处理里进程随时会走，
  想清楚「等多久」以及等不到时的兜底。
- **模型**：opus
- **状态**：DONE `54b0746`。两宿主各接 SIGTERM / SIGINT / SIGHUP，等 2000 ms，超时照样
  `process.exit(128+signo)`——**刻意不用「摘 listener 再把信号发给自己」**：那样退出状态更像 shell
  惯例，但恰好绕开 `'exit'` 回调，把 host-node `exitNet` 的同步整组 SIGKILL 兜底一起绕掉。
  **卡面判据「pgrep 找不到了」本身证不了钩子接上了——本卡实测推翻。** 只要装了信号处理器并经
  `process.exit` 退出，`exitNet` 的 `'exit'` 回调就会同步整组 SIGKILL，孙进程照样消失，**即使
  `registerHostDisposer` 根本没传下去**（它删掉那个参数，只判 pgrep 的用例仍全绿）。所以两条测试
  各加了一条**耗时**判据（退出必须晚于信号 300 ms，因为 `disposeAll` 要等满一个 500 ms grace）。
  **结论：`registerHostDisposer` 买的是「优雅关闭」，「没有孤儿」由信号处理器 + exitNet 已经保证。**
  **卡面「CLI REPL 的 Ctrl-C 是中断本轮」在当前代码里不成立**（pty 驱动真进程实测）：readline 在
  TTY 上把 stdin 切进 raw mode、ISIG 关掉，`^C` 只是个 0x03 字节，**进程级 SIGINT 处理器一次都没被
  调用**；现有语义是「关掉输入通道、REPL 带着一条错误收场」。
  **一条会误导后来人的事实**：`tsx` 的 CLI wrapper 会 fork 子进程并接管信号，被试进程收到 SIGTERM
  时 `'exit'` 照样执行 → **`pnpm serve` / `pnpm cli` 在开发机上根本复现不出漏子进程**，而打包后的
  `dist/main.js`（plain node）复现得出。测试因此用 `node --import tsx`（只装 loader）。

### C4 · 前端 server 版 MCP connector 与配置存储

- **依赖**：C3、C1、B2
- **改动面**：新建 `apps/web/src/mcp/serverStdioConnector.ts`、`serverMcpConfigStorage.ts`
- **判据**：与 `tauriStdioConnector.ts` / `tauriMcpConfigStorage.ts` 同接口；
  `listen()` 换成 C3 的 SSE 订阅。跑 `pnpm exec vitest run apps/web/src/mcp`
- **模型**：opus
- **状态**：DONE `6a5e9ef`（接线由主会话做）。13 个新文件 / 53 例，既有文件零改动；接线后由本卡收尾被打破的
  12 条既存用例并把 storage 从 2 例扩到 7 例。**变异探针 D 推翻了主会话给的探针清单**：主会话要求的三条
  （storage / capabilities / serverHost 判据）全绿时，把 `...(serverHost ? { stdio: … })` 那一行整个删掉
  **16 例一条都不红**——`capabilities.stdio` 仍为真、准入闸照常放行，一直到 `manager.connect` 才因 router
  里没有 stdio 键而失败。本卡自行补了端到端用例（判据取「连接请求真的发出去了」而非「工厂被调用过」），
  主会话独立复跑确认只有那条会红。事件走**一条共享 SSE** + 连接器内分发，过滤判据 `(serverId, sessionToken)`
  逐字照搬（主会话探针：只看 serverId → 1 红）。

---

## P · 持久化收敛

### B8 · server 宿主下用户插件整个特性静默缺席

- **依赖**：C7
- **改动面**：`apps/web/src/plugins/initialize.ts`、`apps/web/src/main.tsx`（传 `host`）
- **判据**：**来源：C7 交回的「宿主二次探测」清单第 2 条，主会话复核。**
  `apps/web/src/plugins/initialize.ts:74` 是 `if (!isTauri()) return`，由 `main.tsx:156` **无参**调用。
  于是 server 宿主下用户插件**整个特性不存在**——不是报错，是安安静静地什么都没有。

  **这不是能力所限。** 主会话核实：插件加载走 `readWorkspaceFile`，而它的判据是
  `hasHostBridge()` / `loadHostInvoke()`（`packages/agent-core/src/runtime/workspaceRead.ts:342-350`）
  ——H 线早就把它从「是不是 Tauri」换成「有没有桥」，而 `main.tsx:140` 的
  `registerHostCommandBridge(host)` 在 server 宿主上是**登记了的**。挡住它的只有那一行 `isTauri()`。

  顺带核对：`desktopProvider.ts:80` 那句注释「只在非 Tauri 宿主发生（那时
  `buildProjectSkillsWorkspaceBridge` 返回 undefined）」在 H 线之后已经过期，一并核实修正。
  判据：server 宿主下插件面可用；装配点收 `ResolvedHost`，`plugins/` 下不再有宿主二次探测。
- **模型**：opus
- **状态**：DROPPED（**被 T1 吸收**）。事实属实且已复核：`plugins/initialize.ts:74` 的
  `if (!isTauri()) return` 让 server 宿主下用户插件整个特性静默缺席，而这**不是能力所限**——
  插件加载走 `readWorkspaceFile`，判据早在 H 线就换成 `hasHostBridge()`，server 宿主上桥是登记了的。
  **修法随 T1 一起做**：桌面端删掉之后 `isTauri()` 这个判据本身消失，那一行只能去掉。
  单独立卡会造成「先按三态修一遍、再随 T1 按两态改一遍」。

### C9 · 删掉已无生产消费方的宿主自探测工厂

- **依赖**：C7
- **改动面**：`apps/web/src/mcp/tauriMcpConfigStorage.ts` 及其测试
- **判据**：**来源：C7 交回的清单第 1 条。** `createDesktopMcpConfigStorage()`
  （`tauriMcpConfigStorage.ts:93-96`，内部 `isTauri()`）在 C7 之后**生产消费方为零**，只剩它自己的
  测试还在用。今天无后果，但它仍从 mcp 目录导出——**下一个接配置存储的人很可能直接伸手去拿**，
  于是「装配点不再有第二处宿主探测」这条刚立起来的纪律被悄悄推翻。
  判据：该函数删除；`apps/web` 全绿；全仓 `isTauri()` 的生产命中只剩 `resolveHost.ts` 一处
  （B8 落地后）。
- **模型**：sonnet
- **状态**：DROPPED（**被 T1 吸收**）。`createDesktopMcpConfigStorage()` 已无生产消费方，但
  **T1 会把整个 `tauriMcpConfigStorage.ts` 删掉**，这张卡的产出会被那次删除覆盖。

### P1 · persistence-sqlite 抽 SQL 传输 port

- **依赖**：—
- **改动面**：`packages/persistence-sqlite/src/sqliteShared.ts` 及其消费方
- **判据**：跨包 API 卡。把直连 `@tauri-apps/plugin-sql` 换成可注入的 SQL 执行 port；
  Tauri 装配注入插件实现，行为不变。跑 `pnpm exec vitest run packages/persistence-sqlite` +
  `node scripts/check-boundaries.js`（`core 禁入 Tauri SQL 插件` 那条仍须绿）
- **模型**：opus
- **状态**：DONE `dae8669`。port 住 `packages/agent-core/src/state/persistence/sqlTransport.ts`：
  `SqlExecutor { execute(sql, params?) / select<Rows>(sql, params?) }` + `SqlExecutorLoader`，
  消费面 `configureSqlExecutor(loader)`。**放 core 是为了可达性**：四类消费方彼此无依赖，唯一都已
  依赖的就是 core；放进任一消费方会逼出反向箭头，另起一个只装三个接口的包要在四处登记。
  core 自己一处都不消费它。**收 loader 不收已就绪 executor**，逐字沿用 `hostBridge.ts` 的理由。
  **卡面「`sqliteShared.ts` 的批量执行」这个前提不存在——主会话已核实，卡面写错了。** 那个文件里
  全是逐条独立 `execute`/`select`；血泪注释说的是**相反**的事：历史问题正是「多次独立 `db.execute`
  发 BEGIN/DELETE/INSERT/COMMIT，语句被路由到池里**不同连接**，事务根本不成立，还把写锁遗留在
  某条连接上」，而修法**不是**打包成一批，是**彻底删掉跨语句事务**、让每次写入都是一条自包含的
  原子语句。所以粒度取**单条**：把「一批语句」做成 port 的一等概念，恰恰是把「这几条落在同一条
  连接上」这个假设重新引进来，而 port 给不出兑现它的手段（HTTP 那条路更给不出）。
  两个方法按「语句有没有返回行」分而非按读写分——PRAGMA 会回一行当前值，必须走 `select`。
  **关于门禁本身的两条事实**（值得记）：① 「core 禁入 Tauri SQL 插件」**只扫
  `packages/agent-core/src`**，从来不扫 `persistence-sqlite`，所以本卡真正收紧的「driver 包不再
  import 插件」**没有任何门禁看着**（要有得把它加进 `capabilityRule`，那会同时判红
  observability-sqlite，属 P4）；② 判据是**精确字符串相等**，`@tauri-apps/plugin-sql/xxx` 子路径
  写法能绕过去。主会话独立复核：在 `sqlTransport.ts` 顶部插一行该 import，门禁当场精确报出该文件
  第 1 行，撤掉后恢复绿。
  遗留：`packages/persistence-sqlite/package.json` 的 `@tauri-apps/plugin-sql` 依赖声明仍在（源码已无
  import），摘它要同步刷 `pnpm-lock.yaml`，与并行卡冲突，留给 P4 一并处理。

### P2 · host-node 的 SQLite 执行

- **依赖**：P1、N1
- **改动面**：`packages/host-node/src/sqlite/` + `commandNames.ts` / `commandArgs.ts` 登记
- **状态**：DONE `e3d174f`。**驱动选 `node:sqlite`（Node 内置），零新增依赖**——`better-sqlite3` 一类
  原生插件意味着「预编译二进制 OS×arch×ABI 矩阵，否则现场 node-gyp」，而 `npx @einfach-agent/server` 正是整棵树
  的动机，原生模块就是「一条命令跑起来」与「装不上时用户无从下手」的分界线；`sql.js`(wasm) 整库在
  内存、落盘要整份写回，与「每次写入是一条自包含原子语句」的耐久性模型直接冲突。
  全仓 `node:sqlite` 只有 `connections.ts` 一处 `import()`，低于版本门槛时翻成点名版本的中文错误
  而不是静默降级。实测实验性警告每进程只打一行（按 feature 去重）。
  **命令名 Node 侧新定**：`sqlite_execute` / `sqlite_select`（全表 28 → **30**），按「语句有没有返回行」
  分而非按读写分。**卡面漏了一处改动面**：`commandNames.test.ts` 断言「恰好 28 条」并与 `lib.rs` 的
  `generate_handler!` 逐字相等——处理不是放宽比对（放宽后 Rust 真漂移就没人报信），而是**点名排除整域**
  `DOMAINS_WITHOUT_DESKTOP_COMMANDS = ['sqlite']`，另配一条反向用例钉「这两个名字确实不在 Rust 列表里」。
  **它没有照字面复用 `configPaths.ts`，主会话复核后采纳**：那个文件解析的是**配置文件**路径且绑死
  `WEB_AGENT_CONFIG_DIR`，而库文件是**应用数据**。跟随该环境变量会让同一个开关在两个宿主上做不同的
  事——桌面版的库仍在应用数据目录、Node 版跑到配置目录，于是「两个宿主看到同一份会话」恰好在最需要
  它的场景（用户开了隔离配置）失效。复用的是 N7 真正的权威 `config/homeDirectory.ts`，有专测钉
  「**不**跟随 `WEB_AGENT_CONFIG_DIR`」。顺带修掉了 findings #10 的两个 bug（XDG 必须绝对 + 空串不算有值）。
  **「没有顺手提供事务/批量」靠四道结构性判据**，不是自觉：公开面只有两个方法（有用例断言
  `Object.keys` 恰好如此）／事务控制语句直接判非法（Node 侧单句柄上 `BEGIN…COMMIT` **真的会成立**，
  放行 = 制造「本地能跑、换宿主就坏」，比两边一起坏更难查）／**多语句拒绝**／ATTACH·DETACH 拒。
  **主会话独立复核了多语句那条**：`node:sqlite` 的 `prepare()` 对 `"INSERT a; INSERT b"` 既不报错也
  不执行第二条，回执仍是 `{changes:1}` —— **成功回执配半份数据**，不拦就是静默丢一半。
  另堵死两个 node:sqlite 陷阱：`$1` 位置绑定当场 `SQLITE_RANGE`（改具名对象）、漏传参数**静默绑成
  NULL**（扫描器数出 `$N` 个数与 `params.length` 双向比对）；行是 null 原型对象，统一展平成普通对象
  以免「本地能跑、上 server 就变」。
  两条独立连接以 **(逻辑连接名, 解析后路径)** 为键，`SQLITE_CONNECTION_NAMES` 是**封闭词表**——名字
  来自 HTTP 外部载荷，开放字符串会让拼错的名字静默开出第三条连接。小订正：桌面侧其实是**三**处
  `Database.load`，后两处读写同一批表，收进一个 `observability` 名字。
  **遗留提醒**：`commandArgs.ts` 现 295 行，**下一条往那张表里加命令的卡必然顶破 300**，需要真拆
  （可用的拆法只有「把跨命令的线上规则单独成文」，按域拆会退化成 part1/part2）。
- **判据**：实现 P1 的 port；数据库路径与桌面版一致（`com.webagent.app/web-agent.db`），
  使两个宿主看到同一份会话。跑该目录 vitest
- **模型**：opus

### P3 · server SQL 端点与前端接线

- **依赖**：P2、S3、B3
- **改动面**：`apps/server/src/sqlRoute*`、`apps/web/src/persistence/persistenceDrivers.ts`
- **判据**：**先读 W4 卡面最后一段**——run index 的分页 cursor 里嵌了一个 snapshot 指纹，
  Node 侧用 sha256 前 16 hex 而 Rust 用 SipHash13，两者不互认。当前两个宿主的会话数据不共享，
  所以跨宿主 cursor 不会出现；本卡把持久化收敛到一起之后**这个前提就没了**，要重新评估
  （失败形态是可恢复的「refresh history」，不是数据损坏，但值得有意识地决定而不是撞上）。
  `persistenceDrivers` 从二选一变三选一；server 宿主下会话落 SQLite 而非 IndexedDB。
  跑 `pnpm exec vitest run apps/web/src/persistence apps/server`
- **模型**：opus
- **状态**：DONE `263a0b0`。**卡面「新建 `apps/server/src/sqlRoute*` 端点」不成立，本卡用证据推翻、主会话复核采纳**：
  `sqlite_execute` / `sqlite_select` 已在 30 条命令全集里且已挂进 `createSqliteRoutes`，而认证在
  `requestRouter.ts` 的 `handleApi` **第一行**、早于所有路由分支——`POST /api/invoke/sqlite_*` 天生就是那条
  端点、天生在认证后面。再开一条 `/api/sql` 只会得到第二处认证接法、第二套 body 上限与失败信封、
  第二处随命令表漂移。交付改为一份只有测试没有源码的回归网。**顺带挖出一个真缺口**：既有的
  `authApi.test.ts` 只拿 `run_shell_command` 一条命令探认证，主会话独立复验——埋一个只针对 sqlite 的
  认证后门，它 12/12 全绿，本卡新增的守卫 2 条转红。那扇门后面是完整的会话库。
  W4 的跨宿主 cursor 指纹裁决为「不对齐，接受可恢复降级」，写在 `persistenceDrivers.ts` 那行代码旁边：
  逐位对齐要在 Node 复刻 Rust 的 `DefaultHasher`，而它明文不保证跨版本稳定——**那是拿一个会响的失败
  换一个不响的失败**。

### P4 · observability-sqlite 同款收敛

- **依赖**：P3
- **改动面**：`packages/observability-sqlite/src/`、`apps/server/src/`
- **判据**：照 P1–P3 的范式；trace viewer 在 server 宿主下能读到 span。
  跑 `pnpm exec vitest run packages/observability-sqlite`
- **模型**：sonnet
- **状态**：DONE `ccf88cc`（装配接线由主会话做）。包侧 5 源 + 6 测试 / 40 例，14 条变异探针。
  **卡面「改动面 `apps/server/src/`」不成立**：server 侧零改动——`sqlite_execute`/`sqlite_select`
  已在 30 条命令全集里，`connection: 'observability'` 已在封闭词表里且有覆盖，P3 已把「端点在认证
  之后」钉死。本卡拆成 transport（注入面）+ schema（DDL 收参数）两个文件而不是照抄 P1 的单个
  `sqliteShared.ts`：读取端要「只解析、不建表」（打开 TraceViewer 是只读动作，让它顺手把遗留
  running span 改写成 cancelled 是实打实的行为变更），写入端要「建过表」，两个 memo 必须同住一处
  才能被 `configure` 一起作废。
  **探针 N 是探针驱动加的测试**：包内没有任何一处从 barrel 取 `configureTraceSqlExecutor`（唯一
  消费方在装配层），漏掉它 38 例一条不红、`tsc` 也过——于是补了 `index.test.ts` 钉住「恰好这五个导出」。
  **「trace viewer 在 server 宿主下能读到 span」真跑通了**：临时探针起真 `startTestServer`，把浏览器侧的
  `createServerSqlExecutor('observability')` 经 `POST /api/invoke/sqlite_*` 打到真 Node 后端 + 真
  `node:sqlite`，driver 写下的 span 被 reader 原样读回。
  **接线连带修掉了 B7 的第 ③ 条**：判据从「是不是 tauri」换成「这一态有没有 SQL 通路」（与
  `persistenceDrivers.ts` 逐字同形）之后，`server + DEV` 两端都是 SQLite，不再写 IndexedDB 读桌面
  SQLite。B5 随后把它那 4 条用例改成钉新行为，并把第 ④ 条改成**正面断言**当作 B7③ 的回归网。
  主会话独立探针：删掉 `configureTraceSqlExecutor(loadExecutor)` 那一行 → **5 条红**
  （P4 明说过这个中间态的症状是「trace 静默不落盘」，而 driver 是 best-effort、不会喊）。
  **B7 的第 ② 条没被修掉**（`.catch(() => {})` 仍在），B5 在测试里钉了「现状档案」并注明
  B7 落地时它必然转红——**做 B7 的人会在这一条上撞一次，撞到的正是他要改的那一格**。

---

## D · 分发

### D1 · 前端产物嵌入 server 包

- **依赖**：S1
- **改动面**：`apps/server/` 构建配置
- **判据**：`pnpm build` 后 server 包自带 `apps/web/dist`，单个 npm 包即可启动，
  不依赖仓库工作树。跑 `node scripts/check-dist.js`
- **模型**：sonnet
- **状态**：DONE `31f54e7`。`apps/server` 加 `main` / `files:["dist"]` / `build: "tsup && node
  scripts/embed-web-dist.mjs"`，根 `build` 末尾追加 `pnpm --filter @einfach-agent/server build`（顺序保证
  `vite build` 先产出 `apps/web/dist` 再嵌）。产物 `dist/main.js` + `dist/public/`。
  `DEFAULT_DIST_DIRECTORY` 改成**运行期探测**：先试 `dirname(import.meta.url)/public`（分发形态），
  不存在回落 `../../web/dist`（开发形态）——靠「是否存在」而非路径巧合，两个候选本来就不会同时存在。
  **卡面判据点名的 `check-dist.js` 其实扛不起本卡**（D1 纠正）：那个脚本只扫 `packages/*` 与 `tools/*`、
  验的是「公开 `exports` 面能被真实消费方 import」，而 `apps/server` 没有 `exports`、是被直接执行的
  进程。真正扛判据的是它自建的隔离验证：`npm pack` → 改写 `workspace:*` 为真实 version → 解到全新
  目录 → **真实 `npm install`（不是 pnpm，排除工作区符号链接魔法）** → 在那里 `node dist/main.js`。
  主会话独立复核：产物里 `grep` 仓库绝对路径**零命中**；从仓库外目录直接跑 `dist/main.js`，
  `GET /` 吐出内嵌前端、`/api/health` 正常、带 token 的 invoke 回 `"/Users/dol"`；
  `@einfach-agent/host-node` 正确 external（`@einfach-agent/core` 全是 `import type`，编译期已擦除）。
  **顺带修掉一个既有缺口**：`check-dist.js` 第一次跑就红，因为 `tools-shell` 等包的 `dist` 是陈旧的
  （还留着 S5 改名前的 `detectHostPlatform`）。它重建了全部 17 个包的 `dist`。**这个脚本不在
  `.github/workflows/ci.yml` 里**，所以那份陈旧态一直没人发现——与主会话在 S4/S5 撞到的「陈旧 dist
  遮蔽 src」是同一个根。D2/D3 值得把它加进 CI。

### D2 · npm 包元数据与 bin launcher

- **依赖**：D1、S4
- **改动面**：`apps/server/package.json`、`apps/server/bin/`
- **状态**：DONE `3828602`。`bin`（26 行转发 shim，带 shebang；名字随 `f2077a4` 改为 `einfach-agent`），
  `files: ["dist","bin"]`，`engines: ">=22.0.0"`，保留 `private: true`。
  **卡面「`private: true` 会让 `npm publish --dry-run` 直接拒绝」是错的——本卡读源码 + 实测推翻。**
  `npm/lib/commands/publish.js:148` 是 `if (workspace && manifest.private)`，`workspace` 只在
  `npm publish -ws` 时才有值，**从包目录直接 publish 根本不走那条检查**。所以「要判据就得摘 private」
  这个取舍不存在，两者兼得。保留 private 的真理由：**依赖闭包全是私有包**（单独发 server，它的
  `dependencies` 指向 registry 上不存在的 `@einfach-agent/core@0.1.0`，用户 `npm i` 当场 404），
  发布是整闭包的决定、归 D3。
  **一条发布路径上的硬伤（主会话已独立复核）**：`npm pack` 把 `workspace:*` **原样留着**，
  `pnpm pack` 才改写成 `0.1.0`。**用 `npm publish` 发出去的包是装不上的**——`workspace:*` 不是合法
  semver。D3 必须用 `pnpm publish`。
  `engines` 的 `>=22` 是**支持策略下限不是技术下限**（技术下限约等于 18）：CI 两个 job 都是 22，
  低于 22 从没跑过；且今天 Node 18 与 **20 均已 EOL**。README 里那句「≥20.19 或 ≥22.12」是
  **Vite 7 的 `engines` 原样抄来的构建期约束**，发布出去的 server 包不跑 Vite，属误植。
  **给 P2 的提醒**：若选 `node:sqlite`，下限要提到 `>=22.5.0`。
  主会话独立复核：pnpm pack 四个包 → 仓库外 `npm install` → `./node_modules/.bin/web-agent` 起服务，
  health / invoke / 内嵌前端全通，`node_modules` 里引用仓库路径的文件**零个**；tarball 22 文件、
  零测试零源码。
  **包名已由用户拍板并落地（`f2077a4`）**：scope 从 `@web-agent` 改为 **`@einfach-agent`**，
  bin 命令改为 **`einfach-agent`**。D2 查证到的决定性事实是 `@einfach` scope 在公共 npm 上归本仓库
  同一账号（`@einfach/core` 的 maintainer 就是 `allroad88888888`），而 `@web-agent` 无证据已注册
  ——**scope 没注册就发不出去**。
  用 `@einfach-agent` 当 scope 而不是 `@einfach/agent-*`：**`@einfach/core` 与 `@einfach/react` 是本
  仓库自己依赖的 einfach 状态库**，占用 `@einfach/core` 会直接撞车；换成独立 scope 后 20 个包全部
  1:1 平移（子名一个没改），冲突面为零。
  落地方式是一次精确替换 `@web-agent/` → `@einfach-agent/`（606 文件 / 1268 处）。**用户数据标识
  一律未动**：`web-agent.db`、`~/.webAgent/`、IndexedDB 名与 storage key 改了会孤立既有本地数据。
  用户可见与握手标识一并改了：启动横幅、`SERVICE_IDENTIFIER`（server 与 B1 的客户端副本两侧同改
  ——B1 的文本对拍守卫当场咬住了单侧改动，正是它存在的意义）、MCP `clientInfo`。
  六条门禁全绿；主会话另做隔离验证：pnpm pack 四个包 → 仓库外 `npm install` →
  **`npx einfach-agent` 起服务**，health / invoke 全通（**注意**：这条跑在已把 tarball 装进 consumer 目录之后，bin 已在本地 `node_modules/.bin`；干净机器上的入口是 `npx @einfach-agent/server`，见「目标」段的修正）。
- **判据**：对外交付卡。`npm pack` 产物在**干净目录**里 `npx` 能起；
  `files` 字段不夹带源码与测试；Node 版本下限声明明确。
  跑 `npm pack --dry-run` 逐条核对文件清单
- **模型**：opus

### D3 · 发布流水线

- **依赖**：D2
- **改动面**：`.github/workflows/`
- **判据**：tag 触发、跑完整门禁（check-docs → check-boundaries → check-state → test → build）
  才发布；**不需要任何签名 Secret**。首次以 dry-run 模式验证
- **模型**：opus
- **状态**：DONE `3e5c8bb`。**判据不能完整达成，本卡如实交回而没有用 dry-run 蒙混**——发布闭包 4 个包全是
  `private: true`，真发布一律 EPRIVATE。而蒙混恰恰是这张卡最危险的陷阱，主会话独立复验了两条：
  ① `npm publish --dry-run` 对 private **结构性失明**（`npm/lib/commands/publish.js` 是
  `if (!dryRun) await otplease(..., libpub(...))`，而 EPRIVATE 在 `libnpmpublish` 的 publish() 第一行）；
  ② 更糟的是 `pnpm -r publish`：全私有时打印「There are no new packages that should be published」并
  **exit 0**，主会话拿打不通的 registry（127.0.0.1:1）实跑，连 ECONNREFUSED 都没有——它压根没去连。
  所以流水线里有一条**独立的前置判定**，dry-run 与真发布都跑（主会话验过它在当前仓库上确实 exit 1）。
  **顺序陷阱（本卡负向实测）**：全新 checkout 上先跑 `pnpm -r build` 会失败——`apps/server` 的 build 末尾
  要嵌 `apps/web/dist`，那份产物只有根 `pnpm build` 的 `vite build` 才产出。故 `pnpm build → pnpm -r build
  → check-dist`，不可倒。`check-dist` 同时进 `ci.yml`（每个 PR）：陈旧化是每个 PR 都能引入的，
  只在 tag 上拦等于让它在主干里躺到发版当天。

### D3d · `check-dist` 的 `skipLibCheck: true` 掩盖了消费方会撞的类型错

- **依赖**：D3b
- **改动面**：`scripts/check-dist.js`；处置上游类型错的方案待定
- **判据**：**来源：D3b 实测（含对照实验），主会话采纳。**
  `scripts/check-dist.js:141` 的 `verifyNodeNextDeclarations` 写死 `skipLibCheck: true`，于是**消费方
  只要关掉 skipLibCheck 就会看到、而门禁永远看不到**的类型错被静默放过。D3b 把 tarball 装进干净目录、
  `moduleResolution: NodeNext` + `strict` + `skipLibCheck: false` 实测到两类：
  · `@einfach-agent/host-node` 的 `dist/sqlite/databasePath.d.ts` 报 `TS2503: Cannot find namespace 'NodeJS'`
    ——根因是 `@types/node` 在 devDependencies 而公开 d.ts 用到了它（**这一条已在 D3b 里修掉**）；
  · **存量、且不是本仓库引入的**：`@einfach-agent/core` 的 d.ts 报 51 条、上游 `@einfach/core@0.4.0`
    自己报 8 条（`TS2834: Relative import paths need explicit file extensions … 'nodenext'`，出在
    `node_modules/@einfach/core/@types/index.d.ts`），级联成 `Store` / `Atom` / `History` / `AtomEntity`
    全部 `has no exported member`。仓库自身构建绿是因为它用的不是 NodeNext 解析。
  **所以这张卡不能只是把 true 改成 false**——那会当场把上游那 59 条抖出来。要先定处置方案
  （给上游提 issue / 本地 patch / 在门禁里把上游单独豁免但不豁免自家包）。
  判据：门禁能抓到「自家包的 d.ts 在 NodeNext + 不跳过 libCheck 下不成立」，且上游的既有问题有
  **具名的、写得出理由的**豁免，而不是靠一个全局 `skipLibCheck` 把两者一起盖住。
- **模型**：opus
- **状态**：DROPPED（**前提消失**：用户裁决「不发，仅本地跑」）。`check-dist` 的 `skipLibCheck: true`
  掩盖消费方类型错这件事属实（D3b 有实测 + 对照），但它服务的是「别人 npm install 我们的包」这个
  场景，而那个场景不存在了。**本卡真正要解的那条已经在 D3b 里解掉了**（`@types/node` 移入
  dependencies，实测 `TS2503` 归零）；剩下的是上游 `@einfach/core@0.4.0` 的 59 条 NodeNext 错，
  那是上游的账，不该由本仓库的门禁扛。

### D4 · README 与 docs 更新

- **依赖**：M5
- **改动面**：`README.md`、`README.zh-CN.md`、`docs/README.md`、`CLAUDE.md`、
  **`docs/config-directory-override.md`**（N7 交回时点名：它现在只讲「桌面版」，而那套语义
  ——默认路径、旧配置安全复制、`WEB_AGENT_CONFIG_DIR` 隔离与密钥边界——已在 Node 宿主上等价成立）
- **判据**：对外长文写作卡。README 的「三个宿主」表述改为浏览器自托管 / CLI / 桌面套壳；
  删掉「浏览器预览下 Tauri 桥支持的工具不可用」这类已过期的说明；
  `CLAUDE.md` 的「持久化与运行环境」节同步。跑 `node scripts/check-docs.js`
- **模型**：opus
- **状态**：TODO

---

## T · Tauri 退成套壳

### C6 · `/api/invoke/:command` 的业务失败塌成不透明 500

- **依赖**：C4、P3
- **改动面**：`apps/server/src/invokeRoute.ts` 与 `invokeRouteError.ts`
- **判据**：**来源：C4 与 P3 从两条独立路径撞上同一处，主会话在真 server 上端到端复现。**
  `invokeRoute.ts` 的 catch 只认 `NodeHostCommandError`，其余异常一律重抛 → `requestRouter.ts`
  收成 `text/plain` 的 500「服务端内部错误。」。实测（`pnpm serve`，带真 token）：

  ```
  POST /api/invoke/mcp_config_read   → 200  application/json  {}
  POST /api/invoke/mcp_list_tools    → 500  text/plain 「服务端内部错误。」
  服务端 stderr: McpCommandError … kind: 'invalid_input'
  ```

  **这不是文案难看，是一条判据被切断。** `tools/mcp` 的 `failureClassification.ts` 对 stdio 桥
  **只认 `kind`**，且注释明写「Only kinds listed here are permanent; every other kind … falls to
  the temporary default」。于是 kind 丢了之后，`command_spawn_failed`（Tauri 上是**永久**失败，
  一条根本不存在的命令）在 server 宿主上被判成临时失败 → **无限退避重连**。
  SQL 那侧的同一处表现是：语法错、游标非法这些准确中文全丢，客户端只能给
  「本地服务返回了非预期的错误响应（HTTP 500）」，且它们还被当作预期外异常写进 server 的 stderr。
  **修法要通用，不要给 MCP 开特例**——30 条命令都在这条路上。C4 建议 `McpCommandError` 映射成
  `{ statusCode: 502, error: error.kind, message }`（信封的 `error` 字段本来就是「给程序看的稳定
  标识」，与 `kind` 是同一个东西，不必给信封加字段）；但本卡要先判断这个形状对其余各域是否也成立。
  客户端那一半 C4 已写好并测好，**服务端补上之前是安全降级**（拿不到 kind → 判可重试），有一条用例
  钉住今天的现实。
  判据：四个域各有一条用例断言业务失败带得出结构化标识；且 MCP 那条的 `kind` 端到端穿到客户端。
- **模型**：opus
- **状态**：DONE `d6c30ab`。7 个文件，`invokeRouteError.ts` 25→113 成为**全部** invoke 失败的唯一映射表，
  catch 不再重抛。**C4 建议的形状被本卡用证据推翻，主会话复核采纳**：host-node 349 个抛出点里
  **309 是裸 `new Error`**（主会话独立复数：309 裸 Error / 28 McpCommandError / 23 model 系），
  它们是等价移植 Rust `Result<T, String>` 的产物，**没有可转发的标识**。所以信封形状留用，
  「`error` = 各域 kind」那一半改成「**转发**域自己的标识（mcp 的 `kind` / model 的 `reason`），
  没有的落稳定兜底码 `command_failed`」——**本层转发标识，不生产标识**。
  刻意没做按命令名推 `<domain>_command_failed`：调用方本来就知道自己调的哪条命令，前缀不带新信息，
  却会造出一个 host-node 从未声明过的标识。
  **主会话在真 server 上端到端验收**：探不存在的可选目录 → `502 {"error":"command_failed",…}`
  （原为 `500 text/plain 服务端内部错误。`）；`mcp_list_tools` 失败 → `502 {"error":"invalid_input"}`
  ——**kind 终于穿过 HTTP，C4 报的「永久失败被判成临时 → 无限退避重连」断根**；服务端 stderr
  堆栈行数 **0**（M5 报的三份「预期外异常」噪声消失）。
  **探针 A 暴露了一处只有跨端守卫才拦得住的东西**：把 `COMMAND_FAILURE_STATUS` 从 502 改掉只红 2 条，
  关键那条是读 `apps/web/src/mcp/serverMcpCommands.ts` 源码文本比对的守卫——没有它，改这个数
  **一条都不会红**（apps/web 的用例喂的是写死状态码的假 fetch）。手法照抄 M6 的文案守卫。
  判别全部按字段：`reason` 用 `Object.hasOwn` 而非 `in`（`reason:'constructor'` 能冒充分发失败）；
  `message` 按字段读而非 `instanceof Error`（`McpCommandError.toJSON()` 的产物是普通对象）。
  **卡面「四个域」少算了**：经 `/api/invoke` 能触到的是 workspace/shell/mcp/config/sqlite **五个**。
  **C8 没有被本卡消解**：浏览器控制台那行 `Failed to load resource` 任何非 2xx 都会打，
  换 reason/换状态码一行都消不掉；本卡明确论证正解在「调用方别拿异常当探测手段」，且要 Rust 侧一起动。

### C8 · 可选目录探测在 server 宿主上变成噪声 500

- **依赖**：C6
- **改动面**：待定（`apps/server/src/invokeRoute*.ts`，或 `tools/skills/src/projectSkillsLoader.ts` 的探测方式）
- **判据**：**来源：M5 验收，主会话在真浏览器里撞上并查实根因。**
  新建一个工作区后发第一条消息，浏览器控制台当场三条
  `500 @ /api/invoke/list_workspace_files`，服务端 stderr 三份完整堆栈
  （`path '.claude/skills' / '.webAgent/skills' is not accessible … ENOENT`）。

  三件事已经查实，**别再重查**：
  · **不是移植缺陷**——`apps/desktop/src/workspace_read_paths.rs:33` 是同一句文案、同样在路径不存在
    时报错，Node 与 Rust 行为一致；
  · **功能上无影响**——`projectSkillsLoader.ts:164-169` 明写「目录不存在是常态（多数根都没有），
    静默返回空」，M5 那轮对话里 `skill_manifest` 确实返回了完整清单；
  · **问题在传输层**——桌面上「探测一个可选目录、没有」是一次被 loader 吞掉的 `invoke` reject；
    到 server 宿主上同一件事变成三条 HTTP 500 + 三份被 `requestRouter.ts` 的 `reportError`
    当作**预期外异常**记录的堆栈。

  **为什么值得修**：噪声会淹没真正的 500，而那恰恰是 C6 要让 500 重新有意义的那件事。每开一个新
  工作区就先送三条，久了没人再看控制台里的 500。
  判据：新建空工作区后首轮对话，控制台零 500、服务端 stderr 零「预期外异常」，而**真正的**宿主
  内部错误仍然照报。**不许为消噪声放宽路径禁闭**——`resolveExistingWorkspacePath` 抛错是正确行为，
  `realpath` 失败与「越界」共用同一条出口是有意的。
- **模型**：opus
- **状态**：DROPPED（**范围裁剪**）。**服务端那一半已被 C6 修掉**：主会话在真 server 上复验，
  探不存在的可选目录现在回 `502 {"error":"command_failed",…}`，服务端 stderr「预期外异常」堆栈
  归零。剩下的只有浏览器控制台那行 `Failed to load resource`——**任何非 2xx 都会打，404 也打**，
  换 reason、换状态码一行都消不掉。C6 论证过正解在「调用方别拿异常当探测手段」，且要 Rust 侧
  一起动才不制造宿主差异；而 Rust 侧即将随 T1 整个删掉，这个前提也没了。不值一张卡。

### D3b · 摘掉发布闭包的 `private: true`

- **依赖**：D3
- **改动面**：`apps/server`、`packages/agent-core`、`packages/agent-ai`、`packages/host-node` 四个
  `package.json`
- **判据**：**来源：D3 交回时点名的阻塞项。** 这四个包是 `pnpm -r --filter "@einfach-agent/server..."`
  算出的运行期依赖闭包，全部 `private: true`，于是 D3 的流水线永远走不到 publish。
  D2 当初保留 private 的理由是「闭包全私有，单发 server 会 404」——而四个一起发正是解法，**理由已消解**。
  判据：D3 那条闭包前置判定转绿；`pnpm -r --filter "@einfach-agent/server..." publish --dry-run`
  列出 4 个包。**注意 dry-run 本身证明不了能发**（见 D3 状态段的两条实测），所以判据必须是前置判定。
- **模型**：opus
- **状态**：DONE（**部分回退**：`private` 那一半随用户裁决改回）。
  本卡按判据摘掉了四个包的 `private: true`、并**自查出它自己引入的风险**：本机
  `npm config get registry` 是 `http://npmjs.deepfos.com/`（公司内网、token 有效），仓库无 `.npmrc`，
  于是摘掉之后一句裸 `pnpm -r publish` 会把四个包**以 public 身份外发到内网**（本卡实测拿到那行
  `Publishing to http://npmjs.deepfos.com/`）。主会话据此要求补 `publishConfig.registry`，
  **实测它连显式 CLI `--registry` 都覆盖不掉**——是真护栏不是默认值。
  **随后用户裁决「不要发，仅本地跑」，`private: true` 已全部改回**（见「目标」段）。保留下来的是
  三样与发布无关、对本地验证同样成立的东西：`publishConfig.registry`（冗余护栏）、
  `packages/host-node` 的 `engines: >=22.13.0`、`@types/node` 从 devDependencies 移入 dependencies。
  **`engines` 的下限本卡核实后从 D2 记的 `>=22.5.0` 提高了**：API 面确实只要 22.5.0，卡住下限的是
  旗标——`connections.ts:48-50` 的错误文案原文就写着「需要 Node 22.13（或 23.4）以上」，而
  `apps/server` 是 `node dist/main.js` 裸跑，没地方塞 `--experimental-sqlite`。主会话据此把
  `apps/server` 的 `engines` 也从 `>=22.0.0` 提到 `>=22.13.0`——**传递依赖已经把技术下限钉死了，
  声明一个更低的下限只会让 22.0–22.12 的用户装得上、第一次落盘就挂**。
  `@types/node` 那条有实测复现 + 对照：消费方 `skipLibCheck: false` 下撞
  `TS2503: Cannot find namespace 'NodeJS'`，移入 dependencies 后归零。**`check-dist` 抓不到它**
  （`scripts/check-dist.js:141` 写死 `skipLibCheck: true`）→ 已立卡 **D3d**。
  连带：`@types/node` 跨字段搬家让 `pnpm-lock.yaml` 陈旧、`--frozen-lockfile` 转红，
  主会话按本卡给的最小改法修掉（净 diff 1 增 1 删）。

### D3c · 发布版本策略

- **依赖**：D3b
- **改动面**：四个包的 `version`，或引入 changesets
- **判据**：**来源：D3 交回时点名。** 四个包现在都钉在 `0.1.0`。首发没问题；**第二次发**时若 core
  改了却没涨版本号，`pnpm -r publish` 会跳过 core，发出去的 server 依赖的是 registry 上那份**旧** core，
  **且不报错**。要么 lockstep 涨版本，要么上 changesets。判据：构造「core 改了但没涨版本」的情形，
  流水线必须红。
- **模型**：opus
- **状态**：DROPPED（用户裁决「不要发，仅本地跑」）。本卡要解的「第二次发时 core 改了没涨版本会被静默
  跳过」只在真发布时成立。D3b 顺带查到的一条隐藏输入一并记档，**将来若改主意必须重新捡起**：
  `publishConfig.registry` 只管住 PUT 的目标，而 **pnpm 递归发布的「这个版本发过没有」预检走的是
  另一条 registry 解析**（实测：显式 CLI `--registry` 在预检上赢）。两者不是同一个 registry 时，
  pnpm 会拿 A 的版本表决定要不要往 B 发。

### B5 · 五个宿主分流模块补 colocated 测试

- **依赖**：M3、C4
- **改动面**：`apps/web/src/host/` 下五份新测试
- **判据**：**来源：主会话接线 M3 时发现。** `host/` 下九个模块里有五个没有 colocated 测试：
  `hostCommandBridge` / `hostModelCredentialHost` / `hostModelTransport` / `hostObservability` /
  `hostRecoveryFlush`。M3 已补掉 `hostModelTransport` 那一份，**其余四个仍是零覆盖**。
  现有的只有三份装配测试的**间接**断言，而 `main.serverHost.test.tsx` 只断言了「桌面那条没被调用」，
  **没有任何一条断言 server 宿主真的拿到了对的实现**——接错分支、顺序写反，104 例一条都不会红。
  M3 交回的两条范式事实要照用：① **vitest 4 的 `restoreMocks: true` 不碰 `vi.fn()`**，只管
  `vi.spyOn` 造的 spy，「某工厂一次都没被造出来」这类断言会跨用例串账，要显式 `vi.clearAllMocks()`；
  ② **`import.meta.env.DEV` 在 vitest 下默认为 `true`**（`hostObservability.ts:38` 也读它），
  不 `vi.stubEnv('DEV', …)` 就等于在测 dev 形态，而且它会绿。
- **模型**：opus
- **状态**：DONE `884d9eb`。4 份 colocated 测试 / 21 例，**生产代码零改动**（md5 逐一比对）。11 条变异探针全咬。
  **本卡最有价值的是它按纪律「只报不改」挖出的 5 个生产问题**，主会话逐条复核，前三条已立卡：
  ① **五个分流模块全无穷举守卫**——主会话独立探针：给 `ResolvedHost` 加第四态 `{ kind: 'sidecar' }`
  跑 `tsc -b`，`apps/web/src/host/host*.ts` **零编译错误**（基线 exit 0，对照成立）。
  `hostCommandBridge` 的 `switch` 没有 `default`，第四态直接返回 undefined → **不登记桥** →
  文件/shell/Git/rg 工具整类对模型不可见、执行一律早退且不报错。→ **B6**
  ② `hostObservability.ts` 的 `.catch(() => {})` 吞掉 SQLite driver 加载失败且无回落，
  `configureObservability` 一次没被调用 → core 的 `enqueue()` 里 `if (!current) return`
  （`observability/trace.ts:56`，主会话复核）**直接丢弃**所有 span，无日志无告警无兜底。→ **B7**
  ③ **`server + DEV` 这一格写入端与读取端劈开了**：写 IndexedDB（driver 只认 tauri），
  读走 `createDevSqliteLogReader`（DEV 判据排在宿主判据之前）→ TraceViewer 一条看不到。
  而该文件头声称的正是「两端在同一个函数里按同一个宿主判据选」。与 C7 同类。→ **B7**
  ④⑤ 次要：static 支不 `configureHostInvoke(undefined)`（运行时切宿主会留旧桥）；
  两条 flush 安装器的解绑函数被丢弃（dev HMR 累积监听）。
  顺序敏感点的钉法值得后人抄：`hostModelCredentialHost` **模块内部没有可钉的顺序**（三支互斥），
  真正的敏感点是**跨模块**的——`hostModelTransport` 那条「server 排在 DEV 之前」的正确性依赖
  本模块「没有 DEV 分支」，所以钉法是逐态钉「DEV 抢不走任何一态」。

### C7 · 工具名缓存的宿主判据没跟上，与服务配置分家

- **依赖**：C4
- **改动面**：`apps/web/src/mcp/toolNameCacheStorage.ts`、`service.ts`
- **判据**：**来源：C4 交回时点名。** `createDesktopToolNameCacheStorage()`
  （`toolNameCacheStorage.ts:139-140`）仍然自己 `isTauri()`，而它由 `service.ts:100` 作为默认值取用、
  **根本收不到装配点传下来的宿主态**。后果：server 宿主下「服务配置」经 `/api/invoke/mcp_config_*`
  进 `~/.webAgent/config.json`，而「工具名缓存」落浏览器 localStorage——**两份状态分家**。
  不是回归（B5 之前也这样），但 C4 把配置那一半收口之后它变成一处真实的不一致。
  同一处二次探测也逼得测试必须把 `isTauri` 替身与 `host.kind` 手工对齐。
  判据：缓存与配置在三个宿主下落到同一处；装配点不再有第二处宿主探测。
- **模型**：opus
- **状态**：DONE `2dc513f`。删掉 `createDesktopToolNameCacheStorage()` 那处 `isTauri()`，两条配置文件通道
  （tauri/server，只差一次调用）抽成共享工厂，装配点两处存储由**同一个 `host`** 分派。
  **卡面有一处不准，本卡推翻且主会话复核采纳**：卡面说「C4 把配置那一半收口之后」——**配置那一半
  其实没收口**，`createDesktopMcpConfigStorage()`（`tauriMcpConfigStorage.ts:94`）内部**也自己
  `isTauri()`**。所以「装配点不再有第二处宿主探测」这条判据只修缓存那一半达不到，本卡把配置那一半
  也改成显式三分支（这动到了硬边界点名的那处，本卡说明了理由并给了回退路径，主会话核实后采纳）。
  **探针 H 是「探针清单本身不够」的又一例**：把 `service.ts` 的默认值改回会 `isTauri()` 的旧写法，
  `apps/web` **856 例一条不红**——因为装配点现在总会显式传 storage，默认值失去了所有生产消费方。
  而那正是本卡要根除的形态（将来有人新加一条不传 storage 的路径，bug 原样复活）。本卡为此补了
  `service.defaultStorage.test.ts`（`isTauri` 替身故意答 `true`，断言默认通道仍落 localStorage 且
  `invoke`/`isTauri` 一次没被调用），补完后 H 转 7 红。主会话独立复跑确认。
  **交回的「全仓宿主二次探测」清单**：① `createDesktopMcpConfigStorage()` 本卡后生产消费方为零，
  建议删（→ 并入 C9 一并处理）；② `plugins/initialize.ts:74` → **B8**；③ `workspaceDialog.ts` 已被
  U-1 覆盖（`@tauri-apps/plugin-dialog` 无浏览器等价物）。
  未验：三个宿主都只在 jsdom + 替身下验证，「server 宿主下缓存真的落进 `~/.webAgent/config.json` 的
  `mcp.toolNameCache`」只验到「发出了 `mcp_config_write {patch:{toolNameCache:…}}`」，没起真服务看文件。
  `service.ts` 仍 426 行超限（存量，未拆）。

### T1 · 删掉 `apps/desktop`，桌面端整条退出

- **依赖**：M5
- **改动面**：删除 `apps/desktop/`；`.github/workflows/`（`desktop-native` job、`release-desktop.yml`）；
  根 `package.json` 的 tauri 脚本与依赖；`apps/web` 里**只为 tauri 宿主存在**的那些文件与分支
- **判据**：**取代原 T1→T2→T3→T4 四张（用户裁决）。** 原方案是「Tauri 起 sidecar Node 进程 →
  前端切 server 宿主 → 删 Rust → 精简 CI」，四张卡换来「原生窗口 + 单一实现」。裁掉它的理由是
  **那个原生窗口照样要签名才能分发，而绕开签名是这整棵树的唯一动机**——做出来的东西发不出去。
  直接删则一张卡拿到同样的「单一实现」，还顺带让 `cargo test` 与三平台 `tauri build` 退出 CI。

  **现在的实况是这棵树自己造出来的负债**：同一批 30 条命令有**两份完整实现同时活着**——
  `apps/desktop/src/*.rs` 16535 行（其中 workspace/shell/mcp/model 相关 15393 行是真业务逻辑，
  不是壳）与 `packages/host-node/src` 19535 行。W 线只做了移植，一行 Rust 都没删。

  **本卡吸收了 B8 与 C9**：桌面端删掉之后 `isTauri()` 这个判据本身消失，
  `plugins/initialize.ts:74` 的 `if (!isTauri()) return`（server 宿主下用户插件整个静默缺席，
  **已复核不是能力所限**——插件走 `readWorkspaceFile`，判据早在 H 线换成 `hasHostBridge()`）
  只能去掉；`tauriMcpConfigStorage.ts` 整个文件消失。

  **不许留下不可达的死分支。** 宿主从三态减到两态（server / static）之后，
  `ResolvedHost` 的 `kind: 'tauri'` 支、五个 `host*.ts` 里的 tauri 分支、
  `tauriSqlExecutor` / `tauriModelTransport` / `tauriStdioConnector` / `tauriMcpConfigStorage`
  这些**只为那一态存在**的模块都要一并删——留着就是把「两份实现」换个形式再留一遍。
  判据：全仓 `@tauri-apps` 零命中；`isTauri` 零命中；八条门禁全绿；`pnpm serve` 与本地
  pack→install 两条路径实跑通过。
- **模型**：opus
- **状态**：TODO

## 未决

**U-1 · `workspaceDialog` 的浏览器替代。**
`packages/agent-core/src/runtime/workspaceDialog.ts` 用 `@tauri-apps/plugin-dialog` 开原生
目录选择框，浏览器里无等价物（File System Access API 拿不到真实路径）。三个选法：
server 端做目录浏览 UI（体验最好，约 3 卡）／输入框手输路径 + server 侧校验（约 1 卡）／
读配置文件里的 workspace 列表（约 1 卡）。T2 之前桌面侧仍可用原生插件，所以不阻塞主线，
但纯浏览器版在此之前无法切换工作区。

**U-2 · 对拍 fixture 的覆盖下限。**
W16/W17 覆盖 patch、change journal、写锁、读限额。是否要求 Rust 侧 161 个测试函数全部
有 TS 对应，还是只钉住上述四块的边界用例？前者成本高一个量级，后者留下未覆盖面。
T3 的删除动作依赖这条的答案。

**U-3 · 多 workspace 切换。**
桌面版靠原生目录选择器切工作区。浏览器自托管下，是让 server 启动时用 `--workspace` 固定一个，
还是支持运行时切换？影响 S4 与 U-1 的选型。
