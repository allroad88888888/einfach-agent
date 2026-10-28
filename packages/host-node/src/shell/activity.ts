// 「上一次收到子进程输出是什么时候」的共享脉冲
// ---------------------------------------------------------------------------
// shell 的两条管道（stdout / stderr）每读到一块数据就 `touch()` 它；`waitForChild` 订阅这个
// 脉冲，把超时判据从「总时长」换成「静默时长」——这是「一条一直在吐输出的命令不该被杀」
// 的落点。
//
// 【为什么不是一个时间戳】订阅方的动作是 `Timeout.refresh()`，它本身语义就是「从现在重新
// 计时」，不需要时间戳参与比较。改成「记 lastActivityAt，等待方轮询比较」会把两种时间源
// （脉冲自己的钟、定时器自己的钟）摆在一起，而仓库里唯一该被信任的单调钟只有一处用法
// （`performance.now()`，见 pipeline.ts 的 `millisSince`）。
//
// 【为什么不用 hostEventBus】那一套有完整的派发语义（快照、中途取消、异常隔离、异步 handler
// 不阻塞），是为「多个互不相识的消费方」设计的契约。这里只有一个消费方，且要求 touch **同步
// 生效**——异步派发会留下「refresh 还没轮到，定时器已经触发」的窗口，而那个窗口最坏的结果是
// 杀掉一个刚刚还在正常输出的命令，正是本模块要消灭的事。
//
// 【listener 抛异常不隔离】唯一的生产消费者是 `waitForChild` 里的一次 `refresh()`，不会抛。
// 真抛了说明是代码写错，让它冒泡到 `captureOutput` 的读取循环并被记成读失败，比在这里
// 吞掉更容易定位。这与 hostEventBus 的选择不同，是因为这里的 listener 面不是开放契约。

/** 输出的活性脉冲。stdout / stderr 两路都往同一个脉冲里发。 */
export interface ActivityPulse {
  /** 收到一块输出。同步通知全部订阅方。 */
  touch(): void
  /** 订阅。返回取消函数；重复调用取消函数是 no-op。 */
  listen(listener: () => void): () => void
}

/** 输出的活性脉冲。stdout / stderr 两路都往同一个脉冲里发。 */
export interface ActivityPulse {
  /** 收到一块输出。同步通知全部订阅方。 */
  touch(): void
  /**
   * 订阅。返回取消函数；重复调用取消函数是 no-op。
   *
   * 同一个函数订阅两次算**两条独立订阅**（各自拿到自己的取消函数，事件到时各被调一次）。
   * 语义对齐 Node 的 `EventEmitter`：去重会让先调用的取消函数把另一条一并杀掉，而
   * 「两个消费方传同一个模块级函数」是常事。
   */
  listen(listener: () => void): () => void
}

/** 一条订阅。取消 = 置 `active = false` **且**从集合移除。 */
interface Subscription {
  readonly handler: () => void
  active: boolean
}

export function createActivityPulse(): ActivityPulse {
  // 存订阅记录而不是裸函数：裸函数进 Set 会被**去重**，两条独立订阅合并成一条；
  // 而且派发时无从判断「这条还在不在」，取消就成了「有时管用」。
  const subscriptions = new Set<Subscription>()

  return {
    touch() {
      // 快照 + 逐条复查 `active`，两道都要：
      //   · 只要快照：在 handler 里取消另一条（或自己的）订阅，被取消的仍在快照里，照样被调
      //     —— `listen` 返回的取消函数就成了「有时管用」。
      //   · 只要复查、直接遍历原 Set：删除会让游标跳过下一条。
      for (const subscription of [...subscriptions]) {
        if (!subscription.active) continue
        subscription.handler()
      }
    },

    listen(listener) {
      const subscription: Subscription = { handler: listener, active: true }
      subscriptions.add(subscription)
      return () => {
        // 幂等：清理路径天然会跑两遍（finally 加错误分支），在那里抛异常等于惩罚
        // 正确的防御式写法。
        if (!subscription.active) return
        subscription.active = false
        subscriptions.delete(subscription)
      }
    },
  }
}
