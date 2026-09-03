import { describe, expect, it } from 'vitest'
import { verifyStagedGuard } from './guard'
import { contentSha256 } from '../common/contentHash'

const hashOf = (content: string) => contentSha256(Buffer.from(content, 'utf8'))

describe('verifyStagedGuard', () => {
  it('两个都不给 = 不校验', () => {
    expect(() => verifyStagedGuard('anything', undefined, undefined)).not.toThrow()
  })

  it('两个都给 → 拒（先于任何比对）', () => {
    // 连内容都对得上时也拒：模棱两可的入参要在这里失败，而不是「碰巧两个都对所以放行」。
    expect(() => verifyStagedGuard('old', 'old', hashOf('old'))).toThrow(
      /^pass either oldContent or expectedContentHash, not both$/,
    )
  })

  it('oldContent 逐字比对', () => {
    expect(() => verifyStagedGuard('old', 'old', undefined)).not.toThrow()
    expect(() => verifyStagedGuard('old', 'old\n', undefined)).toThrow(
      /^oldContent did not match current file content$/,
    )
  })

  it('expectedContentHash 比的是内容 UTF-8 字节的 sha256', () => {
    expect(() => verifyStagedGuard('你好', undefined, hashOf('你好'))).not.toThrow()
    expect(() => verifyStagedGuard('你好', undefined, hashOf('你 好'))).toThrow(
      /^expectedContentHash did not match current file content; re-read the file and retry with the new contentHash$/,
    )
  })

  it('空文件的 hash 也认（不是「没内容就跳过」）', () => {
    expect(() => verifyStagedGuard('', undefined, hashOf(''))).not.toThrow()
  })

  it('格式不合规的 hash 先被格式那句话挡下', () => {
    const digest = hashOf('old').slice('sha256:'.length)
    const badFormats = [
      digest, // 裸 hex，没有前缀
      `sha1:${digest}`,
      `sha256:${digest.toUpperCase()}`, // 大写 hex 不收
      `sha256:${digest.slice(0, 63)}`,
      `sha256:${digest}0`,
      `sha256:${digest.slice(0, 63)}g`,
      'sha256:',
    ]
    for (const value of badFormats) {
      expect(() => verifyStagedGuard('old', undefined, value)).toThrow(
        /^expectedContentHash must use sha256:<64 lowercase hex characters>$/,
      )
    }
  })

  it('hex 后面跟换行不算合规（正则的 `$` 不能被尾随换行糊弄）', () => {
    expect(() => verifyStagedGuard('old', undefined, `${hashOf('old')}\n`)).toThrow(
      /must use sha256:/,
    )
  })
})
