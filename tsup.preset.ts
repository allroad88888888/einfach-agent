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
  /**
   * 包间会变 ④：代码分割。默认 false（单 entry 包的正确口径，产物扁平、无哈希 chunk）。
   *
   * **多 entry 且 entry 之间共享可变状态（模块级单例：store、registry、计数器）的包必须开。**
   * 理由：`splitting: false` 下每个 entry 各自打成一个独立 bundle，共享模块会被**逐份内联**；
   * 消费方同时 `import '@x/pkg'` 和 `import '@x/pkg/sub'` 时就拿到两份单例，状态直接分裂——
   * 这是运行时才炸、且没有任何构建期警告的正确性事故。开 splitting 后 esbuild 把共享模块提到
   * 独立 chunk，两条 entry 相对 import 同一个 chunk，单例回到一份。
   *
   * 代价：dist 里多出 `chunk-*.js`。entry 文件名不受影响（仍按 entry key 落地），所以
   * package.json 的 exports 照样能写死路径；chunk 只被 entry 以相对说明符引用，不进 exports。
   */
  splitting?: boolean
}

export function definePackageBuild({
  entry,
  external = [],
  esbuildPlugins,
  splitting = false,
}: PackageBuildInput) {
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
    // 代价是 tsc 原样保留无扩展名的相对说明符，所以各包 build script **必须接
    // `node ../../scripts/fix-dts-specifiers.mjs dist`**，否则 node16/nodenext 消费方直接红
    // （TS2834 起，barrel re-export 连带全灭）。
    dts: false,
    // 见 PackageBuildInput.splitting：默认关，多 entry + 共享可变状态的包按需开。
    splitting,
    // **必须显式关掉**：tsup 默认 `removeNodeProtocol: true`，会挂一个内置 esbuild 插件把
    // `node:xxx` 无条件重写成裸名 `xxx`（tsup/dist/index.js 的 `nodeProtocolPlugin`）。
    // 那是给「产物要跑在不认 `node:` 的老 Node / 老打包器上」准备的，本仓库 engines 是
    // `>=22.13.0`，不需要，而且它有一类致命后果：**只存在 `node:` 形式的内置模块会被剥成
    // 一个不存在的包名**。`node:sqlite` 就是——剥成 `sqlite` 后 npm registry 上那是别人的包，
    // 消费方 `Cannot find package 'sqlite'`，SQL 持久化整条挂掉（其余内置恰好都有裸名别名，
    // 所以只有它显形）。
    //
    // 只能在这里关，不能靠 `platform` / `target` / `external: [/^node:/]` 绕：三者都是**交给
    // esbuild 的**参数，而剥前缀发生在更早的 tsup 插件 `onResolve` 里；等 esbuild 的内置外部化
    // 或 tsup 自己的 externalPlugin 看到这个说明符时，它已经叫 `sqlite` 了。也不能靠传一个
    // 自己的 esbuild 插件覆盖：`esbuildPlugins` 被追加在 `nodeProtocolPlugin` **之后**，
    // 同 filter 的 onResolve 按注册序先到先得，后来者根本不会被调用。
    removeNodeProtocol: false,
    external,
    // `?raw` 内联对全仓生效：源码里的 `*.md?raw` 是 Vite 语法，产物必须已经把正文变成字符串，
    // 否则消费方的打包器/Node 会去找一个叫 `x.md?raw` 的文件。包自带插件排在它后面。
    esbuildPlugins: [rawTextPlugin(), ...(esbuildPlugins ?? [])],
  })
}
