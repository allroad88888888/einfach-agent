// ---------------------------------------------------------------------------
// 规则 4 · 会话 atom 必须有归宿
// ---------------------------------------------------------------------------
// 为什么：SESSION_SLOTS 是「一个会话的完整状态」的穷举表，规则 3 已经能保证**已在表里**的每个
//   槽位都被想过一遍记账形态；但**新增一个会话 atom 却不登记进槽位表**时，此前没有任何门禁会响
//   —— 它只是不进快照、不进账，静默缺席。恢复树红线 10 就是为这一层而立的，它靠人肉抓出过两个
//   真实缺口（`pendingArtifacts` 的文件正文、`composerDraft` 的用户原话）。本规则把那层判断
//   变成机械判定：四个会话 atom 模块里的每个 atom 都必须恰好落在 atomDispositionTable.js 的
//   一张表里，登记与源码对不上（陈旧、两表、形态不符、与槽位表不一致）一律 error。
// 违反后：不报错。刷新后会话少一块内容，或者 undo 越过该 atom 后它停在新值上、其余全部回滚。
//
// 判据照抄红线 10：**不在 SESSION_SLOTS 里的会话 atom 必须能重建**，三类正当归宿 —— 能从别处
// 算回来 / 有明确的补偿设计 / 刷新即恢复安全默认。「说不出机制 = 缺口，不是设计」。
//
// 这里比红线多一类 `knownLoss`（已知缺口、接受丢失）。它**不是第四种正当归宿**，而是给缺口一个
// 有名字的去处：否则一个已裁决「先不修」的缺口唯一的落法就是编一句理由塞进前三类，
// 那正是本规则要防的事。表里每条理由都要指得出代码位置——指不出来的理由等于没核实过。

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sessionAtomDeclarations, SESSION_ATOM_FILES } from './sessionAtomSource.js'
import { SLOTS_FILE, slotAtomNames } from './slotSource.js'
import {
  compensatedAtoms,
  derivedAtoms,
  DISPOSITIONS,
  externalSessionAtoms,
  knownLossAtoms,
  recomputableAtoms,
  safeDefaultAtoms,
  slotAtoms,
} from './atomDispositionTable.js'

// 报错信息里出现的是**表**的位置而不是本文件：读到报错的人要去改的是登记，不是判定。
const RULE_FILE = 'scripts/state-invariants/atomDispositionTable.js'

/** 表里每一项：登记的归宿、以及它和源码对不对得上。返回 atom → 归宿 的映射供后续判未分类。 */
function classifyDeclaredAtoms({ declared, slots, errors }) {
  const classifications = [
    ...slotAtoms.map((atom) => ({ atom, table: 'slot' })),
    ...derivedAtoms.map((atom) => ({ atom, table: 'derived' })),
    ...recomputableAtoms.map((item) => ({ ...item, table: 'recomputable' })),
    ...compensatedAtoms.map((item) => ({ ...item, table: 'compensated' })),
    ...safeDefaultAtoms.map((item) => ({ ...item, table: 'safeDefault' })),
    ...knownLossAtoms.map((item) => ({ ...item, table: 'knownLoss' })),
  ]
  const seen = new Map()
  for (const { atom, table, reason } of classifications) {
    const previous = seen.get(atom)
    if (previous) {
      errors.push(`atom ${atom} 同时登记在 ${previous} 与 ${table} —— 一个 atom 只能有一种归宿`)
      continue
    }
    seen.set(atom, table)
    if (!reason && !['slot', 'derived'].includes(table)) {
      errors.push(`${RULE_FILE} 的 ${table} 条目 ${atom} 没写理由 —— 说不出机制 = 缺口，不是设计`)
    }
    const declaration = declared.get(atom)
    if (!declaration) {
      if (table === 'slot' && slots.has(atom)) {
        errors.push(
          `${SLOTS_FILE} 的槽位 atom ${atom} 不在规则 4 枚举的模块里 —— 请把它的定义模块加进`
          + ' state-invariants/sessionAtomSource.js 的 SESSION_ATOM_FILES，否则那个模块整片没人管',
        )
        continue
      }
      errors.push(
        `${RULE_FILE} 的 ${table} 里有 ${atom}，但 ${SESSION_ATOM_FILES.join(' / ')} 里已无此 atom`
        + ' —— 陈旧条目会让分类表和源码悄悄漂移，请删掉它',
      )
      continue
    }
    if (table === 'derived' && declaration.shape !== 'derived') {
      errors.push(
        `${declaration.file}:${declaration.line} atom ${atom} 登记为 derived，但源码不是 `
        + '`atom((get) => …)` —— primitive atom 有自己的写入面，丢了就是真丢，必须选一类内容归宿',
      )
    }
    if (table !== 'derived' && declaration.shape === 'derived') {
      errors.push(
        `${declaration.file}:${declaration.line} atom ${atom} 源码是 derived，却登记在 ${table} 里`
        + ' —— derived 没有写入面，占一个内容归宿的名额只会让那张表看起来比实际更满',
      )
    }
    if (table === 'slot' && !slots.has(atom)) {
      errors.push(
        `${RULE_FILE} 把 ${atom} 登记为 slot，但 ${SLOTS_FILE} 的 SESSION_SLOTS 里没有它`
        + ' —— 它其实不进快照也不入账，请按红线 10 的三类归宿之一重新登记',
      )
    }
    if (table !== 'slot' && slots.has(atom)) {
      errors.push(
        `${RULE_FILE} 把 ${atom} 登记为 ${table}，但它在 ${SLOTS_FILE} 的 SESSION_SLOTS 里`
        + ' —— 槽位就是「进快照且要还原」的那一类，改归宿等于宣称它丢了也没关系，而它照旧在快照里',
      )
    }
  }
  return seen
}

