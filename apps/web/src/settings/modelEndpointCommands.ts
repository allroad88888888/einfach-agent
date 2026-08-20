// 接入点登记的命令面：hydrate / 改草稿 / 保存 / 删除
// ---------------------------------------------------------------------------
// 与 `modelCredentialCommands.ts` 并排，多做一件它不做的事：**每次拿到后端的状态，都把那条
// 地址同步给受限传输**（`applyOpenAiCompatEndpoint`）。两者必须由同一个动作更新——分开写的话，
// 面板显示「已登记」而 adapter 手里还是空的（或反过来），症状是「明明存好了却报
// missing_base_url」，而两边各自都不报错。
//
// 【失败一律以后端的话为准】保存失败时显示的是后端那句（「模型接入点地址未获允许」/
// 「模型请求格式无效」），不在前端另编一句更具体的解释——前端没有判据，编出来的解释可能与
// 真正的拒绝理由不符。规则提示（MODEL_ENDPOINT_RULE_HINT）常驻在输入框旁边，那是**提示**，
// 不冒充判定结果。

import { uiStore } from '../uiStore'
import { applyOpenAiCompatEndpoint } from '../modelTransport/openAiCompatEndpoint'
import {
  createUnavailableModelEndpointHost,
  type ModelEndpointHost,
  type ModelEndpointStatus,
} from './modelEndpointHost'
import {
  modelEndpointEntryAtom,
  modelEndpointHostAvailableAtom,
  setModelEndpointDraft,
  setModelEndpointState,
} from './modelEndpointState'

let activeHost = createUnavailableModelEndpointHost()

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '模型接入点操作失败'
}

/**
 * 采纳一次后端状态：先喂给受限传输，再落到界面状态上。
 *
 * 顺序不是随意的——先更新传输，界面上出现「已登记」的那一刻请求就真的发得出去了；反过来会有
 * 一个「面板说好了、下一次发送却拿到 missing_base_url」的窗口。
 */
function adopt(status: ModelEndpointStatus, uiStatus: 'ready' | 'saved'): void {
  applyOpenAiCompatEndpoint(status.configured ? status.baseUrl : undefined)
  setModelEndpointState(uiStore, {
    status: uiStatus,
    configured: status.configured,
    ...(status.baseUrl === undefined ? {} : { baseUrl: status.baseUrl }),
  })
}

export function configureModelEndpointHost(host: ModelEndpointHost): void {
  activeHost = host
  uiStore.setter(modelEndpointHostAvailableAtom, host.available)
}

export async function hydrateModelEndpoint(): Promise<void> {
  setModelEndpointState(uiStore, { status: 'loading', configured: false })
  try {
    adopt(await activeHost.status(), 'ready')
  } catch {
    // 读不到状态 ≠ 没登记。传输保持「没登记」是安全的那一侧（fail closed），但界面要说实话。
    applyOpenAiCompatEndpoint(undefined)
    setModelEndpointState(uiStore, {
      status: 'error',
      error: '无法读取 OpenAI 兼容端点的接入点配置，请重试。',
      configured: false,
    })
  }
}

export function updateModelEndpointDraft(value: string): void {
  setModelEndpointDraft(uiStore, value)
}

export async function saveModelEndpoint(): Promise<boolean> {
  const draft = uiStore.getter(modelEndpointEntryAtom).draft.trim()
  const current = uiStore.getter(modelEndpointEntryAtom).state
  if (!draft) {
    setModelEndpointState(uiStore, {
      status: 'error',
      error: '请输入 OpenAI 兼容端点的接入点地址。',
      configured: current.configured,
      ...(current.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }),
    })
    return false
  }
  setModelEndpointState(uiStore, { status: 'loading', configured: current.configured })
  try {
    const status = await activeHost.save(draft)
    setModelEndpointDraft(uiStore, '')
    adopt(status, 'saved')
    return true
  } catch (error) {
    // 后端拒绝时**登记没有变**：把原来那条状态原样留着，别让用户以为自己刚把它弄没了。
    setModelEndpointState(uiStore, {
      status: 'error',
      error: errorMessage(error),
      configured: current.configured,
      ...(current.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }),
    })
    return false
  }
}

export async function deleteModelEndpoint(): Promise<boolean> {
  const current = uiStore.getter(modelEndpointEntryAtom).state
  setModelEndpointState(uiStore, { status: 'loading', configured: current.configured })
  try {
    const status = await activeHost.delete()
    setModelEndpointDraft(uiStore, '')
    adopt(status, 'saved')
    return true
  } catch (error) {
    setModelEndpointState(uiStore, {
      status: 'error',
      error: errorMessage(error),
      configured: current.configured,
      ...(current.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }),
    })
    return false
  }
}
