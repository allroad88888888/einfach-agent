// 组请求稳定前缀里的各条 system 消息（固定 system / 长期自定义指令 / 运行环境）—— 无副作用、无 store。
// ---------------------------------------------------------------------------
//   · buildSystemItem / buildCustomInstructionsItem —— 固定 system 与长期自定义指令，都放在
//     append-only 历史【之前】的稳定前缀里，不含本轮输入。
//     ★ 固定 system 现在只有收尾自查 / 如实报告两条 ★ —— 曾经写在这里的六条协议条款
//     （lazy tools、禁止模拟工具调用、skill 正文经 skill_read、planning 三段式、计划审批）
//     已按用户裁决整段移除。lazy tools 那一半仍有信息源：工具摘要段（toolManifest.ts）自己就写
//     「仅用于发现，不代表参数 schema 已加载」并指向 request_tool_schema；其余几条不再进 prompt。
//     ★ skill 名单不由本文件产出 ★（阶段 3，docs/skills-tree-blueprint.md）：曾经的
//     buildSkillContextItem 按本轮输入匹配 skill、把名单挂在历史尾部，导致每轮都被新历史顶位、
//     全额 cache miss。名单改由 registry 的 buildSkillManifestText() 产出【全量】清单，
//     由 modelTurnPrefix 作为稳定前缀的一段组装，模型按 description 自判该读哪个；
//     TK4 不变——进 prompt 的只有清单元数据，正文与资源仍必须经 skill_read。
//     中途曾把它改成 sessionStart 到点工具、投影成历史里的 timed tool result（a88ba16），
//     那等于把清单搬回历史尾巴、重演当年的持续 miss；C7 已把它迁回稳定前缀。
//   · buildEnvironmentItem —— 组「运行环境」段（workspace 根目录 / 本机能力 / 平台 + 路径纪律）。
//     它和 skill 清单是稳定前缀里仅有的两段按 workspace 变化的内容，故一起排在其它前缀段【之后】。

import type { HostPlatform } from './hostPlatform'
import type { SystemItem } from '@einfach-agent/ai'
// 收尾自查 / 如实报告两条条款住在零依赖叶子模块：evals 的 prompt 行为 A/B 要 import 同一份
// 字节做对照实验，而本文件（经装配的 skill registry + tools/registry 的 defaultCore）
// 在那个 tsconfig 下既无法解析也不该被实例化。详见 selfReflectionPrompts.ts 顶部说明。
import { SELF_CHECK_CLAUSES } from './selfReflectionPrompts'

// 简介：组固定的 system 指令（不 appendItem，只用于请求）——当前就是收尾自查 / 如实报告两条。
// 详情：这里不能混入本轮输入、时间或计划状态，否则每轮都会从 token 0 打断 Provider 的前缀缓存。
export function buildSystemItem(): SystemItem {
  return { role: 'system', content: SELF_CHECK_CLAUSES.join('\n') }
}

export interface EnvironmentItemInput {
  /** 该会话绑定的 workspace 根目录（已归一化）；未绑定时为 undefined。 */
  workspaceRoot?: string
  /**
   * 宿主有没有本机能力——文件 / shell / Git 工具能不能真的执行。
   *
   * 【B3：为什么按能力措辞】这个入参与它渲染的文案曾经都写死成一个宿主品牌，等于把
   * 「有没有本机能力」写成了「是不是某个牌子的宿主」。判据在 H4b 就已经换成
   * `hasHostBridge()`：桥背后是 Tauri 原生层、本机 Node 后端还是别的什么，core 不关心。
   * 名字与文案不跟着换的话，浏览器接上本地 Node 后端之后，模型会被告知自己在 Tauri 桌面端，
   * 然后按一个错误的宿主假设行事——而这段文本是喂给模型的，它没有第二个信息源可以纠正。
   */
  hostHasLocalCapabilities: boolean
  /**
   * 宿主平台，取自 `hostPlatform()`（S5）——与 shell 桥实际收到的值**同一个来源**，
   * 不是各自探测。模型据这一行在 shell_macos / shell_linux / shell_powershell 里挑工具，
   * 所以它和桥拿到的值必须逐字一致，否则模型按 A 平台组命令、桥按 B 平台拒绝。
   *
   * 没有本机能力时它回落成本地探测值（`hostPlatform()` 的文件头写明），此刻没有任何机器会
   * 执行命令，这个值只是「用户坐在哪种机器前」，文案里也据此措辞。
   */
  platform: HostPlatform
}

