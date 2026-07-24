# execute_plan

Call after approval to start the next ready stage, or after a failed/blocked evaluation to retry that stage. Pass the exact plan ID and latest revision. Perform the active stage with normal tools, then call `submit_stage_result`; successful completion is decided by `evaluate_stage`.
