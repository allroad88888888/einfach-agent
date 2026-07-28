---
name: demo
description: 何时用：验证项目 skills 自动加载链路时读我；何时不用：正常业务任务。
triggers: [验证, project skills, demo]
---

# demo skill 正文（L2）

这段正文只应通过 `skill_read({name:'project/demo'})` 读到，绝不出现在 L1 清单里。

可读资源见 `references/checklist.md`。
