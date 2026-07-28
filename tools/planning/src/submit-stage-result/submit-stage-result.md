# submit_stage_result

Call this after doing and verifying the active stage. Provide a concise summary and concrete evidence such as test output, build output, changed files, API responses, or review findings.

This tool only moves the stage from `in_progress` to `evaluating`. It cannot mark work complete. The host then launches an independent evaluator and applies its criterion-by-criterion verdict.

The evaluator always reads the workspace and can run the shell commands needed to verify the acceptance criteria, including project-provided scripts, through `run_verification_command`. It uses real exit codes and output as execution evidence. If no shell is available, criteria that require execution can come back as `unknown`.

An `unknown` verdict leaves the stage `blocked` with a reason instead of `failed`. A later submission can re-run the automated evaluation after the missing evidence or environment issue is resolved.
