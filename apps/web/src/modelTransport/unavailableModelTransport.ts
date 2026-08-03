/** Creates the fail-closed fetch implementation used by static browser builds. */
export function createUnavailableModelFetch(): typeof fetch {
  return async () => {
    throw new Error('静态 Web 部署没有可信模型代理；请使用桌面应用或本地开发预览。')
  }
}
