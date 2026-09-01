# 030 执行报告

状态：DONE

## R1 修复

- 锁 owner 规则改为：可解析 owner 的 PID 存活时绝不参考 mtime 抢锁；dead PID 可立即恢复；仅 malformed owner 按 stale age 恢复。
- recovery/release 先把路径 rename 到唯一 claim，再核对观察到的完整 owner 内容；内容变化时通过 hard-link 的 `EEXIST` 语义无覆盖恢复，不能删除或覆盖后来者。锁对象提供写前 `assertOwned()`，store 在 append 前验证 token。
- `flush()` 以调用时的 operation id 为 barrier，等待覆盖范围内任务，保留并传播调用前已经 settled 的失败；错误被一次 flush 报告后消费。
- 最后 record 改为 `FileHandle.stat/read` 的 bounded tail read，最多读取 `AGENT_ROLLOUT_MAX_LINE_BYTES + 2` 字节，不再整文件读取或 split；保留半行、超长尾行、空尾行与非法 record corruption。
- 新增针对性测试：live PID + stale mtime 不可抢锁、ownership loss 写前失败、later owner 不被 release 删除、settled append failure 由 flush 传播、32 MiB sparse history 仅靠尾读继续 ordinal。

## R2 修复

- malformed/dead recovery candidate 现在由同一个已打开 `FileHandle` 读取内容与 stat，不再把 pathname 的旧 stat 和另一代内容拼接。
- rename 到唯一 claim 后，同时比较候选 handle、观察 stat 与 claimed pathname 的文件 identity：优先 `dev/ino`，无 inode 的平台使用 birth/ctime/size/mode metadata；同时复核候选内容，覆盖同 inode 初始化竞态。
- release 同样要求 owner handle identity 与 PID/token 内容均匹配，保留 R1 的 later-owner 防护。
- 新增可控竞态测试：观察旧空 stale lock 后，将 pathname 替换为新创建的空 lock；reclaimer 必须因 identity 不同恢复新代并最终 wait timeout，测试核对新 handle 与 pathname 仍为同一 inode。

## 实现

- `rolloutPath.ts`：用 SHA-256 将逻辑 target 的各 id 映射为固定 64 字符 key；生成 root/child 规定物理布局，并返回稳定 `historyId`。调用方无法注入 raw path。
- `rolloutLock.ts`：实现 history 专属 `wx` 文件锁、PID/token owner、heartbeat、活跃锁等待、dead/stale 锁恢复、token 校验释放及等待超时。
- `jsonlStore.ts`：实现每 target 本进程队列；锁内读取并校验完整尾行、连续分配 ordinal、整批编码为带结尾换行的单次 append，随后 `FileHandle.sync()`；编码、append、sync 与 corruption 错误均向调用方传播；`flush()` 等待全部本地队列。
- 显式限制：单行沿用 core codec 的 byte limit；单批最多 1000 records / 16 MiB；lock wait 默认 10 秒。

## 验证

- 定向 Vitest：3 files / 18 tests 通过；覆盖独立 Node 进程并发批写、批次不交错、不同 target、跨代 identity-safe active/stale/非 owner 锁、wait timeout、bounded tail、半行 corruption、target mismatch、batch limit、flush 成功与失败传播。
- `pnpm exec tsc -b`：通过。
- `pnpm exec tsc -p packages/host-node/tsconfig.json --noEmit`：通过。
- `pnpm check:boundaries`：通过（仅输出仓库既有观察项）。
- `pnpm check:state`：通过。

## 文件职责与行数

- `rolloutPath.ts`：40 行，只负责逻辑 target 到路径的映射。
- `rolloutLock.ts`：181 行，只负责跨进程锁生命周期。
- `jsonlStore.ts`：168 行，只负责 JSONL 串行持久化。
- 全部实现与测试文件均低于 300 行。
