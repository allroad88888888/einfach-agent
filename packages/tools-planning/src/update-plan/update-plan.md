# update_plan

Use only to mark the active stage `blocked`, with a concrete `blockReason`.

This tool cannot complete or skip a stage. For successful work use `submit_stage_result`; the host automatically launches an independent evaluator. Update only the current `in_progress` stage and pass the exact latest revision.
