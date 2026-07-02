// tools/defs/browser-action.ts —— 副作用工具「browser_action」（TOOLS-SPEC §9/§10/§12）。
// 关键差异：不再直接 addBrowserCard / 写 stale 守卫；卡片渲染统一经 ctx.renderCard，
// harness 负责写 atom + 集中 stale/ghost 守卫，回 {cardId} 或 {error}。
// 本文件零依赖：只 import 类型；绝不 import state/atom/store；副作用只经 ctx。
import type { Tool } from '../types'

// lazy schema（照旧 registry）：唯一 action 是 render_card；payload 只承载 title/body。
const inputSchema = {
  type: 'object',
  properties: {
    action: { enum: ['render_card'] },
    payload: {
      type: 'object',
      // 执行侧卡片只承载 title/body；schema 不广告 items/options，避免误导 model。
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title'],
    },
  },
  required: ['action', 'payload'],
}

// 把未知 payload 安全视为普通对象（非对象 / 数组 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// 规范化 payload：title 必须非空 string（trim 后判空）；body 仅当非空 string 才保留。
// 无法规范化（title 空）时返回 undefined → 上层回 error，不调 renderCard。
function normalizeCardPayload(payload: unknown): { title: string; body?: string } | undefined {
  const value = asRecord(payload)
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  if (!title) return undefined

  const card: { title: string; body?: string } = { title }
  if (typeof value.body === 'string' && value.body.trim()) {
    card.body = value.body
  }
  return card
}

export const browserActionTool: Tool = {
  name: 'browser_action',
  runtime: 'browser',
  skill: {
    description: '渲染信息卡片到对话流（render_card）。',
    triggers: ['卡片', 'card', 'render', '展示'],
    content: `# browser_action

在对话流里渲染一张**信息卡片**。当前唯一 action 是 \`render_card\`。

## 参数
- \`action\`：固定 \`'render_card'\`。
- \`payload.title\`（必填）：卡片标题，非空字符串。
- \`payload.body\`（可选）：卡片正文文本。

## 注意
- **卡片不持久化**：它只是即时的可视化，不会进对话历史。请务必在**最终回复里用文字概括卡片内容**，否则用户刷新后就丢了。
- title 为空 / action 不是 render_card 会直接失败，不产生卡片。`,
  },
  inputSchema,
  execute(args, ctx) {
    // 1) 防御式取参：args 可能是任意对象。
    const input = asRecord(args)
    const action = typeof input.action === 'string' ? input.action : undefined
    if (action !== 'render_card') {
      return { ok: false, error: `unsupported browser_action: ${action ?? '(missing)'}` }
    }

    const card = normalizeCardPayload(input.payload)
    if (!card) {
      return {
        ok: false,
        error: 'invalid browser_action payload: title (non-empty string) is required',
      }
    }

    // 2) 副作用只经 ctx：harness 写 atom + 施 stale/ghost 守卫，回 {cardId} 或 {error}。
    const r = ctx.renderCard(card)
    if ('error' in r) {
      return { ok: false, error: r.error }
    }

    // 3) 成功：卡片不持久化，提示 model 在最终回复里文字概括。
    return {
      ok: true,
      data: {
        ok: true,
        cardId: r.cardId,
        note: '卡片不持久化，请在最终回复里文字概括其内容',
      },
    }
  },
}
