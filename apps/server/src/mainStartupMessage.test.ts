import { describe, expect, it } from 'vitest'
import { formatStartupMessage } from './mainStartupMessage'

const URL = 'http://127.0.0.1:4765/?token=abc123XYZ'

describe('formatStartupMessage', () => {
  it('willOpen=true：逐字比对整段文案', () => {
    expect(formatStartupMessage({ url: URL, willOpen: true })).toBe(
      [
        'einfach-agent 已启动：',
        `  ${URL}`,
        '',
        '地址末尾的 token 只在这一次页面加载时使用，请勿分享给他人或提交到代码仓库；',
        '每次启动都会换一枚新的，关闭这个进程后旧的立即失效。',
        '',
        '正在尝试自动打开浏览器……',
        '按 Ctrl+C 停止服务。',
        '',
      ].join('\n'),
    )
  })

  it('willOpen=false（--no-open）：换成跳过打开的提示，其余文案不变', () => {
    const message = formatStartupMessage({ url: URL, willOpen: false })
    expect(message).toContain('已跳过自动打开浏览器（--no-open）。')
    expect(message).not.toContain('正在尝试自动打开浏览器')
    expect(message).toContain(URL)
  })

  it('以换行收尾，方便直接 write 到 stdout', () => {
    expect(formatStartupMessage({ url: URL, willOpen: true }).endsWith('\n')).toBe(true)
  })
})
