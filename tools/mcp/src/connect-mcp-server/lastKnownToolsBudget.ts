// tools/mcp/src/connect-mcp-server/lastKnownToolsBudget.ts —— 「若干条可伸缩条目，塞进一个字符预算」
// 的裁剪算法。只管长度，不管措辞（措辞在 lastKnownToolsText.ts）。
//
// 【为什么要有它】这份清单会进模型上下文，manifest 那一层还是【每次请求都发】。50 个服务 × 200 个
//   工具照抄进去，光这一段就能吃掉几千 token。所以呈现侧必须自带硬上限，且超限时的行为要说得清、
//   测得出。
//
// 【裁剪顺序：先瘦最胖的，再整条丢】超限时先从"当前条目最多"的那个服务尾部丢掉一个工具名，循环
//   到符合预算为止。这样预算是被所有服务分摊掉的，而不是被排在前面的那个服务一口吃光——对模型来说
//   "12 个服务各露 2 个工具名"远比"1 个服务露 24 个、其余 11 个完全看不见"有用：前者还能路由，
//   后者等于那 11 个服务不存在。只有当每个服务都只剩 1 个名字仍然超预算时，才从尾部整条丢弃服务，
//   并把丢掉的条数交回给调用方去写进文案——被丢掉的服务必须留下痕迹，否则模型会把"没列出来"
//   读成"没有这个能力"。

export interface BudgetedEntry {
  /** 可以从尾部逐个丢弃的条目（工具名/工具行）。 */
  readonly items: readonly string[]
  /** 用保留下来的 items 和被丢弃的条数渲染成最终文本；抬头等固定开销由实现自己带上。 */
  render(items: readonly string[], droppedItems: number): string
}

export interface BudgetedFitResult {
  readonly text: string
  /** 连抬头都放不下、被整条丢弃的条目数。 */
  readonly droppedEntries: number
}

/**
 * 把 entries 渲染并裁剪进 budgetChars。
 *
 * 每一步只重渲染被改动的那一条，总长度增量更新——manifest 的 skill.description 是每次
 * ToolRegistry.list() 都要重算的热路径，不能写成每轮都把全部条目重拼一遍的 O(n²)。
 */
export function fitEntriesToBudget(
  entries: readonly BudgetedEntry[],
  budgetChars: number,
  separator: string,
): BudgetedFitResult {
  if (entries.length === 0) return { text: '', droppedEntries: 0 }
  if (budgetChars <= 0) return { text: '', droppedEntries: entries.length }

  const kept = entries.map((entry) => ({ entry, count: entry.items.length }))
  const rendered = kept.map(({ entry, count }) =>
    entry.render(entry.items.slice(0, count), entry.items.length - count))
  let total = rendered.reduce((sum, text) => sum + text.length, 0)
    + separator.length * (rendered.length - 1)

  const rerender = (index: number): void => {
    const { entry, count } = kept[index]!
    const next = entry.render(entry.items.slice(0, count), entry.items.length - count)
    total += next.length - rendered[index]!.length
    rendered[index] = next
  }

  // ① 先瘦最胖的：每次从条目最多的那一条尾部丢一个，直到每条都只剩一个。
  while (total > budgetChars) {
    let fattest = -1
    for (let index = 0; index < kept.length; index += 1) {
      if (kept[index]!.count > 1 && (fattest < 0 || kept[index]!.count > kept[fattest]!.count)) {
        fattest = index
      }
    }
    if (fattest < 0) break
    kept[fattest]!.count -= 1
    rerender(fattest)
  }

  // ② 还超 → 从尾部整条丢弃。丢弃数交回调用方写进文案。
  let droppedEntries = 0
  while (total > budgetChars && kept.length > 0) {
    const removed = rendered.pop()!
    kept.pop()
    total -= removed.length + (rendered.length > 0 ? separator.length : 0)
    droppedEntries += 1
  }

  return { text: rendered.join(separator), droppedEntries }
}
