import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { contextStatsAtom, type ContextStatsSnapshot } from '@web-agent/core'
import { ContextStats } from './ContextStats'

const baseStats: ContextStatsSnapshot = {
  id: 'ctx1',
  createdAt: 1,
  vendor: 'deepseek',
  model: 'deepseek-chat',
  runId: 'r1',
  turnId: 'u1',
  llmTurn: 1,
  messagesCount: 2,
  toolsCount: 1,
  systemChars: 120,
  messagesChars: 240,
  toolsChars: 160,
  totalChars: 400,
  estimatedTokens: 44_000,
  inputBudgetTokens: 176_000,
  roles: {
    system: { count: 1, chars: 120, estimatedTokens: 30 },
    user: { count: 1, chars: 120, estimatedTokens: 30 },
    assistant: { count: 0, chars: 0, estimatedTokens: 0 },
    tool: { count: 0, chars: 0, estimatedTokens: 0 },
  },
  toolNames: ['request_tool_schema'],
}

describe('ContextStats', () => {
  it('无统计时不渲染', () => {
    const { container } = renderWithStore(<ContextStats />, { store: createStore() })
    expect(container.firstChild).toBeNull()
  })

  it('有估算统计时渲染摘要和明细', () => {
    const store = createStore()
    store.setter(contextStatsAtom, baseStats)

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByLabelText('上下文统计')).toBeInTheDocument()
    expect(screen.getByText('上下文 25%')).toBeInTheDocument()
    expect(screen.getByText('44,000 / 176,000 tokens (25%)')).toBeInTheDocument()
    expect(screen.getByText('本次可用输入额度（已扣除输出预留与安全余量）')).toBeInTheDocument()
    expect(screen.getByText(/^tools 1$/)).toBeInTheDocument()
    expect(screen.getByText('deepseek/deepseek-chat')).toBeInTheDocument()
    expect(screen.getByText('request_tool_schema')).toBeInTheDocument()
    expect(screen.queryByText(/建议新开会话/)).toBeNull()
    expect(screen.queryByText(/system 1/)).toBeNull()
  })

  it('压缩前超过会话软上限时稳定提示新开会话', () => {
    const store = createStore()
    store.setter(contextStatsAtom, {
      ...baseStats,
      estimatedTokensBeforeCompaction: 240_000,
    })

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByText('上下文 25% · 建议新开会话')).toBeInTheDocument()
    expect(
      screen.getByText('本轮压缩前约 240,000 tokens，已超过 200,000 的会话软上限；建议新开会话。'),
    ).toBeInTheDocument()
  })

  it('provider 返回 usage 后优先展示真实 usage 摘要', () => {
    const store = createStore()
    store.setter(contextStatsAtom, {
      ...baseStats,
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    })

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByText('上下文 0%')).toBeInTheDocument()
    expect(screen.getByText('120 / 176,000 tokens (0%)')).toBeInTheDocument()
    expect(screen.getByText(/prompt 120 \/ completion 30 \/ total 150/)).toBeInTheDocument()
  })

  it('展示本轮与累计缓存命中；字段缺失时不伪装成 0', () => {
    const store = createStore()
    store.setter(contextStatsAtom, {
      ...baseStats,
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cacheHitTokens: 80,
        cacheMissTokens: 40,
        cacheHitRate: 2 / 3,
      },
      cache: {
        lane: 'main',
        profileId: 'main:deepseek:deepseek-chat:agent-runtime-prefix-v2',
        epoch: 1,
        epochReason: 'initial',
        protocolVersion: 'agent-runtime-prefix-v2',
        toolSetFingerprint: 'tools-v1-fnv1a32-12345678',
        laneScopeFingerprint: 'scope-v1-fnv1a32-12345678',
        systemFingerprint: 'system-v1-fnv1a32-12345678',
        requestProjectionFingerprint: 'request-v1-fnv1a32-12345678',
        compactionBoundary: 'full-history',
        metricsStatus: 'available',
      },
      cacheTotals: {
        runId: 'r1',
        measuredRequests: 2,
        hitTokens: 100,
        missTokens: 50,
        hitRate: 2 / 3,
      },
    })

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByText('run cache 67%')).toBeInTheDocument()
    expect(screen.getByText('hit 80 / miss 40 (unknown) / rate 67%')).toBeInTheDocument()
    expect(screen.getByText('2 requests / hit 100 / miss 50 / rate 67%')).toBeInTheDocument()
    expect(screen.getByText('main / epoch 1 (initial) / full-history')).toBeInTheDocument()
    expect(
      screen.getByText('本次运行累计命中'),
    ).toBeInTheDocument()
    expect(screen.getByText('请求投影档案（本地）')).toBeInTheDocument()
    expect(
      screen.getByText('DeepSeek 无显式 cache_id；命中以本轮 Provider usage 为准'),
    ).toBeInTheDocument()
  })

  it('provider 未返回缓存字段时明确标记不可用', () => {
    const store = createStore()
    store.setter(contextStatsAtom, {
      ...baseStats,
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
      cache: {
        lane: 'main',
        profileId: 'main:deepseek:deepseek-chat:agent-runtime-prefix-v2',
        epoch: 2,
        epochReason: 'request_projection_changed',
        protocolVersion: 'agent-runtime-prefix-v2',
        toolSetFingerprint: 'tools-v1-fnv1a32-12345678',
        laneScopeFingerprint: 'scope-v1-fnv1a32-12345678',
        systemFingerprint: 'system-v1-fnv1a32-12345678',
        requestProjectionFingerprint: 'request-v1-fnv1a32-87654321',
        compactionBoundary: 'full-history',
        metricsStatus: 'unavailable',
      },
    })

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByText('Provider 未返回缓存指标')).toBeInTheDocument()
    expect(screen.queryByText('cache 0%')).toBeNull()
  })

  it.each(['provider', 'derived', 'unknown'] as const)(
    '展示 %s 类型的 miss 来源',
    (cacheMissSource) => {
      const store = createStore()
      store.setter(contextStatsAtom, {
        ...baseStats,
        usage: {
          cacheHitTokens: 80,
          cacheMissTokens: 40,
          cacheMissSource,
          cacheHitRate: 2 / 3,
        },
        cache: {
          lane: 'subagent',
          profileId: 'subagent:deepseek:deepseek-chat:agent-runtime-prefix-v2',
          epoch: 3,
          epochReason: 'compaction_projection_changed',
          protocolVersion: 'agent-runtime-prefix-v2',
          toolSetFingerprint: 'tools-v1-fnv1a32-12345678',
          laneScopeFingerprint: 'scope-v1-fnv1a32-87654321',
          systemFingerprint: 'system-v1-fnv1a32-12345678',
          requestProjectionFingerprint: 'request-v1-fnv1a32-87654321',
          compactionBoundary: 'compacted-history',
          metricsStatus: 'available',
        },
      })

      renderWithStore(<ContextStats />, { store })

      expect(
        screen.getByText(`hit 80 / miss 40 (${cacheMissSource}) / rate 67%`),
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          'subagent / epoch 3 (compaction_projection_changed) / compacted-history',
        ),
      ).toBeInTheDocument()
    },
  )

  it.each([
    ['request_failed', '请求失败，未获得缓存指标'],
    ['cancelled', '请求已取消，未获得缓存指标'],
  ] as const)('缓存请求状态为 %s 时明确展示原因', (metricsStatus, expected) => {
    const store = createStore()
    store.setter(contextStatsAtom, {
      ...baseStats,
      cache: {
        lane: 'main',
        profileId: 'main:deepseek:deepseek-chat:agent-runtime-prefix-v2',
        epoch: 1,
        epochReason: 'initial',
        protocolVersion: 'agent-runtime-prefix-v2',
        toolSetFingerprint: 'tools-v1-fnv1a32-12345678',
        laneScopeFingerprint: 'scope-v1-fnv1a32-12345678',
        systemFingerprint: 'system-v1-fnv1a32-12345678',
        requestProjectionFingerprint: 'request-v1-fnv1a32-12345678',
        compactionBoundary: 'full-history',
        metricsStatus,
      },
    })

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByText(expected)).toBeInTheDocument()
  })
})
