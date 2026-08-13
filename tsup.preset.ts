// 发包构建的共享 tsup 预设（V1 在 packages/agent-ai 试点，V3 逐包接线时直接复用）。
// ---------------------------------------------------------------------------
// 这里只放**全仓一致**的构建口径；包与包之间会变的东西全部由调用方传参，见 PackageBuildInput。
// 选型依据见 docs/launch/npm-publish-plan.md 第 3 节：JS 交给 tsup（esbuild），
// `.d.ts` 交给各包自己的 `tsc -p tsconfig.build.json --emitDeclarationOnly`，两者产物合流同一个 dist。
// 要改「全仓怎么构建」就改这个文件，别在单包 tsup.config.ts 里各改各的。
import { defineConfig, type Options } from 'tsup'
import { rawTextPlugin } from './tsup.rawPlugin'

export interface PackageBuildInput {
  /**
   * 包间会变 ①：入口。默认形态是单 barrel `['src/index.ts']`；
   * 保留显式 subpath exports 的包（如 core）要把每条 subpath 的源文件都列进来，
   * 与 package.json `exports` 逐条对应——tsup 不会替你推断 subpath。
   */
  entry: NonNullable<Options['entry']>
  /**
   * 包间会变 ②：额外的 external。
   * tsup 已自动把**本包 package.json** 的 `dependencies` + `peerDependencies` 标为 external
   * （见 tsup 的 getProductionDeps，按运行时 cwd 就近取 package.json），所以正常情况下这里留空。
   * 只有「自动推不出的」才手写：未在本包声明的可选 peer、只在类型里出现的包、
   * 或需要按子路径细分的说明符。
   *
   * 反过来说：**包没在自己的 package.json 里声明的运行时依赖会被打进产物**（G9 那类未声明
   * 依赖在这里会变成静默的重复打包），接构建前先核对本包 dependencies 是否齐全。
   */
  external?: NonNullable<Options['external']>
  /**
   * 包间会变 ③（少数包才用）：**某包独有**的 esbuild 插件。
   * 全仓通用的 `?raw` 内联插件已默认接上（见下方 esbuildPlugins），这里传的是追加项。
   */
  esbuildPlugins?: Options['esbuildPlugins']
}

export function definePackageBuild({ entry, external = [], esbuildPlugins }: PackageBuildInput) {
  return defineConfig({
    entry,
    // 全仓 `"type": "module"`，没有 CJS 消费方；只出 ESM，顺带避开 dual-package hazard。
    format: ['esm'],
    // 与 tsconfig.app.json 的 target 对齐（ES2022）。
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // esbuild 的 JS sourcemap 默认内联 sourcesContent，`files: ["dist"]` 不带 src 也不会断链。
    clean: true,
    // **不用 tsup --dts**：rollup 系声明打包在 core 那种大类型面上容易慢或在循环类型上失败，
    // 声明产物一律由各包的 tsconfig.build.json 出。
    dts: false,
    // 产物必须与 entry 一一对应：package.json 的 exports 要写死路径，不能有代码分割出来的
    // 哈希 chunk 名。
    splitting: false,
    external,
    // `?raw` 内联对全仓生效：源码里的 `*.md?raw` 是 Vite 语法，产物必须已经把正文变成字符串，
    // 否则消费方的打包器/Node 会去找一个叫 `x.md?raw` 的文件。包自带插件排在它后面。
    esbuildPlugins: [rawTextPlugin(), ...(esbuildPlugins ?? [])],
  })
}
