#!/usr/bin/env node
// `npx @einfach-agent/server` 的可执行入口。**只做一件事**：给 tsup 的产物套一层操作系统能 exec 的壳。
//
// 为什么需要它：`dist/main.js` 是 tsup（esbuild）出的 bundle，**没有 shebang**（去看文件头，
// 第一行是 `// src/createServer.ts`）。npm 安装 `bin` 时在 `node_modules/.bin/` 下建的是指向目标
// 文件的符号链接，POSIX 上由内核按 shebang 挑解释器、Windows 上由 npm 生成的 `.cmd`/`.ps1` shim
// 读 shebang 决定用什么跑——没有那一行，`npx` 起不来。
//
// 为什么是转发而不是让 tsup 注入 banner（两条路都能加上 shebang，这里选了前者）：
// ① **改动面**：banner 要么写进全仓共享的 `tsup.preset.ts`（那会波及 17 个库包，它们都不是可执行的），
//    要么给 preset 加一个只有本包用的开关；转发只新增本包内的一个文件。
// ② **`dist/` 保持纯粹是 bundler 的输出**。「怎么被 npx 执行」是包级元数据的事，不是打包口径的事；
//    混进去以后 `dist/main.js` 同时是 `main`（可被 import 的模块）和自带 shebang 的脚本。
// ③ **可执行名与产物文件名解耦**。`bin` 的键 `web-agent` 是用户输入的命令名，它不该随 tsup 的
//    entry 名/输出布局漂移；将来产物改名或分片，只有本文件跟着改。
//
// 用**静态** import 而不是 `import()`：静态 import 的加载失败就是本模块的加载失败，Node 原样打印
// `ERR_MODULE_NOT_FOUND` 与完整路径；`import()` 会变成一条浮动 Promise，同样的故障降级成
// unhandled rejection。这里刻意不加 try/catch 兜「dist 不存在」——`files` 已经保证 tarball 里带着它，
// 真缺了就该响亮地报出那条路径，而不是被一句自制文案盖住真实原因。
//
// argv 不需要转发：`main.ts` 读的是 `process.argv.slice(2)`，而 argv[1] 是本文件（或 .bin 里的
// 那条符号链接），选项从 argv[2] 起，与直接 `node dist/main.js` 完全一致。
//
// 运行时下限见 package.json 的 `engines`；本文件本身没有任何超出 ESM 的语法要求。
import '../dist/main.js'
