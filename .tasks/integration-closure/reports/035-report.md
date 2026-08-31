# 035 Lingui catalog 稳定性报告

状态：DONE

## 初始机械核对

| Catalog | 初始 SHA-256 | Source entries | Header 外空 `msgstr` | fuzzy / obsolete |
| --- | --- | ---: | ---: | --- |
| `apps/web/src/i18n/locales/en/messages.po` | `a133bd0af4aa047ce6c2f20c7aa96a4ad080f7a3b253efa638bfef51d86a41d5` | 482 | 0 | 无 |
| `apps/web/src/i18n/locales/zh-CN/messages.po` | `eae155131465f6f7b1b7dc2b8bfd568824e27dbd4f2f5db0dae10b23f660f733` | 482 | 0 | 无 |

核对使用 `awk` 统计非 header `msgid` 与空 `msgstr`，并以 `rg '^#, fuzzy|^#~'` 检查 fuzzy/obsolete entry。

## 生成验证

```text
pnpm lingui:extract --clean && pnpm lingui:compile
```

通过：extract 统计 `zh-CN (source) 482`、`en 482`、`Missing 0`；compile 成功完成。

提取与编译后的 SHA-256 与初始值完全一致：

| Catalog | 最终 SHA-256 |
| --- | --- |
| `apps/web/src/i18n/locales/en/messages.po` | `a133bd0af4aa047ce6c2f20c7aa96a4ad080f7a3b253efa638bfef51d86a41d5` |
| `apps/web/src/i18n/locales/zh-CN/messages.po` | `eae155131465f6f7b1b7dc2b8bfd568824e27dbd4f2f5db0dae10b23f660f733` |

最终再次机械核对：两份 PO 都是 482 entries、header 外空 `msgstr` 为 0、无 fuzzy/obsolete。未手改或格式化 PO，未修改生产源或 Lingui 配置。

## 真实 Provider surface 验证

```text
pnpm exec vitest run apps/web/src/agentNew/ui/i18nFullSurface.test.tsx apps/web/src/agentNew/ui/i18nConversation.test.tsx
```

通过：2 文件、4 测试通过。两测试经真实 i18n Provider 覆盖中文与英文 surface，并断言动态会话数据原样保留。

```text
git diff --check -- apps/web/src/i18n/locales/en/messages.po apps/web/src/i18n/locales/zh-CN/messages.po
```

通过（无输出）。两份 PO 分别为 2043 行；它们是 i18n 资源，适用文件行数例外。

## Diff 边界

本叶只审阅并经 Lingui 生成验证两份声明 PO；它们的内容未漂移。本执行额外回写本报告：`.tasks/integration-closure/reports/035-report.md`。
