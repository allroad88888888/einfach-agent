// model 域十条命令的**线上入参形状**
// ---------------------------------------------------------------------------
// 从 `src/commandArgs.ts` 分出来的一段：那张根表回答「每条命令收什么」，本文件回答的是同一个
// 问题、只针对 model 这一个域。大小写规则、`undefined` 陷阱、「handler 仍然必须自己收窄」
// 这些全域约定仍以根表的文件头为准，**不在这里复述**（复述就是第二权威）。
//
// 【为什么单独搬出来的是 model 域】它是入参形状还在长的那个域：本仓库在 28 条 Rust 命令之外
// 给它新增了 `model_endpoint_*` 三条（openai-compat 的登记接入点，见 endpointCommands.ts），
// 而根表当时已经贴着 300 行硬上限。搬到域目录里也顺了 routeTable.ts 那条方向——域的实现、
// 域的收窄、域的入参形状同住一处，根表只做组装。
//
// 移植来源：Rust `model_proxy.rs` / `model_credentials.rs`（已随 T1 删除，只能从 Git 历史读）。
// TS 调用点：`apps/web/src/modelTransport/`、`apps/web/src/settings/modelCredentialHost.ts`、
// `apps/web/src/settings/modelEndpointHost.ts`。

/** model 域的命令名 → 入参形状。根表 `NodeHostCommandArgs` 直接 extends 它。 */
export interface ModelCommandArgs {
  /**
   * 流式模型请求。桌面侧签名还有第三个参数 `events: Channel<ModelProxyEvent>`——那是 Tauri 的
   * 反向通道，**不是 JSON 入参**，所以不在本类型里。Node 宿主怎么把响应流送回调用方是
   * `events` 域要解决的事（HTTP 那条路上大概率是 SSE / chunked），`HostInvoke` 的
   * `(cmd, args) => Promise<T>` 签名本身装不下它。
   */
  model_provider_request: { input: { target: unknown; body: unknown; requestId: string } }
  /** 唯一的 camelCase 顶层参数之一（Rust 侧 `request_id`，命令没有 rename_all）。 */
  cancel_model_provider_request: { requestId: string }
  /** 旧渲染层兼容命令，当前无 TS 调用方；同样带 Channel 反向通道。 */
  model_chat_completions: { input: { provider: string; body: string; requestId: string } }
  /** 唯一的 camelCase 顶层参数之二。 */
  cancel_model_chat_completions: { requestId: string }
  /**
   * `provider` 取 'deepseek' | 'glm' | 'kimi' | 'openai-compat'，`scope` 取 'default' | 'cn'
   * （Rust 侧 lowercase）。`openai-compat` 没有 Rust 对应项，见 provider.ts。
   */
  model_credential_status: { provider: string; scope?: string }
  /** 响应里**从不**回传 Key 值，只回 configured 与来源——这条契约在 Node 宿主也必须保住。 */
  model_credential_set: { input: { provider: string; scope?: string; apiKey: string } }
  model_credential_delete: { provider: string; scope?: string }
  /**
   * 无参。返回 `{ configured, baseUrl? }`——接入点**不是**秘密，与凭证命令相反它必须回显：
   * 设置面板要显示用户现在登记的是哪个地址，没有回显用户就无从确认自己填对了。
   */
  model_endpoint_status: undefined
  /** 登记 openai-compat 的上行接入点。判据见 openAiCompatBaseUrl.ts；不合规整次拒绝、不落盘。 */
  model_endpoint_set: { input: { baseUrl: string } }
  /** 无参。撤销登记之后 openai-compat 立刻回到「目标未获允许」。 */
  model_endpoint_delete: undefined
}
