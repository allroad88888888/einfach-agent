// 对拍驱动器：一个补丁操作作用在暂存状态上的纯规则
// ---------------------------------------------------------------------------
// 喂 fixtures/patch-stage-rules.json，对面是 Rust 的
// apps/desktop/src/workspace_patch_stage_parity_tests.rs。
//
// TS 侧这一层是真的纯的（`validatePatchOperationInput` + `nextFileState` 都不碰磁盘）。Rust 侧
// 没有对应的拆分，`stage_operation` 里连着路径解析与「第一次碰到就读一次磁盘」，所以那边的驱动器
// 建一个空目录做路径解析、并**预置暂存表**让读盘那步够不着。两侧喂的是同一组
// `(state, operation)`，出来的必须是同一个 state 或同一句话。
//
// 【顺序也在被测范围内】Rust 每个分支都是「先校验文本入参，再解析路径，再读磁盘，最后动状态」。
// 本组只用合法的简单路径，所以顺序这件事在这里看不出来——它由 patch-pipeline.json 的
// 「text arguments are validated before the path is resolved」那一例盯着。

import { describe, expect, it } from 'vitest'
import { nextFileState, validatePatchOperationInput } from '../workspace/patch/stageRules'
import { captureFailure, loadParityFixture, toComparableJson } from './parityFixtures.testHarness'
import type { PatchFileState, PatchOperation } from '../workspace/patch/types'

interface StageStep {
  operation: PatchOperation
  /** 恰好有 `state` 或 `error` 之一。 */
  expect: { state?: unknown; error?: string }
}

interface StageCase {
  name: string
  source?: string
  /** 本 case 里所有操作共用的路径，见下面的断言。 */
  path: string
  initial: PatchFileState
  steps: StageStep[]
}

const fixture = loadParityFixture<StageCase>('patch-stage-rules.json')

describe(`对拍 · ${fixture.target}`, () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      let state: PatchFileState = testCase.initial
      for (const [index, step] of testCase.steps.entries()) {
        // 一个 case 只碰一条路径是 schema 的约定（跨路径的相互作用属于流水线）。Rust 侧的驱动器
        // 靠这条约定只预置一格暂存表，写错了那边会去读磁盘、静默拿到 `None`。
        expect(step.operation.path, `第 ${index + 1} 步的 path 必须是 ${testCase.path}`).toBe(
          testCase.path,
        )

        let next: PatchFileState = state
        const failure = captureFailure(() => {
          validatePatchOperationInput(step.operation)
          next = nextFileState(state, step.operation)
        })

        if (step.expect.error !== undefined) {
          expect(failure, `第 ${index + 1} 步应当被拒`).toBe(step.expect.error)
          // 被拒的一步不改状态：下一步接着用上一步的 state（两侧实现都是如此）。
          continue
        }
        expect(failure, `第 ${index + 1} 步不该被拒`).toBeNull()
        expect(toComparableJson(next), `第 ${index + 1} 步之后的暂存状态`).toStrictEqual(
          step.expect.state,
        )
        state = next
      }
    })
  }
})
