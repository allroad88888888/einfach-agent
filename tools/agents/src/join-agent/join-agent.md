# join_agent

Wait for a background agent execution only when the parent genuinely needs its result.

Pass the `executionId` returned by `delegate_agent`. Prefer `observe_agent` when polling should not
block the current model turn.
