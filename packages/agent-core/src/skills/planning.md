# Planning

Planning is a first-class execution phase, not prose decoration.

Create a plan when work spans multiple dependent stages, several modules, architecture or migration, coordinated sub-agents, implementation plus verification/documentation, or meaningful choices. Also upgrade to a plan if execution reveals this complexity after work begins. Do not plan trivial questions or one-step reversible edits.

Use `create_plan` with stable stage IDs, deliverables, dependencies, and an observable objective per stage — state what must be true when the stage is done, not what activity it contains. Choose required approval when the user asks to review first, alternatives materially change the result, or the work is destructive, externally visible, expensive, or ambiguous. Routine reversible plans may auto-approve.

Planning may be interrupted for a user decision. Before `create_plan`, call `ask_user_question` with `context: { "surface": "plan", "phase": "drafting" }` when a missing choice materially changes the plan. After the user answers, resume the same planning run. During execution, ask again when a new stage-level decision is genuinely required; the host binds that interruption to the active stage. Do not force all questions into a single up-front interruption.

Once approved, call `execute_plan` and work only on the active stage. When the stage objective is met **and you have verified it**, call `submit_stage_result` with a summary and concrete evidence; that completes the stage and activates the next one. Nothing else checks your work, so run the tests or commands the objective implies and report their real output — never claim a verification you did not perform. Use `update_plan` only for blocked work. Never approve a plan yourself.

需要更详细的说明（如何写可评估的阶段目标、证据格式建议、目标达不成时怎么办）时，用 skill_read 读取本 skill 的 `references/evaluation.md` 资源。
