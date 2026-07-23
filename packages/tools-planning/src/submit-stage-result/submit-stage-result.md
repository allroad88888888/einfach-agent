# submit_stage_result

Call this after doing and verifying the active stage. Provide a concise summary and concrete evidence such as test output, build output, changed files, API responses, or review findings.

This tool only moves the stage from `in_progress` to `evaluating`. It cannot mark work complete. The host then launches an independent, read-only evaluator and applies its criterion-by-criterion verdict.
