# 010 Web 回归夹具执行报告

状态：DONE

## 修改范围

- `apps/web/src/agentNew/ui/Composer.images.test.tsx`
  - 默认 `photo()` 使用 `apps/web/src/imageInput/staticImagePolicy.testFixtures.ts` 导出的 `pngBytes(20, 10)`，生成完整、合法的 PNG 容器。
- `apps/web/src/agentNew/ui/BrowserActionCard.test.tsx`
  - 两个渲染用例从 RTL `render` 改为仓库的 `renderWithStore`，以装配真实 i18n Provider；动态中文 title/body 断言保持原样。

未修改生产组件、静态图片 policy、i18n runtime 或共享 render helper。

## 精确验证命令与结果

```text
pnpm exec vitest run apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/BrowserActionCard.test.tsx
```

结果：通过；`Test Files 2 passed (2)`、`Tests 13 passed (13)`。

```text
pnpm exec tsc -b --pretty false
```

结果：通过（退出码 0，无输出）。

```text
git diff --check -- apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/BrowserActionCard.test.tsx
```

结果：通过（无输出）。

```text
wc -l apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/BrowserActionCard.test.tsx
```

结果：Composer 232 行；BrowserActionCard 38 行；均未超过 300 行。

## Diff 边界

产品/测试代码 diff 仅涉及以下两个声明文件：

- `apps/web/src/agentNew/ui/Composer.images.test.tsx`
- `apps/web/src/agentNew/ui/BrowserActionCard.test.tsx`

本执行仅额外回写本报告：`.tasks/integration-closure/reports/010-report.md`。
