# @einfach-agent/tools-agents

The agents tool domain: delegating, observing, joining and cancelling sub-agent runs,
querying their histories, and compacting model context.

`compact_context` is a runtime-only tool (`callTiming: 'compact'`). Register it through
`registerAgentsTools` or `registerStandardTools`; it does not appear in model discovery.
The runtime triggers it before an over-budget request and binds it to the current agent.
Summary policy lives in the tool; state, undo, history and model credentials stay in core.

This package is part of the [Einfach Agent](https://github.com/allroad88888888/einfach-agent)
workspace — see the main repository for setup, documentation and contribution guidelines.
