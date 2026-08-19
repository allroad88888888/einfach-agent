// 启动完成后打印给用户看的那几行——**这是 token 唯一允许出现的出口**（见 `authToken.ts` 的
// 链路①②）。不要把这段文案的构造分散到 `mainRunServer.ts` 里：措辞是本卡判据里用户会直接读的
// 部分，独立成纯函数才方便照原文核对、照原文测试。
//
// 纯函数，不做任何 IO——由调用方决定写到 stdout 还是别处。

export interface StartupMessageInput {
  /** 完整 URL，含 `?token=…`。 */
  readonly url: string
  /** 是否会（尝试）自动打开浏览器；对应 `--no-open` 是否生效。 */
  readonly willOpen: boolean
}

export function formatStartupMessage(input: StartupMessageInput): string {
  const lines = [
    'web-agent 已启动：',
    `  ${input.url}`,
    '',
    '地址末尾的 token 只在这一次页面加载时使用，请勿分享给他人或提交到代码仓库；',
    '每次启动都会换一枚新的，关闭这个进程后旧的立即失效。',
    '',
    input.willOpen ? '正在尝试自动打开浏览器……' : '已跳过自动打开浏览器（--no-open）。',
    '按 Ctrl+C 停止服务。',
  ]
  return `${lines.join('\n')}\n`
}
