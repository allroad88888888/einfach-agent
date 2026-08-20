// server 宿主登记 openai-compat 接入点的通路：三条命令，换一条传输
// ---------------------------------------------------------------------------
// 与 `serverModelCredentialHost.ts` 逐行同款（同一条 `httpInvoke`、同样不加工返回体、同样让
// 失败原样抛出），只是命令名与入参形状不同。两个工厂并排放着而不是合成一个带命令名参数的函数：
// 它们真正的区别是「登记的是什么」，合成之后调用点要多传一个实参，而漏传的那次不会报错。
//
// 【本文件不做任何加工】返回体就是宿主给的 `{ configured, baseUrl? }`，原样返回；失败原样抛出
// （`httpInvoke` reject 的是**裸字符串**，与 Tauri invoke 逐字一致，命令层的 `errorMessage`
// 两种形状都认）。中间不加 try/catch、不补默认值：「读不到状态」与「没登记」是两件事，
// 把前者折成后者会让面板对着一条存好的登记说没登记。

import { httpInvoke } from '../host/serverInvoke'
import type { HostInvoke } from '@einfach-agent/core'
import type { ModelEndpointHost, ModelEndpointStatus } from './modelEndpointHost'

/**
 * 造 server 宿主的接入点宿主。`invoke` 只为测试注入假实现而存在，生产路径用默认的 `httpInvoke`
 * （装配点是 `apps/web/src/host/hostModelEndpointHost.ts`）。
 */
export function createServerModelEndpointHost(
  invoke: HostInvoke = httpInvoke,
): ModelEndpointHost {
  return {
    available: true,
    status: () => invoke<ModelEndpointStatus>('model_endpoint_status'),
    save: (baseUrl: string) => invoke<ModelEndpointStatus>('model_endpoint_set', {
      input: { baseUrl },
    }),
    delete: () => invoke<ModelEndpointStatus>('model_endpoint_delete'),
  }
}
