# cancel_agent

Cancel a background agent execution by the `executionId` returned from `delegate_agent`.

Cancellation is idempotent: an execution that already reached a terminal state is returned with
`cancelled: false` and its current status. Unknown execution IDs fail explicitly.