// 简介：组「运行环境」system 消息——告诉模型它在哪台机器、哪个工作区里干活。
// 详情：这是稳定前缀里【最后】一段，因为它按会话绑定的 workspace 变化（另一段这样的是 skill
//   清单，排在它之前，见 modelTurnPrefix 的顺序注释）。内容只依赖会话绑定的 workspace 与宿主环境，
//   不含本轮输入、时间或计划状态，所以整个会话生命周期内逐字不变。
// ★ 为什么必须有这一段 ★ —— 缺它时模型对「我在哪」零信息，只能猜；实测模型首轮
//   直接编出一条训练数据里的绝对路径（/Users/<某人>/develop/...），read_file 报
//   WORKSPACE_READ_FAILED，模型是从【报错文案】里才第一次看到真实 workspace 根目录，
//   白烧三轮才走上正轨。把根目录摆进稳定前缀能整类消灭这种开局失败，且因为在前缀里、
//   逐字不变，token 成本被 provider 前缀缓存吃掉。
export function buildEnvironmentItem(input: EnvironmentItemInput): SystemItem {
  const lines = ['运行环境：']

  if (input.hostHasLocalCapabilities) {
    // 【B3】按能力措辞，不报宿主品牌：同一句话要对桌面原生层和本机 Node 后端两种宿主都逐字成立。
    // 「宿主机器」这个说法同时交代了一件 server 宿主下必须交代的事——执行工具的那台机器不一定
    // 是用户面前这台，下面的工作区路径与平台说的都是前者。
    lines.push(`- 本机能力：可用（文件、shell 与 Git 工具在宿主机器上执行）；宿主机器平台 ${input.platform}。`)
    // 宿主可以是三种 shell 都不支持的系统（FreeBSD / AIX…）：文件能力照常，shell 一定跑不了。
    // 不说这一句的话，模型只会看到一个陌生的平台名，然后在三个 shell 工具里随便挑一个反复撞
    // platform mismatch——那句错误里没有任何「本宿主根本没有 shell」的信息。
    if (input.platform === 'unsupported') {
      lines.push('- 宿主机器平台不属于 macos / linux / windows 三者之一：shell 类工具在本宿主上一定失败，不要调用它们，改用文件与 Git 工具完成任务。')
    }
    if (input.workspaceRoot) {
      lines.push(`- 当前工作区根目录：${input.workspaceRoot}`)
      lines.push('- 文件与 shell 工具的相对路径都以该根目录为基准；除非明确需要访问外部路径，优先传相对路径。')
    } else {
      // 没有根目录可报时不能造一个，也不能说"以该根目录为基准"——指代会落空。
      lines.push('- 当前会话未绑定工作区根目录：本机侧会自行推断（通常取 Git 根目录）。先用一次目录列举取得实际根目录，再据此组路径；此前一律传相对路径。')
    }
    // 反臆造条款：模型编路径时往往同时编出「项目是什么」，所以这里同时禁掉「按记忆假设内容」。
    lines.push('- 你对这个工作区里有什么文件【一无所知】。不要凭记忆或猜测写出本段未给出的绝对路径，也不要假设某个文件存在；先用目录列举或搜索类工具确认，再读写。')
  } else {
    // 同样不报品牌：没有本机能力的宿主今天有静态 Web 预览、也有还没接进程内 host 的 CLI，
    // 说「浏览器（Web 预览）」对后者已经是错的。这里的平台是用户设备的，不是任何执行机器的
    // ——没有机器会执行命令，所以明说它只作参考。
    lines.push(`- 本机能力：不可用（本宿主没有接入任何能执行命令的机器）；用户设备平台 ${input.platform}，仅供参考。`)
    lines.push('- 本机文件、shell 与 Git 工具在本环境不可用，工具清单里也不会出现它们；不要声称自己读过或改过本机文件。')
  }

  return { role: 'system', content: lines.join('\n') }
}

// 简介：把宿主保存的长期自定义指令组成一条独立 system 消息。
// 详情：它与固定运行时协议分开成条（便于观测与替换），但由调用方放在【固定 system 之后、
//   append-only 历史之前】，与固定 system 一起构成本 lane 的稳定前缀。
// ★ 缓存权衡（曾经放在历史之后，实测每轮全额 miss）★ ——
//   自定义指令是低频变更的长期设置，却随着历史每轮增长被顶到新位置，于是每一轮都要为这段
//   token 付一次 cache miss。挪进稳定前缀后：不变的轮次（绝大多数）整段命中；用户真去设置里
//   改了指令的那一次，前缀字节变化会让 contextCache 记一次 profile_changed（新 epoch）、
//   provider 侧对应一次全量 miss —— 用「变更时的一次性代价」换「每一轮的持续命中」。
//   因此调用方须把本条内容并入 contextCache 的 systemContent，让变更被归因为 profile_changed，
//   而不是被误当成尾巴动态控制的变化。
export function buildCustomInstructionsItem(instructions: string): SystemItem | undefined {
  const normalized = instructions.trim()
  if (!normalized) return undefined
  return {
    role: 'system',
    content: `用户在设置中保存了以下长期自定义指令，请在本次任务中遵循：\n${normalized}`,
  }
}
