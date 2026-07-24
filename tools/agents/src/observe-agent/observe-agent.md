# observe_agent

Read the current state of a background agent execution without waiting for it.

Pass the `executionId` returned by `delegate_agent`. If it is still running, continue useful
independent work. Use `join_agent` only when the result is a real dependency.
