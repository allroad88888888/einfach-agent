# run_task

Run one predefined workspace task through the server runtime.

## Parameters

- `kind` (required): one of `test`, `build`, `lint`, `typecheck`, or `cargo_check`.
- `timeoutMs` (optional): positive timeout in milliseconds, capped by the runtime.
- `maxOutputChars` (optional): positive output cap, capped by the runtime.

## Use

- Use this when the next useful check is a known project task, such as tests, build, lint, typecheck, or Cargo check.
- Prefer the narrowest task that answers the question.
- Use the returned stdout/stderr and exit status as evidence, then inspect files with read/search tools if needed.

## Constraints

- Less is more: this is a small task launcher, not a shell.
- It does not accept arbitrary commands, args, env, cwd, or package-manager-specific flags.
- It does not perform complex diagnostics or rewrite failing output into custom reports.
- If a project needs a task that is not listed in `kind`, use another appropriate tool instead of stretching this one.
