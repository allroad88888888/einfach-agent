# create_plan

Use this before executing work that has several dependent phases. Give stages stable, short IDs; concrete deliverables; and observable acceptance criteria.

Use `approvalMode: "required"` when the user explicitly asks to review the plan first, when alternatives materially change the result, or when work is destructive, externally visible, expensive, or ambiguous. Use `auto` for routine reversible work.

After an auto-approved plan, call `execute_plan`. After required approval, stop: the host approval card resumes the run, then call `execute_plan` with the returned revision.
