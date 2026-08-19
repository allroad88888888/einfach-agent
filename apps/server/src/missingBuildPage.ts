// 前端产物缺失时的提示页。
//
// 看到这个页面的**就是用户本人**（本地自托管，没有别人），所以这页要回答的是「我现在该做什么」，
// 不是「文件没找到」。一个裸 404 会把「你还没 build」误导成「服务端坏了」，而两者的处置完全不同。
//
// 状态码用 503 而不是 404：缺的不是**某个资源**，是这台服务器还没准备好提供前端——404 会让
// 浏览器、反代与自动化探针把它当成一条正常的「该路径不存在」，而 503 恰好是「暂时不可用，
// 稍后再来」。`/api/health` 在这一刻仍然是 200，两者合起来说的是同一件事：服务端活着，产物没有。

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

// 路径来自启动选项而不是请求，但仍然转义：这页把一个**文件系统路径**回显进 HTML，
// 而「回显来源可信所以不转义」正是所有 XSS 的第一句台词。
function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ESCAPES[character] ?? character)
}

export function renderMissingBuildPage(distDirectory: string): string {
  const path = escapeHtml(distDirectory)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web Agent 尚未构建</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 3rem 1.5rem; font: 15px/1.7 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 42rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { padding: 0.75rem 1rem; border-radius: 6px; background: rgba(127, 127, 127, 0.14); overflow-x: auto; }
p { margin: 0 0 1rem; }
.path { word-break: break-all; }
</style>
</head>
<body>
<main>
<h1>Web Agent 尚未构建</h1>
<p>服务端本身正常（<code>/api/health</code> 可以访问），只是还没有找到前端构建产物：</p>
<p class="path"><code>${path}</code></p>
<p>在仓库根目录执行下面两条命令，然后刷新本页：</p>
<pre>pnpm install
pnpm build</pre>
<p>首次克隆仓库才需要 <code>pnpm install</code>；之后改了前端代码，重跑 <code>pnpm build</code> 即可。</p>
<p>如果只是想开发调试前端，也可以改用 <code>pnpm dev</code> 启动 Vite 预览。</p>
</main>
</body>
</html>
`
}
