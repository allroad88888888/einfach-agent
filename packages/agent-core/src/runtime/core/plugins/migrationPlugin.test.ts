// migrationPlugin 隔离测——不经 modelRun，用假 root/session store 直接验证 onRunStart 槽把
// 主 Agent 模型归一化写回 sessionsAtom。
// ---------------------------------------------------------------------------
// 覆盖（对齐任务补测要求）：
//   · deepseek-chat → onRunStart 后 sessionsAtom 里 model=deepseek-v4-pro + thinking:false（含
//     updatedAt/id/title/createdAt 逐字不变、只碰 settings）。
//   · deepseek-reasoner → model=deepseek-v4-pro + thinking:true。
//   · 历史 Flash 主会话 → Pro。
//   · 已是主模型（deepseek-v4-pro）→ no-op，不写（记录引用不变）。
//   · 未知模型名 → 原样，不写。
//   · 幂等：连调两次结果一致，且第二次不写。
//   · ctx.isCurrent() 为 false（stale run）→ 不写（迁移被守卫拦下）。
//   · 会话已 ghost（sessionsAtom 无此会话）→ no-op、不抛。
//   · 不覆盖用户显式 thinking（继承 migrateSessionMeta 不变量）。
//   · applyMigration 直调与经插件装配行为一致。
// 「写了没写」的判定统一用【sessionsAtom 记录引用是否变】：applyMigration 写时走函数式更新
//   产生新记录对象（!== before）；no-op 路径根本不调 setter（=== before）——比逐字段比更能抓到
//   「本不该写却写了 / 本该写却没写」的变异。

import { describe, expect, it } from 'vitest'
import { createStore, type Store } from '@einfach/core'

import { sessionsAtom } from '../../../state/rootStore'
import { runAtom } from '../../../state/sessionAtoms'
import type { ModelSettings, SessionMeta } from '../../../state/core.type'
import { makeCoreCtx, type CoreCtx } from '../coreCtx'
import { assemblePlugins } from '../pluginApi'
import { applyMigration, migrationPlugin } from './migrationPlugin'

// 完整 SessionMeta（非 `as unknown as` 简写）——要断言 updatedAt / id / title / createdAt 逐字不变。
function metaWith(settings: ModelSettings, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: '存量会话',
    settings,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  }
}

// 造一个 CoreCtx：session 存在于 root.sessionsAtom['s1']；store.runAtom.runId 默认匹配 ctxRunId
// （→ isCurrent()=true）；传 runInStore 覆盖成别的值可制造 stale（→ isCurrent()=false）。
function makeCtx(opts: {
  meta?: SessionMeta
  ctxRunId?: string
  runInStore?: string // store.runAtom 里的 runId；省略则等于 ctxRunId（isCurrent=true）
}): { ctx: CoreCtx; root: Store } {
  const root = createStore()
  const store = createStore()
  const ctxRunId = opts.ctxRunId ?? 'r1'
  if (opts.meta) root.setter(sessionsAtom, { s1: opts.meta })
  store.setter(runAtom, { runId: opts.runInStore ?? ctxRunId, status: 'running' })
  const ctx = makeCoreCtx({
    sessionId: 's1',
    runId: ctxRunId,
    signal: new AbortController().signal,
    store,
    root,
    traceEvent: () => {},
  })
  return { ctx, root }
}

// 经真实装配路径跑 onRunStart（migrationPlugin 注册了 onRunStart，故复合槽必非 undefined）。
async function runOnRunStart(ctx: CoreCtx): Promise<void> {
  await assemblePlugins([migrationPlugin]).onRunStart?.(ctx)
}

