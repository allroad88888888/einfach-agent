import type { ProviderTransport } from '@einfach-agent/ai'
import { createProviderFetch } from './providerFetch'

const unavailableMessage = '静态 Web 部署没有可信模型代理；请连上本机后端（pnpm serve）或用本地开发预览。'

export function createUnavailableProviderTransport(): ProviderTransport {
  return {
    async request(): Promise<Response> {
      throw new Error(unavailableMessage)
    },
  }
}

/** Creates the fail-closed fetch implementation used by static browser builds. */
export function createUnavailableModelFetch(): typeof fetch {
  return createProviderFetch(createUnavailableProviderTransport())
}
