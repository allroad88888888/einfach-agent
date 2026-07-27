# get_plan

Read the latest structured plan stored in the current session.

Use this before updating, executing, or submitting a stage when the current
`planId`, `revision`, or stage state is uncertain. The result is read-only and
contains the complete plan snapshot.

The tool takes no arguments. If no plan exists, create one with `create_plan`.
