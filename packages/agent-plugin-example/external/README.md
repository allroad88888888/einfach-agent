# external/

这是 [`docs/plugin-quickstart.md`](../../../docs/plugin-quickstart.md) 从零写一遍之后的成品参照，
不是 pnpm workspace 包（没有 `package.json`）：把本目录整份复制到
`<workspace>/.webAgent/plugins/<任意目录名>/`，用 `pnpm cli -v -p "..."` 就能在输出里看到
`[plugins] acme.hello@1.0.0: enabled`。

```sh
cp -r packages/agent-plugin-example/external .webAgent/plugins/hello-plugin
```
