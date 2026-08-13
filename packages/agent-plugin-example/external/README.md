# external/

这是 [`docs/plugin-quickstart.md`](../../../docs/plugin-quickstart.md) 从零写一遍之后的成品参照，
不是 pnpm workspace 包（没有 `package.json`）：把本目录整份复制到
`<workspace>/.webAgent/plugins/<任意目录名>/`，用 `pnpm cli -v -p "..."` 就能在输出里看到
`[plugins] acme.hello@1.0.0: enabled`。

```sh
cp -r packages/agent-plugin-example/external .webAgent/plugins/hello-plugin
```

同一份文件在桌面端也能装：入口写的是静态 `import { definePlugin } from '@web-agent/core/plugin'`，
桌面宿主求值前会把这个说明符改写到自己的契约模块桥，因此不依赖 `node_modules`
（见 quickstart 的「在桌面端跑同一个插件」）。
