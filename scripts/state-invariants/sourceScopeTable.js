// 门禁扫描面的登记表 —— 哪些根算生产源码、哪些目录与后缀一律不算，以及各自的理由。
// ---------------------------------------------------------------------------
// 表与判定分家（同 atomDispositionTable.js / atomBindingTable.js）：本文件只有表和理由，
// 遍历、过滤与「成员缺 src/ 就抛错」的判定都在 sourceFiles.js。改「哪些目录算源码」只动这里。
//
// **漏判会怎样**：五条规则（derivedPurity / writeChokepoint / slotJournalShape /
// atomDisposition / agentStoreBinding）共用同一份文件清单。这里少列一个根，五条规则就一起
// 少扫一批文件、门禁**照样绿** —— 收窄扫描面是「让门禁变松而不报错」的最短路径。所以本表的
// 三条写法约束都是为了让「少扫」响亮地失败：
//   · 根按「工作区分组 × src/」枚举，不写死包名 —— 新开一个包不会悄悄掉出扫描面；
//   · 分组树里出现在白名单**之外**的非测试 TS/TSX 源文件一律抛错，除非登记进
//     SOURCE_FILE_BASENAMES_OUTSIDE_ROOTS —— 这条是本表真正的兜底：白名单写漏了什么，
//     由「有源文件没人扫」当场喊出来，而不是靠人记得；
//   · 有 package.json 却没有 src/ 的成员也抛错，除非登记进 MEMBERS_WITHOUT_SOURCE_DIRECTORY；
//   · 排除项的理由必须是「这类文件不可能承载任何一条判据」，不能是「碰巧现在没命中」。
//
// 这条兜底不是假想的：本卡第一版把「工作区成员」判成「有 package.json 的目录」，而 `apps/web`
// 根本没有 package.json（它是 Vite 的 app root，包身份挂在仓库根），于是 165 个 UI 文件
// —— 包括规则 5 的头号案发现场 UndoBar.tsx —— 一声不响地掉出了扫描面，门禁照样绿。

// 工作区分组，与 pnpm-workspace.yaml 的 `apps/*` / `packages/*` / `tools/*` 一一对应。
// 新增分组必须同步加到这里，否则整组不进扫描面。
export const WORKSPACE_GROUPS = ['apps', 'packages', 'tools']

// 每个分组成员唯一被扫的子目录。与 check-boundaries.js 的 `<pkg>/src` 同口径。
// 「成员」= 分组下**有 src/ 的目录**，不是「有 package.json 的目录」：`apps/web` 没有
// package.json（Vite app root，包身份在仓库根），按后者判会整个掉出扫描面。
export const SOURCE_DIRECTORY = 'src'

// 有 src/ 但不含 TS/TSX 生产源码的精确根。Tauri 的 Rust 薄壳不承载 Einfach atom 或 React
// hook，状态门禁不该把 Rust 当 TypeScript 解析；一旦这里出现 TS/TSX，白名单外的第一道闸会失败。
export const SOURCE_ROOTS_WITHOUT_TYPESCRIPT = {
  'apps/desktop/src': 'Tauri thin shell is Rust-only; session state remains in the shared Node server and Web UI.',
}

// 例外表：确实没有 `src/` 的 pnpm 工作区成员（纯原生 / 纯配置的包）。**当前为空**。
// 登记一条就等于承认「这个包不参与状态门禁」，要写清凭什么它不可能有会话状态。
export const MEMBERS_WITHOUT_SOURCE_DIRECTORY = []

// 例外表：允许住在白名单根之外的源文件名。除这些之外，分组树里任何非测试 TS/TSX 文件
// 落在 `<成员>/src` 外面都会让门禁直接失败 —— 那说明白名单漏了一个根。
export const SOURCE_FILE_BASENAMES_OUTSIDE_ROOTS = [
  // tsup 的构建配置，只被打包器读；不 import 任何 atom，也不会出现在渲染层。
  'tsup.config.ts',
]

// 兜底黑名单：即便嵌在 `<pkg>/src` 里也不算源码的目录名。
// 白名单已经把这两类挡在外面（它们是 `<pkg>/dist`、`<pkg>/node_modules` 的兄弟目录），
// 这里再列一遍是为了 `src/` 内部出现同名目录时不靠运气。
export const EXCLUDED_DIRECTORY_NAMES = [
  // tsup 产物，是 `src` 的编译副本。扫它等于让门禁结论取决于「本地跑没跑过 pnpm build」：
  // CI 里门禁排在 build 之前恰好扫不到，本地 build 过就多扫 600 多个 .d.ts。
  'dist',
  // 第三方依赖，不是本仓库源码。
  'node_modules',
]

// 兜底黑名单：不算源码的文件后缀。
export const EXCLUDED_FILE_SUFFIXES = [
  // 类型声明文件没有可执行代码，而五条规则判的全是运行期形状（atom 定义、writer 调用、
  // 裸 hook 调用），`.d.ts` 里不可能出现 —— 排除它不会放过任何一条判据。
  // 仓库里 `<pkg>/src` 下的 8 个 `.d.ts` 都是手写环境声明（raw-modules / vite-env），
  // dist 里的 600 多个则是编译产物；两类都按同一条理由排除。
  '.d.ts',
]

// 源文件后缀。
export const SOURCE_FILE_PATTERN = /\.(?:ts|tsx)$/

// 与 check-boundaries 同口径：测试脚手架不是生产代码。
export const TEST_FILE_PATTERN = /\.(?:test|testHarness|testFixtures|fixtures)\.(?:ts|tsx)$/
