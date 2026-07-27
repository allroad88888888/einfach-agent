# join_agent

Wait for a background agent execution only when the parent genuinely needs its result.

Pass the `executionId` returned by `delegate_agent`. Prefer `observe_agent` when polling should not
block the current model turn.

`timeoutMs` defaults to 30 seconds and is capped at 5 minutes. A timeout is retryable and does not
cancel the child; continue useful work and observe or join it again.
