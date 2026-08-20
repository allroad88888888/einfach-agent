// openai-compat 接入点登记的宿主契约
// ---------------------------------------------------------------------------
// 与 `modelCredentialHost.ts` 并排，形状相似但**不是同一件事**，因此没有合并：
//   · 凭据是秘密：`ModelCredentialStatus` 恒不含 Key，前端没有任何读回 Key 的能力。
//   · 接入点不是秘密，而且必须**回显**——用户要看得见自己登记的是哪个地址，否则无从确认填对了。
// 把回显字段加进凭据那条契约，等于在「返回体只有 {configured, source}」上开一个口子，
// 而那条契约的价值正在于它没有例外。
//
// 【地址合不合规由谁判】由本机 Node 后端判（`packages/host-node/src/model/openAiCompatBaseUrl.ts`）。
// 前端不持有那条判据的副本：浏览器把用户填的原文交上去，拿回来的要么是**归一化后的**那条地址，
// 要么是一句「未获允许」。前端少一份判据 = 少一处会与后端分叉的地方。下面那句 RULE 是**给人看的
// 提示文案**，不是判据——它说不清楚顶多让用户多试一次，判错才会让人以为存住了。

export interface ModelEndpointStatus {
  /** 后端配置里现在有没有一条**过得了判据**的登记。 */
  configured: boolean
  /** 登记的那条地址，已由后端归一化。`configured` 为 false 时不出现。 */
  baseUrl?: string
}

export interface ModelEndpointHost {
  available: boolean
  status(): Promise<ModelEndpointStatus>
  save(baseUrl: string): Promise<ModelEndpointStatus>
  delete(): Promise<ModelEndpointStatus>
}

/** 面板上的规则提示。与后端 `OPENAI_COMPAT_BASE_URL_RULE` 同义，改判据时两边一起改。 */
export const MODEL_ENDPOINT_RULE_HINT
  = '接入点必须是 https:// 地址，或指向本机回环地址（localhost / 127.x.x.x / [::1]）的 http://；'
  + '不接受 query、fragment 与内嵌的用户名密码。'

/** 输入框的长度上限；与后端那条 512 字节硬顶同量级，超了后端也会拒。 */
export const MAX_MODEL_ENDPOINT_LENGTH = 512

/**
 * 没有本机后端的那一态（纯静态产物）：如实说存不进去，而不是给一个存不进去的框。
 * `available: false` 同时也是设置面板收起输入框的判据（同凭据宿主）。
 */
export function createUnavailableModelEndpointHost(): ModelEndpointHost {
  const unavailable = async (): Promise<ModelEndpointStatus> => {
    throw new Error('模型接入点只能由本机后端写入配置文件；当前页面没有连上本机后端。')
  }
  return {
    available: false,
    status: async () => ({ configured: false }),
    save: unavailable,
    delete: unavailable,
  }
}
