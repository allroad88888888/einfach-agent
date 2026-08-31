---
id: "060"
title: 建立桌面发布矩阵
kind: leaf
parent: "300"
depends_on:
  - "040"
  - "052"
  - "055"
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - .github/workflows/release-desktop.yml
  - docs/desktop-release.md
---

# 建立桌面发布矩阵

## 目标

使 CI 构建目标匹配的桌面包。

## 上下文

旧 `e52c31d^:.github/workflows/release-desktop.yml` 曾在 macOS 双架构、Windows、Linux 上发布并接入
Apple notarization/Windows signing。此任务只处理用户确认的 `aarch64-apple-darwin`。新架构还须先执行
030 的 Node staging，不能依赖 GitHub runner 预装的 Node 作为用户 runtime。

若确认 unsigned preview，只建 build artifact job；若确认正式发布，tag 检查、签名和 notarization
必须使用 CI secrets，绝不输出 secrets、ready token 或证书内容。

## 接口

### 消费

- `pnpm desktop:build`：040 产物。
- `node scripts/check-desktop-wrapper.mjs`：050 产物，所有 build job 在打包前执行。

### 产出

- tag `app-v<tauri.conf.json.version>` 的 release workflow；每一 matrix target 都先准备同 target Node sidecar。

## 验收标准

1. workflow YAML 静态解析通过，矩阵 target 与 staging target 一一对应。
2. 无 release secret 的 pull request 路径只构建与验证，不上传发行版。
3. 有 release secret 的 tag 路径校验 tag/version、签名和 notarization 前置条件，且日志不含 secret/token。

## 执行记录（仅编排者回写）

- 2026-08-21：050 最终独立审查失败，原依赖阻塞。
- 2026-08-31：改为消费 052 的绑定语义修复与 055 的根测试接入；两者通过独立审查前不得派发。
- 2026-08-31：R1 修正 pnpm cache 初始化顺序并显式传递 matrix target；R2 补齐 Rust target 安装，最终独立复审 APPROVED，编排者复跑 YAML/策略/diff/行数门通过。
