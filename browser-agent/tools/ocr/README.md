# PaddleOCR browser tool

`@einfach-agent/tools-browser-ocr` 提供独立的 `paddle_ocr` 工具，无 React、Chrome、Python 依赖。
使用 PaddleOCR 官方异步任务接口和 `PP-OCRv6`，支持 PDF、PNG、JPEG、WebP、GIF；不解析 Word。

```ts
registerOcrTools(registry, {
  getToken: () => hostCredentials.ocrToken,
  resolveAttachment: (id, context) => attachments.get(context.sessionId, id),
  fetch: hostFetch, // 可选；默认 globalThis.fetch
})
```

输入来源三选一：`{ attachmentId }`、`{ fileUrl }`、`{ jobId }`。
本地文件通过宿主解析为 `{ name, data: Blob }`，不接受本地路径或模型传入的凭据。
可选 `pageRanges`（如 `1-3,5`，只在提交时生效）、三个文档方向/矫正开关、
`timeoutMs`（默认 60 秒，上限 120 秒）和 `maxChars`（默认 30,000，上限 50,000）。

返回 `jobId`、`state`、`pageCount`、`pages`（有序文字、平均置信度、标注图 URL）、`truncated`。
页号表示所返回结果的顺序；限定 pageRanges 时不代表原文件页号。
不会自动下载标注图。结果 JSONL 最多读取 16 MiB，最多向模型返回 200 页；截断会明确标记。

只提交一次，不自动重试 POST。已知 jobId 的等待超时或查询失败可以用同一 ID 继续查询；
提交响应丢失则返回 `OCR_SUBMISSION_UNKNOWN`，不得自动再次上传。取消只停止本地等待，
已提交云端任务仍可能继续。工具标记 `replayUnsafe`，摘要不能建议重复执行上传。

Token 仅发送给固定的官方 API；结果存储请求不带 Token、Cookie 或 Referer，并拒绝重定向。
原始传输异常和 API 错误响应体不透传给模型。宿主须对 attachmentId 执行会话隔离。

普通网页需要能访问 API 和结果存储的宿主转发接口（通过 `fetch` 注入）；官方接口未向任意
网页开放 CORS。插件声明 API 及已验证结果域名的 host_permissions，由侧栏直接请求。

协议参考：[官方 HTTP 客户端](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_api_client/_http.py)、
[官方结果轮询解析](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_api_client/_poller.py)。
