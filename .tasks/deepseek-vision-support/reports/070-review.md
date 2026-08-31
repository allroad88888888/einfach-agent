# 070 审查：说明 DeepSeek 视觉能力

## 结论

**APPROVED**。未发现 Critical / Important / Minor 问题。

审查基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`。仅审阅 070 执行报告及两份 README 相对该基线的
diff；未重跑报告中的测试或验收命令，未修改产品文件。

## C-010 验收

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 两份 README 同步记录模型与工具 | ✅ | `README.md:147–153` 与 `README.zh-CN.md:139–143` 均包含精确模型名 `deepseek-v4-flash-vision-exp`、`view_image`、`detail` 及同一组行为说明。 |
| Composer 支持格式边界 | ✅ | 两份新增段落均只宣传 JPEG、PNG、WebP，并说明保留原始字节。 |
| Files API 临时上传 | ✅ | 两份文档都明确 Composer 附件经 DeepSeek Files API 临时上传，并使用官方直链 `https://api-docs.deepseek.com/guides/files_api`。 |
| `view_image` 默认与 low 行为 | ✅ | 两份文档都写明默认 `detail: 'low'`，静态图上传前缩放至 512×512 包围盒。 |
| high 使用建议与像素语义 | ✅ | 两份文档均列出 OCR、截图小字、密集图表、精细视觉比较，并说明 `high` 保留原始像素。 |
| 清理语义 | ✅ | 两份文档均说明图片观察文件在完成或失败后 best-effort 删除。 |
| Vision 官方链接 | ✅ | 两份文档均链接官方 `https://api-docs.deepseek.com/guides/vision`，不是搜索页。 |
| 未实现能力未宣传 | ✅ | 070 新增行没有 GIF、动画、Responses API、64 MiB、服务端 `file_id` 或服务端 `file_id` 的 `detail` 表述。 |
| 局部插入与双语一致性 | ✅ | 视觉说明局部插入“配置模型”段落，英文与中文逐项对应，没有新增其他 README 或重写无关章节。 |
| 空白与执行报告验收 | ✅ | 执行报告记录的 `git diff --check -- README.md README.zh-CN.md` 通过；本审查不重复运行。 |

## 在途改动边界

相对 070 基线的 README diff 还包含静态 BYOK、localStorage、CORS 和配置密钥说明。这些是 README 中已有的
在途改动，已与视觉说明区分，未将其归因于 070，也未要求回滚。两份 README 顶部已有的 `cli-demo.gif` 图片
引用同样属于既有内容，不是 070 对视觉输入格式或动画能力的宣传。

## 回执

APPROVED — 两份现有 README 的 DeepSeek Vision 说明准确、一致且局部插入，满足 C-010 验收边界。

## R1 最小复审

复审仅核对任务指定链接与已批准文案，未重跑报告测试，未修改 README。

| 文件 | Files API 链接 | Vision 链接 | 结论 |
| --- | --- | --- | --- |
| `README.md` | `https://api-docs.deepseek.com/zh-cn/guides/files_api`（1 条） | `https://api-docs.deepseek.com/zh-cn/guides/vision`（1 条） | ✅ |
| `README.zh-CN.md` | `https://api-docs.deepseek.com/zh-cn/guides/files_api`（1 条） | `https://api-docs.deepseek.com/zh-cn/guides/vision`（1 条） | ✅ |

四条链接均精确匹配要求；将两段视觉说明中的链接路径归一化后，模型、格式、`view_image` detail、high
场景与 best-effort 清理文案均与已批准版本一致，未发现其他文案变化。

## R1 回执

APPROVED — 两份 README 各含一条精确的 zh-cn Vision 链接和一条精确的 zh-cn Files API 链接，其余已批准文案未变。
