---
id: '120-r3'
kind: leaf
title: 页面提前采集的上限不会被其他使用者扩大
parent: browser-agent
base: 756cd97
status: done
model: gpt-5.6-sol
files:
  - browser-agent/tools/network/**
---
# 接手120 R3窄修
前人已修2轮，R1/R2报告与review在reports/120-report-r1.md、120-review-r1.md、120-report-r2.md、120-review-r2.md。仅剩后者1个Important；不要重做整包。读index全局及120-network-tools.md的固定合同/最新用户对话前采集要求。只改network包与reports/120-report-r3.md，禁止提交/install/浏览器/CDP，正常文件≤300行。

## 精确问题与裁决
window-observer.ts retainObserver lines30–48当前把host/后续recorder maxRequests/maxBodyChars Math.max合并，导致已安装页面recorder100/32Ki被host500/64Ki放大。root裁决已经明确：只要存在recorder，页面预缓冲使用所有recorder中更保守的数量、正文、年龄上限，普通host不能提高这些上限。没有recorder时，多host可共享更大的观察上限，而各capture在window-host.ts cloneForCapture再以自己maxBodyChars限制输出（已正确，保留该行为）。
可采用最小修复：首个recorder接入既有按需observer时清理旧记录，并将其限制设为recorder自己的值；后续recorder只收紧min并立即prune/重设timer及处理现有超限正文；普通host只有observer.recorderRefs===0时允许max。恢复被释放较严recorder后的较宽上限不是本次要求，保守保留更小上限可以明确文档说明；不能反过来扩大已存在recorder。不要引入新宿主层或全局无界集合。注意在收紧maxBodyChars时既有缓冲已经存储的正文也不能超过新限制，JSON超限必须省略，不能未解析截断泄露；可用现有sanitize/cloneForCapture相同安全规则提取内部有限函数，但不暴露新公共框架。

## 必验
使用真实recorder+host，必须在宽松host/第二recorder加入之后继续发请求，再stop宽松host并新建capture读取buffer，验证预缓冲条数和正文不超过原recorder限制；覆盖host→recorder，recorder→host，小recorder→大recorder，大recorder→小recorder（含已存在正文），以及原R2无recorder的两host顺序测试继续通过。异步pending record在限制变化期间不能写回超限正文；原record存活/cleanup逻辑不能退化。
运行根`pnpm exec vitest run browser-agent/tools/network/src`、network tsc/build、docs，保存日志在.tasks/browser-agent/reports/120-r3-*.log。完成全部且源码冻结后发DONE一次，给准确report。root会最终组合/打包/CUA和独立复审。不能在完成后偷偷改源码。
