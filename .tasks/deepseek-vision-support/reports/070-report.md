# 070 执行报告：说明 DeepSeek 视觉能力

## 改动摘要

- `README.md` 的 **Configuring models** 段新增 DeepSeek vision 说明：
  `deepseek-v4-flash-vision-exp`、Composer 对 JPEG/PNG/WebP 原图的 Files API 临时上传、
  `view_image` 的 `low` 默认与 `high` 适用场景，以及观察文件在完成或失败后的尽力清理。
- `README.zh-CN.md` 的 **配置模型** 段同步同一事实和限制。
- 两份文档均链接官方 [Vision 指南](https://api-docs.deepseek.com/guides/vision) 与
  [Files API](https://api-docs.deepseek.com/guides/files_api)；没有宣传 GIF、动画、Responses API、
  64 MiB、服务端 `file_id` 的 `detail`，或真实联网验证。

## 验收

1. `rg -n "deepseek-v4-flash-vision-exp|view_image|Detail|detail" README.md README.zh-CN.md`
   - 通过：两份 README 分别在英文 147–150 行、中文 139–142 行包含模型与 `view_image`/`detail` 说明。
2. `rg -n "api-docs.deepseek.com/.*/guides/(vision|files_api)" README.md README.zh-CN.md`
   - 通过：两份 README 均包含官方 Vision 与 Files API 直接链接，无搜索页链接。
3. `git diff --check -- README.md README.zh-CN.md`
   - 通过：无空白错误。

## C-010 证据

- 用户可在两份根 README 的模型配置位置确认：精确视觉模型名；Composer 仅上传 JPEG、PNG、WebP 原图；
  `view_image` 的默认 `low` 为 512×512 包围盒，以及 OCR、截图小字、密集图表和精细比较应选择 `high`。
- 文档还明确图片观察产生的临时文件在完成或失败后 best-effort 清理，并给出两条官方 API 指南链接。

## 未验证与范围外

- 未进行真实 DeepSeek 网络/API 验证；本叶仅同步 040、050、060 已审查实现的文档事实。
- 未验证 GIF、动画、Responses API、64 MiB、服务端 `file_id` 的 `detail`，这些均不在文档表述范围内。
- 根目录与任务基线均不存在 `README.zh-TW.md`、`README.ja.md`；经编排者修正任务范围后，只更新现有的
  `README.md` 与 `README.zh-CN.md`，未新建两份残缺翻译。
- 已保留 README 既有 BYOK 在途改动，未 reset、checkout、暂存或提交。

## 回执（四态）

- 实现：完成
- 聚焦验证：完成
- 组合类型检查：不适用（纯 README 文档叶）
- 范围外变更：未处理，已保留

## R1 修复记录

- 四条 DeepSeek 官方文档链接均改为任务指定的 `/zh-cn/guides/vision` 与
  `/zh-cn/guides/files_api` 精确路径；未改动其它 README 文案或文件。
- `rg -n "https://api-docs\\.deepseek\\.com/zh-cn/guides/(vision|files_api)" README.md README.zh-CN.md`
  通过：每份 README 各有 Vision、Files API 两个命中。
- `git diff --check -- README.md README.zh-CN.md` 通过：无空白错误。

## R1 回执（四态）

- 实现：完成
- 聚焦验证：完成
- 组合类型检查：不适用（纯 README 文档叶）
- 范围外变更：未处理，已保留
