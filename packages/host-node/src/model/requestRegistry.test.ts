import { describe, expect, it } from 'vitest'
import { createModelRequestRegistry, modelRequestRegistry } from './requestRegistry'

describe('在飞请求表', () => {
  it('ID 格式非法一律拒绝登记', () => {
    // 与 Rust `rejects_invalid_request_ids` 同款。ID 会被原样用作表的键，不收严就等于给了调用方
    // 一个能任意造键的入口。
    const registry = createModelRequestRegistry()
    for (const requestId of ['', 'request with spaces', 'r'.repeat(129), 'req/1']) {
      expect(() => registry.register(requestId)).toThrow('模型请求 ID 无效')
    }
  })

  it('取消只作用于那一个请求，重复登记是受控失败', () => {
    // 与 Rust `cancellation_is_scoped_to_one_active_request` 同款。重复登记若改成覆盖，先前那次
    // 请求就永远取消不掉了——它还在跑、还在花 token，而调用方手里的 ID 已经指向另一个人。
    const registry = createModelRequestRegistry()
    const first = registry.register('request-1')
    const second = registry.register('request-2')

    expect(registry.cancel('request-1')).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(() => registry.register('request-2')).toThrow('模型请求 ID 已存在')

    registry.finish('request-1')
    expect(() => registry.register('request-1')).not.toThrow()
  })

  it('取消一个不存在或已结束的 ID 是无害的 no-op', () => {
    // 前端在收尾竞态里补发一次 cancel 很常见。让它抛错只会把一次无害的迟到变成错误日志。
    const registry = createModelRequestRegistry()
    expect(registry.cancel('missing-request')).toBe(false)
    registry.register('request-1')
    registry.finish('request-1')
    expect(registry.cancel('request-1')).toBe(false)
    // 格式非法仍然抛：那是调用方写错了，与「这个 ID 不在表里」不是一回事。
    expect(() => registry.cancel('bad id')).toThrow('模型请求 ID 无效')
  })

  it('finish 之后表回到空——泄漏的唯一可观测形态就是它不回到 0', () => {
    const registry = createModelRequestRegistry()
    registry.register('request-1')
    registry.register('request-2')
    expect(registry.activeCount).toBe(2)
    registry.finish('request-1')
    registry.finish('request-2')
    registry.finish('request-2')
    expect(registry.activeCount).toBe(0)
  })

  it('取消原因原样落到 signal.reason 上', () => {
    // 转发层靠它区分「用户取消」与「超时」：对上游是同一个动作，对调用方是两种结果。
    const registry = createModelRequestRegistry()
    const controller = registry.register('request-1')
    const reason = new Error('用户取消')
    registry.cancel('request-1', reason)
    expect(controller.signal.reason).toBe(reason)
  })

  it('导出的进程级实例是同一张表', () => {
    // 取消命令走命令路由表，请求转发走 M2 的流式端点——两条不同的进入路径必须看同一张表，
    // 否则取消永远找不到请求，而症状只是「取消按钮没反应」。
    modelRequestRegistry.register('shared-request')
    expect(modelRequestRegistry.cancel('shared-request')).toBe(true)
    modelRequestRegistry.finish('shared-request')
    expect(modelRequestRegistry.activeCount).toBe(0)
  })
})
