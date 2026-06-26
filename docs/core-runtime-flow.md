# Web Agent Core Runtime Flow

This document captures the current browser-side agent runtime shape.

## Runtime Overview

```mermaid
flowchart TD
  U[User input] --> C[Composer]
  C --> R[startAgentRun]

  R --> M1[append user message]
  R --> S1[setRunState: running]
  R --> E[executeRun]

  E --> A1[MainArchitectAgent<br/>create worker plan]
  A1 --> SK[pickSkillsForInput]
  SK --> T0[load base lazy tools<br/>delegate_agent / skill_search / skill_read]

  T0 --> W[worker agents]
  W --> D[DeputyArchitectAgent<br/>merge artifacts]

  D --> LOOP[DeepSeek model/tool loop]

  LOOP -->|assistant_message| OUT[streamAssistantAnswer]
  OUT --> DONE[setRunState: done]

  LOOP -->|request_tool_schema| LOAD[loadTool schema]
  LOAD --> LOOP

  LOOP -->|tool_payload| TOOL[handle runtime tool]
  TOOL -->|ask_user_question| WAIT[setRunState: waiting_user<br/>render question card]
  TOOL -->|tool_result| LOOP

  LOOP -->|turn guard reached| LIMIT[emit loop-limit timeline]
  LIMIT --> OUT

  WAIT --> ANS[user submits answers]
  ANS --> CONT[continueAgentRunWithAnswers]
  CONT --> E
```

## Lazy Tool Protocol

The first model turn does not receive full tool JSON schemas. It only receives a tool manifest with `name`, `description`, and `runtime`. After that, the runtime stays in the same loop until the model returns an assistant message, pauses on user input, or hits the safety guard.

```mermaid
sequenceDiagram
  participant Runtime
  participant Model as DeepSeek
  participant Tools as Tool Registry
  participant UI as Browser UI

  Runtime->>Model: Agent turn: user input + tool manifest + request_tool_schema
  Note over Runtime,Model: Full JSON schemas are not included.

  loop Until assistant_message / waiting_user / max turn guard
    alt Model needs an unloaded tool
      Model-->>Runtime: tool_call request_tool_schema(toolName, reason)
      Runtime->>Tools: loadTool(toolName)
      Tools-->>Runtime: Loaded tool with JSON schema
      Runtime->>Model: Next turn with tool result + loaded schema
    else Model calls a loaded tool
      Model-->>Runtime: tool_call loaded_tool(payload)
      Runtime->>Tools: Execute runtime/browser/internal tool
      Tools-->>Runtime: tool result
      Runtime->>Model: Next turn with tool result
    else Model can answer directly
      Model-->>Runtime: assistant_message
    end
  end

  Runtime->>UI: stream assistant answer or set pendingQuestion
  UI-->>Runtime: optional user answers
  Runtime->>Model: new loop with answerContext
```

## Prompt Boundary

The first turn prompt stays abstract:

- It describes the lazy tool protocol.
- It lists available tools as a manifest only.
- It does not include concrete JSON schemas.
- It does not hard-code special rules for one tool.
- It says that runtime state changes, pausing, structured input collection, browser-side actions, and delegation should use a matching tool capability.
- It treats user-requested questioning, confirmation, answer collection, and waiting for choices as runtime state changes when a matching tool exists.

Tool-specific behavior belongs to:

- tool summary in `src/agent/tools/registry.ts`
- loaded tool JSON schema in `src/agent/tools/registry.ts`
- runtime handling in `src/agent/runtime/loop.ts`
- UI rendering in `src/chat/*`

## Main Code Map

| Area | File | Responsibility |
| --- | --- | --- |
| Chat shell | `src/chat/ChatShell.tsx` | Layout: messages, run activity, question card, composer, timeline |
| Composer | `src/chat/Composer.tsx` | Starts and stops runs |
| Run activity | `src/chat/RunActivity.tsx` | Inline live progress: agent steps, model thinking, tool calls |
| Ask user UI | `src/chat/AskUserQuestionCard.tsx` | Renders structured questions and submits answers |
| Runtime loop | `src/agent/runtime/loop.ts` | Run lifecycle, workers, tool loading, model turn handling |
| DeepSeek adapter | `src/agent/model/deepseek-adapter.ts` | SSE, thinking stream, tool calls, continuation messages |
| Tool registry | `src/agent/tools/registry.ts` | Tool summaries and lazy-loaded JSON schemas |
| Skill registry | `src/agent/skills/registry.ts` | Repository skill summaries and lazy reads |
| State | `src/agent/state/atoms.ts` | Einfach atoms for sessions, messages, runs, timeline, pending answers |

## AskUserQuestion Path

```mermaid
flowchart TD
  P[User asks for planning / questions] --> M[Model sees tool manifest]
  M --> Q[request_tool_schema: ask_user_question]
  Q --> S[Runtime loads ask_user_question schema]
  S --> M2[Model receives schema]
  M2 --> AQ[ask_user_question payload]
  AQ --> W[waiting_user]
  W --> UI[AskUserQuestionCard]
```

This is one possible path through the model/tool loop. It is not a hard-coded second turn: any number of schema requests, tool calls, and tool results can happen before the final assistant message or pause.

## Run Statuses

| Status | Meaning |
| --- | --- |
| `idle` | No active run |
| `running` | Runtime is executing agents/model/tools |
| `waiting_user` | Runtime is paused on structured user input |
| `done` | Run completed normally |
| `stopped` | User stopped the active run |
| `error` | Runtime failed |

## Local Development

The project root is:

```bash
/Volumes/work/ai/web-agent
```

Start the app from that directory:

```bash
cd /Volumes/work/ai/web-agent
npm run dev
```
