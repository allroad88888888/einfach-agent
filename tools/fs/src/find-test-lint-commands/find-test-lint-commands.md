# find_test_lint_commands

Finds candidate test and lint commands from a bounded set of repository configuration files.

The tool only reads recognized manifests and sends those small excerpts to a context-free, low-cost extraction model. It never runs a command, opens source files, receives the current conversation, or delegates work to an agent.

Results distinguish commands explicitly declared by the project from conservative ecosystem inferences. Treat them as candidates to verify, not proof that the commands have run.
