---
id: "010"
title: 同步 Web 回归夹具
kind: leaf
parent: "100"
depends_on: []
discovered_from: "deepseek-vision-support/080, lingui-full-ui/150"
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/Composer.images.test.tsx
  - apps/web/src/agentNew/ui/BrowserActionCard.test.tsx
---

# 同步 Web 回归夹具

## 目标

使旧 Web 回归测试使用当前生产装配与合法图片容器。

## 上下文

全量测试暴露两个夹具漂移，不是产品语义缺陷：

- `Composer.images.test.tsx` 的 `photo()` 只有 PNG 八字节签名。055 已将 Composer 与 `view_image`
  统一到完整静态容器校验，因此这不是合法图片；测试应消费
  `apps/web/src/imageInput/staticImagePolicy.testFixtures.ts` 导出的 `pngBytes(width,height)`，不能 mock
  或绕过 policy。
- `BrowserActionCard` 在 120 接入 `useLingui()`，旧测试仍直接用 RTL `render`，没有生产同构
  `AppI18nProvider`。仓库现有 `renderWithStore` 已装配真实中文 catalog、三层 store 与 timeline registry。

不得修改生产组件、静态图片 policy、i18n runtime 或共享 render helper。动态 title/body 仍应原样渲染。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/BrowserActionCard.test.tsx` → 2 文件、13 项通过。
2. Composer 测试的默认 PNG 有完整合法容器，原 11 个选择/paste/drop/发送/清理断言不删除、不弱化。
3. BrowserActionCard 两例经 `renderWithStore` 使用真实 i18n Provider，动态中文 title/body 不被翻译。
4. `pnpm exec tsc -b --pretty false` 与两个文件的 `git diff --check` 通过；`wc -l` 均不超过 300。

## 执行记录（仅编排者回写）

- 2026-08-31：由全量 `pnpm test` 的 8 个非法 PNG 失败与 2 个缺 Provider 失败发现。
- 2026-08-31：执行与独立审查通过；编排者复跑 2 文件 13/13、diff-check 与行数门全绿。
