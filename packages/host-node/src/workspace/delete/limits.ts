// 可恢复删除的体量预算：逐字照搬 apps/desktop/src/workspace_delete.rs 的两个常量
// ---------------------------------------------------------------------------
// 只有常量与按常量做的判定，一行 IO 都没有——遍历那棵树是 inspectTree.ts 的事。分开是为了
// W16/W17 的跨语言对拍能直接喂 `(entries, bytes)` 数对，不必先在磁盘上堆出 20001 个文件。
//
// ═══ 超限时是**拒绝删除**，不是「删掉但标记不可逆」═══
// write 域有 `REVERSIBLE_MAX_BYTES`（1 MiB）：超过它的写入**照样成功**，只是 `reversible: false`
// 并给出理由。删除侧**没有**这个档位，Rust 侧一个也没有——超限就是 `ok: false`，一个字节都不删。
//
// 差别的根源是两种动作的最坏情况不同：一次不可逆的写入，用户手里还有磁盘上那份新内容；一次
// 不可逆的删除，那份内容**除了载荷副本之外不存在于任何地方**。所以删除这边宁可拒绝服务，也不
// 提供「删了但撤不回来」这个档位——真需要删一棵 600 MB 的树时，`rm -rf` 一直都在，而那是用户
// 明确知道自己在做什么的动作。**别顺手给删除加一个 reversible: false 的成功路径。**

/**
 * 一次可恢复删除最多涉及多少个条目（含目录本身与所有子孙）。
 *
 * 这是「载荷复制要拷多少次」的上限，不是磁盘容量的上限——20 万个小文件的目录即使只有几 MB，
 * 复制一遍也要几十万次系统调用，而那段时间里 workspace 处于「原件还在、副本没齐」的状态。
 */
export const MAX_ENTRIES = 20_000

/** 一次可恢复删除最多涉及多少字节（只累计**文件**的大小，目录本身不计）。 */
export const MAX_BYTES = 512 * 1024 * 1024

/**
 * 到目前为止扫到的量是否已经越过预算。
 *
 * 边界是 `>`：恰好等于上限是允许的（与 Rust 的 `*entries > MAX_ENTRIES || *bytes > MAX_BYTES`
 * 逐字一致）。调用方每数完**一个**条目就问一次，而不是扫完整棵树再问——一棵 10 万文件的树
 * 在第 20001 个条目上就该停手，没必要先把它整个走完。
 */
export function exceedsDeleteBudget(entries: number, bytes: number): boolean {
  return entries > MAX_ENTRIES || bytes > MAX_BYTES
}

/**
 * 超限时的失败文案。两个数字**内联进字符串**（Rust 的 `{MAX_ENTRIES}` / `{MAX_BYTES}` 同款），
 * 所以线上看到的是 `limit: 20000 entries or 536870912 bytes`——没有千分位分隔符，别自作主张加。
 */
export function tooLargeMessage(): string {
  return `path is too large for recoverable delete (limit: ${MAX_ENTRIES} entries or ${MAX_BYTES} bytes)`
}
