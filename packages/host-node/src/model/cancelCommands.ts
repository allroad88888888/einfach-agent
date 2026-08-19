// `cancel_model_provider_request` / `cancel_model_chat_completions` 的 Node 实现
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_proxy.rs 的两条同名命令——它们在 Rust 侧是**逐字相同**的两个
// 函数（都只是 `cancellations.cancel(&request_id)`），Node 侧同样共用一个工厂，只有报参数缺失时
// 的命令名不同。合并成一条命令是不行的：命令名是对外契约，旧渲染层发的是后一个名字。
//
// ⚠️ **入参是 camelCase 的 `requestId`**，不是 snake_case。这两条命令是全表 28 条里仅有的两个
// 例外（`commandArgs.ts` 的文件头点名）：它们没有 `rename_all = "snake_case"`，走 Tauri 默认的
// camelCase→snake_case 转换，而参数名恰好是多词。照 workspace 那批的习惯写成 `request_id`，
// 结果是取消永远读到 undefined —— 而 undefined 会被判成「缺参数」抛错，不是静默失效，这一点是
// 下面那句显式检查换来的。
//
// 【取消一个不存在的 id 是 no-op，不是错误】前端在收尾竞态里补发一次 cancel 很常见（响应刚结束、
// abort 事件才到）。让它抛错只会把一次无害的迟到变成一条错误日志，而调用方对此无能为力。
// 返回值 `false` 就是完整的答复：「找过了，没有这个在飞的请求」。

import { ModelRequestError } from './errors'
import {
  modelRequestRegistry,
  validateModelRequestId,
  type ModelRequestRegistry,
} from './requestRegistry'
import type { NodeHostCommandHandler } from '../routeTable'

/**
 * 造一条取消命令的 handler。
 *
 * `registry` 默认是进程级共享实例——**必须**和 `forwardProviderRequest` 用的是同一张表，否则取消
 * 命令永远找不到请求（那正是「按装配实例各持一份」会造成的静默失效，见 requestRegistry.ts 文件头）。
 */
export function createCancelModelRequestHandler(
  commandName: string,
  registry: ModelRequestRegistry = modelRequestRegistry,
): NodeHostCommandHandler {
  return async (args) => {
    // 判存在只看值，不用 `'requestId' in args`：进程内注入时可选键可能「存在且为 undefined」，
    // 走 HTTP 时 JSON.stringify 又会把它丢掉，用 `in` 会写出两种传输下行为不同的检查。
    // 与本域其余失败一样带上 `reason`：文案是给人看的，判别面是字段（见 errors.ts 文件头）。
    // 这一条**没有** Rust 对应文案（Tauri 那边缺参数是反序列化层拒的），所以它不在 MODEL_ERROR 表里，
    // 而分类与那张表里的收窄失败同类：调用方发错了参数。
    if (args.requestId === undefined) {
      throw new ModelRequestError('invalid-request', `${commandName} 缺少 requestId 参数`)
    }
    // id 格式非法仍然抛（`模型请求 ID 无效`）：那是调用方写错了，与「这个 id 不在表里」不是一回事。
    // 收窄放在这里而不是靠 `String(...)` 强转：`String(123)` 会把一个数字 id 洗成合法字符串，
    // 于是「调用方类型发错了」变成一次查不到的取消，症状是取消按钮偶尔没反应。
    return registry.cancel(validateModelRequestId(args.requestId))
  }
}
