# submit_stage_result

Call this after doing **and verifying** the active stage. Provide a concise summary and concrete evidence such as test output, build output, changed files, API responses, or review findings.

Completing the stage is your own call, so the verification has to be real: run the tests or commands the stage objective implies and put their actual output in `evidence`. Do not submit a stage whose verification you skipped, and never write evidence for a command you did not run.

This tool completes the stage and activates the next dependency-ready stage. When the last stage completes, the plan is done.

If the objective turns out to be unreachable, use `update_plan` to mark the stage `blocked` with a `blockReason` instead of submitting a result that overstates what was achieved.