describe('migrationPlugin —— 主 Agent 模型归一化写回 sessionsAtom', () => {
  it('deepseek-chat → onRunStart 后 model=deepseek-v4-pro + thinking:false，其余字段逐字不变', async () => {
    const { ctx, root } = makeCtx({ meta: metaWith({ vendor: 'deepseek', model: 'deepseek-chat' }) })
    const recordBefore = root.getter(sessionsAtom)

    await runOnRunStart(ctx)

    const after = root.getter(sessionsAtom).s1
    expect(after.settings).toEqual({ vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: false })
    // 记录对象被换过（确有写回）——去掉 setter 的变异会让这条 + 上面的 model 断言一起变红。
    expect(root.getter(sessionsAtom)).not.toBe(recordBefore)
    // 兼容迁移只碰 settings：updatedAt / id / title / createdAt 逐字不动。
    expect(after.updatedAt).toBe(2000)
    expect(after.createdAt).toBe(1000)
    expect(after.id).toBe('s1')
    expect(after.title).toBe('存量会话')
  })

  it('deepseek-reasoner → model=deepseek-v4-pro + thinking:true（旧名隐含思考模式被补上）', async () => {
    const { ctx, root } = makeCtx({ meta: metaWith({ vendor: 'deepseek', model: 'deepseek-reasoner' }) })

    await runOnRunStart(ctx)

    expect(root.getter(sessionsAtom).s1.settings).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: true,
    })
  })

  it('历史 Flash 主会话 → Pro，并写回 sessionsAtom', async () => {
    const meta = metaWith({ vendor: 'deepseek', model: 'deepseek-v4-flash' })
    const { ctx, root } = makeCtx({ meta })
    const recordBefore = root.getter(sessionsAtom)

    await runOnRunStart(ctx)

    expect(root.getter(sessionsAtom)).not.toBe(recordBefore)
    expect(root.getter(sessionsAtom).s1.settings.model).toBe('deepseek-v4-pro')
  })

  it('已是主模型（deepseek-v4-pro）→ no-op，不写（sessionsAtom 记录引用不变）', async () => {
    const meta = metaWith({ vendor: 'deepseek', model: 'deepseek-v4-pro' })
    const { ctx, root } = makeCtx({ meta })
    const recordBefore = root.getter(sessionsAtom)

    await runOnRunStart(ctx)

    // 未迁移路径根本不调 setter → 记录对象【同一引用】，会话 meta 也【同一引用】。
    expect(root.getter(sessionsAtom)).toBe(recordBefore)
    expect(root.getter(sessionsAtom).s1).toBe(meta)
  })

  it('未知模型名（用户自定义）→ 原样，不写', async () => {
    const meta = metaWith({ vendor: 'deepseek', model: 'my-private-model' })
    const { ctx, root } = makeCtx({ meta })
    const recordBefore = root.getter(sessionsAtom)

    await runOnRunStart(ctx)

    expect(root.getter(sessionsAtom)).toBe(recordBefore)
    expect(root.getter(sessionsAtom).s1.settings.model).toBe('my-private-model')
  })

  it('幂等：连调两次结果一致，且第二次不写（迁移后再迁不产生新记录）', async () => {
    const { ctx, root } = makeCtx({ meta: metaWith({ vendor: 'deepseek', model: 'deepseek-chat' }) })

    await runOnRunStart(ctx)
    const afterFirst = root.getter(sessionsAtom)
    const metaAfterFirst = afterFirst.s1
    expect(metaAfterFirst.settings.model).toBe('deepseek-v4-pro')

    await runOnRunStart(ctx)
    const afterSecond = root.getter(sessionsAtom)

    // 第二次是 no-op：记录对象与会话 meta 都保持第一次之后的同一引用；值逐字一致。
    expect(afterSecond).toBe(afterFirst)
    expect(afterSecond.s1).toBe(metaAfterFirst)
    expect(afterSecond.s1.settings).toEqual({ vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: false })
  })

  it('ctx.isCurrent() 为 false（run 被顶掉）→ 不写，会话仍是下线旧名', async () => {
    // 会话存在（→ current 有值、迁移被算出来）但 store.runAtom.runId 与 ctx.runId 不符 → isCurrent()=false。
    // 用 stale-run 制造 false（而非 ghost）：ghost 会先在 `!current` 处返回、根本走不到 isCurrent 守卫，
    // 这里要精确验证的是 isCurrent 那道守卫本身。
    const { ctx, root } = makeCtx({
      meta: metaWith({ vendor: 'deepseek', model: 'deepseek-chat' }),
      ctxRunId: 'r1',
      runInStore: 'r2', // 被新 run 顶掉
    })
    const recordBefore = root.getter(sessionsAtom)

    await runOnRunStart(ctx)

    // 守卫拦下写回：记录引用不变，会话仍是未迁移的 deepseek-chat。
    expect(root.getter(sessionsAtom)).toBe(recordBefore)
    expect(root.getter(sessionsAtom).s1.settings.model).toBe('deepseek-chat')
  })

  it('会话已 ghost（sessionsAtom 无此会话）→ no-op、不抛、不凭空造会话', async () => {
    const { ctx, root } = makeCtx({}) // 不 seed meta
    const recordBefore = root.getter(sessionsAtom)

    await expect(runOnRunStart(ctx)).resolves.toBeUndefined()

    expect(root.getter(sessionsAtom)).toBe(recordBefore)
    expect(root.getter(sessionsAtom).s1).toBeUndefined()
  })

  it('不覆盖用户显式 thinking：deepseek-chat + thinking:true → 只迁 model，thinking 保持 true', async () => {
    // migrateSessionMeta 的不变量：thinking 只在 undefined（用户没表过态）时才按旧名补；用户显式设过
    // 就是主动选择，优先于旧名隐含语义。本插件全盘继承，不重写规则。
    const { ctx, root } = makeCtx({
      meta: metaWith({ vendor: 'deepseek', model: 'deepseek-chat', thinking: true }),
    })

    await runOnRunStart(ctx)

    expect(root.getter(sessionsAtom).s1.settings).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: true,
    })
  })
})

// applyMigration 本体的独立单测（不经 assemblePlugins/PluginApi 装配这层）——确保「插件注册」
// 与「迁移逻辑」两层各自都可单独验证，与 compactionPlugin 的 applyCompaction 同款设计意图。
describe('applyMigration（不经插件装配，直接调用本体）', () => {
  it('与经 migrationPlugin 装配后的行为一致（deepseek-chat 迁移 + 写回）', () => {
    const { ctx, root } = makeCtx({ meta: metaWith({ vendor: 'deepseek', model: 'deepseek-chat' }) })

    applyMigration(ctx)

    expect(root.getter(sessionsAtom).s1.settings).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: false,
    })
  })

  it('只替换本会话、保留 sessionsAtom 里的其它会话', () => {
    const root = createStore()
    const store = createStore()
    const other = metaWith({ vendor: 'glm', model: 'glm-5.2' }, { id: 's2', title: '别的会话' })
    root.setter(sessionsAtom, {
      s1: metaWith({ vendor: 'deepseek', model: 'deepseek-chat' }),
      s2: other,
    })
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    const ctx = makeCoreCtx({
      sessionId: 's1',
      runId: 'r1',
      signal: new AbortController().signal,
      store,
      root,
      traceEvent: () => {},
    })

    applyMigration(ctx)

    expect(root.getter(sessionsAtom).s1.settings.model).toBe('deepseek-v4-pro')
    // 另一会话原封不动（同一引用）。
    expect(root.getter(sessionsAtom).s2).toBe(other)
  })
})
