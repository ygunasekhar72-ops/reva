# REVA Architecture

```
┌──────────────┐   ┌──────────────────┐
│  Terminal UI │   │   Mobile PWA      │
│ (src/tui)    │   │  (public/, SSE)   │
└──────┬───────┘   └────────┬──────────┘
       │ direct             │ HTTP + SSE (bearer token)
       │                    │
       │            ┌───────▼────────────┐
       │            │  Server (src/server)│  auth · rate limits · headers
       │            └───────┬────────────┘
       │                    │
┌──────▼────────────────────▼───────┐
│           Harness (src/core)      │  wiring: config, registries, stores
├───────────────────────────────────┤
│  AgentSession (src/agent)         │  the loop: chat → tools → subagents
│   ├ EventLog (JSONL + live fanout)│  every visible step is an event
│   ├ MemoryManager                 │  per-project memory + compaction
│   └ ProviderRegistry (src/providers)  OpenAI / Anthropic / Gemini flavors
├───────────────────────────────────┤
│  ToolRegistry (src/tools)         │  schema validation, hooks, audit
│   exec fs web skill memory task   │
├───────────────────────────────────┤
│  Security (src/security)          │  crypto · accounts · sessions
│  path guard · ssrf · cmd guard    │  rate limit · audit · redaction
├───────────────────────────────────┤
│  MCP client · Skills · Plugins ·  │
│  Extensions · Bots · Automation   │
└───────────────────────────────────┘
```

## Event-sourced agent

`AgentSession` never talks to the UI directly. Every observable step — user
message, thinking delta, text delta, tool start/result with timings, memory
snapshot, compaction, subagent start/done, usage — is appended to a per-session
`EventLog` (`src/agent/events.js`):

- subscribers are notified **synchronously before any await**, so streamed
  deltas reach every consumer in order;
- events persist as JSONL (`<project>/.reva/sessions/<id>.jsonl`), which is
  what makes sessions resumable: `rebuildMessages()` folds the log back into a
  message array;
- the TUI subscribes directly; the server bridges the same log over SSE.

## The loop

1. Append user message; run plugin `message:new` hooks.
2. If estimated tokens exceed `agent.compaction_threshold`: **memory snapshot
   first** — the model distills the conversation into JSON notes that merge
   into `.reva/memory/{decisions,facts,todos,gotchas}.md` — then compaction
   replaces old messages with the summary (recent messages kept).
3. Build the system prompt: identity + workspace + bot persona + skills
   catalog + **project memory** + working rules.
4. Call the provider with the tool set. Stream events.
5. `stop_reason === 'tool_use'` → execute tool calls (bounded concurrency;
   independent calls run in parallel) → append tool results → loop.
6. Otherwise emit the final assistant message and finish.

Guards at every edge: provider errors are normalized (`ProviderError` with
retryable classification + backoff); tool arguments are schema-validated;
plugin hooks can observe but not corrupt (errors isolated, payload cloned).

## Providers

One internal message/tool format, three protocol adapters (OpenAI
chat-completions incl. SSE tool-call delta assembly and `reasoning_content`;
Anthropic messages incl. thinking blocks preserved across tool loops; Gemini
generateContent incl. thought summaries and schema sanitization). Key
resolution: keystore → config `api_key` → env var. Retry with jittered backoff
on 429/5xx only.

## Memory before compaction

`MemoryManager` gives every project an isolated memory workspace
(`<project>/.reva/memory/`). Compaction is a two-phase event stream
(`memory_snapshot` → `compact`) so the UI can show it. Notes are merged under
dated headings, indexed, and injected into every future session's system
prompt (truncated with a pointer to `memory_read`).

## Multi-agent

The `task` tool spawns child `AgentSession`s (depth-limited, concurrency-
limited). Several task calls in one assistant turn execute **concurrently**
(worker pool bounded by `agent.max_concurrent_subagents`) — that's the
fan-out. Children mirror summarized events into the parent log
(`subagent_event`), keep their own full JSONL, and `explore` mode restricts
them to read-only tools.

## Bots & automation

`bots.json` holds named presets (provider/model/system/tools_allow/
max_iterations); built-ins `dots` (OpenAI) and `grok` (xAI) are seeded on
first use. `AutomationStore` + `Scheduler` persist jobs with interval or
daily-at schedules; the scheduler runs under `reva serve`, the TUI host
process, or `reva auto daemon`, and marks each run ok/error in the job record.

## Frontends

- **TUI**: inline streaming (no alt-screen) — robust over SSH/Termux/Windows
  Terminal. Thinking streams dim; tool calls render as compact cards with
  timings; spinner; slash commands (`/model /bot /resume /memory /compact …`);
  Ctrl+C interrupts the current run. Non-TTY stdin degrades to a scripted
  one-shot mode (used by the e2e tests).
- **PWA**: vanilla-JS SPA served by the same server. Bottom tabs
  (chat/sessions/bots/more), SSE-driven message flow with collapsible thinking
  blocks and tool cards, settings for providers/keys, memory viewer, automation
  manager, audit-chain verifier, and the extension loader. Installable via
  "Add to Home Screen"; service worker caches the shell only (API never cached).

## Extension points

| Layer | Mechanism | Trust boundary |
|---|---|---|
| Tools | `ToolRegistry.register` | in-process, first-party |
| Plugins | manifest + `activate(ctx)` | permission-gated (`tools`, `events`, …), per-plugin error isolation |
| MCP servers | config → child process | JSON-RPC over stdio, timeouts, namespaced tools |
| Skills | markdown + frontmatter | prompt injection only — no code execution |
| Mobile extensions | dynamic import in the PWA | browser sandbox; permission-declared manifest; server path-guards their files |

## Testing strategy

101 tests, 8 files, zero network calls to real providers. The core technique:
a **protocol-faithful mock LLM** (SSE for all three flavors, split tool-call
deltas, error injection) and a **real MCP server process**, so the client code
under test is the same code that runs in production. Server e2e boots the real
HTTP stack on an ephemeral port and drives auth → sessions → SSE → tools
through `fetch`. CLI/TUI e2e spawns the real binary. Process-level
parallelism in `node --test` is safe because every suite isolates `HOME` into
a temp directory (`testkit/env.js`).
