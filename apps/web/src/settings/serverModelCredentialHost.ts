// server 宿主保存模型 API Key 的通路：与桌面版同一套命令，换一条传输
// ---------------------------------------------------------------------------
// 与 `createTauriModelCredentialHost()` **同接口、同命令名、同入参形状**，唯一的差别是
// `invoke` 从 Tauri 的 IPC 换成 B2 的 `httpInvoke`（`POST /api/invoke/:command`）。
// 两个工厂并排放在设置目录里而不是合成一个带传输参数的函数，是因为它们真正的区别只有这一行；
// 合成之后调用点要多传一个「用哪条传输」的实参，而漏传的那次不会报错，只会静默走错宿主。
//
// 【本文件不做任何加工】三条命令的返回体就是宿主给的 `{ configured, source }`，原样返回；
// 失败原样抛出（B2 那头 reject 的是**裸字符串**，与 Tauri invoke 逐字一致，
// `modelCredentialCommands.ts` 的 `errorMessage` 两种形状都认）。中间不加 try/catch、不补默认值：
// 「读不到状态」与「状态是未配置」是两件事，把前者折成后者会让设置面板对着一把存好的 Key
// 说没配置。
//
// 【Key 只往一个方向走】`save` 把明文 Key 放进请求体交给宿主，此后前端不再持有它——
// `status` / `delete` 的返回体不含 Key，`save` 的返回体也不含（M4 在 host-node 侧的
// `credentialCommands.ts` 正面钉住了这条）。前端这一层因此没有任何「读回 Key」的能力，
// 不是靠某处过滤，是那条命令压根不返回。
import { httpInvoke } from '../host/serverInvoke'
import type { HostInvoke } from '@einfach-agent/core'
import type {
  ModelCredentialHost,
  ModelCredentialStatus,
  ModelCredentialTarget,
} from './modelCredentialHost'

/**
 * 造 server 宿主的凭据宿主。`invoke` 只为测试注入假实现而存在，生产路径用默认的 `httpInvoke`
 * （装配点是 `apps/web/src/host/hostModelCredentialHost.ts`）。
 */
export function createServerModelCredentialHost(
  invoke: HostInvoke = httpInvoke,
): ModelCredentialHost {
  return {
    available: true,
    status: ({ provider, scope }: ModelCredentialTarget) => invoke<ModelCredentialStatus>(
      'model_credential_status',
      { provider, scope },
    ),
    save: ({ provider, scope }: ModelCredentialTarget, apiKey: string) => (
      invoke<ModelCredentialStatus>('model_credential_set', {
        input: { provider, scope, apiKey },
      })
    ),
    delete: ({ provider, scope }: ModelCredentialTarget) => invoke<ModelCredentialStatus>(
      'model_credential_delete',
      { provider, scope },
    ),
  }
}
