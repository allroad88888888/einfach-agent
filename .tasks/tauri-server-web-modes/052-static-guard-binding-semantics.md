---
id: "052"
title: 收紧静态守卫绑定语义
kind: leaf
parent: "300"
depends_on:
  - "040"
discovered_from: "050"
model: gpt-5.6-sol
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/desktop/tests/webCapabilityStaticAnalysis.mjs
  - apps/desktop/tests/desktopStaticGuard.test.mjs
---

# 收紧静态守卫绑定语义

## 目标

让 Web 静态守卫只信任可证明不可变的词法绑定。

## 上下文

050 的 R3 最终 reviewer 已确认透明表达式、可信插件箭头、Rust 输出与内容 hash 都通过，唯一 Important
根因位于 `webCapabilityStaticAnalysis.mjs`：`collectConstants()` 用全文件 `Map<name,value>` 收集任意变量，
不区分 `const/let/var`、声明顺序、写操作或词法作用域。因此下面两类确定性绕过会被误判为静态：

```ts
let target = './safe.js'; target = attackerControlled; import(target)
let key = 'safe'; key = 'require'; const load = globalThis[key]; load(source)
```

内外层同名 binding 也不能按文本互相覆盖。实现应按使用点解析真实 binding；只有同一词法 binding 的
`const`、有可求值 initializer、声明先于使用、且未被赋值/update 时才可折叠。任何无法证明的动态 import
必须拒绝；任何无法证明安全的 computed global require 必须拒绝。允许保守多报，不允许漏报。

不要修改生产 Web、Rust、wrapper、三态 smoke 或内容快照。

## 验收标准

1. `node apps/desktop/tests/desktopStaticGuard.test.mjs` → 全部通过。
2. 新增 R3 的 mutation 与词法 shadowing 反例；非静态 import、computed require alias 均产生 violation。
3. 既有直接 `const` 拼接、模板常量、透明 wrapper 与唯一可信插件 `evaluate` 仍按原契约工作。
4. `node scripts/check-desktop-wrapper.mjs` → 通过，范围文件与声明 ignored artifacts 字节不变。
5. `node --check`、范围 `git diff --check`、`wc -l` 通过；两个文件各自保持单一职责且不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-31：作为 050 failed 的后继叶派发；不是 050 的第四轮修复。
- 2026-08-31：首轮独立审查 REJECTED：mutation 检测漏解构 assignment target 与 `for..of/in` 写入，
  可让非静态 import/computed require 继续折叠旧值；原执行者进入 R1。
- 2026-08-31：R1 独立复审通过；编排者复跑 static guard 4/4、wrapper 7/7、语法与 300 行门全绿。
