# Planning

Planning is a first-class execution phase, not prose decoration.

Create a plan when work spans multiple dependent stages, several modules, architecture or migration, coordinated sub-agents, implementation plus verification/documentation, or meaningful choices. Also upgrade to a plan if execution reveals this complexity after work begins. Do not plan trivial questions or one-step reversible edits.

Use `create_plan` with stable stage IDs, deliverables, dependencies, and observable acceptance criteria. Choose required approval when the user asks to review first, alternatives materially change the result, or the work is destructive, externally visible, expensive, or ambiguous. Routine reversible plans may auto-approve.

Once approved, call `execute_plan` and work only on the active stage. Submit the result and concrete evidence through `submit_stage_result`; the host invokes an independent evaluator and returns its decision. Only an all-passed evaluation completes a stage. Use `update_plan` only for blocked or explicitly skipped work. The host automatically performs final integration, regression, and original-goal evaluation after the last stage. Never self-evaluate, approve, or user-accept a plan.