/** 外部会话 atom 表：只判在案条目有没有陈旧，判不了「有没有第三个没人登记的」。 */
async function checkExternalEntries({ repositoryRoot, declared, seen, errors }) {
  for (const { atom, file, disposition, reason } of externalSessionAtoms) {
    if (!DISPOSITIONS.includes(disposition)) {
      errors.push(`${RULE_FILE} 的外部会话 atom ${atom} 归宿 ${disposition} 不是 ${DISPOSITIONS.join(' / ')} 之一`)
    }
    if (!reason) errors.push(`${RULE_FILE} 的外部会话 atom ${atom} 没写理由 —— 说不出机制 = 缺口，不是设计`)
    if (seen.has(atom) || declared.has(atom)) {
      errors.push(
        `${RULE_FILE} 的外部会话 atom ${atom} 其实定义在 ${SESSION_ATOM_FILES.join(' / ')} 里`
        + ' —— 它会被机械枚举到，请登记进对应的归宿表，别放进只判陈旧的外部表',
      )
      continue
    }
    const source = await readFile(resolve(repositoryRoot, file), 'utf8').catch(() => undefined)
    if (source === undefined) {
      errors.push(`${RULE_FILE} 的外部会话 atom ${atom} 指向 ${file}，该文件不存在 —— 陈旧条目，请更新或删除`)
      continue
    }
    if (!new RegExp(`\\b${atom}\\b`).test(source)) {
      errors.push(`${RULE_FILE} 的外部会话 atom ${atom} 指向 ${file}，但该文件里已无这个名字 —— 陈旧条目，请更新或删除`)
    }
  }
}

async function checkAtomDisposition({ repositoryRoot, errors }) {
  const declarations = await sessionAtomDeclarations(repositoryRoot)
  const declared = new Map(declarations.map((item) => [item.name, item]))
  const slots = await slotAtomNames(repositoryRoot)
  const seen = classifyDeclaredAtoms({ declared, slots, errors })

  for (const { name, file, line } of declarations) {
    if (seen.has(name)) continue
    errors.push(
      `${file}:${line} atom ${name} 未分类 —— 会话 atom 必须在 ${RULE_FILE} 的 `
      + `${DISPOSITIONS.join(' / ')} 之一里登记（恢复树红线 10）：不在 SESSION_SLOTS 里，`
      + '就得说得出凭什么能重建；说不出机制 = 缺口，不是设计',
    )
  }

  await checkExternalEntries({ repositoryRoot, declared, seen, errors })
}

export const atomDispositionRule = {
  summary: [
    '规则 4：四个会话 atom 模块里的每个 atom 都有归宿'
    + `（槽位 ${slotAtoms.length} / 派生 ${derivedAtoms.length} / 可重算 ${recomputableAtoms.length}`
    + ` / 有补偿 ${compensatedAtoms.length} / 安全默认 ${safeDefaultAtoms.length}`
    + ` / 已知缺口 ${knownLossAtoms.length}），另有 ${externalSessionAtoms.length} 个在案的外部会话 atom。`,
    '不在 SESSION_SLOTS 里就必须说得出凭什么能重建——漏登记的会话状态不报错，只是刷新后少一块。',
  ],
  run: checkAtomDisposition,
}
