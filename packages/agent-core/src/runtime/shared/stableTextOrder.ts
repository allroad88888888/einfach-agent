// 决定可缓存请求前缀字节顺序的文本比较器。

// 不用 localeCompare：它会受宿主 locale / ICU 实现影响，不适合决定可缓存请求前缀的字节顺序。
export function compareStableText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
